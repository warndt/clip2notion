/**
 * Fetch-target safety checks.
 *
 * Its own module, importing only the error types, so that validating a URL does
 * not pull in Readability and jsdom. `mcp.ts` needs this check and nothing else
 * from the extraction layer — see the cold-start note in CLAUDE.md.
 */

import { errors } from "./errors";

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "metadata.google.internal", "instance-data",
]);

/**
 * Cheap SSRF guard. This endpoint fetches an arbitrary URL on request, so at
 * minimum it should refuse to fetch the machine it is running on.
 *
 * Deliberately does not resolve DNS — a hostname pointing at a private address
 * still gets through. Closing that needs resolution plus a check on the socket,
 * which is more machinery than a single-user service warrants today.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw errors.invalidRequest(`Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw errors.invalidRequest(`Unsupported protocol: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw errors.invalidRequest(`Refusing to fetch ${host}`);
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    throw errors.invalidRequest(`Refusing to fetch private address ${host}`);
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const isPrivate =
      a === 0 || a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
    if (isPrivate) throw errors.invalidRequest(`Refusing to fetch private address ${host}`);
  }

  return url;
}
