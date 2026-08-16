# Security

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository. It goes to the maintainer and stays private until there's a fix.

This is a personal project maintained by one person in spare time, so please don't expect a same-day response or a bounty. Reports are read and taken seriously.

## What this is, in threat-model terms

A service, reachable on the public internet, that takes a URL from an authenticated caller and fetches it server-side, then writes the result into a Notion workspace using a token with write access to one database.

The two things worth attacking are therefore: **making it fetch something it shouldn't**, and **making it write somewhere it shouldn't**.

## What is defended

- **Authentication on every entry point.** All three functions — `mcp`, `clip`, `clip-background` — check the shared secret independently. `clip-background` is publicly reachable in its own right and does not trust the function that dispatched to it.
- **Constant-time secret comparison**, hashed first so length doesn't leak through timing.
- **Write-target verification.** Before anything is appended, the target page's parent is checked against `RESOURCES_DATA_SOURCE_ID`. This is the control that makes a leaked secret survivable — it cannot be used to append to arbitrary pages in the workspace. The variable is required and has no default, on purpose.
- **SSRF guard on the fetch target.** `http`/`https` schemes only. Loopback, RFC1918 private, link-local (including cloud metadata), carrier-grade NAT, IETF-reserved, benchmarking, multicast and reserved ranges are refused — as are their IPv4-mapped IPv6 forms, and hostnames with a trailing dot. Re-checked on **every redirect hop**.
- **No secret is ever echoed.** The token is redacted from request logs; `/health` reports whether each variable is present, never its value.

## Known limitations, stated plainly

These are accepted trade-offs for a single-user tool, not oversights. If you deploy this in a context where they matter, close them.

- **DNS is not resolved.** A hostname that resolves to a private address passes the SSRF guard. Closing this needs resolution plus a connect-time check on the socket, redone after every redirect to defeat DNS rebinding. Most consequential if you run this somewhere with a reachable instance-metadata service.
- **No rate limiting.** The shared secret is the only thing between the internet and the endpoints. There is no lockout and no backoff on repeated failures.
- **The secret travels in the connector URL** as a path segment, so it may be captured by intermediary logs outside this service's control. Rotating means updating the environment variable, redeploying, *and* updating the connector URL.
- **`/health` is unauthenticated.** It exposes the deploy id, the site name, and which variables are set — never a value. This is deliberate: it answers "is the fix live?" in one request. Nothing there is a credential, but it is information.
- **CORS is `*` on the MCP endpoint**, which MCP clients need. Authentication is by URL token rather than cookie, so there is no ambient authority for a cross-origin page to abuse — but it does mean anyone holding the secret can call it from a browser.
- **The service fetches attacker-influenceable HTML and parses it** with jsdom and Readability. A malicious page is a denial-of-service vector against a single background invocation. There is a current low-severity ReDoS advisory against `@mozilla/readability` below 0.6.0; the fix is a breaking upgrade and has not been taken yet.

## If you are running your own copy

- Generate a real secret — `openssl rand -hex 32` — and don't reuse one.
- Give the Notion integration access to **one** database, not the workspace.
- Set `RESOURCES_DATA_SOURCE_ID` to a data source you're willing to have written to, and nothing broader.
- Keep the repo's `.gitignore` intact. `.env` and `.env.*` are excluded; `.env.example` is the only one that should ever be committed.
