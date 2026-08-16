# Never start a Claude Code project from scratch

# clip2notion — Claude Code Instructions

## Read this first

Before you make **any** change to this code:

1. Read all of `ROADMAP.md`. Make sure that your change does not conflict with planned work and does not make planned work more difficult. If there is a conflict, report it and ask before you continue.
2. Look at the design system page, if one exists, for the approved patterns, components, and design values. This service has no user interface, so a design system page probably does not exist. Refer to the Design System section.
3. Read the **Limits** section below before you write code that touches Notion, the fetch layer, or a function entry point. Most of those limits cause a failure in production with no visible sign. They do not cause a failure in a test.

---

## What this service is

**clip2notion** writes the full readable content of a web article into a Notion page that already exists. It replaces the Notion Web Clipper browser extension for open-web articles.

This is the full workflow. A Claude project session creates a page in the **WDB | Resources** Notion database. The session sets each property (status, areas, tags, dates, relations) with the Notion MCP. Claude cannot write the body of an article, so it gives this service a `page_id` and a `url`. The service then writes the article to the page. It keeps the structure. It stores the images in Notion and does not link to them on the source website, so the clip continues to operate if the source website changes or stops to operate.

The service has a small scope on purpose. It does not create pages, set properties, or select a category. The caller does these. Therefore you do not change this service when the schema of the database changes. The service does not log in to a source website. Content behind a paywall is out of scope and must fail with a visible message.

The service operates as a Netlify function. A Claude session calls it over HTTPS with a shared secret.

---

## File structure

<!-- Keep this current when you add or move a file. -->

```
/
├── CLAUDE.md                       # This file — Claude Code instructions
├── ROADMAP.md                      # The roadmap and the backlog (the primary reference)
├── README.md                       # Overview, installation, and use
├── TOOL-BRIEF.md                   # Reference for the calling Claude session and for the
│                                   #   person who writes its system prompt. There is a copy
│                                   #   in Notion. Change both when the contract changes.
├── netlify.toml                    # Netlify configuration: publish directory, functions,
│                                   #   redirects, headers
├── package.json                    # Dependencies and scripts
├── tsconfig.json                   # TypeScript configuration
├── .env.example                    # The necessary environment variables, with no values
├── .gitignore
│
├── public/                         # Static publish directory. This is an API, not a website.
│   └── 404.html
│
├── netlify/
│   └── functions/
│       ├── mcp.ts                  # ← The real caller uses this file.
│       │                           #   MCP connector: clip_article and clip_status
│       ├── clip.ts                 # HTTP endpoint. Checks the request and gives a response
│       │                           #   code. Use it from a terminal for tests.
│       ├── clip-background.ts      # The worker. 15 minutes. Always answers 202.
│       └── health.ts               # Which version operates and how it is configured.
│                                   #   It gives no secret values.
│
├── src/
│   │   # --- light: no jsdom. A synchronous function can import these. ---
│   ├── config.ts                   # Environment variables and each adjustable value
│   ├── errors.ts                   # The ClipError classes — refer to Data Formats
│   ├── log.ts                      # JSON log messages, with a clip_id in each message
│   ├── markers.ts                  # Text markers that the service writes and then reads
│   ├── request.ts                  # Authentication and request parsing, for each entry point
│   ├── url.ts                      # The SSRF check of the target URL
│   ├── notion.ts                   # API client, parent check, write, file upload
│   ├── status.ts                   # Reads the state of a clip and when the clip operated
│   │   # --- heavy: imports jsdom. Background function only. ---
│   ├── extract.ts                  # Reads the URL, uses Readability, detects a paywall
│   │                               #   or a bot-block
│   ├── lead-image.ts               # The main image outside the body of the article
│   ├── blocks.ts                   # DOM → Notion blocks, rich text, tables, images
│   └── pipeline.ts                 # Sequence: duplicate check, status, image import, write
│
└── tests/
    └── *.test.ts                   # Covers the five failures that have no visible sign
```

**Rules for this structure**

- One file for each stage of the pipeline. **Divide a file when the file is difficult to work in, and not before.** This is a small service. An earlier plan with five directories was removed on purpose.
- Keep `netlify/functions/clip-background.ts` small: authenticate, check the request, then call `src/pipeline.ts`. All logic is in `src/`, so you can test it without Netlify.
- No file in `src/` imports a file from `netlify/`.
- Each real article that causes a failure becomes a test.

---

## Limits

These limits control each implementation. Some of them cause a failure in production with no visible sign, and not in a test. This is the reason that they are written here.

### Netlify

- A synchronous function stops after **10 seconds**. On the Pro plan you can request 26 seconds. A background function (a filename that ends with `-background`) operates for a maximum of **15 minutes**. But it answers `202` immediately and cannot give a result in the HTTP response.
- ⚠️ **Keep jsdom out of the synchronous functions.** `src/` has two halves. The light half is `config`, `errors`, `log`, `markers`, `request`, `url`, `notion`, and `status`. The heavy half imports jsdom and Readability: `extract`, `blocks`, and `pipeline`. `mcp.ts` and `clip.ts` must import only from the light half. Measured: with only the light half, `mcp` is approximately **44KB**. If it imports the converter, it is **6.5MB**. That difference is some seconds of container start, against a 10-second limit that includes the container start. `status.ts` and `url.ts` exist for this reason. Do not move them back into `pipeline.ts` and `extract.ts`. To check the size, use `npx esbuild netlify/functions/mcp.ts --bundle --platform=node --outfile=/tmp/x.js`.
- ⚠️ **The limit that applies is the patience of the MCP client, not the 10 seconds from Netlify.** Measured on 2026-08-14: each request that arrived at the function returned successfully, and the slowest took 5.4 seconds. But the caller still reported "the connector's server isn't responding" for calls of that length. Those failures never arrived at the function. claude.ai stops waiting before Netlify does. Therefore the wait budgets use approximately **3 seconds** and not 10. A response that **completes** is not the same as a response that **arrives**.
- ⚠️ **`mcp.ts` is synchronous, so the 10-second limit applies to it.** It waits a short time for a clip to reach a final state. Those budgets are in `TUNABLES.syncFunctionBudgetMs`. If a function exceeds the limit, the result is not a partial success: Netlify stops the function, and the caller sees "the connector's server isn't responding". The caller cannot tell this from a service that does not operate at all. This occurred one time, with budgets of 20 seconds. Each wait loop measures from `enteredAt`, which is the time that the request arrived. Keep this method when you add another loop.
- **Netlify calls a failed background function again after 1 minute, and again after 2 more minutes.** If a run fails after it writes part of the content, the retry writes that content again. This is the most important failure in the project.
- Therefore: **throw an error from the background handler only for a temporary failure.** A permanent failure (a paywall, content that the service cannot extract, an incorrect page id) must go into the page and into the log. The handler must then return a success to Netlify. If it does not, Netlify calls the function two more times for no purpose.

### Notion API

- `NOTION_API_VERSION` sets the API version header. The value at the time of writing is **`2026-03-11`**. Read the current Notion documentation before you use this value. Notion changes it.
- **A rich-text object has a limit of 2,000 characters.** Divide a long paragraph into more than one rich-text object in the same block. Do not remove text.
- **You can write a maximum of 100 child blocks in one call.** A long article needs more than one call.
- Notion limits the depth of block nesting. Make a deeply nested list less deep. Do not remove it and do not fail.
- The rate limit is approximately **3 requests each second**. If you receive `429`, wait for the time in `Retry-After`.
- **To store an image, use file import:** `POST /v1/file_uploads` with `mode: "external_url"`. Notion reads the file itself, asynchronously. Poll `GET /v1/file_uploads/{id}` until `status` is not `pending` (it becomes `uploaded` or `failed`). Only then attach the file to a block. If it fails, read `file_import_result` for the cause.
- Notion refuses the import if the URL does not use SSL, if the URL is not publicly available, if there is no `Content-Type` header, if the file is larger than the workspace limit, or if there is no valid filename and supported MIME type. **Real articles cause each of these conditions.** If the service cannot import an image, it uses an external link and writes a log message. It never removes the image.
- Current API versions have separate databases and data sources. `RESOURCES_DATA_SOURCE_ID` is a **data source** id. The check of the page parent must compare it with the correct field.

### Real-world HTML

- **An image URL in extracted content is frequently relative.** Resolve each image URL and link URL against the final URL of the article, after each redirect.
- **A lazy-loaded image has a placeholder in `src`.** The real image is in `data-src`, `data-srcset`, or `srcset`. Simple extraction imports 1×1 spacer images and tracking pixels, and the result looks correct in a code review. Use the largest candidate from `srcset` or `data-srcset` first, then `data-src`, then `src`.

### Security

- Compare the shared secret in **constant time**. Never use `===`.
- **Always make sure that the parent of the target page is the Resources data source before you write.** If a person gets the secret, that person must not be able to write to other pages in the workspace.
- SSRF check of the target URL: the `http` and `https` schemes only. Refuse localhost and each private, link-local, loopback, carrier-grade NAT, multicast, and reserved address. Also refuse the **IPv4-mapped IPv6 form** of these addresses. That form passed the check until 2026-08-16. Do this check again **after each redirect** and not only for the first URL.
- ⚠️ **The check does not resolve DNS.** Therefore a host name that resolves to a private address passes the check. This is a limit that the project accepts and documents. To close it, you must resolve the name and then check the socket at connect time, and do this again after each redirect to prevent a DNS rebinding attack. If you install this service where a metadata service is available, close it.

---

## Rules

### Scope and method

1. **Stay in scope.** Make only the changes for the current task. If you find a different problem, write it in the Backlog section of `ROADMAP.md`. Do not correct it.
2. **Understand the task before you build.** Before you build something new, understand the purpose of the service and the code that exists. Ask a question if the intention is not clear.
3. **Build modules.** Design each component, module, and data structure to be reusable and independent. Use small files with one purpose. Do not use large files.
4. **Do not do an unexpected refactor.** Never delete or restructure code that operates without a question first. If you think that the code needs a new structure, give the reason and wait for approval.

### Development method

5. **Build in small steps that you can test.** After each change, the service must operate. Divide a large feature into parts. Test each part before you continue.
6. **Build a prototype for a difficult feature.** If a feature uses an unfamiliar API, a complex integration, or an uncertain method, build a small independent prototype first. Make sure that it operates and learn how it fails. Then put it into the service. Tell Wil when you think that a feature needs a prototype.
7. **Think about the next task.** Before you write code, think about the position of this task in the roadmap. Select data structures, field names, and patterns that a later feature will not change. If a planned feature defines a field name or a pattern, use it.

### Code and file rules

8. **Keep each file small.** If a file becomes large, divide it into modules with one purpose. Use clear filenames.
9. **Do not put CSS or JavaScript in an HTML file**, unless the project needs this. Put styles and logic in their own files. Exception: JSON-LD `<script type="application/ld+json">` blocks and analytics code belong in the HTML.
10. **Design for a mobile device first.** Each user interface must be responsive, and a mobile device is the primary target. Test the mobile behaviour for each interface change.

### Design system

11. **Look at the design system first.** Before you make a new interface component or style, look at the design system page for a pattern that exists. If there is no design system page, report this and ask if the project needs one.
12. **Keep the design system current.** When you change CSS, layout, component structure, colours, typography, or spacing, check if the design system page needs a change. If it does, change it in the same commit.

### Roadmap and tasks

13. **`ROADMAP.md` is the primary reference** for planned work. Read it before each task.
14. **Change `ROADMAP.md` while you work.** When you start a task, mark it 🟡 (in work). Do **not** mark a task complete until Wil reviews and approves the work.
15. **Write new work in the Backlog.** If you find a bug, technical debt, or an idea during development, write it in the Backlog section of `ROADMAP.md`. Do not correct it immediately.

### Git and deployment

16. **Commit after each complete task.** Write a clear commit message. One logical change in each commit. A commit is free. **A push is not free.** Refer to rule 16a.

16a. **Never use `git push` before you ask Wil. A push costs money.** Netlify does the deploys and charges by credit, so each push spends money. A push is a separate decision that Wil makes each time. Approval of a commit is not approval of a push. A commit directly to `main` is acceptable when Wil asks for it. A branch is optional.

17. **Never commit a secret, an API key, or configuration for one environment.** Use `.env` files, configuration templates, and `.gitignore`. This project uses `NOTION_TOKEN` and `CLIP_SHARED_SECRET`. Both are secrets. They belong in the Netlify environment variables and never in the repository.

---

## Data formats

### The MCP connector ← **the real caller uses this**

`POST /mcp/<CLIP_SHARED_SECRET>` with JSON-RPC. The token is a path segment. A query string does not arrive through claude.ai.

Two tools:

- `clip_article(page_id, url, force?)` checks the request, checks the parent of the page, and starts the work. **It answers when the work starts, not when the work is complete.**
- `clip_status(page_id)` reads the page and gives one of these states: `CLIPPED`, `IN_PROGRESS`, `FAILED`, `NOT_STARTED`, or `FOREIGN_CONTENT`.

**Four rules. They come from the MCP test and apply to each change to `mcp.ts`.**

1. **Send each failure that the user reads as a tool result with `isError`. Never use a JSON-RPC error.** Use protocol errors only for a request with an incorrect format.
2. **Nothing can throw an error out of a tool handler.** The system replaces a `-32603` with a general message: "the server isn't responding, you can try again". That message is not correct for a paywall, and it causes the caller to try again continuously for a permanent failure.
3. **The words of a failure message must show clearly that it is a failure.** `isError` does **not** arrive at the model as a field that a machine can read. Only the wrapper from the harness and our text arrive. This is the reason for the `CLIP FAILED —` marker at the start. Never write a failure message that reads like a success message.
4. **A start is not a write.** A successful `clip_article` means that the work **started**. A stronger message causes the caller to report a clip that did not occur. This is the incorrect-but-confident answer, and it arrives through the success path. `clip_status` exists for this reason.

The URL of the connector contains the secret. Therefore the secret is not in a project prompt that a person copies. To change the secret, you must change the Netlify variable, deploy, **and** change the URL of the connector.

### HTTP request (for tests)

`POST /.netlify/functions/clip`. This endpoint is for terminal use and tests.

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

- `page_id` is necessary. It is a Notion page id, with or without hyphens. The page must exist and must be in the Resources data source.
- `url` is necessary. It is an absolute `http` or `https` URL.
- `force` is optional and the default is `false`. It deletes the previous clip on the page and makes the clip again. Refer to Duplicate prevention.

**`TOOL-BRIEF.md` documents this contract.** There is a copy in a Notion page that the calling session reads, and a summary in the caller's system prompt. Keep the contract simple and stable. The Notion copy does not update itself, and a system prompt does not update itself. Each addition must be optional and must not break an existing caller. **If you change this section, change `TOOL-BRIEF.md` in the same commit.** Also tell Wil that a person must update the Notion copy and the system prompt.

### Response

`/clip` is synchronous. Each status code has an exact meaning.

| Code | Meaning |
|---|---|
| `202` | The request is correct and the work started. The body contains `clip_id`. |
| `400` | The body has an incorrect format, the page id is incorrect, or the URL is not a public `http` or `https` URL |
| `401` | The `X-Clip-Secret` header is incorrect or not present |
| `403` | The page is not in the Resources data source |
| `405` | The request is not a POST |
| `500` | The service configuration is incomplete (an environment variable is not present) |
| `502` | The service cannot reach Notion, or the background function did not start |

**The reason for two functions.** The caller is a Claude session. A background function always answers `202`, because Netlify sends the response before the handler operates and then discards the return value. Therefore an incorrect secret or an incorrect page id would give a success. The session would report a clip that did not occur, and the page would stay empty. This is the same failure as an article with removed text or an image that links to the source website: the service gives an answer with confidence, the answer is incorrect, and nothing shows the problem.

Therefore `/clip` does each check that is fast and certain, because its status code has a meaning. Only then does it start `/clip-background`, which has 15 minutes and cannot give a result.

⚠️ `/clip-background` has a public URL. Therefore it **does each check again** and does not trust the function that called it. It still always answers `202`. **Do not change this to return error codes. Nothing receives them.** Add the check to `/clip`.

### How the service reports the result

The caller reads the result **on the page**, because the HTTP response cannot contain it:

1. The first write is a `⏳ Clipping in progress…` callout.
2. After a success, the service deletes the callout. The article stays. A header block above the article gives the title, the publication, the author, the date, and a link to the original.
3. After a failure, the service changes the callout into an error callout. The message says what failed, in simple language, and what to do. Partial content stays. The service deletes nothing automatically.

Each run also writes JSON messages to the Netlify function log. Each message contains the `clip_id`.

### Error classes

The classes are separate because the next action of the user is different for each one. They are in `src/errors.ts`.

| Class | Meaning | Try again? |
|---|---|---|
| `FETCH_FAILED` | The service cannot reach the source, the request timed out, or the response was not 2xx | Temporary — yes |
| `BLOCKED` | A paywall, a login wall, a bot-block, or a rate limit | No — out of scope by design |
| `NOT_EXTRACTABLE` | The service read the page but found no readable article | No |
| `NOTION_FAILED` | The Notion API refused a write | It depends on the status |
| `INVALID_TARGET` | The page does not exist, or it is not in the Resources data source | No |

`BLOCKED` has four different messages: `paywalled`, `refused`, `botChallenge`, and `rateLimited`. Each message tells the user a different thing. A 403 is not a paywall, and the message must not tell the user to log in.

**Only a temporary class can throw an error out of the handler.** Each other class writes to the page and returns normally, so Netlify does not call the function again. After the service starts to write article content, **nothing** can throw an error. Netlify would call the function again and write on top of the partial content.

### Duplicate prevention

The clip header is a paragraph that contains a link to the source URL. It is the key that prevents a duplicate. The service writes it **in the same call as the first article content**. Therefore a run that stops during the write still leaves the key for the retry to find.

Before the service writes anything, it lists the existing child blocks of the page:

- A paragraph already links to this URL. The page has the clip. Stop, write a log message, and do nothing. This is the Netlify retry.
- An in-progress callout is present. An earlier call can still operate, because it has up to 15 minutes. Stop.

If a run fails during a write, it leaves the partial content and an error callout. It does not delete part of the content.

### Recovery: the `force` flag

`force: true` deletes the previous clip and operates again. **The automatic path still deletes nothing.** That rule prevents the service from destroying content by its own decision. A caller that asks for a new clip gives an instruction, so this is not the same.

The range is the clip and not the page. The service only adds content to the end of a page. Therefore a clip is the group of blocks from its header to the end of the page. Content **above** the header belongs to the person who made the page, and the service never changes it. The service also deletes old progress callouts and error callouts, at any position.

A known result: a note that a person added **below** a clip is inside that range and the service deletes it. An exact range would need a footer marker block on each clip. That is a permanent visible object for a problem that has not occurred. It is in the backlog.

---

## Deployment

**Platform:** Netlify. A commit to `main` deploys automatically.

⚠️ **A push costs money.** Netlify charges by credit and each push deploys. Refer to rule 16a. Never push before you ask Wil, each time.

- **Publish directory:** `public/`, which contains a 404 page. This is an API, not a website.
- **Build command:** none. The Netlify esbuild bundler compiles the TypeScript functions.
- **Functions directory:** `netlify/functions/`.
- **Local development:** `netlify dev`, with a `.env` file copied from `.env.example`.

### Environment variables

Set these in the Netlify interface (Site configuration → Environment variables). Never in the repository.

| Variable | Necessary | Description |
|---|---|---|
| `NOTION_TOKEN` | yes | The internal integration token. Give the integration access to the Resources database. **Secret.** |
| `CLIP_SHARED_SECRET` | yes | Endpoint authentication. **Secret.** |
| `RESOURCES_DATA_SOURCE_ID` | yes | The data source id of the target database. There is no default value. The default was the data source id of the author, and a public repository must not contain it. |
| `NOTION_API_VERSION` | no | The default is the current version (`2026-03-11` at the time of writing) |

### Check after a deploy

Send a request to `/.netlify/functions/health`. It reports the **deployed commit**, if each necessary environment variable is present, and the current settings (the Notion API version and `LEAD_IMAGE_MODE`). It gives no secret values. It returns `200` if the configuration is complete and `503` if a necessary variable is not present.

The commit is the important part. Without it, you must read the build log to answer "is the correction in production?". A change that deploys but does nothing looks the same as a change that never deployed. ⚠️ **The function logs lose entries.** A request that certainly operated was not in the logs. Therefore a log entry that is not present does not show that an event did not occur.

---

## Design system

⚠️ **There is no design system page, and this project probably does not need one.** It is an API with no user interface, except a static 404 page. If a person adds a user interface (a status page or a manual trigger form), stop and ask if the project needs a design system page first.

---
Version v1.2
https://wilarndt.com/resources/claude-bootstrap-prompt/
© 2026 Wil Arndt
