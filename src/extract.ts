/**
 * Fetch a URL and pull the readable article out of it.
 *
 * Paywalls and bot-blocks are out of scope by design, but they have to be
 * *detected* — an undetected paywall produces a page containing a cookie banner
 * and a subscribe prompt, which looks like a successful clip until someone reads it.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { TUNABLES } from "./config";
import { errors } from "./errors";

export interface Footnote {
  number: string;
  html: string;
}

export interface ExtractedArticle {
  title: string | null;
  byline: string | null;
  siteName: string | null;
  publishedAt: string | null;
  contentHtml: string;
  textLength: number;
  finalUrl: string;
  footnotes: Footnote[];
}

// --- Fetch -----------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "metadata.google.internal", "instance-data",
]);

/**
 * Cheap SSRF guard. This endpoint fetches an arbitrary URL on request, so at
 * minimum it should refuse to fetch the machine it is running on.
 *
 * Deliberately does not resolve DNS — a hostname pointing at a private address
 * still gets through. Closing that needs resolution plus a check on the socket,
 * which is more machinery than a single-user service warrants today.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw errors.invalidRequest(`Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw errors.invalidRequest(`Unsupported protocol: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw errors.invalidRequest(`Refusing to fetch ${host}`);
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    throw errors.invalidRequest(`Refusing to fetch private address ${host}`);
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const isPrivate =
      a === 0 || a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    if (isPrivate) throw errors.invalidRequest(`Refusing to fetch private address ${host}`);
  }

  return url;
}

function charsetFrom(contentType: string | null, body: Uint8Array): string {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();

  // Sniff the first 2KB for a meta charset, which is where most pages declare it.
  const head = new TextDecoder("utf-8").decode(body.subarray(0, 2048));
  const fromMeta =
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ??
    head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i)?.[1];
  return fromMeta?.toLowerCase() ?? "utf-8";
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
    if (total > TUNABLES.fetchMaxBytes) {
      await reader.cancel();
      break;
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export interface FetchResult {
  html: string;
  finalUrl: string;
  status: number;
}

/**
 * Some sites answer a moved URL with a 200 whose body is a redirect stub — a
 * `<meta http-equiv="refresh">` plus a script. It isn't an HTTP redirect, so
 * `fetch` won't follow it, and what arrives looks like a real but empty page.
 *
 * Only honoured for short, near-immediate redirects: a long delay on a full
 * page is a session timeout, not a move.
 */
export function metaRefreshTarget(html: string, baseUrl: string): string | null {
  if (html.length > 50_000) return null;

  const match = html.match(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*(\d+)\s*;\s*url=([^"'>\s]+)/i,
  );
  if (!match) return null;

  const delay = Number(match[1]);
  if (!Number.isFinite(delay) || delay > 5) return null;

  const target = match[2];
  if (!target) return null;

  try {
    const resolved = new URL(target.replace(/&amp;/g, "&"), baseUrl);
    return resolved.href === baseUrl ? null : resolved.href;
  } catch {
    return null;
  }
}

/**
 * Follows redirects by hand so every hop gets the safety check, not just the
 * URL we were handed.
 */
export async function fetchArticle(rawUrl: string): Promise<FetchResult> {
  let current = assertSafeUrl(rawUrl);

  for (let hop = 0; hop <= TUNABLES.maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TUNABLES.fetchTimeoutMs);

    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": TUNABLES.userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      throw errors.fetchFailed(aborted ? `Timed out after ${TUNABLES.fetchTimeoutMs}ms` : String(err), err);
    }

    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw errors.fetchRejected(response.status, current.href);
        current = assertSafeUrl(new URL(location, current).href);
        continue;
      }

      if (isBlockedStatus(response.status)) {
        throw errors.blocked(`HTTP ${response.status} from ${current.hostname}`);
      }
      if (!response.ok) {
        throw errors.fetchRejected(response.status, current.href);
      }

      const body = await readCapped(response);
      const charset = charsetFrom(response.headers.get("content-type"), body);
      let html: string;
      try {
        html = new TextDecoder(charset).decode(body);
      } catch {
        html = new TextDecoder("utf-8").decode(body);
      }

      const refreshTarget = metaRefreshTarget(html, current.href);
      if (refreshTarget) {
        current = assertSafeUrl(refreshTarget);
        continue;
      }

      return { html, finalUrl: current.href, status: response.status };
    } finally {
      clearTimeout(timer);
    }
  }

  throw errors.fetchFailed(`More than ${TUNABLES.maxRedirects} redirects`);
}

function isBlockedStatus(status: number): boolean {
  // 401/402/403 are login or payment walls; 451 is legal blocking;
  // 429 at fetch time from a cold IP is rate-limiting us as a bot.
  return status === 401 || status === 402 || status === 403 || status === 451 || status === 429;
}

// --- Extract ---------------------------------------------------------------

const BOT_BLOCK_TITLES = [
  "just a moment", "attention required", "access denied", "are you a robot",
  "verify you are human", "security check", "captcha", "pardon our interruption",
  "please enable javascript", "403 forbidden", "bot verification",
];

const PAYWALL_PHRASES = [
  "subscribe to continue", "subscribers only", "already a subscriber",
  "sign in to read", "sign in to continue", "register to continue",
  "create a free account to continue", "to continue reading",
  "you have reached your article limit", "this article is for subscribers",
  "become a member to read", "log in to continue", "start your free trial",
];

/**
 * Clean the document before Readability sees it.
 *
 * Readability scores elements and discards what looks like furniture. Substack
 * buries an anchor-link widget — a nested div containing a `<button>` — inside
 * every heading, and that is enough for the whole heading to be scored as
 * boilerplate and dropped. The result is an article whose section structure has
 * silently vanished while the prose survives, which reads as one long essay
 * rather than a broken clip.
 *
 * Verified on a real Substack post: 9 headings before this runs, 0 after
 * Readability without it.
 */
function stripHeadingWidgets(doc: Document): void {
  for (const heading of Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const text = (heading.textContent ?? "").trim();
    if (!text) continue;

    // Rebuilt rather than edited in place: the widget markup is only half the
    // problem, and Readability also weighs a heading's own attributes. A plain
    // element carrying nothing but its text gives it nothing to score against.
    const clean = doc.createElement(heading.tagName.toLowerCase());
    clean.textContent = text;
    heading.replaceWith(clean);
  }
}

/**
 * Pull footnote bodies out before Readability discards them.
 *
 * Footnotes are frequently substantive argument rather than bare citations, so
 * losing them loses article text. Readability drops the container along with
 * the comments and subscribe furniture, which leaves the inline markers behind
 * as orphaned digits pointing at nothing.
 *
 * Read from the original document, because Readability mutates what it is given.
 */
function collectFootnotes(doc: Document): Footnote[] {
  const found: Footnote[] = [];
  const seen = new Set<string>();

  const containers = doc.querySelectorAll(
    "div.footnote, li.footnote, .footnotes li, section.footnotes li, ol.footnotes > li",
  );

  for (const container of Array.from(containers)) {
    const body = container.querySelector(".footnote-content") ?? container;
    const html = body.innerHTML?.trim() ?? "";
    if (!html) continue;

    const number =
      container.querySelector(".footnote-number")?.textContent?.trim() ||
      container.getAttribute("id")?.replace(/\D+/g, "") ||
      String(found.length + 1);

    // Some pages render the same footnote twice (inline popup plus endnote).
    const key = `${number}:${html.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({ number, html });
  }

  return found;
}

function meta(doc: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    const value = el?.getAttribute("content") ?? el?.getAttribute("datetime") ?? el?.textContent;
    if (value?.trim()) return value.trim();
  }
  return null;
}

function normalizeDate(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 40);
  return parsed.toISOString().slice(0, 10);
}

export function extractArticle(html: string, finalUrl: string): ExtractedArticle {
  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  const pageTitle = (doc.title || "").toLowerCase();
  if (BOT_BLOCK_TITLES.some((marker) => pageTitle.includes(marker))) {
    throw errors.blocked(`Bot-block page title: ${doc.title}`);
  }

  // Read metadata before Readability runs — it mutates the document it is given.
  const metaTitle = meta(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) || doc.title || null;
  const siteName = meta(doc, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
  const metaByline = meta(doc, [
    'meta[name="author"]', 'meta[property="article:author"]', 'meta[name="byl"]',
    'meta[name="parsely-author"]',
  ]);
  const publishedAt = normalizeDate(
    meta(doc, [
      'meta[property="article:published_time"]', 'meta[name="publish-date"]',
      'meta[name="date"]', 'meta[itemprop="datePublished"]', "time[datetime]",
    ]),
  );

  // Both of these read the document before Readability mutates it.
  const footnotes = collectFootnotes(doc);
  stripHeadingWidgets(doc);

  const freeFlag = meta(doc, ['meta[name="isAccessibleForFree"]', 'meta[itemprop="isAccessibleForFree"]']);
  const declaredPaywalled =
    freeFlag?.toLowerCase() === "false" || /"isAccessibleForFree"\s*:\s*(?:false|"false")/i.test(html);

  let parsed: ReturnType<Readability["parse"]>;
  try {
    parsed = new Readability(doc, { charThreshold: TUNABLES.minArticleChars }).parse();
  } catch (err) {
    throw errors.notExtractable(`Readability threw: ${String(err)}`);
  }

  const textLength = parsed?.textContent?.trim().length ?? 0;

  if (!parsed || !parsed.content || textLength < TUNABLES.minArticleChars) {
    // Only look for paywall wording once extraction has already come up short.
    // Checking it on every article would flag any piece that mentions subscriptions.
    const bodyText = (doc.body?.textContent ?? "").toLowerCase();
    const phrase = PAYWALL_PHRASES.find((candidate) => bodyText.includes(candidate));

    if (declaredPaywalled) throw errors.blocked("Page declares isAccessibleForFree: false");
    if (phrase) throw errors.blocked(`Paywall wording found: "${phrase}"`);

    throw errors.notExtractable(
      `Extracted only ${textLength} characters (minimum ${TUNABLES.minArticleChars})`,
    );
  }

  if (declaredPaywalled && textLength < TUNABLES.minArticleChars * 4) {
    throw errors.blocked("Page declares isAccessibleForFree: false and returned only a teaser");
  }

  return {
    title: parsed.title?.trim() || metaTitle,
    byline: parsed.byline?.trim() || metaByline,
    siteName: parsed.siteName?.trim() || siteName || new URL(finalUrl).hostname.replace(/^www\./, ""),
    publishedAt,
    contentHtml: parsed.content,
    textLength,
    finalUrl,
    footnotes,
  };
}
