/**
 * The MCP entry point — how the real caller reaches this service.
 *
 * A Claude session in the claude.ai chat interface cannot POST to this host;
 * its sandbox refuses non-allowlisted hosts at the egress proxy. A custom
 * connector is called from Anthropic's infrastructure instead, which sidesteps
 * that entirely.
 *
 * ## Four rules, all learned from the spike (see ROADMAP M3). Do not relax them.
 *
 * 1. **Every user-facing failure is a tool result with `isError`, never a
 *    JSON-RPC error.** Protocol errors are for malformed calls only.
 *
 * 2. **Nothing may throw out of a tool handler.** A `-32603` is replaced en
 *    route with a generic "the server isn't responding, you can try again" —
 *    advice that is wrong for a paywall and invites an endless retry against a
 *    deterministic failure. Every handler is wrapped.
 *
 * 3. **Failure prose must be unmistakable in the words themselves.** `isError`
 *    does *not* reach the model as a machine-readable field; what arrives is
 *    the harness's wrapper plus our text. So every failure opens with an
 *    explicit marker and never uses acceptance language.
 *
 * 4. **Dispatch is not a write.** `clip_article` returning successfully means
 *    the work *started*. Saying anything stronger invites the caller to report
 *    a clip that never happened — the confidently-wrong-answer failure, arriving
 *    through the success path. Hence `clip_status`, which reads the page and
 *    gives an answer that can be checked rather than inferred.
 */

// ⚠️ Import only from modules free of jsdom and Readability. This function is
// synchronous, so Netlify kills it at 10 seconds INCLUDING container start, and
// importing the converter costs seconds of that budget before any work begins.
// That is why status lives in src/status.ts and the URL check in src/url.ts
// rather than in pipeline.ts and extract.ts. Do not "tidy" these back.
import { loadConfig, TUNABLES, type Config } from "../../src/config";
import { ClipError } from "../../src/errors";
import { log, newClipId } from "../../src/log";
import { normalizePageId, secretMatches } from "../../src/request";
import { awaitClipSettled, awaitOwnRun, describeClipTime, type ClipStatus } from "../../src/status";
import { assertSafeUrl } from "../../src/url";

/** Same purpose as the copy in pipeline.ts: detect a cold container. */
const MODULE_LOADED_AT = Date.now();

const SERVER_NAME = "clip2notion";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PREFERRED_PROTOCOL_VERSION = "2025-06-18";
const BACKGROUND_PATH = "/.netlify/functions/clip-background";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
};

function rpcResult(
  id: JsonRpcRequest["id"],
  result: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function toolText(id: JsonRpcRequest["id"], text: string, isError = false): Response {
  return rpcResult(id, { content: [{ type: "text", text }], isError });
}

/**
 * Rule 3. The marker carries the meaning, because the `isError` flag doesn't
 * survive the trip and prose is all the caller actually receives.
 */
function toolFailure(id: JsonRpcRequest["id"], text: string): Response {
  // Opens with a STATUS token like every other response, so a caller can match
  // on the first line without a special case. REJECTED rather than FAILED
  // because nothing reached the page: there is no error callout to read, and
  // the cause is in the request rather than in the article.
  return toolText(id, `STATUS: REJECTED\n\nCLIP FAILED — nothing was written.\n\n${text}`, true);
}

// --- Tools -----------------------------------------------------------------

const CLIP_ARTICLE_TOOL = {
  name: "clip_article",
  title: "Clip an article into a Notion page",
  description:
    "Fetches a web article and writes its full content into an existing Notion page in the " +
    "WDB | Resources database, storing images inside Notion. The page must already exist — " +
    "create it and set its properties first. This tool only fills in the body.\n\n" +
    "This tool waits briefly for the work to finish, so it often returns the real outcome " +
    "(CLIPPED or FAILED) directly. If it returns IN_PROGRESS or STARTED, call clip_status " +
    "yourself to keep waiting. Never report success on anything other than a CLIPPED result, " +
    "and never ask the user to prompt you to check.\n\n" +
    "CRITICAL: if this tool fails at the transport level — a timeout, or the server not " +
    "responding — that does NOT mean the clip did not happen. The work is dispatched before " +
    "the reply is sent, so it may well be running. NEVER call clip_article again after such " +
    "an error. Call clip_status instead and let it tell you what is actually on the page. " +
    "Retrying blindly is how a page ends up with the article on it twice.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description:
          "Notion page id, with or without dashes, or a full Notion page URL. The page must " +
          "already exist in the WDB | Resources database.",
      },
      url: {
        type: "string",
        description:
          "Absolute http(s) URL of the article to clip. This argument is the only source of " +
          "the URL — the service never reads the page's own URL property.",
      },
      force: {
        type: "boolean",
        description:
          "Delete an existing clip on this page and clip it again. Only use when re-clipping " +
          "a page that already has content from a previous run. Never on a first attempt.",
      },
    },
    required: ["page_id", "url"],
  },
};

const CLIP_STATUS_TOOL = {
  name: "clip_status",
  title: "Check whether a clip finished",
  description:
    "Reads a Notion page and reports whether a clip has finished, is still running, or failed. " +
    "This tool WAITS for a running clip before answering, so calling it again is how you wait " +
    "— never ask the user to prompt you to check. Keep calling it until it returns CLIPPED or " +
    "FAILED, and report nothing to the user until then.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description:
          "Notion page id, with or without dashes, or a full Notion page URL. This is the " +
          "same page id passed to clip_article — there is no separate job id to keep hold of, " +
          "because status is read from the page itself.",
      },
    },
    required: ["page_id"],
  },
};

async function handleClipArticle(
  id: JsonRpcRequest["id"],
  args: Record<string, unknown>,
  config: Config,
  clipId: string,
  origin: string,
  enteredAt: number,
): Promise<Response> {
  const pageId = normalizePageId(args["page_id"]);
  if (!pageId) {
    return toolFailure(
      id,
      "The page_id is missing or is not a Notion page id. Create the page in the Resources " +
        "database first, then pass the id it was given. This is a problem with the request, " +
        "so retrying it unchanged will not help.",
    );
  }

  const url = typeof args["url"] === "string" ? args["url"].trim() : "";
  if (!url) {
    return toolFailure(id, "No url was given, so there is nothing to clip.");
  }

  try {
    assertSafeUrl(url);
  } catch {
    return toolFailure(
      id,
      `The url ${JSON.stringify(url)} is not a public http(s) web address, so it cannot be ` +
        "fetched. Check it and try again with a corrected address.",
    );
  }

  // Verified before dispatch so a bad target is rejected while a status code
  // still means something. A leaked credential must not mean write access to
  // the whole workspace.
  try {
    const { NotionClient } = await import("../../src/notion");
    await new NotionClient(config, clipId).assertPageInDataSource(pageId);
  } catch (err) {
    if (err instanceof ClipError && err.code === "INVALID_TARGET") {
      return toolFailure(
        id,
        "That page is not in the WDB | Resources database, so nothing was written. Check the " +
          "page_id. Retrying unchanged will not help.",
      );
    }
    return toolFailure(
      id,
      "Notion could not be reached to verify the page, so the clip was not started. This is " +
        "usually temporary — it is safe to try once more.",
    );
  }

  try {
    const dispatch = await fetch(`${origin}${BACKGROUND_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Clip-Secret": config.sharedSecret },
      body: JSON.stringify({
        page_id: pageId,
        url,
        force: args["force"] === true,
        clip_id: clipId,
      }),
    });
    if (dispatch.status !== 202) {
      return toolFailure(
        id,
        `The clip could not be started (dispatch returned ${dispatch.status}). Nothing was ` +
          "written. It is safe to try once more.",
      );
    }
  } catch {
    return toolFailure(
      id,
      "The clip could not be started because the background worker was unreachable. Nothing " +
        "was written. It is safe to try once more.",
    );
  }

  log("info", clipId, "mcp_dispatched", { page_id: pageId, url });

  log("info", clipId, "mcp_dispatched_waiting", { page_id: pageId });

  // Wait for the work rather than handing the caller a job to chase — but wait
  // for OUR run specifically. On the first look a forced re-clip still shows the
  // previous clip, and reporting that would confirm an outcome for work that
  // hasn't happened.
  let settled: ClipStatus | null;
  try {
    settled = await awaitOwnRun(
      pageId,
      config,
      clipId,
      TUNABLES.dispatchWaitBudgetMs,
      enteredAt,
    );
  } catch {
    return toolText(
      id,
      `STATUS: STARTED\n\n` +
        `The clip was started, but its progress could not be read back just now. Call ` +
        `clip_status with page_id ${pageId} to find out what happened. Do not tell the user ` +
        `it worked until you have.`,
    );
  }

  if (settled === null) {
    return toolText(
      id,
      `STATUS: STARTED\n\n` +
        `The clip was dispatched, but it has not yet shown up as running on the page, so ` +
        `nothing here is confirmation of anything.\n\n` +
        `Call clip_status with page_id ${pageId} to find out what actually happened. Do not ` +
        `tell the user the article was clipped until it returns CLIPPED.`,
    );
  }

  if (settled.state !== "in_progress") return statusResponse(id, settled, pageId);

  // Rule 4: this wording must not be relayable as "clipped".
  return toolText(
    id,
    `STATUS: IN_PROGRESS\n\n` +
      `The article is still being fetched and written. This is NOT confirmation that it ` +
      `worked, and it is not a failure either.\n\n` +
      `Call clip_status with page_id ${pageId} again now. That call waits for the work, so ` +
      `simply calling it again is how you wait — do not ask the user to prompt you, and do ` +
      `not report an outcome yet. Repeat until it returns CLIPPED or FAILED. An article with ` +
      `many images can need two or three such calls.`,
  );
}

async function handleClipStatus(
  id: JsonRpcRequest["id"],
  args: Record<string, unknown>,
  config: Config,
  clipId: string,
  enteredAt: number,
): Promise<Response> {
  const pageId = normalizePageId(args["page_id"]);
  if (!pageId) {
    return toolFailure(id, "The page_id is missing or is not a Notion page id.");
  }

  let status: ClipStatus;
  try {
    status = await awaitClipSettled(
      pageId,
      config,
      clipId,
      TUNABLES.statusWaitBudgetMs,
      enteredAt,
    );
  } catch (err) {
    if (err instanceof ClipError && err.code === "INVALID_TARGET") {
      return toolFailure(
        id,
        "That page can't be read — it is either not in the WDB | Resources database, or it " +
          "has been deleted and is in the Notion trash. Retrying will not help; check the " +
          "page id.",
      );
    }
    return toolFailure(
      id,
      "Notion could not be reached to check the page, so the outcome is unknown. Do not " +
        "report success or failure to the user — try again in a moment.",
    );
  }

  return statusResponse(id, status, pageId);
}

/**
 * Render a settled (or still-running) status as a tool result.
 *
 * The first line is a stable token to match on. The prose after it is for the
 * model to act on, but callers shouldn't have to parse English to branch.
 */
function statusResponse(
  id: JsonRpcRequest["id"],
  status: ClipStatus,
  pageId: string,
): Response {
  // When the clip on the page was written. On a re-clip this is the only way to
  // tell a completed run from the previous clip sitting untouched — `CLIPPED`
  // says the same thing either way.
  const written = describeClipTime(status.markerCreatedAt);

  switch (status.state) {
    case "clipped":
      // Says only what was actually checked. An earlier version asserted the
      // images were stored in Notion, which nothing here verifies — and it said
      // so about a run whose images were in fact broken.
      return toolText(
        id,
        `STATUS: CLIPPED\n\n` +
          `The page was read and the article is there.\n` +
          `Source: ${status.sourceUrl ?? "(link present)"}\n` +
          `Clip written: ${written ?? "(time not reported by Notion)"}\n\n` +
          `It is safe to tell the user the clip succeeded. This confirms the article was ` +
          `written; it does not separately verify every image, so if the user reports a ` +
          `broken image, relay that rather than insisting it worked.\n\n` +
          `If you asked for a re-clip, check the written time before reporting it as done: ` +
          `an old timestamp means you are looking at the previous clip and the re-run has ` +
          `not landed. Notion records that time to the minute.`,
      );

    case "in_progress":
      return toolText(
        id,
        `STATUS: IN_PROGRESS\n\n` +
          `The clip has not finished yet, so the outcome is not known. Do NOT report success ` +
          `or failure.\n` +
          `Run started: ${written ?? "(time not reported by Notion)"}\n\n` +
          `Call clip_status with page_id ${pageId} again now. This tool waits for the work ` +
          `before answering, so calling it again IS how you wait — do not ask the user to ` +
          `prompt you. Repeat until it returns CLIPPED or FAILED. An article with many images ` +
          `may need two or three calls. Only if it is still running after roughly ten such ` +
          `calls should you tell the user the run appears to have died.`,
      );

    case "failed":
      return toolText(
        id,
        `STATUS: FAILED\n\n` +
          `CLIP FAILED — the page carries an error. Relay this to the user:\n\n` +
          `${status.detail ?? "(no detail recorded)"}\n\n` +
          `Any content already on the page is partial. Do not retry on your own initiative. ` +
          `If the message says a retry may help, tell the user that and let them decide.\n\n` +
          `This error stays on the page until someone removes it, so it will not decay into ` +
          `NOT_STARTED later.`,
        true,
      );

    case "not_started":
    default:
      return toolText(
        id,
        `STATUS: NOT_STARTED\n\n` +
          `NOTHING CLIPPED — the page has no article, no progress marker, and no error.\n\n` +
          `Either clip_article was never called for this page, or it was rejected before it ` +
          `wrote anything. This is not an expired result: status is read from the page itself, ` +
          `so a failure would still be showing. Do not tell the user it was clipped.`,
        true,
      );
  }
}

// --- Transport -------------------------------------------------------------

/**
 * Where the caller's token came from.
 *
 * A **path segment** is preferred over a query string. Query strings are the
 * fragile part of a URL: they get dropped by normalisation, by proxies, and by
 * anything that stores an endpoint as origin + path. A connector can then pass
 * its settings-page connection test on the full URL and afterwards call the
 * endpoint without the query, which reads here as an unauthenticated request.
 *
 * Every form is accepted so that whichever survives the trip works.
 */
/**
 * Replace a token-carrying path segment before the path is logged.
 *
 * `/mcp/<token>` becomes `/mcp/<redacted>`. Without this, the credential ends
 * up in the function logs verbatim — the very risk that makes a URL-borne
 * secret weaker than a header-borne one.
 */
function redactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length > 1 && segments[0] === "mcp") return "/mcp/<redacted>";
  return pathname;
}

function providedToken(req: Request): { token: string; source: string } {
  const url = new URL(req.url);

  // /mcp/<token>
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length > 1 && segments[0] === "mcp") {
    const last = segments[segments.length - 1];
    if (last) return { token: decodeURIComponent(last), source: "path" };
  }

  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return { token: fromQuery, source: "query" };

  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return { token: auth.slice(7).trim(), source: "bearer" };
  }

  const header = req.headers.get("x-clip-secret");
  if (header) return { token: header, source: "header" };

  return { token: "", source: "none" };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method === "GET") {
    // Streamable HTTP allows a GET for a server-initiated stream. There is
    // nothing to push, and saying so beats leaving a connection hanging.
    return new Response("Method Not Allowed: this server does not offer an SSE stream.", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }
  if (req.method === "DELETE") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  // Stamped at entry so every wait loop measures against the platform's 10s
  // kill, not against its own start.
  const enteredAt = Date.now();
  const clipId = newClipId();

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    log("error", clipId, "config_invalid", { reason: String(err) });
    return rpcError(null, -32603, "Service is misconfigured; check the environment variables.");
  }

  const { token, source } = providedToken(req);
  const requestUrl = new URL(req.url);

  // The body is parsed before the auth check purely so the JSON-RPC method can
  // be logged. Knowing that a client connected but not what it asked for is the
  // difference between diagnosing this and guessing at it.
  let body: JsonRpcRequest | null = null;
  let parseFailed = false;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    parseFailed = true;
  }

  // Logged on every request, accepted or not.
  //
  // The path is redacted first: when the token travels as a path segment,
  // logging the raw path would write the secret into the function logs — the
  // whole reason a URL-borne secret is riskier than a header-borne one. Never
  // log `pathname` or `search` here unredacted.
  log("info", clipId, "mcp_request", {
    method: body?.method ?? (parseFailed ? "<unparseable>" : "<none>"),
    cold_start: enteredAt - MODULE_LOADED_AT < TUNABLES.coldStartWindowMs,
    path: redactPath(requestUrl.pathname),
    token_source: source,
    has_query: requestUrl.search.length > 0,
    accept: req.headers.get("accept")?.slice(0, 60) ?? null,
    protocol_header: req.headers.get("mcp-protocol-version"),
    session_sent: req.headers.get("mcp-session-id") ? "yes" : "no",
    user_agent: req.headers.get("user-agent")?.slice(0, 40) ?? null,
  });

  if (!secretMatches(token, config.sharedSecret)) {
    log("warn", clipId, "mcp_rejected", { reason: "bad or missing token", token_source: source });
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  if (parseFailed || !body) {
    return rpcError(null, -32700, "Parse error: body is not valid JSON.");
  }

  const id = body.id ?? null;

  try {
    switch (body.method) {
      case "initialize": {
        const asked = String(body.params?.["protocolVersion"] ?? "");
        return rpcResult(
          id,
          {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : PREFERRED_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              "Writes article content into existing Notion pages in WDB | Resources. Create " +
              "the page and set its properties first, then call clip_article. clip_article " +
              "only starts the work — always confirm with clip_status before telling the user " +
              "anything.",
          },
          // The server is stateless, so this is cosmetic on our side — but a
          // client that expects a session id and gets none may treat every
          // request as a fresh session and keep reinitialising.
          { "Mcp-Session-Id": clipId },
        );
      }

      case "notifications/initialized":
      case "notifications/cancelled":
        return new Response(null, { status: 202, headers: CORS_HEADERS });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, { tools: [CLIP_ARTICLE_TOOL, CLIP_STATUS_TOOL] });

      case "tools/call": {
        const params = (body.params ?? {}) as Record<string, unknown>;
        const args = (params["arguments"] ?? {}) as Record<string, unknown>;
        const origin = process.env.URL ?? new URL(req.url).origin;

        switch (params["name"]) {
          case CLIP_ARTICLE_TOOL.name:
            return await handleClipArticle(id, args, config, clipId, origin, enteredAt);
          case CLIP_STATUS_TOOL.name:
            return await handleClipStatus(id, args, config, clipId, enteredAt);
          default:
            return rpcError(id, -32602, `Unknown tool: ${String(params["name"])}`);
        }
      }

      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });

      default:
        return rpcError(id, -32601, `Method not found: ${body.method}`);
    }
  } catch (err) {
    // Rule 2. A -32603 reaches the caller as "the server isn't responding, you
    // can try again" — so anything that escapes becomes a tool result instead,
    // where the text actually survives.
    log("error", clipId, "mcp_exception", { detail: String(err) });
    return toolFailure(
      id,
      "Something went wrong inside the clip service. Nothing is known to have been written. " +
        `Report this to the user rather than retrying repeatedly. Reference: ${clipId}`,
    );
  }
}
