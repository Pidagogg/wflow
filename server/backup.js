// ============================================================================
// W FLOW — backups
//
// Snapshots the whole `./data` folder (the SQL database + every JSON store +
// uploaded files + the encryption keyfile) into `./data/backups/<timestamp>/`
// and, when `tar` is available, packs it into a single `.tar.gz` archive.
//
// - SQLite: the database is snapshotted with VACUUM INTO, so the copy is
//   consistent even while the app is running.
// - PostgreSQL: the snapshot is a logical JSON dump of every table (portable,
//   no pg_dump required). For byte-exact backups use pg_dump / Patroni.
// - The events journal lives in the same database, so it is backed up too.
//
// Retention keeps the newest N snapshots (default 7). A scheduler runs the
// backup every N hours (default 24) when enabled from the admin panel.
// ============================================================================
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rawDb, db, databaseEngine } from "./dbx.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BF_DATA_DIR ? path.resolve(process.env.BF_DATA_DIR) : path.join(__dirname, "..", "data");
// Exported so the admin panel's download route resolves the SAME folder as the
// backup writer (it honours BF_DATA_DIR, which tests and multi-instance setups set).
export const BACKUP_DIR = path.join(DATA_DIR, "backups");

// Paths inside ./data that are not part of a backup (the backups folder itself,
// live WAL/SHM sidecar files, and the runtime log).
const SKIP = new Set(["backups", "admin.db-wal", "admin.db-shm", "server.log"]);

const DEFAULTS = { enabled: false, intervalHours: 24, keep: 7 };

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const e of fs.readdirSync(src)) copyRecursive(path.join(src, e), path.join(dest, e));
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

// Run tar portably. GNU tar on Windows reads a drive-letter path like
// "C:\tmp\x.tar.gz" as a remote host (host:path) and fails with "Cannot connect
// to C"; `--force-local` disables that. bsdtar does not know the flag, so fall
// back to the plain invocation before giving up.
async function tarRun(args) {
  try {
    return await execFileAsync("tar", ["--force-local", ...args], { timeout: 120_000 });
  } catch (firstErr) {
    try {
      return await execFileAsync("tar", args, { timeout: 120_000 });
    } catch {
      throw firstErr;
    }
  }
}

async function pack(stagingDir, archivePath) {
  try {
    await tarRun(["-czf", archivePath, "-C", stagingDir, "."]);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return archivePath;
  } catch {
    // No usable tar — keep the folder, it is a perfectly good backup.
    return stagingDir;
  }
}

// ----------------------------------------------------------------------------
// settings
// ----------------------------------------------------------------------------
export async function getBackupSettings() {
  let stored = {};
  try {
    stored = JSON.parse((await db.storeGet("backup.settings")) || "{}");
  } catch {
    stored = {};
  }
  return { ...DEFAULTS, ...stored };
}

export async function saveBackupSettings(patch = {}) {
  const current = await getBackupSettings();
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : !!patch.enabled,
    intervalHours: Math.min(Math.max(Number(patch.intervalHours ?? current.intervalHours) || 24, 1), 24 * 30),
    keep: Math.min(Math.max(Number(patch.keep ?? current.keep) || 7, 1), 365),
  };
  await db.storeSet("backup.settings", JSON.stringify(next));
  await db.storeSet("backup.lastRun", String((await db.storeGet("backup.lastRun")) || ""));
  startBackupScheduler();
  return next;
}

// ----------------------------------------------------------------------------
// run a backup
// ----------------------------------------------------------------------------
export async function runBackup({ reason = "manual" } = {}) {
  ensureDir(BACKUP_DIR);
  const name = `backup-${stamp()}`;
  const staging = ensureDir(path.join(BACKUP_DIR, name));
  const result = { name, reason, createdAt: new Date().toISOString(), engine: databaseEngine, db: null, files: [], warnings: [] };

  // 1. the database (SQLite file / Postgres logical dump)
  try {
    const dbFile = path.join(staging, databaseEngine === "postgres" ? "database.json" : "admin.db");
    const info = await rawDb.backupTo(dbFile);
    result.db = { file: path.basename(info.file), format: info.format };
  } catch (err) {
    result.warnings.push(`database snapshot failed: ${String(err?.message || err)}`);
  }

  // 2. every other file in ./data (JSON stores, uploaded files, keyfile)
  let entries = [];
  try {
    entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    if (e.name === "admin.db" || e.name.startsWith("admin.db-")) continue; // handled above
    try {
      copyRecursive(path.join(DATA_DIR, e.name), path.join(staging, e.name));
      result.files.push(e.name);
    } catch (err) {
      result.warnings.push(`could not copy ${e.name}: ${String(err?.message || err)}`);
    }
  }

  // 3. manifest + archive
  result.sizeBytes = dirSize(staging);
  try {
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(result, null, 2));
  } catch {
    /* ignore */
  }
  const finalPath = await pack(staging, path.join(BACKUP_DIR, `${name}.tar.gz`));
  result.archive = path.basename(finalPath);
  result.packed = finalPath.endsWith(".tar.gz");
  result.path = finalPath;
  result.sizeBytes = result.packed ? (() => { try { return fs.statSync(finalPath).size; } catch { return result.sizeBytes; } })() : result.sizeBytes;

  await db.storeSet("backup.lastRun", result.createdAt);
  await pruneBackups();
  return result;
}

// ----------------------------------------------------------------------------
// list / delete / restore
// ----------------------------------------------------------------------------
export function listBackups() {
  ensureDir(BACKUP_DIR);
  const out = [];
  for (const e of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
    if (e.name === "restore-tmp") continue;
    const full = path.join(BACKUP_DIR, e.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    let manifest = null;
    try {
      const mf = e.isDirectory() ? path.join(full, "manifest.json") : null;
      if (mf && fs.existsSync(mf)) manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
    } catch {
      manifest = null;
    }
    out.push({
      name: e.name,
      kind: e.isDirectory() ? "folder" : "archive",
      createdAt: (manifest && manifest.createdAt) || stat.mtime.toISOString(),
      sizeBytes: e.isDirectory() ? dirSize(full) : stat.size,
      engine: (manifest && manifest.engine) || "",
      reason: (manifest && manifest.reason) || "",
      warnings: (manifest && manifest.warnings) || [],
    });
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export function deleteBackup(name) {
  const safe = path.basename(String(name || ""));
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid backup name.");
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) return false;
  fs.rmSync(full, { recursive: true, force: true });
  return true;
}

export async function pruneBackups() {
  const { keep } = await getBackupSettings();
  const list = listBackups();
  const removed = [];
  for (const b of list.slice(keep)) {
    try {
      fs.rmSync(path.join(BACKUP_DIR, b.name), { recursive: true, force: true });
      removed.push(b.name);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/**
 * Restore a snapshot over the live ./data folder. SQLite only: PostgreSQL is
 * refused because restoring it belongs to pg_restore / Patroni. Closes the
 * database handle first, then copies the files back. A restart is required.
 */
export async function restoreBackup(name) {
  if (databaseEngine === "postgres") {
    throw new Error(
      "Restoring a running PostgreSQL database is not supported here — use pg_restore or Patroni (see the PostgreSQL tab) to restore the snapshot file."
    );
  }
  const safe = path.basename(String(name || ""));
  const full = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(full)) throw new Error("Backup not found.");

  let source = full;
  if (!fs.statSync(full).isDirectory()) {
    const tmp = ensureDir(path.join(BACKUP_DIR, "restore-tmp"));
    fs.rmSync(tmp, { recursive: true, force: true });
    ensureDir(tmp);
    try {
      await tarRun(["-xzf", full, "-C", tmp]);
    } catch (err) {
      throw new Error(`Could not extract the archive (is 'tar' installed?): ${String(err?.message || err)}`);
    }
    source = tmp;
  }

  // Stop the SQLite handle so the database file can be replaced on Windows.
  try {
    rawDb.closeDb?.();
  } catch {
    /* ignore */
  }

  const restored = [];
  for (const e of fs.readdirSync(source, { withFileTypes: true })) {
    if (e.name === "manifest.json") continue;
    const from = path.join(source, e.name);
    const to = path.join(DATA_DIR, e.name);
    try {
      fs.rmSync(to, { recursive: true, force: true });
      copyRecursive(from, to);
      restored.push(e.name);
    } catch (err) {
      throw new Error(`Could not restore ${e.name}: ${String(err?.message || err)}`);
    }
  }
  if (source !== full) fs.rmSync(source, { recursive: true, force: true });
  return { restored, restartRequired: true };
}

// ----------------------------------------------------------------------------
// scheduler — runs in the main server process only
// ----------------------------------------------------------------------------
let timer = null;
let running = false;

export function stopBackupScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function startBackupScheduler({ onRun } = {}) {
  stopBackupScheduler();
  // Re-read settings whenever we reschedule; check every 10 minutes whether a
  // backup is due, rather than trusting one long interval (settings can change).
  timer = setInterval(async () => {
    if (running) return;
    let settings;
    try {
      settings = await getBackupSettings();
    } catch {
      return;
    }
    if (!settings.enabled) return;
    const last = (await db.storeGet("backup.lastRun")) || "";
    const due = !last || Date.now() - Date.parse(last) >= settings.intervalHours * 60 * 60_000;
    if (!due) return;
    running = true;
    try {
      const result = await runBackup({ reason: "scheduled" });
      if (onRun) onRun(result);
      console.log(`  [backup] scheduled snapshot written: ${result.name} (${result.sizeBytes} bytes)`);
    } catch (err) {
      console.error("  [backup] scheduled snapshot failed:", err?.message || err);
    } finally {
      running = false;
    }
  }, 10 * 60_000);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
