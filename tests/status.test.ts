/**
 * Tests for clip status derivation.
 *
 * This is what turns "did it work" from something a caller infers from prose
 * into something it can check. The ordering rules are the substance: a run that
 * died partway leaves both partial content and an error callout, and reporting
 * that as a success would be the exact failure the whole design guards against.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { deriveClipStatus } from "../src/pipeline";
import { clipHeader, errorCallout, statusCallout, type Block } from "../src/blocks";
import type { NotionBlockRecord } from "../src/notion";

/** Dress a generated block up as a block record returned by the Notion API. */
function record(block: Block, id = "blk"): NotionBlockRecord {
  return { id, has_children: false, ...block } as unknown as NotionBlockRecord;
}

const header = record(
  clipHeader({ title: "A Piece", url: "https://example.com/piece", siteName: "Example" }),
  "header",
);
const progress = record(statusCallout("clp_test1"), "progress");
const failure = record(errorCallout("Paywall detected.", "clp_test1"), "failure");

const paragraph = record(
  {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: "Body text." } }] },
  },
  "para",
);

test("an empty page is not_started", () => {
  assert.equal(deriveClipStatus([]).state, "not_started");
});

test("a page holding content but no markers is NOT reported as not_started", () => {
  // The P0 defect. A forced re-clip deletes the old blocks one at a time and
  // the header goes first, so there is a real window where content exists with
  // no header above it. Calling that "nothing was clipped" steers the caller
  // into a fresh non-force clip, which appends a second copy of the article.
  const status = deriveClipStatus([paragraph]);

  assert.notEqual(status.state, "not_started", "content without a marker must never read as empty");
  assert.equal(status.state, "in_progress");
});

test("only a genuinely empty page is not_started", () => {
  assert.equal(deriveClipStatus([]).state, "not_started");

  const divider = record({ object: "block", type: "divider", divider: {} }, "div1");
  assert.equal(deriveClipStatus([divider]).state, "not_started", "a bare divider is not content");
});

test("a progress callout means in_progress", () => {
  assert.equal(deriveClipStatus([progress]).state, "in_progress");
});

test("a clip header means clipped, and reports the source URL", () => {
  const status = deriveClipStatus([header, paragraph]);
  assert.equal(status.state, "clipped");
  assert.equal(status.sourceUrl, "https://example.com/piece");
});

test("an error callout means failed, and carries the message", () => {
  const status = deriveClipStatus([failure]);
  assert.equal(status.state, "failed");
  assert.match(status.detail ?? "", /Paywall detected/);
});

test("a partially written clip reports failed, not clipped", () => {
  // The dangerous case: content AND a header AND an error callout all present.
  // Reporting this as success would tell the user a truncated article is fine.
  const status = deriveClipStatus([failure, header, paragraph]);
  assert.equal(status.state, "failed", "an error callout must outrank a present header");
});

test("an error callout outranks a progress callout", () => {
  assert.equal(deriveClipStatus([failure, progress]).state, "failed");
});

test("a progress callout outranks a header from an earlier clip", () => {
  // A forced re-clip in flight: the old header is still there while the new run
  // is running. Reporting "clipped" would describe the previous run's result.
  assert.equal(deriveClipStatus([header, progress]).state, "in_progress");
});

test("a paragraph that merely mentions a link is not mistaken for the header", () => {
  const decoy = record(
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "See ", link: null } },
          { type: "text", text: { content: "this", link: { url: "https://example.com/x" } } },
        ],
      },
    },
    "decoy",
  );

  // Not "clipped": a stray link is not a clip header. It reads as in_progress
  // now rather than not_started, because content is present.
  assert.equal(deriveClipStatus([decoy]).state, "in_progress");
});

test("the header must carry a link, not just the prefix text", () => {
  const linkless = record(
    {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "Source: something" } }] },
    },
    "linkless",
  );

  // The prefix alone must not count as a header — a clip header always carries
  // the source link, which is what makes it the idempotency key.
  assert.equal(deriveClipStatus([linkless]).state, "in_progress");
});
