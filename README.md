# clip2notion

[![tests](https://github.com/warndt/clip2notion/actions/workflows/test.yml/badge.svg)](https://github.com/warndt/clip2notion/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

This service reads a web article and writes the full content of the article into a Notion page. The page must exist before you call the service.

The service keeps the structure of the article. It stores the images in Notion. It does not link to the images on the source website.

The service is small. It has approximately 2,000 lines of code and two dependencies.

**Status:** in use.

---

## The problem

I wanted a Claude session to file articles into my Notion database. The session must create the page, set the status, set the areas, set the tags, set the relations, and set the dates. The session must then put the article on the page.

Claude does the first part correctly. Claude cannot do the second part. There are two different reasons.

**Reason 1. An assistant cannot give you the text of an article that a different person wrote.** If you ask a model for the full text of an article with a copyright, the model does not give you the text. The model gives you a summary, a paraphrase, or a part of the text.

A summary is not a clip. A clip is the article. A summary is a different document about the same subject. If you open the page 6 months later, you find the summary and not the article.

**Reason 2. The structure of the content is not correct.** When a model writes the content again, the content loses the parts that make an archive useful:

- The headings become body text.
- The tables become paragraphs.
- The footnotes are not present, or the footnote numbers stay in the text with no footnote.
- The code blocks lose the name of the language.
- The images are links to the source website. If the source website changes, the links stop to operate.

The Notion Web Clipper browser extension does all of this correctly. But it is a browser extension. It needs a person, a browser, and a click. An automatic workflow does not have these.

## The solution

The service divides the work into two parts:

- **Claude makes the decisions.** Claude knows the subject of the article, the project for the article, and your method to file it. Claude creates the page and sets all of the properties.
- **The service moves the data.** Claude gives the service a `page_id` and a `url`. The service reads the HTML, uses [Readability](https://github.com/mozilla/readability), and changes the HTML into Notion blocks.

No model reads or writes the text of the article. The service does not write the text again, summarize it, or change it. The data goes from the source server into Notion. This is the same operation that the browser extension does.

Because of this division, you do not change the service when you change the properties of your database. The service does not read or write properties.

**The service stores the images in Notion.** It sends each image to the Notion file-import API. The clip continues to operate if the source website changes or stops to operate. If the service cannot import an image, it uses a link to the source image and writes a message in the log. The service does not remove the image.

---

## How the service operates

```
Claude session (claude.ai)
        │
        │  MCP connector, HTTPS
        ▼
    mcp.ts ──────────── Checks the request. Checks the parent of the page.
        │               Answers in approximately 1 second.
        │               The answer means the work started.
        │               It does not mean the work is complete.
        ▼
 clip-background.ts ─── Maximum time: 15 minutes
        │
        ├── Reads the URL. Uses Readability. Looks for a paywall or a bot-block.
        ├── Changes the DOM into Notion blocks (tables, code, footnotes, lead image)
        ├── Sends each image to Notion
        └── Writes to the page in groups of 100 blocks
```

The HTTP response cannot contain the result, because the work continues after the response. Therefore the service writes the result on the page. First it writes a `⏳ Clipping in progress…` callout. Then one of two things happens:

- If the clip is successful, the service deletes the callout.
- If the clip is not successful, the service changes the callout into an error message.

The service supplies two tools:

- `clip_article(page_id, url, force?)` starts the clip. **The answer means the work started. It does not mean the work is complete.**
- `clip_status(page_id)` gives one of these results: `CLIPPED`, `IN_PROGRESS`, `FAILED`, `NOT_STARTED`, or `FOREIGN_CONTENT`.

[TOOL-BRIEF.md](TOOL-BRIEF.md) contains the full contract. It also contains the rules that prevent a caller from reporting a clip that did not occur.

### What the service does not do

- It does not create pages, set properties, or select a category. The caller does these.
- It does not log in to a website. If an article has a paywall or a login wall, the clip fails. The error message tells you to use the Web Clipper.
- It does not run JavaScript. If the article is only present after the browser runs JavaScript, the service cannot read it.
- It does not write the words of the article again, summarize them, or change them.

---

## How to install your own copy

### Requirements

- A Notion account and a database
- A [Netlify](https://netlify.com) account. The free level is sufficient for personal use.
- Node 20 or later. Production uses Node 22.

### 1. Make a Notion integration

Go to [notion.so/my-integrations](https://www.notion.so/my-integrations). Make an internal integration. Copy the token.

Open your database in Notion. Give the integration access to the database: `••• → Connections → your integration`.

If you do not do this, all calls give a 404 error. The integration cannot see a page until you give it access.

### 2. Find your data source id

Notion has two different identifiers. A **database** contains one or more **data sources**. This service needs the data source id.

```bash
curl -s https://api.notion.com/v1/databases/<DATABASE_ID> \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" | jq '.data_sources'
```

`<DATABASE_ID>` is the 32-character hexadecimal string in the URL of the database.

If you use a database id where the service needs a data source id, the parent check fails for each page. Each clip then reports that the page is not in the database.

### 3. Install the service

```bash
git clone https://github.com/warndt/clip2notion.git
cd clip2notion
npm install
npm test          # The tests do not use the network or Notion.
netlify deploy    # Or connect the repository in the Netlify interface.
```

Set these environment variables in **Site configuration → Environment variables**:

| Variable | Necessary | Description |
|---|---|---|
| `NOTION_TOKEN` | yes | The integration token from step 1. **Keep this secret.** |
| `CLIP_SHARED_SECRET` | yes | Make one with `openssl rand -hex 32`. **Keep this secret.** |
| `RESOURCES_DATA_SOURCE_ID` | yes | The value from step 2. There is no default value. Refer to [Security](#security). |
| `NOTION_API_VERSION` | no | The default value is the current version. Notion changes this value. Read the Notion documentation. |
| `LEAD_IMAGE_MODE` | no | `insert` (default), `detect` (writes a log message but does not change the page), or `off` |

⚠️ If you change an environment variable in Netlify, the change does not go to the functions until you deploy again.

To make sure that the installation is correct, send a GET request to `/.netlify/functions/health`. The response tells you which deploy operates and if each variable is present. The response does not contain the value of a variable. The response code is 503 if a necessary variable is not present.

### 4. Connect Claude

Add an MCP connector with this URL:

```
https://<your-site>.netlify.app/mcp/<CLIP_SHARED_SECRET>
```

The secret is a part of the path. The server refuses the `?token=` form and gives 401, because a query string goes into proxy logs and referrer headers. claude.ai also removes query strings, so that form never operated: the connector connects but supplies no tools.

The connector is only one part. The calling session also needs a system prompt. The prompt must tell the session to create the page first, then call `clip_article`, then call `clip_status` before it tells the user the result. You can copy [TOOL-BRIEF.md](TOOL-BRIEF.md) into a Notion page that the session reads.

### 5. Do a test from a terminal

```bash
curl -X POST https://<your-site>.netlify.app/.netlify/functions/clip \
  -H "X-Clip-Secret: $CLIP_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"page_id":"<a page in your database>","url":"https://example.com/article"}'
```

This endpoint checks the request and gives a response code. If the secret is not correct, the response code is 401. This makes a test easier.

---

## How to change the service for your use

The service has strong opinions about its method. It has almost no opinions about your Notion setup.

**A different database, or different properties.** You do not change anything. The service does not read or write properties, and it does not read the schema. It writes blocks to the page id that you give it, after it makes sure that the page is in your data source. You can change the names of your columns.

**A different platform, not Netlify.** The parts that are specific to Netlify are in two locations: `netlify/functions/` has the three entry points, and `netlify.toml` has the configuration. All of the code in `src/` is TypeScript with no platform imports. This is a rule of the project.

You must replace the background function. This is necessary because Netlify stops a synchronous function after 10 seconds, and a long article with images needs some minutes. Any platform with a queue or a long-life worker is sufficient.

**A different caller, not Claude.** The MCP connector in `mcp.ts` is one of three entry points. `clip.ts` is a usual HTTP endpoint with authentication. Any client that can send a POST request can use it: a shortcut, a bookmarklet, or a scheduled job that reads a list of URLs.

**Different conversion values.** All of the values are in `TUNABLES` in [src/config.ts](src/config.ts). You can change each value with an environment variable that has the same name. Therefore you can correct an incorrect value in the Netlify interface without a deploy. Users change these values most frequently: `MIN_ARTICLE_CHARS`, `LEAD_IMAGE_MIN_DIMENSION`, `MAX_IMAGES`, and `LEAD_IMAGE_MODE`.

**A website that Readability reads incorrectly.** `extract.ts` cleans the DOM before Readability reads it. It contains corrections for the heading widgets on Substack and for footnotes that Readability removes. Add your corrections in the same function.

Read [CLAUDE.md](CLAUDE.md) before you change the code. It lists the limits that cause a failure in production but not in a test. These include the 10-second limit, the rule to keep jsdom out of the synchronous functions, the Notion limit of 2,000 characters for each rich-text object, and the rule that a background function must almost never throw an error.

---

## Security

The service has one user and one shared secret. It reads a URL that the caller supplies.

There are two possible attacks: to make the service read a URL that it must not read, and to make the service write to a page that it must not write to.

### Protection

- **Authentication on each entry point.** The three functions `mcp`, `clip`, and `clip-background` each check the shared secret. `clip-background` has a public URL, so it does not trust the function that called it.
- **Constant-time comparison of the secret.** The service hashes the secret first, so the length of the secret does not change the time.
- **A check of the parent page.** Before the service writes, it makes sure that the parent of the target page is the data source in `RESOURCES_DATA_SOURCE_ID`. If a person gets your secret, that person still cannot write to other pages in your workspace. The variable is necessary and has no default value.
- **An SSRF check of the target URL.** The service accepts only the `http` and `https` schemes. It refuses loopback, private, link-local, carrier-grade NAT, multicast, and reserved addresses. It also refuses the IPv4-mapped IPv6 form of these addresses. The service does this check again after **each redirect**.
- **The service does not write a secret in a log or a response.** It removes the token from the log messages. `/health` tells you if a variable is present, but not its value.

### Known limits

These are decisions for a service with one user. If these limits are a problem for your installation, correct them.

- **The service does not resolve DNS.** If a host name resolves to a private address, the SSRF check does not stop it. To correct this, you must resolve the name and then check the socket, after each redirect. This prevents a DNS rebinding attack.
- **There is no rate limit.** The shared secret is the only protection.
- **The secret is in the URL of the connector.** Other systems can write the URL in their logs. To change the secret, you must change the environment variable, deploy again, and change the URL of the connector.
- **`/health` has no authentication.** It gives the deploy id, the name of the site, and which variables are present. It does not give a value. This is intentional: it answers the question "which version operates now?" with one request.
- **CORS is `*` on the MCP endpoint**, because MCP clients need this. Authentication uses a token in the URL and not a cookie. Therefore a web page in a browser cannot use the authentication of the user.
- **The service reads HTML from a website that you do not control.** A malicious page can stop one background function. This is a denial-of-service risk for that one clip.

To report a security problem, refer to [SECURITY.md](SECURITY.md). Do not write a public issue for a security problem.

---

## Documentation

| File | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | The limits of the service. Read this before you change the code. |
| [TOOL-BRIEF.md](TOOL-BRIEF.md) | The contract for the caller: tools, status values, and problem correction |
| [ROADMAP.md](ROADMAP.md) | Completed work, remaining work, and a list of failures with their causes |
| [SECURITY.md](SECURITY.md) | How to report a security problem |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Why the project does not accept pull requests, and what to do instead |

`ROADMAP.md` is useful even if you do not install the service. It records the failures that changed the code. The service did not detect most of these failures. Examples: images that were 1×1 spacers, headings that Readability removed, and a status function that reported a clip that did not occur.

---

## Contributions

This is a personal tool. I made it public because it can be useful to other persons.

**The project does not accept pull requests.** [CONTRIBUTING.md](CONTRIBUTING.md) gives the reason and tells you what to do instead. You can write an issue. You can also make a fork.

## License

[MIT](LICENSE).
