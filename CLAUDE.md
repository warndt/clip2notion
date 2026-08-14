# Never start a Claude Code project from scratch

# clip2notion — Claude Code Instructions

## Read First

Before making **any** change to this codebase:

1. Read `ROADMAP.md` in full. Confirm your change does not conflict with or make harder any planned work. If it does, flag the conflict and ask before proceeding.
2. Check the design system page (if one exists) for established patterns, components, and design tokens. This is a headless service with no UI, so there probably won't be one — see the Design System section.
3. Read the **Hard Constraints** section below before writing anything that touches Notion, the fetch layer, or the function entry point. Most of those constraints fail silently in production rather than loudly in testing.

---

## What This App Is

**clip2notion** is a headless service that fills an existing Notion page with the full readable content of a web article. It replaces the Notion Web Clipper browser extension for open-web articles.

The workflow it belongs to: a Claude project session creates a page in the **WDB | Resources** Notion database and sets every property (status, areas, tags, dates, relations) via the Notion MCP. Claude cannot write article body content at scale, so it hands this service a `page_id` and a `url`, and the service appends the article — structure preserved, images stored inside Notion rather than hotlinked so the clip survives the source site changing or disappearing.

The service is deliberately narrow. It does not create pages, set properties, or make categorisation decisions — those belong to the caller, which means this service needs no changes when the database schema changes. It does not authenticate to source sites; paywalled content is out of scope and must fail visibly.

Deployed as a Netlify function. Called by a Claude session over HTTPS with a shared secret in a header.

---

## File Structure

<!-- Keep this up to date as files are added or moved. This is the proposed structure — parts of it don't exist yet. See ROADMAP.md for build order. -->

```
/
├── CLAUDE.md                       # This file — Claude Code instructions
├── ROADMAP.md                      # Feature roadmap and task backlog (source of truth)
├── README.md                       # Project overview, setup, and usage
├── CALLER-PROMPT.md                # The snippet pasted into the calling Claude project.
│                                   #   Update it whenever the request contract changes.
├── netlify.toml                    # Netlify config: publish dir, functions, redirects, headers
├── package.json                    # Dependencies and scripts
├── tsconfig.json                   # TypeScript config
├── .env.example                    # Required env vars, no values — copy to .env locally
├── .gitignore
│
├── public/                         # Static publish dir (near-empty; this is an API, not a site)
│   └── 404.html
│
├── netlify/
│   └── functions/
│       ├── mcp.ts                  # ← how the real caller reaches this service.
│       │                           #   MCP connector: clip_article + clip_status
│       ├── clip.ts                 # HTTP endpoint. Validates synchronously, returns a
│       │                           #   real status code. Used from a terminal for testing
│       └── clip-background.ts      # The worker. 15 minutes, always answers 202
│
├── src/
│   ├── config.ts                   # Env vars + every tunable, all env-overridable
│   ├── errors.ts                   # ClipError taxonomy — see Data Formats
│   ├── log.ts                      # Structured JSON logging, keyed by clip_id
│   ├── request.ts                  # Auth + request parsing, shared by both entry points
│   ├── notion.ts                   # API client, parent check, append, file upload
│   ├── extract.ts                  # Fetch + Readability + paywall/bot-block detection
│   ├── blocks.ts                   # DOM walk → Notion blocks, rich text, tables, images
│   └── pipeline.ts                 # Orchestration: idempotency, status, image import, append
│
└── tests/
    └── *.test.ts                   # Covers the five invisible-failure cases
```

**Rules for this structure**

- One file per pipeline stage. **Split a file when it gets annoying to work in, not before** — this is a small service, and an earlier five-directory split was cut deliberately.
- `netlify/functions/clip-background.ts` stays thin: auth, validate, hand off to `src/pipeline.ts`. All logic lives in `src/` so it can be tested without Netlify.
- Nothing in `src/` imports from `netlify/`.
- Every real article that breaks something becomes a test case.

---

## Hard Constraints

These bound any implementation. Several of them fail late and silently in production rather than in testing, which is why they are written down.

### Netlify

- Synchronous functions time out at **10s** (26s on Pro, by request). Background functions (`-background` filename suffix) run up to **15 minutes** but return `202` immediately and cannot report a result in the HTTP response.
- ⚠️ **`mcp.ts` is synchronous, so the 10s ceiling applies to it.** It blocks briefly waiting for a clip to settle, and those budgets live in `TUNABLES.syncFunctionBudgetMs`. Exceeding the ceiling does not degrade gracefully: Netlify kills the function mid-flight and the caller sees *"the connector's server isn't responding"* — indistinguishable from the whole service being down. This has already happened once, from budgets set to 20s. Every wait loop measures against `enteredAt`, the moment the request arrived; keep it that way when adding another.
- **Netlify retries a failed background function after 1 minute, and again 2 minutes later.** A run that fails after partially appending content will otherwise duplicate that content. This is the single most important failure mode in the project.
- Consequence: **only throw from the background handler for genuinely transient failures.** A deterministic failure (paywall, unextractable content, bad page id) must be recorded in the page, logged, and then returned as a success to Netlify — otherwise it gets retried twice for no reason.

### Notion API

- API version header is configurable via `NOTION_API_VERSION`. Current value at time of writing: **`2026-03-11`**. Re-check the live docs before assuming; this moves.
- **Rich text is capped at 2000 characters per object.** Long paragraphs must be split across multiple rich-text objects in the same block, never truncated.
- **Block children append 100 at a time.** Long articles need batching.
- Block nesting depth is limited. Deeply nested lists must be flattened, not dropped and not failed on.
- Rate limit is roughly **3 requests/second** averaged. Handle `429` by honouring `Retry-After`.
- **Image permanence uses file import:** `POST /v1/file_uploads` with `mode: "external_url"`. Notion fetches the file itself, asynchronously — poll `GET /v1/file_uploads/{id}` until `status` leaves `pending` (becomes `uploaded` or `failed`) before attaching it to a block. Check `file_import_result` for the error detail on failure.
- That import is rejected if the URL isn't SSL, isn't publicly reachable, has no `Content-Type` header, exceeds the workspace per-file size limit, or lacks a valid filename and supported MIME type. **Real articles hit all of these.** An image that can't be imported degrades to an external reference and the degradation gets logged — it never vanishes.
- Databases and data sources are distinct in current API versions. `RESOURCES_DATA_SOURCE_ID` is a **data source** id, and the page-parent check must compare against the right field.

### Real-world HTML

- **Image URLs in extracted content are frequently relative.** Resolve every image and link URL against the article's final (post-redirect) base URL.
- **Lazy-loaded images put a placeholder in `src`** with the real image in `data-src`, `data-srcset`, or `srcset`. Naive extraction imports 1×1 spacers and tracking pixels, and the result looks fine in code review. Prefer the largest candidate from `srcset`/`data-srcset`, then `data-src`, then `src`.

### Security

- Shared secret compared in **constant time**. Never `===`.
- **Always verify the target page's parent is the Resources data source before writing.** A leaked secret must not permit appending to arbitrary pages in the workspace.
- SSRF protection on the fetch target: no localhost, no private/link-local/loopback IP ranges, HTTPS only, and re-check **on every redirect hop**, not just the initial URL.

---

## Key Rules

### Scope & Approach

1. **Stay in scope.** Only make changes related to the current task. If you notice something else that needs fixing, note it in the Backlog section of ROADMAP.md — don't fix it.
2. **Understand before building.** Before building anything from scratch, understand the purpose of the application and the context of what already exists. Ask clarifying questions if the intent isn't clear.
3. **Build modularly.** Design components, modules, and data structures to be reusable and self-contained. Prefer small, focused files over monoliths.
4. **No surprise refactors.** Never delete or refactor working code without asking first. If you think something should be restructured, explain why and wait for approval.

### Development Philosophy

5. **Build in small, testable steps.** Each change should leave the app in a working state. Break large features into increments that can be tested and verified independently before moving on.
6. **Prototype risky features in isolation.** When a feature involves unfamiliar APIs, complex integrations, or uncertain approaches, build a minimal standalone proof of concept first. Validate that it works, understand the failure modes, then fold it into the main app. Flag when you think something warrants a prototype.
7. **Think about what comes next.** Before implementing, consider how this task fits into the broader roadmap. Choose data structures, field names, and patterns that won't need to be reworked when later features arrive. If a planned feature defines a field name or pattern, use it.

### Code & File Conventions

8. **Keep files small.** If a file is getting large, split it into focused modules. Use clear, descriptive filenames.
9. **No inline CSS or JS in HTML files** (unless the project explicitly calls for it). Styles and logic go in their own files. Exception: JSON-LD `<script type="application/ld+json">` blocks and analytics snippets (e.g. GA4) belong in the HTML.
10. **Mobile-first by default.** All UI work should be responsive and consider mobile as the primary target. Test or reason through mobile behaviour for any UI change.

### Design System

11. **Check the design system first.** Before creating new UI components or styles, check the design system page for existing patterns. If no design system page exists yet, flag this and ask about setting one up.
12. **Keep the design system in sync.** Whenever you change CSS, layout, component structure, colours, typography, or spacing, check whether the design system page needs updating. If it does, update it in the same commit.

### Roadmap & Task Tracking

13. **ROADMAP.md is the source of truth** for planned work. Read it before every task.
14. **Update ROADMAP.md as you work.** When you begin a task, mark it 🟡 (in progress). Do **not** mark tasks ~~complete~~ until the user has reviewed and approved the work.
15. **Add discovered work to the Backlog.** If you find bugs, tech debt, or ideas during development, add them to the Backlog section of ROADMAP.md rather than acting on them immediately.

### Git & Deployment

16. **Commit after every completed task.** Write clear, descriptive commit messages. One logical change per commit. Committing is free — **pushing is not.** See rule 16a.

16a. **Never `git push` without asking Wil first — pushing costs money.** Deploys run through Netlify, which bills by credits, so every push spends real money. Treat pushing as a separate decision Wil makes explicitly, every time; approving a commit is not approving a push. Committing directly to `main` is fine when he asks for it — a branch is optional.

17. **Never commit secrets, API keys, or environment-specific config.** Use `.env` files, config templates, and `.gitignore`. This project uses `NOTION_TOKEN` and `CLIP_SHARED_SECRET` — both are secrets and belong in Netlify environment variables, never in the repo.

---

## Data Formats

### The MCP connector ← **this is how the real caller reaches the service**

`POST /mcp?token=<CLIP_SHARED_SECRET>` speaking JSON-RPC. Two tools:

- `clip_article(page_id, url, force?)` — validates, verifies the page's parent, dispatches. **Returns on dispatch, not on completion.**
- `clip_status(page_id)` — reads the page and reports `CLIPPED` / `STILL RUNNING` / `CLIP FAILED` / `NOTHING CLIPPED`.

**Four rules, learned from the spike and binding on any change to `mcp.ts`:**

1. **Every user-facing failure is a tool result with `isError`, never a JSON-RPC error.** Protocol errors are for malformed calls only.
2. **Nothing may throw out of a tool handler.** A `-32603` is replaced en route with a generic *"the server isn't responding, you can try again"* — wrong for a paywall, and it invites an endless retry against a deterministic failure.
3. **Failure prose must be unmistakable in the words themselves.** `isError` does *not* reach the model as a machine-readable field; only the harness's wrapper and our text arrive. Hence the leading `CLIP FAILED —` markers. Never phrase a failure like an acceptance.
4. **Dispatch is not a write.** `clip_article` succeeding means the work *started*. Anything stronger invites the caller to report a clip that never happened — the confidently-wrong-answer failure arriving through the success path. That is what `clip_status` exists for.

The connector URL carries the secret, so it stays out of pasted project prompts. Rotating it means updating Netlify, redeploying, **and** the connector URL.

### HTTP request (testing)

`POST /.netlify/functions/clip` — kept for terminal use and testing

```
X-Clip-Secret: <CLIP_SHARED_SECRET>
Content-Type: application/json
```

```json
{
  "page_id": "2f1b8c4e-...",
  "url": "https://example.com/article",
  "force": false
}
```

- `page_id` — required. Notion page id, with or without dashes. Must already exist and live in the Resources data source.
- `url` — required. Absolute `http(s)` URL of the article.
- `force` — optional, default `false`. Delete the previous clip on this page and clip it again. See Idempotency.

**This contract is described in a Claude project prompt** — see `CALLER-PROMPT.md`. Keep it simple and keep it stable: every change here means the caller's prompt has to change too, and a prompt pasted into a Claude project doesn't update itself. Additions must be optional and backwards-compatible, and **any change to this section means updating `CALLER-PROMPT.md` in the same commit.**

### Response

`/clip` is synchronous and its status codes mean what they say:

| Status | Meaning |
|---|---|
| `202` | Validated and dispatched. Body carries `clip_id`. |
| `400` | Malformed body, bad page id, or a URL that isn't public http(s) |
| `401` | Bad or missing `X-Clip-Secret` |
| `403` | Page is not in the Resources data source |
| `405` | Not a POST |
| `500` | Service misconfigured (missing env vars) |
| `502` | Notion unreachable, or the background function didn't start |

**Why there are two functions.** The caller is a Claude session. A background function always answers `202` — Netlify responds before the handler runs and discards its return value — so a stale secret or a bad page id would come back as success, the session would report a clip that never happened, and the page would sit empty. That is the same failure shape as a truncated article or a hotlinked image: confidently delivered, wrong, invisible.

So everything cheap and certain is checked synchronously in `/clip`, where the status code still means something. Only then is the work handed to `/clip-background`, which has 15 minutes and cannot report back.

⚠️ `/clip-background` is publicly reachable in its own right, so it **repeats every check** rather than trusting its caller. It still always answers `202`. **Do not "fix" that by making it return error codes — they go nowhere.** Add checks to `/clip` instead.

### Outcome reporting

The caller sees the result **in the page itself**, because the HTTP response can't carry it:

1. First write is a `⏳ Clipping in progress…` callout.
2. On success it is deleted, and the article — led by a header block giving title, publication, author, date, and a link to the original — is what remains.
3. On failure it is updated in place into an error callout saying what went wrong in plain language and what to do about it. Partial content stays; nothing is auto-deleted.

Every run also emits structured JSON to the Netlify function log, keyed by `clip_id`.

### Error classes

Distinguished because the user's next action differs for each. Defined in `src/errors.ts`.

| Class | Meaning | Retry? |
|---|---|---|
| `FETCH_FAILED` | Source unreachable, timed out, non-2xx | Transient — yes |
| `BLOCKED` | Paywall, login wall, or bot-block suspected | No — out of scope by design |
| `NOT_EXTRACTABLE` | Fetched fine, no readable article found | No |
| `NOTION_FAILED` | Notion API rejected a write | Depends on status |
| `INVALID_TARGET` | Page missing, or not in the Resources data source | No |

**Only transient classes may throw out of the handler.** Everything else records to the page and returns normally, so Netlify does not retry it. And once article content has begun appending, *nothing* may throw — a transient failure mid-append would be retried on top of the partial content.

### Idempotency

The clip header — a paragraph containing a link to the source URL — is the idempotency key. It is written **in the same append call as the first article content**, so a run that dies mid-append still leaves the key behind for the retry to find.

Before writing anything, list the page's existing children:

- A paragraph already links to this URL → already clipped. Stop, log, do nothing. This is the Netlify-retry case.
- In-progress callout present → an earlier invocation may still be running (it has up to 15 minutes). Stop.

A run that fails partway leaves its partial content and an error callout in place rather than half-cleaning up.

### Recovery: the `force` flag

`force: true` deletes the previous clip and runs again. **The automatic path still never deletes anything** — that rule is about the service not destroying content on its own initiative, and a caller asking for a redo is an instruction, not initiative.

Scope is the clip, not the page. Because the service only ever appends, a clip is the run of blocks from its header to the end of the page; anything **above** the header belongs to whoever set the page up and is never touched. Stale progress and error callouts are swept too, wherever they sit.

Known trade-off: notes added *below* a clip fall inside that range and go with it. Bounding it exactly would need a footer marker block on every clip — a permanent visible artifact solving a problem that hasn't happened. In the backlog.

---

## Deployment

**Platform:** Netlify. `main` auto-deploys.

⚠️ **Pushing costs money** (Netlify bills by credit and every push deploys). See rule 16a — never push without asking Wil, every time.

- **Publish directory:** `public/` — a placeholder 404 page. This is an API, not a site.
- **Build command:** none currently. Netlify's esbuild bundler compiles the TypeScript functions.
- **Functions directory:** `netlify/functions/`.
- **Local dev:** `netlify dev`, with a `.env` copied from `.env.example`.

### Environment variables

Set in the Netlify UI (Site configuration → Environment variables). Never in the repo.

| Variable | Required | Notes |
|---|---|---|
| `NOTION_TOKEN` | yes | Internal integration token. The integration must be shared with the Resources database. **Secret.** |
| `CLIP_SHARED_SECRET` | yes | Endpoint authentication. **Secret.** |
| `RESOURCES_DATA_SOURCE_ID` | no | Defaults to `<your-data-source-id>` |
| `NOTION_API_VERSION` | no | Defaults to the current pinned version (`2026-03-11` at time of writing) |

### Post-deploy check

Hit `/.netlify/functions/health` — it reports whether required env vars are present and which Notion API version is pinned, without echoing any secret values.

---

## Design System

⚠️ **No design system page has been set up yet, and this project probably doesn't need one** — it's a headless API with no UI beyond a static 404 page. If UI work is ever added (a status dashboard, a manual trigger form), stop and ask about setting one up first.

---
Version v1.2
https://wilarndt.com/resources/claude-bootstrap-prompt/
© 2026 Wil Arndt
