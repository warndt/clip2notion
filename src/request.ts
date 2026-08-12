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

/** Accepts a Notion page id with or without dashes; returns the dashed form. */
export function normalizePageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.trim().replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20),
  ].join("-");
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
