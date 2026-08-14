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
