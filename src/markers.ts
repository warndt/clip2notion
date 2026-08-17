/**
 * Text markers the service writes into pages and later reads back.
 *
 * Their own module, with no dependencies, so that reading a page's state does
 * not drag in the HTML converter. `mcp.ts` needs these; it must never need
 * jsdom. See the note on cold starts in CLAUDE.md.
 */

/** Opens the in-progress callout. */
export const STATUS_MARKER = "Clipping in progress";

/** Opens the error callout. */
export const ERROR_MARKER = "Clipping failed";

/** Opens the clip header paragraph, which doubles as the idempotency key. */
export const HEADER_PREFIX = "Source:";

/**
 * Appears in an error callout when the run had already written article content.
 *
 * Read back as evidence of ownership. A run that wrote nothing cannot be the
 * author of an article sitting on the page, so its error cannot be describing
 * that article — and no clock is needed to establish it. Notion records block
 * creation only to the minute, and a failure followed by a fresh clip lands
 * inside one minute easily, so timestamps alone cannot separate "this error
 * belongs to the article below it" from "this error belongs to an earlier run".
 */
export const PARTIAL_WRITE_MARKER = "Part of the article was already written";
