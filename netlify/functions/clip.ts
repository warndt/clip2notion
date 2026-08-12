/**
 * The endpoint the caller actually uses.
 *
 * This exists because the caller is a Claude session. A background function
 * always answers 202 — Netlify responds before the handler runs — so a stale
 * secret or a bad page id would come back as success, and the session would
 * report a clip that never happened while the page sat empty. A confidently
 * delivered wrong answer is the exact failure this service is organised against.
 *
 * So everything cheap and certain is checked here, synchronously, where the
 * status code still means something: the secret, the request shape, the fetch
 * target, and the page's parent data source. Only then is the real work handed
 * to the background function, which has 15 minutes and cannot report back.
 */

import { loadConfig } from "../../src/config";
import { ClipError } from "../../src/errors";
import { assertSafeUrl } from "../../src/extract";
import { log, newClipId } from "../../src/log";
import { NotionClient } from "../../src/notion";
import { parseClipRequest, secretMatches } from "../../src/request";

const BACKGROUND_PATH = "/.netlify/functions/clip-background";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const clipId = newClipId();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log("error", clipId, "config_invalid", { reason: String(err) });
    return json(500, { error: "Service is misconfigured; check the environment variables." });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Use POST." });
  }

  if (!secretMatches(req.headers.get("x-clip-secret") ?? "", config.sharedSecret)) {
    log("warn", clipId, "rejected", { reason: "bad shared secret" });
    return json(401, { error: "Bad or missing X-Clip-Secret header." });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body is not valid JSON." });
  }

  const parsed = parseClipRequest(body);
  if (!parsed.ok) {
    log("warn", clipId, "rejected", { reason: parsed.reason });
    return json(400, { error: parsed.reason });
  }

  const { pageId, url, force } = parsed.value;

  try {
    assertSafeUrl(url);
  } catch (err) {
    const reason = err instanceof ClipError ? err.message : String(err);
    log("warn", clipId, "rejected", { reason });
    return json(400, { error: "url must be a public http(s) address." });
  }

  // The check that makes a leaked secret survivable. One API call, and it is
  // the difference between "rejected" and "wrote to an arbitrary page".
  try {
    await new NotionClient(config, clipId).assertPageInDataSource(pageId);
  } catch (err) {
    if (err instanceof ClipError && err.code === "INVALID_TARGET") {
      log("warn", clipId, "rejected", { reason: err.message });
      return json(403, { error: "That page isn't in the Resources database." });
    }
    log("error", clipId, "target_check_failed", { reason: String(err) });
    return json(502, { error: "Couldn't reach Notion to verify the page. Try again." });
  }

  const origin = process.env.URL ?? new URL(req.url).origin;

  try {
    const dispatch = await fetch(`${origin}${BACKGROUND_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Clip-Secret": config.sharedSecret,
      },
      body: JSON.stringify({ page_id: pageId, url, force, clip_id: clipId }),
    });

    // Background functions answer 202 immediately; anything else means the work
    // never started, and the caller needs to know that now rather than never.
    if (dispatch.status !== 202) {
      log("error", clipId, "dispatch_failed", { status: dispatch.status });
      return json(502, { error: "Couldn't start the clip. Nothing was written." });
    }
  } catch (err) {
    log("error", clipId, "dispatch_failed", { reason: String(err) });
    return json(502, { error: "Couldn't start the clip. Nothing was written." });
  }

  log("info", clipId, "dispatched", { page_id: pageId, url, force });

  return json(202, {
    accepted: true,
    clip_id: clipId,
    note: "Clipping runs in the background. Re-fetch the page to see the result; " +
      "a progress callout is replaced by the article, or by an error explaining what went wrong.",
  });
}
