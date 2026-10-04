// ============================================================================
// Admin server — CSRF / login integration tests.
// Spins up a real admin server on an ephemeral port with an isolated temp DB,
// then exercises the double-submit-cookie CSRF flow over real HTTP.
//
// The core regression this covers: the login POST used to reject valid sessions
// with "Invalid or missing CSRF token." because the server rotated the CSRF
// token on every response and validated it order-dependently, so a browser that
// had let duplicate bf_csrf cookies pile up could present a cookie value that
// disagreed with the X-CSRF-Token header the page echoed.
//
// Run: node --test tests/
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-admin-test-"));

// Default admin account seeded by admin.js (seedIfNeeded) when the DB is empty.
const ADMIN = { username: "test-admin", password: "test-admin-pass-123" };

// Point the admin database at an isolated file BEFORE the modules load it.
process.env.BF_DB_PATH = path.join(tempDir, "admin-test.db");
delete process.env.BF_ADMIN_CSRF_SECRET;
// The developer's repo may ship a .env that overrides the admin credentials
// (BF_ADMIN_USERNAME / BF_ADMIN_PASSWORD). server/env.js re-applies .env to
// process.env on import, so deleting them would just let .env win again.
// Instead pin BOTH to the well-known defaults the suite logs in with, so the
// isolated test database is always seeded with test-admin / test-admin-pass-123 no matter
// what the local .env contains.
process.env.BF_ADMIN_USERNAME = ADMIN.username;
process.env.BF_ADMIN_PASSWORD = ADMIN.password;

// Import AFTER env is set so db.js reads the temp path.
const { startAdminServer } = await import("../server/admin.js");
const db = await import("../server/db.js");

let server;
let base;

before(async () => {
  server = startAdminServer(0);
  await new Promise((resolve, reject) => {
    server.on("listening", resolve);
    server.on("error", reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const s = server;
  server = null;
  if (s) await new Promise((resolve) => s.close(resolve));
  // Only after every request is done can we release the SQLite handle (open
  // DB file on Windows is locked) and then remove the temp directory.
  db.closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Parse Set-Cookie / Cookie header values into a plain object (first wins).
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const line of header) {
    const m = line.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

function getSetCookies(res) {
  // fetch may give one string or an array
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw;
}

async function loginWithToken({ csrfHeader, cookies, order = "given" }) {
  const headers = { "Content-Type": "application/json" };
  let cookie = cookies ? Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") : "";
  if (order === "reversed") cookie = [...cookie.matchAll(/([^;=]+=[^;]+)/g)].reverse().map((m) => m[0]).join("; ");
  if (cookie) headers["Cookie"] = cookie;
  if (csrfHeader) headers["X-CSRF-Token"] = csrfHeader;
  const res = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers,
    body: JSON.stringify(ADMIN),
  });
  return res;
}

test("login without a CSRF header is rejected (403)", async () => {
  const res = await loginWithToken({});
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "Invalid or missing CSRF token.");
});

test("login with a bogus/forged CSRF token is rejected (403)", async () => {
  // Establish cookies first so rate limiting / absence of cookie isn't the cause.
  const me = await fetch(`${base}/api/admin/me`);
  const csrfCookies = parseCookies(getSetCookies(me));
  assert.ok(csrfCookies.bf_csrf, "server should issue a bf_csrf cookie");
  const res = await loginWithToken({ csrfHeader: "0".repeat(48), cookies: csrfCookies });
  assert.equal(res.status, 403);
});

test("a normal fresh-session login round trip succeeds", async () => {
  // 1. page load
  const root = await fetch(`${base}/`);
  const rootCookies = parseCookies(getSetCookies(root));
  assert.ok(rootCookies.bf_csrf, "GET / issues a CSRF cookie");

  // 2. /me echoes the SAME stable token (no per-response rotation)
  const me = await fetch(`${base}/api/admin/me`, {
    headers: { Cookie: `bf_csrf=${rootCookies.bf_csrf}` },
  });
  const meCookies = parseCookies(getSetCookies(me));
  const meHeader = me.headers.get("x-csrf-token");
  assert.equal(meCookies.bf_csrf, rootCookies.bf_csrf, "CSRF token must stay stable across / and /me");
  assert.equal(meHeader, rootCookies.bf_csrf, "X-CSRF-Token header must match the stable cookie");

  // 3. login echoing that token
  const login = await loginWithToken({ csrfHeader: meHeader, cookies: meCookies });
  assert.equal(login.status, 200, `expected 200 but got ${login.status}`);
  const body = await login.json();
  assert.equal(body.authed, true);
  assert.equal(body.username, ADMIN.username);

  // session cookie issued and the CSRF token is unchanged (stable)
  const loginCookies = parseCookies(getSetCookies(login));
  assert.ok(loginCookies.bf_admin, "login should issue the session cookie");
  assert.equal(loginCookies.bf_csrf, rootCookies.bf_csrf, "login must not rotate the CSRF token");

  // 4. Authenticated request works with the session + stable CSRF cookie
  const authed = await fetch(`${base}/api/admin/settings`, {
    headers: { Cookie: `bf_admin=${loginCookies.bf_admin}; bf_csrf=${loginCookies.bf_csrf}` },
  });
  assert.equal(authed.status, 200);
});

test("duplicate bf_csrf cookies (in either order) are accepted", async () => {
  // Simulate a browser that has let a stale duplicate cookie linger alongside
  // the current one — the historical root cause of the desync bug. The header
  // must be accepted as long as it matches ANY of the presented cookie values
  // (the parser must not be order-dependent "last cookie wins").
  const me = await fetch(`${base}/api/admin/me`);
  const fresh = parseCookies(getSetCookies(me)).bf_csrf;
  const stale = "a".repeat(48); // an old, no-longer-current value
  const cookieDupe = `bf_csrf=${stale}; bf_csrf=${fresh}`;

  // Header matches the FRESH cookie; request sends stale first, fresh last.
  let res = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookieDupe,
      "X-CSRF-Token": fresh,
    },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(res.status, 200, `fresh token against [stale, fresh] cookies should pass`);

  // Now the header matches the stale value (server uses an order-independent check).
  res = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookieDupe,
      "X-CSRF-Token": stale,
    },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(res.status, 200, `stale token against [stale, fresh] cookies should also pass`);
});