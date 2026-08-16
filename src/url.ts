/**
 * Fetch-target safety checks.
 *
 * Its own module, importing only the error types, so that validating a URL does
 * not pull in Readability and jsdom. `mcp.ts` needs this check and nothing else
 * from the extraction layer — see the cold-start note in CLAUDE.md.
 */

import { errors } from "./errors";

const BLOCKED_HOSTNAMES = new Set([
  "localhost", "metadata.google.internal", "instance-data", "metadata",
]);

/**
 * Is this dotted-quad address one we refuse to fetch?
 *
 * Covers more than "private": link-local carries cloud metadata, carrier-grade
 * NAT is someone else's internal network, and multicast and the reserved space
 * above it have no business being an article host.
 */
function isBlockedIpv4(a: number, b: number): boolean {
  return (
    a === 0 ||                            // "this network"
    a === 127 ||                          // loopback
    a === 10 ||                           // RFC1918
    (a === 172 && b >= 16 && b <= 31) ||  // RFC1918
    (a === 192 && b === 168) ||           // RFC1918
    (a === 169 && b === 254) ||           // link-local, incl. cloud metadata
    (a === 100 && b >= 64 && b <= 127) || // RFC6598 carrier-grade NAT
    (a === 192 && b === 0) ||             // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224                              // multicast and reserved
  );
}

/**
 * Pull the embedded IPv4 out of an IPv4-mapped IPv6 address, or null.
 *
 * This is the hole that made the guard bypassable. `new URL()` normalises
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, which matched none of the old
 * checks — not the `::1` literal, not the `fc`/`fd`/`fe80` prefixes, and not
 * the dotted-quad regex. `[::ffff:169.254.169.254]` therefore sailed through
 * to the fetch as a perfectly ordinary-looking hostname.
 */
function mappedIpv4(host: string): [number, number] | null {
  if (!host.includes(":")) return null;

  // The dotted tail survives in some inputs; the hex form is what URL emits.
  const dotted = /:((\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted) return [Number(dotted[2]), Number(dotted[3])];

  const groups = host.split(":").filter((g) => g.length > 0);
  if (groups.length < 3) return null;

  const last = groups[groups.length - 1]!;
  const secondLast = groups[groups.length - 2]!;
  const marker = groups[groups.length - 3]!;
  if (marker.toLowerCase() !== "ffff") return null;

  const high = Number.parseInt(secondLast, 16);
  const low = Number.parseInt(last, 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;

  return [(high >> 8) & 0xff, high & 0xff];
}

/**
 * SSRF guard. This service fetches an arbitrary URL on request, so at minimum
 * it must refuse to fetch the machine it is running on or its neighbours.
 *
 * ⚠️ **It deliberately does not resolve DNS.** A hostname that resolves to a
 * private address still gets through. Closing that needs resolution plus a
 * check on the socket at connect time — and re-checking after every redirect,
 * since DNS can answer differently the second time (a rebinding attack).
 * `fetchArticle` re-runs this on every hop, which is necessary but not
 * sufficient against an attacker who controls the DNS record.
 *
 * What this does buy: an attacker needs the shared secret before any of that
 * matters, and the literal-address routes to loopback, link-local and cloud
 * metadata are closed. Anyone deploying this somewhere with a real metadata
 * service, or exposing it more widely than one caller, should add resolution.
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

  // A trailing dot is a fully-qualified name and resolves identically, so
  // `localhost.` has to be treated as `localhost` rather than as a new name.
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw errors.invalidRequest(`Refusing to fetch ${host}`);
  }
  if (host === "::" || host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80:")) {
    throw errors.invalidRequest(`Refusing to fetch private address ${host}`);
  }

  const mapped = mappedIpv4(host);
  if (mapped && isBlockedIpv4(mapped[0], mapped[1])) {
    throw errors.invalidRequest(`Refusing to fetch private address ${host}`);
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 && isBlockedIpv4(Number(ipv4[1]), Number(ipv4[2]))) {
    throw errors.invalidRequest(`Refusing to fetch private address ${host}`);
  }

  return url;
}
