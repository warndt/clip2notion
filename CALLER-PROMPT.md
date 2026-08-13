# Caller prompt snippet

The caller reaches this service through an **MCP connector**, not HTTP. A Claude session in the claude.ai chat interface cannot POST to `<your-site>.netlify.app` — its sandbox refuses non-allowlisted hosts — but a custom connector is called from Anthropic's infrastructure, which sidesteps that.

## One-time setup

Add the connector at **claude.ai → Settings → Connectors → Add custom connector**:

```
https://<your-site>.netlify.app/mcp?token=<CLIP_SHARED_SECRET>
```

Get the value with `netlify env:get CLIP_SHARED_SECRET` (the plain form — `--context production` returns a mask, not the real value).

The token lives in the connector URL rather than in the prompt below, which means it isn't pasted into project instructions or repeated in chat transcripts. It is visible in your connector settings, and it travels in the URL rather than a header — a deliberate shortcut for a single-user tool. The stronger answer is OAuth, recorded in the ROADMAP backlog.

Rotating the secret means updating **three** places: Netlify, a redeploy (env changes don't reach live functions otherwise), and this connector URL.

## The project prompt

Paste this into the Claude project that creates Resources pages. It is deliberately short — the tools describe themselves, and this only has to enforce the discipline the tool descriptions ask for.

```markdown
## Clipping article text into a Resources page

You have a connector, clip2notion, with two tools: `clip_article` and `clip_status`.

After creating a page in WDB | Resources and setting its properties, call
`clip_article` with the page id and the article URL. You never write article
content yourself — that is what the service is for.

A newly created Resources page has a blank body. Every template in that database
sets properties only and seeds no content, so blank is the expected state, not a
page still loading. Clip into it — do not wait for content to appear.

**`clip_article` starting successfully does NOT mean the article was clipped.**
It means the work began. It runs in the background and can still fail after
that response. Never tell me the article was clipped on the strength of it.

Always confirm with `clip_status` before reporting anything. Match on the first
line of its response:

- **STATUS: CLIPPED** — confirmed on the page. Safe to tell me it worked.
- **STATUS: IN_PROGRESS** — outcome unknown. See the note on waiting below.
- **STATUS: FAILED** — relay the message to me verbatim.
- **STATUS: NOT_STARTED** — the page is empty. Do not report success.

**On IN_PROGRESS, call `clip_status` again yourself.** Both tools wait for the
work before answering, so calling again IS how you wait. Never ask me to say
"check again" — chasing a background job is not my job. Keep calling until you
get CLIPPED or FAILED. A long illustrated article may need two or three calls.
Only after roughly ten calls should you tell me the run appears to have died.

**Never retry on your own initiative.** Relay what the failure said. If the
message indicates a retry may help, say so and let me decide — you don't start
one yourself. Most failures (a paywall, a page outside Resources, a bad URL) do
not change on a retry, and the message says so when that's the case.

Only pass `force: true` when re-clipping a page that already has a clip on it.
It deletes the existing clip first. Never on a first attempt.

Paywalled and login-walled articles are out of scope by design; the service
cannot log in to anything. Use the Notion Web Clipper browser extension for
those.
```

## The contract

### `clip_article(page_id, url, force?)`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `page_id` | string | yes | Dashed or undashed id, **or a full Notion page URL**. Dashes don't matter. A `?v=` view id in a URL is ignored. |
| `url` | string | yes | Absolute `http(s)` article URL. |
| `force` | boolean | no | Only literal `true` counts. Deletes the existing clip first. |

### `clip_status(page_id)`

Takes **the page id — there is no job id.** Status is derived from the page's own blocks, so there is nothing to carry across turns and nothing to lose if the conversation restarts.

### Status values

The **first line** of the response text is a stable token:

```
STATUS: STARTED      (clip_article only — dispatch, not completion)
STATUS: CLIPPED
STATUS: IN_PROGRESS
STATUS: FAILED
STATUS: NOT_STARTED
```

Match on that line rather than on the prose after it. `isError` is also set on failures, but the spike found it does **not** arrive as a machine-readable field, so don't depend on it.

### Retention — results never expire

Status is read from the page, not from a job store. A `FAILED` result is an error callout sitting on the page, and it stays there until someone deletes it. **`FAILED` never decays into `NOT_STARTED`**, so the two remain distinguishable indefinitely.

### Existing content, `force: false`

The guard is per-URL, not per-page:

- The page already has a clip of **the same URL** → the run stops and writes nothing. No duplicate. `clip_status` reports `CLIPPED`.
- The page has other content but no clip of that URL → the article is **appended**. "Has content" is not the same as "already clipped this URL".

### Paywalls

Detected and failed, not clipped as a preview. Verified live: a paywalled NYT article returns HTTP 403 and is classified `BLOCKED` before anything is written.

**Residual risk, stated honestly:** detection is heuristic. A soft paywall that serves a long teaser with no recognisable subscribe wording could be extracted and reported as `CLIPPED`. If you see a clip that stops abruptly mid-article, that is the case to suspect.

### The URL comes only from the argument

The service never reads the page's `userDefined:URL` property — it doesn't touch properties at all, by design. If the argument and the property disagree, the argument wins and the property is left untouched. Keeping them in step is the caller's job.

### Target verification

Confirmed against data source `<your-data-source-id>`. `RESOURCES_DATA_SOURCE_ID` is unset in Netlify, so the code default applies, and it matches the live WDB | Resources data source.

### Templates: a blank new page is normal — clip into it

**Every template in WDB | Resources has a blank body.** Verified 2026-08-13: the default `(New article to read)` and the named ones like `(Architecture clipping)` all preset *properties* — Status, Areas, Tags — and none seed body content.

So a newly created page being empty is the expected steady state, not a page still loading. **Do not wait for content to appear before clipping.**

An earlier version of this document told the caller to wait until the template body had landed. That was wrong and caused a real deadlock in testing: a caller correctly followed it, fetched a blank page, and stopped — waiting for content that was never coming. The instruction was also unfalsifiable, because a blank page looks the same whether a template is still landing or has nothing to land.

The underlying race is real but narrow: the service appends to the end of a page, so if a template body ever did arrive mid-clip it would interleave. That cannot currently happen with these templates. If body-bearing templates are added to Resources later, this needs revisiting — see the ROADMAP backlog.

## Why it is shaped this way

The spike found that `isError` does **not** reach the model as a machine-readable field — what arrives is the harness's error wrapper plus whatever text the server wrote. So the tools lead every failure with an unmistakable marker (`CLIP FAILED`, `NOTHING CLIPPED`) rather than relying on a flag, and this prompt tells the caller to look for those words.

It also found the more dangerous gap on the *success* path: `clip_article` can only ever confirm dispatch, so a caller relaying it as "clipped" overstates what it was told with no error involved anywhere. `clip_status` exists to close that — it reads the page and gives an answer that can be checked instead of inferred.

## Notes for testing

- Images genuinely stored in Notion serve from an `amazonaws.com` URL, not the source site's domain. That is the check that matters most.
- Function logs: `image_degraded` and `image_import_failed` are images that fell back to hotlinks. A cluster of them means something systematic about that site.
- If a long illustrated article approaches the 15-minute ceiling, `IMAGE_CONCURRENCY` and the poll intervals are the tunables to reach for.
