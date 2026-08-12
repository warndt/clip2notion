# Caller prompt snippet

> # ⛔ SUPERSEDED — DO NOT PASTE THIS INTO A CLAUDE PROJECT
>
> **This file describes an HTTP calling convention the intended caller cannot use.**
>
> The caller is a Claude session in the claude.ai chat interface. That environment
> cannot POST to `<your-site>.netlify.app` — its sandbox refuses non-allowlisted
> hosts at the egress proxy (`x-deny-reason: host_not_allowed`), and its fetching
> tool is GET-only and cannot set an `X-Clip-Secret` header. Verified 2026-08-12,
> not assumed.
>
> The instructions below are accurate for a **terminal or any environment with
> unrestricted outbound HTTP**, which is how the service was tested. They are wrong
> for the client this project is actually built for.
>
> This file is frozen pending the entry-point decision (see ROADMAP M3). Rewriting
> it before then would just mean writing it twice. **Nothing here should be treated
> as the current contract.**

Paste the block below into the Claude project that creates Resources pages, filling in the two placeholders. Everything outside the fenced block is notes for you, not for the model.

**Before pasting:** replace `<SITE>` with the Netlify site name and `<CLIP_SHARED_SECRET>` with the current production secret. The secret goes in the project prompt because the calling session needs to send it — treat the project as holding a credential, and rotate both places together.

---

```markdown
## Clipping article text into a Resources page

After you create a page in **WDB | Resources** and set its properties, you can
have the article's full text written into the page body by calling the
clip2notion service. You do not write article content yourself.

### The call

POST https://<SITE>.netlify.app/.netlify/functions/clip

Headers:
  X-Clip-Secret: <CLIP_SHARED_SECRET>
  Content-Type: application/json

Body:
  {
    "page_id": "<the page you just created>",
    "url": "<the article's URL>"
  }

The endpoint is `/clip`. Do **not** call `/clip-background` — that is the
internal worker, and it answers 202 to everything, including requests it
rejects, so calling it directly means you cannot tell success from failure.

Add `"force": true` only when re-clipping a page that already has a clip on it.
It deletes the existing clip first. Never send it on a first attempt.

### What the response means

**202** — accepted, *not finished*. The article is being fetched and written in
the background, which takes anywhere from a few seconds to a few minutes for a
long illustrated piece. It can still fail after this point. Do not tell the user
the clip succeeded on the strength of a 202. Wait a short while, re-fetch the
page, and confirm (see below) before reporting success.

**401** — the shared secret is wrong or missing. **403** — the page is not in
the Resources database. Both are configuration problems. Stop, tell the user
which one it is, and do not retry — repeating the call cannot change the answer.

**400** — the request was malformed (bad page id, or a URL that isn't a public
http/https address). This is a bug in how the request was built. Report it
rather than retrying with variations.

**502** — Notion was unreachable, or the background job failed to start.
Nothing was written. Retry **once**. If it fails again, stop and report.

### Confirming the result

Re-fetch the page and look at its content:

- **The article is there**, led by a "Source: …" line linking to the original —
  the clip succeeded.
- **A ⏳ "Clipping in progress…" callout** — still running. Wait longer and
  check again. If it is still there after several minutes, the run died; report
  that to the user rather than assuming success.
- **A ⚠️ "Clipping failed" callout** — read it. It says what went wrong in plain
  language and what to do about it. Relay that to the user. Common cases are a
  paywall or bot-block (the service cannot log in to sites; the Notion Web
  Clipper browser extension is the fallback for those) and a page with no
  extractable article.

Report what you actually observed. A page that looks created but is empty is
worse than a clear failure, because it looks like success until someone opens it.
```

---

## Notes for testing (M2)

The first end-to-end run is also the first exercise of the Notion round trip. Worth watching on the first few:

- Does the progress callout appear promptly, and does it disappear on success?
- Are images actually stored in Notion (open one — a Notion-hosted file has an `amazonaws.com` URL behind it, not the source site's domain)?
- Check the function logs for `image_degraded` and `image_import_failed` events — those are images that fell back to hotlinks, and a high rate means something systematic about that site.
- Time a long illustrated article. If it approaches the 15-minute ceiling, `IMAGE_CONCURRENCY` and the poll intervals are the tunables to reach for.
