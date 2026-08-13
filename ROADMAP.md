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

## M1 — MVP 🟡

The whole service, in one pass. Awaiting review.

- 🟡 Project scaffolding — `package.json`, `tsconfig.json`, `netlify.toml`, `.env.example`
- 🟡 `src/config.ts` — env plus every tunable in one place, all env-overridable
- 🟡 `src/errors.ts` — error classes with plain-language user messages, each marked transient or not
- 🟡 `src/notion.ts` — API client (paced requests, `429` + `Retry-After`, bounded retry), data-source parent check, paginated child listing, batched append, file upload with polling
- 🟡 `src/extract.ts` — fetch with browser UA and redirect-by-redirect host checks, Readability, paywall/bot-block detection
- 🟡 `src/blocks.ts` — direct DOM walk to Notion blocks, rich-text chunking, lazy-image URL resolution, tables with lossless fallback
- 🟡 `src/pipeline.ts` — orchestration, idempotency, status callout lifecycle, image import
- 🟡 `netlify/functions/clip.ts` — synchronous validation with real status codes, then dispatch
- 🟡 `netlify/functions/clip-background.ts` — the worker; repeats every check, always answers 202
- 🟡 `src/request.ts` — constant-time auth and request parsing, shared by both entry points
- 🟡 `force: true` — delete the previous clip and re-run, scoped to the clip rather than the page
- 🟡 Tests over the invisible-failure cases, including the header/first-content append ordering

**Done when:** a long open-web article with images lands complete and readable, a paywalled URL fails with a clear message and no garbage, and a retry doesn't duplicate.

---

## M3 — Make the service callable by its actual client ⬜

> **Numbered M3 because it was discovered third, but placed here because it blocks M2.** There is no point clipping twenty articles from a terminal when the real caller can't clip one. Do this before finishing M2 below.

**Blocking.** The pipeline works; the door only opens from environments the real caller doesn't have.

The intended caller is a Claude session in the claude.ai chat interface. That environment **cannot POST to `<your-site>.netlify.app`** — its sandbox refuses non-allowlisted hosts at the egress proxy (`x-deny-reason: host_not_allowed`), and its fetch tool is GET-only and cannot set an `X-Clip-Secret` header. Verified directly on 2026-08-12, not assumed.

The M2 clips below prove the pipeline; they do **not** prove callability, because a terminal and that sandbox have different network access.

- 🟡 **Spike: minimal remote MCP server** — `netlify/functions/mcp.ts`, served at `/mcp`. One diagnostic tool, `clip_probe`. Self-contained: imports nothing from `src/`, touches nothing in the clip path, so deleting the file leaves the service unchanged. Goes straight to `main` — there are no branch deploys configured and nothing in production to protect.
- 🟡 **`clip_probe` exists to test the failure channels, not the happy path.** Four modes: `ok`, `tool_error` (a normal result flagged `isError` — how a paywall or wrong page id would surface), `protocol_error` (a JSON-RPC error object), and `thrown` (unhandled server exception). All four verified locally.
- ✅ **Success criterion met: rejections reach the session specific and actionable.** Verdict: **port to MCP.** Observed from a real claude.ai session, 2026-08-13.
- 🟡 **Ported.** `netlify/functions/mcp.ts` now serves `clip_article` and `clip_status`, authenticated by a token in the connector URL. The probe is gone; the pipeline is unchanged behind it.
- 🟡 `src/pipeline.ts` gains `deriveClipStatus` (pure, tested) and `getClipStatus`.
- 🟡 `CALLER-PROMPT.md` rewritten around the two tools and the dispatch-then-confirm loop.
- ⬜ Deploy and re-point the connector at `/mcp?token=…`, then run a real clip end to end from a chat session.

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

- ⬜ **Add `clip_status(page_id)`** returning a definite state — `not_started` / `in_progress` / `clipped` / `failed` with the reason. It reads the page the same way the idempotency check already does, so the logic exists.
- ⬜ `clip_article` returns dispatch wording that cannot be mistaken for completion, and instructs the caller to confirm with `clip_status`.

This turns "did it work" into something the session can *check* rather than *infer from prose*, which is a better guarantee than any wording discipline.
- ⬜ If the spike passes: port `runClip` behind the MCP entry point. Mechanical — the pipeline is unchanged.
- ⬜ Rewrite `CALLER-PROMPT.md` (currently marked superseded; do not paste it anywhere)

**Documented fallback — Notion automation → webhook.** A paid-plan Notion database automation POSTs to the service when a page is created, inverting the direction so Notion calls us and the caller needs no HTTP capability at all.

**Why it wasn't chosen, so nobody relitigates this from scratch:** it surrenders synchronous rejection. There is no way to tell the calling session "that URL was malformed" at call time — everything becomes write, wait, re-read. That is the confidently-wrong-answer shape this project is organised against, and getting a real status code back is precisely why the validating front function exists. Setup is also manual UI config with weak auth options, likely putting the secret in a query string.

---

## M2 — Clip twenty real articles ⬜

The actual test plan. Nothing here is speculative work — it's finding out what breaks.

- 🟡 Write the calling snippet for the Claude project prompt — `CALLER-PROMPT.md`. **Superseded, see M3.**
- 🟡 Rotate `CLIP_SHARED_SECRET` for production and set env vars in Netlify
- 🟡 Deploy

### Verified against live Notion (2026-08-12)

Three real clips, from a terminal. All four of the testable must-be-right items now hold in production, not just against fixtures:

- 🟡 **Images stored in Notion** — NASA Hubble Science, 6/6 images imported and serving from `prod-files-secure.s3.us-west-2.amazonaws.com`, zero degraded to hotlinks. Captions preserved. This is the one the project exists for.
- 🟡 **Tables** — MDN `Cache-Control`, 2 tables converted to genuine Notion `table` blocks (not the HTML fallback), header rows detected, inline code preserved inside cells, empty cells intact. 30 code blocks, 34/34 headings, no content loss.
- 🟡 **Fail visibly** — a paywalled NYT URL produced a red ⚠️ callout with the plain-language message and no partial content. Correctly classified `BLOCKED` at fetch (HTTP 403) rather than clipped as a stub.
- 🟡 **No duplication on retry** — an identical re-POST of a completed clip returned `202` and wrote nothing; the page still holds exactly one header, one article, six images.
- 🟡 Status callout lifecycle — appears on first write, deleted on success, updated in place to the error on failure.

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
- ⬜ Long-form magazine piece, including a paragraph over 2000 characters
- ⬜ A site with lazy-loaded images (`data-src` / `srcset` placeholders) — verified in fixtures, never against a live lazy-loading site
- ⬜ Then: ordinary use, reporting what breaks

- ⬜ Log what breaks in the Backlog below; fix what actually breaks, not what might

**Done when:** Wil clips an article end to end from Claude with the browser extension uninstalled.

---

## Backlog

Discovered work goes here rather than getting fixed in place.

**Found while smoke-testing real articles (fetch + extract + convert only — no Notion round trip yet):**

- ✅ Handled: `blog.rust-lang.org` answers a moved URL with a **200 whose body is a meta-refresh stub**. `fetch` doesn't follow those, so the clip failed as "not extractable" on a perfectly good article. `metaRefreshTarget` now follows short-delay refreshes on small pages. Regression-tested.
- **Wikipedia infobox tables become a lossless HTML code block** (they use `colspan`). Correct by the rules, ugly in practice — and the ugliness is not about merged-cell handling, so don't "fix" it by loosening the merged-cell rule. Two specific problems: the fallback parks a wall of markup at the **top** of the article, where the reader hits it first; and the infobox image is inside that markup, so it never reaches the image importer and is hotlinked-by-omission. If this recurs on real clips, the likely fix is **detect infobox-shaped tables, skip them, and import the image separately** — not a change to table conversion. Wikipedia isn't the target use case, so this waits for a real occurrence.
- Verified working against real HTML: image URL resolution (12 images off a Wikipedia article, 6 off a NASA page, all absolute and real rather than placeholders), code-block language detection, heading/list/quote structure, and the 2000-character rich-text cap.

**Bug found in the M2 clips — code block languages are lost on MDN-style markup:**

All 30 code blocks in the MDN clip came out as `plain text`, and the language name leaked in as a stray paragraph above each one. Root cause confirmed rather than guessed: MDN carries no `class` on the `<pre>` by the time Readability is done (`first <pre> class: null`), and puts the language in a *sibling* element — `<div><p><span>http</span></p><pre><code>…</code></pre></div>`. So `detectLanguage` has nothing to read, and the label element converts to a paragraph like any other unknown content.

One root cause, two symptoms. Fix: when converting a `<pre>`, check the preceding sibling (and the wrapper's first child) for a short text node matching a known language; if it matches, use it as the language *and* suppress the paragraph. Not urgent — no content is lost, code is intact and correctly formatted, it's just unlabelled with a stray word above it. But it will affect every clip from any site using this common markup pattern.

**The template race — found in caller review, not yet handled:**

Notion applies page templates asynchronously, so a page created from a template is blank for a moment. The service appends to the end of the page, so if the template body lands mid-clip, template content and article content interleave.

Currently the caller must wait and confirm the template body has landed before calling `clip_article`. That is a real burden pushed onto the caller. Options if it bites: have `clip_article` poll briefly for a settled page before its first write, or accept a `wait_for_content` flag. Not urgent — the Resources templates in use are small and land fast — but it will produce a scrambled page when it does happen, and a scrambled page reads as a bad clip rather than as a race.

**Known limitations, shipped deliberately:**

- **`force: true` removes notes added below a clip.** The clip's range is "header to end of page", because the service only ever appends. Anything above the header is untouched. Bounding the range exactly would need a footer marker block on every clip — a permanent visible artifact solving a problem that hasn't happened yet. Revisit if it does.
- **A forced re-clip deletes blocks one at a time** at roughly 3 requests/second, so re-clipping a 300-block article spends about a minute and a half deleting before it starts. Well inside the 15-minute budget, just not quick.
- **Tables over 100 rows fall back to an HTML code block** rather than appending rows in a second call. Lossless but ugly. Rare enough to wait for a real occurrence.
- **Table cells hold rich text only** (a Notion constraint). Block-level content inside a cell is flattened to text.
- **Images inside table cells are dropped from the cell** — cells can't contain image blocks. Currently no fallback; if this shows up in a real article, emit the image below the table.
- List nesting deeper than 2 levels is flattened to level 2, not dropped.

**Ideas, unprioritised:**

- Retry a failed image import once before degrading to an external reference
- Per-domain extraction overrides for sites Readability handles badly
- `dry_run` flag returning the block tree without writing, for debugging conversion
- Video/embed handling — currently dropped, unclear what the right Notion representation is
- Cap total imported image bytes per article (workspace storage is finite)
