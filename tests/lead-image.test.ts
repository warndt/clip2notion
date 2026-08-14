/**
 * The hero that lives outside the article body.
 *
 * This is an invisible-failure case in both directions, which is why it is
 * tested at all. Miss the hero and the clip looks complete while an image is
 * gone; take the wrong candidate and every clip from that site carries a site
 * logo at the top. Both look fine in code review.
 *
 * The markup shapes below are copied from real pages — TechCrunch's featured
 * image above the `<h1>`, Substack's avatars and captioned images, WordPress's
 * `-1024x683` resize suffix.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { normalizeImageUrl, selectLeadImage, type LeadImageResult } from "../src/lead-image";
import { applyLeadImage } from "../src/pipeline";
import { collectImageBlocks, htmlToBlocks, imageBlock, leadImageBlock, type Block } from "../src/blocks";

const BASE = "https://example.com/2026/08/an-article/";

function docFrom(body: string): Document {
  return new JSDOM(`<!DOCTYPE html><html><body>${body}</body></html>`, { url: BASE }).window.document;
}

const PROSE =
  "Bill Swearingen has spent the past year running largely the same test over and over again, " +
  "and the results are consistent enough that they are worth writing down at length.";

/** A TechCrunch-shaped page: site header, hero above the `<h1>`, then the body. */
function heroAboveHeadline(extraBody = ""): string {
  return `
    <header class="wp-block-techcrunch-site-header">
      <figure class="site-header__logo-small">
        <img src="/uploads/2026/05/tc-lockup-hp.svg" width="149" height="16">
      </figure>
    </header>
    <div class="article-hero">
      <div class="article-hero__first-section">
        <figure class="wp-block-post-featured-image">
          <img width="1024" height="683" src="/uploads/2026/08/hero.jpg?w=1024"
               srcset="/uploads/2026/08/hero.jpg 1024w" style="object-fit:cover;">
          <figcaption><strong>Image Credits:</strong>Bill Swearingen</figcaption>
        </figure>
      </div>
      <div class="article-hero__middle"><h1 class="article-hero__title">An Article</h1></div>
    </div>
    <main><div class="entry-content"><p>${PROSE}</p>${extraBody}</div></main>`;
}

/** Capture the structured log lines a call emits, keyed by event. */
function logsFrom(run: () => void): Array<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const collect = (line: unknown) => {
    try {
      captured.push(JSON.parse(String(line)));
    } catch {
      /* not one of ours */
    }
  };

  console.log = collect;
  console.warn = collect;
  console.error = collect;
  try {
    run();
  } finally {
    Object.assign(console, original);
  }
  return captured;
}

function events(lines: Array<Record<string, unknown>>): string[] {
  return lines.map((line) => String(line["event"]));
}

// --- Selection -------------------------------------------------------------

test("the hero above the headline is found, with its credit line", () => {
  const result = selectLeadImage(docFrom(heroAboveHeadline()), BASE);

  assert.ok(result.candidate, "the featured image above the <h1> is the lead");
  assert.equal(result.candidate.url, "https://example.com/uploads/2026/08/hero.jpg");
  assert.equal(result.candidate.rule, "before-h1");
  assert.match(result.candidate.captionHtml ?? "", /Bill Swearingen/);
  assert.equal(result.candidate.width, 1024);
});

test("a hero just inside the body, ahead of the prose, is found too", () => {
  // Substack's shape: no separate header region, the image opens the body.
  const doc = docFrom(`
    <article class="newsletter-post">
      <h1>An Article</h1>
      <div class="body markup">
        <div class="captioned-image-container">
          <figure><img src="/img/opening.jpg" width="1456" height="816">
          <figcaption>Photo by someone</figcaption></figure>
        </div>
        <p>${PROSE}</p>
      </div>
    </article>`);

  const result = selectLeadImage(doc, BASE);

  assert.ok(result.candidate);
  assert.equal(result.candidate.rule, "before-first-paragraph");
});

test("an article container is never mistaken for chrome by its class name", () => {
  // Substack labels the article element itself `newsletter-post`. A substring
  // match on "newsletter" rejected every Substack hero — found in detect mode
  // against a real post before this ever reached a page.
  const doc = docFrom(`
    <article class="typography newsletter-post post">
      <h1>An Article</h1>
      <figure><img src="/img/opening.jpg" width="1456" height="816"></figure>
      <p>${PROSE}</p>
    </article>`);

  assert.ok(selectLeadImage(doc, BASE).candidate, "the hero must survive an editorial container");
});

test("site logos above the headline are rejected, with the reason recorded", () => {
  const doc = docFrom(`
    <header class="site-header">
      <img src="/img/tc-logo-mobile.svg" width="47" height="24">
      <img src="/img/masthead-logo.png" width="240" height="240">
      <img src="/img/wordmark.png" width="80" height="24">
      <img src="/img/promo-banner.png" width="600" height="400">
    </header>
    <h1>An Article</h1><p>${PROSE}</p>`);

  const result = selectLeadImage(doc, BASE);

  assert.equal(result.candidate, null, "no site furniture may be promoted to lead");
  assert.equal(result.rejected.length, 4);
  assert.match(result.rejected[0]!.reason, /SVG/);
  assert.match(result.rejected[1]!.reason, /logo/, "a logo filename is furniture at any size");
  assert.match(result.rejected[2]!.reason, /too small/);
  assert.match(result.rejected[3]!.reason, /header|chrome|promo/);
});

test("spacers, tracking pixels and data URIs are never the lead", () => {
  const doc = docFrom(`
    <div class="article-hero">
      <img src="/img/1x1.gif" width="1" height="1">
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <img src="/img/tracking-beacon.png">
    </div>
    <h1>An Article</h1><p>${PROSE}</p>`);

  const result = selectLeadImage(doc, BASE);

  assert.equal(result.candidate, null);
  assert.equal(result.rejected.length, 3);
});

test("an article with no hero yields no candidate and no complaint", () => {
  const doc = docFrom(`<article><h1>An Article</h1><p>${PROSE}</p></article>`);
  const result = selectLeadImage(doc, BASE);

  assert.equal(result.candidate, null);
  assert.deepEqual(result.rejected, [], "nothing was found, so nothing was rejected");
});

test("images below the first paragraph belong to the body, not the lead", () => {
  const doc = docFrom(`
    <article><h1>An Article</h1><p>${PROSE}</p>
    <figure><img src="/img/mid-article.jpg" width="900" height="600"></figure></article>`);

  assert.equal(selectLeadImage(doc, BASE).candidate, null);
});

test("a headline beside the image is not mistaken for its caption", () => {
  const doc = docFrom(`
    <div class="article-hero">
      <figure><img src="/img/hero.jpg" width="1024" height="683" alt="A patterned jacket"></figure>
      <div class="article-hero__middle"><h1>An Article</h1><span>By A. Writer</span></div>
    </div>
    <p>${PROSE}</p>`);

  const candidate = selectLeadImage(doc, BASE).candidate;

  assert.ok(candidate);
  assert.equal(candidate.captionHtml, null, "a headline block is not a credit line");
  assert.equal(candidate.alt, "A patterned jacket");
});

test("a document that makes no sense produces no lead rather than an error", () => {
  assert.doesNotThrow(() => selectLeadImage(docFrom(""), BASE));
  assert.equal(selectLeadImage(docFrom("<img src='/a.jpg'>"), BASE).candidate, null);
});

// --- Dedupe ----------------------------------------------------------------

test("normalising drops the query string and WordPress resize suffixes", () => {
  const bare = "cdn.example.com/uploads/2026/08/car.jpg";

  assert.equal(normalizeImageUrl("https://cdn.example.com/uploads/2026/08/car.jpg?w=652"), bare);
  assert.equal(normalizeImageUrl("https://cdn.example.com/uploads/2026/08/car.jpg?resize=1151,1200"), bare);
  assert.equal(normalizeImageUrl("https://cdn.example.com/uploads/2026/08/car-1024x683.jpg"), bare);
  // Different files must stay different.
  assert.notEqual(
    normalizeImageUrl("https://cdn.example.com/uploads/2026/08/hero.jpg?w=1024"),
    normalizeImageUrl("https://cdn.example.com/uploads/2026/08/car.jpg?w=1024"),
  );
});

// --- Placement -------------------------------------------------------------

function leadResult(url: string, captionHtml: string | null = null): LeadImageResult {
  return {
    candidate: { url, rule: "before-h1", captionHtml, alt: null, width: 1024, height: 683 },
    rejected: [],
  };
}

test("the lead image is inserted at the front of the body, below the header", () => {
  const { blocks } = htmlToBlocks(`<h2>First section</h2><p>${PROSE}</p>`, BASE);
  const lines = logsFrom(() =>
    applyLeadImage(blocks, leadResult("https://cdn.example.com/hero.jpg"), BASE, "clp_test", "insert"),
  );

  assert.equal(blocks[0]!.type, "image", "the lead sits above the first heading");
  assert.equal(blocks[1]!.type, "heading_2");
  assert.ok(events(lines).includes("lead_image_found"));
});

test("detect mode logs the candidate and writes nothing", () => {
  const { blocks } = htmlToBlocks(`<p>${PROSE}</p>`, BASE);
  const before = blocks.length;

  const lines = logsFrom(() =>
    applyLeadImage(blocks, leadResult("https://cdn.example.com/hero.jpg"), BASE, "clp_test", "detect"),
  );
  const found = lines.find((line) => line["event"] === "lead_image_found");

  assert.equal(blocks.length, before, "detect mode must not touch the page");
  assert.equal(found?.["inserted"], false);
  assert.equal(found?.["mode"], "detect");
});

test("off mode selects nothing and logs nothing", () => {
  const { blocks } = htmlToBlocks(`<p>${PROSE}</p>`, BASE);
  const lines = logsFrom(() =>
    applyLeadImage(blocks, leadResult("https://cdn.example.com/hero.jpg"), BASE, "clp_test", "off"),
  );

  assert.deepEqual(events(lines), []);
  assert.equal(collectImageBlocks(blocks).length, 0);
});

test("a candidate that is already in the body is skipped, not duplicated", () => {
  // The exact trap from the repro article: og:image and a body image are the
  // same file at two sizes, so a raw string comparison would insert a duplicate.
  const { blocks } = htmlToBlocks(
    `<p>${PROSE}</p><figure><img src="https://cdn.example.com/uploads/car.jpg?w=652"></figure>`,
    BASE,
  );
  const before = blocks.length;

  const lines = logsFrom(() =>
    applyLeadImage(
      blocks,
      leadResult("https://cdn.example.com/uploads/car.jpg?resize=1151,1200"),
      BASE,
      "clp_test",
      "insert",
    ),
  );
  const skip = lines.find((line) => line["event"] === "lead_image_skipped_duplicate");

  assert.equal(blocks.length, before, "the body already has this image");
  assert.equal(collectImageBlocks(blocks).length, 1, "the image appears exactly once");
  assert.ok(skip, "the skip is logged so the dedupe can be audited");
  assert.match(String(skip?.["lead_url"]), /resize=1151/);
  assert.match(String(skip?.["body_url"]), /w=652/);
});

test("no candidate and every rejection are logged, because that is the only evidence", () => {
  const { blocks } = htmlToBlocks(`<p>${PROSE}</p>`, BASE);

  const none = logsFrom(() =>
    applyLeadImage(blocks, { candidate: null, rejected: [] }, BASE, "clp_test", "insert"),
  );
  assert.deepEqual(events(none), ["lead_image_none"]);

  const rejected = logsFrom(() =>
    applyLeadImage(
      blocks,
      { candidate: null, rejected: [{ url: "https://cdn.example.com/logo.png", reason: "filename says furniture (logo)" }] },
      BASE,
      "clp_test",
      "insert",
    ),
  );
  assert.deepEqual(events(rejected), ["lead_image_rejected", "lead_image_none"]);
  assert.match(String(rejected[0]!["reason"]), /logo/);
});

test("a lead image can never fail the clip", () => {
  const { blocks } = htmlToBlocks(`<p>${PROSE}</p>`, BASE);
  const broken = {
    candidate: { url: "not a url", rule: "before-h1" as const, captionHtml: null, alt: null, width: null, height: null },
    rejected: [],
  };

  assert.doesNotThrow(() =>
    logsFrom(() => applyLeadImage(blocks, broken, BASE, "clp_test", "insert")),
  );
});

// --- The block itself ------------------------------------------------------

test("the lead block is an ordinary external image block, so it degrades like one", () => {
  // Import failure has to fall back to a hotlink by the existing path rather
  // than a second mechanism — so the shape must match exactly.
  const lead = leadImageBlock(
    { url: "https://cdn.example.com/hero.jpg", captionHtml: null, alt: null },
    BASE,
  );

  assert.deepEqual(lead, imageBlock("https://cdn.example.com/hero.jpg"));
  assert.equal((lead["image"] as { type: string }).type, "external");
});

test("the caption keeps its formatting and links, and falls back to alt text", () => {
  const withCaption = leadImageBlock(
    {
      url: "https://cdn.example.com/hero.jpg",
      captionHtml: '<span>Photo by </span><a href="https://unsplash.com/x">Joe Dudeck</a>',
      alt: "ignored when a caption exists",
    },
    BASE,
  );
  const caption = (withCaption["image"] as { caption: Array<{ text: { content: string; link?: unknown } }> })
    .caption;

  assert.equal(caption.map((item) => item.text.content).join(""), "Photo by Joe Dudeck");
  assert.equal(caption[1]?.text.link?.["url" as never], "https://unsplash.com/x");

  const altOnly = leadImageBlock(
    { url: "https://cdn.example.com/hero.jpg", captionHtml: null, alt: "A patterned jacket" },
    BASE,
  );
  assert.equal(
    (altOnly["image"] as { caption: Array<{ text: { content: string } }> }).caption[0]?.text.content,
    "A patterned jacket",
  );
});

// --- End to end through the converter --------------------------------------

test("the hero survives selection, conversion and placement together", () => {
  const html = `<!DOCTYPE html><html><body>${heroAboveHeadline(
    `<figure><img src="/uploads/2026/08/car.jpg?w=652"><figcaption>A car</figcaption></figure>`,
  )}</body></html>`;
  const doc = new JSDOM(html, { url: BASE }).window.document;

  const lead = selectLeadImage(doc, BASE);
  const { blocks } = htmlToBlocks(doc.querySelector(".entry-content")!.innerHTML, BASE);

  logsFrom(() => applyLeadImage(blocks, lead, BASE, "clp_test", "insert"));

  const images = collectImageBlocks(blocks).map(
    (block) => (block["image"] as { external: { url: string } }).external.url,
  );

  assert.deepEqual(images, [
    "https://example.com/uploads/2026/08/hero.jpg",
    "https://example.com/uploads/2026/08/car.jpg?w=652",
  ]);
  assert.equal((blocks[0] as Block).type, "image", "the hero leads the article");
});
