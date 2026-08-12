# clip2notion

Fetches a web article and writes its full content — structure intact, images stored inside Notion — into an existing Notion page.

Built to replace the Notion Web Clipper browser extension for open-web articles. A Claude session creates the page in the **WDB | Resources** database and sets every property; this service fills in the body.

**Status:** MVP built, not yet deployed or run against Notion. See [ROADMAP.md](ROADMAP.md).

---

## How it's used

A caller `POST`s a page id and a URL with a shared secret in a header. The request is validated synchronously — bad secret, bad page id, or a page outside the Resources database come back as real error codes — then the work runs in the background, reporting its outcome by writing into the page itself: a progress callout while it runs, an error callout if it fails.

```bash
curl -X POST https://<site>.netlify.app/.netlify/functions/clip \
  -H "X-Clip-Secret: $CLIP_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"page_id": "<notion-page-id>", "url": "https://example.com/article"}'
```

`202` means accepted, not finished — re-fetch the page to see the result. Add `"force": true` to delete an existing clip and run it again.

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

Secrets live in Netlify environment variables and in a local `.env`. Never in the repo.

---

## File Structure

Proposed structure — parts don't exist yet. Full annotated version in [CLAUDE.md](CLAUDE.md).

```
/
├── CLAUDE.md               # Claude Code instructions
├── ROADMAP.md              # Feature roadmap and task backlog
├── README.md               # This file
├── netlify.toml            # Netlify config
├── public/                 # Static publish dir (404 page only)
├── netlify/functions/
│   ├── clip.ts             # The caller's endpoint — validates, returns real status codes
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
- Two functions: `clip` validates synchronously and returns real status codes, then dispatches to `clip-background` (the `-background` suffix gives it 15 minutes, at the cost of always answering `202`)

⚠️ Netlify bills by credit and every push deploys, so pushing costs money. Pushes are an explicit decision each time, never automatic.
