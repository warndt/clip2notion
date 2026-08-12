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
- 🟡 `netlify/functions/clip-background.ts` — constant-time auth, validation, dispatch
- 🟡 Tests over the invisible-failure cases

**Done when:** a long open-web article with images lands complete and readable, a paywalled URL fails with a clear message and no garbage, and a retry doesn't duplicate.

---

## M2 — Clip twenty real articles ⬜

The actual test plan. Nothing here is speculative work — it's finding out what breaks.

- ⬜ Deploy and set env vars in Netlify
- ⬜ Write the calling snippet for the Claude project prompt
- ⬜ Clip twenty real articles across the spread: long-form magazine, technical posts with code, image-heavy listicles, at least one paywalled
- ⬜ Log what breaks in the Backlog below; fix what actually breaks, not what might

**Done when:** Wil clips an article end to end from Claude with the browser extension uninstalled.

---

## Backlog

Discovered work goes here rather than getting fixed in place.

**Found while smoke-testing real articles (fetch + extract + convert only — no Notion round trip yet):**

- ✅ Handled: `blog.rust-lang.org` answers a moved URL with a **200 whose body is a meta-refresh stub**. `fetch` doesn't follow those, so the clip failed as "not extractable" on a perfectly good article. `metaRefreshTarget` now follows short-delay refreshes on small pages. Regression-tested.
- **Wikipedia infobox tables become a lossless HTML code block** (they use `colspan`), which parks a wall of markup at the top of the article — and the infobox image is inside it, so it never reaches the image importer. Correct by the rules, ugly in practice. Wikipedia isn't the target use case; revisit if it comes up for real.
- Verified working against real HTML: image URL resolution (12 images off a Wikipedia article, 6 off a NASA page, all absolute and real rather than placeholders), code-block language detection, heading/list/quote structure, and the 2000-character rich-text cap.

**Known limitations, shipped deliberately:**

- **A background function can't return a real status code.** Netlify returns `202` before the handler runs, so a wrong secret or a page outside the Resources data source is rejected *silently* — nothing is written, and the rejection is logged, but the caller still sees `202`. Fixable with a synchronous validating function in front, at the cost of a second function and an internal HTTP hop. Worth doing only if the silence actually bites.
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
