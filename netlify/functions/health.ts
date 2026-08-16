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

/**
 * Which deploy is answering.
 *
 * ⚠️ **`COMMIT_REF` is a build variable and is not set at function runtime.**
 * The first version of this endpoint read it and reported `commit: null` —
 * an identity endpoint with no identity in it. Measured against the live
 * deploy, not assumed.
 *
 * The deploy id *is* available, on the context argument Netlify passes as the
 * second parameter. It maps to a commit in one step: the Netlify UI's deploy
 * page, or `netlify api getDeploy --data '{"deploy_id":"..."}'`.
 *
 * Typed loosely on purpose — reading three fields defensively is cheaper than
 * taking on `@netlify/functions` as a dependency for its `Context` type.
 */
interface NetlifyContext {
  deploy?: { id?: string; context?: string; published_at?: string };
  site?: { name?: string };
}

function deployInfo(context: NetlifyContext | undefined): Record<string, string | null> {
  return {
    deploy_id: context?.deploy?.id ?? process.env.DEPLOY_ID ?? null,
    published_at: context?.deploy?.published_at ?? null,
    context: context?.deploy?.context ?? process.env.CONTEXT ?? null,
    site: context?.site?.name ?? process.env.SITE_NAME ?? null,
    // Only present if someone sets it as a real environment variable in the UI.
    commit: process.env.COMMIT_REF ?? null,
    note: "commit is null unless COMMIT_REF is set in the UI; deploy_id identifies the build",
  };
}

export default async function handler(_req: Request, context?: NetlifyContext): Promise<Response> {
  const hasToken = Boolean(process.env.NOTION_TOKEN);
  const hasSecret = Boolean(process.env.CLIP_SHARED_SECRET);
  // Required since the hardcoded default was removed. Reported the same way as
  // the secrets, because a missing one breaks the service just as completely —
  // and this endpoint exists to make that answerable in one request.
  const hasDataSource = Boolean(process.env.RESOURCES_DATA_SOURCE_ID);
  const ok = hasToken && hasSecret && hasDataSource;

  const body = {
    service: "clip2notion",
    ok,
    checked_at: new Date().toISOString(),
    deploy: deployInfo(context),
    env: {
      // Presence only. Reporting the value of either of these would turn a
      // convenience endpoint into a credential leak.
      NOTION_TOKEN: hasToken ? "set" : "MISSING",
      CLIP_SHARED_SECRET: hasSecret ? "set" : "MISSING",
      // Not a secret, but not echoed either: it identifies a private database.
      RESOURCES_DATA_SOURCE_ID: hasDataSource ? "set" : "MISSING",
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
