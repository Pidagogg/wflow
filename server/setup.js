// ============================================================================
// W FLOW — instance setup (storage + execution target)
//
// A self-hosted copy is configured from the app itself: Setup (the /setup page,
// or Settings → This instance) writes the answers into the copy's own .env, so
// the next start uses them. Two things are configurable:
//
//   Storage    where workflows, credentials and run history live
//              SQLite file (default, stays on this machine)
//              PostgreSQL  (any server the owner runs — e.g. their own VPS)
//
//   Execution  where workflow runs actually happen
//              this machine (default)
//              a remote runner (the same app installed on another server),
//              reached over HTTP with a shared token
//
// Security model: a copy only ACCEPTS runs from a remote builder when it has
// WFLOW_RUNNER_TOKEN set. Without that token this instance refuses every
// /api/runner request, so a copy that never opted in can never be turned into
// somebody else's execution host. WFLOW_STANDALONE marks a user-owned copy
// (the installer sets it) — it never calls back to the instance the installer
// came from.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { db, databaseEngine } from "./dbx.js";

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// The file the Setup page reads and writes. BF_ENV_PATH points it somewhere
// else (containers, tests, a second copy on the same machine). Resolved on
// every call — never cached at import — so a process that changes the variable
// (a test, a launcher script) always edits the file it means to.
export function envPath() {
  return process.env.BF_ENV_PATH ? path.resolve(process.env.BF_ENV_PATH) : path.join(APP_ROOT, ".env");
}

/** Env keys the Setup page owns. Everything else in .env is left untouched. */
export const MANAGED_KEYS = [
  "BF_DB_PATH",
  "DATABASE_URL",
  "WFLOW_REMOTE_URL",
  "WFLOW_REMOTE_TOKEN",
  "WFLOW_RUNNER_TOKEN",
  "WFLOW_STANDALONE",
];

const TRUE = /^(1|true|yes|on)$/i;

// ---------------------------------------------------------------------------
// Current state (environment as this process actually runs)
// ---------------------------------------------------------------------------

// ---- official cloud ----
// Every installation is a self-hosted copy — which needs a Pro licence key
// (server/license.js) — unless it proves it is the official cloud at
// w-flow.tech. The proof is WFLOW_CLOUD_SECRET, a random value that exists
// only on the licensor's server; the code holds just its SHA-256, so neither
// a flag nor a copy of the code is enough. Setting, patching or removing this
// check on a copy circumvents the licence-key functionality, which the
// Elastic License 2.0 forbids.
const CLOUD_SECRET_SHA256 = "1861700c13c7e2ff8abe0feaac07d8c53284d5d55dcd85035f045a7968cebde6";

/** Whether this process is the official cloud (w-flow.tech). */
export function officialCloud() {
  const secret = String(process.env.WFLOW_CLOUD_SECRET || "").trim();
  if (secret && createHash("sha256").update(secret).digest("hex") === CLOUD_SECRET_SHA256) return true;
  // The test suite: node --test sets NODE_TEST_CONTEXT in every test file's
  // process, so the tests exercise the cloud's behaviour unless a test asks
  // for a copy with WFLOW_STANDALONE=1. Not for running real workflows.
  return !!process.env.NODE_TEST_CONTEXT;
}

/** A self-hosted copy: the installer's copy (WFLOW_STANDALONE) or any installation that is not the official cloud. */
export function standaloneMode() {
  return TRUE.test(String(process.env.WFLOW_STANDALONE || "")) || !officialCloud();
}

/** The token this instance accepts from a remote builder ("" = not a runner). */
export function runnerToken() {
  return String(process.env.WFLOW_RUNNER_TOKEN || "").trim();
}

/** True when this instance may execute runs sent by a remote builder. */
export function acceptsRemoteRuns() {
  return runnerToken().length > 0;
}

/** Where this instance sends its runs (empty url = execute locally). */
export function remoteTarget() {
  return {
    url: String(process.env.WFLOW_REMOTE_URL || "").trim().replace(/\/+$/, ""),
    token: String(process.env.WFLOW_REMOTE_TOKEN || "").trim(),
  };
}

/** True when runs are dispatched to another server instead of this one. */
export function remoteEnabled() {
  const { url, token } = remoteTarget();
  return !!url && !!token;
}

/** SQLite file this copy uses ("" when PostgreSQL is selected). */
export function sqlitePath() {
  const raw = String(process.env.BF_DB_PATH || "").trim();
  return raw || path.join(APP_ROOT, "data", "admin.db");
}

export function databaseUrl() {
  return String(process.env.DATABASE_URL || "").trim();
}

/** A fresh secret for the token fields. */
export function newSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

// ---------------------------------------------------------------------------
// .env file editing
//
// Read/patch/write keeps every comment, blank line and unknown key exactly as
// it was — the file is the operator's, not ours. Values are written quoted when
// they contain characters a dotenv parser could mangle.
// ---------------------------------------------------------------------------

/** Parse the .env file into `{ key: value }` (last assignment wins). */
export function readEnvFile() {
  const values = {};
  let text = "";
  try {
    text = fs.readFileSync(envPath(), "utf8");
  } catch {
    return values; // no .env yet — every setting falls back to the defaults
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[m[1]] = value;
  }
  return values;
}

function formatValue(value) {
  const v = String(value ?? "");
  return /[\s#'"\\]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

/**
 * Apply `patch` (key → value; "" or null/undefined deletes the key) to .env.
 * Returns the keys that actually changed. The write is atomic: a temp file is
 * renamed over the old one, so an interrupted save can never truncate .env.
 */
export function writeEnvValues(patch) {
  let text = "";
  try {
    text = fs.readFileSync(envPath(), "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/);
  const pending = new Map(Object.entries(patch).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)]));
  const changed = [];
  const kept = [];

  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !pending.has(m[1])) {
      kept.push(line);
      continue;
    }
    const key = m[1];
    const next = pending.get(key);
    pending.delete(key);
    const before = m[2].trim().replace(/^["']|["']$/g, "");
    if (!next) {
      // key removed — drop the line
      if (before !== "") changed.push(key);
      continue;
    }
    kept.push(`${key}=${formatValue(next)}`);
    if (before !== next) changed.push(key);
  }

  // Keys that were not in the file yet. An empty value means "remove": no line
  // is written, but a key that is still active in this process counts as
  // changed too — the caller then reports it and asks for the restart it needs.
  const added = [];
  for (const [key, value] of pending) {
    if (!value) {
      if (String(process.env[key] ?? "").trim() !== "") changed.push(key);
      continue;
    }
    added.push(`${key}=${formatValue(value)}`);
    changed.push(key);
  }

  let body = kept.join("\n").replace(/\n+$/, "");
  if (added.length) body += `${body ? "\n" : ""}${added.join("\n")}\n`;
  else body += "\n";

  try {
    const target = envPath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, target);
  } catch (err) {
    throw new Error(`Could not write .env: ${String(err.message || err)}`);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function cleanPath(raw) {
  const v = String(raw || "").trim();
  if (!v || /[\r\n]/.test(v)) return "";
  return v;
}

export function validDatabaseUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (!/^postgres(ql)?:\/\//i.test(v)) return null;
  try {
    new URL(v);
  } catch {
    return null;
  }
  return v;
}

export function validRunnerUrl(raw) {
  const v = String(raw || "").trim().replace(/\/+$/, "");
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) return null;
  try {
    new URL(v);
  } catch {
    return null;
  }
  return v;
}

/** Hide the password in a connection URL so it is safe to send to the browser. */
export function maskUrl(raw) {
  const v = String(raw || "");
  if (!v) return "";
  try {
    const u = new URL(v);
    if (u.password) u.password = "••••";
    return u.toString();
  } catch {
    return v.replace(/:\/\/([^@/]*):[^@/]*@/, "://$1:••••@");
  }
}

// ---------------------------------------------------------------------------
// Read / write the setup
// ---------------------------------------------------------------------------

/** Everything the Setup page shows. Secrets are never echoed back. */
export function readSetup() {
  const file = readEnvFile();
  const remote = remoteTarget();
  return {
    standalone: standaloneMode(),
    // the backend this process is actually using right now
    activeEngine: databaseEngine,
    storage: {
      engine: databaseUrl() ? "postgres" : "sqlite",
      sqlitePath: String(file.BF_DB_PATH || process.env.BF_DB_PATH || "").trim() || sqlitePath(),
      databaseUrl: maskUrl(databaseUrl()),
      hasDatabaseUrl: !!databaseUrl(),
    },
    execution: {
      mode: remoteEnabled() ? "remote" : "local",
      remoteUrl: remote.url,
      hasRemoteToken: !!remote.token,
      // this copy as an execution host for another builder
      acceptsRuns: acceptsRemoteRuns(),
      hasRunnerToken: acceptsRemoteRuns(),
      runnerToken: runnerToken(), // shown once the owner asks for it (their own copy)
    },
    port: Number(process.env.PORT || 3001) || 3001,
    restartRequired: restartRequired(),
    envPath: envPath(),
  };
}

/** Are the values in .env different from the ones this process is running with? */
export function restartRequired() {
  const file = readEnvFile();
  const active = {
    BF_DB_PATH: String(process.env.BF_DB_PATH || "").trim(),
    DATABASE_URL: String(process.env.DATABASE_URL || "").trim(),
    WFLOW_REMOTE_URL: String(process.env.WFLOW_REMOTE_URL || "").trim().replace(/\/+$/, ""),
    WFLOW_REMOTE_TOKEN: String(process.env.WFLOW_REMOTE_TOKEN || "").trim(),
    WFLOW_RUNNER_TOKEN: String(process.env.WFLOW_RUNNER_TOKEN || "").trim(),
    WFLOW_STANDALONE: String(process.env.WFLOW_STANDALONE || "").trim(),
  };
  for (const key of MANAGED_KEYS) {
    const fromFile = String(file[key] ?? "").trim();
    if (fromFile !== active[key]) return true;
  }
  return false;
}

/**
 * Save what the Setup page sent. Only the values that were actually provided
 * are touched, so a form that only edits execution never rewrites storage.
 * Returns `{ ok, changed, restartRequired, runnerToken? }`.
 */
export function saveSetup(body = {}) {
  const patch = {};
  const errors = [];

  const storage = body.storage || null;
  if (storage) {
    const engine = String(storage.engine || "").toLowerCase();
    if (!["sqlite", "postgres"].includes(engine)) {
      errors.push("Storage must be either the local SQLite file or PostgreSQL.");
    } else if (engine === "sqlite") {
      const p = cleanPath(storage.sqlitePath);
      if (p && p !== sqlitePath()) {
        patch.BF_DB_PATH = p;
        patch.DATABASE_URL = "";
      }
    } else {
      const url = validDatabaseUrl(storage.databaseUrl);
      if (url === null) errors.push("The PostgreSQL URL must look like postgres://user:password@host:5432/database.");
      else if (url) {
        patch.DATABASE_URL = url;
        patch.BF_DB_PATH = "";
      }
    }
  }

  const execution = body.execution || null;
  if (execution) {
    const mode = String(execution.mode || "").toLowerCase();
    if (!["local", "remote"].includes(mode)) errors.push("Execution must be either this machine or a remote runner.");
    else if (mode === "local") {
      patch.WFLOW_REMOTE_URL = "";
      patch.WFLOW_REMOTE_TOKEN = "";
    } else {
      const url = validRunnerUrl(execution.remoteUrl);
      if (url === null) errors.push("The runner URL must start with http:// or https://");
      const token = String(execution.remoteToken || "").trim() || remoteTarget().token;
      if (url && !token) errors.push("A remote runner needs its token — copy it from the runner's own Setup page.");
      if (url && token) {
        patch.WFLOW_REMOTE_URL = url;
        patch.WFLOW_REMOTE_TOKEN = token;
      }
    }
    // Does this copy accept runs from a builder elsewhere?
    if (execution.acceptRuns !== undefined) {
      const wanted = !!execution.acceptRuns;
      const provided = String(execution.runnerToken || "").trim();
      if (!wanted) patch.WFLOW_RUNNER_TOKEN = "";
      else patch.WFLOW_RUNNER_TOKEN = provided || runnerToken() || newSecret();
    }
  }

  if (errors.length) return { ok: false, error: errors[0], errors, changed: [] };
  if (!Object.keys(patch).length) return { ok: true, changed: [], restartRequired: restartRequired() };

  const changed = writeEnvValues(patch);
  const out = { ok: true, changed, restartRequired: restartRequired() };
  if (patch.WFLOW_RUNNER_TOKEN) out.runnerToken = patch.WFLOW_RUNNER_TOKEN;
  return out;
}

// ---------------------------------------------------------------------------
// Tests the Setup page can run before saving
// ---------------------------------------------------------------------------

/** Try a PostgreSQL connection with the URL the user typed. */
export async function testDatabase(url) {
  const checked = validDatabaseUrl(url);
  if (checked === null) return { ok: false, message: "That does not look like a postgres:// connection URL." };
  if (!checked) return { ok: false, message: "Enter a PostgreSQL connection URL first." };
  let pg;
  try {
    pg = await import("pg");
  } catch {
    return { ok: false, message: "The PostgreSQL driver is not installed in this copy (npm install pg)." };
  }
  const Client = pg.default?.Client || pg.Client;
  const client = new Client({ connectionString: checked, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    const res = await client.query("select version()");
    const version = String(res.rows?.[0]?.version || "").split(" ").slice(0, 2).join(" ");
    return { ok: true, message: `Connected — ${version || "PostgreSQL"}.` };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${String(err.message || err)}` };
  } finally {
    try {
      await client.end();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Who may open the Setup page
// ---------------------------------------------------------------------------

/**
 * The instance owner: an admin, or — on a copy the user installed themselves
 * (standalone) — the oldest account, so the person who set it up is never
 * locked out of their own settings.
 */
export async function setupAllowed(user) {
  if (!user) return false;
  if (String(user.role || "") === "admin") return true;
  if (!standaloneMode()) return false;
  try {
    const users = await db.listUsers();
    const list = Array.isArray(users) ? users : [];
    return !!list.length && String(list[list.length - 1].id) === String(user.userId);
  } catch {
    return false;
  }
}
