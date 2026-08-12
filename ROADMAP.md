# clip2notion — Roadmap

Source of truth for planned work. Read in full before every task.

**Status key:** ⬜ not started · 🟡 in progress · ✅ complete (only after Wil reviews and approves) · ⏸️ blocked

---

## Guiding constraints

Every milestone below is shaped by four facts. They're documented in full in `CLAUDE.md` → Hard Constraints; repeated here because they drive the build order:

1. Netlify retries a failed background function twice — so idempotency isn't a polish task, it's load-bearing.
2. Notion image import is asynchronous and must be polled — so image-heavy articles involve many sequential round trips.
3. A background function can't report its outcome in the response — so the outcome has to be written somewhere the caller can re-read.
4. Real-world HTML lies about image URLs — so extraction needs fixtures from real articles, not synthetic tests.

---

## Open questions — decided, flag if you disagree

Section 7 of the brief asked for these to be surfaced rather than decided silently. Current positions:

**Q1 — Does this need a background function, or does it fit synchronously?**
**Position: background function.** A text-only short article would fit in 10s, but the acceptance criteria include a 10+ image article. Each image is create-upload → poll until ready → attach, and Notion's ~3 req/s ceiling means those round trips serialise. Ten images plus batched appends is comfortably past 26s. The synchronous path fails exactly the case the project exists for. Cost of the decision: no result in the response, hence the in-page status mechanism and the idempotency work in M6. **Revisit if** M1's spike shows import latency is much lower than expected.

**Q2 — Is there a library that does HTML→Notion blocks well enough to skip the Markdown hop?**
**Position: undecided, spike it (M2).** The Markdown hop (`turndown` → `@tryfabric/martian`) is a known-working path but loses exactly what this project cares about: image element attributes (`data-src`, `srcset`) are gone by the time we reach Markdown, figure/figcaption pairing is flattened, and table fidelity is weak. A direct DOM walk keeps all of it and is not much code. But that's a hypothesis — M2 tests both against the four target article types before committing. Don't skip the spike; picking wrong here means rewriting the conversion layer.

**Q3 — Is there better observability than writing status into the page?**
**Position: in-page status, plus structured logs.** It needs no extra properties, survives the caller's session ending, and the calling Claude can verify by re-fetching the page it already has the id for. Two alternatives were considered: a **Notion comment** on the page (cleaner — keeps failure noise out of the body, and doubles as an audit trail; worth testing in M6 as a variant) and an **external status store** (rejected — new infrastructure, new failure mode, and the caller would need a second endpoint to poll).

---

## M0 — Scaffolding ⬜

Goal: a deployable repo that does nothing yet, correctly.

- ⬜ `package.json`, `tsconfig.json`, dependency baseline
- ⬜ `.gitignore`, `.env.example` (names only, never values)
- ⬜ `src/config.ts` — env loading and every tunable in one place (timeouts, size caps, concurrency, retry counts). No magic numbers anywhere else in the codebase.
- ⬜ `src/log.ts` — structured JSON logging keyed by `clip_id`
- ⬜ `netlify/functions/health.ts` — reports env-var presence and pinned Notion API version, echoes no secret values
- ⬜ `public/404.html`
- ⬜ Verify `netlify dev` runs and `/health` responds

**Done when:** `netlify dev` serves a health check locally.

---

## M1 — Spike: Notion file import ⬜

**Standalone prototype before any integration.** This is the highest-uncertainty part of the project — the API is recent, moves, and fails in ways that only show up against real files.

- ⬜ `spikes/file-upload.ts` — takes an image URL, runs `POST /v1/file_uploads` with `mode: "external_url"`, polls until `uploaded` or `failed`, attaches to a scratch page
- ⬜ Confirm the current request/response shape against live docs, and confirm the pinned `NOTION_API_VERSION` is current
- ⬜ Measure: how long does a typical import take? What's the realistic poll interval and ceiling?
- ⬜ Deliberately break it: no `Content-Type`, non-SSL URL, oversized file, missing extension, 404 URL. Record what `file_import_result` says for each.
- ⬜ Write findings to `spikes/README.md` — including the measured latency, which feeds back into Q1

**Done when:** an image from a real article is visible in a Notion test page, stored by Notion, and every failure mode above has a recorded error signature.

---

## M2 — Spike: HTML → Notion blocks ⬜

**Standalone prototype.** Resolves Q2 before the conversion layer gets written.

- ⬜ Save HTML fixtures from the four target article types into `tests/fixtures/`: long-form magazine piece, technical post with code blocks, image-heavy listicle, known paywalled article
- ⬜ Path A: `turndown` → `@tryfabric/martian`. Check current maintenance status of both.
- ⬜ Path B: direct DOM walk → blocks
- ⬜ Compare on: heading levels, nested lists, blockquotes, code blocks *with language*, tables, image attribute survival, figcaption pairing
- ⬜ Record the decision and the reasoning in `spikes/README.md`

**Done when:** one path is chosen with evidence, not preference.

---

## M3 — Endpoint contract and security ⬜

Goal: the endpoint is reachable, authenticated, and safe — and still writes nothing.

- ⬜ `netlify/functions/clip-background.ts` — accepts `POST`, returns `202` with a `clip_id`
- ⬜ `src/http/auth.ts` — constant-time secret comparison (`crypto.timingSafeEqual`, length-safe)
- ⬜ `src/http/validate.ts` — body validation, page-id normalisation (dashed/undashed), URL must be absolute `https://`
- ⬜ `src/http/ssrf.ts` — reject localhost, loopback, private, link-local, and IPv6-mapped equivalents. Re-check on every redirect hop.
- ⬜ `src/notion/client.ts` — version header, `429` + `Retry-After` handling, bounded backoff
- ⬜ `src/notion/guard.ts` — fetch the page, verify its parent is `RESOURCES_DATA_SOURCE_ID`, reject with `403` otherwise

**Done when:** a wrong secret gets `401`, a page outside Resources gets `403`, a private-IP URL gets `400`, and a valid request gets `202` — with nothing written to Notion in any case.

**Test:** the acceptance criteria "wrong secret is rejected and writes nothing" and "`page_id` outside Resources is rejected" are both satisfied at this milestone.

---

## M4 — Fetch and extract ⬜

- ⬜ `src/fetch/article.ts` — browser user-agent, configurable timeout, response size cap, redirect chain captured so the final URL is available as the base
- ⬜ `src/extract/article.ts` — Readability (or Defuddle, if M2 favours it) → title, byline, site name, published date, content HTML
- ⬜ `src/extract/images.ts` — resolve relative URLs against the **final** base URL; pick the real image from `srcset`/`data-srcset`/`data-src` before falling back to `src`; drop tracking pixels and sub-threshold spacers
- ⬜ `src/extract/blocked.ts` — paywall / login-wall / bot-block heuristics (status codes, known markers, suspiciously short body relative to page size)

**Done when:** all four fixtures extract correctly, the listicle yields real image URLs rather than placeholders, and the paywalled fixture is classified `BLOCKED`.

---

## M5 — Convert to blocks ⬜

Uses the path chosen in M2.

- ⬜ `src/convert/rich-text.ts` — inline marks (bold, italic, code, strikethrough, links) and **2000-character chunking that never truncates**
- ⬜ `src/convert/to-blocks.ts` — headings, paragraphs, nested lists, blockquotes, code blocks with language, images with captions, tables, dividers
- ⬜ `src/convert/limits.ts` — flatten nesting past Notion's depth limit rather than failing; cap total blocks with a configurable ceiling and log if hit
- ⬜ Unit tests over the fixtures, including a >2000-character paragraph

**Done when:** every fixture converts to a valid block tree and the long-paragraph test proves nothing is lost.

---

## M6 — Write to Notion ⬜

Goal: the first end-to-end clip, text only.

- ⬜ `src/notion/append.ts` — batches of 100, sequential, rate-limit aware
- ⬜ `src/notion/status.ts` — in-progress callout written first; deleted on success; replaced with a class-specific error callout on failure
- ⬜ `src/idempotency.ts` — permanent clip header as the idempotency key; detect existing clip or in-progress callout and stop; `force: true` clears prior clip blocks first
- ⬜ Header block: title, publication, author, date, link to original
- ⬜ `src/pipeline.ts` — orchestration, with the throw-only-on-transient rule enforced at the boundary so Netlify never retries a deterministic failure
- ⬜ Variant test for Q3: try a Notion comment alongside the in-page callout, decide which stays

**Done when:** a text article lands complete, and invoking the same request twice produces exactly one copy of the article.

---

## M7 — Image import ⬜

Uses the findings from M1.

- ⬜ `src/notion/file-upload.ts` — create, poll with backoff to a configurable ceiling, attach
- ⬜ Bounded concurrency (configurable), respecting the ~3 req/s budget shared with appends
- ⬜ **Graceful degradation:** an image that fails import becomes an external-URL image block, and the degradation is logged with the reason. It never disappears.
- ⬜ Pre-flight the rejection conditions where cheap (non-SSL, missing extension) rather than paying a full import cycle to be told no
- ⬜ Caption preservation through the upload swap

**Done when:** the 10+ image article lands with images stored in Notion, and a deliberately broken image URL degrades visibly rather than vanishing.

---

## M8 — Acceptance pass ⬜

Run the full criteria list from the brief against production, not local.

- ⬜ Long-form magazine piece — complete, formatting intact
- ⬜ Technical post — code blocks keep their language
- ⬜ Image-heavy listicle — 10+ images stored in Notion, real images not placeholders
- ⬜ Paywalled article — clear visible error, no partial garbage
- ⬜ >2000-character paragraph preserved in full
- ⬜ Simulated retry does not duplicate content
- ⬜ Wrong secret rejected, writes nothing
- ⬜ Page outside Resources rejected
- ⬜ Timing check: how close does the worst case get to the 15-minute ceiling?

---

## M9 — Caller integration ⬜

- ⬜ Write the calling snippet for the Claude project prompt: endpoint, headers, body, and how to verify the result by re-fetching the page
- ⬜ Document the error callouts the caller might find, and what each means
- ⬜ README updated with real setup steps
- ⬜ End-to-end run from an actual Claude session, not curl

**Done when:** Wil clips an article end to end from Claude with the browser extension uninstalled.

---

## Backlog

Discovered work goes here rather than getting fixed in place.

- Per-domain extraction overrides for sites Readability handles badly
- Retry a failed image import once before degrading to external
- Cap total imported image bytes per article (workspace storage is finite)
- Handle articles paginated across multiple URLs
- Consider a `dry_run` flag that returns the block tree without writing — useful for debugging conversion without burning a page
- Video/embed handling — currently out of scope, unclear what the right Notion representation is
- Revisit whether `health` should verify the Notion token by making a real call, or stay purely local
