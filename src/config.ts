/**
 * Env vars and every tunable in one place. No magic numbers elsewhere.
 *
 * Anything here can be overridden by an env var of the same name, so a bad
 * default can be fixed in the Netlify UI without a deploy (deploys cost money).
 */

export interface Config {
  notionToken: string;
  sharedSecret: string;
  dataSourceId: string;
  notionVersion: string;
}

const DEFAULT_DATA_SOURCE_ID = "<your-data-source-id>";

/** Checked against the live docs on 2026-08-11. This value moves — re-check it. */
const DEFAULT_NOTION_VERSION = "2026-03-11";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): Config {
  return {
    notionToken: requireEnv("NOTION_TOKEN"),
    sharedSecret: requireEnv("CLIP_SHARED_SECRET"),
    dataSourceId: process.env.RESOURCES_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID,
    notionVersion: process.env.NOTION_API_VERSION || DEFAULT_NOTION_VERSION,
  };
}

export const TUNABLES = {
  /** Source fetch. Generous — background functions have 15 minutes to play with. */
  fetchTimeoutMs: num("FETCH_TIMEOUT_MS", 30_000),
  fetchMaxBytes: num("FETCH_MAX_BYTES", 8_000_000),
  maxRedirects: num("MAX_REDIRECTS", 5),
  userAgent:
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",

  /** Below this many characters of extracted text, assume extraction failed. */
  minArticleChars: num("MIN_ARTICLE_CHARS", 400),

  /** Notion hard limits. Not tunable in any meaningful sense — documented here so
   *  the numbers have names at their call sites. */
  richTextCharLimit: 2000,
  richTextArrayLimit: 100,
  appendBatchSize: 100,
  maxNestDepth: num("MAX_NEST_DEPTH", 2),

  /** Safety ceiling on a single article. Hitting it is logged, never silent. */
  maxBlocks: num("MAX_BLOCKS", 4000),
  maxImages: num("MAX_IMAGES", 80),

  /** Notion allows ~3 req/s averaged. One request per 350ms leaves headroom. */
  notionMinRequestGapMs: num("NOTION_MIN_REQUEST_GAP_MS", 350),
  notionMaxRetries: num("NOTION_MAX_RETRIES", 4),
  notionRetryBaseMs: num("NOTION_RETRY_BASE_MS", 1000),

  /** Image import is asynchronous on Notion's side and must be polled. */
  imageConcurrency: num("IMAGE_CONCURRENCY", 3),
  imagePollTimeoutMs: num("IMAGE_POLL_TIMEOUT_MS", 120_000),
  imagePollIntervalMs: num("IMAGE_POLL_INTERVAL_MS", 2000),
  imagePollMaxIntervalMs: num("IMAGE_POLL_MAX_INTERVAL_MS", 15_000),

  /** Images smaller than this in either dimension are spacers or tracking pixels. */
  minImageDimension: num("MIN_IMAGE_DIMENSION", 33),

  /**
   * Lead image — the hero that sits outside the readable body.
   *
   * `off` skips selection entirely. `detect` runs it and logs what it *would*
   * insert without touching the page. `insert` places it below the header.
   *
   * Defaults to `detect` so the first deploy produces log evidence over a
   * spread of real sites before anything reaches a page: the risk being
   * managed is a site logo appearing at the top of every clip, which is a
   * visible defect on every page rather than a missing bonus on one.
   *
   * An unrecognised value behaves as `detect`, which is the safe direction for
   * a typo to fail in.
   *
   * ⚠️ A Netlify env change does not reach live functions without a redeploy.
   */
  leadImageMode: (process.env.LEAD_IMAGE_MODE || "detect").toLowerCase(),

  /**
   * A lead candidate below this on either axis is furniture, not a hero.
   * Much stricter than `minImageDimension`, which only screens spacers.
   */
  leadImageMinDimension: num("LEAD_IMAGE_MIN_DIMENSION", 200),

  /** Longer than this and the text beside the image is prose, not a credit line. */
  leadImageMaxCaptionChars: num("LEAD_IMAGE_MAX_CAPTION_CHARS", 200),

  /** How much text makes a `<p>` article prose rather than a label or a teaser. */
  leadImageBodyParagraphChars: num("LEAD_IMAGE_BODY_PARAGRAPH_CHARS", 100),

  /**
   * How many unattributed content blocks make a page look mid-write rather than
   * merely furnished.
   *
   * Resources templates seed body content — a version toggle and a divider — so
   * "has content" no longer implies "a clip is in flight". Below this count the
   * page reads as template furniture; at or above it, as an article being
   * deleted or written. A partially deleted clip is also marked by its progress
   * callout, so this is a second line of defence rather than the only one.
   */
  orphanContentThreshold: num("ORPHAN_CONTENT_THRESHOLD", 5),

  /**
   * How long a status call may block waiting for a clip to settle.
   *
   * ⚠️ **The binding limit is the MCP client's patience, not Netlify's.** A
   * synchronous function is killed at 10s, but measurement showed calls that
   * reached the function and returned successfully in ~5s still surfaced to the
   * caller as "the connector's server isn't responding". Every request that
   * arrived completed; the failures never arrived at all. So claude.ai gives up
   * well before Netlify does, and these budgets target roughly 3s.
   *
   * Waiting is a convenience. A response the caller never sees is worse than an
   * early IN_PROGRESS it can simply ask about again.
   */
  statusWaitBudgetMs: num("STATUS_WAIT_BUDGET_MS", 2500),
  statusPollIntervalMs: num("STATUS_POLL_INTERVAL_MS", 1200),

  /**
   * How long clip_article waits after dispatch before answering.
   *
   * Much shorter than the status budget, because this call is already the
   * slowest: it waits on clip-background's own cold start, which is genuinely
   * heavy (6.5MB with jsdom). A timeout here is also the worst kind — the
   * dispatch has happened, so the caller sees a transport error for work that
   * is running, and must not retry it.
   */
  dispatchWaitBudgetMs: num("DISPATCH_WAIT_BUDGET_MS", 1200),

  /**
   * How long to wait for a dispatched run to plant its progress marker before
   * concluding it isn't running. Until that marker appears, anything on the
   * page belongs to a previous clip and must not be reported as this one's.
   *
   * Capped by the budgets above in practice — kept small so it cannot become
   * the reason a response arrives too late to be seen.
   */
  runStartWaitMs: num("RUN_START_WAIT_MS", 1200),

  /**
   * Hard ceiling on time spent inside a synchronous function, measured from
   * entry. Every wait loop checks it, so adding another cannot silently push
   * responses past the point where the client stops listening.
   */
  syncFunctionBudgetMs: num("SYNC_FUNCTION_BUDGET_MS", 3500),

  /**
   * Ceiling when the container has just cold-started.
   *
   * Container initialisation happens before a handler can observe anything, so
   * a cold request has already spent time no measurement here can see. `mcp.ts`
   * no longer imports jsdom, which cut this sharply — cold status calls went
   * from ~6s to under 2s — but the first call of a quiet period is still the
   * slowest, and it is the one most likely to be abandoned by the client.
   */
  coldStartBudgetMs: num("COLD_START_BUDGET_MS", 1200),

  /** A handler entered within this long of module load is on a cold container. */
  coldStartWindowMs: num("COLD_START_WINDOW_MS", 1500),
} as const;
