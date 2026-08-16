# Security

## How to report a problem

**Do not write a public issue for a security problem.**

Use the private report function in GitHub: **Security → Report a vulnerability** on this repository. The report goes to the maintainer and stays private until there is a correction.

One person maintains this project in available time. Do not expect an answer on the same day, and there is no payment for a report. I read each report and take it seriously.

## What this service is, for a threat model

This service has a public URL. It takes a URL from a caller with authentication and reads that URL from a server. It then writes the result into a Notion workspace with a token that can write to one database.

Therefore there are two attacks: **make the service read a URL that it must not read**, and **make the service write to a page that it must not write to**.

## Protection

- **Authentication on each entry point.** The three functions `mcp`, `clip`, and `clip-background` each check the shared secret. `clip-background` has a public URL, so it does not trust the function that called it.
- **Constant-time comparison of the secret.** The service hashes the value first, so the length of the value does not change the time of the comparison.
- **A check of the target page.** Before the service writes, it makes sure that the parent of the target page is the data source in `RESOURCES_DATA_SOURCE_ID`. This is the control that limits the effect of a lost secret: a person with the secret cannot write to other pages in the workspace. The variable is necessary and has no default value.
- **An SSRF check of the target URL.** The service accepts only the `http` and `https` schemes. It refuses loopback, RFC1918 private, link-local (which includes cloud metadata), carrier-grade NAT, IETF-reserved, benchmarking, multicast, and reserved addresses. It also refuses the IPv4-mapped IPv6 form of these addresses, and a host name with a final dot. The service does this check again **after each redirect**.
- **The service never gives a secret in a log or a response.** It removes the token from the log messages. `/health` reports if a variable is present, and never its value.

## Known limits

These are decisions for a tool with one user. If a limit is a problem for your installation, correct it.

- **The service does not resolve DNS.** A host name that resolves to a private address passes the SSRF check. To correct this, resolve the name and then check the socket at connect time. Do this again after each redirect, to prevent a DNS rebinding attack. This limit is most important if you install the service where an instance-metadata service is available.
- **There is no rate limit.** The shared secret is the only protection. There is no lock and no delay after failed attempts.
- **The secret is in the URL of the connector.** Other systems can write the URL in their logs, and this service does not control those systems. To change the secret, change the environment variable, deploy, and change the URL of the connector.
- **`/health` has no authentication.** It gives the deploy id, the name of the site, and which variables are present. It never gives a value. This is intentional: it answers "which version operates now?" with one request. No part of it is a credential, but it is information.
- **CORS is `*` on the MCP endpoint**, because MCP clients need this. The authentication uses a token in the URL and not a cookie. Therefore a web page in a browser has no automatic authority to use. But a person with the secret can call the endpoint from a browser.
- **The service reads HTML from a website that you do not control**, and parses it with jsdom and Readability. A malicious page can stop one background function. This is a denial-of-service risk for that one clip.

## If you install your own copy

- Make a new secret with `openssl rand -hex 32`. Do not use a secret from a different service.
- Give the Notion integration access to **one** database and not to the workspace.
- Set `RESOURCES_DATA_SOURCE_ID` to a data source that the service can write to, and to nothing larger.
- Do not change `.gitignore`. It excludes `.env` and `.env.*`. `.env.example` is the only one of these files that belongs in the repository.
