# clip2notion

Fetches a web article and writes its full content — structure intact, images stored inside Notion — into an existing Notion page.

Built to replace the Notion Web Clipper browser extension for open-web articles. A Claude session creates the page in the **WDB | Resources** database and sets every property; this service fills in the body.

**Status:** deployed and in use. See [ROADMAP.md](ROADMAP.md) for what's left, all optional.

---

## How it's used

**Through an MCP connector**, from a Claude session in the claude.ai chat interface. That session creates the Resources page and sets its properties, then calls two tools:

- `clip_article(page_id, url, force?)` — starts the clip
- `clip_status(page_id)` — reports `CLIPPED` / `IN_PROGRESS` / `FAILED` / `NOT_STARTED`

`clip_article` returning successfully means the work *started*, not that it finished, so the caller confirms with `clip_status` before reporting anything. The full contract, the rules that keep a caller from reporting a clip that never happened, and a troubleshooting table are in [TOOL-BRIEF.md](TOOL-BRIEF.md).

The connector URL carries the shared secret as a **path segment** — `/mcp/<secret>`, not `?token=`. The query form is accepted by the server but does not survive the trip through claude.ai.

There is also an HTTP endpoint, `POST /.netlify/functions/clip`, kept for testing from a terminal. The chat session cannot use it: its sandbox refuses non-allowlisted hosts, which is why the connector exists.

What it deliberately does **not** do: create pages, set properties, categorise, log into paywalled sites, or rewrite article content.

---

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in the values (see below)
3. `npm test` — unit tests, no network or Notion access required
4. `npm run typecheck`
5. `netlify dev` to run the function locally

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `NOTION_TOKEN` | yes | Internal integration token, shared with the Resources database. **Secret.** |
| `CLIP_SHARED_SECRET` | yes | Endpoint authentication. **Secret.** |
| `RESOURCES_DATA_SOURCE_ID` | no | Defaults to the WDB \| Resources data source |
| `NOTION_API_VERSION` | no | Defaults to the pinned current version |
| `LEAD_IMAGE_MODE` | no | `insert` (default) · `detect` (logs the hero it would insert, writes nothing) · `off`. Set to `detect` to roll back. |

Secrets live in Netlify environment variables and in a local `.env`. Never in the repo.

---

## File Structure

Proposed structure — parts don't exist yet. Full annotated version in [CLAUDE.md](CLAUDE.md).

```
/
├── CLAUDE.md               # Claude Code instructions
├── ROADMAP.md              # Feature roadmap and task backlog
├── README.md               # This file
├── TOOL-BRIEF.md           # Tool reference for the calling session (mirrored into Notion)
├── netlify.toml            # Netlify config
├── public/                 # Static publish dir (404 page only)
├── netlify/functions/
│   ├── mcp.ts              # The connector — how the real caller reaches the service
│   ├── clip.ts             # HTTP endpoint, kept for testing from a terminal
│   └── clip-background.ts  # The worker — up to 15 minutes, always answers 202
├── src/
│   ├── config.ts           # Env vars and every tunable
│   ├── errors.ts           # Error classes with plain-language messages
│   ├── log.ts              # Structured logging
│   ├── request.ts          # Auth and request parsing, shared by both entry points
│   ├── extract.ts          # Fetch + Readability + paywall detection
│   ├── blocks.ts           # HTML → Notion blocks
│   ├── notion.ts           # Notion API client
│   └── pipeline.ts         # Orchestration
└── tests/                  # Unit tests
```

---

## Deployment

Netlify. `main` auto-deploys.

- Publish directory: `public/`
- Functions: `netlify/functions/`, bundled by esbuild — no separate build step
- Three functions: `mcp` serves the connector, `clip` is the equivalent HTTP endpoint for testing, and both dispatch to `clip-background` (the `-background` suffix gives it 15 minutes, at the cost of always answering `202`)
- ⚠️ `mcp` and `clip` are synchronous, so Netlify kills them at **10 seconds** — including container start. The wait budgets in `TUNABLES` are sized against that; exceeding it looks to the caller like the whole service is down.

⚠️ Netlify bills by credit and every push deploys, so pushing costs money. Pushes are an explicit decision each time, never automatic.
