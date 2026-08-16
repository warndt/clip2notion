# clip2notion — Roadmap

Source of truth for planned work. Read in full before every task.

**Status key:** ⬜ not started · 🟡 in progress (awaiting review) · ✅ complete (only after Wil reviews and approves) · ⏸️ blocked

**Scope was cut deliberately.** One user, a few articles a week, who can look at a page and re-run it if it's wrong. Build the smallest thing that works and let real articles tell us what's missing. No spikes, no comparison matrices, no five-directory source split.

---

## The five things that must be right

Everything else is negotiable. These five fail *invisibly* — the page looks fine and isn't — which is the only reason they survived the scope cut. Any change touching these needs a test.

1. **Images stored in Notion, not hotlinked.** Fall back to an external reference rather than dropping the image.
2. **Don't duplicate on retry.** Netlify retries at 1min and 2min. Only throw on transient failures — never on a paywall, never after a partial append.
3. **Don't truncate.** Rich text caps at 2000 chars per object. Split, never cut.
4. **Fail visibly.** In-progress callout first, replaced with a plain-language error on failure. Never auto-delete partial content.
5. **Tables.** Where `colspan`/`rowspan` make clean conversion impossible, fall back to something lossless. Never silently drop cells.

---

> **State as of 2026-08-15:** the service works end to end and is in ordinary use. An article is clipped from a claude.ai chat session via the MCP connector, images stored in Notion, structure intact, exactly one copy after a forced re-clip.
>
> Since the 14th, on the back of real clips rather than planning: the **lead image** above the article body is captured (M4); `clip_status` reports **when** a clip was written and `/health` reports what is deployed, so "did it actually run?" and "is the fix live?" are both answerable (M5); and **images wrapped in links** — a whole class that was being silently discarded — are converted properly (M6). Deployed at `d225195`.
>
> Everything below is either history, or optional work that real usage will prioritise better than planning would.

## M1 — MVP ✅

The whole service, in one pass. Awaiting review.

- ✅ Project scaffolding — `package.json`, `tsconfig.json`, `netlify.toml`, `.env.example`
- ✅ `src/config.ts` — env plus every tunable in one place, all env-overridable
- ✅ `src/errors.ts` — error classes with plain-language user messages, each marked transient or not
- ✅ `src/notion.ts` — API client (paced requests, `429` + `Retry-After`, bounded retry), data-source parent check, paginated child listing, batched append, file upload with polling
- ✅ `src/extract.ts` — fetch with browser UA and redirect-by-redirect host checks, Readability, paywall/bot-block detection
- ✅ `src/blocks.ts` — direct DOM walk to Notion blocks, rich-text chunking, lazy-image URL resolution, tables with lossless fallback
- ✅ `src/pipeline.ts` — orchestration, idempotency, status callout lifecycle, image import
- ✅ `netlify/functions/clip.ts` — synchronous validation with real status codes, then dispatch
- ✅ `netlify/functions/clip-background.ts` — the worker; repeats every check, always answers 202
- ✅ `src/request.ts` — constant-time auth and request parsing, shared by both entry points
- ✅ `force: true` — delete the previous clip and re-run, scoped to the clip rather than the page
- ✅ Tests over the invisible-failure cases, including the header/first-content append ordering

**Done when:** a long open-web article with images lands complete and readable, a paywalled URL fails with a clear message and no garbage, and a retry doesn't duplicate.

---

## M3 — Make the service callable by its actual client ✅

> **Numbered M3 because it was discovered third, but placed here because it blocks M2.** There is no point clipping twenty articles from a terminal when the real caller can't clip one. Do this before finishing M2 below.

**Blocking.** The pipeline works; the door only opens from environments the real caller doesn't have.

The intended caller is a Claude session in the claude.ai chat interface. That environment **cannot POST to `<your-site>.netlify.app`** — its sandbox refuses non-allowlisted hosts at the egress proxy (`x-deny-reason: host_not_allowed`), and its fetch tool is GET-only and cannot set an `X-Clip-Secret` header. Verified directly on 2026-08-12, not assumed.

The M2 clips below prove the pipeline; they do **not** prove callability, because a terminal and that sandbox have different network access.

- ✅ **Spike: minimal remote MCP server** — `netlify/functions/mcp.ts`, served at `/mcp`. One diagnostic tool, `clip_probe`. Self-contained: imports nothing from `src/`, touches nothing in the clip path, so deleting the file leaves the service unchanged. Goes straight to `main` — there are no branch deploys configured and nothing in production to protect.
- ✅ **`clip_probe` exists to test the failure channels, not the happy path.** Four modes: `ok`, `tool_error` (a normal result flagged `isError` — how a paywall or wrong page id would surface), `protocol_error` (a JSON-RPC error object), and `thrown` (unhandled server exception). All four verified locally.
- ✅ **Success criterion met: rejections reach the session specific and actionable.** Verdict: **port to MCP.** Observed from a real claude.ai session, 2026-08-13.
- ✅ **Ported.** `netlify/functions/mcp.ts` now serves `clip_article` and `clip_status`, authenticated by a token in the connector URL. The probe is gone; the pipeline is unchanged behind it.
- ✅ `src/pipeline.ts` gains `deriveClipStatus` (pure, tested) and `getClipStatus`.
- ✅ Caller documentation rewritten around the two tools and the dispatch-then-confirm loop.
- ✅ Deployed, connector re-pointed at `/mcp/<token>`, and a real clip run end to end from a chat session. **The query-string form did not survive** — claude.ai reached the endpoint with no query at all (`has_query: false` in every logged request), so the connector attached but its tools never loaded. A path segment carries the token reliably. Query, `Authorization` and `X-Clip-Secret` are all still accepted.

### Spike results — how each failure channel actually behaves

| Channel | What reached the session |
|---|---|
| Tool result (`isError`) | **Full text, intact.** Cause, consequence, and remedy all survived. Best behaved by a wide margin. |
| JSON-RPC `-32602` | Code and message survived. **`data` arrived as `null` despite being sent** — that field is dropped in transit and cannot be relied on. |
| JSON-RPC `-32603` | **Replaced** with a generic "the connector's server isn't responding, you can try again". The server's own message never arrived. |
| Unhandled exception | Same generic substitution. Nothing useful reached the caller. |

**Four design rules follow, and they are binding on the port:**

1. **Every user-facing failure goes through a tool result with `isError`, never a protocol error.** Protocol errors are for malformed calls only.
2. **Never let an exception escape the tool handler.** `-32603` is substituted with "you can try again" — advice that is wrong for a paywall and invites an endless retry loop. Catch everything and convert it to a tool result with real text.
3. **Failure prose must be unmistakable at the level of the words.** The `isError` flag does **not** reach the model as a distinct machine-readable field — what arrives is the harness's `<error>` wrapper plus our wording. The spike's text read as a failure because it was *written* as one. Lead every failure with an explicit marker; never let a failure be phrased like an acceptance.
4. **Do not let success-of-dispatch read as success-of-write.** See below.

### The sharper hazard: dispatch is not a write

The spike's success text said "accepted, verify the page shortly". A session relaying that to a user as "clipped it" has overstated what it was told — **with no error involved anywhere**. That is the confidently-wrong-answer failure this project exists to prevent, arriving through the success path rather than a failure path.

Returning only after the write confirms is not available: a long illustrated article takes minutes and a tool call cannot wait that long. So the fix is a second tool.

- ✅ **`clip_status(page_id)`** returns a definite state — `NOT_STARTED` / `IN_PROGRESS` / `CLIPPED` / `FAILED`, as a stable first-line token. It reads the page the same way the idempotency check does.
- ✅ `clip_article` returns dispatch wording that cannot be mistaken for completion, and instructs the caller to confirm with `clip_status`.

This turns "did it work" into something the session can *check* rather than *infer from prose*, which is a better guarantee than any wording discipline.
- ✅ Ported `runClip` behind the MCP entry point. The pipeline itself is unchanged.
- ✅ `TOOL-BRIEF.md` written as the single caller-facing reference: the two tools, the full parameter contract, the status tokens, the rules that keep a caller from reporting a clip that never happened, and a troubleshooting table. Mirrored into a Notion page the calling session can read.

**Done when:** an article is clipped end to end from a claude.ai chat session, with the browser extension uninstalled. **Met 2026-08-14** — Noahpinion long-form, three images stored in Notion with fresh file objects, section headings and footnotes intact, article present exactly once after a forced re-clip, images confirmed rendering.

**Documented fallback — Notion automation → webhook.** A paid-plan Notion database automation POSTs to the service when a page is created, inverting the direction so Notion calls us and the caller needs no HTTP capability at all.

**Why it wasn't chosen, so nobody relitigates this from scratch:** it surrenders synchronous rejection. There is no way to tell the calling session "that URL was malformed" at call time — everything becomes write, wait, re-read. That is the confidently-wrong-answer shape this project is organised against, and getting a real status code back is precisely why the validating front function exists. Setup is also manual UI config with weak auth options, likely putting the secret in a query string.

---

## M2 — Clip twenty real articles ✅

The actual test plan. Nothing here is speculative work — it's finding out what breaks.

> **Closed 2026-08-16 with one case deliberately still open.** Everything below shipped and is in daily use, but the retry-after-partial-append case at the bottom was never exercised — it cannot be produced by clipping, only by injecting a fault. Marking the milestone complete does not mark that ⬜ complete. It is the single most important failure mode in the project and it remains unproven.

- ✅ Write the calling snippet for the Claude project prompt. **Superseded — the caller reaches the service over MCP, not HTTP. See M3.**
- ✅ Rotate `CLIP_SHARED_SECRET` for production and set env vars in Netlify
- ✅ Deploy

### Verified against live Notion (2026-08-12)

Three real clips, from a terminal. All four of the testable must-be-right items now hold in production, not just against fixtures:

- ✅ **Images stored in Notion** — NASA Hubble Science, 6/6 images imported and serving from `prod-files-secure.s3.us-west-2.amazonaws.com`, zero degraded to hotlinks. Captions preserved. This is the one the project exists for.
- ✅ **Tables** — MDN `Cache-Control`, 2 tables converted to genuine Notion `table` blocks (not the HTML fallback), header rows detected, inline code preserved inside cells, empty cells intact. 30 code blocks, 34/34 headings, no content loss.
- ✅ **Fail visibly** — a paywalled NYT URL produced a red ⚠️ callout with the plain-language message and no partial content. Correctly classified `BLOCKED` at fetch (HTTP 403) rather than clipped as a stub.
- ✅ **No duplication on retry** — an identical re-POST of a completed clip returned `202` and wrote nothing; the page still holds exactly one header, one article, six images.
- ✅ Status callout lifecycle — appears on first write, deleted on success, updated in place to the error on failure.

### Still untested: the dangerous idempotency case ⬜

Re-POSTing a *completed* clip is the easy half. The state the design actually protects against is **content written → run died → Netlify retry arrives**, which no amount of clipping produces naturally.

- ⬜ Inject a temporary throw after the first append batch and confirm the retry finds the clip header and stops.
- ⬜ **Run it locally under `netlify dev`, never deployed.** `netlify dev` injects the linked site's environment variables, so the pipeline runs against real Notion with real credentials while the fault stays in the working tree. Nothing to deploy, therefore nothing to forget to remove — a stronger guarantee than a preview deploy, which still has to be torn down.
- ⬜ **The fault injection must not reach `main` under any circumstances.** Unlike the MCP spike, which is additive, this one deliberately breaks the clip path — it is the single change that would make the live service destructive. A leftover fault line is exactly the kind of thing that survives a rebase unnoticed.

This is worth going out of the way for: it is the one failure that surfaces weeks later as duplicated article content, on a page nobody is watching.
### Coverage, not a count

The brief said "clip twenty real articles." The evidence argues for coverage instead: three clips have produced two real bugs, and both came from **variety** rather than volume — a site that redirects via a meta-refresh stub, and a site that puts code languages in a sibling element. Twenty articles from similar sources would teach less than five deliberately different ones.

And once M3 lands, these stop being tests. Clipping is just using the tool, so the remaining work is "use it on things you actually want to keep, and report what breaks" — no manufactured test pages cluttering Resources.

- ✅ Image-heavy — NASA Hubble Science (6 images, all stored)
- ✅ Technical post with code blocks and tables — MDN Cache-Control
- ✅ Paywalled — NYT
- ✅ Long-form with CDN images and footnotes — Noahpinion (Substack)
- ✅ A site with `srcset` CDN transforms — Substack, which is what exposed the comma-splitting bug
- ⬜ A paragraph over 2000 characters against a live article — still only proven in fixtures
- ⬜ Then: ordinary use, reporting what breaks

- ⬜ Log what breaks in the Backlog below; fix what actually breaks, not what might

**Done when:** Wil clips an article end to end from Claude with the browser extension uninstalled. **Met 2026-08-14.**

### Field report from the first live connector clips (2026-08-13/14)

Five defects found by the calling session, all fixed. Recorded because every one of them was invisible from this side — the pipeline reported success throughout.

- ✅ **P0 — `clip_status` said `NOT_STARTED` for a page holding a complete article.** Two causes. A forced re-clip deleted blocks one at a time with the header first, leaving content unmarked for tens of seconds; the progress callout is now written *before* any deletion. And absence of a marker was read as absence of content, which is the dangerous direction — the contract sends a `NOT_STARTED` page to a non-`force` clip, appending a second copy. Content with no header now reads `in_progress`.
- ✅ **P1 — `clip_article` asserted a confirmed outcome it had no basis for.** It dispatched then watched the page, and on the first look a forced re-clip still shows the *previous* clip. It now waits for its own run's marker before believing any terminal state.
- ✅ **A transport error from `clip_article` did not mean the clip hadn't happened.** Dispatch completes before the wait, so a killed function looks like failure for work already running. Retrying on that error is how a page gets the article twice. The tool description and caller prompt now forbid it: after a transport error, call `clip_status`, never `clip_article`.
- ✅ **Headings dropped entirely on Substack.** Not conversion — Readability scored them as boilerplate because an anchor-link widget with a `<button>` sits inside each one. Nine headings before extraction, zero after. Headings are rebuilt as plain elements first.
- ✅ **Footnote bodies dropped, markers left as orphaned digits.** Bodies are now collected from the original document before Readability discards them and appended as a Footnotes section; markers render as `[1]` rather than fusing into the preceding word.

Also corrected: the `CLIPPED` response asserted images were stored in Notion, which nothing verified — and it said so about a run whose images were broken.

---

## M4 — Lead image ✅

Articles whose hero sits **outside** the article body lost it entirely. Nothing failed and nothing was logged: images are only ever collected from Readability's output, so an image above the article root was never seen. Confirmed in the code before building — 8 images in the raw TechCrunch document, 2 in the extracted body, no filter involved.

- ✅ `src/lead-image.ts` — candidate selection over the region from the top of the document to the first real body paragraph, which covers both places a hero hides: above the `<h1>`, and just inside the body ahead of the prose. Exclusions for SVGs, furniture filenames, sub-200px images, tracking pixels, `data:` URIs, and chrome ancestry. Runs before Readability, which mutates the document it is given.
- ✅ Dedupe by normalised URL — host plus path, no query — because the same file appears at different CDN sizes in the two places. WordPress's `-1024x683` resize suffix is stripped too: the same hazard expressed in the path.
- ✅ **No metadata fallback.** On the repro article `og:image` is a *body* image at another size, so a naive fallback would insert a duplicate and still miss the hero. Substack's is an auto-generated social card with the headline burned in. Revisit only if the logs show a class of sites worth catching.
- ✅ Placed below the `Source:` line and above the first heading, before image import, so it stores in Notion and degrades to a hotlink by exactly the path body images use.
- ✅ `lead_image_found` / `lead_image_skipped_duplicate` / `lead_image_none` / `lead_image_rejected` — the last two matter most: they are the only way to tell "this site has no hero" from "the exclusions are too tight".
- ✅ 19 tests, including the dedupe, both no-op modes, and the guarantee that a lead image can never fail a clip.
- ⬜ **Ships as `LEAD_IMAGE_MODE=detect`** — selection runs and logs, nothing is written. Flip to `insert` after reading the logs from a spread of real clips. ⚠️ A Netlify env change needs a redeploy before live functions see it.

**Detect mode has already earned itself**, before deploying: a substring match on `newsletter` in the chrome exclusions rejected *every* Substack hero, because Substack labels the article element itself `newsletter-post`. Found by running selection over a real post. Fixed, and an `<article>`/`<main>` element is now never read as chrome whatever its classes say.

Verified against live markup, fetched 2026-08-14:

| Site | Result |
|---|---|
| TechCrunch (repro) | Hero found above the `<h1>`, credit line captured, both site logos rejected. Not a duplicate of either body image. |
| Ars Technica | Hero found ahead of the first paragraph, 1920×1080, nothing rejected. |
| Noahpinion (Substack) | Hero found with its Unsplash credit; five avatars rejected as too small. |
| Astral Codex Ten | No candidate — the post genuinely has no images. The `og:image` social card was correctly not used. |
| MDN | No candidate, nothing rejected. |

### Detect mode in the field — first four live clips (2026-08-14)

Deployed at `b513ae3`. Every outcome was correct, and **nothing would have been inserted on any of them** — all four articles already carried their hero inside the body.

| Clip | Logged | Verified against the source |
|---|---|---|
| peterdarbyshire.com (WordPress blog) | `lead_image_none`, 0 rejected | Correct. 11 images on the page, all sidebar book covers, WordPress logos and a tracking pixel, all past the first paragraph. `og:image` is a blank placeholder. |
| archdaily.com | `lead_image_skipped_duplicate` | Correct. The hero *is* the first body image; the two URLs differ only by a cache-busting query. |
| techcrunch.com (AI-pilled) | 2 × `lead_image_rejected` (SVG), then `lead_image_skipped_duplicate` | Correct. Both site logos rejected; this article's hero sits inside the body, unlike the repro article. |
| grimoiremanor.substack.com | `lead_image_none`, 2 rejected (40×40, 36×36 avatars) | Correct. The post opens with a paragraph and its hero follows, inside the body, where it was clipped. |

Four furniture images rejected, zero real heroes rejected, zero wrong candidates, dedupe firing correctly on two different CDNs. The one evidence type still missing is a live `lead_image_found` — the flag should not flip until an article with a hero *above* the body has been clipped in detect mode. The original repro article is the guaranteed case.

- ✅ **Flipped to `insert`** (2026-08-15), by changing the default in `config.ts` rather than setting a Netlify env var — an env change needs a redeploy anyway, and a default in code is one fewer thing to forget. `LEAD_IMAGE_MODE=detect` or `off` in the Netlify UI is the rollback.

**Done when:** a re-clip of the repro article shows the pattern screenshot at the top and the Yaris photo exactly once. **Met 2026-08-15**, confirmed by the calling session:

- Repro article re-clipped with `force: true` → three images, hero directly below the `Source:` line with its credit, Yaris photo exactly once, all three serving from `prod-files-secure.s3...` rather than hotlinked.
- A fresh TechCrunch clip took its Getty hero and rejected four candidates that a looser rule would have taken: two site logos, an event promo, and **the author headshot** — a real JPEG close to the article, marked as furniture only by its 150px width and its filename. The caller expected that one to slip through.
- Nothing spurious on either page: no logo, no avatar, no ad, no duplicated body image.
- `TOOL-BRIEF.md` §5 now says lead images are captured. ⚠️ **The Notion mirror and the caller's system prompt need re-syncing.**

---

## M5 — Make "did it actually run?" answerable ✅

Raised by the calling session after three forced re-clips it could not verify, and worth more than it looks: every hour lost tonight went on that question rather than on the clip itself.

- ✅ **`netlify/functions/health.ts`** — reports the deployed commit SHA, presence (never value) of each required secret, and the live settings. `200` configured, `503` misconfigured. **CLAUDE.md documented this endpoint as the post-deploy check and it did not exist** — hitting it returned the 404 page, so that check had never once worked.
- ✅ **`clip_status` now reports when the clip was written**, absolutely and relatively. Read from the header block's Notion `created_time`, so nothing new is written to the page, the tool contract is unchanged, and the idempotency key is untouched. A forced re-clip deletes the old header and writes a new one, so the time moves when a run really happened.
- ✅ `IN_PROGRESS` reports when the run started, which also makes a dead run visible as an old marker.
- ✅ Known limit, deliberately accepted: Notion records block creation to the minute, so two runs inside the same minute are indistinguishable. This is a *report*, never a decision input — nothing branches on it.

### The timestamp did its job on the first run that used it

Verified 2026-08-15, and worth recording because the sequence is not the obvious one. A forced re-clip produced, in order:

1. `CLIPPED` — `Clip written: 2026-08-14 20:59 UTC (4 hours ago)` ← **the previous clip**
2. `IN_PROGRESS` — `Run started: 2026-08-15 00:31 UTC (1 minute ago)`
3. `CLIPPED` — `Clip written: 2026-08-15 00:32 UTC (moments ago)`

**A stale `CLIPPED` arrives *before* `IN_PROGRESS`**, because the run had been dispatched but had not yet planted its marker, so the tool read the page and truthfully found the old clip. Before the timestamp, that first response was indistinguishable from success — which is exactly how three earlier re-clips ended up unverifiable.

**Asked for, and deliberately not built: `clip_status` returning `IN_PROGRESS` instead of a stale `CLIPPED`.** It cannot. `clip_status` reads the page and nothing else — there is no job store, so a dispatch that has not touched the page yet is invisible to it, and a page clipped last week is legitimately `CLIPPED`. Any rule of the form "an old timestamp means something is coming" would misreport every ordinary status check. The timestamp *is* the substitute for the knowledge the tool cannot have, and the tool text now tells the caller to read it on a re-clip.

### ⚠️ Netlify function logs drop entries — established 2026-08-15

I told Wil the caller's three `force` attempts "never arrived at the function", on the evidence that the page id appeared nowhere in three hours of logs. **That inference was wrong, and the reasoning behind it is unsafe.**

A `clip_status` call I made myself, which returned a correct page-specific answer and therefore certainly executed, **never appeared in the logs at all** — not immediately, and not in a poll five minutes later. Entries also arrive minutes late and out of order relative to each other.

So the logs are usable as positive evidence (a line that is there happened) and **worthless as negative evidence** (a line that is missing proves nothing). Every diagnosis that turns on "there is no log entry for X" has to be re-checked against something else. This is precisely why the health endpoint and the clip timestamp are worth their deploy: both answer questions the logs cannot be trusted to.

---

## M6 — Images that never became images ✅

Reported from real use: an ArchDaily project page clipped 2 images out of a 21-image article, and a Divisare project clipped **none at all**. Both reported success. Diagnosed by counting images at each stage rather than by reading the sites: Readability's output held 21 and 33 images respectively, so nothing was lost upstream — the converter was throwing them away.

**Root cause: an `<img>` wrapped in an `<a>` was flattened into link text.** `<a>` is an inline tag, so a linked image landed in a run of prose and `collectRichText` degraded it to a link carrying its alt text. The image itself was gone. This is how a very large class of sites publishes photography — every photo links to its full-size version or a lightbox — so it was never one awkward site. ArchDaily lost 18 of 21 images this way; Divisare lost all 33.

- ✅ An inline wrapper holding an image and no text is now treated as a block, in all three places that split inline from block content. A genuinely inline image — an icon inside a sentence — is unchanged, which is what the no-text condition protects.
- ✅ A paragraph with no words of its own but an image inside it converts as a figure. That is how Divisare publishes every photograph.
- ✅ A list item holding only an image emits the image rather than a bullet. ArchDaily's gallery strip is `ul > li > a > picture > img`, eleven of them; as bullets they would read as a list of nothing.

**Two more defects surfaced while fixing it, both older than this change:**

- ✅ **`pickImageUrl` never looked at the inner `<img>` when handed a `<picture>`.** The figure and gallery paths hand over the `<picture>`, whose own attributes are empty — so any `<picture>` without a `<source>` yielded no URL at all, and one with only a phone-sized source yielded the thumbnail. Caught by a test written for something else.
- ✅ **The phone-sized `<source>` outranked the full image.** `<source media="(max-width: 767px)">` is the small copy; preferring it archived a 6KB thumbnail while leaving the 98KB photograph on the source site. Now demoted rather than skipped — a first attempt that skipped them deleted images outright, because on a lazy-loaded image the mobile source is sometimes the only real URL in the markup. A small copy beats no copy.
- ✅ Loading animations no longer count as photographs. A real clip stored `assets.adsttc.com/doodles/flat/loader-white.gif` in Notion, permanently.

Measured before and after, on the reported articles and on four already-verified ones:

| Article | Before | After |
|---|---|---|
| Divisare project | **0** | 33 |
| ArchDaily project | 2 | 15, of which 12 at `medium_jpg` rather than thumbnails |
| Ars Technica review | 9 | 12 |
| Noahpinion (Substack) | 2 | 3 |
| TechCrunch repro | 3 | 3 — unchanged, as intended |
| MDN, Astral Codex Ten | 0 | 0 — neither has body images |

Seven tests, including the two that keep the fix honest: an icon inside a sentence must not split the paragraph, and a photograph named `loaders-at-work.jpg` must survive the loader filter.

**Done when:** Wil re-clips both reported articles with `force: true` and sees the full set. **Met 2026-08-15** — ArchDaily 15 images with all 15 stored in Notion and none degraded; Divisare 33 images with 29 stored. Confirmed against the function logs and reviewed on the pages: images render correctly.

---

## Backlog

Discovered work goes here rather than getting fixed in place.

**⬜ `loudersound.com` refuses everything, not just us — uninvestigated (found 2026-08-16).**

Failed the same day as `ecuad.ca` and reported through the same `BLOCKED` path (`clp_id5huito`, HTTP 403), but it is **not** the same problem. `ecuad.ca` refuses Node while serving the article to curl; `loudersound.com` 403s curl too, from a residential IP with a browser User-Agent. That is a harder wall, and the cause was never established.

Worth knowing before spending time on it: the fix that helped `ecuad.ca` was a *message* fix, not an access fix, and this site already gets the same corrected wording. So there is no user-facing defect outstanding here — only an unanswered question about whether the site is reachable at all. Left alone deliberately until a real clip needs it.

**✅ `clip_status` reported `IN_PROGRESS` forever on any page the Web Clipper filled. Fixed and approved (2026-08-16).**

Fixed in two steps. First the orphan branch was given a timestamp — the newest block, standing in for the marker it lacks — so the caller's fifteen-minute rule had something to apply to. Then the state itself was corrected: a new `foreign_content` state and a `STATUS: FOREIGN_CONTENT` token, meaning "there is content here and none of it is mine", which is the only claim the block list supports. ⚠️ **The Notion guide and the caller's system prompt both need the new token.**

Original report:


Discovered immediately after the fix below, on the very page that prompted it. The clip failed, Wil fell back to the Notion Web Clipper as instructed, and the page then reported `IN_PROGRESS` to ten consecutive `clip_status` calls — including the first, before `clip_article` had been called at all.

Nothing was running. There is no marker on that page: no progress callout, no error callout, no `Source:` header. `deriveClipStatus` falls through to the orphan-content branch (`status.ts:136`), sees ~30 substantive blocks against `orphanContentThreshold` of 5, and concludes a clip is mid-write. `markerCreatedAt` is absent because there is no marker to date, so the caller loses the fifteen-minute bound too and cannot even declare it dead.

**The bad part is which path triggers it.** The Web Clipper is the *documented fallback* for `BLOCKED` failures — so the recovery we tell users to perform is precisely what poisons the status endpoint afterwards. Every fallback page becomes permanently unreadable to the caller.

Not a trivial fix, which is why it is recorded rather than patched. The branch exists to stop `NOT_STARTED` being reported for a page holding a half-written clip, because that sends the caller to a non-`force` clip and appends a second copy. Returning `not_started` here would be correct for a Web Clipper page and dangerous for a half-deleted one, and the block list alone does not distinguish them. Options worth weighing: look for the Web Clipper's own signature, require a clip2notion marker before claiming `in_progress` now that the progress callout is always written first, or report a distinct fourth state meaning "content present, none of it ours".

Note the caller handled it correctly — it stopped, refused to fire `clip_article` at a page reporting a live run, and asked. The instinct was right even though the diagnosis it offered was wrong.

**✅ A 403 was reported to the user as a paywall. Message split, approved (2026-08-16).**

`ecuad.ca` failed a clip (`clp_km0rcf25`) with *"Paywall or bot-block detected — this article can't be fetched without a login."* The article is free and open. So is the site.

Root cause, measured rather than assumed: **Cloudflare refuses this service on Node's TLS fingerprint, not on its headers or Netlify's IPs.** From one residential machine, same IP, same three headers — curl over HTTP/1.1 → 200, Python → 200, Node `fetch` → 403, `node:https` → 403. Replaying undici's exact header set *and order* through curl still → 200. Cipher-list and `ecdhCurve` tuning from Node changed nothing. Incidentally: undici silently overwrites `Sec-Fetch-Mode: navigate` with `cors`, so `fetch` cannot present itself as a document navigation — though that was not the trigger either.

**So "send browser-like headers" is not a fix, and was deliberately not shipped.** The lever is below the header layer and Node's TLS stack does not expose it. Recorded here so it does not get re-proposed.

What did ship: `errors.blocked` split into `paywalled` / `refused` / `botChallenge` / `rateLimited`, all still `BLOCKED` and non-transient, so retry semantics are untouched. 401/402 → paywall; 403/451 → refused; 429 → rate-limited. The upstream status is now a first-class `http_status` log field rather than only prose inside `detail`. `TOOL-BRIEF.md` updated in the same commit — **the Notion copy and the caller's system prompt still need re-syncing.**

Two open threads:

- **This is systematic, not site-specific.** Any site with bot protection turned up will do it. The same day, `loudersound.com` failed with the same symptom and a *different* cause — it 403s curl too, so that one is an everyone-blocked wall rather than a fingerprint issue. Both were reported to the user as paywalls. If these accumulate, the question worth asking is whether a fetch-through proxy earns its keep; it is one external dependency on every clip, so not yet.
- **`ecuad.ca` is Web Clipper territory** until the university relaxes its own settings. Nothing to fix in the service.

**Found while smoke-testing real articles (fetch + extract + convert only — no Notion round trip yet):**

- ✅ Handled: `blog.rust-lang.org` answers a moved URL with a **200 whose body is a meta-refresh stub**. `fetch` doesn't follow those, so the clip failed as "not extractable" on a perfectly good article. `metaRefreshTarget` now follows short-delay refreshes on small pages. Regression-tested.
- **Wikipedia infobox tables become a lossless HTML code block** (they use `colspan`). Correct by the rules, ugly in practice — and the ugliness is not about merged-cell handling, so don't "fix" it by loosening the merged-cell rule. Two specific problems: the fallback parks a wall of markup at the **top** of the article, where the reader hits it first; and the infobox image is inside that markup, so it never reaches the image importer and is hotlinked-by-omission. If this recurs on real clips, the likely fix is **detect infobox-shaped tables, skip them, and import the image separately** — not a change to table conversion. Wikipedia isn't the target use case, so this waits for a real occurrence.
- Verified working against real HTML: image URL resolution (12 images off a Wikipedia article, 6 off a NASA page, all absolute and real rather than placeholders), code-block language detection, heading/list/quote structure, and the 2000-character rich-text cap.

**Bug found in the first real MCP clip — srcset URLs containing commas were shredded. Fixed.**

Substack's images came out as 404s pointing at `noahpinion.blog` instead of the CDN. Root cause: `fromSrcset` split the attribute on commas, but image CDNs put commas *inside* the URL — Cloudinary-style transforms like `.../fetch/$s_!ElHF!,w_424,c_limit,f_auto,q_auto:good,fl_progressive:steep/...`. Splitting produced fragments, the widest-looking fragment was a relative scrap, and it resolved against the article's own path.

Now parsed per the HTML spec, where **a srcset URL is terminated by whitespace, not by a comma**. Verified against the live article: all three images return `200 image/webp` from `substackcdn.com`. Regression-tested with the real markup.

Worth noting what this says about the earlier testing: the fixtures used simple `srcset="/w400.jpg 400w"` markup, which the broken parser handled correctly. Only a real CDN URL exposed it. The degradation path did work as designed — the failed import fell back to an external reference rather than dropping the image — but it degraded to a URL that was already wrong.

**Bug found in the M2 clips — code block languages are lost on MDN-style markup:**

All 30 code blocks in the MDN clip came out as `plain text`, and the language name leaked in as a stray paragraph above each one. Root cause confirmed rather than guessed: MDN carries no `class` on the `<pre>` by the time Readability is done (`first <pre> class: null`), and puts the language in a *sibling* element — `<div><p><span>http</span></p><pre><code>…</code></pre></div>`. So `detectLanguage` has nothing to read, and the label element converts to a paragraph like any other unknown content.

One root cause, two symptoms. Fix: when converting a `<pre>`, check the preceding sibling (and the wrapper's first child) for a short text node matching a known language; if it matches, use it as the language *and* suppress the paragraph. Not urgent — no content is lost, code is intact and correctly formatted, it's just unlabelled with a stray word above it. But it will affect every clip from any site using this common markup pattern.

**The template race — raised in caller review, then disproved by testing. Resolved.**

The concern: Notion applies templates asynchronously, so a page created from a template is briefly blank, and since the service appends to the end of a page, a template body landing mid-clip would interleave with the article.

I responded by telling the caller to wait until the template body had landed. **That instruction was wrong and caused a deadlock in the very next test.** A caller followed it correctly, fetched a blank page twice, and stopped — waiting for content that was never going to arrive.

Root cause, verified 2026-08-13: **at that time every template in WDB | Resources had a blank body.** The default `(New article to read)` and the named ones such as `(Architecture clipping)` preset *properties* — Status, Areas, Tags — and seeded no content. There was nothing to wait for.

⚠️ **No longer true.** The templates were reissued on 2026-08-14 as `[New resource] <v1.0>` and siblings, and now seed a version toggle and a divider. The advice is unchanged — clip in regardless, never wait — but the reasoning above is history, not the current state. The change also caused a follow-on defect, recorded below.

Two lessons worth keeping:

1. **An instruction of the form "wait until X appears" is a deadlock whenever X may never appear.** It has to be paired with a way to tell "not yet" from "never", and a blank page provides no such signal — it looks identical in both cases. This one was unfalsifiable from the caller's side.
2. **Verify a reported hazard applies before designing around it.** The race is real in the abstract; it was not real for this database, and one fetch of the template would have shown that before the instruction shipped.

Still true, and narrow: if body-bearing templates are ever added to Resources, the append-to-end behaviour would interleave. Revisit then — the fix would be server-side (settle-check before the first write), not another instruction to the caller.

**Notion MCP fetches may be cached — noted by the test caller:**

Two consecutive `notion-fetch` calls on the same page returned an identical `as of` timestamp, so the second may have been served from cache rather than being a genuine re-read. This matters for any "fetch twice and compare" technique, including checking whether a background clip has progressed. `clip_status` goes through the Notion REST API rather than the MCP connector, so it is not affected — but a caller re-fetching the page to verify might be.

**Templates gained bodies, which broke status detection (2026-08-14). Fixed.**

Resources templates were reissued carrying a version toggle and a divider. `deriveClipStatus` read *any* content-without-a-header as a clip mid-write — a guard added days earlier against the opposite failure — so a freshly created page reported `IN_PROGRESS` with nothing running. A caller would poll it and then report a dead run.

Now requires enough content to look like a half-written article rather than template furniture (`ORPHAN_CONTENT_THRESHOLD`, default 5 blocks). The forced-re-clip guard is also marked by its own progress callout, so the content heuristic is a second line of defence rather than the only one.

Also extracted `selectBlocksToDelete` as a pure exported function and tested it, because template furniture now sits above every clip and the blast radius of a destructive operation should be a test rather than a reading of the loop. Confirmed: content above the clip header survives, stale callouts are swept, the run's own marker is spared, and a URL that was never clipped removes nothing.

**A caller sets properties that a template also presets — worth knowing:**

Templates now preset properties. A property passed alongside `template_id` overrides rather than merges, so a caller setting properties explicitly can silently wipe a template's preset Area. The clipper never touches properties, so this is not a clipper bug — but it belongs in the caller's system prompt.

**Cold starts eat the synchronous budget — mitigated, not solved:**

`mcp.ts` transitively imports jsdom through the converter, so a cold container spends several seconds initialising before any handler code runs. Netlify's 10s clock covers that init; a handler can only measure from its own entry. Measured cold: ~6s for a call doing no waiting at all.

Mitigated by detecting a cold container (handler entered within 1.5s of module load) and using a much smaller wait ceiling, so the total stays clear of the kill. The proper fix is to stop `mcp.ts` pulling jsdom at all — split the status logic and `assertSafeUrl` into modules that don't import the converter or Readability. That is a refactor of working code, so it needs a decision rather than a drive-by.

**Update 2026-08-14 — the transport errors are not our latency.** Three `clip_article` calls in a row surfaced to the caller as transport errors. Measured from the function logs, those same invocations were **warm** (`cold_start: false`) and returned in **549ms and 1736ms** — nowhere near the 10s kill, and well inside the ~3s budget the tunables target. Nothing on this side was slow. The remaining lever is not another budget cut; it is either the connector transport itself or something about how the response is delivered. Worth a look before shaving more off the wait budgets, which would cost the caller certainty for nothing.

The protections held throughout: each caller checked `clip_status` instead of retrying, every URL produced exactly one `clip_start`, and no page was written twice. Clip durations themselves were 3.0s, 6.8s, 7.3s and 7.9s — the pipeline is not what feels slow.

**Known limitations, shipped deliberately:**

- **`force: true` removes notes added below a clip.** The clip's range is "header to end of page", because the service only ever appends. Anything above the header is untouched. Bounding the range exactly would need a footer marker block on every clip — a permanent visible artifact solving a problem that hasn't happened yet. Revisit if it does.
- **A forced re-clip deletes blocks one at a time** at roughly 3 requests/second, so re-clipping a 300-block article spends about a minute and a half deleting before it starts. Well inside the 15-minute budget, just not quick.
- **Tables over 100 rows fall back to an HTML code block** rather than appending rows in a second call. Lossless but ugly. Rare enough to wait for a real occurrence.
- **Table cells hold rich text only** (a Notion constraint). Block-level content inside a cell is flattened to text.
- **Images inside table cells are dropped from the cell** — cells can't contain image blocks. Currently no fallback; if this shows up in a real article, emit the image below the table.
- List nesting deeper than 2 levels is flattened to level 2, not dropped.

**Readability drops captioned images on Substack — found while building the lead-image work (2026-08-14):**

Not the lead image, and not fixed here. On a real Noahpinion post, four content images sit inside `div.body.markup`; the converted body holds **two**. The two that vanish are exactly the two carrying a `<figcaption>` — the credit lines "Photo by Joe Dudeck" and "Illustrative diagram adapted from Lennart Heim" appear twice in the raw HTML and zero times in the extracted content, along with every `captioned-image-container`. So Readability is discarding the captioned figures wholesale, not just their captions.

This is silent content loss on a site that is already a known-awkward source (it also ate the headings and the footnotes). Same shape as those: the clip reports success and the page looks fine. Worth fixing by the same technique — rebuild or rescue the figures before Readability scores them — but it is a separate change from the hero, and it needs its own evidence about how many sites are affected.

One consequence worth knowing meanwhile: because the hero on that post is one of the dropped images, the lead-image step inserts it rather than deduping it. Correct today, and self-correcting if this is ever fixed — the dedupe will simply start catching it.

**An `<img>` can point at a PDF, and four did (2026-08-15):**

The Divisare re-clip stored 29 of 33 images and degraded 4. All four are the project's **architectural drawings**, which Divisare publishes inside `<img>` tags pointing at `.pdf` URLs; the CDN serves `application/pdf` regardless of the `Accept` header, and asking for the same asset as `.jpg` 404s. So the degradation is correct — Notion's importer cannot take a PDF as an image — but those four drawings are now hotlinks to Divisare, which is exactly the impermanence this service exists to remove. They may also render as broken images on the page.

The fix would be to import a non-image attachment as a Notion **file block** rather than an image block: `POST /v1/file_uploads` accepts PDFs, so the drawing would be stored and openable. That is a new block type in the converter and worth doing only if this recurs — though on architecture sites it very likely will, since plans and sections are usually PDFs.

**Reviewed 2026-08-15 and deliberately not built.** The page reads fine as it stands, so the cost is four drawings that live on Divisare's servers rather than in Notion — a permanence gap, not a visible defect. Revisit when a clip actually suffers for it.

**Left alone in the M6 image work, deliberately:**

- **An author bio photo can still reach the page.** ArchDaily's "about the author" headshot converts like any body image. The lead-image selector rejects headshots by filename, but applying that filter to body images would risk dropping a real photograph whose filename happens to say `icon` — a worse trade for one stray avatar at the end of an article.
- **A gallery repeats photos the body already showed.** ArchDaily's strip includes every photo, so the two in the article body appear twice. That is what the page itself shows; deduping body images against each other is a bigger decision than it looks, because an article may repeat an image on purpose.
- **The largest variant is not always reachable.** ArchDaily's full-size images sit behind one HTML page per photo. Following those links would be a new capability — a fetch per image — and `medium_jpg` at 98KB turned out to be enough to make the whole set usable, so it stays unbuilt until something needs it.

**Ideas, unprioritised:**

- Retry a failed image import once before degrading to an external reference
- Per-domain extraction overrides for sites Readability handles badly
- `dry_run` flag returning the block tree without writing, for debugging conversion
- Video/embed handling — currently dropped, unclear what the right Notion representation is
- Cap total imported image bytes per article (workspace storage is finite)
