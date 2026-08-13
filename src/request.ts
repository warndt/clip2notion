/**
 * Request parsing and auth, shared by both entry points.
 *
 * The synchronous function validates so the caller gets a real status code; the
 * background function validates again because it is publicly reachable in its
 * own right. Same rules, one implementation.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time comparison. Hashing first makes it length-safe. */
export function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const UUID_PATTERN = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

function dashed(hex: string): string {
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20),
  ].join("-");
}

/**
 * Accepts a Notion page id with or without dashes, **or a Notion page URL**.
 * Returns the dashed form.
 *
 * URLs are accepted because that is what a caller has to hand — the MCP tools
 * and the Notion connector both surface page URLs, and requiring the caller to
 * strip one down to a bare id is a pointless way to fail.
 *
 * The query string is dropped before searching, because a Notion URL can carry
 * a *view* id in `?v=…` that also looks like a uuid. Taking the last match from
 * the path avoids grabbing it.
 */
export function normalizePageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const looksLikeUrl = /^https?:\/\//i.test(trimmed);

  if (!looksLikeUrl) {
    const hex = trimmed.replace(/-/g, "").toLowerCase();
    return /^[0-9a-f]{32}$/.test(hex) ? dashed(hex) : null;
  }

  let path: string;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    return null;
  }

  const matches = path.match(UUID_PATTERN);
  if (!matches || matches.length === 0) return null;

  const hex = matches[matches.length - 1]!.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? dashed(hex) : null;
}

export interface ParsedRequest {
  pageId: string;
  url: string;
  force: boolean;
  clipId: string | null;
}

export type ParseResult =
  | { ok: true; value: ParsedRequest }
  | { ok: false; reason: string };

export function parseClipRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "body must be a JSON object" };
  }

  const record = body as Record<string, unknown>;

  const pageId = normalizePageId(record["page_id"]);
  if (!pageId) return { ok: false, reason: "page_id is missing or not a Notion page id" };

  const rawUrl = record["url"];
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { ok: false, reason: "url is missing" };
  }

  const force = record["force"] === true;

  // Passed through by the synchronous function so both halves log the same id.
  const clipId = typeof record["clip_id"] === "string" ? record["clip_id"] : null;

  return { ok: true, value: { pageId, url: rawUrl.trim(), force, clipId } };
}
