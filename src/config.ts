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
   * How long a status call may block waiting for a clip to settle.
   *
   * ⚠️ **A synchronous Netlify function is killed at 10 seconds.** These budgets
   * must leave room for the Notion round trips either side of the wait, or the
   * function is terminated mid-flight and the caller sees "the server isn't
   * responding" — which reads as an outage rather than as a clip in progress.
   *
   * This was set to 20s once and did exactly that. The waiting is a convenience;
   * exceeding the platform limit to get it is not a trade worth making.
   */
  statusWaitBudgetMs: num("STATUS_WAIT_BUDGET_MS", 4500),
  statusPollIntervalMs: num("STATUS_POLL_INTERVAL_MS", 1200),

  /**
   * How long clip_article waits after dispatch before answering.
   *
   * Shorter than the status budget on purpose. A timeout here is worse than a
   * timeout anywhere else: the dispatch has already happened, so the caller
   * sees a transport error for work that is running.
   */
  dispatchWaitBudgetMs: num("DISPATCH_WAIT_BUDGET_MS", 3500),

  /**
   * How long to wait for a dispatched run to plant its progress marker before
   * concluding it isn't running. Until that marker appears, anything on the
   * page belongs to a previous clip and must not be reported as this one's.
   */
  runStartWaitMs: num("RUN_START_WAIT_MS", 4000),

  /**
   * Hard ceiling on time spent inside a synchronous function, measured from
   * entry. Belt and braces against the 10s kill: every wait loop checks it, so
   * adding another one cannot silently reintroduce the timeout.
   */
  syncFunctionBudgetMs: num("SYNC_FUNCTION_BUDGET_MS", 6000),

  /**
   * Ceiling when the container has just cold-started.
   *
   * Netlify's 10s clock covers container initialisation, but a handler can only
   * measure from its own entry — so on a cold start several seconds are already
   * gone before any of this code runs. `mcp.ts` transitively imports jsdom,
   * which makes that init expensive.
   *
   * Measured cold: ~6s for a call that does no waiting at all. Adding a full
   * wait on top of that is what produced intermittent "server isn't responding"
   * errors mid-poll.
   */
  coldStartBudgetMs: num("COLD_START_BUDGET_MS", 2500),

  /** A handler entered within this long of module load is on a cold container. */
  coldStartWindowMs: num("COLD_START_WINDOW_MS", 1500),
} as const;
