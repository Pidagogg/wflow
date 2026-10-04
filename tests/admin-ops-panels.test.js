// ============================================================================
// Admin panel → VPS / PostgreSQL / Kubernetes / Nginx / Alerts / Backups /
// Journal tabs.
//
// Boots the real admin server against an isolated database + data folder, logs
// in, and exercises every new endpoint the panels call. Also asserts the HTML
// actually ships a section for each new tab — a tab button without a matching
// section would silently show a blank page.
//
// Run: node --test tests/admin-ops-panels.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-admin-ops-"));
const dbPath = path.join(tempDir, "admin.db");
const dataDir = path.join(tempDir, "data");

const ADMIN = { username: "ops-admin", password: "test-admin-pass-123!" };

// Isolated DB + data folder + pinned credentials BEFORE the admin modules load.
process.env.BF_DB_PATH = dbPath;
process.env.BF_DATA_DIR = dataDir;
process.env.BF_ADMIN_USERNAME = ADMIN.username;
process.env.BF_ADMIN_PASSWORD = ADMIN.password;
// Keep the health monitor out of the test: it would poll (and possibly write)
// while the suite tears the temp folder down.
process.env.BF_ALERTS = "0";

const { startAdminServer } = await import("../server/admin.js");
const db = await import("../server/db.js");
const { stopHealthMonitor } = await import("../server/alerts.js");
const { flushJournal } = await import("../server/journal.js");

let server;
let base = "";
let cookie = "";
let csrf = "";

function parseCookies(res) {
  const out = {};
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const m = line.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

function api(method, url, body) {
  return fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
    body: body ? JSON.stringify(body) : undefined,
  });
}

before(async () => {
  server = startAdminServer(0);
  await new Promise((resolve, reject) => {
    server.on("listening", resolve);
    server.on("error", reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const root = await fetch(`${base}/`);
  csrf = parseCookies(root).bf_csrf;
  assert.ok(csrf, "admin page issues a CSRF cookie");
  const login = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `bf_csrf=${csrf}`, "X-CSRF-Token": csrf },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(login.status, 200, "admin login succeeds");
  cookie = `bf_admin=${parseCookies(login).bf_admin}; bf_csrf=${csrf}`;
});

test("every new admin tab has a section and the guides are present", async () => {
  const html = await (await fetch(`${base}/`)).text();
  for (const tab of ["vps", "postgres", "kubernetes", "nginx", "alerts", "backups", "journal"]) {
    assert.match(html, new RegExp(`id="tab-${tab}"`), `section for the ${tab} tab`);
  }
  assert.match(html, /PATRONI/i, "Patroni setup is documented");
  assert.match(html, /DEV VPS \(STAGING\)/i, "dev VPS subsection exists");
  assert.match(html, /NGINX &amp; TLS|NGINX & TLS/i, "Nginx + TLS setup is documented");
});

test("ops settings round-trip (VPS / dev VPS / Patroni / Kubernetes)", async () => {
  const save = await api("POST", "/api/admin/ops", {
    vpsHost: "203.0.113.10",
    vpsUser: "ubuntu",
    domain: "flow.example.com",
    devVpsHost: "198.51.100.20",
    patroniHost: "10.0.0.11",
    k8sHost: "my-cluster",
    registry: "ghcr.io/acme",
  });
  assert.equal(save.status, 200);

  const data = await (await api("GET", "/api/admin/ops")).json();
  assert.equal(data.vpsHost, "203.0.113.10");
  assert.equal(data.devVpsHost, "198.51.100.20");
  assert.equal(data.patroniHost, "10.0.0.11");
  assert.equal(data.k8sHost, "my-cluster");
  assert.equal(data.registry, "ghcr.io/acme");
  assert.ok(data.engine, "reports the database engine");
});

test("alert e-mail is validated and saved", async () => {
  const bad = await api("POST", "/api/admin/alerts/settings", { email: "not-an-email" });
  assert.equal(bad.status, 400, "a malformed address is rejected");

  const good = await api("POST", "/api/admin/alerts/settings", { email: "ops@example.com", enabled: true });
  assert.equal(good.status, 200);

  const data = await (await api("GET", "/api/admin/alerts")).json();
  assert.equal(data.settings.email, "ops@example.com");
  assert.equal(data.settings.enabled, true);
  assert.ok(Array.isArray(data.alerts));
  assert.equal(typeof data.health.ok, "boolean");
});

test("a backup can be created, listed and downloaded", async () => {
  const run = await api("POST", "/api/admin/backups/run");
  const runBody = await run.text();
  assert.equal(run.status, 200, `backup run failed: ${run.status} ${runBody}`);
  const { result } = JSON.parse(runBody);
  // `.tar.gz` when tar is available, otherwise the plain folder snapshot.
  const artifact = result.archive || result.name;
  assert.ok(artifact, "the backup has an artifact name");

  const listed = await (await api("GET", "/api/admin/backups")).json();
  assert.ok(listed.backups.some((b) => b.name === artifact), "the new backup is listed");
  assert.ok(Number(listed.settings.keep) >= 1);

  const dl = await api("GET", `/api/admin/backups/download?name=${encodeURIComponent(artifact)}`);
  assert.equal(dl.status, 200, "the backup downloads");
});

test("the journal endpoint returns database events", async () => {
  await flushJournal();
  const data = await (await api("GET", "/api/admin/journal?limit=50")).json();
  assert.equal(typeof data.enabled, "boolean");
  assert.ok(Array.isArray(data.events));
  assert.ok(data.total >= 0);
  assert.equal(typeof data.stats.total, "number");
});

after(async () => {
  try {
    stopHealthMonitor();
  } catch {
    /* ignore */
  }
  if (server) {
    const s = server;
    server = null;
    await new Promise((resolve) => s.close(resolve));
  }
  try {
    await flushJournal();
  } catch {
    /* ignore */
  }
  db.closeDb();
  // Windows keeps SQLite files locked briefly after close — retry the cleanup.
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});
