/**
 * Tests for PDF handling — the failures that don't look like failures.
 *
 * The service does not read PDF text. It recognises a PDF, says so, and (in
 * `attach` mode) stores the file. The dangerous cases here are a PDF that isn't
 * recognised as one, an HTML page mistaken for a PDF, and the switch failing to
 * stay out of the way when it is off.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { fetchArticle, sniffPdf, type FetchResult } from "../src/extract";
import { pdfBlock, pdfNoticeCallout } from "../src/blocks";
import { hostnameOf, pdfTitleFrom } from "../src/pipeline";

const bytes = (s: string) => new TextEncoder().encode(s);
const EMPTY = new Uint8Array();

/**
 * Fetch one stubbed response under a given mode.
 *
 * The mode is a parameter rather than an env override because TUNABLES is
 * `as const` and nothing should mutate config at runtime — the same reason
 * `applyLeadImage` takes its mode from the caller.
 */
async function fetchStubbed(
  body: BodyInit,
  init: ResponseInit,
  mode: string,
  url = "https://example.com/paper.pdf",
): Promise<FetchResult> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, init)) as typeof fetch;
  try {
    return await fetchArticle(url, mode);
  } finally {
    globalThis.fetch = original;
  }
}

const PDF_HEADERS = { status: 200, headers: { "content-type": "application/pdf" } };

// --- sniffPdf --------------------------------------------------------------

test("a PDF content type is recognised without reading the body", () => {
  assert.equal(sniffPdf("application/pdf", EMPTY), true);
  assert.equal(sniffPdf("application/pdf; charset=UTF-8", EMPTY), true);
  assert.equal(sniffPdf("application/x-pdf", EMPTY), true);
  assert.equal(sniffPdf("  application/pdf  ", EMPTY), true);
});

test("magic bytes catch a PDF the content type lied about", () => {
  // Real servers send octet-stream for PDFs. Measured on live URLs, so a
  // header-only check silently drops them into the HTML path as mojibake.
  assert.equal(sniffPdf("application/octet-stream", bytes("%PDF-1.7\n...")), true);
  assert.equal(sniffPdf("binary/octet-stream", bytes("%PDF-1.3")), true);
  assert.equal(sniffPdf(null, bytes("%PDF-1.4")), true);
});

test("an HTML page that merely mentions %PDF- is not a PDF", () => {
  // The magic bytes are only magic at offset zero. A page *about* PDFs, or one
  // linking to them, would otherwise be swallowed and never clipped.
  const page = bytes("<html><body><p>The file starts with %PDF- always.</p></body></html>");
  assert.equal(sniffPdf("text/html", page), false);
  assert.equal(sniffPdf(null, page), false);
});

test("a content type naming pdf inside another word is not a PDF", () => {
  assert.equal(sniffPdf("text/html+pdfish", EMPTY), false);
  assert.equal(sniffPdf("application/pdfx-custom", EMPTY), false);
});

test("a body shorter than the magic bytes is not a PDF", () => {
  assert.equal(sniffPdf(null, bytes("%PD")), false);
  assert.equal(sniffPdf(null, EMPTY), false);
});

// --- the switch ------------------------------------------------------------

test("PDF_MODE=off leaves a PDF response on the HTML path, exactly as before", async () => {
  // The guarantee behind shipping this dark: with the switch off the fetch
  // behaves as it did before PDFs were handled at all. A sniff-then-ignore
  // would break it, so the gate has to sit above the check itself.
  const result = await fetchStubbed("%PDF-1.7\nnot html at all", PDF_HEADERS, "off");
  assert.equal(result.kind, "html");
});

test("PDF_MODE=detect recognises the PDF and carries no body", async () => {
  const result = await fetchStubbed("%PDF-1.7\n", PDF_HEADERS, "detect");
  assert.equal(result.kind, "pdf");
  assert.ok(!("html" in result), "the PDF arm must not carry a body — Notion fetches the file");
});

test("PDF_MODE=attach still recognises an octet-stream PDF by its bytes", async () => {
  const result = await fetchStubbed(
    "%PDF-1.5\nbinary",
    { status: 200, headers: { "content-type": "application/octet-stream" } },
    "attach",
    "https://example.com/download",
  );
  assert.equal(result.kind, "pdf");
});

test("an ordinary HTML page is untouched whatever the mode", async () => {
  for (const mode of ["off", "detect", "attach"]) {
    const result = await fetchStubbed(
      "<html><body><p>hello</p></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
      mode,
      "https://example.com/article",
    );
    assert.equal(result.kind, "html", `mode ${mode} must not divert HTML`);
  }
});

// --- title from URL --------------------------------------------------------

test("a slug becomes a readable title", () => {
  assert.equal(
    pdfTitleFrom("https://example.com/files/good_fonts_for_dyslexia_study.pdf"),
    "good fonts for dyslexia study",
  );
  assert.equal(
    pdfTitleFrom("https://example.com/service-design-playbook-beta.pdf"),
    "service design playbook beta",
  );
});

test("a percent-encoded filename is decoded before it becomes a title", () => {
  assert.equal(pdfTitleFrom("https://example.com/DE%20201%20EN.pdf"), "DE 201 EN");
});

test("a title with no letters is refused rather than guessed", () => {
  // A CDN path can be all digits. "1579247082256" is not a title, and the
  // header is better with no title than with a wrong one.
  assert.equal(pdfTitleFrom("https://cdn.example.com/t/1579247082256.pdf"), null);
  assert.equal(pdfTitleFrom("https://example.com/"), null);
  assert.equal(pdfTitleFrom("not a url at all"), null);
});

// --- blocks ----------------------------------------------------------------

test("the PDF block is external so the pipeline can swap in an upload", () => {
  const block = pdfBlock("https://example.com/paper.pdf");
  assert.equal(block.type, "pdf");
  const payload = block["pdf"] as { type: string; external: { url: string } };
  assert.equal(payload.type, "external");
  assert.equal(payload.external.url, "https://example.com/paper.pdf");
});

test("the notice says plainly that the text was not extracted", () => {
  // A page holding a header and an attachment but no prose reads as a broken
  // clip. The status is CLIPPED, so the page itself has to explain why.
  const text = ((pdfNoticeCallout()["callout"] as { rich_text: { text: { content: string } }[] })
    .rich_text.map((r) => r.text.content).join(""));
  assert.match(text, /PDF/);
  assert.match(text, /not extracted/i);
});

test("hostnameOf strips www and survives junk", () => {
  assert.equal(hostnameOf("https://www.example.com/a.pdf"), "example.com");
  assert.equal(hostnameOf("https://nvlpubs.nist.gov/x.pdf"), "nvlpubs.nist.gov");
  assert.equal(hostnameOf("nonsense"), null);
});
