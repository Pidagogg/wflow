// ============================================================================
// One-click update of a self-hosted copy (server/updater.js, update-restart.js)
//
// The swap runs on a throwaway app folder inside the repo (so the helper's
// imports still find node_modules): new files replace old ones, files the new
// version dropped disappear, .env / ./data / node_modules are never touched,
// and a failed install or a new version that does not start puts the previous
// files back.
//
// Run: node --test tests/self-update.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, after, beforeEach } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-update-"));
process.env.BF_DB_PATH = path.join(tempDir, "update.db");
process.env.WFLOW_STANDALONE = "1";
process.env.WFLOW_LICENSE_KEY = "wfl_" + "u".repeat(32);

const { createZipBuffer } = await import("../server/fileextract.js");
const selfhost = await import("../server/selfhost.js");
const updater = await import("../server/updater.js");
const lic = await import("../server/license.js");

// throwaway app folders live in the repo so `import` resolves node_modules
const roots = [];
function appRoot() {
  const root = fs.mkdtempSync(path.join(REPO, ".tmp-update-"));
  roots.push(root);
  return root;
}
after(async () => {
  // the restart helper starts its servers detached; stop them before cleaning up
  for (const r of roots) {
    try {
      process.kill(Number(fs.readFileSync(path.join(r, "fake-server.pid"), "utf8")));
    } catch {
      /* none running */
    }
  }
  await new Promise((res) => setTimeout(res, 500));
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  (await import("../server/dbx.js")).closeDb();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* a temp folder Windows still holds is harmless */
  }
  delete process.env.WFLOW_STANDALONE;
});
beforeEach(() => updater.resetUpdateState());

function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

/** A copy as the installer leaves it, at version "old". */
function oldCopy() {
  const root = appRoot();
  write(root, "package.json", JSON.stringify({ name: "t", version: "1.0.0" }));
  write(root, "server/index.js", "// old server");
  write(root, "server/removed-later.js", "// only in the old version");
  write(root, "dist/assets/app-old.js", "old bundle");
  write(root, "wflow-version.json", JSON.stringify({ version: "1.0.0+old" }));
  write(root, ".env", "BF_ENCRYPTION_KEY=keep-me\n");
  write(root, "data/admin.db", "the user's database");
  write(root, "node_modules/dep/index.js", "dependency");
  return root;
}

function newBundle(version = "1.0.1+new", extra = []) {
  return createZipBuffer([
    { name: "package.json", data: Buffer.from(JSON.stringify({ name: "t", version: "1.0.1" })) },
    { name: "server/index.js", data: Buffer.from("// new server") },
    { name: "dist/assets/app-new.js", data: Buffer.from("new bundle") },
    { name: "wflow-version.json", data: Buffer.from(JSON.stringify({ version })) },
    ...extra,
  ]);
}

// ---- versions ----

test("every shipped bundle names its version, and the version follows the files", () => {
  selfhost.resetBundleCache();
  const b = selfhost.buildSelfhostBundle();
  assert.match(b.version, /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
  const a = [{ name: "a.js", data: Buffer.from("1") }];
  assert.equal(selfhost.versionOf(a), selfhost.versionOf([{ name: "a.js", data: Buffer.from("1") }]));
  assert.notEqual(selfhost.versionOf(a), selfhost.versionOf([{ name: "a.js", data: Buffer.from("2") }]));
});

test("a copy's licence check learns the newest version", async () => {
  lic.resetLicenseCache();
  await lic.refreshLicense({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, plan: "pro", seats: 1, validUntil: Date.now() + 1e9, latestVersion: "9.9.9+abc" }) }),
  });
  assert.equal((await lic.licenseStatus()).latestVersion, "9.9.9+abc");
});

test("only a self-hosted copy that is not a git checkout updates itself", () => {
  const root = oldCopy();
  assert.equal(updater.canSelfUpdate(root).ok, true);
  fs.mkdirSync(path.join(root, ".git"));
  assert.match(updater.canSelfUpdate(root).reason, /git pull/);
  delete process.env.WFLOW_STANDALONE;
  assert.equal(updater.canSelfUpdate(oldCopy()).ok, false, "the cloud is updated by deploying");
  process.env.WFLOW_STANDALONE = "1";
});

// ---- the swap ----

test("the swap replaces app files, drops removed ones and never touches .env, data or node_modules", () => {
  const root = oldCopy();
  const version = updater.installBundleFiles(
    newBundle("1.0.1+new", [
      { name: "../escape.txt", data: Buffer.from("x") },
      { name: "data/admin.db", data: Buffer.from("overwritten!") },
      { name: ".env", data: Buffer.from("BF_ENCRYPTION_KEY=stolen") },
    ]),
    root
  );
  assert.equal(version, "1.0.1+new");
  assert.equal(read(root, "server/index.js"), "// new server");
  assert.equal(exists(root, "server/removed-later.js"), false, "a file the new version dropped is removed");
  assert.equal(exists(root, "dist/assets/app-old.js"), false, "old built assets are removed");
  assert.equal(read(root, "dist/assets/app-new.js"), "new bundle");
  assert.equal(updater.currentVersion(root), "1.0.1+new");
  assert.equal(read(root, ".env"), "BF_ENCRYPTION_KEY=keep-me\n");
  assert.equal(read(root, "data/admin.db"), "the user's database");
  assert.equal(read(root, "node_modules/dep/index.js"), "dependency");
  assert.equal(fs.existsSync(path.join(path.dirname(root), "escape.txt")), false);

  assert.equal(updater.restorePrevious(root), true);
  assert.equal(read(root, "server/index.js"), "// old server");
  assert.equal(read(root, "server/removed-later.js"), "// only in the old version");
  assert.equal(exists(root, "dist/assets/app-new.js"), false);
  assert.equal(updater.currentVersion(root), "1.0.0+old");
});

test("an incomplete download is refused before anything changes", () => {
  const root = oldCopy();
  const zip = createZipBuffer([{ name: "server/index.js", data: Buffer.from("half") }]);
  assert.throws(() => updater.installBundleFiles(zip, root), /not a complete W flow bundle/);
  assert.equal(read(root, "server/index.js"), "// old server");
});

// ---- the whole flow ----

const zipResponse = (zip) => async (url, init) => {
  assert.match(url, /\/api\/selfhosted\/update\/bundle$/);
  assert.deepEqual(Object.keys(JSON.parse(init.body)), ["key"], "only the licence key is sent");
  return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length), json: async () => ({}) };
};

test("Update now downloads, swaps, installs and hands over to the restart", async () => {
  const root = oldCopy();
  const steps = [];
  let restarted = null;
  const r = await updater.applyUpdate({
    root,
    fetchImpl: zipResponse(newBundle()),
    install: async (_root, onStep) => {
      onStep("Installing dependencies…");
      steps.push("install");
    },
    restart: async (rt) => (restarted = rt),
  });
  assert.deepEqual(r, { ok: true, from: "1.0.0+old", target: "1.0.1+new" });
  assert.deepEqual(steps, ["install"]);
  assert.equal(restarted, root);
  const st = updater.readUpdateState(root);
  assert.equal(st.phase, "restarting");
  assert.equal(st.target, "1.0.1+new");
});

test("a failed install puts the previous version back and reports why", async () => {
  const root = oldCopy();
  let calls = 0;
  await assert.rejects(
    () =>
      updater.applyUpdate({
        root,
        fetchImpl: zipResponse(newBundle()),
        install: async () => {
          calls++;
          if (calls === 1) throw new Error("npm ci failed");
        },
        restart: async () => assert.fail("must not restart"),
      }),
    /npm ci failed/
  );
  assert.equal(calls, 2, "dependencies are reinstalled for the restored version");
  assert.equal(read(root, "server/index.js"), "// old server");
  assert.equal(updater.currentVersion(root), "1.0.0+old");
  const st = updater.readUpdateState(root);
  assert.equal(st.phase, "failed");
  assert.match(st.error, /npm ci failed/);
});

test("a refused download (lapsed licence) changes nothing", async () => {
  const root = oldCopy();
  await assert.rejects(
    () =>
      updater.applyUpdate({
        root,
        fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: "The Pro subscription behind this licence has ended." }) }),
        install: async () => assert.fail("must not install"),
        restart: async () => assert.fail("must not restart"),
      }),
    /subscription .* has ended/
  );
  assert.equal(read(root, "server/index.js"), "// old server");
});

// ---- the restart helper, for real ----

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const fakeServer = `import http from "node:http"; import fs from "node:fs"; fs.writeFileSync("fake-server.pid", String(process.pid));
http.createServer((q, s) => { s.setHeader("Content-Type", "application/json"); s.end("{}"); }).listen(Number(process.env.WFLOW_UPDATE_PORT), "127.0.0.1");`;

async function runHelper(root, port, extraEnv = {}) {
  // the helper and the updater it falls back on come from this repo
  for (const f of fs.readdirSync(path.join(REPO, "server"))) {
    if (f === "index.js" || !f.endsWith(".js")) continue;
    fs.copyFileSync(path.join(REPO, "server", f), path.join(root, "server", f));
  }
  fs.cpSync(path.join(REPO, "shared"), path.join(root, "shared"), { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "server", "update-restart.js"), "0"], {
    cwd: root,
    env: { ...process.env, WFLOW_UPDATE_PORT: String(port), WFLOW_RESTART_TIMEOUT_MS: "6000", ...extraEnv },
    stdio: "ignore",
  });
  await new Promise((r) => child.on("exit", r));
}

async function answers(port) {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/auth/config`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test("the restart helper starts the new version", { timeout: 60_000 }, async () => {
  const root = oldCopy();
  write(root, "server/index.js", fakeServer + `\nsetTimeout(() => process.exit(0), 8000);`);
  const port = await freePort();
  await runHelper(root, port);
  assert.equal(await answers(port), true);
  assert.match(read(root, ".wflow-update/update.log"), /the new version is up/);
});

test("the restart helper rolls back when the new version does not start", { timeout: 120_000 }, async () => {
  const root = oldCopy();
  // previous = a working server; the "new" one crashes at once
  write(root, "server/index.js", fakeServer + `\nsetTimeout(() => process.exit(0), 8000);`);
  updater.installBundleFiles(newBundle(), root);
  write(root, "server/index.js", "process.exit(1);");
  write(root, ".wflow-update/state.json", JSON.stringify({ phase: "restarting", target: "1.0.1+new" }));
  const port = await freePort();
  await runHelper(root, port);
  assert.equal(await answers(port), true, "the previous version is running again");
  assert.match(read(root, ".wflow-update/update.log"), /rolling back[\s\S]*previous version was started again/);
  assert.match(read(root, "server/index.js"), /createServer/);
  const st = JSON.parse(read(root, ".wflow-update/state.json"));
  assert.equal(st.phase, "failed");
  assert.match(st.error, /previous one was put back/);
});

// ---- the cloud side, over HTTP ----

test("the cloud names its version in licence answers and ships updates only to valid keys", { timeout: 90_000 }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dbFile = path.join(tempDir, "cloud.db");
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), BF_DB_PATH: dbFile, DISABLE_SCHEDULER: "1", NODE_ENV: "test", DATABASE_URL: "", BF_SITE_DOMAIN: "" };
  delete env.WFLOW_STANDALONE; // this one plays w-flow.tech
  const cloud = spawn(process.execPath, ["server/index.js"], { cwd: REPO, env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`${base}/api/auth/config`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, "cloud server started");
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `upd-${Date.now()}@example.com`, password: "correct-horse-battery", name: "U" }),
    });
    assert.equal(reg.status, 200);
    const cookie = reg.headers.getSetCookie()[0].split(";")[0];
    const raw = new DatabaseSync(dbFile);
    raw.prepare("UPDATE users SET role = 'pro_user'").run();
    raw.close();

    const { key } = await (await fetch(`${base}/api/selfhosted/license`, { headers: { Cookie: cookie } })).json();
    const check = await (await fetch(`${base}/api/license/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) })).json();
    assert.equal(check.valid, true);
    assert.match(check.latestVersion, /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);

    const bundle = await fetch(`${base}/api/selfhosted/update/bundle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get("x-w-flow-version"), check.latestVersion);
    const { readZip } = await import("../server/fileextract.js");
    const entries = readZip(Buffer.from(await bundle.arrayBuffer()));
    const stamp = JSON.parse(entries.find((e) => e.name === "wflow-version.json").data.toString("utf8"));
    assert.equal(stamp.version, check.latestVersion);
    assert.equal(entries.some((e) => e.name.startsWith("data/") || e.name === ".env"), false, "no data and no secrets in an update");

    const refused = await fetch(`${base}/api/selfhosted/update/bundle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "wfl_" + "z".repeat(32) }) });
    assert.equal(refused.status, 403);
  } finally {
    cloud.kill();
    await new Promise((r) => cloud.on("exit", r));
  }
});
