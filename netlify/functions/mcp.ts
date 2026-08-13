/**
 * SPIKE — remote MCP server. Throwaway diagnostic, not part of the service.
 *
 * Deliberately self-contained: imports nothing from src/, touches nothing in
 * the clip path. Delete this file and the service is unchanged.
 *
 * ## What it is for
 *
 * The intended caller is a Claude session in the claude.ai chat interface,
 * which cannot POST to this host — its sandbox refuses non-allowlisted hosts at
 * the egress proxy. A custom connector sidesteps that, because Claude connects
 * to an MCP server from Anthropic's infrastructure rather than from the sandbox.
 *
 * ## What it has to prove
 *
 * Two things, and the second is the one that decides the design:
 *
 *   1. The handshake works at all — claude.ai can reach a Netlify function and
 *      list a tool.
 *   2. **A failure round-trips as something specific and actionable.** This is
 *      the entire reason for preferring MCP over the Notion-webhook fallback,
 *      which surrenders synchronous rejection. If a rejection arrives in the
 *      session as something vague, MCP's advantage is smaller than it looks and
 *      the comparison needs revisiting BEFORE porting the pipeline.
 *
 * MCP has two distinct failure channels, and they are not interchangeable:
 *
 *   - A **tool error**: a normal result carrying `isError: true`. The model sees
 *     the text and can act on it. This is what a paywall or a wrong page id
 *     should be.
 *   - A **protocol error**: a JSON-RPC `error` object. For malformed calls.
 *     Whether the model sees anything useful is exactly what we're testing.
 *
 * `clip_probe` fires either on demand so we can compare them side by side.
 */

const SERVER_NAME = "clip2notion-spike";
const SERVER_VERSION = "0.0.1";

/** Echo back whatever the client asks for when we recognise it. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PREFERRED_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, MCP-Protocol-Version",
};

function rpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }),
    { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
  );
}

/** A normal result the model reads as text. `isError` marks it as a failure. */
function toolResult(id: JsonRpcRequest["id"], text: string, isError = false): Response {
  return rpcResult(id, { content: [{ type: "text", text }], isError });
}

const PROBE_TOOL = {
  name: "clip_probe",
  title: "Clip probe (diagnostic)",
  description:
    "Diagnostic probe for the clip2notion connector spike. It does not clip anything and " +
    "does not touch Notion. Call it with each mode in turn and report exactly what you " +
    "receive, including whether you can tell success from failure and what the failure said.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["ok", "tool_error", "protocol_error", "thrown"],
        description:
          "ok = success. tool_error = a normal result flagged isError (how a paywall or a " +
          "wrong page id would surface). protocol_error = a JSON-RPC error object. " +
          "thrown = an unhandled exception on the server.",
      },
      note: {
        type: "string",
        description: "Optional text echoed back, to confirm arguments arrive intact.",
      },
    },
    required: ["mode"],
  },
};

function handleToolCall(id: JsonRpcRequest["id"], params: Record<string, unknown>): Response {
  const args = (params["arguments"] ?? {}) as Record<string, unknown>;
  const name = params["name"];

  if (name !== PROBE_TOOL.name) {
    return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
  }

  const mode = String(args["mode"] ?? "");
  const note = typeof args["note"] === "string" ? args["note"] : "";
  const stamp = new Date().toISOString();

  switch (mode) {
    case "ok":
      return toolResult(
        id,
        `SUCCESS. The connector reached clip2notion and returned a normal result.\n` +
          `Server time: ${stamp}\n` +
          `Your note came through as: ${note ? JSON.stringify(note) : "(none sent)"}\n\n` +
          `This is the shape a real clip dispatch would use: "accepted, verify the page shortly".`,
      );

    case "tool_error":
      // The shape a real rejection would use. Deliberately worded like the real
      // 403, to see whether a plain-language failure survives the round trip.
      return toolResult(
        id,
        `That page isn't in the Resources database, so nothing was written. ` +
          `Check the page_id and try again — retrying unchanged will not help. ` +
          `(diagnostic tool_error at ${stamp})`,
        true,
      );

    case "protocol_error":
      return rpcError(id, -32602, "Invalid params: 'url' must be a public http(s) address.", {
        diagnostic: "protocol_error",
        at: stamp,
      });

    case "thrown":
      throw new Error(`Deliberate unhandled exception from clip_probe at ${stamp}`);

    default:
      return toolResult(
        id,
        `Unrecognised mode ${JSON.stringify(mode)}. Valid modes: ok, tool_error, protocol_error, thrown.`,
        true,
      );
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Streamable HTTP allows a GET for a server-initiated stream. This spike has
  // nothing to push, and saying so plainly beats a hanging connection.
  if (req.method === "GET") {
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

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error: body is not valid JSON.");
  }

  const id = body.id ?? null;
  console.log(JSON.stringify({ event: "mcp_request", method: body.method, id }));

  try {
    switch (body.method) {
      case "initialize": {
        const asked = String(body.params?.["protocolVersion"] ?? "");
        const version = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : PREFERRED_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Diagnostic spike for clip2notion. Call clip_probe with each mode and report " +
            "verbatim what you receive for each.",
        });
      }

      // Notifications carry no id and expect no result.
      case "notifications/initialized":
      case "notifications/cancelled":
        return new Response(null, { status: 202, headers: CORS_HEADERS });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, { tools: [PROBE_TOOL] });

      case "tools/call":
        return handleToolCall(id, (body.params ?? {}) as Record<string, unknown>);

      // Declared unsupported in capabilities, but answer politely if asked.
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });

      default:
        return rpcError(id, -32601, `Method not found: ${body.method}`);
    }
  } catch (err) {
    // The "thrown" mode lands here. Returning a protocol error rather than a
    // 500 is itself part of the experiment.
    console.error(JSON.stringify({ event: "mcp_exception", detail: String(err) }));
    return rpcError(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
