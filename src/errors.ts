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

  constructor(
    code: ClipErrorCode,
    userMessage: string,
    options: { transient?: boolean; detail?: string; cause?: unknown } = {},
  ) {
    super(options.detail ? `${code}: ${userMessage} (${options.detail})` : `${code}: ${userMessage}`);
    this.name = "ClipError";
    this.code = code;
    this.transient = options.transient ?? false;
    this.userMessage = userMessage;
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

  blocked: (reason: string) =>
    new ClipError(
      "BLOCKED",
      "Paywall or bot-block detected — this article can't be fetched without a login. " +
        "Use the Notion Web Clipper for this one.",
      { detail: reason },
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
