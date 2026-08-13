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

import { loadConfig, type Config } from "../../src/config";
import { ClipError } from "../../src/errors";
import { assertSafeUrl } from "../../src/extract";
import { log, newClipId } from "../../src/log";
import { getClipStatus } from "../../src/pipeline";
import { normalizePageId, secretMatches } from "../../src/request";

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

function rpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
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
  return toolText(id, `CLIP FAILED — nothing was written.\n\n${text}`, true);
}

// --- Tools -----------------------------------------------------------------

const CLIP_ARTICLE_TOOL = {
  name: "clip_article",
  title: "Clip an article into a Notion page",
  description:
    "Fetches a web article and writes its full content into an existing Notion page in the " +
    "WDB | Resources database, storing images inside Notion. The page must already exist — " +
    "create it and set its properties first. This tool only fills in the body.\n\n" +
    "IMPORTANT: a successful response means the work STARTED, not that it finished. It runs " +
    "in the background and can still fail afterwards. Never tell the user the article was " +
    "clipped on the strength of this response — call clip_status to confirm first.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description: "Notion page id, with or without dashes. Must already exist in Resources.",
      },
      url: {
        type: "string",
        description: "Absolute http(s) URL of the article to clip.",
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
    "Use this after clip_article to confirm the outcome before telling the user anything. " +
    "A long illustrated article can take a few minutes, so if it reports in_progress, wait and " +
    "check again rather than assuming either outcome.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: {
        type: "string",
        description: "Notion page id, with or without dashes.",
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

  // Rule 4: this wording must not be relayable as "clipped".
  return toolText(
    id,
    `STARTED — the article is being fetched and written now. This is NOT confirmation that ` +
      `it worked.\n\n` +
      `Reference: ${clipId}\n\n` +
      `The work runs in the background and can still fail. Do not tell the user the article ` +
      `was clipped yet. Wait about 30 seconds, then call clip_status with page_id ` +
      `${pageId} to find out what actually happened. A long article with many images may ` +
      `take a few minutes, in which case check again rather than assuming.`,
  );
}

async function handleClipStatus(
  id: JsonRpcRequest["id"],
  args: Record<string, unknown>,
  config: Config,
  clipId: string,
): Promise<Response> {
  const pageId = normalizePageId(args["page_id"]);
  if (!pageId) {
    return toolFailure(id, "The page_id is missing or is not a Notion page id.");
  }

  let status;
  try {
    status = await getClipStatus(pageId, config, clipId);
  } catch (err) {
    if (err instanceof ClipError && err.code === "INVALID_TARGET") {
      return toolFailure(id, "That page is not in the WDB | Resources database.");
    }
    return toolFailure(
      id,
      "Notion could not be reached to check the page, so the outcome is unknown. Do not " +
        "report success or failure to the user — try again in a moment.",
    );
  }

  switch (status.state) {
    case "clipped":
      return toolText(
        id,
        `CLIPPED — the article is on the page in full, with its images stored in Notion.\n\n` +
          `Source: ${status.sourceUrl ?? "(link present)"}\n\n` +
          `This is a confirmed result: the page was read and the article is there. It is safe ` +
          `to tell the user the clip succeeded.`,
      );

    case "in_progress":
      return toolText(
        id,
        `STILL RUNNING — the clip has not finished, so the outcome is not yet known.\n\n` +
          `Do NOT report success or failure. Wait longer and check again. A long illustrated ` +
          `article can take a few minutes. If it is still running after about five minutes, ` +
          `the run has probably died — say that rather than guessing either way.`,
      );

    case "failed":
      return toolText(
        id,
        `CLIP FAILED — the page carries an error. Relay this to the user:\n\n` +
          `${status.detail ?? "(no detail recorded)"}\n\n` +
          `Any content already on the page is partial. Do not retry automatically; the message ` +
          `above says whether retrying would help.`,
        true,
      );

    case "not_started":
    default:
      return toolText(
        id,
        `NOTHING CLIPPED — the page has no article, no progress marker, and no error.\n\n` +
          `Either clip_article was never called for this page, or it was rejected before it ` +
          `wrote anything. Do not tell the user it was clipped.`,
        true,
      );
  }
}

// --- Transport -------------------------------------------------------------

/** Token from the connector URL, or a header if one was sent. */
function providedToken(req: Request): string {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;

  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  return req.headers.get("x-clip-secret") ?? "";
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

  const clipId = newClipId();

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    log("error", clipId, "config_invalid", { reason: String(err) });
    return rpcError(null, -32603, "Service is misconfigured; check the environment variables.");
  }

  if (!secretMatches(providedToken(req), config.sharedSecret)) {
    log("warn", clipId, "mcp_rejected", { reason: "bad token" });
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error: body is not valid JSON.");
  }

  const id = body.id ?? null;

  try {
    switch (body.method) {
      case "initialize": {
        const asked = String(body.params?.["protocolVersion"] ?? "");
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PREFERRED_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Writes article content into existing Notion pages in WDB | Resources. Create the " +
            "page and set its properties first, then call clip_article. clip_article only " +
            "starts the work — always confirm with clip_status before telling the user anything.",
        });
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
            return await handleClipArticle(id, args, config, clipId, origin);
          case CLIP_STATUS_TOOL.name:
            return await handleClipStatus(id, args, config, clipId);
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
