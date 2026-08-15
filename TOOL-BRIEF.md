# clip2notion — tool reference

**Last updated: 2026-08-15.** Describes the connector as deployed on that date. If the tool changes, this is the document to change with it. The Notion mirror was re-synced on the 15th.

Covers only the clipping tool — not the Resources database, Areas, Tags, or the rest of the workflow.

## How to use this document

It has three audiences.

**Using it day to day.** Section 0 is the whole of it. The rest is detail you only need when something misbehaves.

**A Claude session doing the clipping.** Read this when something goes wrong, or when you need a detail the system prompt doesn't carry — a parameter, a status value, a symptom you don't recognise. Sections 2, 3, 5, 6 and 8 are for you.

**Whoever writes or revises the system prompt.** Sections 1 and 4 are the substance. Section 7 is setup and belongs to whoever configures the connector, not to the caller.

**Section 4 is deliberately duplicated in the system prompt itself.** Those five rules are load-bearing: each one, if got wrong, produces a confidently reported clip that never happened, or an article on the page twice. They must not depend on this document being fetched, reachable, or current. If you are revising the prompt and thinking of replacing them with a pointer here — don't. Reference material is for recovering from problems, not for preventing them.

---

## 0. Using it

Open the Claude project that handles Resources, give it the article's URL, and ask for it to be saved. Claude creates the page, sets the properties, and calls the clipper for the body. Nothing else is required of you — in particular, **you never need to say "check again"**; if a clip is still running, Claude waits for it.

### What a good clip looks like

Open the page. It should have, in order:

1. A **`Source:`** line — article title as a link, then publication, author and date
2. The article itself, headings and all
3. A **Footnotes** section at the end, if the original had footnotes

Then check the images actually render. That is the one thing no tool can verify — Claude can confirm an image is stored in Notion, but not that it displays. If images are broken, say so; don't assume a reported success means they're fine.

### When it goes wrong

- **A ⚠️ error callout on the page** — read it. It says what happened in plain language and whether trying again would help.
- **Article there but wrong** (missing sections, mangled tables) — ask Claude to re-clip it with force. That deletes the existing clip and rebuilds it.
- **A ⏳ callout still there after several minutes** — the run died. Ask for a force re-clip.
- **Paywalled or login-walled** — the service can't log in to anything, by design. Use the Notion Web Clipper browser extension for those. Same for pages rendered entirely in JavaScript.

### One thing to know about `force`

A forced re-clip deletes everything from the `Source:` line to the end of the page. Anything you added **above** it is safe; notes you added **below** the article go with it. Move them up, or copy them out first.

### When something is properly broken

First, **check what is running**: [<your-site>.netlify.app/.netlify/functions/health](https://<your-site>.netlify.app/.netlify/functions/health) answers with the deployed commit, whether each required secret is present, and the current settings. It never echoes a secret's value. A `503` there means the service is misconfigured and no clip will work until it is fixed.

Then Netlify → the clip2notion site → **Function logs**. Every run is tagged with a `clip_id`. `image_degraded` and `image_import_failed` mark images that fell back to hotlinks — a cluster of those means something systematic about that site rather than a one-off.

⚠️ **The logs drop entries.** A request that provably ran and returned has been observed missing from them entirely. Treat a missing log line as "no information", never as proof that something didn't happen.

---

## 1. What it is

An MCP connector called **clip2notion**. It writes a web article's full content into a Notion page that already exists, storing the article's images inside Notion rather than hotlinking them, so the clip survives the source site changing or disappearing.

It replaces the Notion Web Clipper browser extension for open-web articles.

**It does exactly one thing.** It does not create pages, set properties, choose Areas or Tags, or make any categorisation decision. Those are the caller's job. It only fills in the page body.

The division of labour the system prompt should encode:

1. Caller creates the page in **WDB | Resources** and sets every property.
2. Caller calls `clip_article` with the page id and the article URL.
3. Caller confirms with `clip_status` before telling the user anything.

⚠️ **On step 1, mind the templates.** Resources templates now preset properties of their own, and a property passed alongside `template_id` **overrides rather than merges**. A caller setting properties explicitly can silently wipe a preset Area. This is not a clipper concern — it touches no properties — but it belongs in the system prompt, because the symptom is a page that looks correctly filed and isn't.

---

## 2. The two tools

### `clip_article(page_id, url, force?)`

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `page_id` | string | yes | Dashed or undashed id, **or a full Notion page URL**. A `?v=` view id in a URL is ignored. |
| `url` | string | yes | Absolute `http(s)` article URL. |
| `force` | boolean | no | Only literal `true` counts. Deletes the existing clip first. |

### `clip_status(page_id)`

Takes **the page id — there is no job id**. Status is derived from the page's own blocks, so nothing needs carrying across turns and nothing is lost if the conversation restarts.

Both tools wait a few seconds server-side before answering, so a short article often completes inside a single call.

### What `force: false` actually guards against

The guard is **per-URL, not per-page**:

- Page already has a clip of **the same URL** → the run stops and writes nothing. No duplicate. `clip_status` reports `CLIPPED`.
- Page has other content but no clip of that URL → the article is **appended**. "Has content" is not the same as "already clipped this URL".

### The URL comes only from the argument

The service never reads the page's `userDefined:URL` property — it does not touch properties at all, by design. If the argument and the property disagree, the argument wins and the property is left untouched. Keeping them in step is the caller's job.

---

## 3. Status values

The **first line** of every response is a stable token. Match on that, not on the prose after it.

| Token | Meaning | What the caller may say |
|---|---|---|
| `STATUS: STARTED` | Dispatched. Nothing confirmed. | Nothing about success |
| `STATUS: IN_PROGRESS` | Still running. Outcome unknown. | Nothing about success |
| `STATUS: CLIPPED` | Confirmed on the page. | Safe to report success |
| `STATUS: FAILED` | Error callout on the page, with a reason. | Relay the reason verbatim |
| `STATUS: NOT_STARTED` | Page is empty. | Must not report success |
| `STATUS: REJECTED` | The request was refused before anything was written — bad page id, bad URL, page outside Resources, or Notion unreachable. | Relay the reason. Nothing reached the page, so there is no error callout to read. |

Failure responses also set `isError`, but **do not depend on it** — it does not reliably reach the model as a machine-readable field. The leading token and the words are what arrive. This is why every failure leads with an unmistakable phrase rather than relying on a flag.

**`CLIPPED` and `IN_PROGRESS` carry a time.** `Clip written:` on a `CLIPPED` result is when that clip's header was created; `Run started:` on `IN_PROGRESS` is when the running clip planted its marker. Both read absolutely and relatively — `2026-08-15 00:31 UTC (2 minutes ago)`.

This matters in exactly one situation, and it is the situation that has caused the most confusion: **on a re-clip, `CLIPPED` alone proves nothing.** The token says the same thing whether the re-run finished or the previous clip is sitting untouched. Check the written time before reporting a re-clip as done — a stale timestamp means the re-run has not landed and the article on the page is the old one. Notion records that time to the minute, so two runs inside one minute cannot be told apart this way.

**Results never expire.** Status is read from the page, not from a job store. A `FAILED` result is an error callout sitting on the page and stays there until someone deletes it, so `FAILED` never decays into `NOT_STARTED` — the two stay distinguishable indefinitely.

---

## 4. The five rules — keep these inline in the system prompt

Each exists because getting it wrong produces a confidently-delivered wrong answer or duplicated content. **Do not reduce these to a pointer at this document.** A caller that hasn't read them must still follow them.

**1. `clip_article` succeeding does NOT mean the article was clipped.**
It means the work started. It runs in the background and can still fail afterwards. Never report success on the strength of it — confirm with `clip_status` first.

**2. A transport error from `clip_article` does NOT mean nothing happened.**
The work is dispatched *before* the reply is sent. If the tool call times out or reports the server as not responding, the clip may well be running. **Never call `clip_article` a second time on the strength of an error alone.** Call `clip_status` first and let the page say what actually happened:

- `NOT_STARTED` → nothing was written, so calling `clip_article` again is safe. No `force` — there is nothing to replace.
- `IN_PROGRESS` → it is running. Keep calling `clip_status`.
- `CLIPPED` → it worked despite the error. Report success.

Retrying `clip_article` *without* that check is how a page ends up with the article on it twice. The first call after a quiet spell is the one most likely to error this way, and recovering through `clip_status` is expected rather than exceptional.

**3. On `IN_PROGRESS`, call `clip_status` again — do not ask the user.**
The tool waits server-side, so calling it again *is* how you wait. A long illustrated article may need several calls. Only after roughly ten should the caller say the run appears to have died. Never ask the user to say "check again"; chasing a background job is not the user's work.

**4. Never retry on your own initiative after a `FAILED`.**
Relay what the message said. Most failures — a paywall, a page outside Resources, a bad URL — do not change on a retry, and the message says so when that is the case. If it indicates a retry may help, offer that and let the user decide.

**5. `force: true` only when re-clipping a page that already has a clip.**
Never on a first attempt. It deletes the existing clip before rewriting.

---

## 5. What it handles, and what it doesn't

**Preserved:** headings, paragraphs, inline formatting, links, nested lists, blockquotes, code blocks with language, images with captions, tables, footnotes. Long paragraphs are split across Notion's 2000-character limit rather than truncated.

**Images** are imported into Notion. A stored image serves from an `amazonaws.com` URL, not the source site's domain — that is how you verify it. An image that can't be imported degrades to an external reference rather than vanishing.

**The lead image is captured**, meaning the hero that sits *above* the article body — where most news sites and WordPress themes put it, alongside its credit line. It lands directly below the `Source:` line, above the first heading, with its caption. Before 2026-08-15 it was lost silently: the article extracted fine and nothing reported a problem, so the only sign was an image you remembered seeing on the site.

Selection is deliberately strict — a missing hero is a minor loss, while a site logo at the top of every clip would be a visible defect on every page. Site logos, author headshots, event promos and tracking pixels are rejected, and a hero that is already in the article body is skipped rather than inserted twice.

**Paywalls and login walls are out of scope by design.** The service fetches server-side with no session and cannot log in to anything. It detects the wall and fails visibly, before anything is written. The fallback is the Notion Web Clipper browser extension — the system prompt should say so, since it is the user's actual next step.

**A newly created Resources page already has content, and that is normal.** The templates — `[New resource] <v1.0>` and its siblings — seed a version toggle and a divider along with preset properties. Verified 2026-08-14. **Clip into the page regardless; never wait for it to look a particular way before starting.**

**Existing content is not evidence of an existing clip.** The `force: false` guard is per-URL, not per-page (section 2): a page is "already clipped" only when it carries a clip header linking to *that* URL. Template furniture, or notes you added, are neither. Reaching for `force` because a page isn't empty would break rule 5 and delete content that was never a clip.

Two related failures are worth knowing about, because both were real:

- An earlier version of this guidance told the caller to wait until template content appeared. That deadlocked a session — it followed the instruction correctly, read a blank page, and stopped, waiting for something that was never coming. The instruction was unfalsifiable: a blank page looks identical whether a template is still landing or has nothing to land.
- The reverse then became possible when templates gained bodies. `clip_status` briefly read any content-bearing page as a clip mid-write, so a fresh page reported `IN_PROGRESS` with nothing running. Fixed by requiring enough content to look like a half-written article rather than furniture.

---

## 6. Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| Tool call errors, "server isn't responding" | The client gave up before the reply arrived. The clip may be running. | Call `clip_status`. **Never** re-call `clip_article` until `clip_status` says the page is untouched. |
| The **first** call after a quiet spell errors, later ones work | Cold start. Known and expected. | Call `clip_status` once to establish the true state, then carry on. One retry is normal; a pattern of them is not. |
| `STATUS: FAILED`, paywall mentioned | Bot-block or paywall detected before anything was written | Tell the user to use the Web Clipper for that article |
| `STATUS: FAILED`, other reason | Page carries an error callout; any content on it is partial | Relay verbatim; recovery is a `force` re-clip |
| `STATUS: NOT_STARTED` | Page genuinely empty — never called, or rejected before writing | Do not report success. A fresh clip is safe here. |
| "That page can't be read…" | Wrong page id, page outside Resources, or page deleted/in trash | Check the id. Retrying will not help. |
| Tools missing from the session entirely | Connector cached or not enabled for that conversation | Check the per-conversation connector toggle; if that fails, disconnect and reconnect the connector |
| `STATUS: CLIPPED` but images look broken | Import may have degraded to external references | Relay the user's report rather than insisting it worked — `CLIPPED` confirms the article was written, not every image |

**A page that looks created but empty is the worst outcome**, because it looks like success until someone opens it. Every rule above exists to prevent the caller reporting that as done.

---

## 7. Connector setup — operator only

**Not for the calling session.** Nothing here is actionable from a chat; it is for whoever configures the connector in claude.ai settings.

URL form — **the token is a path segment, not a query parameter**:

```
https://<your-site>.netlify.app/mcp/<CLIP_SHARED_SECRET>
```

The `?token=` form is still accepted by the server but **does not work through claude.ai** — the query string does not survive the trip, so the connector attaches and then reports no tools. This cost hours to diagnose; don't reintroduce it.

Rotating the secret means updating **three** places: the Netlify environment variable, a redeploy (env changes don't reach live functions otherwise), and the connector URL.

If tools don't appear after a change, disconnect and re-add the connector rather than editing it — the settings page can show a stale URL.

**Target verification.** The service only writes to pages whose parent is data source `<your-data-source-id>` (WDB | Resources). `RESOURCES_DATA_SOURCE_ID` is unset in Netlify, so the code default applies and matches the live data source. A leaked token therefore cannot append to arbitrary pages in the workspace.

**Checking a clip by hand.** Images genuinely stored in Notion serve from an `amazonaws.com` URL rather than the source site's domain — that is the check that matters most, and the only reliable way to tell a stored image from a hotlinked one. In the Netlify function logs, `image_degraded` and `image_import_failed` mark images that fell back to external references; a cluster of them means something systematic about that site. If a long illustrated article approaches the 15-minute background-function ceiling, `IMAGE_CONCURRENCY` and the image poll intervals are the tunables to reach for.

---

## 8. Known limitations, all deliberate

- **`force` deletes from the clip header to the end of the page.** Notes added *below* a clip go with it. Anything above the header is untouched.
- **Tables with merged cells** fall back to the original HTML in a code block — lossless but ugly. Notion has no merged cells.
- **Code block languages are lost on some sites** (MDN-style markup, where the language sits in a sibling element). The code is intact and correctly formatted, just unlabelled, with the language name appearing as a stray word above it.
- **List nesting deeper than two levels is flattened**, not dropped.
- **Paywall detection is heuristic.** A soft paywall serving a long teaser with no recognisable subscribe wording could be clipped and reported `CLIPPED`. If a clip stops abruptly mid-article, that is the case to suspect.
- **Images inside table cells are dropped** from the cell — Notion cells hold rich text only.

---

## 9. Tone note for the system prompt

The failure this whole service is built against is a caller reporting success for a clip that didn't happen. Whatever wording you choose, the prompt should make the caller comfortable saying *"it's still running"*, *"it failed, here's why"*, or *"I can't tell yet"* — and never let it round any of those up to "done".
