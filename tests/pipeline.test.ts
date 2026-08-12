/**
 * The idempotency-key ordering guarantee, and request parsing.
 *
 * The ordering test exists because the guarantee is easy to break by accident
 * and impossible to notice when you do: the failure only appears when a run
 * dies mid-append AND Netlify retries it, days later, as a duplicated article.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildAppendBatches } from "../src/pipeline";
import { clipHeader, type Block } from "../src/blocks";
import { normalizePageId, parseClipRequest, secretMatches } from "../src/request";

const header = clipHeader({ title: "A Piece", url: "https://example.com/piece" });

function contentBlocks(count: number): Block[] {
  return Array.from({ length: count }, (_, i) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: `para ${i}` } }] },
  }));
}

// --- The ordering guarantee ------------------------------------------------

test("the header ships with the first content in the single-batch case", () => {
  // The trivial path: a short article, one append call. The guarantee holds by
  // accident here, which is exactly why it needs pinning down.
  const batches = buildAppendBatches(header, contentBlocks(10), 100);

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 11);
  assert.equal(batches[0]![0], header);
  assert.ok(batches[0]!.length > 1, "the header must never be appended alone");
});

test("the header ships with the first content when the article spans many batches", () => {
  const batches = buildAppendBatches(header, contentBlocks(250), 100);

  assert.equal(batches.length, 3);
  assert.equal(batches[0]![0], header, "the header must lead the first batch");
  assert.ok(batches[0]!.length > 1, "the first batch must carry content alongside the header");
  for (const batch of batches) {
    assert.ok(batch.length <= 100, "batches must respect the 100-child append limit");
  }
});

test("the header ships with content even for a one-block article", () => {
  const batches = buildAppendBatches(header, contentBlocks(1), 100);

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.length, 2);
  assert.equal(batches[0]![0], header);
});

test("no block is lost or duplicated across batching", () => {
  const blocks = contentBlocks(250);
  const flattened = buildAppendBatches(header, blocks, 100).flat();

  assert.equal(flattened.length, 251);
  assert.equal(flattened[0], header);
  assert.deepEqual(flattened.slice(1), blocks);
});

test("an exact multiple of the batch size does not produce a trailing header-only batch", () => {
  // 99 content blocks + 1 header = exactly 100.
  const batches = buildAppendBatches(header, contentBlocks(99), 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 100);
});

// --- Request parsing -------------------------------------------------------

test("page ids are accepted with or without dashes", () => {
  const dashed = "2f1b8c4e-1234-4abc-8def-0123456789ab";
  assert.equal(normalizePageId(dashed), dashed);
  assert.equal(normalizePageId(dashed.replace(/-/g, "")), dashed);
  assert.equal(normalizePageId("  2F1B8C4E1234" + "4ABC8DEF0123456789AB  "), dashed);
});

test("bad page ids are refused", () => {
  for (const bad of ["", "not-an-id", "12345", null, 42, undefined]) {
    assert.equal(normalizePageId(bad), null, `should refuse ${String(bad)}`);
  }
});

test("force defaults to false and is only true when explicitly true", () => {
  const base = { page_id: "2f1b8c4e12344abc8def0123456789ab", url: "https://example.com/a" };

  const plain = parseClipRequest(base);
  assert.ok(plain.ok && plain.value.force === false);

  const forced = parseClipRequest({ ...base, force: true });
  assert.ok(forced.ok && forced.value.force === true);

  // Truthy-but-not-true values must not trigger a destructive re-clip.
  for (const value of ["true", 1, {}, "yes"]) {
    const parsed = parseClipRequest({ ...base, force: value });
    assert.ok(parsed.ok && parsed.value.force === false, `force must stay false for ${JSON.stringify(value)}`);
  }
});

test("a missing url or page_id is a parse failure, not a default", () => {
  assert.equal(parseClipRequest({ url: "https://example.com/a" }).ok, false);
  assert.equal(parseClipRequest({ page_id: "2f1b8c4e12344abc8def0123456789ab" }).ok, false);
  assert.equal(parseClipRequest(null).ok, false);
  assert.equal(parseClipRequest("nope").ok, false);
});

// --- Auth ------------------------------------------------------------------

test("secret comparison accepts the match and refuses everything else", () => {
  assert.equal(secretMatches("s3cret", "s3cret"), true);
  assert.equal(secretMatches("s3cret", "s3creT"), false);
  assert.equal(secretMatches("", "s3cret"), false);
  // Length mismatches must not throw — hashing first is what makes that safe.
  assert.equal(secretMatches("short", "a much longer secret value"), false);
});
