/**
 * Fetch-target safety and the "this isn't an article" cases.
 *
 * A paywall that isn't detected produces a page containing a cookie banner and
 * a subscribe prompt — which looks like a successful clip until someone reads it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assertSafeUrl, extractArticle, metaRefreshTarget } from "../src/extract";
import { ClipError } from "../src/errors";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ClipError) return err.code;
    throw err;
  }
  throw new Error("expected the call to throw");
}

function paragraphs(count: number): string {
  const sentence =
    "The service fetches the page and converts what it finds into blocks that Notion will accept. ";
  return Array.from({ length: count }, (_, i) => `<p>${sentence.repeat(4)} Paragraph ${i}.</p>`).join("\n");
}

function page(body: string, head = ""): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

// --- Fetch target safety ---------------------------------------------------

test("public https URLs are accepted", () => {
  assert.equal(assertSafeUrl("https://example.com/article").hostname, "example.com");
});

test("localhost and private ranges are refused", () => {
  const refused = [
    "http://localhost:8888/admin",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.20.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/",
    "http://[::1]/",
  ];

  for (const url of refused) {
    assert.equal(codeOf(() => assertSafeUrl(url)), "INVALID_REQUEST", `should refuse ${url}`);
  }
});

test("non-http protocols are refused", () => {
  assert.equal(codeOf(() => assertSafeUrl("file:///etc/passwd")), "INVALID_REQUEST");
  assert.equal(codeOf(() => assertSafeUrl("ftp://example.com/x")), "INVALID_REQUEST");
  assert.equal(codeOf(() => assertSafeUrl("not a url")), "INVALID_REQUEST");
});

// --- Redirect stubs --------------------------------------------------------

test("a meta-refresh stub is followed, not mistaken for an empty article", () => {
  // Real case: blog.rust-lang.org answers a moved URL with a 200 whose body is
  // a redirect stub. Without this, the clip fails as "not extractable".
  const stub = page(
    `<p><a href="https://blog.example.com/post/">Click here</a> to be redirected.</p>`,
    `<title>Redirect</title>
     <noscript><meta http-equiv="refresh" content="0; url=https://blog.example.com/post/"></noscript>`,
  );

  assert.equal(metaRefreshTarget(stub, "https://blog.example.com/post.html"), "https://blog.example.com/post/");
});

test("relative meta-refresh targets resolve against the current URL", () => {
  const stub = `<meta http-equiv="refresh" content="0;url=/new/home">`;
  assert.equal(metaRefreshTarget(stub, "https://example.com/old/page"), "https://example.com/new/home");
});

test("a long-delay refresh on a real page is left alone", () => {
  const stub = `<meta http-equiv="refresh" content="600; url=/session-expired">`;
  assert.equal(metaRefreshTarget(stub, "https://example.com/article"), null);

  // A refresh buried in a full-length article is a session timeout, not a move.
  const article = `<meta http-equiv="refresh" content="0; url=/x">${"padding ".repeat(9000)}`;
  assert.equal(metaRefreshTarget(article, "https://example.com/article"), null);
});

test("a self-referential refresh does not loop", () => {
  const stub = `<meta http-equiv="refresh" content="0; url=https://example.com/a">`;
  assert.equal(metaRefreshTarget(stub, "https://example.com/a"), null);
});

// --- Extraction ------------------------------------------------------------

test("a normal article extracts with its metadata", () => {
  const html = page(
    `<article><h1>How Clipping Works</h1>${paragraphs(6)}</article>`,
    `<title>How Clipping Works</title>
     <meta property="og:site_name" content="Example Magazine">
     <meta name="author" content="A. Writer">
     <meta property="article:published_time" content="2026-01-15T09:00:00Z">`,
  );

  const article = extractArticle(html, "https://example.com/how-clipping-works");

  assert.match(article.title ?? "", /How Clipping Works/);
  assert.equal(article.siteName, "Example Magazine");
  assert.equal(article.byline, "A. Writer");
  assert.equal(article.publishedAt, "2026-01-15");
  assert.ok(article.textLength > 400);
});

test("a bot-block interstitial is reported as blocked, not clipped", () => {
  const html = page("<h1>Just a moment...</h1><p>Checking your browser.</p>", "<title>Just a moment...</title>");
  assert.equal(codeOf(() => extractArticle(html, "https://example.com/a")), "BLOCKED");
});

test("a paywall teaser is reported as blocked", () => {
  const html = page(
    `<article><h1>Members Only</h1><p>A short teaser paragraph.</p>
     <div>Subscribe to continue reading this story.</div></article>`,
    `<title>Members Only</title>`,
  );
  assert.equal(codeOf(() => extractArticle(html, "https://example.com/a")), "BLOCKED");
});

test("a declared paywall is blocked even when the teaser is long", () => {
  const html = page(
    `<article><h1>Declared</h1>${paragraphs(2)}</article>
     <script type="application/ld+json">{"isAccessibleForFree":false}</script>`,
    `<title>Declared</title>`,
  );
  assert.equal(codeOf(() => extractArticle(html, "https://example.com/a")), "BLOCKED");
});

test("a page with no article is reported as not extractable, not as an empty clip", () => {
  const html = page("<div><h1>Links</h1><ul><li>One</li><li>Two</li></ul></div>", "<title>Links</title>");
  assert.equal(codeOf(() => extractArticle(html, "https://example.com/a")), "NOT_EXTRACTABLE");
});
