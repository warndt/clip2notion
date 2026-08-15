/**
 * What is actually running right now.
 *
 * This exists because "is the fix live?" cost two rounds of guessing: a missing
 * hero looks identical whether the code shipped, the build failed, or a flag is
 * doing exactly what it was told. A commit SHA answers it in one request.
 *
 * Deliberately unauthenticated and deliberately value-free. Secrets are reported
 * as present or missing, never echoed — the point is to make configuration
 * checkable without making it readable.
 *
 * Light imports only. This is a synchronous function under Netlify's 10s clock,
 * so it must never reach the converter and pull jsdom in behind it.
 */

import { TUNABLES } from "../../src/config";

/** Netlify sets these on the deploy; absent under `netlify dev`. */
function deployInfo(): Record<string, string | null> {
  return {
    commit: process.env.COMMIT_REF ?? null,
    branch: process.env.BRANCH ?? null,
    context: process.env.CONTEXT ?? null,
    deploy_id: process.env.DEPLOY_ID ?? null,
  };
}

export default async function handler(_req: Request): Promise<Response> {
  const hasToken = Boolean(process.env.NOTION_TOKEN);
  const hasSecret = Boolean(process.env.CLIP_SHARED_SECRET);
  const ok = hasToken && hasSecret;

  const body = {
    service: "clip2notion",
    ok,
    checked_at: new Date().toISOString(),
    deploy: deployInfo(),
    env: {
      // Presence only. Reporting the value of either of these would turn a
      // convenience endpoint into a credential leak.
      NOTION_TOKEN: hasToken ? "set" : "MISSING",
      CLIP_SHARED_SECRET: hasSecret ? "set" : "MISSING",
      RESOURCES_DATA_SOURCE_ID: process.env.RESOURCES_DATA_SOURCE_ID ? "overridden" : "default",
    },
    config: {
      notion_api_version: process.env.NOTION_API_VERSION ?? "(pinned default)",
      lead_image_mode: TUNABLES.leadImageMode,
      max_blocks: TUNABLES.maxBlocks,
      max_images: TUNABLES.maxImages,
    },
  };

  // 503 when a required secret is missing: a health check that answers 200 to
  // everything is a health check nobody can act on.
  return new Response(JSON.stringify(body, null, 2), {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
