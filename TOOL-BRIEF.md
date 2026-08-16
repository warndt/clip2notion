# clip2notion — tool reference

**Last change: 2026-08-16.** This document describes the connector on that date. If the tool changes, change this document also.

This document covers only the clipping tool. It does not cover the Resources database, Areas, Tags, or the other parts of the workflow.

## How to use this document

There are three groups of readers.

**A person who uses the tool each day.** Read section 0. The other sections give detail that you need only when there is a problem.

**A Claude session that makes the clips.** Read this document when there is a problem, or when you need a detail that the system prompt does not contain: a parameter, a status value, or a symptom that you do not know. Sections 2, 3, 5, 6, and 8 are for you.

**A person who writes or changes the system prompt.** Sections 1 and 4 are the important parts. Section 7 is for the person who configures the connector and not for the caller.

**Section 4 is also in the system prompt, on purpose.** Those five rules are necessary. If the caller applies one of them incorrectly, the result is a clip that the caller reports but that did not occur, or an article that is on the page two times. The rules must not depend on this document. If you change the prompt, do not replace the rules with a link to this document. Reference material corrects a problem. It does not prevent a problem.

---

## 0. How to use the tool

Open the Claude project for Resources. Give it the URL of the article and ask it to save the article. Claude creates the page, sets the properties, and calls the clipper for the body. You do nothing more. In particular, **you never need to say "check again"**. If a clip continues to operate, Claude waits for it.

### What a correct clip looks like

Open the page. It has these parts, in this order:

1. A **`Source:`** line: the title of the article as a link, then the publication, the author, and the date
2. The article, with its headings
3. A **Footnotes** section at the end, if the original article has footnotes

Then look at the images. No tool can confirm that an image shows correctly. Claude can confirm that an image is in Notion, but not that the image shows. If an image does not show, report it. Do not assume that a reported success means that each image is correct.

### If there is a problem

- **A ⚠️ error callout on the page.** Read it. It says what occurred, in simple language, and if a second attempt can help.
- **The article is present but is not correct** (sections are missing, or a table is not correct). Ask Claude to clip the article again with `force`. This deletes the clip that exists and makes it again.
- **A ⏳ callout is still present after some minutes.** The run stopped. Ask for a clip with `force`.
- **A paywall or a login wall.** The service cannot log in to a website. This is by design. Use the Notion Web Clipper browser extension. Use it also for a page that needs JavaScript to show its content.
- **The website refused the request.** Some websites have bot protection that refuses each request from a server, although the article is free and open in your browser. The error message says this. It also says that a login does not help. The Web Clipper operates in your browser, so the bot protection does not affect it.

### One fact about `force`

A clip with `force` deletes each block from the `Source:` line to the end of the page. Content **above** that line is safe. A note that you added **below** the article is deleted with the clip. Move the note above the `Source:` line, or copy it to a different location first.

### If the service does not operate

First, **find out which version operates**. Send a request to `https://<your-site>.netlify.app/.netlify/functions/health`. It answers with the deployed commit, if each necessary secret is present, and the current settings. It never gives the value of a secret. A `503` means that the configuration is not complete and no clip will operate until a person corrects it.

Then open Netlify, then the clip2notion site, then **Function logs**. Each run has a `clip_id`. The messages `image_degraded` and `image_import_failed` show images that became external links. If there are many of these for one website, the cause is systematic for that website and is not a single event.

⚠️ **The logs lose entries.** A request that certainly operated and returned a response was not in the logs. If a log line is not present, this gives no information. It does not show that an event did not occur.

---

## 1. What the tool is

An MCP connector with the name **clip2notion**. It writes the full content of a web article into a Notion page that already exists. It stores the images of the article in Notion and does not link to them on the source website. Therefore the clip continues to operate if the source website changes or stops to operate.

It replaces the Notion Web Clipper browser extension for open-web articles.

**It does one thing.** It does not create pages, set properties, select Areas or Tags, or make any decision about a category. The caller does these. The tool writes only the body of the page.

The system prompt must contain this division of work:

1. The caller creates the page in **WDB | Resources** and sets each property.
2. The caller calls `clip_article` with the page id and the URL of the article.
3. The caller uses `clip_status` to confirm the result before it tells the user anything.

⚠️ **In step 1, be careful with the templates.** The Resources templates now set properties. A property that the caller sends with `template_id` **replaces the template value and does not add to it**. Therefore a caller that sets properties can delete an Area that the template set, with no message. This is not a problem in the clipper, because the clipper changes no properties. But it belongs in the system prompt, because the symptom is a page that looks correct and is not correct.

---

## 2. The two tools

### `clip_article(page_id, url, force?)`

| Parameter | Type | Necessary | Description |
|---|---|---|---|
| `page_id` | string | yes | An id with or without hyphens, **or a full Notion page URL**. The tool ignores a `?v=` view id in a URL. |
| `url` | string | yes | The absolute `http` or `https` URL of the article. |
| `force` | boolean | no | Only the value `true` operates. It deletes the clip that exists first. |

### `clip_status(page_id)`

This tool uses **the page id. There is no job id.** The tool reads the state from the blocks of the page. Therefore you do not carry a value between turns, and you lose nothing if the conversation starts again.

Both tools wait some seconds on the server before they answer. Therefore one call is frequently sufficient for a short article.

### What `force: false` prevents

The check is **for each URL and not for each page**:

- The page has a clip of **the same URL**. The run stops and writes nothing. There is no duplicate. `clip_status` gives `CLIPPED`.
- The page has other content but no clip of that URL. The service **adds** the article. "The page has content" is not the same as "the page has a clip of this URL".

### The URL comes only from the parameter

The service never reads the `userDefined:URL` property of the page. It does not read or write properties. If the parameter and the property are different, the service uses the parameter and does not change the property. The caller must keep them the same.

---

## 3. Status values

The **first line** of each response is a fixed value. Use that line and not the text after it.

| Value | Meaning | What the caller can say |
|---|---|---|
| `STATUS: STARTED` | The work started. Nothing is confirmed. | Nothing about success |
| `STATUS: IN_PROGRESS` | The run continues. The result is not known. | Nothing about success |
| `STATUS: CLIPPED` | Confirmed on the page. | You can report success |
| `STATUS: FAILED` | There is an error callout on the page, with a cause. | Give the cause with no change |
| `STATUS: NOT_STARTED` | The page is empty. | Do not report success |
| `STATUS: FOREIGN_CONTENT` | The page has content, and this service wrote none of it. No run operates. | Do not report success. Do not call again. Ask the user before you clip. |
| `STATUS: REJECTED` | The service refused the request before it wrote anything: an incorrect page id, an incorrect URL, a page outside Resources, or Notion is not available. | Give the cause. Nothing reached the page, so there is no error callout to read. |

A failure response also sets `isError`. **Do not depend on this flag.** It does not always arrive at the model as a field that a machine can read. The first-line value and the words arrive. This is the reason that each failure message starts with a clear phrase and does not depend on a flag.

**`CLIPPED`, `IN_PROGRESS`, and `FOREIGN_CONTENT` each give a time.** On a `CLIPPED` result, `Clip written:` is the creation time of the header of that clip. On `IN_PROGRESS`, `Run started:` is the time when the run wrote its marker. On `FOREIGN_CONTENT`, `Last change:` is the newest block on the page. Each time is absolute and relative: `2026-08-15 00:31 UTC (2 minutes ago)`.

**`FOREIGN_CONTENT` is not a failure and is not a run.** It means that the page has content and that none of the content has a marker from this service. The most frequent cause is a Web Clipper save that a person made after this service failed for that article. Other causes are notes from the user, or a clip that a person deleted partially. The service cannot tell which cause applies, and it says this instead of a guess.

No run operates, therefore **do not call the tool again**. It gives the same answer continuously. Also, **do not call `clip_article` for such a page before you ask the user.** A clip with no `force` adds a second copy of the article below the content that exists. A clip with `force: true` deletes the content that exists. Describe the content of the page and let the user decide.

This is important in one situation, and that situation causes the most confusion. **After a clip with `force`, `CLIPPED` alone shows nothing.** The value is the same if the new run is complete and if the previous clip is unchanged. Read the written time before you report that a clip with `force` is complete. An old time means that the new run did not finish and that the article on the page is the old article. Notion records that time to the minute, so you cannot tell two runs apart inside one minute.

**A result does not expire.** The service reads the state from the page and not from a job store. A `FAILED` result is an error callout on the page. It stays until a person deletes it. Therefore `FAILED` never becomes `NOT_STARTED`, and the two states stay different.

---

## 4. The five rules — keep these in the system prompt

Each rule exists because an incorrect action gives an incorrect answer with confidence, or gives content two times. **Do not replace these with a link to this document.** A caller that has not read this document must still obey them.

**1. A successful `clip_article` does NOT mean that the service clipped the article.**
It means that the work started. The work continues in the background and can still fail. Never report success because of this response. Use `clip_status` to confirm the result first.

**2. A transport error from `clip_article` does NOT mean that nothing occurred.**
The service starts the work **before** it sends the response. If the tool call times out or reports that the server does not answer, the clip can still operate. **Never call `clip_article` a second time only because of an error.** Call `clip_status` first and let the page give the result:

- `NOT_STARTED` — the service wrote nothing, so a second `clip_article` call is safe. Do not use `force`. There is nothing to replace.
- `IN_PROGRESS` — the run operates. Continue to call `clip_status`.
- `FOREIGN_CONTENT` — the page has content that this service did not write, and no run operates. Do **not** call `clip_article`. Ask the user what the content is first.
- `CLIPPED` — the clip operated although there was an error. Report success.

If you call `clip_article` again without this check, the page can receive the article two times. The first call after a quiet period is the most probable cause of this error. Recovery with `clip_status` is usual and not exceptional.

**3. After `IN_PROGRESS`, call `clip_status` again. Do not ask the user.**
The tool waits on the server, so a second call **is** the method to wait. A long article with images can need some calls. Only after approximately ten calls can the caller say that the run stopped. Never ask the user to say "check again". The user does not do this work.

**4. Never try again by your own decision after a `FAILED`.**
Give the message to the user. Most failures do not change after a second attempt: a paywall, a page outside Resources, or an incorrect URL. The message says this when it applies. If the message says that a second attempt can help, tell the user and let the user decide.

**5. Use `force: true` only for a page that already has a clip.**
Never use it for a first attempt. It deletes the clip that exists before it writes the new clip.

---

## 5. What the service does and does not do

**The service keeps these:** headings, paragraphs, inline formatting, links, nested lists, quotations, code blocks with the language, images with captions, tables, and footnotes. It divides a long paragraph across the Notion limit of 2,000 characters. It does not remove text.

**The service imports the images into Notion.** An image in Notion comes from an `amazonaws.com` URL and not from the domain of the source website. Use this to confirm that an image is in Notion. If the service cannot import an image, it uses an external link and does not remove the image.

**The service captures the lead image.** This is the main image **above** the body of the article, where most news websites and WordPress themes put it, with its credit line. The service puts it directly below the `Source:` line, above the first heading, with its caption. Before 2026-08-15 the service lost this image and reported no problem. The article extracted correctly and nothing showed an error, so the only sign was an image that you remembered from the website.

The selection is strict on purpose. A lost main image is a small loss. A site logo at the top of each clip is a visible defect on each page. The service rejects site logos, author photographs, event advertisements, and tracking pixels. If the main image is already in the body of the article, the service does not insert it a second time.

**Paywalls and login walls are out of scope by design.** The service reads the URL from a server with no session and cannot log in. It detects the wall and fails with a visible message, before it writes anything. The alternative is the Notion Web Clipper browser extension. The system prompt must say this, because it is the next action of the user.

**A website that refuses the request is a different failure, and the message says so.** Bot protection at the edge of a website can refuse a request from a server and supply the same article to any browser. The refusal applies to the client that makes the request and not to an anonymous reader. No account changes this. Therefore the message gives the name of the website, the HTTP status, and a clear statement that this is not a paywall and that a login does not help.

Do not give one of these messages as the other. Until 2026-08-16 both gave the same sentence: "this article can't be fetched without a login". This caused the user to look for a subscription for a free article. If the message does not say login or subscription, do not add one.

**A new Resources page already has content, and this is usual.** The templates `[New resource] <v1.0>` and its similar templates add a version toggle and a divider, with the preset properties. Confirmed on 2026-08-14. **Clip into the page. Never wait for the page to have a specific appearance before you start.**

**Content on a page does not show that a clip exists.** The `force: false` check is for each URL and not for each page (section 2). A page has a clip only when it has a clip header with a link to **that** URL. Template content and your notes are not a clip. If you use `force` because a page is not empty, you break rule 5 and delete content that was never a clip.

Two failures are worth knowing, because both occurred:

- An earlier version of this document told the caller to wait until the template content arrived. A session followed that instruction correctly, read an empty page, and stopped. It waited for content that was never going to arrive. The caller could not test the instruction: an empty page looks the same if a template is still arriving and if there is nothing to arrive.
- The opposite failure then became possible when the templates gained a body. `clip_status` read any page with content as a clip in progress. Therefore a new page gave `IN_PROGRESS` although no run operated. The correction requires sufficient content to look like a partial article and not like template content.

---

## 6. Problems and corrections

| Symptom | Meaning | Action |
|---|---|---|
| The tool call gives an error, "server isn't responding" | The client stopped waiting before the response arrived. The clip can still operate. | Call `clip_status`. **Never** call `clip_article` again until `clip_status` says that the page has no content. |
| The **first** call after a quiet period gives an error, and later calls operate | A cold container. This is known and expected. | Call `clip_status` one time to find the true state, then continue. One error is usual. Many errors are not usual. |
| `STATUS: FAILED`, and the message says paywall or subscription | A true login wall or subscription wall, detected before the service wrote anything | Tell the user to use the Web Clipper for that article |
| `STATUS: FAILED`, and the message says "refused this request" or "bot-check page" | The bot protection of the website refused the request. **This is not a paywall.** The message says so. | Tell the user to use the Web Clipper. Do not tell the user to log in or to subscribe. |
| `STATUS: FAILED`, a different cause | The page has an error callout. Any content on the page is partial. | Give the message with no change. To recover, clip again with `force`. |
| `STATUS: NOT_STARTED` | The page is empty. The service was never called, or it refused the request before it wrote anything. | Do not report success. A new clip is safe. |
| `STATUS: FOREIGN_CONTENT` | The page has content that this service did not write, usually a Web Clipper save after a failed clip. No run operates. | Do not call again. The answer will not change. Do not clip before you ask: a clip with no `force` adds a duplicate, and `force` deletes the content. |
| "That page can't be read…" | An incorrect page id, a page outside Resources, or a page that a person deleted | Check the id. A second attempt does not help. |
| The tools are not in the session | The connector uses a cache, or it is not enabled for that conversation | Check the connector control for that conversation. If that does not operate, disconnect the connector and connect it again. |
| `STATUS: CLIPPED` but the images look incorrect | The import can have used external links | Give the report from the user. Do not say that the clip is correct. `CLIPPED` confirms that the service wrote the article, not that each image is correct. |

**The worst result is a page that looks complete and is empty**, because it looks like a success until a person opens it. Each rule above prevents the caller from reporting that page as complete.

---

## 7. Connector setup — for the operator only

**This section is not for the calling session.** A chat session cannot use any of this. It is for the person who configures the connector in the claude.ai settings.

The form of the URL. **The token is a path segment and not a query parameter:**

```
https://<your-site>.netlify.app/mcp/<CLIP_SHARED_SECRET>
```

The real host of the deployed service belongs in the Notion copy of this document, which only the operator and the calling session read. Keep it out of the public repository.

The server still accepts the `?token=` form, but **it does not operate through claude.ai**. The query string does not arrive. Therefore the connector connects and then reports no tools. This took hours to diagnose. Do not use it again.

To change the secret, you must change **three** items: the Netlify environment variable, the deploy (an environment change does not reach the live functions without a deploy), and the URL of the connector.

If the tools do not appear after a change, disconnect the connector and add it again. Do not edit it. The settings page can show an old URL.

**Target check.** The service writes only to a page whose parent is the data source in `RESOURCES_DATA_SOURCE_ID`. That variable is necessary and has no default value. Therefore a person who gets the token cannot write to other pages in the workspace.

**How to check a clip manually.** An image that is in Notion comes from an `amazonaws.com` URL and not from the domain of the source website. This is the most important check, and it is the only reliable method to tell an image in Notion from an external link. In the Netlify function logs, `image_degraded` and `image_import_failed` show images that became external links. Many of these for one website show a systematic cause. If a long article with many images approaches the 15-minute limit of the background function, change `IMAGE_CONCURRENCY` and the image poll intervals.

---

## 8. Known limits, all accepted on purpose

- **`force` deletes each block from the clip header to the end of the page.** A note below a clip is deleted with the clip. Content above the header does not change.
- **A table with merged cells becomes the original HTML in a code block.** No data is lost, but it is not easy to read. Notion has no merged cells.
- **The service loses the code-block language on some websites** (MDN-style HTML, where the language is in a sibling element). The code is complete and formatted correctly. It has no language name, and the name of the language is one additional word above the block.
- **The service makes list levels deeper than two into level two.** It does not remove them.
- **Paywall detection uses rules that can be incorrect.** A partial paywall that supplies a long sample with no recognised subscribe text can produce a clip with a `CLIPPED` result. If a clip stops in the middle of an article, this is the probable cause.
- **Some websites refuse this service, whatever it sends.** Bot protection can evaluate the **client** and not the reader. It refuses a request from Node because of the TLS fingerprint, before it examines the headers. Measured on `ecuad.ca`: curl and Python received the article from the same machine and the same IP address that received a 403 for Node, and browser-like headers changed nothing. Use the Web Clipper for these websites until the website changes its settings. There is no correction inside the service.
- **The service removes an image inside a table cell.** A Notion cell holds only rich text.

---

## 9. A note about the tone of the system prompt

This service exists to prevent one failure: a caller that reports success for a clip that did not occur. Use any words that you want, but the prompt must let the caller say **"the run continues"**, **"it failed, and this is the cause"**, or **"I cannot tell yet"**. The prompt must never let the caller change one of these into "complete".
