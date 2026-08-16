# clip2notion

[![tests](https://github.com/warndt/clip2notion/actions/workflows/test.yml/badge.svg)](https://github.com/warndt/clip2notion/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Fetches a web article and writes its full content — structure intact, images stored inside Notion rather than hotlinked — into a Notion page that already exists.

It is a small, deliberately narrow service: roughly 2,000 lines, two dependencies, one job.

**Status:** deployed and in daily use.

---

## The problem this solves

I wanted a Claude session to file articles into my Notion reading database: create the page, set the status, the areas, the tags, the relations, the dates — and then put the article itself on the page.

Claude is genuinely good at the first part. It fails at the second, in two separate ways that took a while to untangle.

**An assistant cannot hand you someone else's article.** Asking a model to reproduce the full text of a copyrighted piece is a dead end, and correctly so. What you get instead is a summary, a paraphrase, or a partial quotation — and *that is not a clip*. A clip is the article. A paraphrase of the article is a different artifact that happens to be about the same subject, and six months later, when you open the page expecting the source, you find a Claude-flavoured retelling of it.

**Even setting that aside, the output is malformed.** Reconstructed article content loses the things that make an archive worth keeping: heading structure flattens, tables become prose, footnotes vanish or turn into orphaned digits, code blocks lose their language, and images — if they survive at all — end up as hotlinks to the origin server, which rot the moment the source site redesigns.

The Notion Web Clipper browser extension gets all of that right. But it is a browser extension: it needs a human, a browser, and a click, which is exactly what an automated filing workflow does not have.

## What this does instead

It splits the job along the line where the two halves actually differ.

**Claude decides. The service moves bytes.**

Claude — which knows what the article is about, which project it belongs to, and how you file things — creates the page and sets every property. Then it hands this service a `page_id` and a `url`, and the service does the mechanical part: fetch the HTML, run [Readability](https://github.com/mozilla/readability) over it, walk the DOM, and convert it into Notion blocks.

No model ever handles the article text. Nothing is reproduced from memory, summarised, or rewritten — the bytes go from the origin server into Notion the same way the browser extension moves them, and the same way an RSS reader or a read-later app does. The copyright question doesn't arise, because nothing is being authored. It's a fetch-and-transform pipeline with a Notion-shaped output.

That split is also why the service needs no changes when your database schema changes. It never touches properties.

**Images are stored in Notion, not linked.** Every image is uploaded through Notion's file-import API so the clip survives the source site changing or disappearing. An image that genuinely can't be imported degrades to an external reference and the degradation is logged — it never silently vanishes.

---

## How it works

```
Claude session (claude.ai)
        │
        │  MCP connector over HTTPS
        ▼
    mcp.ts ──────────── validates, checks the page's parent,
        │               answers in ~1s. Dispatch, not completion.
        │
        ▼
 clip-background.ts ─── up to 15 minutes
        │
        ├── fetch + Readability + paywall/bot-block detection
        ├── DOM → Notion blocks (tables, code, footnotes, lead image)
        ├── upload every image into Notion
        └── append to the page in batches of 100
```

The caller sees the result **in the page itself**, because the HTTP response can't carry it: a `⏳ Clipping in progress…` callout goes down first, and is either deleted on success or rewritten in place into a plain-language error.

Two tools are exposed:

- `clip_article(page_id, url, force?)` — starts the clip. **Returns on dispatch, not on completion.**
- `clip_status(page_id)` — reports `CLIPPED` / `IN_PROGRESS` / `FAILED` / `NOT_STARTED` / `FOREIGN_CONTENT`

The full contract, including the rules that stop a caller reporting a clip that never happened, is in [TOOL-BRIEF.md](TOOL-BRIEF.md).

### What it deliberately does not do

- Create pages, set properties, or categorise anything — that's the caller's job
- Log into anything. Paywalled and login-walled articles fail visibly and tell you to use the Web Clipper
- Render JavaScript. If the article only exists after a client-side render, this won't see it
- Rewrite, summarise, or otherwise touch the article's words

---

## Running your own

### You will need

- A Notion account, and a database to clip into
- A [Netlify](https://netlify.com) account (the free tier is enough for personal use)
- Node 20+ (production runs 22)

### 1. Create a Notion integration

At [notion.so/my-integrations](https://www.notion.so/my-integrations), create an internal integration and copy its token. Then open your target database in Notion and share it with that integration — `••• → Connections → your integration`. Without this step every call returns 404, because the integration cannot see pages it hasn't been given.

### 2. Find your data source id

Current Notion API versions distinguish a **database** from the **data sources** inside it, and this service wants the data source id. The quickest way:

```bash
curl -s https://api.notion.com/v1/databases/<DATABASE_ID> \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" | jq '.data_sources'
```

Your `<DATABASE_ID>` is the 32-hex string in the database URL. If you pass a database id where a data source id is wanted, the parent check fails on every page and every clip reports "that page isn't in the database" — a confusing failure with a one-line cause.

### 3. Deploy

```bash
git clone https://github.com/warndt/clip2notion.git
cd clip2notion
npm install
npm test          # no network or Notion access required
netlify deploy    # or connect the repo in the Netlify UI
```

Then set four environment variables in **Site configuration → Environment variables**:

| Variable | Required | Notes |
|---|---|---|
| `NOTION_TOKEN` | yes | Integration token from step 1. **Secret.** |
| `CLIP_SHARED_SECRET` | yes | Generate one: `openssl rand -hex 32`. **Secret.** |
| `RESOURCES_DATA_SOURCE_ID` | yes | From step 2. No default — see [Security](#security). |
| `NOTION_API_VERSION` | no | Defaults to the pinned version. Re-check the live docs; this moves. |
| `LEAD_IMAGE_MODE` | no | `insert` (default) · `detect` (logs what it would insert, writes nothing) · `off` |

⚠️ A Netlify environment change does **not** reach live functions until you redeploy.

Check it worked: `GET /.netlify/functions/health` reports which deploy is answering and whether each variable is present, without echoing any value. It returns `503` if a required one is missing.

### 4. Connect Claude

Add an MCP connector pointing at:

```
https://<your-site>.netlify.app/mcp/<CLIP_SHARED_SECRET>
```

The secret travels as a **path segment**, not a query string — `?token=` is accepted by the server but query strings are stripped somewhere in claude.ai's connector plumbing, and the connector attaches with no tools rather than failing loudly.

The connector is only half of it. The calling session also needs a system prompt telling it to create the page first, call `clip_article`, and confirm with `clip_status` before reporting anything. [TOOL-BRIEF.md](TOOL-BRIEF.md) is written to be pasted into a Notion page the session can read, and summarised into the prompt.

### 5. Test it from a terminal first

```bash
curl -X POST https://<your-site>.netlify.app/.netlify/functions/clip \
  -H "X-Clip-Secret: $CLIP_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"page_id":"<a page in your database>","url":"https://example.com/article"}'
```

This endpoint exists for exactly this: it validates synchronously and returns a real status code, so a bad secret is a `401` rather than a silent nothing.

---

## Adapting it

The service is opinionated about *mechanism* and almost entirely unopinionated about *your setup*. What you're likely to want to change:

**A different database, or a different schema.** Nothing to change. The service sets no properties and reads no schema — it appends blocks to a page id you give it, after checking that page lives in the data source you configured. Rename your columns freely.

**Somewhere other than Netlify.** The platform-specific parts are contained: `netlify/functions/` holds the three entry points and `netlify.toml` the routing. Everything in `src/` is plain TypeScript with no platform imports, by rule. The one thing you would need to replace is the background-function mechanism — the split exists because Netlify kills synchronous functions at 10 seconds, and a long article with images takes minutes. Any platform with a queue or a longer-lived worker will do.

**Not Claude.** The MCP connector in `mcp.ts` is one entry point among three. `clip.ts` is an ordinary authenticated HTTP endpoint and works from anything that can POST — a shortcut, a bookmarklet backend, a cron job over a list of URLs.

**Tuning the conversion.** Every threshold lives in `TUNABLES` in [src/config.ts](src/config.ts) and every one is overridable by an environment variable of the same name, so you can adjust a bad default from the Netlify UI without a deploy. The ones people actually reach for: `MIN_ARTICLE_CHARS`, `LEAD_IMAGE_MIN_DIMENSION`, `MAX_IMAGES`, `LEAD_IMAGE_MODE`.

**Sites that extract badly.** `extract.ts` cleans the DOM before Readability sees it — there are already targeted fixes for Substack's heading widgets and for footnote bodies that Readability discards. That function is the place to add your own.

Before changing anything, read [CLAUDE.md](CLAUDE.md). It documents the constraints that fail *silently in production rather than loudly in testing* — the 10-second ceiling and what blows through it, why jsdom must stay out of the synchronous functions, Notion's 2,000-character rich-text cap, and why a background function must almost never throw.

---

## Security

The threat model is small on purpose: one user, one shared secret, a service that fetches arbitrary URLs on request.

- **The shared secret is compared in constant time**, on every entry point, hashed first so length doesn't leak.
- **Every write target's parent is checked** against `RESOURCES_DATA_SOURCE_ID` before anything is appended. This is the check that makes a leaked secret survivable: it can't be used to append to arbitrary pages in your workspace. That variable is required and has no default, deliberately — a default here would be one specific person's database.
- **SSRF guard on the fetch target**: `http`/`https` only, and loopback, private, link-local, CGNAT, multicast and reserved ranges are refused, including their IPv4-mapped IPv6 forms. Re-checked on **every redirect hop**, not just the URL you passed in.
- ⚠️ **The guard does not resolve DNS.** A hostname that resolves to a private address still gets through. This is a known, documented limit rather than an oversight — closing it needs resolution plus a connect-time socket check, redone per redirect to defeat rebinding. If you deploy this somewhere with a reachable metadata service, close it.
- ⚠️ **There is no rate limiting.** The secret is the only thing between the internet and the endpoints.
- ⚠️ **The secret is in the connector URL**, so it can appear in intermediary logs. The service redacts it from its own. Rotating it means updating Netlify, redeploying, *and* the connector URL.

Found something? See [SECURITY.md](SECURITY.md). Please don't open a public issue for a vulnerability.

---

## Project documentation

| File | What it's for |
|---|---|
| [CLAUDE.md](CLAUDE.md) | The constraints, in detail. Read before changing anything |
| [TOOL-BRIEF.md](TOOL-BRIEF.md) | The caller-facing contract — tools, status tokens, troubleshooting |
| [ROADMAP.md](ROADMAP.md) | What shipped, what's left, and a backlog of real failures with their root causes |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Why pull requests aren't accepted, and what to do instead |

`ROADMAP.md` is worth a look even if you never run this: it records the failures that made it, most of which were invisible from the service's side — images that imported as 1×1 spacers, headings silently scored as boilerplate, a status endpoint that confidently reported a clip that never happened.

---

## Contributing

This is a personal tool published in case it's useful. **Pull requests are not accepted** — see [CONTRIBUTING.md](CONTRIBUTING.md) for the reasoning and for what to do instead. Issues and ideas are welcome, and forking is actively encouraged.

## License

[MIT](LICENSE). Do what you like with it.
