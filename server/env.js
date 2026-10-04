// ============================================================================
// W FLOW — environment loader
// Loads variables from a .env file (if present) into process.env BEFORE any
// module reads them (PORT, DATABASE_URL, TRUST_PROXY, BF_ENCRYPTION_KEY, …).
// Import this module first in any server entry point.
//
// process.loadEnvFile is built into Node 20.12+ / 21.7+. It throws when no
// .env file exists — that is expected (the app runs fine without one).
// ============================================================================
import fs from "node:fs";

try {
  process.loadEnvFile();
} catch {
  /* no .env file — use process env / defaults */
}

// ----------------------------------------------------------------------------
// Docker / host database bridge
//
// Inside a container "localhost" is the container itself — not the machine the
// container runs on. A .env written for a plain `npm start` therefore cannot
// reach a database that runs on the host once the app is containerised, and the
// other way round: a .env pointing at host.docker.internal (which does not
// resolve outside Docker) breaks `npm start`.
//
// So one .env can serve both: when we detect we are inside a container, a
// LOOPBACK host in DATABASE_URL is rewritten to host.docker.internal, which
// resolves to the host machine on Docker Desktop and — thanks to the
// `extra_hosts: host.docker.internal:host-gateway` mapping in
// docker-compose.yml — on plain Linux (VPS) too. Only the host part changes;
// credentials, port and database name are left byte-for-byte identical.
//
// A database in another container (postgres://…@postgres:5432/…) or a hosted
// one is never touched. Overrides:
//   BF_DB_HOST_REWRITE=0                  disable the rewrite
//   BF_DB_HOST_REWRITE=my-db.internal     rewrite to a different host instead
// ----------------------------------------------------------------------------
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Are we running inside a container? (Docker, Podman, Kubernetes, containerd) */
function insideContainer() {
  try {
    if (fs.existsSync("/.dockerenv")) return true;
  } catch {
    /* no /.dockerenv — keep checking */
  }
  try {
    const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
    if (/docker|containerd|kubepods|podman|libpod/.test(cgroup)) return true;
  } catch {
    /* no cgroup file (Windows/macOS host) */
  }
  return /docker|containerd|kubepods/.test(String(process.env.container || ""));
}

/**
 * Replace a loopback host in a connection URL. Two passes so an unusual
 * password (an unencoded "@", say) still works: a plain string rewrite when the
 * shape is simple, URL parsing as a fallback.
 */
function withContainerHost(url) {
  const simple = url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i,
    "$1host.docker.internal"
  );
  if (simple !== url) return simple;
  try {
    const parsed = new URL(url);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return url;
    parsed.hostname = "host.docker.internal";
    return parsed.toString();
  } catch {
    return url; // not a URL we understand — leave it exactly as it was
  }
}

const rewriteSetting = String(process.env.BF_DB_HOST_REWRITE ?? "").trim();
const rewriteDisabled = /^(0|false|no|off)$/i.test(rewriteSetting);
const rewriteTarget = !rewriteSetting || /^(1|true|yes|on)$/i.test(rewriteSetting) ? "host.docker.internal" : rewriteSetting;

if (process.env.DATABASE_URL && !rewriteDisabled && insideContainer()) {
  const before = process.env.DATABASE_URL;
  const after = rewriteTarget === "host.docker.internal" ? withContainerHost(before) : before;
  if (after !== before) {
    process.env.DATABASE_URL = after;
    // Never print the URL itself — it carries the database password.
    console.log(`[env] DATABASE_URL pointed at a loopback host — using ${rewriteTarget} (we are inside a container).`);
  }
}
