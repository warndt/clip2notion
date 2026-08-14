/**
 * Find the article's lead image — the hero that sits *outside* the readable
 * body and is therefore invisible to everything downstream.
 *
 * Readability picks an article root and we convert only that root, so an image
 * above it is never seen: nothing fails, nothing is logged, and the clip looks
 * complete. TechCrunch and most WordPress themes put the hero above the `<h1>`,
 * in the article header alongside its credit line, which is a large class of
 * sites rather than one awkward one.
 *
 * Three rules run through this file:
 *   - **A lead image may never fail a clip.** Every entry point here is
 *     total: anything unexpected produces "no candidate", never a throw.
 *   - **Prefer being too strict.** A missing hero is a minor loss. A site logo
 *     inserted at the top of every clip is a visible defect on every page.
 *   - **Say why.** A rejection carries its reason, because the only way to tell
 *     "this site has no hero" from "our exclusions are too aggressive" is the log.
 *
 * Selection runs on the original document, before Readability mutates it.
 */

import { TUNABLES } from "./config";
import { pickImageUrl } from "./blocks";

export type LeadImageRule = "before-h1" | "before-first-paragraph";

export interface LeadImageCandidate {
  url: string;
  rule: LeadImageRule;
  /** Snapshot rather than a live node: Readability mutates the document after this runs. */
  captionHtml: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
}

export interface LeadImageRejection {
  url: string | null;
  reason: string;
}

export interface LeadImageResult {
  candidate: LeadImageCandidate | null;
  rejected: LeadImageRejection[];
}

const NO_LEAD_IMAGE: LeadImageResult = { candidate: null, rejected: [] };

/** Filenames that are furniture rather than content, whatever their size. */
const FURNITURE_NAMES = /logo|icon|avatar|sprite|favicon|headshot|placeholder/i;

/**
 * Class and id fragments that mark chrome. Matched as substrings because that
 * is how these names are built (`site-header__logo-small`, `rightrail-promo`).
 *
 * `newsletter` was here and had to come out: Substack labels the article
 * element itself `newsletter-post`, so it rejected every Substack hero. Found
 * in detect mode against a real post, which is the entire point of shipping
 * this in detect mode. Subscribe boxes are still caught by `subscribe`.
 */
const CHROME_HINTS =
  /nav|menu|share|social|subscribe|promo|sponsor|related|recirc|comment|author|byline|footer|sidebar|rail|breadcrumb|cookie|masthead|logo|avatar/i;

/** Advertising, matched on token boundaries — a bare `ad` is inside "header", "read", "load". */
const AD_HINTS = /(^|[^a-z])(ad|ads|advert|advertisement|adsense|dfp)([^a-z]|$)/i;

/** Elements whose text is plausibly a credit line rather than the headline. */
const CAPTION_TAGS = new Set(["FIGCAPTION", "SPAN", "P", "SMALL", "EM", "CITE", "DIV"]);

/** How many rejections are worth logging before the point is made. */
const MAX_REJECTIONS = 10;

/**
 * Normalise for comparison: host plus path, no query.
 *
 * CDN resizing parameters differ between the same image in two places, so a raw
 * string comparison will not catch a duplicate. On the repro article the hero
 * arrives as `?w=1024` and `og:image` as `?resize=1151,1200`.
 *
 * The `-1024x683` suffix goes too. That is WordPress's resize convention — the
 * same hazard expressed in the path rather than the query, and common enough
 * that ignoring it would put a second copy of the hero at the top of the clip.
 */
export function normalizeImageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/-\d{2,5}x\d{2,5}(\.[a-z0-9]+)$/i, "$1");
    return `${url.hostname.toLowerCase()}${path}`;
  } catch {
    return raw;
  }
}

function attributeDimension(el: Element, name: "width" | "height"): number | null {
  const attr = el.getAttribute(name)?.trim();
  if (attr && /^\d+(px)?$/i.test(attr)) {
    const value = parseInt(attr, 10);
    if (Number.isFinite(value) && value > 0) return value;
  }

  // jsdom has no layout, so "rendered" dimensions are only ever what the markup
  // declares. An inline style is the other place a site declares them.
  const style = el.getAttribute("style") ?? "";
  const match = style.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*(\\d+)px`, "i"));
  if (match?.[1]) {
    const value = parseInt(match[1], 10);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

/**
 * Is this element inside site chrome rather than the article?
 *
 * A `<header>` is ambiguous — the site masthead and the article's own title
 * block are both headers — so it only counts as chrome when it sits outside
 * `<article>`/`<main>` and its own classes don't say otherwise.
 */
function chromeReason(el: Element): string | null {
  let current: Element | null = el;

  while (current && current.tagName !== "BODY" && current.tagName !== "HTML") {
    const tag = current.tagName.toUpperCase();
    if (tag === "NAV") return "inside <nav>";
    if (tag === "ASIDE") return "inside <aside>";
    if (tag === "FOOTER") return "inside <footer>";

    if (tag === "HEADER") {
      const inArticle = current.closest("article, main") !== null;
      const looksEditorial = /article|post|entry|story|hero/i.test(identity(current));
      if (!inArticle && !looksEditorial) return "inside the site <header>";
    }

    // An <article> or <main> declares itself editorial. Whatever its classes
    // say, the element wrapping the content is not chrome.
    const name = tag === "ARTICLE" || tag === "MAIN" ? "" : identity(current);
    if (name) {
      if (AD_HINTS.test(name)) return `advertising markup (${trim(name)})`;
      const hint = name.match(CHROME_HINTS)?.[0];
      if (hint) return `chrome markup (${hint} in ${trim(name)})`;
    }

    current = current.parentElement;
  }

  return null;
}

function identity(el: Element): string {
  const className = typeof el.className === "string" ? el.className : "";
  return `${className} ${el.id ?? ""}`.trim();
}

function trim(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

/**
 * Why this image can't be the lead, or null if it survives.
 * Ordered cheapest-and-most-certain first so the logged reason is the useful one.
 */
function rejectionReason(img: Element, url: string | null): string | null {
  if (!url) return "no usable image URL (placeholder, data: URI, or tracking pixel)";

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "unparseable URL";
  }

  if (/\.svgz?$/i.test(pathname)) return "SVG";

  const furniture = pathname.match(FURNITURE_NAMES)?.[0];
  if (furniture) return `filename says furniture (${furniture})`;

  const min = TUNABLES.leadImageMinDimension;
  const width = attributeDimension(img, "width");
  const height = attributeDimension(img, "height");
  if ((width !== null && width < min) || (height !== null && height < min)) {
    return `too small (${width ?? "?"}x${height ?? "?"}, minimum ${min})`;
  }

  return chromeReason(img);
}

/**
 * The caption or credit beside the candidate.
 *
 * Same shapes body images use — a `<figcaption>` first, then the short text
 * that follows. The heading guard matters: on plenty of layouts the element
 * after the hero is the headline block, and a headline is not a credit line.
 */
function captionHtmlFor(img: Element): string | null {
  const figure = img.closest("figure");
  const figcaption = figure?.querySelector("figcaption");
  if (figcaption?.textContent?.trim()) return figcaption.innerHTML.trim();

  const anchor = figure ?? img;
  const next = anchor.nextElementSibling;
  if (!next) return null;
  if (!CAPTION_TAGS.has(next.tagName.toUpperCase())) return null;
  if (next.querySelector("h1, h2, h3, h4, h5, h6")) return null;

  const text = next.textContent?.trim() ?? "";
  if (text.length < 2 || text.length > TUNABLES.leadImageMaxCaptionChars) return null;

  return next.innerHTML.trim();
}

/** The first paragraph substantial enough to be article prose rather than a label. */
function firstBodyParagraph(doc: Document, heading: Element | null): Element | null {
  for (const p of Array.from(doc.querySelectorAll("p"))) {
    if ((p.textContent ?? "").trim().length < TUNABLES.leadImageBodyParagraphChars) continue;
    if (heading && !precedes(heading, p)) continue;
    return p;
  }
  return null;
}

function precedes(before: Element, after: Element): boolean {
  // DOCUMENT_POSITION_FOLLOWING === 4, spelled out because the Node constants
  // live on the jsdom window rather than anywhere convenient here.
  return (before.compareDocumentPosition(after) & 4) !== 0;
}

/**
 * Pick the lead image, or explain why there isn't one.
 *
 * The search region runs from the top of the document to the first real body
 * paragraph, which covers both places a hero hides: above the `<h1>` in the
 * article header, and just inside the body ahead of the prose. Document order
 * gives the brief's rule ordering for free.
 */
export function selectLeadImage(doc: Document, baseUrl: string): LeadImageResult {
  try {
    const heading = doc.querySelector("article h1") ?? doc.querySelector("h1");
    const boundary = firstBodyParagraph(doc, heading) ?? heading;
    if (!boundary) return NO_LEAD_IMAGE;

    const rejected: LeadImageRejection[] = [];

    for (const img of Array.from(doc.querySelectorAll("img"))) {
      // Document order, so the first image at or past the boundary ends the region.
      // An image *inside* the first paragraph is body content, not a lead.
      if (boundary.contains(img) || !precedes(img, boundary)) break;

      const url = pickImageUrl(img, baseUrl);
      const reason = rejectionReason(img, url);

      if (reason) {
        if (rejected.length < MAX_REJECTIONS) rejected.push({ url, reason });
        continue;
      }

      return {
        candidate: {
          url: url!,
          rule: heading && precedes(img, heading) ? "before-h1" : "before-first-paragraph",
          captionHtml: captionHtmlFor(img),
          alt: img.getAttribute("alt")?.trim() || null,
          width: attributeDimension(img, "width"),
          height: attributeDimension(img, "height"),
        },
        rejected,
      };
    }

    return { candidate: null, rejected };
  } catch {
    // A lead image is a bonus. Nothing here may cost the article.
    return NO_LEAD_IMAGE;
  }
}
