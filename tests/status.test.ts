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

import { deriveClipStatus, selectBlocksToDelete } from "../src/pipeline";
import { describeClipTime } from "../src/status";
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

/** What a Resources template seeds into a brand-new page: a toggle and a divider. */
function templateFurniture(): NotionBlockRecord[] {
  return [
    record(
      {
        object: "block",
        type: "toggle",
        toggle: { rich_text: [{ type: "text", text: { content: "Version 1.0" } }] },
      },
      "tpl-toggle",
    ),
    record({ object: "block", type: "divider", divider: {} }, "tpl-divider"),
  ];
}

test("a fresh page carrying only template furniture reads as not_started", () => {
  // Resources templates seed a version toggle and a divider, so a newly created
  // page is never empty. Reading that as "a clip is mid-write" would have the
  // caller poll a page where nothing is running, then report a dead run.
  assert.equal(deriveClipStatus(templateFurniture()).state, "not_started");
});

test("template furniture plus a finished clip still reads as clipped", () => {
  const status = deriveClipStatus([...templateFurniture(), header, paragraph]);
  assert.equal(status.state, "clipped");
  assert.equal(status.sourceUrl, "https://example.com/piece");
});

test("a half-deleted article with no markers is NOT reported as not_started", () => {
  // The P0 defect. A forced re-clip deletes the old blocks one at a time and
  // the header goes first, so there is a real window where article content
  // exists with no header above it. Calling that "nothing was clipped" steers
  // the caller into a fresh non-force clip, appending a second copy.
  const remnants = Array.from({ length: 8 }, (_, i) =>
    record(
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: `orphaned para ${i}` } }] },
      },
      `orphan-${i}`,
    ),
  );

  const status = deriveClipStatus(remnants);

  assert.notEqual(status.state, "not_started", "article content must never read as empty");
  assert.equal(status.state, "in_progress");
});

test("unattributed content is dated, so the caller can time it out", () => {
  // A page the Notion Web Clipper filled looks exactly like the half-deleted
  // clip above: content, no marker of ours. It reported IN_PROGRESS to ten
  // consecutive calls with no time attached, and nothing the caller could do
  // would ever end that — the fifteen-minute rule needs a timestamp to apply to.
  // Reporting the newest block gives it one: a live run has a block seconds
  // old, a Web Clipper save from hours ago does not.
  const blocks = Array.from({ length: 8 }, (_, i) =>
    record(
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: `clipper para ${i}` } }] },
        created_time: `2026-08-16T18:${String(40 + i).padStart(2, "0")}:00.000Z`,
      },
      `wc-${i}`,
    ),
  );

  const status = deriveClipStatus(blocks);

  assert.equal(status.state, "in_progress");
  assert.equal(status.markerCreatedAt, "2026-08-16T18:47:00.000Z", "the newest block, not the oldest");
});

test("unattributed content with no timestamps still reports a state", () => {
  // Notion has always stamped created_time, but a missing one must degrade to
  // "no time reported" rather than throwing or inventing one.
  const blocks = Array.from({ length: 6 }, (_, i) =>
    record(
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: `para ${i}` } }] },
      },
      `undated-${i}`,
    ),
  );

  const status = deriveClipStatus(blocks);

  assert.equal(status.state, "in_progress");
  assert.equal(status.markerCreatedAt, undefined);
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

  // The point is that it is not "clipped" — a stray link is not a clip header.
  assert.notEqual(deriveClipStatus([decoy]).state, "clipped");
});

// --- What a forced re-clip deletes ------------------------------------------

test("content above the clip header survives a forced re-clip", () => {
  // Every Resources page now has template furniture above the clip, so this is
  // the normal case rather than an edge one. If deletion ever became "from the
  // first block", a re-clip would silently eat the template's version toggle.
  const furniture = templateFurniture();
  const body = record(
    {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "article body" } }] },
    },
    "body",
  );

  const doomed = selectBlocksToDelete([...furniture, header, body], "https://example.com/piece");
  const doomedIds = doomed.map((block) => block.id);

  assert.deepEqual(doomedIds, ["header", "body"], "only the clip itself is removed");
  for (const kept of furniture) {
    assert.ok(!doomedIds.includes(kept.id), `${kept.id} must survive`);
  }
});

test("a forced re-clip sweeps stale callouts but never its own marker", () => {
  const running = record(statusCallout("clp_current"), "current-marker");
  const stale = record(errorCallout("Old failure.", "clp_old"), "stale-error");

  const doomed = selectBlocksToDelete(
    [...templateFurniture(), stale, running, header],
    "https://example.com/piece",
    "current-marker",
  ).map((block) => block.id);

  assert.ok(doomed.includes("stale-error"), "a stale error callout is swept");
  assert.ok(doomed.includes("header"), "the previous clip goes");
  assert.ok(!doomed.includes("current-marker"), "this run's own marker must survive");
  assert.ok(!doomed.includes("tpl-toggle"), "template furniture must survive");
});

test("with no matching header, a forced re-clip deletes no page content", () => {
  const doomed = selectBlocksToDelete(
    [...templateFurniture(), paragraph],
    "https://example.com/never-clipped",
  );

  assert.deepEqual(doomed, [], "a URL that was never clipped removes nothing");
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
  assert.notEqual(deriveClipStatus([linkless]).state, "clipped");
});

// --- When the clip was written ---------------------------------------------

test("clipped reports when the header was created, so a re-clip is verifiable", () => {
  // `CLIPPED` says the same thing whether a re-run just finished or the previous
  // clip is sitting untouched. Three forced re-clips were unverifiable from the
  // caller's side for exactly this reason.
  const stamped = { ...header, created_time: "2026-08-15T00:31:00.000Z" } as NotionBlockRecord;
  const status = deriveClipStatus([stamped, paragraph]);

  assert.equal(status.state, "clipped");
  assert.equal(status.markerCreatedAt, "2026-08-15T00:31:00.000Z");
});

test("in_progress reports when the run started", () => {
  const stamped = { ...progress, created_time: "2026-08-15T00:31:00.000Z" } as NotionBlockRecord;
  const status = deriveClipStatus([stamped]);

  assert.equal(status.state, "in_progress");
  assert.equal(status.markerCreatedAt, "2026-08-15T00:31:00.000Z");
});

test("a missing or malformed timestamp is simply not reported", () => {
  // Never a decision input, so an absent value degrades to silence rather than
  // to a wrong claim about when something happened.
  assert.equal(deriveClipStatus([header, paragraph]).markerCreatedAt, undefined);
  assert.equal(
    deriveClipStatus([{ ...header, created_time: 12345 } as unknown as NotionBlockRecord]).markerCreatedAt,
    undefined,
  );
  assert.equal(describeClipTime(undefined), null);
  assert.equal(describeClipTime("not a date"), null);
});

test("the written time reads absolutely and relatively", () => {
  const now = Date.parse("2026-08-15T01:00:00.000Z");

  assert.equal(describeClipTime("2026-08-15T00:59:40.000Z", now), "2026-08-15 00:59 UTC (moments ago)");
  assert.equal(describeClipTime("2026-08-15T00:59:00.000Z", now), "2026-08-15 00:59 UTC (1 minute ago)");
  assert.equal(describeClipTime("2026-08-15T00:30:00.000Z", now), "2026-08-15 00:30 UTC (30 minutes ago)");
  assert.equal(describeClipTime("2026-08-14T22:00:00.000Z", now), "2026-08-14 22:00 UTC (3 hours ago)");
  assert.equal(describeClipTime("2026-08-11T01:00:00.000Z", now), "2026-08-11 01:00 UTC (4 days ago)");
});
