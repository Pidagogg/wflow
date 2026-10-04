// ============================================================================
// Self-hosted installer (Pro perk) — Settings → Defaults → “Run it self-hosted”.
//
// Covers the module directly (what goes into the shipped ZIP, the signed
// download link, both installer scripts) and the three endpoints over HTTP:
//
//   GET /api/selfhosted            → Pro state + whether the instance can ship
//   GET /api/selfhosted/installer  → the one-file installer (Pro only)
//   GET /api/selfhosted/bundle     → the app ZIP, token-authenticated
//
// The bundle is a plain ZIP built with the app's own ZIP writer; the assertions
// check it packs the app and — importantly — never the ./data database or the
// live .env with the encryption key.
//
// Run: node --test tests/selfhost.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// A fixed instance key keeps the server and this test on the same HMAC secret —
// and keeps getEncryptionKey() from writing ./data/.secret in the repo.
process.env.BF_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

const {
  selfhostReadiness,
  collectShipFiles,
  buildSelfhostBundle,
  newBundleToken,
  verifyBundleToken,
  installerScript,
  SELFHOST_PORT,
} = await import("../server/selfhost.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-selfhost-"));
const dbPath = path.join(tempDir, "selfhost.db");

let child;
let base = "";
let cookie = "";

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const raw = res.headers.getSetCookie?.() ?? [];
  if (raw[0]) cookie = raw[0].split(";")[0];
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data, res };
}

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready in time");
}

const EMAIL = `selfhost-${Date.now()}@example.com`;

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

test("the instance reports a runnable self-hosted copy", () => {
  const state = selfhostReadiness();
  assert.equal(state.ready, true, state.reason);
  assert.equal(state.port, SELFHOST_PORT);
  assert.equal(SELFHOST_PORT, 3001);
});

test("the shipped file list carries the app but never the data folder or .env", () => {
  const files = collectShipFiles();
  const names = files.map((f) => path.relative(repoRoot, f).split(path.sep).join("/"));
  assert.ok(names.includes("package.json"), "package.json is shipped");
  assert.ok(names.some((n) => n === "server/index.js"), "the server is shipped");
  assert.ok(names.some((n) => n.startsWith("shared/")), "shared modules are shipped");
  assert.ok(names.some((n) => n.startsWith("dist/") || n.startsWith("src/")), "a UI (built or source) is shipped");

  for (const name of names) {
    assert.notEqual(name, ".env", "the live .env (encryption key, Stripe secrets) must stay behind");
    assert.ok(!/(^|\/)data\//.test(name), `database files must stay behind: ${name}`);
    assert.ok(!/\.log$/i.test(name), `logs must stay behind: ${name}`);
    assert.ok(!name.startsWith("tests/"), "dev-only tests are not shipped");
    assert.ok(!name.includes("node_modules"), "dependencies are installed on the target machine");
  }
});

test("the bundle is a real zip of the app", () => {
  const bundle = buildSelfhostBundle();
  assert.ok(bundle, "a bundle could be built");
  assert.ok(bundle.files > 10, `expected a full app, got ${bundle.files} files`);
  assert.ok(bundle.bytes > 1000, "expected real content");
  // local file header signature of the first ZIP entry
  assert.equal(bundle.zip.subarray(0, 2).toString("latin1"), "PK");
  const asText = bundle.zip.toString("latin1");
  assert.ok(asText.includes("server/index.js"), "the zip names the server");
  assert.ok(asText.includes("package.json"), "the zip names the package file");
  assert.ok(!asText.includes("wflow-selfhost"), "the installer itself is not bundled");
});

test("download links are signed, tamper-proof and expire", () => {
  const token = newBundleToken();
  assert.equal(verifyBundleToken(token), true);

  const [expiry, signature] = token.split(".");
  assert.equal(verifyBundleToken(`${expiry}.${signature.replace(/.$/, signature.endsWith("0") ? "1" : "0")}`), false, "a tampered signature is rejected");
  assert.equal(verifyBundleToken(`${Number(expiry) + 60_000}.${signature}`), false, "a changed expiry is rejected");
  assert.equal(verifyBundleToken(newBundleToken(-1000)), false, "an expired link is rejected");
  assert.equal(verifyBundleToken(""), false);
  assert.equal(verifyBundleToken("nonsense"), false);
  assert.equal(verifyBundleToken(undefined), false);
});

test("the bash installer downloads the app, sets the copy up and starts it", () => {
  const script = installerScript({ os: "linux", baseUrl: "https://flow.example.com/", token: "123.sig", port: 3100 });
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.ok(script.includes('BUNDLE_URL="https://flow.example.com/api/selfhosted/bundle?token=123.sig"'), "absolute link, no double slash");
  assert.ok(script.includes('DEFAULT_PORT="3100"'), "the default port travels with the script");
  assert.ok(script.includes("node server/index.js"), "it starts the builder");
  assert.ok(script.includes("npm ci --no-audit --no-fund"), "it installs production dependencies");
  assert.ok(script.includes("npm run build"), "it builds the UI when the sources are shipped");
  assert.ok(script.includes("command -v node"), "it checks for Node.js");

  // …and it ASKS the setup questions: where it lives, which port, what the copy
  // is for, where runs execute and where the data is stored.
  assert.ok(script.includes("Install folder"), "asks where to install");
  assert.ok(script.includes("Port for the builder UI"), "asks for the port");
  assert.ok(script.includes("What is this copy for?"), "asks builder / runner / both");
  assert.ok(script.includes("Where should workflows execute?"), "asks where runs happen");
  assert.ok(script.includes("Where should workflows, credentials and run history be stored?"), "asks where data lives");

  // The answers land in the copy's own .env — with its own secrets.
  assert.ok(script.includes("WFLOW_STANDALONE=1"), "marks the copy as the user's own");
  assert.ok(script.includes("BF_ENCRYPTION_KEY"), "writes a fresh encryption key");
  assert.ok(script.includes("BF_DB_PATH"), "points at the local database file");
  assert.ok(script.includes("DATABASE_URL"), "or at the user's PostgreSQL server");
  assert.ok(script.includes("WFLOW_REMOTE_URL"), "can send runs to a runner");
  assert.ok(script.includes("WFLOW_RUNNER_TOKEN"), "can accept runs from a builder");
  assert.ok(script.includes("randomBytes(32)"), "the encryption key is random per copy");
  assert.ok(script.includes("/setup"), "it prints the Setup page address");
  assert.ok(script.includes("start-wflow.sh"), "it creates a launcher");
  // The launcher gets the port chosen at run time, not the default.
  assert.ok(script.includes("__LAUNCHPORT__"), "the launcher's port is substituted on the target machine");
  assert.ok(script.includes("sed -i.bak"), "…with GNU/BSD compatible sed");
});

test("the macOS installer is the same script, double-clickable in Finder", () => {
  const script = installerScript({ os: "mac", baseUrl: "https://flow.example.com", token: "123.sig", port: 3100 });
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.ok(script.includes("self-hosted installer (macOS)"), "it names the platform");
  assert.ok(script.includes("Start W flow.command"), "it creates the Finder launcher");
  assert.ok(script.includes("open http://localhost"), "it opens the builder in the browser");
  assert.ok(script.includes("brew install node"), "the Node hint is the macOS one");
});

test("the batch installer asks the same questions on Windows (CRLF file)", () => {
  const script = installerScript({ os: "windows", baseUrl: "https://flow.example.com", token: "123.sig" });
  assert.ok(script.startsWith("@echo off\r\n"), "batch files need CRLF");
  assert.ok(script.includes('set "BUNDLE_URL=https://flow.example.com/api/selfhosted/bundle?token=123.sig"'));
  assert.ok(script.includes("node server/index.js"));
  assert.ok(script.includes("where node"));
  assert.ok(script.includes("setlocal"));
  assert.ok(script.includes('Install folder'), "asks where to install");
  assert.ok(script.includes("Port for the builder UI"), "asks for the port");
  assert.ok(script.includes("What is this copy for?"), "asks builder / runner / both");
  assert.ok(script.includes("Where should workflows execute?"), "asks where runs happen");
  assert.ok(script.includes("Where should workflows, credentials and run history be stored?"), "asks where data lives");
  assert.ok(script.includes("/setup"), "it prints the Setup page address");

  // The settings file, the launcher and the desktop shortcut are written by the
  // embedded PowerShell helper (base64, so cmd never has to quote a URL).
  const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
  assert.ok(encoded, "the PowerShell helper is embedded as base64");
  const helper = Buffer.from(encoded, "base64").toString("utf8");
  assert.ok(helper.includes("Set-Content"), "the helper writes files");
  assert.ok(helper.includes("WFLOW_STANDALONE=1"), "…including the standalone marker");
  assert.ok(helper.includes("BF_ENCRYPTION_KEY"), "…and the copy's own encryption key");
  assert.ok(helper.includes("BF_DB_PATH"), "…and its database path");
  assert.ok(helper.includes("WFLOW_RUNNER_TOKEN"), "…and its runner token");
  assert.ok(helper.includes("Start W flow.bat"), "…and the launcher");
  assert.ok(helper.includes("WScript.Shell"), "plus a desktop shortcut");
  assert.ok(!script.includes("%DATABASE_URL%>>"), "no fragile cmd redirection of user input");
});

// ---------------------------------------------------------------------------
// The endpoints
// ---------------------------------------------------------------------------

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: dbPath,
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForServer();
  const reg = await api("POST", "/api/auth/register", { email: EMAIL, password: "correct-horse-battery", name: "Selfhoster" });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("a free account sees the option but cannot download the installer", async () => {
  const info = await api("GET", "/api/selfhosted");
  assert.equal(info.status, 200);
  assert.equal(info.data.pro, false, "the account is not Pro yet");
  assert.equal(info.data.ready, true);
  assert.equal(info.data.port, 3001);

  const locked = await api("GET", "/api/selfhosted/installer?os=unix");
  assert.equal(locked.status, 403);
  assert.match(String(locked.data.error), /Pro/i);
});

test("a Pro account gets the installer, and its link fetches the app", async () => {
  // Flip the account to Pro in the shared database, the way the admin panel does.
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE users SET role = 'pro_user' WHERE email = ?").run(EMAIL);
  db.close();

  const info = await api("GET", "/api/selfhosted");
  assert.equal(info.data.pro, true);

  const res = await fetch(`${base}/api/selfhosted/installer?os=unix`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("content-type")), /text\/plain/);
  assert.match(String(res.headers.get("content-disposition")), /attachment; filename="wflow-selfhost\.sh"/);
  const script = await res.text();
  const link = script.match(/BUNDLE_URL="([^"]+)"/)?.[1] || "";
  assert.ok(link.startsWith(`${base}/api/selfhosted/bundle?token=`), `unexpected link: ${link}`);

  // The exact link inside the script downloads the app without a session cookie.
  const bundle = await fetch(link);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get("content-type"), "application/zip");
  const body = Buffer.from(await bundle.arrayBuffer());
  assert.ok(body.length > 1000, "the bundle has content");
  assert.equal(body.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(body.toString("latin1").includes("server/index.js"));
});

test("the Windows installer is served as a .bat for Windows", async () => {
  const res = await fetch(`${base}/api/selfhosted/installer?os=windows`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("content-disposition")), /filename="wflow-selfhost\.bat"/);
  const script = await res.text();
  assert.ok(script.startsWith("@echo off"));
});

test("the bundle endpoint refuses unsigned, tampered and expired links", async () => {
  const bad = await fetch(`${base}/api/selfhosted/bundle?token=123.deadbeef`);
  assert.equal(bad.status, 401);

  const missing = await fetch(`${base}/api/selfhosted/bundle`);
  assert.equal(missing.status, 401);

  const expired = newBundleToken(-5000);
  const stale = await fetch(`${base}/api/selfhosted/bundle?token=${encodeURIComponent(expired)}`);
  assert.equal(stale.status, 401);

  const valid = await fetch(`${base}/api/selfhosted/bundle?token=${encodeURIComponent(newBundleToken())}`);
  assert.equal(valid.status, 200);
});

test("the endpoints are behind a login", async () => {
  const anon = await fetch(`${base}/api/selfhosted`);
  assert.equal(anon.status, 401);
  const anonInstaller = await fetch(`${base}/api/selfhosted/installer`);
  assert.equal(anonInstaller.status, 401);
});
