// ============================================================================
// Admin / cloud database — backed by SQLite (node:sqlite, zero native deps).
// - All queries are parameterised (safe against SQL injection).
// - Sensitive fields are encrypted at rest with AES-256-GCM (see security.js).
// - Passwords are stored as scrypt hashes, never plaintext.
// ============================================================================
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, newSessionToken, digestToken, encryptText, decryptText } from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Allow overriding the database file (used by the test suite for an isolated DB,
// and handy for running multiple instances without clobbering production data).
const DB_PATH = process.env.BF_DB_PATH || path.join(__dirname, "..", "data", "admin.db");

let db = null;

function open() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS admin_user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,            -- sha256 of the raw session token
      user_id INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      encrypted INTEGER NOT NULL DEFAULT 0
    );
    -- Website user accounts (login with email + password on the main site).
    -- Every new registration is inserted here; the same DB also backs the
    -- admin panel, so both sides share one SQL database.
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'user',
      deactivation_reason TEXT NOT NULL DEFAULT '',
      deactivated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,            -- sha256 of the raw session token
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    -- One-time auth tokens: password reset and e-mail verification links.
    -- Stored hashed (sha256 of the raw token, never the token itself) with an
    -- expiry, and deleted as soon as they are used.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,            -- sha256 of the raw token
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,             -- reset | verify
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, kind);
    -- Password sign-ups waiting for their e-mail confirmation. The account in
    -- users is only created once the link is opened, so an address nobody
    -- confirmed never becomes an account. id is the sha256 of the link token.
    CREATE TABLE IF NOT EXISTS pending_signups (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    -- Credentials entered on workflow nodes (AI Agent "configure a model here",
    -- HTTP auth, Slack tokens, …). Stored here — encrypted at rest — instead of
    -- inside the workflow JSON, so exported / community-shared workflows never
    -- carry them. Keyed by workflow + node + config field; the workflow's owner
    -- is kept alongside for admin queries. Lookups are by workflow id so public
    -- webhook runs can resolve the keys too.
    CREATE TABLE IF NOT EXISTS workflow_secrets (
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,            -- AES-256-GCM encrypted
      user_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, node_id, field)
    );
    -- Saved AI agent credentials (the model API key). Mirrors workflow_secrets:
    -- encrypted at rest, kept out of agents.json, re-injected when the owner
    -- opens the agent or a workflow runs it.
    CREATE TABLE IF NOT EXISTS agent_secrets (
      agent_id TEXT NOT NULL,
      field TEXT NOT NULL,
      value TEXT NOT NULL,            -- AES-256-GCM encrypted
      user_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, field)
    );
    -- Paid subscriptions (buyable on the main site via Stripe Checkout). One
    -- row per paying customer (user_id is the account id). Status mirrors the
    -- latest Stripe webhook event (active / trialing / past_due / canceled …).
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL DEFAULT '',
      subscription_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      price_id TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      current_period_end INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Free-plan usage counters (workflow runs the account started: editor Run
    -- clicks + webhook calls to its workflows). One row per account per UTC
    -- day. Pro subscribers are exempt — their runs are never recorded here.
    CREATE TABLE IF NOT EXISTS usage_runs (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
    -- Website activity heartbeats (one row per active user per ~minute). Used
    -- by the admin panel's Analytics tab to chart how many users are online now
    -- or were online over the last hour / day / week / month / year / all time.
    CREATE TABLE IF NOT EXISTS user_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ts INTEGER NOT NULL            -- epoch milliseconds
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON user_activity (ts);
    -- Full workflow JSON stored in the SQL database (instead of the local
    -- ./data/workflows.json file) when the admin enables "Save workflows in
    -- the SQL database" on the Cloud servers page. code is the assigned
    -- per-workflow code (a short random string) used to look a workflow up
    -- again on the server/cloud, e.g. GET /api/workflows/by-code/:code.
    -- Secrets are never stored here: node credentials live in the encrypted
    -- workflow_secrets table and are blanked in the JSON, exactly like the
    -- file-backed store.
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '{}',   -- full workflow JSON (secrets blanked)
      code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_code ON workflows (code) WHERE code <> '';
    CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows (owner_id);
    -- Execution history — one row per workflow run (editor Run, webhook, chat,
    -- schedule, Telegram). Powers the Execution menu's history list: the small
    -- summary columns drive the list, the data column holds the full ExecResult (log,
    -- consoleLog, inputs/outputs, durations) so a past run can be reopened.
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'editor',   -- editor | webhook | chat | schedule | telegram
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 0,
      aborted INTEGER NOT NULL DEFAULT 0,
      node_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      -- AI usage of the run (sum of every model call): tokens and the estimated
      -- cost at the owner's price table when the run was recorded.
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      ai_cost_usd REAL NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}'          -- full ExecResult JSON
    );
    CREATE INDEX IF NOT EXISTS idx_executions_workflow ON executions (workflow_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_owner ON executions (owner_id);
    -- Per-user credential vault: any secret an account wants to store for its
    -- workflows (API keys, tokens, passwords). The payload lives ENCRYPTED at
    -- rest (AES-256-GCM) in the data column; only the owning account can read it.
    CREATE TABLE IF NOT EXISTS user_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '',     -- AES-256-GCM encrypted JSON of the fields
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_user ON user_credentials (user_id);
    -- Per-user variables — named values workflow nodes can reference.
    CREATE TABLE IF NOT EXISTS variables (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      value TEXT NOT NULL DEFAULT '',    -- AES-256-GCM encrypted when secret = 1
      secret INTEGER NOT NULL DEFAULT 0,
      test_value TEXT NOT NULL DEFAULT '', -- used by workflows in the Test environment
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_variables_user ON variables (user_id);
    -- Per-user data tables — lightweight spreadsheets stored in SQL. The columns
    -- field is a JSON array of column names; each row's values live in data_table_rows.
    CREATE TABLE IF NOT EXISTS data_tables (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      columns TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_datatables_user ON data_tables (user_id);
    CREATE TABLE IF NOT EXISTS data_table_rows (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',   -- JSON object of column -> value
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_datarows_table ON data_table_rows (table_id);
    -- Events journal — one row per database contact. Every read/write the app
    -- makes through the db facade is recorded here (batched), so the admin can
    -- audit what touched the database and when. Pruned on a schedule.
    CREATE TABLE IF NOT EXISTS db_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,               -- epoch milliseconds
      source TEXT NOT NULL DEFAULT 'server',   -- server | admin
      actor TEXT NOT NULL DEFAULT '',    -- user id / admin username when known
      op TEXT NOT NULL DEFAULT '',       -- db function that was called
      target TEXT NOT NULL DEFAULT '',   -- table / resource when known
      detail TEXT NOT NULL DEFAULT '',   -- short, non-sensitive argument summary
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_db_events_ts ON db_events (ts);
    -- Operational alerts shown in the admin panel (server down, DB errors, …).
    -- Unresolved alerts are deduplicated by source + title and count occurrences.
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'warning',  -- info | warning | critical
      source TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      occurrences INTEGER NOT NULL DEFAULT 1,
      email_sent INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts (created_at DESC);
  `);
  // migration: keep a per-user registry of assigned workflow ids in SQL (JSON
  // array as TEXT). The JSON workflows file stays the source of truth; this
  // column mirrors it so the assignment is visible/queryable in the database.
  const cols = d.prepare(`SELECT name FROM pragma_table_info('users')`).all().map((r) => r.name);
  if (!cols.includes("workflow_ids")) {
    d.exec("ALTER TABLE users ADD COLUMN workflow_ids TEXT NOT NULL DEFAULT '[]'");
  }
  if (!cols.includes("status")) {
    d.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!cols.includes("role")) {
    d.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!cols.includes("deactivation_reason")) {
    d.exec("ALTER TABLE users ADD COLUMN deactivation_reason TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes("deactivated_at")) {
    d.exec("ALTER TABLE users ADD COLUMN deactivated_at TEXT");
  }
  // 1 once the account's e-mail address has been verified (link or OAuth).
  if (!cols.includes("email_verified")) {
    d.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  }
  d.prepare("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''").run();
  d.prepare("UPDATE users SET role = 'user' WHERE role IS NULL OR role = ''").run();

  // migration: a variable's test value (Test / Live environments).
  const varCols = d.prepare(`SELECT name FROM pragma_table_info('variables')`).all().map((r) => r.name);
  if (!varCols.includes("test_value")) {
    d.exec("ALTER TABLE variables ADD COLUMN test_value TEXT NOT NULL DEFAULT ''");
  }

  // migration: AI token / cost columns on the execution history (added after
  // the executions table shipped). Runs recorded before this stay at 0.
  const execCols = d.prepare(`SELECT name FROM pragma_table_info('executions')`).all().map((r) => r.name);
  if (!execCols.includes("prompt_tokens")) {
    d.exec("ALTER TABLE executions ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!execCols.includes("completion_tokens")) {
    d.exec("ALTER TABLE executions ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!execCols.includes("ai_cost_usd")) {
    d.exec("ALTER TABLE executions ADD COLUMN ai_cost_usd REAL NOT NULL DEFAULT 0");
  }
}

// ----------------------------------------------------------------------------
// generic encrypted key/value store (page + cloud settings)
// ----------------------------------------------------------------------------
export function storeGet(key) {
  const row = open().prepare("SELECT value, encrypted FROM settings WHERE key = ?").get(key);
  if (!row) return null;
  return row.encrypted ? decryptText(row.value) : row.value;
}

export function storeSet(key, value, { encrypted = false } = {}) {
  const toStore = encrypted ? encryptText(String(value)) : String(value);
  open()
    .prepare(
      "INSERT INTO settings (key, value, encrypted) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted"
    )
    .run(key, toStore, encrypted ? 1 : 0);
}

export function storeDelete(key) {
  open().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ----------------------------------------------------------------------------
// admins
// ----------------------------------------------------------------------------
export function seedAdmin({ username, password }) {
  const d = open();
  const existing = d.prepare("SELECT COUNT(*) AS c FROM admin_user").get();
  if (existing.c > 0) return false;
  d.prepare("INSERT INTO admin_user (username, password_hash, created_at) VALUES (?, ?, ?)").run(
    username,
    hashPassword(password),
    new Date().toISOString()
  );
  return true;
}

export function listAdmins() {
  return open()
    .prepare("SELECT id, username, created_at FROM admin_user ORDER BY id")
    .all();
}

export function getUserByUsername(username) {
  return open()
    .prepare("SELECT id, username, password_hash, created_at FROM admin_user WHERE username = ?")
    .get(username) ?? null;
}

export function setAdminPassword(userId, passwordHash) {
  open().prepare("UPDATE admin_user SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

export function setAdminUsername(userId, username) {
  open().prepare("UPDATE admin_user SET username = ? WHERE id = ?").run(String(username).trim(), userId);
}

export function deleteAdmin(userId) {
  open().prepare("DELETE FROM admin_user WHERE id = ?").run(userId);
}

// ----------------------------------------------------------------------------
// sessions
// ----------------------------------------------------------------------------
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

export function createSession(userId) {
  const raw = newSessionToken();
  const id = digestToken(raw);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  open()
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, expiresAt, new Date().toISOString());
  // return the raw token (only shown once, in the cookie)
  return { raw, id, expiresAt };
}

export function getUserForSession(token) {
  const id = digestToken(token);
  const now = Date.now();
  const row = open()
    .prepare(
      "SELECT s.user_id, a.username, s.expires_at FROM sessions s JOIN admin_user a ON a.id = s.user_id WHERE s.id = ?"
    )
    .get(id);
  if (!row) return null;
  if (row.expires_at < now) {
    destroySession(token);
    return null;
  }
  return { userId: row.user_id, username: row.username };
}

export function destroySession(token) {
  open().prepare("DELETE FROM sessions WHERE id = ?").run(digestToken(token));
}

export function destroyAllSessionsForUser(userId) {
  open().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function sessionCount() {
  return open().prepare("SELECT COUNT(*) AS c FROM sessions").get().c;
}

// ----------------------------------------------------------------------------
// website users (main-site login)
// ----------------------------------------------------------------------------
export function createUser({ email, name, passwordHash }) {
  const id = crypto.randomUUID();
  open()
    .prepare("INSERT INTO users (id, email, name, password_hash, created_at, status, role, deactivation_reason) VALUES (?, ?, ?, ?, ?, 'active', 'user', '')")
    .run(id, String(email).trim().toLowerCase(), String(name || "").trim(), passwordHash, new Date().toISOString());
  return getUserByEmail(email);
}

export function getUserByEmail(email) {
  return (
    open()
      .prepare("SELECT id, email, name, password_hash, created_at, last_login, workflow_ids, status, role, deactivation_reason, deactivated_at, email_verified FROM users WHERE email = ?")
      .get(String(email).trim().toLowerCase()) ?? null
  );
}

export function getUserById(id) {
  // includes password_hash so server-side flows (e.g. account changes) can
  // verify the current password; this is never sent to the client as-is
  return open().prepare("SELECT id, email, name, password_hash, created_at, last_login, workflow_ids, status, role, deactivation_reason, deactivated_at, email_verified FROM users WHERE id = ?").get(id) ?? null;
}

// --- one-time auth tokens (password reset / e-mail verification) -------------
const AUTH_TOKEN_TTL_MS = { reset: 1000 * 60 * 60, verify: 1000 * 60 * 60 * 48 };

export function createAuthToken(userId, kind, ttlMs) {
  const d = open();
  const raw = newSessionToken();
  const id = digestToken(raw);
  const ttl = ttlMs || AUTH_TOKEN_TTL_MS[kind] || 1000 * 60 * 60;
  // one live token per kind and account — a new request invalidates the old link
  d.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?").run(String(userId), String(kind));
  d.prepare("INSERT INTO auth_tokens (id, user_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    String(userId),
    String(kind),
    Date.now() + ttl,
    new Date().toISOString()
  );
  return raw;
}

/** Verify + consume a token; returns the user id it belonged to, or null. */
export function consumeAuthToken(raw, kind) {
  const d = open();
  const id = digestToken(String(raw || ""));
  const row = d.prepare("SELECT user_id, expires_at FROM auth_tokens WHERE id = ? AND kind = ?").get(id, String(kind));
  if (!row) return null;
  d.prepare("DELETE FROM auth_tokens WHERE id = ?").run(id);
  if (Number(row.expires_at) < Date.now()) return null;
  return row.user_id;
}

// ----------------------------------------------------------------------------
// pending sign-ups (password registration awaiting e-mail confirmation)
// ----------------------------------------------------------------------------
const PENDING_SIGNUP_TTL_MS = AUTH_TOKEN_TTL_MS.verify;

/** Park a sign-up until its link is opened. Returns the raw link token. */
export function createPendingSignup({ email, name, passwordHash }) {
  const d = open();
  const raw = newSessionToken();
  const addr = String(email).trim().toLowerCase();
  d.prepare("DELETE FROM pending_signups WHERE email = ? OR expires_at < ?").run(addr, Date.now());
  d.prepare(
    "INSERT INTO pending_signups (id, email, name, password_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(digestToken(raw), addr, String(name || "").trim(), passwordHash, Date.now() + PENDING_SIGNUP_TTL_MS, new Date().toISOString());
  return raw;
}

/** The live (unexpired) pending sign-up for an address, or null. */
export function getPendingSignup(email) {
  const row = open()
    .prepare("SELECT email, name, password_hash, expires_at FROM pending_signups WHERE email = ?")
    .get(String(email).trim().toLowerCase());
  return row && Number(row.expires_at) >= Date.now() ? row : null;
}

/** Issue a fresh link for a pending sign-up (the old one stops working). */
export function renewPendingSignup(email) {
  const addr = String(email).trim().toLowerCase();
  if (!getPendingSignup(addr)) return null;
  const raw = newSessionToken();
  open()
    .prepare("UPDATE pending_signups SET id = ?, expires_at = ? WHERE email = ?")
    .run(digestToken(raw), Date.now() + PENDING_SIGNUP_TTL_MS, addr);
  return raw;
}

/** Use a link once: returns { email, name, password_hash } or null. */
export function consumePendingSignup(raw) {
  const d = open();
  const id = digestToken(String(raw || ""));
  const row = d.prepare("SELECT email, name, password_hash, expires_at FROM pending_signups WHERE id = ?").get(id);
  if (!row) return null;
  d.prepare("DELETE FROM pending_signups WHERE id = ?").run(id);
  return Number(row.expires_at) < Date.now() ? null : row;
}

export function deletePendingSignup(email) {
  open().prepare("DELETE FROM pending_signups WHERE email = ?").run(String(email).trim().toLowerCase());
}

export function setEmailVerified(userId, verified = true) {
  open().prepare("UPDATE users SET email_verified = ? WHERE id = ?").run(verified ? 1 : 0, String(userId));
  return getUserById(userId);
}

export function deleteAuthTokensForUser(userId) {
  open().prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(String(userId));
}

export function listUsers() {
  return open().prepare("SELECT id, email, name, created_at, last_login, workflow_ids, status, role, deactivation_reason, deactivated_at FROM users ORDER BY created_at DESC").all();
}

export function countUsers() {
  return open().prepare("SELECT COUNT(*) AS c FROM users").get().c;
}

// Erase the account and everything stored for it (GDPR Art. 17): connected
// accounts and other vault credentials, variables, data tables, run history,
// node secrets of its workflows, sessions and tokens. Both the app's own
// account deletion and the admin panel end here, so nothing tied to the user
// survives whichever door the deletion came through.
export function deleteUser(id) {
  const d = open();
  const uid = String(id);
  const row = d.prepare("SELECT workflow_ids FROM users WHERE id = ?").get(uid);
  let wfIds = [];
  try {
    wfIds = JSON.parse(row?.workflow_ids || "[]").map(String);
  } catch {
    wfIds = [];
  }
  clearRunUsage(uid);
  for (const wf of wfIds) {
    d.prepare("DELETE FROM workflow_secrets WHERE workflow_id = ?").run(wf);
    d.prepare("DELETE FROM executions WHERE workflow_id = ?").run(wf);
  }
  d.prepare("DELETE FROM workflow_secrets WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM executions WHERE owner_id = ?").run(uid);
  d.prepare("DELETE FROM workflows WHERE owner_id = ?").run(uid);
  d.prepare("DELETE FROM user_credentials WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM variables WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM data_table_rows WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM data_tables WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM user_activity WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(uid);
  d.prepare("DELETE FROM users WHERE id = ?").run(uid);
}

export function updateLastLogin(id) {
  open().prepare("UPDATE users SET last_login = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function updateUserStatus(id, status, reason = "") {
  const next = String(status || "").trim().toLowerCase();
  if (!["active", "deactivated"].includes(next)) throw new Error("Invalid user status.");
  const normalizedReason = next === "deactivated" ? String(reason || "").trim().slice(0, 500) : "";
  if (next === "deactivated" && !normalizedReason) throw new Error("A deactivation reason is required.");
  open()
    .prepare("UPDATE users SET status = ?, deactivation_reason = ?, deactivated_at = ? WHERE id = ?")
    .run(next, normalizedReason, next === "deactivated" ? new Date().toISOString() : null, id);
  return getUserById(id);
}

export function updateUserRole(id, role) {
  const next = String(role || "").trim().toLowerCase();
  if (!["user", "pro_user", "admin"].includes(next)) throw new Error("Invalid user role.");
  open().prepare("UPDATE users SET role = ? WHERE id = ?").run(next, id);
  return getUserById(id);
}

// ----------------------------------------------------------------------------
// workflow assignment registry — the users table lists the workflow ids that
// belong to each account (workflow_ids column, JSON array as TEXT).
// ----------------------------------------------------------------------------
function parseIds(text) {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setUserWorkflows(userId, ids) {
  const list = [...new Set((ids || []).map(String))];
  open().prepare("UPDATE users SET workflow_ids = ? WHERE id = ?").run(JSON.stringify(list), userId);
  return list;
}

export function getUserWorkflowIds(userId) {
  const row = open().prepare("SELECT workflow_ids FROM users WHERE id = ?").get(userId);
  return row ? parseIds(row.workflow_ids) : [];
}

export function addWorkflowToUser(userId, workflowId) {
  const current = getUserWorkflowIds(userId);
  if (!current.includes(String(workflowId))) current.push(String(workflowId));
  return setUserWorkflows(userId, current);
}

export function removeWorkflowFromUser(userId, workflowId) {
  return setUserWorkflows(userId, getUserWorkflowIds(userId).filter((id) => id !== String(workflowId)));
}

// ----------------------------------------------------------------------------
// workflows table — full workflow JSON stored in SQL (enabled from the admin
// Cloud servers page). Mirrors the file-backed store's shapes: entries are the
// raw workflow objects ({ id, ownerId, name, nodes, edges, code, … }) with node
// credentials blanked (they live in the encrypted workflow_secrets table).
// ----------------------------------------------------------------------------
function workflowRowToObj(row) {
  let obj = {};
  try {
    obj = JSON.parse(row.data || "{}");
  } catch {
    obj = {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) obj = {};
  obj.id = row.id;
  obj.ownerId = row.owner_id;
  if (row.code) obj.code = row.code;
  if (!obj.createdAt && row.created_at) obj.createdAt = row.created_at;
  if (!obj.updatedAt && row.updated_at) obj.updatedAt = row.updated_at;
  return obj;
}

function genWorkflowCode(d) {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    if (!d.prepare("SELECT 1 FROM workflows WHERE code = ?").get(code)) return code;
  }
  return `WF-${Date.now().toString(36).toUpperCase()}`;
}

export function workflowsCount() {
  return open().prepare("SELECT COUNT(*) AS c FROM workflows").get().c;
}

export function workflowsAll() {
  return open()
    .prepare("SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows ORDER BY updated_at DESC")
    .all()
    .map(workflowRowToObj);
}

export function workflowsGet(id) {
  const row = open()
    .prepare("SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE id = ?")
    .get(String(id));
  return row ? workflowRowToObj(row) : null;
}

export function workflowsListByOwner(ownerId) {
  return open()
    .prepare("SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE owner_id = ? ORDER BY updated_at DESC")
    .all(String(ownerId || ""))
    .map(workflowRowToObj);
}

export function workflowsGetByOwner(id, ownerId) {
  const row = open()
    .prepare("SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE id = ? AND owner_id = ?")
    .get(String(id), String(ownerId || ""));
  return row ? workflowRowToObj(row) : null;
}

// Look a workflow up by its assigned code (the per-workflow code stored in the
// SQL database, used to reach the workflow on the server/cloud).
export function workflowsGetByCode(code) {
  const row = open()
    .prepare("SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE code = ?")
    .get(String(code).trim().toUpperCase());
  return row ? workflowRowToObj(row) : null;
}

// Insert or replace a workflow row. Assigns the per-workflow code on first
// save; re-saving keeps the same code. Returns the stored object.
export function workflowsSave(entry) {
  const d = open();
  const now = new Date().toISOString();
  const id = String(entry?.id || crypto.randomUUID());
  const existing = d.prepare("SELECT created_at, code FROM workflows WHERE id = ?").get(id);
  const createdAt = existing?.created_at || entry?.createdAt || now;
  const code = String(entry?.code || existing?.code || genWorkflowCode(d));
  const obj = { ...(entry || {}), id, code, createdAt, updatedAt: entry?.updatedAt || now };
  d.prepare(
    `INSERT INTO workflows (id, owner_id, name, data, code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       owner_id=excluded.owner_id, name=excluded.name, data=excluded.data,
       code=excluded.code, updated_at=excluded.updated_at`
  ).run(id, String(obj.ownerId || ""), String(obj.name || ""), JSON.stringify(obj), code, createdAt, obj.updatedAt);
  return obj;
}

export function workflowsRemove(id) {
  const info = open().prepare("DELETE FROM workflows WHERE id = ?").run(String(id));
  return Number(info.changes || 0) > 0;
}

export function workflowsRemoveByOwner(id, ownerId) {
  const info = open()
    .prepare("DELETE FROM workflows WHERE id = ? AND owner_id = ?")
    .run(String(id), String(ownerId || ""));
  return Number(info.changes || 0) > 0;
}

// ----------------------------------------------------------------------------
// executions — per-workflow run history (see the executions table comment).
// Summaries feed the Execution menu list; executionGet returns the full run.
// ----------------------------------------------------------------------------
function executionRowToSummary(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    source: row.source,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: Number(row.duration_ms || 0),
    success: !!row.success,
    aborted: !!row.aborted,
    nodeCount: Number(row.node_count || 0),
    errorCount: Number(row.error_count || 0),
    // AI usage recorded with the run (0 when no model was called).
    promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0),
    aiCostUsd: Number(row.ai_cost_usd || 0),
  };
}

export function executionsSave(entry) {
  const id = String(entry?.id || crypto.randomUUID());
  const result = entry?.result || {};
  const usage = result.usage || {};
  open()
    .prepare(
      `INSERT INTO executions (id, workflow_id, owner_id, source, started_at, finished_at, duration_ms, success, aborted, node_count, error_count, prompt_tokens, completion_tokens, ai_cost_usd, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         finished_at=excluded.finished_at, duration_ms=excluded.duration_ms,
         success=excluded.success, aborted=excluded.aborted, error_count=excluded.error_count,
         prompt_tokens=excluded.prompt_tokens, completion_tokens=excluded.completion_tokens,
         ai_cost_usd=excluded.ai_cost_usd, data=excluded.data`
    )
    .run(
      id,
      String(entry?.workflowId || ""),
      String(entry?.ownerId || ""),
      String(entry?.source || "editor"),
      String(entry?.startedAt || result.startedAt || new Date().toISOString()),
      String(entry?.finishedAt || result.finishedAt || ""),
      Number(entry?.durationMs ?? result.durationMs ?? 0),
      entry?.success === undefined ? (result.success ? 1 : 0) : entry.success ? 1 : 0,
      (entry?.aborted ?? result.aborted) ? 1 : 0,
      Number(entry?.nodeCount ?? result.nodeCount ?? 0),
      Number(entry?.errorCount ?? result.errorCount ?? 0),
      Number(entry?.promptTokens ?? usage.prompt ?? 0),
      Number(entry?.completionTokens ?? usage.completion ?? 0),
      Number(entry?.aiCostUsd ?? result.aiCostUsd ?? 0),
      JSON.stringify(result)
    );
  return id;
}

export function executionsListByWorkflow(workflowId, limit = 30) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  return open()
    .prepare(
      "SELECT id, workflow_id, source, started_at, finished_at, duration_ms, success, aborted, node_count, error_count, prompt_tokens, completion_tokens, ai_cost_usd FROM executions WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?"
    )
    .all(String(workflowId), n)
    .map(executionRowToSummary);
}

export function executionGet(id) {
  const row = open().prepare("SELECT * FROM executions WHERE id = ?").get(String(id));
  if (!row) return null;
  let result = {};
  try {
    result = JSON.parse(row.data || "{}");
  } catch {
    result = {};
  }
  return { ...executionRowToSummary(row), result };
}

export function executionsRemoveByWorkflow(workflowId) {
  open().prepare("DELETE FROM executions WHERE workflow_id = ?").run(String(workflowId));
}

/** Delete runs that started before `cutoffIso`. Returns how many went. */
export function executionsPrune(cutoffIso) {
  return Number(open().prepare("DELETE FROM executions WHERE started_at < ?").run(String(cutoffIso)).changes || 0);
}

// Aggregated run statistics for the Main page: how many runs happened without
// anyone pressing Run in the editor ("production"), how many of those failed,
// how long they took in total and on average.
export function executionStatsByOwner(ownerId) {
  const row =
    open()
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN source <> 'editor' THEN 1 ELSE 0 END) AS prod,
           SUM(CASE WHEN source <> 'editor' AND success = 0 THEN 1 ELSE 0 END) AS failed_prod,
           SUM(CASE WHEN source <> 'editor' THEN duration_ms ELSE 0 END) AS prod_ms,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(ai_cost_usd) AS ai_cost,
           AVG(duration_ms) AS avg_ms
         FROM executions WHERE owner_id = ?`
      )
      .get(String(ownerId)) || {};
  const total = Number(row.total || 0);
  const prod = Number(row.prod || 0);
  return {
    totalExecutions: total,
    prodExecutions: prod,
    failedProd: Number(row.failed_prod || 0),
    prodDurationMs: Number(row.prod_ms || 0),
    avgDurationMs: Math.round(Number(row.avg_ms || 0)),
    editorExecutions: total - prod,
    promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0),
    aiCostUsd: Number(row.ai_cost || 0),
  };
}

export function updateUserProfile(userId, { name, email } = {}) {
  const d = open();
  if (name !== undefined) d.prepare("UPDATE users SET name = ? WHERE id = ?").run(String(name).trim(), userId);
  if (email !== undefined) d.prepare("UPDATE users SET email = ? WHERE id = ?").run(String(email).trim().toLowerCase(), userId);
  return getUserById(userId);
}

export function updateUserPassword(userId, passwordHash) {
  open().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

const USER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function createUserSession(userId) {
  const raw = newSessionToken();
  const id = digestToken(raw);
  const expiresAt = Date.now() + USER_SESSION_TTL_MS;
  open()
    .prepare("INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, expiresAt, new Date().toISOString());
  return { raw, id, expiresAt };
}

export function getUserForUserSession(token) {
  const id = digestToken(token);
  const now = Date.now();
  const row = open()
    .prepare(
      "SELECT s.user_id, u.email, u.name, u.workflow_ids, u.status, u.role, s.expires_at FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?"
    )
    .get(id);
  if (!row) return null;
  if (row.expires_at < now) {
    destroyUserSession(token);
    return null;
  }
  if (row.status !== "active") {
    destroyUserSession(token);
    return null;
  }
  return { userId: row.user_id, email: row.email, name: row.name, role: row.role || "user", workflowIds: parseIds(row.workflow_ids) };
}

export function destroyUserSession(token) {
  open().prepare("DELETE FROM user_sessions WHERE id = ?").run(digestToken(token));
}

export function destroyAllUserSessions(userId) {
  open().prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
}

export function destroyOtherUserSessions(userId, keepSessionId) {
  open().prepare("DELETE FROM user_sessions WHERE user_id = ? AND id != ?").run(userId, keepSessionId || "");
}

export function userSessionCount() {
  return open().prepare("SELECT COUNT(*) AS c FROM user_sessions").get().c;
}

// ----------------------------------------------------------------------------
// workflow secrets — credentials entered on workflow nodes, kept OUT of the
// workflow JSON so exports and community posts never carry them. Encrypted at
// rest (AES-256-GCM), looked up by workflow id so webhook runs (which have no
// logged-in user) can resolve them for the workflow's owner.
// ----------------------------------------------------------------------------
export function replaceWorkflowSecrets(workflowId, userId, secrets) {
  const d = open();
  d.prepare("DELETE FROM workflow_secrets WHERE workflow_id = ?").run(workflowId);
  const ins = d.prepare(
    "INSERT INTO workflow_secrets (workflow_id, node_id, field, value, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  for (const s of secrets || []) {
    ins.run(workflowId, String(s.nodeId), String(s.field), encryptText(String(s.value)), String(userId || ""), now);
  }
  return (secrets || []).length;
}

export function getWorkflowSecrets(workflowId) {
  const rows = open()
    .prepare("SELECT node_id, field, value FROM workflow_secrets WHERE workflow_id = ?")
    .all(workflowId);
  return rows
    .map((r) => ({ nodeId: r.node_id, field: r.field, value: decryptText(r.value) }))
    .filter((s) => s.value !== null);
}

export function deleteWorkflowSecrets(workflowId) {
  open().prepare("DELETE FROM workflow_secrets WHERE workflow_id = ?").run(workflowId);
}

// ----------------------------------------------------------------------------
// agent secrets — saved AI agent credentials (model API key), encrypted at
// rest and kept out of agents.json, like workflow_secrets. Looked up by agent
// id so webhook runs (no logged-in user) can resolve the owner's key too.
// ----------------------------------------------------------------------------
export function replaceAgentSecrets(agentId, userId, secrets) {
  const d = open();
  d.prepare("DELETE FROM agent_secrets WHERE agent_id = ?").run(agentId);
  const ins = d.prepare(
    "INSERT INTO agent_secrets (agent_id, field, value, user_id, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  for (const s of secrets || []) {
    ins.run(agentId, String(s.field), encryptText(String(s.value)), String(userId || ""), now);
  }
  return (secrets || []).length;
}

export function getAgentSecrets(agentId) {
  const rows = open()
    .prepare("SELECT field, value FROM agent_secrets WHERE agent_id = ?")
    .all(agentId);
  return rows
    .map((r) => ({ field: r.field, value: decryptText(r.value) }))
    .filter((s) => s.value !== null);
}

export function deleteAgentSecrets(agentId) {
  open().prepare("DELETE FROM agent_secrets WHERE agent_id = ?").run(agentId);
}

// ----------------------------------------------------------------------------
// subscriptions — paid plans bought through Stripe Checkout on the main site.
// This table is written by the billing webhook (server/billing.js) and read by
// the main site's /api/billing endpoint (subscription page) + the admin panel.
// ----------------------------------------------------------------------------
export function setSubscription(userId, fields = {}) {
  const now = new Date().toISOString();
  const existing = getSubscription(userId);
  open()
    .prepare(
      `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, price_id, email, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         customer_id=excluded.customer_id, subscription_id=excluded.subscription_id,
         status=excluded.status, price_id=excluded.price_id, email=excluded.email,
         current_period_end=excluded.current_period_end, updated_at=excluded.updated_at`
    )
    .run(
      userId,
      String(fields.customerId ?? existing?.customer_id ?? ""),
      String(fields.subscriptionId ?? existing?.subscription_id ?? ""),
      String(fields.status ?? existing?.status ?? ""),
      String(fields.priceId ?? existing?.price_id ?? ""),
      String(fields.email ?? existing?.email ?? ""),
      Number(fields.currentPeriodEnd) || existing?.current_period_end || 0,
      existing?.created_at || now,
      now
    );
  return getSubscription(userId);
}

// Find which user owns a subscription, by Stripe subscription id first then
// customer id (used to attribute webhook events that only carry those ids).
export function resolveSubscriptionOwner(subscriptionId, customerId) {
  let row = subscriptionId
    ? open().prepare("SELECT user_id FROM subscriptions WHERE subscription_id = ?").get(subscriptionId)
    : null;
  if (!row && customerId) {
    row = open().prepare("SELECT user_id FROM subscriptions WHERE customer_id = ?").get(customerId);
  }
  return row ? row.user_id : null;
}

export function getSubscription(userId) {
  return (
    open().prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId) ?? {
      user_id: userId,
      customer_id: "",
      subscription_id: "",
      status: "",
      price_id: "",
      email: "",
      current_period_end: 0,
      created_at: "",
      updated_at: "",
    }
  );
}

// ----------------------------------------------------------------------------
// run usage — free-plan daily run counter (Pro accounts are exempt). One row
// per user per UTC day; the day flips at midnight UTC.
// ----------------------------------------------------------------------------
export function usageDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function getRunUsage(userId, day = usageDayKey()) {
  const row = open()
    .prepare("SELECT count FROM usage_runs WHERE user_id = ? AND day = ?")
    .get(String(userId), day);
  return row ? Number(row.count) : 0;
}

export function bumpRunUsage(userId, day = usageDayKey()) {
  open()
    .prepare(
      "INSERT INTO usage_runs (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = usage_runs.count + 1"
    )
    .run(String(userId), day);
  return getRunUsage(userId, day);
}

export function clearRunUsage(userId) {
  open().prepare("DELETE FROM usage_runs WHERE user_id = ?").run(String(userId));
}

// ----------------------------------------------------------------------------
// user activity — heartbeats for the admin Analytics chart. recordActivity is
// throttled to one row per user per minute so the table stays small over time.
// onlineStats returns how many distinct users were seen in each window, and
// activitySeries buckets activity into bars so the admin chart can plot ranges.
// ----------------------------------------------------------------------------
export async function recordActivity(userId) {
  if (!userId) return;
  const now = Date.now();
  const last = open().prepare("SELECT ts FROM user_activity WHERE user_id = ? ORDER BY ts DESC LIMIT 1").get(userId);
  if (last && now - last.ts < 60_000) return; // throttle to ~1/min per user
  open().prepare("INSERT INTO user_activity (user_id, ts) VALUES (?, ?)").run(userId, now);
}

function distinctUsersSince(since) {
  const row = open()
    .prepare(since == null
      ? "SELECT COUNT(DISTINCT user_id) AS c FROM user_activity"
      : "SELECT COUNT(DISTINCT user_id) AS c FROM user_activity WHERE ts >= ?")
    .get(...(since == null ? [] : [since]));
  return Number(row.c);
}

// Distinct active users per window, millis since the epoch.
export function onlineStats() {
  const now = Date.now();
  return {
    now: distinctUsersSince(now - 5 * 60_000),      // active in the last 5 minutes
    hour: distinctUsersSince(now - 60 * 60_000),
    day: distinctUsersSince(now - 24 * 60 * 60_000),
    week: distinctUsersSince(now - 7 * 24 * 60 * 60_000),
    month: distinctUsersSince(now - 30 * 24 * 60 * 60_000),
    year: distinctUsersSince(now - 365 * 24 * 60 * 60_000),
    all: distinctUsersSince(null),
  };
}

// Build a bucketed bar-chart series of distinct active users for a range.
// Returns { buckets: [{label, count}], total } where total is the distinct users
// seen anywhere in the range.
const MONTH_MS = 30 * 24 * 60 * 60_000;
export function activitySeries(range = "day", bucketCount = 12) {
  const now = Date.now();
  const spans = {
    hour: 60 * 60_000,
    day: 24 * 60 * 60_000,
    week: 7 * 24 * 60 * 60_000,
    month: 30 * 24 * 60 * 60_000,
    year: 365 * 24 * 60 * 60_000,
    all: now,
  };
  const span = spans[range] ?? spans.day;
  const start = range === "all" ? 0 : now - span;
  const rows = open()
    .prepare("SELECT user_id, ts FROM user_activity WHERE ts >= ? ORDER BY ts")
    .all(start);

  // distinct users seen per bucket (a user counts once even if active repeatedly)
  const perBucket = new Map();
  const seen = new Map();
  for (const r of rows) {
    let idx;
    if (range === "all") {
      const d = new Date(r.ts);
      idx = (d.getUTCFullYear() - 1970) * 12 + (d.getUTCMonth() - 0) + 1;
    } else {
      idx = Math.floor((r.ts - start) / (span / bucketCount));
      if (idx < 0) idx = 0;
      if (idx >= bucketCount) idx = bucketCount - 1;
    }
    if (!seen.has(r.user_id)) seen.set(r.user_id, new Set());
    seen.get(r.user_id).add(idx);
  }
  for (const [, set] of seen) for (const i of set) perBucket.set(i, (perBucket.get(i) || 0) + 1);

  // build labels
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ label: labelFor(range, i, bucketCount, start, span), count: perBucket.get(i) || 0 });
  }
  if (range !== "all") {
    // ensure total matches distinct users over the whole range (bucket overlap across
    // boundaries is avoided since idx maps each ts to exactly one bucket)
  }
  return { buckets, total: seen.size, range, bucketCount };
}

function labelFor(range, idx, bucketCount, start, span) {
  const t = start + Math.floor(span / bucketCount) * (idx + 0.5);
  const d = new Date(t);
  if (range === "hour") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "day") return d.toLocaleTimeString([], { hour: "2-digit" });
  if (range === "week") return d.toLocaleDateString([], { weekday: "short" });
  if (range === "month") return d.toLocaleDateString([], { day: "numeric", month: "short" });
  if (range === "year") return d.toLocaleDateString([], { month: "short" });
  return d.toLocaleDateString([], { month: "short", year: "2-digit" });
}

// Prune activity older than a year (holds the table down on busy instances).
export function pruneActivity() {
  open().prepare("DELETE FROM user_activity WHERE ts < ?").run(Date.now() - 366 * 24 * 60 * 60_000);
}

// ----------------------------------------------------------------------------
// database overview + SQL console (admin panel)
// ----------------------------------------------------------------------------
export function listTables() {
  return open()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

export function tableCounts() {
  const counts = {};
  for (const t of listTables()) {
    try {
      counts[t] = open().prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    } catch {
      counts[t] = 0;
    }
  }
  return counts;
}

// Run an arbitrary SQL statement from the SQL Query node / admin console.
// SELECT-ish statements return rows; everything else returns the change count.
// Params are bound as named parameters (:name / @name / $name).
export function runSql(sql, params = {}) {
  const d = open();
  const stmt = d.prepare(String(sql));
  const bound = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const isSelect = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(String(sql));
  if (isSelect) {
    const rows = stmt.all(bound);
    return { rows, columns: rows.length ? Object.keys(rows[0]) : [], rowCount: rows.length, changes: 0 };
  }
  const info = stmt.run(bound);
  return { rows: [], columns: [], rowCount: 0, changes: Number(info.changes || 0), lastInsertRowid: info.lastInsertRowid ?? null };
}

// ----------------------------------------------------------------------------
// per-user credential vault — credentials an account stores for its workflows.
// The field payload is encrypted at rest with AES-256-GCM; reads are scoped to
// the owning user id so one account can never see another's secrets.
// ----------------------------------------------------------------------------
function credentialRow(row) {
  if (!row) return null;
  let fields = {};
  try {
    const text = decryptText(row.data) ?? row.data;
    fields = text ? JSON.parse(text) : {};
  } catch {
    fields = {};
  }
  return {
    id: row.id,
    name: row.name || "",
    type: row.type || "",
    fields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeFields(fields) {
  return encryptText(JSON.stringify(fields && typeof fields === "object" ? fields : {}));
}

export function credentialsList(userId) {
  return open()
    .prepare("SELECT * FROM user_credentials WHERE user_id = ? ORDER BY name COLLATE NOCASE, created_at")
    .all(String(userId))
    .map(credentialRow);
}

export function credentialGet(id, userId) {
  return credentialRow(
    open().prepare("SELECT * FROM user_credentials WHERE id = ? AND user_id = ?").get(String(id), String(userId))
  );
}

export function credentialCreate({ id, userId, name, type, fields }) {
  const credId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  open()
    .prepare(
      "INSERT INTO user_credentials (id, user_id, name, type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(credId, String(userId), String(name || ""), String(type || ""), encodeFields(fields), now, now);
  return credentialGet(credId, userId);
}

export function credentialUpdate(id, userId, { name, type, fields } = {}) {
  const d = open();
  const existing = d.prepare("SELECT * FROM user_credentials WHERE id = ? AND user_id = ?").get(String(id), String(userId));
  if (!existing) return null;
  d.prepare("UPDATE user_credentials SET name = ?, type = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
    name === undefined ? existing.name : String(name),
    type === undefined ? existing.type : String(type),
    fields === undefined ? existing.data : encodeFields(fields),
    new Date().toISOString(),
    String(id),
    String(userId)
  );
  return credentialGet(id, userId);
}

export function credentialRemove(id, userId) {
  const info = open().prepare("DELETE FROM user_credentials WHERE id = ? AND user_id = ?").run(String(id), String(userId));
  return Number(info.changes || 0) > 0;
}

// ----------------------------------------------------------------------------
// per-user variables — named values referenced from workflows.
// ----------------------------------------------------------------------------
function variableRow(row) {
  if (!row) return null;
  const secret = !!row.secret;
  let value = row.value || "";
  let testValue = row.test_value || "";
  if (secret) value = decryptText(row.value) ?? row.value;
  if (secret && testValue) testValue = decryptText(testValue) ?? testValue;
  return {
    id: row.id,
    name: row.name || "",
    value,
    testValue,
    secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function variablesList(userId) {
  return open()
    .prepare("SELECT * FROM variables WHERE user_id = ? ORDER BY name COLLATE NOCASE, created_at")
    .all(String(userId))
    .map(variableRow);
}

export function variableGet(id, userId) {
  return variableRow(open().prepare("SELECT * FROM variables WHERE id = ? AND user_id = ?").get(String(id), String(userId)));
}

const sealVariable = (text, isSecret) => (isSecret && text ? encryptText(text) : text);

export function variableCreate({ id, userId, name, value, testValue, secret }) {
  const varId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  const isSecret = !!secret;
  open()
    .prepare("INSERT INTO variables (id, user_id, name, value, test_value, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      varId,
      String(userId),
      String(name || ""),
      isSecret ? encryptText(String(value ?? "")) : String(value ?? ""),
      sealVariable(String(testValue ?? ""), isSecret),
      isSecret ? 1 : 0,
      now,
      now
    );
  return variableGet(varId, userId);
}

export function variableUpdate(id, userId, { name, value, testValue, secret } = {}) {
  const d = open();
  const existing = d.prepare("SELECT * FROM variables WHERE id = ? AND user_id = ?").get(String(id), String(userId));
  if (!existing) return null;
  const isSecret = secret === undefined ? !!existing.secret : !!secret;
  const rawValue = value === undefined ? (existing.secret ? decryptText(existing.value) ?? "" : existing.value) : String(value ?? "");
  const oldTest = existing.test_value || "";
  const rawTest = testValue === undefined ? (existing.secret && oldTest ? decryptText(oldTest) ?? "" : oldTest) : String(testValue ?? "");
  d.prepare("UPDATE variables SET name = ?, value = ?, test_value = ?, secret = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
    name === undefined ? existing.name : String(name),
    isSecret ? encryptText(rawValue) : rawValue,
    sealVariable(rawTest, isSecret),
    isSecret ? 1 : 0,
    new Date().toISOString(),
    String(id),
    String(userId)
  );
  return variableGet(id, userId);
}

export function variableRemove(id, userId) {
  const info = open().prepare("DELETE FROM variables WHERE id = ? AND user_id = ?").run(String(id), String(userId));
  return Number(info.changes || 0) > 0;
}

// ----------------------------------------------------------------------------
// per-user data tables (spreadsheet-style rows stored in SQL).
// ----------------------------------------------------------------------------
function dataTableRow(row) {
  if (!row) return null;
  let columns = [];
  try {
    const v = JSON.parse(row.columns || "[]");
    if (Array.isArray(v)) columns = v.map((c) => String(c));
  } catch {
    columns = [];
  }
  return { id: row.id, name: row.name || "", columns, createdAt: row.created_at, updatedAt: row.updated_at };
}

function dataRow(row) {
  let data = {};
  try {
    data = JSON.parse(row.data || "{}");
  } catch {
    data = {};
  }
  return { id: row.id, tableId: row.table_id, data, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function dataTablesList(userId) {
  return open()
    .prepare("SELECT * FROM data_tables WHERE user_id = ? ORDER BY name COLLATE NOCASE, created_at")
    .all(String(userId))
    .map(dataTableRow);
}

export function dataTableGet(id, userId) {
  return dataTableRow(open().prepare("SELECT * FROM data_tables WHERE id = ? AND user_id = ?").get(String(id), String(userId)));
}

export function dataTableCreate({ id, userId, name, columns }) {
  const tableId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  const cols = Array.isArray(columns) ? columns.map((c) => String(c)) : [];
  open()
    .prepare("INSERT INTO data_tables (id, user_id, name, columns, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(tableId, String(userId), String(name || ""), JSON.stringify(cols), now, now);
  return dataTableGet(tableId, userId);
}

export function dataTableUpdate(id, userId, { name, columns } = {}) {
  const d = open();
  const existing = d.prepare("SELECT * FROM data_tables WHERE id = ? AND user_id = ?").get(String(id), String(userId));
  if (!existing) return null;
  const cols = Array.isArray(columns) ? columns.map((c) => String(c)) : null;
  d.prepare("UPDATE data_tables SET name = ?, columns = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
    name === undefined ? existing.name : String(name),
    cols ? JSON.stringify(cols) : existing.columns,
    new Date().toISOString(),
    String(id),
    String(userId)
  );
  return dataTableGet(id, userId);
}

export function dataTableRemove(id, userId) {
  const d = open();
  const existing = d.prepare("SELECT id FROM data_tables WHERE id = ? AND user_id = ?").get(String(id), String(userId));
  if (!existing) return false;
  d.prepare("DELETE FROM data_table_rows WHERE table_id = ?").run(String(id));
  d.prepare("DELETE FROM data_tables WHERE id = ? AND user_id = ?").run(String(id), String(userId));
  return true;
}

export function dataTableRowsList(tableId, userId) {
  return open()
    .prepare("SELECT * FROM data_table_rows WHERE table_id = ? AND user_id = ? ORDER BY created_at")
    .all(String(tableId), String(userId))
    .map(dataRow);
}

export function dataTableRowCreate({ id, tableId, userId, data }) {
  const rowId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  open()
    .prepare("INSERT INTO data_table_rows (id, table_id, user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(rowId, String(tableId), String(userId), JSON.stringify(data && typeof data === "object" ? data : {}), now, now);
  return dataRow(open().prepare("SELECT * FROM data_table_rows WHERE id = ?").get(rowId));
}

// Bulk insert (CSV import): one prepared statement for the whole batch so a
// 5000-row file is a single round of writes instead of 5000 HTTP requests.
// Timestamps advance by a millisecond per row so `ORDER BY created_at` keeps
// the order the rows came in with.
export function dataTableRowCreateMany({ tableId, userId, rows }) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const d = open();
  const stmt = d.prepare("INSERT INTO data_table_rows (id, table_id, user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  const base = Date.now();
  rows.forEach((data, i) => {
    const now = new Date(base + i).toISOString();
    stmt.run(String(crypto.randomUUID()), String(tableId), String(userId), JSON.stringify(data && typeof data === "object" ? data : {}), now, now);
  });
  return rows.length;
}

export function dataTableRowUpdate(id, userId, data) {
  const d = open();
  const existing = d.prepare("SELECT * FROM data_table_rows WHERE id = ? AND user_id = ?").get(String(id), String(userId));
  if (!existing) return null;
  d.prepare("UPDATE data_table_rows SET data = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
    JSON.stringify(data && typeof data === "object" ? data : {}),
    new Date().toISOString(),
    String(id),
    String(userId)
  );
  return dataRow(d.prepare("SELECT * FROM data_table_rows WHERE id = ?").get(String(id)));
}

export function dataTableRowRemove(id, userId) {
  const info = open().prepare("DELETE FROM data_table_rows WHERE id = ? AND user_id = ?").run(String(id), String(userId));
  return Number(info.changes || 0) > 0;
}

// ----------------------------------------------------------------------------
// execution history across ALL of a user's workflows (global Executions page).
// ----------------------------------------------------------------------------
export function executionsListByOwner(ownerId, limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return open()
    .prepare(
      "SELECT id, workflow_id, source, started_at, finished_at, duration_ms, success, aborted, node_count, error_count, prompt_tokens, completion_tokens, ai_cost_usd FROM executions WHERE owner_id = ? ORDER BY started_at DESC LIMIT ?"
    )
    .all(String(ownerId), n)
    .map(executionRowToSummary);
}

// ----------------------------------------------------------------------------
// AI usage — the budget guard (server/ai-budget.js) sums what finished runs
// used since the start of the day / month; the usage dashboard reads the runs
// that called a model, with their logs (per-node usage and models).
// ----------------------------------------------------------------------------
export function executionsAiUsageSince(ownerId, sinceIso, workflowId = "") {
  const wf = String(workflowId || "");
  const row = open()
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens, COALESCE(SUM(ai_cost_usd), 0) AS cost, COUNT(*) AS runs FROM executions WHERE owner_id = ? AND started_at >= ?${wf ? " AND workflow_id = ?" : ""}`
    )
    .get(...[String(ownerId), String(sinceIso), ...(wf ? [wf] : [])]);
  return { tokens: Number(row?.tokens || 0), costUsd: Number(row?.cost || 0), runs: Number(row?.runs || 0) };
}

export function executionsAiRuns(ownerId, sinceIso, limit = 2000) {
  const n = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
  return open()
    .prepare(
      "SELECT id, workflow_id, started_at, prompt_tokens, completion_tokens, ai_cost_usd, data FROM executions WHERE owner_id = ? AND started_at >= ? AND (prompt_tokens + completion_tokens) > 0 ORDER BY started_at DESC LIMIT ?"
    )
    .all(String(ownerId), String(sinceIso), n)
    .map(aiRunRow);
}

function aiRunRow(r) {
  let log = [];
  try {
    log = JSON.parse(r.data || "{}").log || [];
  } catch {
    log = [];
  }
  return {
    id: r.id,
    workflowId: r.workflow_id,
    startedAt: r.started_at,
    promptTokens: Number(r.prompt_tokens || 0),
    completionTokens: Number(r.completion_tokens || 0),
    aiCostUsd: Number(r.ai_cost_usd || 0),
    // only what the dashboard needs from each node that called a model
    calls: log.filter((l) => l && l.usage).map((l) => ({ nodeId: l.nodeId, nodeName: l.nodeName, nodeType: l.nodeType, usage: l.usage })),
  };
}

// ----------------------------------------------------------------------------
// events journal — batched writes from server/journal.js. journalInsert is the
// raw sink and is intentionally NOT routed through the journaling db facade.
// ----------------------------------------------------------------------------
export function journalInsert(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const d = open();
  const stmt = d.prepare(
    "INSERT INTO db_events (ts, source, actor, op, target, detail, duration_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  let count = 0;
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      stmt.run(
        Number(r.ts || Date.now()),
        String(r.source || "server"),
        String(r.actor || ""),
        String(r.op || ""),
        String(r.target || ""),
        String(r.detail || "").slice(0, 400),
        Number(r.durationMs || 0),
        r.ok === false ? 0 : 1
      );
      count++;
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
  return count;
}

export function journalList({ limit = 100, source = "", op = "", since = 0 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const where = [];
  const params = [];
  if (source) {
    where.push("source = ?");
    params.push(String(source));
  }
  if (op) {
    where.push("op = ?");
    params.push(String(op));
  }
  if (since) {
    where.push("ts >= ?");
    params.push(Number(since));
  }
  const sql =
    "SELECT id, ts, source, actor, op, target, detail, duration_ms, ok FROM db_events" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY ts DESC LIMIT ?";
  return open()
    .prepare(sql)
    .all(...params, n)
    .map((r) => ({
      id: r.id,
      ts: Number(r.ts || 0),
      source: r.source,
      actor: r.actor,
      op: r.op,
      target: r.target,
      detail: r.detail,
      durationMs: Number(r.duration_ms || 0),
      ok: !!r.ok,
    }));
}

export function journalPrune(keepMs) {
  const cutoff = Date.now() - Number(keepMs || 7 * 24 * 60 * 60_000);
  const info = open().prepare("DELETE FROM db_events WHERE ts < ?").run(cutoff);
  return Number(info.changes || 0);
}

export function journalCount() {
  return Number(open().prepare("SELECT COUNT(*) AS c FROM db_events").get().c || 0);
}

// ----------------------------------------------------------------------------
// operational alerts (admin panel). Unresolved alerts dedupe by source+title.
// ----------------------------------------------------------------------------
function alertRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    level: row.level || "warning",
    source: row.source || "",
    title: row.title || "",
    message: row.message || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolved: !!row.resolved,
    occurrences: Number(row.occurrences || 1),
    emailSent: !!row.email_sent,
  };
}

// Raise (or bump) an alert. Returns { alert, created } — created is false when
// the same source+title was already open, so the caller can skip duplicate mail.
export function alertUpsert({ id, level, source, title, message }) {
  const d = open();
  const existing = d
    .prepare("SELECT * FROM alerts WHERE resolved = 0 AND source = ? AND title = ? LIMIT 1")
    .get(String(source || ""), String(title || ""));
  const now = new Date().toISOString();
  if (existing) {
    d.prepare("UPDATE alerts SET message = ?, level = ?, occurrences = occurrences + 1, updated_at = ? WHERE id = ?").run(
      String(message || existing.message || ""),
      String(level || existing.level),
      now,
      existing.id
    );
    return { alert: alertRow(d.prepare("SELECT * FROM alerts WHERE id = ?").get(existing.id)), created: false };
  }
  const alertId = String(id || crypto.randomUUID());
  d.prepare(
    "INSERT INTO alerts (id, level, source, title, message, created_at, updated_at, resolved, occurrences, email_sent) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0)"
  ).run(alertId, String(level || "warning"), String(source || ""), String(title || ""), String(message || ""), now, now);
  return { alert: alertRow(d.prepare("SELECT * FROM alerts WHERE id = ?").get(alertId)), created: true };
}

export function alertMarkEmailed(id) {
  open().prepare("UPDATE alerts SET email_sent = 1 WHERE id = ?").run(String(id));
}

export function alertsList({ includeResolved = false, limit = 100 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const sql =
    "SELECT * FROM alerts" +
    (includeResolved ? "" : " WHERE resolved = 0") +
    " ORDER BY resolved ASC, updated_at DESC LIMIT ?";
  return open().prepare(sql).all(n).map(alertRow);
}

export function alertResolve(id) {
  const info = open().prepare("UPDATE alerts SET resolved = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), String(id));
  return Number(info.changes || 0) > 0;
}

export function alertRemove(id) {
  const info = open().prepare("DELETE FROM alerts WHERE id = ?").run(String(id));
  return Number(info.changes || 0) > 0;
}

export function alertsStats() {
  const row = open()
    .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM alerts")
    .get();
  return { total: Number(row.total || 0), open: Number(row.open || 0) };
}

// Close the underlying SQLite handle. Used by the test harness so the temp
// database file can be removed (Windows locks an open SQLite file).
export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    // ignore — already closed
  }
  db = null;
}

// ----------------------------------------------------------------------------
// backup — write a consistent snapshot of the whole database to `destFile`
// using SQLite's VACUUM INTO (safe while the database is in use). The caller
// (server/backup.js) is responsible for the destination path and retention.
// ----------------------------------------------------------------------------
export function backupTo(destFile) {
  const file = String(destFile || "");
  if (!file) throw new Error("backupTo requires a destination file.");
  try {
    fs.unlinkSync(file);
  } catch {
    /* no previous snapshot */
  }
  open().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return { format: "sqlite", file };
}

export { encryptText, decryptText };