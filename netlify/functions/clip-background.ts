/**
 * Entry point. Auth, validate, hand off to the pipeline.
 *
 * ⚠️ A background function cannot return a meaningful status code. Netlify
 * responds 202 before this handler runs and discards whatever it returns, so a
 * wrong secret or an invalid page id is rejected *silently* — nothing is
 * written, the rejection is logged, and the caller still sees 202. Returning
 * error responses from here would be theatre. See the ROADMAP backlog.
 *
 * Throwing, on the other hand, is meaningful: Netlify treats a failed
 * invocation as retryable and re-runs it at 1 minute and again at 2 minutes.
 * So this handler throws only for transient failures, and never once article
 * content has begun appending.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../../src/config";
import { ClipError } from "../../src/errors";
import { log, newClipId } from "../../src/log";
import { runClip } from "../../src/pipeline";

/** Constant-time comparison. Hashing first keeps it length-safe. */
function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Accepts a Notion page id with or without dashes; returns the dashed form. */
function normalizePageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.trim().replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20),
  ].join("-");
}

const accepted = () => new Response(JSON.stringify({ accepted: true }), {
  status: 202,
  headers: { "Content-Type": "application/json" },
});

export default async function handler(req: Request): Promise<Response> {
  const clipId = newClipId();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Missing env vars are a deploy problem. Retrying twice won't fix it.
    log("error", clipId, "config_invalid", { reason: String(err) });
    return accepted();
  }

  if (req.method !== "POST") {
    log("warn", clipId, "rejected", { reason: "method not allowed", method: req.method });
    return accepted();
  }

  if (!secretMatches(req.headers.get("x-clip-secret") ?? "", config.sharedSecret)) {
    log("warn", clipId, "rejected", { reason: "bad shared secret" });
    return accepted();
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    log("warn", clipId, "rejected", { reason: "body is not valid JSON" });
    return accepted();
  }

  const pageId = normalizePageId(body["page_id"]);
  const url = typeof body["url"] === "string" ? body["url"].trim() : "";

  if (!pageId) {
    log("warn", clipId, "rejected", { reason: "page_id missing or not a Notion id" });
    return accepted();
  }
  if (!url) {
    log("warn", clipId, "rejected", { reason: "url missing" });
    return accepted();
  }

  try {
    await runClip({ pageId, url }, config, clipId);
  } catch (err) {
    if (err instanceof ClipError && err.transient) {
      // Deliberate: throwing lets Netlify retry. Only reached when nothing has
      // been written to the page yet.
      log("warn", clipId, "retryable_failure", { code: err.code, detail: err.message });
      throw err;
    }
    log("error", clipId, "run_failed", { detail: String(err) });
  }

  return accepted();
}
