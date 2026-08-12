/**
 * The worker. Fetches, converts, and writes — with up to 15 minutes to do it.
 *
 * Callers should use `/clip` instead, which validates synchronously and can
 * return a real status code. This function is publicly reachable in its own
 * right, so it repeats every check rather than trusting its caller.
 *
 * ⚠️ Netlify answers 202 before this handler runs and discards whatever it
 * returns, so returning error codes from here would be theatre — rejections are
 * logged and nothing is written.
 *
 * Throwing, on the other hand, is meaningful: Netlify treats a failed
 * invocation as retryable and re-runs it at 1 minute and again at 2 minutes.
 * So this throws only for transient failures, and never once article content
 * has begun appending.
 */

import { loadConfig } from "../../src/config";
import { ClipError } from "../../src/errors";
import { log, newClipId } from "../../src/log";
import { runClip } from "../../src/pipeline";
import { parseClipRequest, secretMatches } from "../../src/request";

const accepted = () => new Response(JSON.stringify({ accepted: true }), {
  status: 202,
  headers: { "Content-Type": "application/json" },
});

export default async function handler(req: Request): Promise<Response> {
  let clipId = newClipId();

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    log("warn", clipId, "rejected", { reason: "body is not valid JSON" });
    return accepted();
  }

  const parsed = parseClipRequest(body);
  if (!parsed.ok) {
    log("warn", clipId, "rejected", { reason: parsed.reason });
    return accepted();
  }

  const { pageId, url, force } = parsed.value;
  // Keep the id the synchronous half already gave the caller, so one clip reads
  // as one story in the logs.
  if (parsed.value.clipId) clipId = parsed.value.clipId;

  try {
    await runClip({ pageId, url, force }, config, clipId);
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
