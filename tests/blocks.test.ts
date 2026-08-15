/**
 * Tests for the failures that don't look like failures.
 *
 * A truncated article still reads like an article. A mangled table reads like
 * bad prose. A lazy-loaded image imports a 1x1 spacer and the page looks fine
 * until you scroll. Everything here asserts on counts and structure rather than
 * on "did it produce something", because producing something is the bug.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  clipHeader, collectImageBlocks, htmlToBlocks, pickImageUrl, plainTextLength,
  splitRichText, type Block, type RichText,
} from "../src/blocks";
import { TUNABLES } from "../src/config";

// --- Helpers ---------------------------------------------------------------

function payload(block: Block): Record<string, unknown> {
  return block[block.type] as Record<string, unknown>;
}

function richTextOf(block: Block): RichText[] {
  const items = payload(block)["rich_text"];
  return Array.isArray(items) ? (items as RichText[]) : [];
}

/** Total characters across every rich-text object in a block tree. */
function totalChars(blocks: Block[]): number {
  let sum = 0;
  for (const block of blocks) {
    sum += plainTextLength(richTextOf(block));
    const children = payload(block)["children"];
    if (Array.isArray(children)) sum += totalChars(children as Block[]);
  }
  return sum;
}

function maxNesting(blocks: Block[], depth = 0): number {
  let deepest = depth;
  for (const block of blocks) {
    const children = payload(block)["children"];
    if (Array.isArray(children) && children.length > 0) {
      deepest = Math.max(deepest, maxNesting(children as Block[], depth + 1));
    }
  }
  return deepest;
}

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
}

// --- Never truncate --------------------------------------------------------

test("a paragraph over 2000 characters is preserved in full", () => {
  const text = words(1200);
  assert.ok(text.length > 5000, "fixture should exceed the rich-text cap several times over");

  const { blocks } = htmlToBlocks(`<p>${text}</p>`, "https://example.com/a");

  assert.equal(totalChars(blocks), text.length);
  for (const block of blocks) {
    for (const item of richTextOf(block)) {
      assert.ok(
        item.text.content.length <= TUNABLES.richTextCharLimit,
        `rich text object of ${item.text.content.length} chars exceeds the 2000 cap`,
      );
    }
  }
});

test("a paragraph past the 100-object array limit becomes several blocks, not a truncated one", () => {
  // 100 objects x 2000 chars is the most a single block can hold.
  const text = words(60_000);
  assert.ok(text.length > TUNABLES.richTextCharLimit * TUNABLES.richTextArrayLimit);

  const { blocks } = htmlToBlocks(`<p>${text}</p>`, "https://example.com/a");

  assert.ok(blocks.length > 1, "should have split into multiple paragraph blocks");
  assert.equal(totalChars(blocks), text.length);
  for (const block of blocks) {
    assert.equal(block.type, "paragraph");
    assert.ok(richTextOf(block).length <= TUNABLES.richTextArrayLimit);
  }
});

test("splitting preserves every character, including with no spaces to break on", () => {
  const solid = "x".repeat(4500);
  const split = splitRichText([{ type: "text", text: { content: solid } }]);

  assert.equal(plainTextLength(split), solid.length);
  assert.equal(split.map((item) => item.text.content).join(""), solid);
});

test("formatting and links survive the split", () => {
  const text = words(800);
  const { blocks } = htmlToBlocks(
    `<p><a href="/story"><strong>${text}</strong></a></p>`,
    "https://example.com/section/",
  );

  const items = blocks.flatMap(richTextOf);
  assert.equal(plainTextLength(items), text.length);
  assert.ok(items.every((item) => item.annotations?.bold === true));
  assert.ok(items.every((item) => item.text.link?.url === "https://example.com/story"));
});

// --- Tables ----------------------------------------------------------------

test("a clean table becomes a Notion table block", () => {
  const html = `
    <table>
      <thead><tr><th>Language</th><th>Year</th></tr></thead>
      <tbody>
        <tr><td>Rust</td><td>2010</td></tr>
        <tr><td>Go</td><td>2009</td></tr>
      </tbody>
    </table>`;

  const { blocks } = htmlToBlocks(html, "https://example.com/a");
  const table = blocks.find((block) => block.type === "table");

  assert.ok(table, "expected a table block");
  const data = payload(table) as { table_width: number; has_column_header: boolean; children: Block[] };
  assert.equal(data.table_width, 2);
  assert.equal(data.has_column_header, true);
  assert.equal(data.children.length, 3);

  const firstCell = (payload(data.children[0]!)["cells"] as RichText[][])[0]!;
  assert.equal(firstCell[0]!.text.content, "Language");
});

test("merged cells fall back to lossless HTML rather than a mangled table", () => {
  const html = `
    <table>
      <tr><th colspan="2">Combined</th></tr>
      <tr><td>a</td><td>b</td></tr>
    </table>`;

  const { blocks } = htmlToBlocks(html, "https://example.com/a");

  assert.equal(blocks.find((block) => block.type === "table"), undefined);

  const code = blocks.find((block) => block.type === "code");
  assert.ok(code, "expected the original markup preserved in a code block");

  const preserved = richTextOf(code).map((item) => item.text.content).join("");
  assert.match(preserved, /colspan="2"/);
  assert.match(preserved, /Combined/);
  // Every cell still present — nothing dropped on the way through.
  assert.match(preserved, />a</);
  assert.match(preserved, />b</);
});

test("ragged rows are padded rather than rejected", () => {
  const html = `<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td></tr></table>`;
  const { blocks } = htmlToBlocks(html, "https://example.com/a");

  const table = blocks.find((block) => block.type === "table");
  assert.ok(table);
  const data = payload(table) as { table_width: number; children: Block[] };
  assert.equal(data.table_width, 3);

  for (const row of data.children) {
    assert.equal((payload(row)["cells"] as RichText[][]).length, 3);
  }
});

// --- Images ----------------------------------------------------------------

test("lazy-loaded images resolve to the real file, not the placeholder", () => {
  const html = `
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
         data-src="/media/real-photo.jpg" alt="A photo">`;

  const { blocks } = htmlToBlocks(html, "https://example.com/posts/one");
  const [image] = collectImageBlocks(blocks);

  assert.ok(image);
  const data = payload(image) as { external: { url: string }; caption: RichText[] };
  assert.equal(data.external.url, "https://example.com/media/real-photo.jpg");
  assert.equal(data.caption[0]!.text.content, "A photo");
});

test("srcset URLs containing commas are not shredded", () => {
  // Real Substack markup. Cloudinary-style transforms put commas INSIDE the
  // URL, so splitting a srcset on commas produces relative fragments that
  // silently resolve against the article's own path and 404. This shipped, and
  // it produced a page of broken images that looked fine in the block tree.
  const cdn = "https://substackcdn.com/image/fetch";
  const target = "https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fx_739x415.jpeg";
  const html = `
    <img src="${cdn}/$s_!ElHF!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/${target}"
         srcset="${cdn}/$s_!ElHF!,w_424,c_limit,f_auto,q_auto:good,fl_progressive:steep/${target} 424w, ${cdn}/$s_!ElHF!,w_848,c_limit,f_auto,q_auto:good,fl_progressive:steep/${target} 848w">`;

  const { blocks } = htmlToBlocks(html, "https://www.noahpinion.blog/p/an-article");
  const [image] = collectImageBlocks(blocks);

  assert.ok(image);
  const url = (payload(image) as { external: { url: string } }).external.url;

  assert.ok(
    url.startsWith("https://substackcdn.com/image/fetch/"),
    `expected a substackcdn URL, got ${url}`,
  );
  assert.ok(!url.includes("noahpinion.blog"), "must not resolve a fragment against the article");
  assert.match(url, /w_848/, "should pick the widest candidate");
  assert.match(url, /fl_progressive:steep/, "the full transform chain must survive");
});

test("srcset candidates without descriptors still parse", () => {
  const { blocks } = htmlToBlocks(
    `<img srcset="https://cdn.example.com/a,b,c/one.jpg">`,
    "https://example.com/post",
  );
  const [image] = collectImageBlocks(blocks);
  assert.ok(image);
  assert.equal(
    (payload(image) as { external: { url: string } }).external.url,
    "https://cdn.example.com/a,b,c/one.jpg",
  );
});

test("srcset picks the largest candidate", () => {
  const html = `
    <img src="/small.jpg"
         srcset="/w400.jpg 400w, /w1600.jpg 1600w, /w800.jpg 800w">`;

  const { blocks } = htmlToBlocks(html, "https://example.com/a");
  const [image] = collectImageBlocks(blocks);

  assert.ok(image);
  assert.equal((payload(image) as { external: { url: string } }).external.url, "https://example.com/w1600.jpg");
});

test("relative image URLs resolve against the article URL", () => {
  const html = `<figure><img src="../assets/diagram.png"><figcaption>How it works</figcaption></figure>`;
  const { blocks } = htmlToBlocks(html, "https://example.com/blog/2026/post.html");
  const [image] = collectImageBlocks(blocks);

  assert.ok(image);
  const data = payload(image) as { external: { url: string }; caption: RichText[] };
  assert.equal(data.external.url, "https://example.com/blog/assets/diagram.png");
  assert.equal(data.caption[0]!.text.content, "How it works");
});

test("tracking pixels and spacers are skipped", () => {
  const html = `
    <img src="https://analytics.example.com/pixel.gif">
    <img src="/img/spacer.png">
    <img src="/img/thumb.jpg" width="1" height="1">
    <img src="/img/real.jpg">`;

  const { blocks } = htmlToBlocks(html, "https://example.com/a");
  const images = collectImageBlocks(blocks);

  assert.equal(images.length, 1);
  assert.equal(
    (payload(images[0]!) as { external: { url: string } }).external.url,
    "https://example.com/img/real.jpg",
  );
});

test("pickImageUrl prefers a picture source over the fallback img", () => {
  const { blocks } = htmlToBlocks(
    `<picture><source srcset="/hero-2x.webp 2x"><img src="/hero.jpg"></picture>`,
    "https://example.com/a",
  );
  const [image] = collectImageBlocks(blocks);
  assert.ok(image);
  assert.equal(
    (payload(image) as { external: { url: string } }).external.url,
    "https://example.com/hero-2x.webp",
  );
});

// --- Structure -------------------------------------------------------------

test("headings, quotes, code and dividers survive", () => {
  const html = `
    <h1>Title</h1><h2>Section</h2><h5>Deep heading</h5>
    <blockquote><p>A quoted line.</p></blockquote>
    <pre><code class="language-python">def f():\n    return 1</code></pre>
    <hr>`;

  const { blocks } = htmlToBlocks(html, "https://example.com/a");
  const types = blocks.map((block) => block.type);

  assert.deepEqual(types, [
    "heading_1", "heading_2", "heading_3", "quote", "code", "divider",
  ]);

  const code = blocks.find((block) => block.type === "code")!;
  assert.equal(payload(code)["language"], "python");
  // Indentation inside code is not whitespace-collapsed.
  assert.match(richTextOf(code)[0]!.text.content, /\n {4}return 1/);
});

test("nested lists keep their nesting up to the limit and flatten past it", () => {
  const html = `
    <ul>
      <li>one
        <ul><li>two
          <ul><li>three
            <ul><li>four</li></ul>
          </li></ul>
        </li></ul>
      </li>
    </ul>`;

  const { blocks } = htmlToBlocks(html, "https://example.com/a");

  assert.ok(maxNesting(blocks) <= TUNABLES.maxNestDepth, "nesting must stay within Notion's limit");

  // Flattened, not dropped — every item is still on the page somewhere.
  const flatten = (list: Block[]): string[] =>
    list.flatMap((block) => {
      const own = richTextOf(block).map((item) => item.text.content).join("");
      const children = payload(block)["children"];
      return [own, ...(Array.isArray(children) ? flatten(children as Block[]) : [])];
    });

  const text = flatten(blocks).join(" ");
  for (const word of ["one", "two", "three", "four"]) {
    assert.match(text, new RegExp(word));
  }
});

test("bare text between block elements is not lost", () => {
  const { blocks } = htmlToBlocks(
    `<div>Loose text <em>with emphasis</em>.<p>A paragraph.</p></div>`,
    "https://example.com/a",
  );

  const text = blocks.flatMap(richTextOf).map((item) => item.text.content).join("");
  assert.match(text, /Loose text with emphasis\./);
  assert.match(text, /A paragraph\./);
});

// --- Footnotes -------------------------------------------------------------

test("footnote markers render as references, not digits fused to the text", () => {
  const html = `<p>I don't expect that, of course.<a id="footnote-anchor-1" href="#footnote-1" class="footnote-anchor">1</a> But it follows.</p>`;

  const { blocks } = htmlToBlocks(html, "https://example.com/post");
  const text = blocks.flatMap(richTextOf).map((item) => item.text.content).join("");

  assert.match(text, /of course\. \[1\]/, "should read as a reference, not 'course.1'");
  assert.doesNotMatch(text, /course\.1/);
});

test("a footnote link wrapping real prose stays an ordinary link", () => {
  const html = `<p>See <a href="#footnote-2" class="footnote-anchor">the second note</a> for detail.</p>`;

  const { blocks } = htmlToBlocks(html, "https://example.com/post");
  const items = blocks.flatMap(richTextOf);

  assert.ok(
    items.some((item) => item.text.content.includes("the second note")),
    "prose inside a footnote link must survive",
  );
});

// --- Idempotency key -------------------------------------------------------

test("the clip header links to the source URL so a retry can find it", () => {
  const header = clipHeader({
    title: "A Long Read",
    siteName: "Example Magazine",
    byline: "A. Writer",
    publishedAt: "2026-01-15",
    url: "https://example.com/long-read",
  });

  const items = richTextOf(header);
  assert.ok(
    items.some((item) => item.text.link?.url === "https://example.com/long-read"),
    "the header must carry the source link — it is the idempotency key",
  );

  const text = items.map((item) => item.text.content).join("");
  assert.match(text, /A Long Read/);
  assert.match(text, /Example Magazine/);
  assert.match(text, /A\. Writer/);
});

// --- Label-and-value spacing -----------------------------------------------

/** The plain text of the first block, as a reader would see it. */
function textOf(html: string): string {
  const { blocks } = htmlToBlocks(html, "https://example.com/a");
  return richTextOf(blocks[0]!).map((item) => item.text.content).join("");
}

test("a credit line does not run into the name it credits", () => {
  // Real TechCrunch markup: there is no whitespace anywhere in the source. The
  // gap on the site comes from rendering the bold run, and none of that
  // survives into plain text — Notion showed "Image Credits:Getty Images" on
  // every clipped image.
  assert.equal(textOf("<p><strong>Image Credits:</strong>Getty Images</p>"), "Image Credits: Getty Images");
  assert.equal(
    textOf("<p><em><strong>Image Credits:</strong>Bill Swearingen</em></p>"),
    "Image Credits: Bill Swearingen",
  );
});

test("a site that already spaces its labels does not get a double space", () => {
  assert.equal(textOf("<p><strong>Image Credits: </strong>Getty Images</p>"), "Image Credits: Getty Images");
  assert.equal(textOf("<p><strong>Image Credits:</strong> Getty Images</p>"), "Image Credits: Getty Images");
});

test("a word split by formatting is left alone", () => {
  // The general rule — space at every formatting boundary — is wrong, which is
  // why this one is scoped to a colon.
  assert.equal(textOf("<p><b>un</b>likely</p>"), "unlikely");
  assert.equal(textOf("<p><b>Micro</b>soft</p>"), "Microsoft");
});

test("text the author wrote without a space keeps it that way", () => {
  // One text node, no formatting boundary: not ours to edit.
  assert.equal(textOf("<p>Note:Value</p>"), "Note:Value");
});
