/**
 * The whole run, start to finish.
 *
 * The ordering here is load-bearing, not stylistic. Netlify retries a failed
 * background function at 1 minute and again at 2 minutes, so:
 *
 *   - The clip header goes in the *same append call* as the first article
 *     content. A run that dies mid-append still leaves the idempotency key
 *     behind for the retry to find.
 *   - Once content has started appending, nothing is allowed to throw. A
 *     transient failure at that point would be retried on top of what is
 *     already on the page.
 */

import { TUNABLES, type Config } from "./config";

import { ClipError, errors, toClipError } from "./errors";
import { log } from "./log";
import { extractArticle, fetchArticle } from "./extract";
import {
  clipHeader, collectImageBlocks, errorCallout, footnoteBlocks, htmlToBlocks, statusCallout,
  ERROR_MARKER, HEADER_PREFIX, STATUS_MARKER, type Block,
} from "./blocks";
import {
  blockFirstLink, blockLinksTo, blockPlainText, NotionClient, type NotionBlockRecord,
} from "./notion";

// Status lives in its own module so `mcp.ts` can read a page without importing
// the converter. Re-exported here for callers and tests that already reach for
// it through the pipeline.
export {
  awaitClipSettled, awaitOwnRun, deriveClipStatus, getClipStatus,
  type ClipState, type ClipStatus,
} from "./status";

export interface ClipRequest {
  pageId: string;
  url: string;
  /**
   * Re-clip a page that already has a clip, deleting the previous one first.
   *
   * Deliberately explicit. The automatic path never deletes anything — but a
   * caller asking for a redo is an instruction, not the service acting on its
   * own initiative, and the alternative is deleting blocks by hand in the
   * Notion UI, which is the tedium this project exists to remove.
   */
  force?: boolean;
}

export type ClipOutcome = "clipped" | "already_clipped" | "in_progress_elsewhere" | "failed";

/**
 * The clip header must travel in the same append call as the first article
 * content. It is the idempotency key: a run that dies mid-append has to leave
 * it behind, or Netlify's retry appends a second copy on top of the first.
 *
 * Extracted and exported so that guarantee is a test rather than a reading of
 * the loop — including in the single-batch case, where it holds trivially and
 * would be the easiest path to break without noticing.
 */
export function buildAppendBatches(header: Block, blocks: Block[], batchSize: number): Block[][] {
  const payload = [header, ...blocks];
  const batches: Block[][] = [];
  for (let i = 0; i < payload.length; i += batchSize) {
    batches.push(payload.slice(i, i + batchSize));
  }
  return batches;
}

export async function runClip(request: ClipRequest, config: Config, clipId: string): Promise<ClipOutcome> {
  const client = new NotionClient(config, clipId);
  const startedAt = Date.now();

  log("info", clipId, "clip_start", { page_id: request.pageId, url: request.url });

  // Nothing below this line runs until we know the page is ours to write to.
  await client.assertPageInDataSource(request.pageId);

  const existing = await client.listChildren(request.pageId);

  if (!request.force) {
    if (existing.some((block) => blockLinksTo(block, request.url))) {
      log("info", clipId, "already_clipped", { page_id: request.pageId });
      return "already_clipped";
    }

    const runningStatus = existing.find(
      (block) => block.type === "callout" && blockPlainText(block).includes(STATUS_MARKER),
    );
    if (runningStatus) {
      log("info", clipId, "in_progress_elsewhere", { status_block: runningStatus.id });
      return "in_progress_elsewhere";
    }
  }

  // The progress callout goes down FIRST — before a forced re-clip deletes
  // anything. Deleting a long clip removes a block at a time at roughly three
  // per second, and the header goes first, so without this the page can hold
  // partially deleted content and no marker for tens of seconds. Anything
  // reading it during that window would see content with no header and no
  // marker, which is indistinguishable from a page mid-write.
  const statusResult = await client.appendChildren(request.pageId, [statusCallout(clipId)]);
  const statusBlockId = statusResult[0]?.id ?? null;

  if (request.force) {
    const removed = await clearPreviousClip(
      client,
      existing,
      request.url,
      clipId,
      statusBlockId,
    );
    log("info", clipId, "force_recliped", { removed_blocks: removed });
  }

  let contentWritten = false;

  try {
    const fetched = await fetchArticle(request.url);
    const article = extractArticle(fetched.html, fetched.finalUrl);

    log("info", clipId, "extracted", {
      title: article.title,
      chars: article.textLength,
      final_url: article.finalUrl,
    });

    const { blocks, truncatedAtBlockCap } = htmlToBlocks(article.contentHtml, article.finalUrl);
    if (blocks.length === 0) {
      throw errors.notExtractable("Conversion produced no blocks");
    }

    await importImages(client, blocks, clipId);

    const header = clipHeader({
      title: article.title,
      siteName: article.siteName,
      byline: article.byline,
      publishedAt: article.publishedAt,
      url: request.url,
    });

    const tail = [...blocks, ...footnoteBlocks(article.footnotes, article.finalUrl)];
    if (truncatedAtBlockCap) {
      tail.push(
        errorCallout(
          `This article exceeded the ${TUNABLES.maxBlocks}-block ceiling and was cut short here. ` +
            "Raise MAX_BLOCKS and re-clip if you need the rest.",
          clipId,
        ),
      );
      log("warn", clipId, "block_cap_hit", { cap: TUNABLES.maxBlocks });
    }

    for (const batch of buildAppendBatches(header, tail, TUNABLES.appendBatchSize)) {
      await client.appendChildren(request.pageId, batch);
      // From here on the page has content and the header, so a retry would find
      // the idempotency key and stop. Nothing after this point may throw.
      contentWritten = true;
    }

    if (statusBlockId) {
      try {
        await client.deleteBlock(statusBlockId);
      } catch (err) {
        // A leftover progress callout is untidy, not harmful. Don't fail the run.
        log("warn", clipId, "status_cleanup_failed", { reason: String(err) });
      }
    }

    log("info", clipId, "clip_done", {
      blocks: tail.length + 1,
      images: collectImageBlocks(blocks).length,
      duration_ms: Date.now() - startedAt,
    });
    return "clipped";
  } catch (err) {
    const clipError = toClipError(err);

    log("error", clipId, "clip_failed", {
      code: clipError.code,
      transient: clipError.transient,
      content_written: contentWritten,
      detail: clipError.message,
    });

    await reportFailure(client, statusBlockId, clipError, clipId, contentWritten);

    // Retrying only helps if the failure was transient AND nothing was written.
    // Otherwise the retry either reaches the same answer or duplicates content.
    if (clipError.transient && !contentWritten) throw clipError;

    return "failed";
  }
}

/**
 * Delete the previous clip so a forced re-clip can start clean.
 *
 * Scoped to the clip, not the page. The service only ever appends, so the clip
 * is the run of blocks from its header to the end of the page — anything above
 * the header belongs to whoever set the page up and is left untouched. Stale
 * progress and error callouts are swept too, wherever they sit.
 *
 * The trade-off worth knowing: notes added *below* a clip are inside that range
 * and go with it. Bounding the range exactly would need a footer marker block
 * on every clip, which is a permanent visible artifact to solve a problem that
 * has not happened yet. Recorded in the ROADMAP backlog.
 */
/**
 * Which blocks a forced re-clip removes.
 *
 * Exported and pure so the blast radius of a destructive operation is a test
 * rather than a reading of the loop. This matters more since Resources
 * templates began seeding their own body content: every page now has blocks
 * above the clip that must survive a re-clip.
 */
export function selectBlocksToDelete(
  existing: NotionBlockRecord[],
  url: string,
  protectedBlockId: string | null = null,
): NotionBlockRecord[] {
  const headerIndex = existing.findIndex((block) => blockLinksTo(block, url));

  // Everything from the clip header down. Anything above it belongs to whoever
  // set the page up — a template's version toggle, the user's own notes — and
  // is never touched.
  const doomed = headerIndex >= 0 ? existing.slice(headerIndex) : [];
  const above = headerIndex >= 0 ? existing.slice(0, headerIndex) : existing;

  // Stale progress and error callouts are swept wherever they sit, so a page
  // left showing "in progress" by a dead run recovers.
  for (const block of above) {
    if (block.type !== "callout") continue;
    const text = blockPlainText(block);
    if (text.includes(STATUS_MARKER) || text.includes(ERROR_MARKER)) doomed.push(block);
  }

  // Never sweep away this run's own progress marker — it is standing in front
  // of the very deletion it announces.
  return doomed.filter((block) => block.id !== protectedBlockId);
}

async function clearPreviousClip(
  client: NotionClient,
  existing: NotionBlockRecord[],
  url: string,
  clipId: string,
  protectedBlockId: string | null = null,
): Promise<number> {
  const doomed = selectBlocksToDelete(existing, url, protectedBlockId);

  for (const block of doomed) {
    try {
      await client.deleteBlock(block.id);
    } catch (err) {
      // Leaving a block behind is better than abandoning the re-clip; the worst
      // case is a duplicate paragraph the user can see and delete.
      log("warn", clipId, "force_delete_failed", { block_id: block.id, reason: String(err) });
    }
  }

  return doomed.length;
}

/** Turn the progress callout into the error message, in place, at the top of the page. */
async function reportFailure(
  client: NotionClient,
  statusBlockId: string | null,
  error: ClipError,
  clipId: string,
  contentWritten: boolean,
): Promise<void> {
  if (!statusBlockId) return;

  const message = contentWritten
    ? `${error.userMessage} Part of the article was already written — delete the clipped blocks and re-run to retry.`
    : error.userMessage;

  const callout = errorCallout(message, clipId);

  try {
    await client.updateBlock(statusBlockId, { callout: callout["callout"] });
  } catch (err) {
    // The page now shows "in progress" forever, which is at least visible.
    log("error", clipId, "error_report_failed", { reason: String(err) });
  }
}

// --- Images ----------------------------------------------------------------

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "bmp", "gif", "heic", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp",
]);

const MIME_EXTENSIONS: Record<string, string> = {
  "image/bmp": "bmp", "image/gif": "gif", "image/heic": "heic",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/svg+xml": "svg", "image/tiff": "tif", "image/webp": "webp",
};

function sanitizeStem(stem: string): string {
  const cleaned = stem.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || "image";
}

/**
 * Notion rejects an import that lacks a valid filename and supported MIME type.
 * Most URLs carry a usable extension; the ones that don't get one HEAD request
 * to find out, and are left as hotlinks if that doesn't answer it either.
 */
async function resolveFilename(rawUrl: string): Promise<string | null> {
  const url = new URL(rawUrl);
  const base = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const dotIndex = base.lastIndexOf(".");
  const extension = dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : "";

  if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return `${sanitizeStem(base.slice(0, dotIndex))}.${extension}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TUNABLES.fetchTimeoutMs);
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": TUNABLES.userAgent },
    });
    clearTimeout(timer);

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const mapped = contentType ? MIME_EXTENSIONS[contentType] : undefined;
    if (!mapped) return null;
    return `${sanitizeStem(base || "image")}.${mapped}`;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Swap external image URLs for Notion-hosted file uploads, in place.
 *
 * This is the point of the service: a clipped article has to survive the source
 * site changing or disappearing. An image that can't be imported stays as an
 * external reference and the degradation is logged — it never vanishes.
 */
async function importImages(client: NotionClient, blocks: Block[], clipId: string): Promise<void> {
  const images = collectImageBlocks(blocks);
  if (images.length === 0) return;

  const importable = images.slice(0, TUNABLES.maxImages);
  if (images.length > importable.length) {
    log("warn", clipId, "image_cap_hit", {
      total: images.length,
      imported: importable.length,
      note: "remainder left as external references",
    });
  }

  let stored = 0;
  let degraded = 0;

  await mapWithConcurrency(importable, TUNABLES.imageConcurrency, async (block) => {
    const payload = block["image"] as { external?: { url: string }; caption?: unknown };
    const url = payload.external?.url;
    if (!url) return;

    // Notion's importer requires SSL and a publicly reachable URL.
    if (!url.startsWith("https://")) {
      degraded++;
      log("warn", clipId, "image_degraded", { url, reason: "not https" });
      return;
    }

    const filename = await resolveFilename(url);
    if (!filename) {
      degraded++;
      log("warn", clipId, "image_degraded", { url, reason: "no supported filename or MIME type" });
      return;
    }

    const uploadId = await client.importExternalFile(url, filename);
    if (!uploadId) {
      degraded++;
      return;
    }

    block["image"] = {
      type: "file_upload",
      file_upload: { id: uploadId },
      caption: payload.caption ?? [],
    };
    stored++;
  });

  log("info", clipId, "images_done", { total: images.length, stored, degraded });
}
