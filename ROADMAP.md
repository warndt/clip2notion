# clip2notion — Roadmap

This file lists the planned work. Read all of it before you start a task.

**Status symbols:** ⬜ not started · 🟡 in work (Wil must review it) · ✅ complete (only after Wil reviews and approves it) · ⏸️ stopped

**The scope is small on purpose.** The service has one user who clips a small number of articles each week. If a clip is not correct, the user can look at the page and do the clip again. Build the smallest thing that operates. Then let real articles show you what is not present.

---

## The five requirements that must be correct

All other requirements can change. These five requirements fail without a visible sign: the page looks correct, but it is not correct. If you change the code for one of these five requirements, write a test.

1. **Store the images in Notion. Do not link to the source website.** If the service cannot store an image, it must use a link. It must not remove the image.
2. **Do not write the content two times.** Netlify does the function again after 1 minute and again after 2 minutes. Throw an error only for a temporary failure. Do not throw an error for a paywall. Do not throw an error after the service wrote a part of the content.
3. **Do not cut the text.** A Notion rich-text object has a limit of 2,000 characters. Divide the text into more than one object. Do not remove text.
4. **Show a failure to the user.** Write the in-progress callout first. If there is a failure, change the callout into an error message in simple language. Do not delete content automatically.
5. **Tables.** If `colspan` or `rowspan` prevent a correct conversion, use a different format that keeps all of the data. Do not remove cells.

---

> **Status on 2026-08-15:** the service operates fully and is in usual use. A claude.ai chat session makes a clip with the MCP connector. The images are in Notion. The structure is correct. After a clip with `force`, the page has exactly one copy of the article.
>
> These items are complete since 14 August. Real clips showed that they were necessary. Planning did not.
> - The service captures the **lead image** above the body of the article (M4).
> - `clip_status` reports **when** the service wrote a clip. `/health` reports which version operates. Therefore you can answer two questions: "did the clip operate?" and "is the correction in production?" (M5).
> - The service converts **images inside links** correctly. Before this, it removed all of these images and did not report a problem (M6).
>
> The deploy is the commit "fix: images wrapped in links were never images at all" (2026-08-14). This document gives commit subjects and not commit hashes, because the project rewrote its history and each hash changed.
>
> All items below are history, or optional work. Real use is a better method to set the priority of the optional work than planning is.

## M1 — Minimum viable product ✅

The full service, in one step.

- ✅ Project files — `package.json`, `tsconfig.json`, `netlify.toml`, `.env.example`
- ✅ `src/config.ts` — the environment variables and all of the adjustable values in one location. An environment variable can change each value.
- ✅ `src/errors.ts` — error classes with messages in simple language. Each class shows if the error is temporary.
- ✅ `src/notion.ts` — the API client (controlled request rate, `429` with `Retry-After`, a limited number of retries), the check of the parent data source, a list of the child blocks with pagination, writes in groups, and file upload with polling
- ✅ `src/extract.ts` — reads the URL with a browser user-agent, checks the host after each redirect, uses Readability, and detects a paywall or a bot-block
- ✅ `src/blocks.ts` — moves through the DOM and makes Notion blocks, divides rich text, finds the URL of a lazy-loaded image, and converts tables without a loss of data
- ✅ `src/pipeline.ts` — controls the sequence, prevents a second copy, controls the status callout, and imports the images
- ✅ `netlify/functions/clip.ts` — checks the request and gives a response code, then starts the background function
- ✅ `netlify/functions/clip-background.ts` — the worker. It does each check again. It always answers with 202.
- ✅ `src/request.ts` — constant-time authentication and request parsing. Both entry points use it.
- ✅ `force: true` — delete the previous clip and do the clip again. This applies to the clip and not to the full page.
- ✅ Tests for the failures that have no visible sign. These include the sequence of the header block and the first content block.

**Complete when:** the service clips a long article with images and the result is complete and easy to read; a URL with a paywall fails with a clear message and writes no incorrect content; and a second attempt does not write the content two times.

---

## M3 — Let the real client call the service ✅

> **The number is M3 because this was the third discovery. The position is here because it stops M2.** It is not useful to clip twenty articles from a terminal if the real caller cannot clip one article.

**This stopped other work.** The pipeline operated. But it operated only from an environment that the real caller does not have.

The intended caller is a Claude session in the claude.ai chat interface. That environment **cannot send a POST request to the service**. The sandbox refuses hosts that are not on its list. The proxy gives `x-deny-reason: host_not_allowed`. Its fetch tool can send only GET requests and cannot set an `X-Clip-Secret` header. This was tested directly on 2026-08-12.

The M2 clips below show that the pipeline operates. They do not show that the real caller can use it. A terminal and that sandbox have different network access.

- ✅ **Test: a minimal remote MCP server** — `netlify/functions/mcp.ts` at `/mcp`, with one diagnostic tool, `clip_probe`. The file imports nothing from `src/` and changes nothing in the clip path. If you delete the file, the service does not change. It went directly to `main`, because there are no branch deploys and there was nothing in production to protect.
- ✅ **`clip_probe` tests the failure channels and not the successful path.** It has four modes: `ok`; `tool_error` (a usual result with the `isError` flag, which is how a paywall or an incorrect page id appears); `protocol_error` (a JSON-RPC error object); and `thrown` (a server exception that no code catches). All four modes were tested locally.
- ✅ **Result: the session receives specific and useful failure messages. Decision: change the service to MCP.** A real claude.ai session showed this on 2026-08-13.
- ✅ **Changed to MCP.** `netlify/functions/mcp.ts` now supplies `clip_article` and `clip_status`. A token in the URL of the connector authenticates the caller. The probe is deleted. The pipeline behind it did not change.
- ✅ `src/pipeline.ts` received `deriveClipStatus` (a pure function with tests) and `getClipStatus`.
- ✅ The caller documentation was written again for the two tools and the start-then-confirm sequence.
- ✅ Deployed. The connector now uses `/mcp/<token>`. A real clip operated fully from a chat session. **The query-string form did not operate.** claude.ai sent the request with no query string (`has_query: false` in each logged request). Therefore the connector connected but supplied no tools. A path segment carries the token correctly. The service also accepted a query string, an `Authorization` header, and an `X-Clip-Secret` header. ⚠️ **This is no longer correct.** The service now accepts only the path segment and the `X-Clip-Secret` header. Refer to the Backlog item of 2026-08-16.

### Test results: how each failure channel operates

| Channel | What the session received |
|---|---|
| Tool result with `isError` | **The full text, with no change.** The cause, the effect, and the correction all arrived. This channel operated much better than the others. |
| JSON-RPC `-32602` | The code and the message arrived. **The `data` field arrived as `null`, although the server sent a value.** That field does not arrive. Do not use it. |
| JSON-RPC `-32603` | The system **replaced** the message with a general message: "the connector's server isn't responding, you can try again". The message from the server did not arrive. |
| An exception that no code catches | The same general message. Nothing useful arrived. |

**Four design rules come from this test. Each rule is necessary.**

1. **Send each failure that the user reads as a tool result with `isError`. Do not send it as a protocol error.** Use protocol errors only for a request with an incorrect format.
2. **Do not let an exception leave the tool handler.** The system replaces `-32603` with "you can try again". That message is not correct for a paywall, and it causes the caller to try again continuously. Catch each exception and change it into a tool result with a correct message.
3. **The words of a failure message must show clearly that it is a failure.** The `isError` flag does **not** arrive at the model as a separate field. The model receives the `<error>` wrapper from the harness and our words. The test message showed a failure because a person wrote it as a failure. Start each failure message with a clear marker. Do not write a failure message that reads like a success message.
4. **A successful start is not a successful write.** Refer to the next section.

### The larger risk: a start is not a write

The success message from the test said "accepted, verify the page shortly". If a session tells the user "I clipped it", the session says more than the message said. **No error occurred at any point.** This is the incorrect-but-confident answer that this project prevents. It arrives through the success path and not through a failure path.

The service cannot answer only after the write is complete. A long article with images needs some minutes, and a tool call cannot wait for that time. Therefore the correction is a second tool.

- ✅ **`clip_status(page_id)`** gives a definite state as the first line of the response: `NOT_STARTED`, `IN_PROGRESS`, `CLIPPED`, or `FAILED`. It reads the page with the same method that the duplicate check uses.
- ✅ `clip_article` gives a message that the caller cannot read as "complete". The message tells the caller to use `clip_status`.

Therefore the session can **check** if the clip operated. Before this, the session had to **estimate** the result from the words of a message. A check is a better method than any rule about wording.

- ✅ `runClip` now operates behind the MCP entry point. The pipeline did not change.
- ✅ `TOOL-BRIEF.md` is the single reference for the caller. It contains the two tools, the full parameter contract, the status values, the rules that prevent the caller from reporting a clip that did not occur, and a table of problems and corrections. There is a copy in a Notion page that the calling session can read.

**Complete when:** a claude.ai chat session clips an article fully, with no browser extension installed. **Complete on 2026-08-14.** The article was a long Noahpinion post. Notion held three images as new file objects. The section headings and the footnotes were correct. After a clip with `force`, the article was present exactly one time. The images showed correctly.

**An alternative method that the project did not use: a Notion automation that calls a webhook.** With a paid Notion plan, a database automation sends a POST request to the service when a person creates a page. Notion calls the service, so the caller needs no HTTP capability.

**The reason the project did not use it.** This method removes the immediate rejection. The service cannot tell the calling session "that URL has an incorrect format" at the time of the call. Each operation becomes write, wait, and read again. This is the incorrect-but-confident answer that this project prevents. The front function exists to give a real status code. Also, the setup uses manual configuration in the interface, the authentication options are weak, and the secret is probably in a query string.

---

## M2 — Clip twenty real articles ✅

The test plan. Each item finds out what fails.

> **Closed on 2026-08-16 with one item still open on purpose.** All items below operate and are in daily use. But no test used the "retry after a partial write" case. You cannot cause that case with a usual clip. You must inject a fault. The complete status of this milestone does not make that ⬜ item complete. It is the most important failure in the project and no test has shown that the protection operates.

- ✅ Write the calling instructions for the Claude project prompt. **Replaced. The caller uses MCP and not HTTP. Refer to M3.**
- ✅ Change `CLIP_SHARED_SECRET` for production and set the environment variables in Netlify
- ✅ Deploy

### Tested against the live Notion workspace (2026-08-12)

Three real clips from a terminal. Four of the five requirements now operate in production and not only against test fixtures.

- ✅ **The images are in Notion.** NASA Hubble Science: the service imported 6 of 6 images. They come from `prod-files-secure.s3.us-west-2.amazonaws.com`. No image used a link to the source website. The captions are correct. This is the primary purpose of the project.
- ✅ **Tables.** MDN `Cache-Control`: the service converted 2 tables into true Notion `table` blocks and did not use the HTML alternative. It detected the header rows. Inline code inside the cells is correct. Empty cells are correct. The clip has 30 code blocks and 34 of 34 headings, with no loss of content.
- ✅ **A visible failure.** A New York Times URL with a paywall produced a red ⚠️ callout with a message in simple language and no partial content. The service classified it as `BLOCKED` when it read the URL (HTTP 403). It did not clip an incomplete article.
- ✅ **No second copy after a retry.** An identical second POST request for a complete clip gave `202` and wrote nothing. The page still has one header, one article, and six images.
- ✅ The status callout sequence: the service writes it at the first write, deletes it after success, and changes it into the error message after a failure.

### Not tested: the dangerous duplicate case ⬜

A second POST request for a **complete** clip is the easy part. The design protects against a different state: **the service writes content, the function stops, and then the Netlify retry arrives.** A usual clip does not cause this state.

- ⬜ Inject a temporary throw after the first group of blocks. Make sure that the retry finds the clip header and stops.
- ⬜ **Do this locally with `netlify dev`. Do not deploy it.** `netlify dev` supplies the environment variables of the connected site. Therefore the pipeline operates against the real Notion workspace with real credentials, and the fault stays in the working directory. There is nothing to deploy, so there is nothing to remove later. This is safer than a preview deploy, which a person must remove.
- ⬜ **The injected fault must never go to `main`.** The MCP test only added a file. This change breaks the clip path. It is the one change that would make the live service destructive. A fault line that stays in the code can survive a rebase, and a person can easily not see it.

This test is worth the additional work. This failure becomes visible some weeks later, as a second copy of an article, on a page that nobody looks at.

### Coverage is more important than a count

The plan said "clip twenty real articles". The evidence shows that coverage is better. Three clips found two real bugs. **Variety** found both bugs, not volume. One website redirects with a meta-refresh page. One website puts the code language in a sibling element. Twenty articles from similar websites teach less than five different articles.

After M3, these clips are not tests. A clip is usual use of the tool. The remaining work is: use the tool on articles that you want to keep, and report the failures. This method does not add test pages to the database.

- ✅ Many images — NASA Hubble Science (6 images, all in Notion)
- ✅ A technical post with code blocks and tables — MDN Cache-Control
- ✅ A paywall — New York Times
- ✅ A long article with CDN images and footnotes — Noahpinion (Substack)
- ✅ A website with `srcset` CDN transforms — Substack. This showed the comma-division bug.
- ⬜ A paragraph with more than 2,000 characters in a live article. Only a test fixture has shown this.
- ⬜ Then: usual use, and a report of each failure

- ⬜ Write each failure in the Backlog below. Correct the failures that occur, not the failures that can occur.

**Complete when:** Wil clips an article fully from Claude, with no browser extension installed. **Complete on 2026-08-14.**

### Report from the first live connector clips (2026-08-13 and 2026-08-14)

The calling session found five defects. All five are corrected. This report exists because the service could not see any of them. The pipeline reported success for each one.

- ✅ **P0 — `clip_status` gave `NOT_STARTED` for a page that held a complete article.** There were two causes. First, a clip with `force` deleted the blocks one at a time and deleted the header first. Therefore the content had no marker for some tens of seconds. The service now writes the progress callout **before** it deletes anything. Second, the code read "no marker" as "no content". This is the dangerous direction: the contract sends a `NOT_STARTED` page to a clip without `force`, which writes a second copy. Content with no header now gives `in_progress`.
- ✅ **P1 — `clip_article` reported a confirmed result that it could not know.** It started the work and then read the page. At the first read, a clip with `force` still shows the **previous** clip. It now waits for the marker of its own run before it accepts any final state.
- ✅ **A transport error from `clip_article` does not mean that the clip did not occur.** The service starts the work before it sends the response. Therefore a function that the platform stops looks like a failure, but the work continues. If the caller tries again after this error, the page receives the article two times. The tool description and the caller prompt now prevent this: after a transport error, call `clip_status` and never `clip_article`.
- ✅ **Substack lost all of the headings.** The conversion was not the cause. Readability classified the headings as page furniture, because each heading contains an anchor-link widget with a `<button>`. There were nine headings before extraction and zero after it. The service now rebuilds each heading as a plain element first.
- ✅ **The footnote text was lost and the markers stayed as single numbers.** The service now collects the footnote text from the original document before Readability removes it, and writes a Footnotes section. The markers now show as `[1]` and do not join to the word before them.

Also corrected: the `CLIPPED` response said that the images were in Notion. Nothing verified this. It said this for a run whose images were not correct.

---

## M4 — Lead image ✅

If the main image of an article is **outside** the body of the article, the service lost it. Nothing failed and nothing was in the log. The service collects images only from the output of Readability. Therefore it never saw an image above the article root. This was confirmed in the code before the work started: a TechCrunch document has 8 images and the extracted body has 2, and no filter is the cause.

- ✅ `src/lead-image.ts` selects a candidate from the area between the top of the document and the first true body paragraph. This area contains both locations where a main image can be: above the `<h1>`, and inside the body before the text. The code excludes SVGs, filenames that show page furniture, images smaller than 200px, tracking pixels, `data:` URIs, and images inside page chrome. It operates before Readability, because Readability changes the document that it receives.
- ✅ The code removes duplicates by a normalised URL: the host and the path, with no query string. The same file appears at two different CDN sizes in the two locations. The code also removes the WordPress `-1024x683` size suffix, which is the same problem in the path.
- ✅ **The code does not use metadata as an alternative.** In the test article, `og:image` is a **body** image at a different size. An alternative that used it would insert a duplicate and still lose the main image. On Substack, `og:image` is an automatic social card with the headline in the image. Examine this again only if the logs show a group of websites that need it.
- ✅ The service puts the image below the `Source:` line and above the first heading. It does this before image import, so the image goes into Notion, and it uses a link only in the same conditions as a body image.
- ✅ The log messages are `lead_image_found`, `lead_image_skipped_duplicate`, `lead_image_none`, and `lead_image_rejected`. The last two are the most important. They are the only method to tell "this website has no main image" from "the exclusions are too strict".
- ✅ 19 tests. These include the duplicate removal, both modes that write nothing, and the requirement that a lead image can never cause a clip to fail.
- ⬜ **The first deploy used `LEAD_IMAGE_MODE=detect`.** Selection operates and writes log messages, but writes nothing to the page. Change the value to `insert` after you read the logs from a group of real clips. ⚠️ A change to a Netlify environment variable needs a deploy before the functions receive it.

**Detect mode found a defect before the deploy.** The chrome exclusions matched the text `newsletter`, which rejected **each** Substack main image. Substack gives the article element the class `newsletter-post`. Selection over a real post found this. After the correction, the code never classifies an `<article>` or `<main>` element as chrome, whatever its classes are.

Tested against live HTML, read on 2026-08-14:

| Website | Result |
|---|---|
| TechCrunch (test article) | Found the main image above the `<h1>` and captured the credit line. Rejected both site logos. It is not a duplicate of either body image. |
| Ars Technica | Found the main image before the first paragraph, 1920×1080. Rejected nothing. |
| Noahpinion (Substack) | Found the main image with its Unsplash credit. Rejected five avatars because they are too small. |
| Astral Codex Ten | No candidate. The post has no images. The code correctly did not use the `og:image` social card. |
| MDN | No candidate. Rejected nothing. |

### Detect mode in production: the first four live clips (2026-08-14)

The deploy was the commit that added the lead-image detect mode (2026-08-14). Each result was correct. **The service would have inserted nothing on any of the four articles**, because each article already had its main image inside the body.

| Clip | Log message | Compared with the source |
|---|---|---|
| peterdarbyshire.com (WordPress) | `lead_image_none`, 0 rejected | Correct. The page has 11 images. All of them are sidebar book covers, WordPress logos, or a tracking pixel, and all are after the first paragraph. `og:image` is an empty placeholder. |
| archdaily.com | `lead_image_skipped_duplicate` | Correct. The main image **is** the first body image. The two URLs differ only by a cache query string. |
| techcrunch.com (AI-pilled) | 2 × `lead_image_rejected` (SVG), then `lead_image_skipped_duplicate` | Correct. It rejected both site logos. The main image of this article is inside the body, which is different from the test article. |
| grimoiremanor.substack.com | `lead_image_none`, 2 rejected (40×40 and 36×36 avatars) | Correct. The post starts with a paragraph, and the main image is after it, inside the body, where the service clipped it. |

The service rejected four page-furniture images, rejected no true main image, selected no incorrect candidate, and removed duplicates correctly on two different CDNs. One type of evidence was still not present: a live `lead_image_found`. Do not change the mode until the service clips an article whose main image is **above** the body in detect mode. The original test article is a certain example.

- ✅ **Changed to `insert`** on 2026-08-15. The change is to the default value in `config.ts` and not to a Netlify environment variable. An environment change needs a deploy, and a default in the code is one less item to remember. To return to the previous behaviour, set `LEAD_IMAGE_MODE` to `detect` or `off` in the Netlify interface.

**Complete when:** a clip of the test article with `force` shows the pattern image at the top and the Yaris photograph exactly one time. **Complete on 2026-08-15.** The calling session confirmed this:

- The test article was clipped again with `force: true`. The result has three images. The main image is directly below the `Source:` line with its credit. The Yaris photograph is present exactly one time. All three images come from `prod-files-secure.s3...` and none uses a link to the source website.
- A new TechCrunch clip used its Getty main image and rejected four candidates that a less strict rule would have used: two site logos, an event advertisement, and **the author photograph**. The author photograph is a true JPEG near the article. Only its 150px width and its filename show that it is page furniture. The caller expected that this image would pass the filter.
- Neither page has an incorrect image: no logo, no avatar, no advertisement, and no duplicate of a body image.
- `TOOL-BRIEF.md` section 5 now says that the service captures lead images. ⚠️ **A person must update the Notion copy and the caller's system prompt.**

---

## M5 — Make "did it operate?" an answerable question ✅

The calling session asked for this after three clips with `force` that it could not verify. It is more valuable than it looks. That question used all of the time that evening, and not the clips.

- ✅ **`netlify/functions/health.ts`** reports the deployed commit, if each necessary secret is present (never its value), and the current settings. It gives `200` if the configuration is correct and `503` if it is not. **CLAUDE.md described this endpoint as the post-deploy check, but the endpoint did not exist.** A request gave the 404 page. Therefore that check had never operated.
- ✅ **`clip_status` now reports when the service wrote the clip**, as an absolute time and as a relative time. It reads the Notion `created_time` of the header block. Therefore the service writes nothing new to the page, the tool contract does not change, and the duplicate-check key does not change. A clip with `force` deletes the old header and writes a new one, so the time changes only when a run occurs.
- ✅ `IN_PROGRESS` reports when the run started. Therefore an old marker shows that a run stopped.
- ✅ A known limit, accepted on purpose: Notion records the creation time of a block to the minute. Therefore you cannot tell two runs apart inside one minute. This value is a **report** and never an input to a decision. No code branches on it.

### The time value operated correctly on its first use

Tested on 2026-08-15. The sequence is not the expected one, so it is recorded here. A clip with `force` gave these three results in this order:

1. `CLIPPED` — `Clip written: 2026-08-14 20:59 UTC (4 hours ago)` ← **this is the previous clip**
2. `IN_PROGRESS` — `Run started: 2026-08-15 00:31 UTC (1 minute ago)`
3. `CLIPPED` — `Clip written: 2026-08-15 00:32 UTC (moments ago)`

**An old `CLIPPED` arrives before `IN_PROGRESS`.** The service started the run, but the run had not yet written its marker. Therefore the tool read the page and correctly found the old clip. Before the time value, that first response looked the same as a success. This is the reason that three earlier clips with `force` could not be verified.

**A request that the project did not build on purpose: `clip_status` gives `IN_PROGRESS` in place of an old `CLIPPED`.** This is not possible. `clip_status` reads the page and nothing else. There is no job store. Therefore a run that has not yet changed the page is not visible to the tool. Also, a page clipped last week is correctly `CLIPPED`. A rule such as "an old time value means that a run is coming" would give an incorrect report for each usual status check. The time value replaces the knowledge that the tool cannot have. The tool message now tells the caller to read it after a clip with `force`.

### ⚠️ Netlify function logs lose entries — confirmed 2026-08-15

I told Wil that the three `force` attempts from the caller "never arrived at the function". The evidence was that the page id was not in three hours of logs. **That conclusion was incorrect, and the method behind it is not safe.**

I made a `clip_status` call myself. It gave a correct answer that was specific to the page, so it certainly operated. That call **was not in the logs at all**, immediately or five minutes later. Entries also arrive some minutes late and in an incorrect order.

Therefore the logs are useful as positive evidence: if a line is present, the event occurred. The logs are **not usable as negative evidence**: if a line is not present, this shows nothing. Check each conclusion of the form "there is no log entry for X" against a different source. This is the reason that the health endpoint and the clip time value are worth their deploy. Both answer questions that the logs cannot answer.

---

## M6 — Images that never became images ✅

Reported from real use. An ArchDaily project page clipped 2 images from an article with 21 images. A Divisare project clipped **no images**. Both clips reported success. The diagnosis counted the images at each stage and did not read the websites. The output of Readability had 21 images and 33 images. Therefore no image was lost before the converter. The converter removed them.

**Cause: the converter changed an `<img>` inside an `<a>` into link text.** `<a>` is an inline tag. Therefore an image inside a link was in a run of text, and `collectRichText` changed it into a link that carries its alt text. The image was not present. A large group of websites publishes photographs in this format, because each photograph links to its full-size version or to a lightbox. Therefore this was not one difficult website. ArchDaily lost 18 of 21 images. Divisare lost all 33 images.

- ✅ An inline wrapper that holds an image and no text is now a block. This applies in all three locations that divide inline content from block content. A true inline image, such as an icon inside a sentence, does not change. The "no text" condition gives this protection.
- ✅ A paragraph that has no words but has an image inside it converts as a figure. Divisare publishes each photograph in this format.
- ✅ A list item that holds only an image gives the image and not a bullet. The ArchDaily gallery is `ul > li > a > picture > img`, eleven times. As bullets, they would show as a list with no content.

**Two more defects appeared during this work. Both are older than this change.**

- ✅ **`pickImageUrl` did not read the `<img>` inside a `<picture>`.** The figure path and the gallery path supply the `<picture>`, whose own attributes are empty. Therefore a `<picture>` with no `<source>` gave no URL, and a `<picture>` with only a phone-size source gave the small image. A test for a different subject found this.
- ✅ **The phone-size `<source>` had a higher rank than the full image.** `<source media="(max-width: 767px)">` is the small copy. The code selected it, so Notion stored a 6KB small image and the 98KB photograph stayed on the source website. The code now gives these sources a lower rank but does not remove them. A first version removed them, which deleted images: on a lazy-loaded image, the mobile source is sometimes the only true URL in the HTML. A small copy is better than no copy.
- ✅ Loading animations are no longer photographs. One real clip stored `assets.adsttc.com/doodles/flat/loader-white.gif` in Notion permanently.

Measured before and after the change, on the reported articles and on four articles that earlier tests used:

| Article | Before | After |
|---|---|---|
| Divisare project | **0** | 33 |
| ArchDaily project | 2 | 15. Twelve of these are `medium_jpg` and not small images. |
| Ars Technica review | 9 | 12 |
| Noahpinion (Substack) | 2 | 3 |
| TechCrunch test article | 3 | 3. No change, as intended. |
| MDN and Astral Codex Ten | 0 | 0. Neither article has body images. |

Seven tests. Two of them keep the correction accurate: an icon inside a sentence must not divide the paragraph, and a photograph with the name `loaders-at-work.jpg` must pass the loader filter.

**Complete when:** Wil clips both reported articles again with `force: true` and sees the full set of images. **Complete on 2026-08-15.** ArchDaily gave 15 images, with all 15 in Notion and none as a link. Divisare gave 33 images, with 29 in Notion. This was confirmed against the function logs and by a review of the pages. The images show correctly.

---

## Backlog

Write new work here. Do not correct it immediately.

**⬜ A status rule is not tested until a test reads it DURING a run (recorded 2026-08-17).**

Three defects came from one blind spot, and each of the three was found by a live test and not by the test suite. Each test in the suite gave `deriveClipStatus` a page in a **settled** condition: a finished clip, or a failure, with no run in operation. But the caller reads the status **while a run operates**. That is the purpose of `clip_status`. Therefore the condition that the suite never made was the condition that the tool is in most of the time.

The three defects:

1. An old error callout hid a **complete** clip. Found by a live test.
2. The first correction compared only times, and two runs seven seconds apart recorded the same minute. Found by a live test.
3. The second correction examined only a **complete** clip, so each read **during** the new run continued to give the old error. Found by a live test.

**The rule for new work: when you add or change a branch in `deriveClipStatus`, write the test for the page as it is in the middle of a run.** The page then has a progress callout, and frequently also a marker from an earlier run. A test with a settled page does not test the state that the caller reads.

An audit of the branches on 2026-08-17 found **two more conditions with no test**, and the code was correct in both. They now have tests:

- A run that operates, on a page that holds content from the Web Clipper. This is the documented recovery path, from end to end: a clip fails, the message tells the user to use the Web Clipper, the user does this, and later the user asks for a clip again. `foreign_content` would tell the caller "nothing operates, do not read this again" about a run that operates.
- A run that operates, with an old error callout and with its own header already written. This is the condition that each usual re-clip passes through.

**⬜ `foreign_content` cannot carry a run identity, and this is correct (examined 2026-08-17).**

Examined after the error-callout work, because that correction used the `clip_id` in a marker and `foreign_content` has no marker. **There is nothing to correct.** The state is reached only when the page has no error callout, no progress callout, and no clip header. Therefore there is no marker of this service on the page, and no `clip_id` can exist. The absence of an identity is the definition of the state and is not an omission.

One characteristic to know, which is not a defect. `markerCreatedAt` for this state is the **newest block on the page**, because there is no marker to read a time from. Therefore a person who writes a note on such a page moves the `Last change:` time, and the page looks as if something occurred recently. This has no effect, because the response says clearly that nothing operates and that the caller must not read the page again. The time is a report for a person and not a value for a decision. Do not make a decision from it later.

**✅ An old error callout hides a clip that operated. A page can report `FAILED` permanently although it holds a complete article. Corrected and approved (2026-08-16).**

**Confirmed by the caller on 2026-08-17, in the difficult condition.** The failure and the clip that followed it were **seven seconds apart**, and both blocks recorded `00:36`. Therefore the times were equal and could not put the two runs in order. The page gave `CLIPPED` with the note about the old callout. A result with two **different** minutes would have been a weaker test, because the first version of the correction would also have passed it.

**The correction, deployed on 2026-08-16.** Three parts, and none of them deletes a block.

1. `deriveClipStatus` now decides by **ownership** and not by time. An error callout whose message does not contain `PARTIAL_WRITE_MARKER` is from a run that wrote no content. That run cannot be the author of an article on the page, so its error cannot describe that article, and a clip that is not older than it has a higher rank. The time is a floor only: a clip that is **older** than the error is from an earlier run and is not the result of the run that failed. Both times must be present, because nothing can be put in order without them.

   ⚠️ **A run that operates also has a higher rank than an earlier error.** A second live test found this. The correction above examined only a **complete** clip, so each `clip_status` call **during** the new run continued to give the old error. The window between the start of a run and its first write is exactly the window in which a caller reads the status, so the second test found this immediately. A run writes its progress callout first, and `reportFailure` changes that same block. Therefore a progress callout and an error callout with different `clip_id` values are necessarily two different runs, and the run that says "in progress" is the current one.

   ⚠️ **A time alone is not sufficient, and a first version of this correction used a time alone. It failed the first live test.** That version needed a header that was strictly newer. Notion records a time to the minute, and a website that refuses a request fails in approximately one second. In the test, the failure and the clip that followed it were **seven seconds apart**, both blocks recorded `23:44`, and the equal times gave `FAILED` for a page that held the complete article. Do not return to a rule that compares only times.
2. `ClipStatus` now gives `markerClipId` and, for `failed`, `markerCreatedAt`. Both callouts already contained the `clip_id`. Nothing read it. `awaitOwnRun` now refuses a `failed` result whose `clip_id` is not its own and continues to wait.
3. The service now selects the **newest** error callout and not the first one. The writes are appends, so an old callout is above a new callout. The first callout is the incorrect end of the page, and reading it would also hide the failure of the current run behind an older failure.

The `CLIPPED` response now contains a `⚠️ NOTE` with the text of the superseded error, because the callout stays on the page. `FAILED` now reports `Error written:`. Eight tests. `TOOL-BRIEF.md` section 3 changed in the same commit. ⚠️ **A person must update the Notion copy.**

The original report:

Found by the test session after the secret rotation. The caller reported it correctly and could not tell the cause from the tool output, because the tool gives no value that shows the cause.

The sequence. A clip of `fantasyliterature.com` failed with a true 403 (`clp_11bxvfs0`) and left an error callout. The caller then called `clip_article` again on the **same page** with a different URL, `sfbook.com` (`clp_na0cmtz7`). That run operated fully and wrote the complete article. Each `clip_status` call after it gave the **old** `fantasyliterature.com` error, with the old `clip_id`.

**The cause is the order of the tests in `deriveClipStatus` (`status.ts:106`).** It looks for an error callout first, before the progress callout and before the clip header. A run without `force` never deletes an error callout: `clearPreviousClip` is the only code that deletes an `ERROR_MARKER` block (`pipeline.ts:242`), and it operates only inside `if (request.force)` (`pipeline.ts:106`). Therefore the page gives `failed` continuously. This does not correct itself, and the value is not late. It is incorrect.

**This also defeats `awaitOwnRun` (`status.ts:288`).** That function exists to prevent a borrowed result. It finds the marker of its own run, then calls `deriveClipStatus`, receives the old `failed`, sees a state that is not `in_progress`, and gives that state as the result of **its own** run. It protects the **start** of a run and does not protect the **result** that it reads.

**Why this is more than an incorrect message.** Rule 4 of the caller says: never try again after `FAILED`, and give the cause to the user. Therefore the user hears "the website refused the request" about a page that holds a correct article, and the message tells the user to use the Web Clipper. That action writes the article to the page a second time.

**The two values that are necessary are almost present already.**

- The error callout already contains the `clip_id` (`pipeline.ts:286`). Therefore the page knows which run failed. `ClipStatus` does not read this value, so nothing can compare it.
- `failed` is the **only** state that gives no `markerCreatedAt` (`status.ts:110`). `clipped`, `in_progress`, and `foreign_content` each give one. Therefore the caller has a time value for each state except the one state where a stale value is dangerous.

A possible correction, for a decision and not for immediate work: give `markerCreatedAt` and the `clip_id` of the failure to the `failed` state, then let `awaitOwnRun` refuse a `failed` result whose `clip_id` is not its own. Do not delete the callout automatically. ⚠️ `deriveClipStatus` is a pure function with tests, and the order of its tests is deliberate: an error callout must have a higher rank than partial content, because a run that fails after a partial write leaves both. A correction must keep that rank and must separate "an error from **this** run" from "an error that is already on the page".

The test page is `clip2notion rotation test` (`3be87615-cd32-818b-8f74-e489c25317d7`). It holds the sfbook article, the old error callout, and a URL property that still gives the fantasyliterature URL. Keep it. It is the test case.

**✅ `mcp.ts` accepted the token from two routes that nothing uses. Removed and approved (2026-08-16).**

From a security audit. `providedToken()` read the token from four locations: the `/mcp/<token>` path segment, a `?token=` query string, an `Authorization: Bearer` header, and an `X-Clip-Secret` header. The last two of these four were never used. The connector uses the path. A terminal test uses the header.

The query string is the least safe of the four. A query string goes into proxy logs, referrer headers, and analytics much more easily than a path does. Code that reads it also lets a client that is configured incorrectly change to that weaker route with no message and no failure.

The service now reads the path segment and the `X-Clip-Secret` header only. A request that carries the token only in a query string is now unauthenticated and receives a 401. **This is the intended result.** `redactPath()` did not change. The `has_query` log field also did not change: now that the query form is refused, that field is the signal that a client sends a token to a location that the service no longer reads. `clip.ts` and `clip-background.ts` did not change. Both authenticate with the header only.

`TOOL-BRIEF.md` and `README.md` changed in the same commit, because both said that the server accepts `?token=`. ⚠️ **A person must update the Notion copy of `TOOL-BRIEF.md`.**

**⬜ `loudersound.com` refuses all clients, not only this service. Not investigated (found 2026-08-16).**

This website failed on the same day as `ecuad.ca` and through the same `BLOCKED` path (`clp_id5huito`, HTTP 403). But it is **not** the same problem. `ecuad.ca` refuses Node and supplies the article to curl. `loudersound.com` gives 403 to curl also, from a residential IP address with a browser user-agent. This is a stronger block, and the cause is not known.

Read this before you spend time on it. The correction for `ecuad.ca` changed a **message** and did not change access. This website already receives the corrected message. Therefore there is no defect that the user can see. There is only an open question: can the service read this website at all? This item stays open until a real clip needs it.

**✅ `clip_status` gave `IN_PROGRESS` continuously for any page that the Web Clipper filled. Corrected and approved (2026-08-16).**

The correction has two steps. First, the orphan-content branch received a time value: the newest block, in place of the marker that it does not have. Therefore the fifteen-minute rule of the caller had a value to use. Second, the state was corrected. There is a new `foreign_content` state and a `STATUS: FOREIGN_CONTENT` value. It means "there is content on this page and this service did not write any of it". This is the only statement that the list of blocks supports. ⚠️ **A person must add the new value to the Notion guide and to the caller's system prompt.**

The original report:

This was discovered immediately after the correction below, on the same page. The clip failed. Wil then used the Notion Web Clipper, as the message instructed. The page then gave `IN_PROGRESS` to ten `clip_status` calls, including the first call, before any code called `clip_article`.

No run operated. The page has no marker: no progress callout, no error callout, and no `Source:` header. `deriveClipStatus` continues to the orphan-content branch (`status.ts:136`). It counts approximately 30 content blocks against an `orphanContentThreshold` of 5, and concludes that a run is writing the page. `markerCreatedAt` is not present, because there is no marker with a time. Therefore the caller also loses the fifteen-minute limit and cannot decide that the run stopped.

**The important part is which path causes this.** The Web Clipper is the **documented alternative** for a `BLOCKED` failure. Therefore the recovery that the service tells the user to do is the action that makes the status endpoint incorrect. The caller can then never read the status of that page.

The correction is not simple, which is why this was recorded and not corrected immediately. The branch exists to prevent `NOT_STARTED` for a page that holds a partial clip, because that sends the caller to a clip without `force`, which writes a second copy. `not_started` is correct for a Web Clipper page and dangerous for a partially deleted clip, and the list of blocks does not show the difference. Three options: look for a signature from the Web Clipper; require a clip2notion marker before the code gives `in_progress`, because the progress callout is now always first; or give a fourth state that means "there is content and none of it is ours".

The caller operated correctly. It stopped, refused to call `clip_article` for a page that reported an active run, and asked a question. The action was correct although the cause that it gave was incorrect.

**✅ The service reported a 403 to the user as a paywall. The messages are now separate. Approved (2026-08-16).**

`ecuad.ca` failed a clip (`clp_km0rcf25`) with this message: "Paywall or bot-block detected — this article can't be fetched without a login." The article is free and open. The website is also open.

The cause was measured and not estimated. **Cloudflare refuses this service because of the TLS fingerprint of Node. It does not refuse because of the headers or the Netlify IP addresses.** From one residential machine, with the same IP address and the same three headers: curl with HTTP/1.1 gave 200; Python gave 200; Node `fetch` gave 403; `node:https` gave 403. curl with the exact header set of undici, in the same order, still gave 200. Changes to the cipher list and to `ecdhCurve` in Node changed nothing. Also of note: undici replaces `Sec-Fetch-Mode: navigate` with `cors` and does not report this, so `fetch` cannot show itself as a document navigation. That was not the cause.

**Therefore "send browser-like headers" is not a correction, and the project did not ship it.** The control is below the header layer, and the TLS stack of Node does not make it available. This is recorded here so that nobody proposes it again.

What the project shipped: `errors.blocked` is now four constructors: `paywalled`, `refused`, `botChallenge`, and `rateLimited`. All four keep the `BLOCKED` code and stay non-temporary, so the retry behaviour does not change. 401 and 402 give a paywall message. 403 and 451 give a refusal message. 429 gives a rate-limit message. The upstream status is now an `http_status` log field and not only text inside `detail`. `TOOL-BRIEF.md` changed in the same commit. **A person must update the Notion copy and the caller's system prompt.**

Two open questions:

- **This affects many websites, not one website.** Any website with strong bot protection does this. On the same day, `loudersound.com` failed with the same symptom and a **different** cause: it gives 403 to curl also, so it blocks all clients and not only this fingerprint. The service reported both to the user as a paywall. If more of these occur, examine a fetch proxy service. That adds one external dependency to each clip, so it is not necessary now.
- **The Web Clipper is the only method for `ecuad.ca`**, until the university changes its settings. There is nothing to correct in the service.

**Found during tests with real articles (read, extract, and convert only; no Notion operations):**

- ✅ Corrected: `blog.rust-lang.org` answers a moved URL with a **200 response whose body is a meta-refresh page**. `fetch` does not follow these, so the clip failed as "not extractable" for a correct article. `metaRefreshTarget` now follows a refresh with a short delay on a small page. There is a test for this.
- **Wikipedia infobox tables become an HTML code block** that keeps all of the data, because they use `colspan`. This is correct by the rules but is not easy to read. The problem is not the handling of merged cells, so do not correct it by a change to the merged-cell rule. There are two specific problems. First, the code block is at the **top** of the article, where the reader sees it first. Second, the infobox image is inside that code block, so it never reaches the image importer and stays as a link. If this occurs on real clips, the probable correction is to detect infobox-shaped tables, ignore them, and import the image separately. It is not a change to table conversion. Wikipedia is not a target website, so this item waits for a real occurrence.
- Tested against real HTML and correct: image URL resolution (12 images from a Wikipedia article and 6 from a NASA page, all absolute and all real), code-block language detection, the structure of headings, lists, and quotations, and the 2,000-character rich-text limit.

**A bug in the first real MCP clip: the code divided srcset URLs that contain commas. Corrected.**

The Substack images gave 404 errors and pointed at `noahpinion.blog` and not at the CDN. Cause: `fromSrcset` divided the attribute at each comma. But image CDNs put commas **inside** the URL, in Cloudinary-style transforms such as `.../fetch/$s_!ElHF!,w_424,c_limit,f_auto,q_auto:good,fl_progressive:steep/...`. The division made fragments. The largest fragment was a relative path, which resolved against the path of the article.

The code now follows the HTML specification, where **whitespace ends a srcset URL, not a comma**. Tested against the live article: all three images give `200 image/webp` from `substackcdn.com`. There is a test with the real HTML.

This shows a limit of the earlier tests. The test fixtures used simple markup such as `srcset="/w400.jpg 400w"`, which the incorrect parser handled correctly. Only a real CDN URL showed the bug. The alternative path operated as designed: the failed import used an external link and did not remove the image. But the link was already incorrect.

**A bug in the M2 clips: the code loses code-block languages on MDN-style HTML.**

All 30 code blocks in the MDN clip showed as `plain text`, and the name of the language became a separate paragraph above each block. The cause was confirmed and not estimated. After Readability operates, MDN has no `class` on the `<pre>` (`first <pre> class: null`). MDN puts the language in a **sibling** element: `<div><p><span>http</span></p><pre><code>…</code></pre></div>`. Therefore `detectLanguage` has nothing to read, and the label element converts to a paragraph like any other unknown content.

One cause, two symptoms. The correction: when the code converts a `<pre>`, it must check the previous sibling and the first child of the wrapper for a short text node that matches a known language. If it matches, use it as the language **and** remove the paragraph. This is not urgent. No content is lost, and the code is correct and formatted correctly. It has no language name and one additional word above it. But it affects each clip from any website that uses this common format.

**The template timing problem: reported in a review, then disproved by a test. Closed.**

The report: Notion applies templates asynchronously. Therefore a page from a template is empty for a short time. The service writes to the end of a page. Therefore a template body that arrives during a clip would mix with the article.

I told the caller to wait until the template body arrived. **That instruction was incorrect and caused a deadlock in the next test.** A caller followed the instruction correctly, read an empty page two times, and stopped. It waited for content that was never going to arrive.

The cause, confirmed on 2026-08-13: **at that time each template in the database had an empty body.** The default template and the named templates set **properties** (Status, Areas, Tags) and added no content. There was nothing to wait for.

⚠️ **This is no longer correct.** The templates changed on 2026-08-14 to `[New resource] <v1.0>` and similar names. They now add a version toggle and a divider. The instruction does not change (clip immediately and never wait), but the reason above is history and not the current state. This change also caused a second defect, which is below.

Two conclusions to remember:

1. **An instruction of the form "wait until X appears" causes a deadlock if X can never appear.** The instruction needs a method to tell "not yet" from "never". An empty page gives no such signal, because it looks the same in both conditions. The caller could not test this instruction.
2. **Confirm that a reported problem applies before you design for it.** The timing problem is real in theory. It was not real for this database. One read of the template would have shown this before the instruction shipped.

**Notion MCP reads may use a cache. The test caller reported this.**

Two `notion-fetch` calls for the same page gave an identical `as of` time value. Therefore the second call may have used a cache and not read the page again. This is important for any method of the form "read two times and compare", which includes a check of the progress of a background clip. `clip_status` uses the Notion REST API and not the MCP connector, so it does not have this problem. But a caller that reads the page again to confirm a result can have it.

**The templates gained a body, which broke status detection (2026-08-14). Corrected.**

The database templates changed and now carry a version toggle and a divider. `deriveClipStatus` read **any** content with no header as a clip in progress. A protection added some days earlier caused this. Therefore a new page gave `IN_PROGRESS` although no run operated. A caller would then read the status repeatedly and report that the run stopped.

The code now needs sufficient content to look like a partial article and not like template furniture (`ORPHAN_CONTENT_THRESHOLD`, default 5 blocks). The clip with `force` also writes its own progress callout, so the content count is a second protection and not the only protection.

The work also made `selectBlocksToDelete` a pure exported function with tests. Template furniture is now above each clip, and a test is a better protection for a destructive operation than a reading of the code. The tests confirm four things: content above the clip header stays; old callouts are removed; the marker of the current run stays; and a URL that the service never clipped removes nothing.

**A caller sets properties that a template also sets:**

The templates now set properties. A property that a caller sends with `template_id` replaces the template value and does not add to it. Therefore a caller that sets properties can remove the Area that the template set, with no message. The service never changes properties, so this is not a defect in the service. But it belongs in the caller's system prompt.

**A cold container uses the time budget of a synchronous function. Reduced, not removed.**

`mcp.ts` imported jsdom through the converter. Therefore a cold container used some seconds to start before any handler code operated. The 10-second Netlify limit includes this time, but a handler can measure only from its own start. Measured on a cold container: approximately 6 seconds for a call that does no waiting.

The correction detects a cold container (the handler starts within 1.5 seconds of the module load) and uses a much smaller wait limit. Therefore the total time stays below the limit. The full correction is to stop `mcp.ts` from importing jsdom: move the status logic and `assertSafeUrl` into modules that do not import the converter or Readability. That is a change to code that operates, so it needs a decision and not an immediate change.

**Update 2026-08-14: the transport errors are not caused by this service.** Three `clip_article` calls gave transport errors to the caller. The function logs show that these same calls were on a **warm** container (`cold_start: false`) and returned in **549ms and 1736ms**. This is much less than the 10-second limit and less than the approximately 3-second budget of the adjustable values. Nothing in this service was slow. The remaining possible causes are the connector transport or the method of response delivery. Examine these before you reduce the wait budgets again, because a smaller budget would remove certainty from the caller for no benefit.

The protections operated correctly during this period. Each caller used `clip_status` and did not try again. Each URL produced exactly one `clip_start`. No page received two copies. The clip times were 3.0s, 6.8s, 7.3s, and 7.9s. The pipeline is not the slow part.

**Known limits, shipped on purpose:**

- **`force: true` removes notes that a person added below a clip.** The range of a clip is "from the header to the end of the page", because the service only adds content to the end. Content above the header does not change. An exact range would need a footer marker block on each clip. That is a permanent visible object for a problem that has not occurred. Examine this again if it occurs.
- **A clip with `force` deletes the blocks one at a time** at approximately 3 requests each second. Therefore a clip of a 300-block article uses approximately 90 seconds to delete before it starts. This is much less than the 15-minute limit, but it is not fast.
- **A table with more than 100 rows becomes an HTML code block** and the service does not add the remaining rows in a second call. No data is lost, but it is not easy to read. This is rare, so it waits for a real occurrence.
- **A table cell holds only rich text.** This is a Notion limit. Block content inside a cell becomes text.
- **The service removes an image inside a table cell.** A cell cannot contain an image block. There is no alternative at this time. If this occurs in a real article, write the image below the table.
- The service makes list levels deeper than 2 into level 2. It does not remove them.

**Readability removes images with captions on Substack. Found during the lead-image work (2026-08-14):**

This is not the lead image, and this work did not correct it. In a real Noahpinion post, four content images are inside `div.body.markup`. The converted body has **two**. The two images that are lost are the two with a `<figcaption>`. The credit lines "Photo by Joe Dudeck" and "Illustrative diagram adapted from Lennart Heim" are in the raw HTML two times and in the extracted content zero times, with each `captioned-image-container`. Therefore Readability removes the full figure and not only the caption.

This is a loss of content with no message, on a website that is already difficult (it also removed the headings and the footnotes). It has the same form as those problems: the clip reports success and the page looks correct. The correction uses the same method: rebuild or save the figures before Readability examines them. But it is a separate change from the lead image, and it needs evidence about how many websites have this problem.

One effect to know now: the main image of that post is one of the removed images. Therefore the lead-image step inserts it and does not identify it as a duplicate. This is correct today. It also corrects itself if a person corrects the Readability problem, because the duplicate check will then find it.

**An `<img>` can point at a PDF, and four did (2026-08-15):**

The second Divisare clip stored 29 of 33 images and used links for 4. All four are the **architectural drawings** of the project. Divisare publishes these inside `<img>` tags that point at `.pdf` URLs. The CDN serves `application/pdf` whatever the `Accept` header says, and a request for the same file as `.jpg` gives 404. Therefore the link is correct: the Notion importer cannot accept a PDF as an image. But those four drawings are now links to Divisare, which is the exact problem that this service removes. They can also show as broken images on the page.

The correction is to import a file that is not an image as a Notion **file block** and not as an image block. `POST /v1/file_uploads` accepts PDFs, so the drawing would be in Notion and a person could open it. That is a new block type in the converter. Do this only if it occurs again. On architecture websites it will probably occur again, because plans and sections are usually PDFs.

**Reviewed on 2026-08-15 and not built, on purpose.** The page is easy to read as it is. The cost is four drawings on the Divisare servers and not in Notion. This is a permanence problem and not a visible defect. Examine this again when a clip has a problem because of it.

**Not corrected in the M6 image work, on purpose:**

- **An author photograph can still reach the page.** The ArchDaily "about the author" photograph converts like any body image. The lead-image selector rejects photographs by filename, but the same filter on body images could remove a true photograph whose filename contains `icon`. That is a worse result than one additional avatar at the end of an article.
- **A gallery repeats photographs that the body already shows.** The ArchDaily gallery contains each photograph, so the two photographs in the article body are present two times. The source page shows the same. A duplicate check between body images is a larger decision than it looks, because an article can repeat an image on purpose.
- **The largest version is not always available.** The ArchDaily full-size images are behind one HTML page for each photograph. To follow those links, the service would need a new capability: one additional read for each image. `medium_jpg` at 98KB is sufficient to make the full set usable, so this stays unbuilt until something needs it.

**Ideas, with no priority:**

- Try a failed image import one more time before the service uses an external link
- Extraction rules for specific websites that Readability handles incorrectly
- A `dry_run` flag that returns the block tree and writes nothing, to debug the conversion
- Video and embedded content. The service removes these now. The correct Notion format is not known.
- A limit on the total number of image bytes for each article, because workspace storage is finite
