/**
 * Error classes, distinguished because the user's next action differs for each.
 *
 * Two properties matter and both are load-bearing:
 *
 *  - `transient` decides whether the failure is allowed to throw out of the
 *    handler. Netlify retries a failed background function at 1min and 2min, so
 *    throwing on a paywall means running it three times to reach the same answer.
 *  - `userMessage` is what gets written into the Notion page. It is read by a
 *    person looking at a half-empty page, so it says what to do, not what broke.
 */

export type ClipErrorCode =
  | "FETCH_FAILED"
  | "BLOCKED"
  | "NOT_EXTRACTABLE"
  | "NOTION_FAILED"
  | "INVALID_TARGET"
  | "INVALID_REQUEST";

export class ClipError extends Error {
  readonly code: ClipErrorCode;
  readonly transient: boolean;
  readonly userMessage: string;
  /** Upstream HTTP status, when the failure came from one. Logged as a field. */
  readonly httpStatus?: number;

  constructor(
    code: ClipErrorCode,
    userMessage: string,
    options: { transient?: boolean; detail?: string; cause?: unknown; httpStatus?: number } = {},
  ) {
    super(options.detail ? `${code}: ${userMessage} (${options.detail})` : `${code}: ${userMessage}`);
    this.name = "ClipError";
    this.code = code;
    this.transient = options.transient ?? false;
    this.userMessage = userMessage;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export const errors = {
  fetchFailed: (detail: string, cause?: unknown) =>
    new ClipError(
      "FETCH_FAILED",
      "Couldn't reach the article. The site may be down or slow — try again in a few minutes.",
      { transient: true, detail, cause },
    ),

  fetchRejected: (status: number, url: string) =>
    new ClipError(
      "FETCH_FAILED",
      `The site returned an error (HTTP ${status}) instead of the article.`,
      // 5xx and 429 are worth a retry; 404 and friends are not.
      { transient: status >= 500 || status === 429, detail: url },
    ),

  /**
   * A real wall: the content sits behind a login or a subscription. Telling the
   * user an account is needed is accurate here and nowhere else.
   */
  paywalled: (reason: string) =>
    new ClipError(
      "BLOCKED",
      "Paywall detected — this article is behind a login or subscription, so it can't " +
        "be fetched. Use the Notion Web Clipper for this one.",
      { detail: reason },
    ),

  /**
   * The site's edge refused the request outright.
   *
   * Not a paywall, and the distinction is the whole point of splitting this out:
   * there is nothing to log into, and the article is usually readable in a
   * browser right now. Bot protection scores the *client*, not the reader — and
   * a server-side fetch from Node loses that scoring on its TLS fingerprint
   * alone, whatever headers it sends.
   *
   * Measured on ecuad.ca 2026-08-16, from a residential IP: curl over HTTP/1.1
   * and Python both got 200 while Node's `fetch` and `node:https` both got 403 —
   * same IP, same headers, and undici's exact header set replayed through curl
   * still got 200. Cipher and curve tuning from Node changed nothing.
   *
   * So "send browser-like headers" is not a fix for this, and the message must
   * not imply the user did anything wrong or that an account would help.
   */
  refused: (status: number, host: string) =>
    new ClipError(
      "BLOCKED",
      `${host} refused this request (HTTP ${status}) — its bot protection blocks ` +
        "automated fetches. This is not a paywall and no login will help. The Notion " +
        "Web Clipper runs inside your browser and should clip it fine.",
      { detail: `HTTP ${status} from ${host}`, httpStatus: status },
    ),

  /** A challenge or interstitial arrived with a 200. Same cause as `refused`. */
  botChallenge: (host: string, title: string) =>
    new ClipError(
      "BLOCKED",
      `${host} served a bot-check page instead of the article — its bot protection ` +
        "blocks automated fetches. This is not a paywall and no login will help. The " +
        "Notion Web Clipper runs inside your browser and should clip it fine.",
      { detail: `Bot-block page title: ${title}` },
    ),

  /**
   * Rate-limited. Left non-transient on purpose: throwing would hand it to
   * Netlify's 1min/2min retries, which is more traffic aimed at a host that has
   * just asked for less. The message tells the user to retry instead.
   */
  rateLimited: (host: string) =>
    new ClipError(
      "BLOCKED",
      `${host} is rate-limiting this service (HTTP 429). Not a paywall — wait a few ` +
        "minutes and clip it again.",
      { detail: `HTTP 429 from ${host}`, httpStatus: 429 },
    ),

  notExtractable: (detail: string) =>
    new ClipError(
      "NOT_EXTRACTABLE",
      "Fetched the page but couldn't find an article in it. It may be a landing page, " +
        "a video, or rendered entirely in JavaScript. Use the Notion Web Clipper for this one.",
      { detail },
    ),

  notionFailed: (detail: string, transient: boolean, cause?: unknown) =>
    new ClipError("NOTION_FAILED", "Notion rejected the write.", { transient, detail, cause }),

  invalidTarget: (detail: string) =>
    new ClipError(
      "INVALID_TARGET",
      "That page isn't in the Resources database, so nothing was written.",
      { detail },
    ),

  invalidRequest: (detail: string) =>
    new ClipError("INVALID_REQUEST", "The request was malformed.", { detail }),
};

export function toClipError(err: unknown): ClipError {
  if (err instanceof ClipError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  // Unknown failures are treated as non-transient on purpose: an unrecognised
  // error retried twice is two more chances to append duplicate content.
  return new ClipError("NOTION_FAILED", "Something went wrong while clipping.", {
    transient: false,
    detail,
    cause: err,
  });
}
