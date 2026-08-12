# clip2notion

Fetches a web article and writes its full content — structure intact, images stored inside Notion — into an existing Notion page.

Built to replace the Notion Web Clipper browser extension for open-web articles. A Claude session creates the page in the **WDB | Resources** database and sets every property; this service fills in the body.

**Status:** bootstrapping. Nothing is built yet — see [ROADMAP.md](ROADMAP.md).

---

## How it's used

A caller `POST`s a page id and a URL with a shared secret in a header. The service returns `202` immediately and does the work in the background, reporting its outcome by writing into the page itself — a progress callout while it runs, an error callout if it fails.

```bash
curl -X POST https://<site>.netlify.app/.netlify/functions/clip-background \
  -H "X-Clip-Secret: $CLIP_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"page_id": "<notion-page-id>", "url": "https://example.com/article"}'
```

What it deliberately does **not** do: create pages, set properties, categorise, log into paywalled sites, or rewrite article content.

---

## Setup

> Placeholder steps — these firm up as the project is built (see M0 in the roadmap).

1. `npm install`
2. Copy `.env.example` to `.env` and fill in the values (see below)
3. `netlify dev`
4. Check `http://localhost:8888/.netlify/functions/health`

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
├── netlify/functions/      # Entry points — thin: auth, validate, hand off
├── src/
│   ├── http/               # Auth, validation, SSRF protection
│   ├── fetch/              # Source HTML retrieval
│   ├── extract/            # Readable article + image URL resolution
│   ├── convert/            # HTML → Notion blocks
│   └── notion/             # API client, guards, appends, file uploads
├── spikes/                 # Standalone prototypes, never imported by src/
└── tests/fixtures/         # Saved HTML from real articles
```

---

## Deployment

Netlify. `main` auto-deploys.

- Publish directory: `public/`
- Functions: `netlify/functions/`, bundled by esbuild — no separate build step
- Runs as a **background function** (`-background` suffix): up to 15 minutes, returns `202` immediately

⚠️ Netlify bills by credit and every push deploys, so pushing costs money. Pushes are an explicit decision each time, never automatic.
