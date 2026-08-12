# Notion clipper service — build spec

A service that fetches a web article and writes its full content into an existing Notion page.

**How to read this spec.** Sections 1–3 are binding: the problem, the requirements, and the platform and API constraints that bound any solution. Section 4 is a suggested approach — a starting point, not a mandate. Evaluate it, and if there's a better way, take it and say why in the PR. Several of the constraints in section 3 are things that fail silently or late in production rather than in testing, which is why they're written down rather than left to discovery.

## 1. The problem

Articles are saved to a Notion database (**WDB | Resources**) using the official Notion Web Clipper browser extension. The clipper captures the article body and images; every property afterwards — status, areas, tags, dates, relations — is set by hand. That manual half is being automated by a Claude project which creates the page and sets all properties via the Notion MCP.

What Claude cannot do is put the article's full text into the page. This service closes that gap. Claude creates and configures the page, then hands this service a page ID and a URL, and the service fills in the body.

Success means the extension is no longer needed for open-web articles.

## 2. Requirements

### Must do

- Accept a Notion page ID and an article URL, and append the article's readable content to that page
- **Store images inside Notion rather than hotlinking them.** This is the point of the exercise — clipped articles must survive the source site changing or disappearing. An image that can't be imported should degrade to an external reference rather than vanish, and the degradation should be logged
- Preserve document structure: headings, paragraphs, inline formatting, links, nested lists, blockquotes, code blocks with language, images with captions, tables
- Preserve article text in full. Never silently truncate
- Report outcome somewhere the caller can see it, including on failure. **A page that looks created-but-empty with no explanation is the worst possible outcome** — it looks like success until someone opens it
- Be safe to retry. The platform retries failed invocations automatically (see 3.1), so a retry must not duplicate content
- Fail cleanly and visibly on paywalled, login-walled, or bot-blocked URLs

### Must not do

- Create pages, set properties, or make categorisation decisions. Those belong to the caller, and keeping them out means this service needs no changes when the database schema changes
- Handle authentication to source sites. Server-side fetches have no session; paywalled content is out of scope
- Summarise, editorialise, or rewrite article content. Structural conversion only

### Security requirements

- Authenticate callers with a shared secret, compared in constant time
- **Verify the target page belongs to the Resources data source before writing to it.** A leaked secret must not allow appending content to arbitrary pages anywhere in the workspace
- Validate inputs, and apply standard SSRF protection on the fetch target — no localhost, no private IP ranges, including via redirect

## 3. Constraints

These are facts about the platform and the API. They bound the solution regardless of approach.

### 3.1 Netlify

- Standard synchronous functions time out at **10 seconds**, raisable to 26s on Pro by request. Background functions (the `-background` filename suffix) run up to **15 minutes** but return `202` immediately and cannot report a result in the response
- **Netlify retries a failed background function after one minute, and again two minutes later.** This is the source of the idempotency requirement — the failure mode is duplicated article content appearing days later, which testing will not catch

Whether the work fits in a synchronous function is worth checking rather than assuming, but note that image import is asynchronous on Notion's side (3.2) and blocks append in batches, so a long illustrated article involves many sequential round trips.

### 3.2 Notion API

- **Rich text is capped at 2000 characters per object**, and **block children append 100 at a time**. Long paragraphs and long articles both need chunking
- Block nesting depth is limited; deeply nested lists need flattening rather than failing
- Rate limit is roughly 3 requests/second averaged. Handle `429` with `Retry-After`
- **File import from an external URL exists and is the mechanism for image permanence.** `POST /v1/file_uploads` with `mode: "external_url"`; Notion fetches the file itself, asynchronously, so the upload must be polled until ready before it can be attached to a block. Verify the current shape of this flow against the live docs — it is recent and moves
- That import is rejected if the URL isn't SSL, isn't publicly reachable, doesn't expose a `Content-Type` header, exceeds the workspace per-file size limit, or lacks a valid filename and supported MIME type. Real articles hit all of these
- The API version header changes. Check the current version at build time rather than copying one from this document

### 3.3 Real-world HTML

Both of these produce broken output that looks fine in code review:

- **Image URLs in extracted content are frequently relative** and must be resolved against the article's base URL
- **Lazy-loaded images put a placeholder in `src`** with the real image in `data-src`, `data-srcset`, or `srcset`. Naive extraction imports 1×1 spacers and tracking pixels

### 3.4 Interface

The caller is a Claude session using the Notion MCP. It creates the page first, then calls this service. Whatever the request and response shape, it needs to be simple enough to describe in a project prompt and stable enough not to change often.

## 4. Suggested approach

**Not binding.** This is one workable design, offered so the requirements are concrete. Override any of it with better judgement.

A Netlify background function taking `POST { page_id, url }` with the secret in a header, returning `202` immediately.

Pipeline: fetch with a browser user-agent and a timeout → extract the article with Mozilla Readability or Defuddle → convert to Notion blocks → import images → append in chunks, prefixed with a small header giving title, publication, author, date, and a link to the original.

For conversion, HTML → Markdown (`turndown`) → blocks (`@tryfabric/martian`) is a known-working path, but a direct HTML-to-blocks converter may handle structure better. Worth a look at what's currently maintained rather than taking these two on faith.

For observability, given that a background function can't return its result: append a `⏳ Clipping in progress…` callout as the first write, delete it on success, and replace it with an error callout describing the failure otherwise. This puts state in the page itself with no extra properties and gives the calling Claude session something to verify by re-fetching. Any equivalent mechanism is fine.

Concurrency, timeouts, and size caps are left open — every number in an earlier draft of this spec was invented. Pick sensible ones and make them configurable.

Error cases worth distinguishing in the message the user sees: fetch failure, content not extractable, paywall or bot-block suspected, and Notion API failure.

## 5. Environment

- `NOTION_TOKEN` — internal integration token with access to the Resources database
- `CLIP_SHARED_SECRET` — endpoint authentication
- `RESOURCES_DATA_SOURCE_ID` — defaults to `<your-data-source-id>`
- Notion API version — configurable, current value checked at build time

## 6. Acceptance criteria

- A long open-web article with 10+ images lands complete, images stored in Notion, formatting intact
- Headings, nested lists, blockquotes, code blocks, and tables all survive
- A paragraph over 2000 characters is preserved in full
- An article with lazy-loaded images imports the real images, not placeholders
- A paywalled URL produces a clear, visible error and no partial garbage
- A retried invocation does not duplicate content
- A wrong secret is rejected and writes nothing
- A `page_id` outside the Resources database is rejected

Test against a long-form magazine piece, a technical post with code blocks, an image-heavy listicle, and a known paywalled article.

## 7. Open questions for the implementer

Flag these rather than deciding silently:

- Whether the work genuinely needs a background function or fits synchronously
- Whether any current library does HTML→Notion blocks well enough to skip the Markdown hop
- Whether there's a better observability mechanism than writing status into the page
