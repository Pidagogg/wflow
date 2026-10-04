// ============================================================================
// W FLOW — SSRF guard: private / internal URL blocking.
//
// Enabled with BF_BLOCK_PRIVATE_URLS=1 (recommended on public deployments such
// as AWS EC2, and set in .env.production.example). When on, every node that
// calls a user-supplied URL (HTTP Request, RSS Read, the webhook senders, the
// AI providers, …) refuses to contact loopback / private / link-local /
// cloud-metadata addresses before any network I/O happens — so a workflow can
// never probe the server itself, its VPC, or the instance-metadata service at
// 169.254.169.254 (which on AWS/GCP can hand out IAM credentials).
//
// The address classifier parses IPv4 AND IPv6 properly, including the IPv4-in-
// IPv6 forms the URL parser rewrites a literal into: `http://[::ffff:127.0.0.1]`
// becomes the hostname `::ffff:7f00:1`, and `http://[::127.0.0.1]` becomes
// `::7f00:1` — both of which an earlier, string-prefix check let through to
// loopback. `safeFetch` additionally re-checks every redirect hop, so a public
// URL that 302-redirects to an internal one is blocked too.
//
// Self-hosters who need to reach internal services set BF_BLOCK_PRIVATE_URLS=0.
// ============================================================================
import dns from "node:dns";
import { attachCode } from "../shared/errors.js";

export function urlBlockingEnabled() {
  const v = process.env.BF_BLOCK_PRIVATE_URLS;
  return v === "1" || v === "true";
}

export function isPrivateIpv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const [a, b] = parts.map(Number);
  if (a === 0 || a === 10) return true; // 0.0.0.0/8 + 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 192 && b === 0) return true; // 192.0.0.0/24
  if (a >= 224) return true; // multicast + reserved
  return false;
}

// Expand an IPv6 string (with optional "::" and optional embedded dotted IPv4
// in the low 32 bits) into its 16 bytes, or null when it is not valid IPv6.
function ipv6ToBytes(input) {
  let s = String(input || "").toLowerCase();
  if (!s.includes(":")) return null;
  // A zone id (fe80::1%eth0) never changes the address itself — drop it.
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  // An embedded IPv4 tail (…:1.2.3.4) becomes two hextets.
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, v4.index) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function isPrivateIpv6Bytes(b) {
  const allZeroHi = b.slice(0, 15).every((x) => x === 0);
  if (allZeroHi && b[15] === 1) return true; // ::1 loopback
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible / low-range embeddings
  // (::a.b.c.d, incl. the hex forms the URL parser produces) — judge by the
  // embedded IPv4 so ::ffff:169.254.169.254 and ::127.0.0.1 are both caught.
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  if (first10Zero && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    return isPrivateIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }
  return false;
}

export function isPrivateIp(ip) {
  const v = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (v.includes(":")) {
    const bytes = ipv6ToBytes(v);
    return bytes ? isPrivateIpv6Bytes(bytes) : true; // unparseable IPv6 → treat as unsafe
  }
  return isPrivateIpv4(v);
}

export function blockedUrlError(host) {
  return attachCode(
    new Error(`URL blocked: '${host}' is a local / private / metadata address, which is not allowed on this instance (BF_BLOCK_PRIVATE_URLS).`),
    "URL_BLOCKED"
  );
}

export async function assertPublicHttpUrl(rawUrl) {
  if (!urlBlockingEnabled()) return;
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return; // malformed — the fetch layer classifies that error instead
  }
  const proto = String(parsed.protocol || "").toLowerCase();
  if (proto !== "http:" && proto !== "https:") return;
  const host = String(parsed.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return;
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" || host === "instance-data") {
    throw blockedUrlError(host);
  }
  // A literal IP (v4 or v6) is judged directly — no DNS needed.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) {
    if (isPrivateIp(host)) throw blockedUrlError(host);
    return;
  }
  // Hostname — resolve and block when it points anywhere private (also stops
  // DNS-rebinding tricks). A lookup failure (offline / NXDOMAIN) is left to the
  // fetch layer to classify.
  let addrs = [];
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    return;
  }
  if (addrs.length && addrs.some((a) => isPrivateIp(a.address))) throw blockedUrlError(host);
}

// fetch() that re-checks every redirect hop against the SSRF guard. A workflow
// may legitimately follow redirects, but a public URL that 302-redirects to
// http://169.254.169.254/ must not slip through, so we follow by hand (up to
// `maxRedirects`), re-asserting each Location before fetching it. When blocking
// is off this behaves exactly like a normal follow (fetch does it natively).
export async function safeFetch(url, options = {}, { maxRedirects = 5 } = {}) {
  const follow = options.redirect !== "manual";
  if (!urlBlockingEnabled() || !follow) {
    return fetch(url, options);
  }
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...options, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location"), current).toString();
      // 303 and (per browsers) 301/302 turn the method into GET without a body.
      if (options.body && (res.status === 303 || res.status === 301 || res.status === 302)) {
        options = { ...options, method: "GET", body: undefined };
      }
      current = next;
      continue;
    }
    return res;
  }
  throw attachCode(new Error("Too many redirects."), "URL_BLOCKED");
}
