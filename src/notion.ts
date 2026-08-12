/**
 * Notion API client and the operations this service needs from it.
 *
 * The API version is pinned in config and configurable by env — it changes, and
 * a copied-from-a-doc version string is a slow-burning bug.
 */

import { TUNABLES, type Config } from "./config";
import { ClipError, errors } from "./errors";
import { log } from "./log";
import type { Block, RichText } from "./blocks";

const API_ROOT = "https://api.notion.com/v1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface NotionBlockRecord {
  id: string;
  type: string;
  has_children: boolean;
  [key: string]: unknown;
}

export interface FileUploadRecord {
  id: string;
  status: "pending" | "uploaded" | "failed" | "expired";
  file_import_result?: { type?: string; error?: { type?: string; message?: string } };
}

export class NotionClient {
  private nextRequestAt = 0;

  constructor(
    private readonly config: Config,
    private readonly clipId: string,
  ) {}

  /** Notion allows roughly 3 requests/second averaged, so requests are spaced. */
  private async pace(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + TUNABLES.notionMinRequestGapMs;
    if (wait > 0) await sleep(wait);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastDetail = "";

    for (let attempt = 0; attempt <= TUNABLES.notionMaxRetries; attempt++) {
      await this.pace();

      let response: Response;
      try {
        response = await fetch(`${API_ROOT}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.config.notionToken}`,
            "Notion-Version": this.config.notionVersion,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        lastDetail = `Network error calling ${method} ${path}: ${String(err)}`;
        if (attempt === TUNABLES.notionMaxRetries) throw errors.notionFailed(lastDetail, true, err);
        await sleep(TUNABLES.notionRetryBaseMs * 2 ** attempt);
        continue;
      }

      if (response.ok) return (await response.json()) as T;

      const text = await response.text().catch(() => "");
      lastDetail = `${method} ${path} -> ${response.status} ${text.slice(0, 400)}`;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        throw errors.notionFailed(lastDetail, false);
      }

      if (attempt === TUNABLES.notionMaxRetries) {
        throw errors.notionFailed(lastDetail, true);
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : TUNABLES.notionRetryBaseMs * 2 ** attempt;

      log("warn", this.clipId, "notion_retry", { status: response.status, attempt, delay_ms: delay });
      await sleep(delay);
    }

    throw errors.notionFailed(lastDetail, true);
  }

  // --- Target verification -------------------------------------------------

  /**
   * A leaked secret must not mean write access to the whole workspace, so the
   * page's parent is checked before anything is written.
   *
   * Fails closed: an unexpected parent shape is a rejection, not a shrug.
   */
  async assertPageInDataSource(pageId: string): Promise<void> {
    let page: { parent?: { type?: string; data_source_id?: string; database_id?: string } };
    try {
      page = await this.request("GET", `/pages/${pageId}`);
    } catch (err) {
      if (err instanceof ClipError && !err.transient) {
        throw errors.invalidTarget(`Could not read page ${pageId}: ${err.message}`);
      }
      throw err;
    }

    const parent = page.parent ?? {};
    const expected = this.config.dataSourceId.replace(/-/g, "");
    const actual = (parent.data_source_id ?? "").replace(/-/g, "");

    if (parent.type !== "data_source_id" || actual !== expected) {
      throw errors.invalidTarget(
        `Page parent is ${parent.type ?? "unknown"}:${parent.data_source_id ?? parent.database_id ?? "none"}, ` +
          `expected data_source_id:${this.config.dataSourceId}`,
      );
    }
  }

  // --- Blocks --------------------------------------------------------------

  async listChildren(blockId: string, maxPages = 5): Promise<NotionBlockRecord[]> {
    const results: NotionBlockRecord[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const query = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
      const response = await this.request<{ results: NotionBlockRecord[]; next_cursor: string | null; has_more: boolean }>(
        "GET",
        `/blocks/${blockId}/children${query}`,
      );
      results.push(...response.results);
      if (!response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }

    return results;
  }

  /** Children append 100 at a time, so anything longer arrives in batches. */
  async appendChildren(parentId: string, children: Block[]): Promise<NotionBlockRecord[]> {
    const response = await this.request<{ results: NotionBlockRecord[] }>(
      "PATCH",
      `/blocks/${parentId}/children`,
      { children },
    );
    return response.results ?? [];
  }

  async updateBlock(blockId: string, payload: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/blocks/${blockId}`, payload);
  }

  async deleteBlock(blockId: string): Promise<void> {
    await this.request("DELETE", `/blocks/${blockId}`);
  }

  // --- File import ---------------------------------------------------------

  /**
   * Notion fetches the file itself, asynchronously, so this is create-then-poll.
   * Returns the file_upload id once it is attachable, or null if the import
   * failed — the caller degrades to an external reference rather than dropping
   * the image.
   */
  async importExternalFile(externalUrl: string, filename: string): Promise<string | null> {
    let upload: FileUploadRecord;
    try {
      upload = await this.request<FileUploadRecord>("POST", "/file_uploads", {
        mode: "external_url",
        external_url: externalUrl,
        filename,
      });
    } catch (err) {
      log("warn", this.clipId, "image_import_rejected", {
        url: externalUrl,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const deadline = Date.now() + TUNABLES.imagePollTimeoutMs;
    let interval = TUNABLES.imagePollIntervalMs;

    while (upload.status === "pending") {
      if (Date.now() > deadline) {
        log("warn", this.clipId, "image_import_timeout", { url: externalUrl, upload_id: upload.id });
        return null;
      }
      await sleep(interval);
      interval = Math.min(interval * 1.5, TUNABLES.imagePollMaxIntervalMs);

      try {
        upload = await this.request<FileUploadRecord>("GET", `/file_uploads/${upload.id}`);
      } catch (err) {
        log("warn", this.clipId, "image_poll_failed", { url: externalUrl, reason: String(err) });
        return null;
      }
    }

    if (upload.status === "uploaded") return upload.id;

    log("warn", this.clipId, "image_import_failed", {
      url: externalUrl,
      status: upload.status,
      reason: upload.file_import_result?.error?.message ?? "unknown",
    });
    return null;
  }
}

/** Plain text of a Notion block's rich text, for finding our own markers again. */
export function blockPlainText(block: NotionBlockRecord): string {
  const payload = block[block.type] as { rich_text?: RichText[] } | undefined;
  const items = payload?.rich_text;
  if (!Array.isArray(items)) return "";
  return items.map((item) => item.text?.content ?? "").join("");
}

/** Whether a block contains a link to this exact URL — the idempotency check. */
export function blockLinksTo(block: NotionBlockRecord, url: string): boolean {
  const payload = block[block.type] as { rich_text?: RichText[] } | undefined;
  const items = payload?.rich_text;
  if (!Array.isArray(items)) return false;
  return items.some((item) => item.text?.link?.url === url);
}
