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

**`clip_article` starting successfully does NOT mean the article was clipped.**
It means the work began. It runs in the background and can still fail after
that response. Never tell me the article was clipped on the strength of it.

Always confirm with `clip_status` before reporting anything:

- **CLIPPED** — confirmed on the page. Safe to tell me it worked.
- **STILL RUNNING** — outcome unknown. Wait and check again. A long illustrated
  article can take a few minutes. If it is still running after about five
  minutes, say the run appears to have died — don't guess either way.
- **CLIP FAILED** — relay the message to me verbatim. It says what went wrong
  and whether retrying would help.
- **NOTHING CLIPPED** — the page is empty. Do not report success.

If a tool reports a failure, tell me what it said rather than retrying. Most
failures — a paywall, a page outside Resources, a bad URL — do not change on a
retry, and the message says so when that's the case.

Only pass `force: true` when re-clipping a page that already has a clip on it.
It deletes the existing clip first. Never on a first attempt.

Paywalled and login-walled articles are out of scope by design; the service
cannot log in to anything. Use the Notion Web Clipper browser extension for
those.
```

## Why it is shaped this way

The spike found that `isError` does **not** reach the model as a machine-readable field — what arrives is the harness's error wrapper plus whatever text the server wrote. So the tools lead every failure with an unmistakable marker (`CLIP FAILED`, `NOTHING CLIPPED`) rather than relying on a flag, and this prompt tells the caller to look for those words.

It also found the more dangerous gap on the *success* path: `clip_article` can only ever confirm dispatch, so a caller relaying it as "clipped" overstates what it was told with no error involved anywhere. `clip_status` exists to close that — it reads the page and gives an answer that can be checked instead of inferred.

## Notes for testing

- Images genuinely stored in Notion serve from an `amazonaws.com` URL, not the source site's domain. That is the check that matters most.
- Function logs: `image_degraded` and `image_import_failed` are images that fell back to hotlinks. A cluster of them means something systematic about that site.
- If a long illustrated article approaches the 15-minute ceiling, `IMAGE_CONCURRENCY` and the poll intervals are the tunables to reach for.
