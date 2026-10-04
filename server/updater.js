// ============================================================================
// W FLOW — one-click update of a self-hosted copy
//
// A copy runs the version it was installed with until it updates. The cloud
// stamps every bundle it ships with a version (server/selfhost.js versionOf:
// package version + a hash of every shipped file) and names its current one in
// each licence answer (server/license.js), so the copy learns about a new
// version at its regular check — still sending nothing but its key.
//
// "Update now" (instance owner, Setup page or the banner) then:
//
//   1. downloads the new bundle from the cloud with the licence key
//   2. backs up the app files it replaces into .wflow-update/previous
//   3. writes the new files over the app (never .env, ./data or node_modules)
//      and removes files the new version no longer has from the app folders
//   4. installs dependencies (npm ci) and builds the interface when the bundle
//      carries its sources — a failure here restores the backup at once
//   5. hands over to server/update-restart.js, a detached helper that waits for
//      this process to exit, starts the new version and checks it answers; if
//      it does not, the helper restores the backup and starts the old version
//
// Not offered for a developer checkout (a .git folder — use git pull), for
// Docker (the image is replaced, not its files — docker compose pull) or on
// the cloud itself.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readZip } from "./fileextract.js";
import { SHIP_DIRS, SHIP_FILES, VERSION_FILE } from "./selfhost.js";
import { licenseRequired, licenseServer, localLicenseKey, licenseStatus } from "./license.js";

export const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK_DIR = ".wflow-update";

// ---- versions ----

/** The version this copy runs: the stamp its bundle carried ("" when unknown). */
export function currentVersion(root = APP_ROOT) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, VERSION_FILE), "utf8")).version || "");
  } catch {
    return "";
  }
}

/** Can this install update itself? → { ok, reason } */
export function canSelfUpdate(root = APP_ROOT) {
  if (!licenseRequired()) return { ok: false, reason: "Only a self-hosted copy updates itself — the cloud is updated by deploying." };
  if (fs.existsSync(path.join(root, ".git"))) return { ok: false, reason: "This copy is a git checkout — update it with git pull." };
  if (fs.existsSync("/.dockerenv")) return { ok: false, reason: "This copy runs in Docker — update it with docker compose pull && docker compose up -d." };
  return { ok: true, reason: "" };
}

// ---- progress (survives the restart in .wflow-update/state.json) ----

let state = null;

function stateFile(root) {
  return path.join(root, WORK_DIR, "state.json");
}

export function readUpdateState(root = APP_ROOT) {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
  } catch {
    state = { phase: "idle", message: "", error: "" };
  }
  return state;
}

function setState(root, patch) {
  state = { ...readUpdateState(root), ...patch, at: Date.now() };
  try {
    fs.mkdirSync(path.join(root, WORK_DIR), { recursive: true });
    fs.writeFileSync(stateFile(root), JSON.stringify(state, null, 2));
  } catch {
    /* progress is best-effort */
  }
  return state;
}

/** Test hook. */
export function resetUpdateState() {
  state = null;
}

/** What the Setup page and the banner show. */
export async function updateStatus(root = APP_ROOT) {
  const lic = await licenseStatus();
  const current = currentVersion(root);
  const latest = String(lic.latestVersion || "");
  const can = canSelfUpdate(root);
  let st = readUpdateState(root);
  // A finished restart: the helper started the version we were going to.
  if (st.phase === "restarting" && st.target && st.target === current) st = setState(root, { phase: "done", message: `Updated to ${current}.`, error: "" });
  return {
    current: current || "unknown",
    latest,
    available: !!latest && latest !== current,
    canUpdate: can.ok,
    reason: can.reason,
    state: st,
  };
}

// ---- the file swap (pure enough to test on a temp folder) ----

/** Paths an update may touch: the shipped folders and root files, nothing else. */
function isAppPath(rel) {
  const top = rel.split("/")[0];
  return SHIP_DIRS.includes(top) || SHIP_FILES.includes(rel) || rel === VERSION_FILE;
}

function safeRel(name) {
  const rel = String(name || "").replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..") || /^[A-Za-z]:/.test(rel)) return "";
  return rel;
}

function listFiles(dir, base = dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      listFiles(full, base, out);
    } else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Every app file the copy has now (relative paths). */
function currentAppFiles(root) {
  const out = [];
  for (const dir of SHIP_DIRS) for (const f of listFiles(path.join(root, dir))) out.push(`${dir}/${f}`);
  for (const f of [...SHIP_FILES, VERSION_FILE]) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out;
}

function copyInto(fromRoot, toRoot, rels) {
  for (const rel of rels) {
    const src = path.join(fromRoot, rel);
    const dst = path.join(toRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/** Put the backed-up app files back exactly as they were. */
export function restorePrevious(root = APP_ROOT) {
  const prev = path.join(root, WORK_DIR, "previous");
  if (!fs.existsSync(prev)) return false;
  const keep = new Set(listFiles(prev));
  for (const rel of currentAppFiles(root)) if (!keep.has(rel)) fs.rmSync(path.join(root, rel), { force: true });
  copyInto(prev, root, [...keep]);
  return true;
}

/**
 * Swap the app files for the bundle's. Returns the new version. `.env`,
 * `./data` and `node_modules` are never touched because they are not app paths.
 */
export function installBundleFiles(zip, root = APP_ROOT) {
  const entries = readZip(zip).filter((e) => e.data);
  const files = new Map();
  for (const e of entries) {
    const rel = safeRel(e.name);
    if (rel && isAppPath(rel)) files.set(rel, e.data);
  }
  const stamp = files.get(VERSION_FILE);
  if (!stamp || !files.has("package.json") || !files.has("server/index.js")) throw new Error("The download is not a complete W flow bundle.");
  const version = String(JSON.parse(stamp.toString("utf8")).version || "");

  // back up what is there now
  const prev = path.join(root, WORK_DIR, "previous");
  fs.rmSync(prev, { recursive: true, force: true });
  copyInto(root, prev, currentAppFiles(root));

  // drop files the new version no longer has (old built assets, removed modules)
  for (const rel of currentAppFiles(root)) if (!files.has(rel)) fs.rmSync(path.join(root, rel), { force: true });
  for (const [rel, data] of files) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
  }
  return version;
}

// ---- dependencies ----

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which Node only starts through a shell
    const child = spawn(cmd, args, { cwd, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let tail = "";
    const keep = (d) => (tail = (tail + d.toString()).slice(-4000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed (exit ${code}):\n${tail.trim().slice(-1500)}`))));
  });
}

/** npm ci (dev deps only when the interface must be built), then the build. */
export async function installDependencies(root = APP_ROOT, onStep = () => {}) {
  const buildsUi = fs.existsSync(path.join(root, "src")) && fs.existsSync(path.join(root, "vite.config.ts"));
  const lock = fs.existsSync(path.join(root, "package-lock.json"));
  onStep("Installing dependencies…");
  await run("npm", [lock ? "ci" : "install", ...(buildsUi ? [] : ["--omit=dev"]), "--no-audit", "--no-fund"], root);
  if (buildsUi) {
    onStep("Building the interface…");
    await run("npm", ["run", "build"], root);
  }
}

// ---- the whole update ----

let running = false;

/**
 * Download, swap, install and restart. Resolves once the restart is handed
 * over (the process exits right after); rejects — with the old version back
 * in place — when anything before the restart fails.
 */
export async function applyUpdate({
  root = APP_ROOT,
  fetchImpl = globalThis.fetch,
  install = installDependencies,
  restart = restartIntoNewVersion,
} = {}) {
  const can = canSelfUpdate(root);
  if (!can.ok) throw new Error(can.reason);
  if (running) throw new Error("An update is already running.");
  running = true;
  const from = currentVersion(root);
  try {
    setState(root, { phase: "downloading", message: "Downloading the new version…", error: "", from });
    const res = await fetchImpl(`${licenseServer()}/api/selfhosted/update/bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: localLicenseKey() }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `The update server answered ${res.status}.`);
    }
    const zip = Buffer.from(await res.arrayBuffer());

    setState(root, { phase: "installing", message: "Replacing the app files…" });
    const target = installBundleFiles(zip, root);
    try {
      await install(root, (message) => setState(root, { message }));
    } catch (err) {
      setState(root, { message: "Install failed — putting the previous version back…" });
      restorePrevious(root);
      await install(root, () => {}).catch(() => {});
      throw err;
    }
    setState(root, { phase: "restarting", message: "Restarting into the new version…", target });
    await restart(root);
    return { ok: true, from, target };
  } catch (err) {
    setState(root, { phase: "failed", message: "", error: String(err.message || err) });
    throw err;
  } finally {
    running = false;
  }
}

/** Start the detached helper, then end this process so it can take the port. */
export async function restartIntoNewVersion(root = APP_ROOT) {
  const helper = spawn(process.execPath, [path.join(root, "server", "update-restart.js"), String(process.pid)], {
    cwd: root,
    env: { ...process.env, WFLOW_UPDATE_PORT: String(process.env.PORT || 3001) },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  helper.unref();
  setTimeout(() => process.exit(0), 800).unref?.();
}
