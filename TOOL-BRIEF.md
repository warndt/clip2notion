# clip2notion — tool reference

**Last updated: 2026-08-14.** Describes the connector as deployed on that date. If the tool changes, this is the document to change with it.

Covers only the clipping tool — not the Resources database, Areas, Tags, or the rest of the workflow.

## How to use this document

It has two audiences.

**A Claude session doing the clipping.** Read this when something goes wrong, or when you need a detail the system prompt doesn't carry — a parameter, a status value, a symptom you don't recognise. Sections 2, 3, 5, 6 and 8 are for you.

**Whoever writes or revises the system prompt.** Sections 1 and 4 are the substance. Section 7 is setup and belongs to whoever configures the connector, not to the caller.

**Section 4 is deliberately duplicated in the system prompt itself.** Those five rules are load-bearing: each one, if got wrong, produces a confidently reported clip that never happened, or an article on the page twice. They must not depend on this document being fetched, reachable, or current. If you are revising the prompt and thinking of replacing them with a pointer here — don't. Reference material is for recovering from problems, not for preventing them.

---

## 1. What it is

An MCP connector called **clip2notion**. It writes a web article's full content into a Notion page that already exists, storing the article's images inside Notion rather than hotlinking them, so the clip survives the source site changing or disappearing.

It replaces the Notion Web Clipper browser extension for open-web articles.

**It does exactly one thing.** It does not create pages, set properties, choose Areas or Tags, or make any categorisation decision. Those are the caller's job. It only fills in the page body.

The division of labour the system prompt should encode:

1. Caller creates the page in **WDB | Resources** and sets every property.
2. Caller calls `clip_article` with the page id and the article URL.
3. Caller confirms with `clip_status` before telling the user anything.

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

Failure responses also set `isError`, but **do not depend on it** — it does not reliably reach the model as a machine-readable field. The leading token and the words are what arrive.

---

## 4. The five rules — keep these inline in the system prompt

Each exists because getting it wrong produces a confidently-delivered wrong answer or duplicated content. **Do not reduce these to a pointer at this document.** A caller that hasn't read them must still follow them.

**1. `clip_article` succeeding does NOT mean the article was clipped.**
It means the work started. It runs in the background and can still fail afterwards. Never report success on the strength of it — confirm with `clip_status` first.

**2. A transport error from `clip_article` does NOT mean nothing happened.**
The work is dispatched *before* the reply is sent. If the tool call times out or reports the server as not responding, the clip may well be running. **Never call `clip_article` a second time after such an error.** Call `clip_status` and let the page say what actually happened. Retrying blindly is how a page ends up with the article on it twice.

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

**Paywalls and login walls are out of scope by design.** The service fetches server-side with no session and cannot log in to anything. It detects the wall and fails visibly. The fallback for those is the Notion Web Clipper browser extension — the system prompt should say so, since it is the user's actual next step.

---

## 6. Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| Tool call errors, "server isn't responding" | Function timed out. The clip may be running. | Call `clip_status`. **Never** re-call `clip_article`. |
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
