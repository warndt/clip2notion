/**
 * HTML -> Notion blocks, by direct DOM walk.
 *
 * Direct rather than via Markdown because the two things that matter most here —
 * lazy-loaded image attributes (`data-src`, `srcset`) and figure/figcaption
 * pairing — are gone by the time you reach Markdown.
 *
 * Three rules run through this file:
 *   - Never truncate. Long text splits across objects and blocks.
 *   - Never silently drop. Anything that can't convert cleanly falls back to
 *     something lossless (usually the original HTML in a code block).
 *   - Never fail on structure. Over-deep nesting flattens; it does not throw.
 */

import { JSDOM } from "jsdom";
import { TUNABLES } from "./config";

// --- Types -----------------------------------------------------------------

export interface Annotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
}

export interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: Annotations;
}

export interface Block {
  type: string;
  [key: string]: unknown;
}

// Markers live in their own dependency-free module so that reading a page's
// state never pulls in this file, and with it jsdom. Imported for use below and
// re-exported, because this is where the blocks that carry them are built.
import { ERROR_MARKER, HEADER_PREFIX, STATUS_MARKER } from "./markers";
export { ERROR_MARKER, HEADER_PREFIX, STATUS_MARKER };

interface Ctx {
  baseUrl: string;
  depth: number;
}

// --- Rich text -------------------------------------------------------------

const INLINE_TAGS = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "BIG", "CITE", "CODE", "DATA", "DEL", "DFN",
  "EM", "FONT", "I", "INS", "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN",
  "STRIKE", "STRONG", "SUB", "SUP", "TIME", "TT", "U", "VAR", "WBR",
]);

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED",
  "SVG", "CANVAS", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "NAV",
]);

function isFootnoteMarker(el: Element): boolean {
  const className = el.getAttribute("class") ?? "";
  const href = el.getAttribute("href") ?? "";
  const id = el.getAttribute("id") ?? "";
  const looksLikeMarker =
    /footnote[-_]?anchor/i.test(className) ||
    /footnote[-_]?anchor/i.test(id) ||
    /^#footnote/i.test(href);

  // Only the bare-number form. A footnote link wrapping real prose is a normal
  // link and should stay one.
  return looksLikeMarker && /^\s*\d{1,3}\s*$/.test(el.textContent ?? "");
}

function annotationsFor(tag: string, inherited: Annotations): Annotations {
  switch (tag) {
    case "STRONG": case "B":
      return { ...inherited, bold: true };
    case "EM": case "I": case "CITE": case "DFN": case "VAR":
      return { ...inherited, italic: true };
    case "S": case "DEL": case "STRIKE":
      return { ...inherited, strikethrough: true };
    case "U": case "INS":
      return { ...inherited, underline: true };
    case "CODE": case "KBD": case "SAMP": case "TT":
      return { ...inherited, code: true };
    default:
      return inherited;
  }
}

function absoluteUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Notion rejects overlong URLs; a link that long is a tracking blob anyway.
    if (url.href.length > 2000) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Collapse HTML whitespace, but leave explicit `<br>` newlines alone. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ");
}

function annotationKey(a: Annotations | undefined): string {
  if (!a) return "";
  return `${a.bold ? 1 : 0}${a.italic ? 1 : 0}${a.strikethrough ? 1 : 0}${a.underline ? 1 : 0}${a.code ? 1 : 0}`;
}

function collectRichText(
  node: Node,
  ctx: Ctx,
  inherited: Annotations,
  link: string | null,
  out: RichText[],
): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      const content = normalizeText(child.textContent ?? "");
      if (content) out.push(makeRichText(content, inherited, link));
      continue;
    }
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;

    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) continue;

    if (tag === "BR") {
      out.push(makeRichText("\n", inherited, link));
      continue;
    }
    if (tag === "IMG") {
      // An image inside a run of text. Keep it as a link so the reference
      // survives, rather than dropping it.
      const src = pickImageUrl(el, ctx.baseUrl);
      const alt = el.getAttribute("alt")?.trim();
      if (src && alt) out.push(makeRichText(alt, inherited, link ?? src));
      continue;
    }

    // A footnote marker is an anchor whose entire text is the number. Left
    // alone it fuses to the preceding word — "of course.1" — and reads as a
    // typo rather than a reference, especially now that there is a Footnotes
    // section for it to point at.
    if (tag === "A" && isFootnoteMarker(el)) {
      const marker = (el.textContent ?? "").trim();
      if (marker) out.push(makeRichText(` [${marker}]`, inherited, null));
      continue;
    }

    const nextLink = tag === "A" ? absoluteUrl(el.getAttribute("href"), ctx.baseUrl) ?? link : link;
    collectRichText(el, ctx, annotationsFor(tag, inherited), nextLink, out);
  }
}

function makeRichText(content: string, annotations: Annotations, link: string | null): RichText {
  const rt: RichText = { type: "text", text: { content } };
  if (link) rt.text.link = { url: link };
  if (Object.keys(annotations).length > 0) rt.annotations = { ...annotations };
  return rt;
}

/**
 * A label and its value, run together with no whitespace between them.
 *
 * `<strong>Image Credits:</strong>Getty Images` carries no space anywhere in the
 * source — the gap you see on the site comes from how the bold run is spaced
 * when rendered, and none of that survives into plain text. Notion shows
 * "Image Credits:Getty Images", which reads as a typo on every clipped image.
 *
 * Scoped hard to a colon, because the general rule is wrong: inserting a space
 * at every formatting boundary would turn `<b>un</b>likely` into "un likely".
 * A colon immediately followed by a word, *across a formatting change*, is a
 * missing space in prose. Runs that share formatting are one text node in the
 * source and are never touched — this is about rendering, not about editing
 * what the author wrote.
 */
function needsSpaceBetween(prev: RichText, next: RichText): boolean {
  return /:$/.test(prev.text.content) && /^[\p{L}\p{N}]/u.test(next.text.content);
}

/** Merge adjacent runs that share formatting, then trim the outer whitespace. */
function tidy(items: RichText[]): RichText[] {
  const merged: RichText[] = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      annotationKey(prev.annotations) === annotationKey(item.annotations) &&
      (prev.text.link?.url ?? null) === (item.text.link?.url ?? null)
    ) {
      prev.text.content += item.text.content;
    } else {
      if (prev && needsSpaceBetween(prev, item)) {
        merged.push({ ...item, text: { ...item.text, content: ` ${item.text.content}` } });
        continue;
      }
      merged.push(item);
    }
  }

  const first = merged[0];
  if (first) first.text.content = first.text.content.replace(/^\s+/, "");
  const last = merged[merged.length - 1];
  if (last) last.text.content = last.text.content.replace(/\s+$/, "");

  return merged.filter((item) => item.text.content.length > 0);
}

/**
 * Enforce the 2000-character-per-object cap by splitting, never cutting.
 * Prefers a word boundary; falls back to a hard split. Character count in
 * equals character count out — the tests assert exactly that.
 */
export function splitRichText(items: RichText[]): RichText[] {
  const limit = TUNABLES.richTextCharLimit;
  const out: RichText[] = [];

  for (const item of items) {
    let content = item.text.content;
    if (content.length <= limit) {
      out.push(item);
      continue;
    }
    while (content.length > limit) {
      let cut = content.lastIndexOf(" ", limit);
      if (cut <= 0) cut = limit;
      out.push({ ...item, text: { ...item.text, content: content.slice(0, cut) } });
      content = content.slice(cut);
    }
    if (content.length > 0) {
      out.push({ ...item, text: { ...item.text, content } });
    }
  }

  return out;
}

export function richTextFrom(el: Element, baseUrl: string): RichText[] {
  const out: RichText[] = [];
  collectRichText(el, { baseUrl, depth: 0 }, {}, null, out);
  return splitRichText(tidy(out));
}

export function plainTextLength(items: RichText[]): number {
  return items.reduce((sum, item) => sum + item.text.content.length, 0);
}

/**
 * A block's rich_text array is itself capped at 100 objects, so a very long
 * paragraph becomes several blocks of the same type rather than a truncated one.
 */
function blocksFromRichText(type: string, items: RichText[], extra: Record<string, unknown> = {}): Block[] {
  if (items.length === 0) return [];
  const limit = TUNABLES.richTextArrayLimit;
  const blocks: Block[] = [];
  for (let i = 0; i < items.length; i += limit) {
    blocks.push({
      object: "block",
      type,
      [type]: { rich_text: items.slice(i, i + limit), ...extra },
    });
  }
  return blocks;
}

// --- Images ----------------------------------------------------------------

const LAZY_SRC_ATTRS = [
  "data-src", "data-original", "data-lazy-src", "data-hi-res-src",
  "data-full-src", "data-image-src", "data-echo",
];

const TRACKING_PATTERNS = /(^|[/_-])(pixel|spacer|blank|transparent|1x1|beacon)([._-]|$)/i;

function descriptorWeight(descriptor: string): number {
  const trimmed = descriptor.trim();
  if (trimmed.endsWith("w")) return parseFloat(trimmed) || 1;
  // Density beats width so a 2x candidate outranks a bare one.
  if (trimmed.endsWith("x")) return (parseFloat(trimmed) || 1) * 1000;
  return 1;
}

/**
 * Parse a srcset into candidates, following the HTML spec's rule that **a URL
 * is terminated by whitespace, not by a comma**.
 *
 * Splitting on commas is the obvious implementation and it is wrong. Image CDNs
 * routinely put commas inside the URL — Cloudinary-style transforms like
 * `.../fetch/$s_!ElHF!,w_424,c_limit,f_auto,q_auto:good,fl_progressive:steep/...`
 * are used by Substack among many others. A comma split shreds one URL into
 * several fragments, and the highest-weighted fragment is a relative scrap that
 * silently resolves against the article's own path. The result is a page full
 * of 404s that looks fine in code review.
 */
function parseSrcsetCandidates(value: string): Array<{ url: string; weight: number }> {
  const candidates: Array<{ url: string; weight: number }> = [];
  const isWhitespace = (char: string) => /\s/.test(char);
  let i = 0;

  while (i < value.length) {
    while (i < value.length && (isWhitespace(value[i]!) || value[i] === ",")) i++;
    if (i >= value.length) break;

    const start = i;
    while (i < value.length && !isWhitespace(value[i]!)) i++;
    let url = value.slice(start, i);

    // A URL may carry its own trailing commas when the descriptor is omitted.
    let hadTrailingComma = false;
    while (url.endsWith(",")) {
      url = url.slice(0, -1);
      hadTrailingComma = true;
    }

    let descriptor = "";
    if (!hadTrailingComma) {
      while (i < value.length && value[i] !== ",") descriptor += value[i++];
      if (i < value.length) i++;
    }

    if (url) candidates.push({ url, weight: descriptorWeight(descriptor) });
  }

  return candidates;
}

/** Largest candidate from a srcset, by width or density descriptor. */
function fromSrcset(value: string | null): string | null {
  if (!value) return null;

  let best: { url: string; weight: number } | null = null;
  for (const candidate of parseSrcsetCandidates(value)) {
    if (!best || candidate.weight > best.weight) best = candidate;
  }

  return best?.url ?? null;
}

/**
 * Pick the real image URL. Lazy-loaded images put a placeholder in `src` and the
 * real one in `data-src`/`srcset`, so `src` is the last thing consulted, not the
 * first — naive extraction imports 1x1 spacers and it looks fine in review.
 */
export function pickImageUrl(el: Element, baseUrl: string): string | null {
  const candidates: (string | null)[] = [];

  // <picture> wraps <source srcset> alternatives around a fallback <img>.
  const picture = el.tagName.toUpperCase() === "PICTURE" ? el : el.parentElement;
  if (picture && picture.tagName.toUpperCase() === "PICTURE") {
    for (const source of Array.from(picture.querySelectorAll("source"))) {
      candidates.push(fromSrcset(source.getAttribute("srcset")));
      candidates.push(fromSrcset(source.getAttribute("data-srcset")));
    }
  }

  candidates.push(fromSrcset(el.getAttribute("data-srcset")));
  candidates.push(fromSrcset(el.getAttribute("srcset")));
  for (const attr of LAZY_SRC_ATTRS) candidates.push(el.getAttribute(attr));
  candidates.push(el.getAttribute("src"));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith("data:")) continue;
    const resolved = absoluteUrl(trimmed, baseUrl);
    if (resolved && !TRACKING_PATTERNS.test(new URL(resolved).pathname)) return resolved;
  }

  return null;
}

function isSpacer(el: Element): boolean {
  const min = TUNABLES.minImageDimension;
  for (const attr of ["width", "height"]) {
    const raw = el.getAttribute(attr);
    if (raw === null) continue;
    const value = parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0 && value < min) return true;
  }
  return false;
}

/**
 * Emitted with an `external` URL. The pipeline swaps in a `file_upload` once
 * Notion has imported it — and leaves this shape in place if it can't, so the
 * image degrades to a hotlink rather than vanishing.
 */
export function imageBlock(url: string, caption: RichText[] = []): Block {
  return {
    object: "block",
    type: "image",
    image: { type: "external", external: { url }, caption: splitRichText(caption).slice(0, 100) },
  };
}

function convertImage(el: Element, ctx: Ctx, caption: RichText[] = []): Block[] {
  if (isSpacer(el)) return [];
  const url = pickImageUrl(el, ctx.baseUrl);
  if (!url) return [];
  const alt = el.getAttribute("alt")?.trim();
  const finalCaption =
    caption.length > 0 ? caption : alt ? [makeRichText(alt, {}, null)] : [];
  return [imageBlock(url, finalCaption)];
}

// --- Code ------------------------------------------------------------------

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", py3: "python", python3: "python",
  rb: "ruby", sh: "shell", zsh: "shell", console: "shell", terminal: "shell",
  bash: "bash", yml: "yaml", md: "markdown", tex: "latex",
  "c++": "c++", cpp: "c++", cc: "c++", "c#": "c#", cs: "c#", csharp: "c#",
  golang: "go", rs: "rust", kt: "kotlin", objc: "objective-c",
  htm: "html", xhtml: "html", vue: "html", psql: "sql", postgres: "sql",
  text: "plain text", txt: "plain text", plaintext: "plain text", none: "plain text",
};

const KNOWN_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++",
  "c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow",
  "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell",
  "html", "java", "javascript", "json", "julia", "kotlin", "latex", "less",
  "lisp", "livescript", "lua", "makefile", "markdown", "markup", "matlab",
  "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php",
  "plain text", "powershell", "prolog", "protobuf", "python", "r", "reason",
  "ruby", "rust", "sass", "scala", "scheme", "scss", "shell", "sql", "swift",
  "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly",
  "xml", "yaml",
]);

function detectLanguage(el: Element): string {
  const code = el.querySelector("code") ?? el;
  const sources = [code.getAttribute("class"), el.getAttribute("class"), el.getAttribute("data-language")];

  for (const source of sources) {
    if (!source) continue;
    for (const token of source.split(/\s+/)) {
      const name = token.replace(/^(language|lang|highlight|brush:)[-:]?/i, "").toLowerCase();
      if (!name) continue;
      const resolved = LANGUAGE_ALIASES[name] ?? name;
      if (KNOWN_LANGUAGES.has(resolved)) return resolved;
    }
  }
  return "plain text";
}

export function codeBlock(text: string, language: string): Block[] {
  // Code keeps its whitespace, so it bypasses the normalising rich-text path.
  const items = splitRichText([{ type: "text", text: { content: text } }]);
  return blocksFromRichText("code", items, { language });
}

// --- Tables ----------------------------------------------------------------

/**
 * Notion tables have no merged cells and fix their column count at creation.
 * Where the source table can't be represented, the original markup goes into a
 * code block instead. Ugly, but lossless — and a mangled table doesn't look
 * broken, it looks like bad prose, with the information gone.
 */
function tableFallback(el: Element, reason: string): Block[] {
  return [
    ...blocksFromRichText("paragraph", [
      makeRichText(`Table preserved as HTML (${reason}).`, { italic: true }, null),
    ]),
    ...codeBlock(el.outerHTML, "html"),
  ];
}

function convertTable(el: Element, ctx: Ctx): Block[] {
  const rows = Array.from(el.querySelectorAll("tr"));
  if (rows.length === 0) return [];

  const grid = rows.map((row) => Array.from(row.querySelectorAll("th, td")));

  const hasMergedCells = grid.some((cells) =>
    cells.some((cell) => {
      const colspan = parseInt(cell.getAttribute("colspan") ?? "1", 10);
      const rowspan = parseInt(cell.getAttribute("rowspan") ?? "1", 10);
      return colspan > 1 || rowspan > 1;
    }),
  );
  if (hasMergedCells) return tableFallback(el, "merged cells");

  const width = Math.max(...grid.map((cells) => cells.length));
  if (width === 0) return [];
  if (width > TUNABLES.appendBatchSize) return tableFallback(el, "too many columns");
  // Rows are children, and children append 100 at a time. Rare enough to punt.
  if (rows.length > TUNABLES.appendBatchSize) return tableFallback(el, "over 100 rows");

  const children = grid.map((cells) => ({
    object: "block",
    type: "table_row",
    table_row: {
      // Pad short rows rather than letting Notion reject a ragged table.
      cells: Array.from({ length: width }, (_, i) => {
        const cell = cells[i];
        // Cells hold rich text only, so any block content inside flattens to text.
        return cell ? splitRichText(tidy(cellRichText(cell, ctx))).slice(0, 100) : [];
      }),
    },
  }));

  const firstRow = grid[0] ?? [];
  const hasColumnHeader =
    el.querySelector("thead") !== null ||
    (firstRow.length > 0 && firstRow.every((cell) => cell.tagName.toUpperCase() === "TH"));

  return [
    {
      object: "block",
      type: "table",
      table: {
        table_width: width,
        has_column_header: hasColumnHeader,
        has_row_header: false,
        children,
      },
    },
  ];
}

function cellRichText(cell: Element, ctx: Ctx): RichText[] {
  const out: RichText[] = [];
  collectRichText(cell, ctx, {}, null, out);
  return out;
}

// --- Element dispatch ------------------------------------------------------

const HEADING_LEVELS: Record<string, string> = {
  H1: "heading_1", H2: "heading_2", H3: "heading_3",
  // Notion stops at three levels. Deeper headings land on heading_3 rather
  // than becoming paragraphs, which would lose the fact they were headings.
  H4: "heading_3", H5: "heading_3", H6: "heading_3",
};

function convertElement(el: Element, ctx: Ctx): Block[] {
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return [];

  if (tag in HEADING_LEVELS) {
    const type = HEADING_LEVELS[tag]!;
    return blocksFromRichText(type, richTextFrom(el, ctx.baseUrl), { is_toggleable: false });
  }

  switch (tag) {
    case "P":
      return blocksFromRichText("paragraph", richTextFrom(el, ctx.baseUrl));

    case "UL":
    case "OL":
      return convertList(el, ctx, tag === "OL");

    case "BLOCKQUOTE":
      return convertQuote(el, ctx);

    case "PRE":
      return codeBlock(el.textContent ?? "", detectLanguage(el));

    case "FIGURE":
      return convertFigure(el, ctx);

    case "PICTURE":
    case "IMG":
      return convertImage(el, ctx);

    case "TABLE":
      return convertTable(el, ctx);

    case "HR":
      return [{ object: "block", type: "divider", divider: {} }];

    case "DL":
      return convertDefinitionList(el, ctx);

    case "BR":
      return [];

    default:
      return walkChildren(el, ctx);
  }
}

function convertFigure(el: Element, ctx: Ctx): Block[] {
  const img = el.querySelector("img, picture");
  const figcaption = el.querySelector("figcaption");
  const caption = figcaption ? richTextFrom(figcaption, ctx.baseUrl) : [];

  if (img) {
    const blocks = convertImage(img, ctx, caption);
    if (blocks.length > 0) return blocks;
  }

  // A figure with no usable image still has its caption text worth keeping.
  const rest = walkChildren(el, ctx).filter((block) => block.type !== "image");
  return rest;
}

function convertQuote(el: Element, ctx: Ctx): Block[] {
  const inline: Node[] = [];
  const blocks: Block[] = [];

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1 && !INLINE_TAGS.has((child as Element).tagName.toUpperCase())) {
      blocks.push(...convertElement(child as Element, { ...ctx, depth: ctx.depth + 1 }));
    } else {
      inline.push(child);
    }
  }

  // A blockquote is usually one or more paragraphs; the first becomes the quote
  // itself, the rest become its children so the attribution stays attached.
  const leading = blocks.length > 0 ? blocks : [];
  const inlineText = inline.length > 0 ? richTextFromNodes(inline, ctx) : [];

  if (inlineText.length > 0) {
    const quote = blocksFromRichText("quote", inlineText);
    const head = quote[0];
    if (head && leading.length > 0 && ctx.depth < TUNABLES.maxNestDepth) {
      (head["quote"] as Record<string, unknown>)["children"] = leading;
      return quote;
    }
    return [...quote, ...leading];
  }

  const first = leading[0];
  if (first && first.type === "paragraph") {
    const rest = leading.slice(1);
    const converted: Block = {
      object: "block",
      type: "quote",
      quote: { ...(first["paragraph"] as Record<string, unknown>) },
    };
    if (rest.length > 0 && ctx.depth < TUNABLES.maxNestDepth) {
      (converted["quote"] as Record<string, unknown>)["children"] = rest;
      return [converted];
    }
    return [converted, ...rest];
  }

  return leading;
}

function richTextFromNodes(nodes: Node[], ctx: Ctx): RichText[] {
  const out: RichText[] = [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const content = normalizeText(node.textContent ?? "");
      if (content) out.push(makeRichText(content, {}, null));
    } else if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === "BR") {
        out.push(makeRichText("\n", {}, null));
        continue;
      }
      const link = tag === "A" ? absoluteUrl(el.getAttribute("href"), ctx.baseUrl) : null;
      const items: RichText[] = [];
      collectRichText(el, ctx, annotationsFor(tag, {}), link, items);
      // A bare inline element with no children of its own still has its text.
      if (items.length === 0 && el.textContent) {
        const content = normalizeText(el.textContent);
        if (content) out.push(makeRichText(content, annotationsFor(tag, {}), link));
      }
      out.push(...items);
    }
  }
  return splitRichText(tidy(out));
}

function convertList(el: Element, ctx: Ctx, ordered: boolean): Block[] {
  const type = ordered ? "numbered_list_item" : "bulleted_list_item";
  const blocks: Block[] = [];

  for (const li of Array.from(el.children)) {
    if (li.tagName.toUpperCase() !== "LI") continue;

    const inline: Node[] = [];
    const childBlocks: Block[] = [];

    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === 1 && !INLINE_TAGS.has((child as Element).tagName.toUpperCase())) {
        childBlocks.push(...convertElement(child as Element, { ...ctx, depth: ctx.depth + 1 }));
      } else {
        inline.push(child);
      }
    }

    const items = richTextFromNodes(inline, ctx);
    const itemBlocks = blocksFromRichText(type, items);

    // An empty <li> that only wraps a nested list still needs a carrier block,
    // otherwise the nesting has nowhere to attach.
    if (itemBlocks.length === 0 && childBlocks.length > 0) {
      itemBlocks.push({ object: "block", type, [type]: { rich_text: [] } });
    }

    const head = itemBlocks[0];
    if (head && childBlocks.length > 0) {
      if (ctx.depth + 1 <= TUNABLES.maxNestDepth) {
        (head[type] as Record<string, unknown>)["children"] = childBlocks;
        blocks.push(...itemBlocks);
      } else {
        // Past Notion's nesting limit: flatten to siblings rather than fail.
        blocks.push(...itemBlocks, ...childBlocks);
      }
    } else {
      blocks.push(...itemBlocks);
    }
  }

  return blocks;
}

function convertDefinitionList(el: Element, ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toUpperCase();
    if (tag === "DT") {
      const items = richTextFrom(child, ctx.baseUrl).map((item) => ({
        ...item,
        annotations: { ...item.annotations, bold: true },
      }));
      blocks.push(...blocksFromRichText("paragraph", items));
    } else if (tag === "DD") {
      blocks.push(...blocksFromRichText("bulleted_list_item", richTextFrom(child, ctx.baseUrl)));
    }
  }
  return blocks;
}

/** Walk children, grouping runs of inline content into paragraphs. */
function walkChildren(el: Element, ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  let inlineRun: Node[] = [];

  const flush = () => {
    if (inlineRun.length === 0) return;
    const items = richTextFromNodes(inlineRun, ctx);
    inlineRun = [];
    blocks.push(...blocksFromRichText("paragraph", items));
  };

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      inlineRun.push(child);
      continue;
    }
    if (child.nodeType !== 1) continue;

    const childEl = child as Element;
    const tag = childEl.tagName.toUpperCase();

    if (INLINE_TAGS.has(tag)) {
      inlineRun.push(child);
    } else {
      flush();
      blocks.push(...convertElement(childEl, ctx));
    }
  }

  flush();
  return blocks;
}

// --- Entry point -----------------------------------------------------------

export interface ConversionResult {
  blocks: Block[];
  truncatedAtBlockCap: boolean;
}

export function htmlToBlocks(html: string, baseUrl: string): ConversionResult {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`);
  const body = dom.window.document.body;
  const blocks = walkChildren(body, { baseUrl, depth: 0 });

  if (blocks.length > TUNABLES.maxBlocks) {
    return { blocks: blocks.slice(0, TUNABLES.maxBlocks), truncatedAtBlockCap: true };
  }
  return { blocks, truncatedAtBlockCap: false };
}

/** Every image block in the tree, including nested ones, in document order. */
export function collectImageBlocks(blocks: Block[]): Block[] {
  const found: Block[] = [];
  const visit = (list: Block[]) => {
    for (const block of list) {
      if (block.type === "image") found.push(block);
      const payload = block[block.type] as Record<string, unknown> | undefined;
      const children = payload?.["children"];
      if (Array.isArray(children)) visit(children as Block[]);
    }
  };
  visit(blocks);
  return found;
}

// --- Our own blocks --------------------------------------------------------

export function statusCallout(clipId: string): Block {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [makeRichText(`${STATUS_MARKER}… (${clipId})`, {}, null)],
      icon: { type: "emoji", emoji: "⏳" },
      color: "gray_background",
    },
  };
}

export function errorCallout(message: string, clipId: string): Block {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: splitRichText([
        makeRichText(`${ERROR_MARKER}. `, { bold: true }, null),
        makeRichText(message, {}, null),
        makeRichText(` (${clipId})`, { code: true }, null),
      ]),
      icon: { type: "emoji", emoji: "⚠️" },
      color: "red_background",
    },
  };
}

/**
 * Render footnote bodies as a trailing section.
 *
 * Footnotes are often substantive argument rather than bare citation, so
 * dropping them loses article text. The inline markers survive extraction as
 * bare digits, so without this the reader gets orphaned numbers pointing at
 * nothing.
 */
export function footnoteBlocks(
  footnotes: Array<{ number: string; html: string }>,
  baseUrl: string,
): Block[] {
  if (footnotes.length === 0) return [];

  const blocks: Block[] = [
    { object: "block", type: "divider", divider: {} },
    ...blocksFromRichText("heading_3", [makeRichText("Footnotes", {}, null)], {
      is_toggleable: false,
    }),
  ];

  const dom = new JSDOM("<!DOCTYPE html><body></body>");
  const { document } = dom.window;

  for (const footnote of footnotes) {
    const holder = document.createElement("div");
    holder.innerHTML = footnote.html;

    const body = walkChildren(holder, { baseUrl, depth: 0 });
    const label = makeRichText(`${footnote.number}. `, { bold: true }, null);

    const first = body[0];
    if (first && first.type === "paragraph") {
      const payload = first["paragraph"] as { rich_text: RichText[] };
      payload.rich_text = splitRichText([label, ...payload.rich_text]).slice(
        0,
        TUNABLES.richTextArrayLimit,
      );
      blocks.push(...body);
    } else {
      blocks.push(...blocksFromRichText("paragraph", [label]), ...body);
    }
  }

  return blocks;
}

/**
 * The lead image, as a block.
 *
 * Built here rather than in the selector so its caption goes through exactly
 * the path a `<figcaption>` takes inside the body — including the alt-text
 * fallback. A second caption mechanism would be a second thing to keep right.
 *
 * The parameter is shaped rather than imported: `lead-image.ts` imports this
 * module for `pickImageUrl`, and a type import back would be a cycle.
 */
export function leadImageBlock(
  lead: { url: string; captionHtml: string | null; alt: string | null },
  baseUrl: string,
): Block {
  let caption: RichText[] = [];

  if (lead.captionHtml) {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const holder = dom.window.document.createElement("div");
    holder.innerHTML = lead.captionHtml;
    caption = richTextFrom(holder, baseUrl);
  }

  if (caption.length === 0 && lead.alt) caption = [makeRichText(lead.alt, {}, null)];

  return imageBlock(lead.url, caption);
}

export interface HeaderFields {
  title?: string | null;
  siteName?: string | null;
  byline?: string | null;
  publishedAt?: string | null;
  url: string;
}

/**
 * The clip header. Doubles as the idempotency key: it carries a link to the
 * source URL and is written in the same append call as the first article
 * content, so a run that dies mid-append still leaves it behind for the retry.
 */
export function clipHeader(fields: HeaderFields): Block {
  const parts: RichText[] = [makeRichText(`${HEADER_PREFIX} `, {}, null)];
  parts.push(makeRichText(fields.title?.trim() || fields.url, {}, fields.url));

  const meta = [fields.siteName, fields.byline, fields.publishedAt]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (meta.length > 0) parts.push(makeRichText(` — ${meta.join(" · ")}`, {}, null));

  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: splitRichText(parts) },
  };
}
