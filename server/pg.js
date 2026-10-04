// ============================================================================
// W FLOW — PostgreSQL database adapter (optional)
//
// Enabled by setting DATABASE_URL (e.g. postgres://user:pass@host:5432/dbname).
// When unset the app falls back to the built-in SQLite backend (server/db.js).
// This module mirrors the db.js interface but returns Promises, so callers use
// `await` — which works for both backends (await on a synchronous SQLite call
// is a no-op). Everything is parameterised; the schema matches db.js exactly.
//
// Table names mirror the SQLite schema so a site can migrate between backends:
//   users, user_sessions, settings, sessions, admin_user
// ============================================================================
import pg from "pg";
import fs from "node:fs";
import crypto from "node:crypto";
import { encryptText, decryptText, newSessionToken, digestToken } from "./security.js";

const encrypt = (v) => encryptText(String(v));
const decrypt = (v) => decryptText(String(v));

const { Pool } = pg;

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  // pg emits an 'error' on idle clients — without a listener it would crash the
  // process on a dropped connection.
  pool.on("error", (err) => {
    console.error("  [db:postgres] pool error:", err.message);
  });
  return pool;
}

async function q(sql, params = []) {
  return getPool().query(sql, params);
}

// ----------------------------------------------------------------------------
// schema — created on first use (idempotent)
// ----------------------------------------------------------------------------
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS admin_user (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    encrypted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login TEXT,
    workflow_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    role TEXT NOT NULL DEFAULT 'user',
    deactivation_reason TEXT NOT NULL DEFAULT '',
    deactivated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- Credentials entered on workflow nodes (AI Agent "configure a model here",
  -- HTTP auth, Slack tokens, …). Mirrors the SQLite schema; encrypted at rest,
  -- kept out of the workflow JSON so exports / community posts never carry them.
  CREATE TABLE IF NOT EXISTS workflow_secrets (
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workflow_id, node_id, field)
  );
  -- Saved AI agent credentials (model API key), encrypted at rest.
  CREATE TABLE IF NOT EXISTS agent_secrets (
    agent_id TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, field)
  );
  -- Paid subscriptions (buyable on the main site via Stripe Checkout).
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL DEFAULT '',
    subscription_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    price_id TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    current_period_end BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- Free-plan usage counters (workflow runs the account started). One row per
  -- user per UTC day; Pro subscribers are exempt.
  CREATE TABLE IF NOT EXISTS usage_runs (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  -- Website activity heartbeats for the admin Analytics chart.
  CREATE TABLE IF NOT EXISTS user_activity (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    ts BIGINT NOT NULL            -- epoch milliseconds
  );
  CREATE INDEX IF NOT EXISTS idx_activity_ts ON user_activity (ts);
  -- Full workflow JSON stored in SQL when the admin enables "Save workflows in
  -- the SQL database" on the Cloud servers page. Mirrors the SQLite schema:
  -- entry JSON in data, per-workflow assigned code in code, credentials kept
  -- in the encrypted workflow_secrets table (blanked in the JSON).
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
  -- schedule, Telegram). Mirrors the SQLite schema: summary columns drive the
  -- Execution menu list, data holds the full ExecResult JSON.
  CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'editor',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 0,
    aborted INTEGER NOT NULL DEFAULT 0,
    node_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    ai_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_executions_workflow ON executions (workflow_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_executions_owner ON executions (owner_id);
  -- One-time auth tokens (password reset / e-mail verification), stored hashed.
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, kind);
  -- Password sign-ups waiting for their e-mail confirmation (mirrors SQLite).
  CREATE TABLE IF NOT EXISTS pending_signups (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- Per-user credential vault (mirrors SQLite): the field payload is encrypted
  -- at rest; only the owning account can read it back.
  CREATE TABLE IF NOT EXISTS user_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_credentials_user ON user_credentials (user_id);
  -- Per-user variables referenced from workflows.
  CREATE TABLE IF NOT EXISTS variables (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL DEFAULT '',
    secret INTEGER NOT NULL DEFAULT 0,
    test_value TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_variables_user ON variables (user_id);
  -- Per-user data tables (spreadsheet-style rows stored in SQL).
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
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_datarows_table ON data_table_rows (table_id);
  -- Events journal — one row per database contact (batched).
  CREATE TABLE IF NOT EXISTS db_events (
    id BIGSERIAL PRIMARY KEY,
    ts BIGINT NOT NULL,
    source TEXT NOT NULL DEFAULT 'server',
    actor TEXT NOT NULL DEFAULT '',
    op TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_db_events_ts ON db_events (ts);
  -- Operational alerts shown in the admin panel.
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL DEFAULT 'warning',
    source TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    occurrences INTEGER NOT NULL DEFAULT 1,
    email_sent INTEGER NOT NULL DEFAULT 0
  );
`;

// Tables the schema defines — in the order the app creates them. Let the
// SQLite → PostgreSQL migration script (scripts/migrate-sqlite-to-pg.mjs) walk
// the same list instead of keeping its own copy.
export const SCHEMA_TABLES = [...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

// Statements applied after the tables. They exist because older PostgreSQL
// installations were created before these columns were introduced; on a fresh
// database every one of them is a no-op. Kept as a list so the migration script
// builds the same schema rather than duplicating the DDL.
const SCHEMA_FIXES = [
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TEXT",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0",
  "UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''",
  "UPDATE users SET role = 'user' WHERE role IS NULL OR role = ''",
  // AI token / cost columns on the execution history (added after the table
  // shipped) — runs recorded earlier stay at 0.
  "ALTER TABLE executions ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE executions ADD COLUMN IF NOT EXISTS completion_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE executions ADD COLUMN IF NOT EXISTS ai_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0",
  // a variable's test value (Test / Live environments)
  "ALTER TABLE variables ADD COLUMN IF NOT EXISTS test_value TEXT NOT NULL DEFAULT ''",
];

// Run the whole schema (tables + fixes) through any query runner: the adapter's
// own pool here, a `pg` client in the migration script.
export async function applySchema(runQuery) {
  await runQuery(SCHEMA_SQL);
  for (const sql of SCHEMA_FIXES) await runQuery(sql);
}

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = applySchema(q).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function migrateUserColumns() {
  await ensureSchema();
  await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'");
  await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'");
  await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason TEXT NOT NULL DEFAULT ''");
  await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TEXT");
  await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0");
  await q("UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''");
  await q("UPDATE users SET role = 'user' WHERE role IS NULL OR role = ''");
}

// ----------------------------------------------------------------------------
// encrypted key/value store (page + cloud settings) — same shapes as db.js
// ----------------------------------------------------------------------------
export async function storeGet(key) {
  await ensureSchema();
  const { rows } = await q("SELECT value, encrypted FROM settings WHERE key = $1", [key]);
  if (!rows.length) return null;
  return rows[0].encrypted ? decrypt(rows[0].value) : rows[0].value;
}

export async function storeSet(key, value, { encrypted = false } = {}) {
  await ensureSchema();
  const toStore = encrypted ? encrypt(String(value)) : String(value);
  await q(
    `INSERT INTO settings (key, value, encrypted) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted`,
    [key, toStore, encrypted ? 1 : 0]
  );
}

export async function storeDelete(key) {
  await ensureSchema();
  await q("DELETE FROM settings WHERE key = $1", [key]);
}

export async function allSettingsCount() {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS c FROM settings");
  return Number(rows[0].c);
}

// ----------------------------------------------------------------------------
// admins
// ----------------------------------------------------------------------------
export async function seedAdmin({ username, password }) {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS c FROM admin_user");
  if (Number(rows[0].c) > 0) return false;
  await q("INSERT INTO admin_user (username, password_hash, created_at) VALUES ($1, $2, $3)", [
    username,
    password,
    new Date().toISOString(),
  ]);
  return true;
}

export async function listAdmins() {
  await ensureSchema();
  const { rows } = await q("SELECT id, username, created_at FROM admin_user ORDER BY id");
  return rows.map((r) => ({ id: Number(r.id), username: r.username, created_at: r.created_at }));
}

export async function getUserByUsername(username) {
  await ensureSchema();
  const { rows } = await q("SELECT id, username, password_hash, created_at FROM admin_user WHERE username = $1", [username]);
  if (!rows.length) return null;
  const r = rows[0];
  return { id: Number(r.id), username: r.username, password_hash: r.password_hash, created_at: r.created_at };
}

export async function setAdminPassword(userId, passwordHash) {
  await ensureSchema();
  await q("UPDATE admin_user SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
}

export async function setAdminUsername(userId, username) {
  await ensureSchema();
  await q("UPDATE admin_user SET username = $1 WHERE id = $2", [String(username).trim(), userId]);
}

export async function deleteAdmin(userId) {
  await ensureSchema();
  await q("DELETE FROM admin_user WHERE id = $1", [userId]);
}

// ----------------------------------------------------------------------------
// sessions (admin)
// ----------------------------------------------------------------------------
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h

export async function createSession(userId) {
  await ensureSchema();
  const raw = crypto.randomBytes(32).toString("hex");
  const id = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", [
    id,
    userId,
    expiresAt,
    new Date().toISOString(),
  ]);
  return { raw, id, expiresAt };
}

export async function getUserForSession(token) {
  await ensureSchema();
  const id = crypto.createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const { rows } = await q(
    `SELECT s.user_id, a.username, s.expires_at FROM sessions s JOIN admin_user a ON a.id = s.user_id WHERE s.id = $1`,
    [id]
  );
  if (!rows.length) return null;
  if (Number(rows[0].expires_at) < now) {
    await destroySession(token);
    return null;
  }
  return { userId: Number(rows[0].user_id), username: rows[0].username };
}

export async function destroySession(token) {
  await ensureSchema();
  const id = crypto.createHash("sha256").update(token).digest("hex");
  await q("DELETE FROM sessions WHERE id = $1", [id]);
}

export async function destroyAllSessionsForUser(userId) {
  await ensureSchema();
  await q("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export async function sessionCount() {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS c FROM sessions");
  return Number(rows[0].c);
}

// ----------------------------------------------------------------------------
// website users (main-site login)
// ----------------------------------------------------------------------------
export async function createUser({ email, name, passwordHash }) {
  await ensureSchema();
  const id = crypto.randomUUID();
  await q("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)", [
    id,
    String(email).trim().toLowerCase(),
    String(name || "").trim(),
    passwordHash,
    new Date().toISOString(),
  ]);
  return getUserByEmail(email);
}

export async function getUserByEmail(email) {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, email, name, password_hash, created_at, last_login, workflow_ids, status, role, deactivation_reason, deactivated_at, email_verified FROM users WHERE email = $1",
    [String(email).trim().toLowerCase()]
  );
  return rows.length ? rows[0] : null;
}

export async function getUserById(id) {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, email, name, password_hash, created_at, last_login, workflow_ids, status, role, deactivation_reason, deactivated_at, email_verified FROM users WHERE id = $1",
    [id]
  );
  return rows.length ? rows[0] : null;
}

// --- one-time auth tokens (password reset / e-mail verification) -------------
const AUTH_TOKEN_TTL_MS = { reset: 1000 * 60 * 60, verify: 1000 * 60 * 60 * 48 };

export async function createAuthToken(userId, kind, ttlMs) {
  await ensureSchema();
  const raw = newSessionToken();
  const id = digestToken(raw);
  const ttl = ttlMs || AUTH_TOKEN_TTL_MS[kind] || 1000 * 60 * 60;
  await q("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2", [String(userId), String(kind)]);
  await q("INSERT INTO auth_tokens (id, user_id, kind, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)", [
    id,
    String(userId),
    String(kind),
    Date.now() + ttl,
    new Date().toISOString(),
  ]);
  return raw;
}

export async function consumeAuthToken(raw, kind) {
  await ensureSchema();
  const id = digestToken(String(raw || ""));
  const { rows } = await q("SELECT user_id, expires_at FROM auth_tokens WHERE id = $1 AND kind = $2", [id, String(kind)]);
  if (!rows.length) return null;
  await q("DELETE FROM auth_tokens WHERE id = $1", [id]);
  if (Number(rows[0].expires_at) < Date.now()) return null;
  return rows[0].user_id;
}

// --- pending sign-ups (password registration awaiting e-mail confirmation) ---
const PENDING_SIGNUP_TTL_MS = AUTH_TOKEN_TTL_MS.verify;

export async function createPendingSignup({ email, name, passwordHash }) {
  await ensureSchema();
  const raw = newSessionToken();
  const addr = String(email).trim().toLowerCase();
  await q("DELETE FROM pending_signups WHERE email = $1 OR expires_at < $2", [addr, Date.now()]);
  await q(
    "INSERT INTO pending_signups (id, email, name, password_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [digestToken(raw), addr, String(name || "").trim(), passwordHash, Date.now() + PENDING_SIGNUP_TTL_MS, new Date().toISOString()]
  );
  return raw;
}

export async function getPendingSignup(email) {
  await ensureSchema();
  const { rows } = await q("SELECT email, name, password_hash, expires_at FROM pending_signups WHERE email = $1", [
    String(email).trim().toLowerCase(),
  ]);
  return rows.length && Number(rows[0].expires_at) >= Date.now() ? rows[0] : null;
}

export async function renewPendingSignup(email) {
  const addr = String(email).trim().toLowerCase();
  if (!(await getPendingSignup(addr))) return null;
  const raw = newSessionToken();
  await q("UPDATE pending_signups SET id = $1, expires_at = $2 WHERE email = $3", [
    digestToken(raw),
    Date.now() + PENDING_SIGNUP_TTL_MS,
    addr,
  ]);
  return raw;
}

export async function consumePendingSignup(raw) {
  await ensureSchema();
  const id = digestToken(String(raw || ""));
  const { rows } = await q("SELECT email, name, password_hash, expires_at FROM pending_signups WHERE id = $1", [id]);
  if (!rows.length) return null;
  await q("DELETE FROM pending_signups WHERE id = $1", [id]);
  return Number(rows[0].expires_at) < Date.now() ? null : rows[0];
}

export async function deletePendingSignup(email) {
  await ensureSchema();
  await q("DELETE FROM pending_signups WHERE email = $1", [String(email).trim().toLowerCase()]);
}

export async function setEmailVerified(userId, verified = true) {
  await ensureSchema();
  await q("UPDATE users SET email_verified = $1 WHERE id = $2", [verified ? 1 : 0, String(userId)]);
  return getUserById(userId);
}

export async function deleteAuthTokensForUser(userId) {
  await ensureSchema();
  await q("DELETE FROM auth_tokens WHERE user_id = $1", [String(userId)]);
}

export async function listUsers() {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, email, name, created_at, last_login, workflow_ids, status, role, deactivation_reason, deactivated_at FROM users ORDER BY created_at DESC"
  );
  return rows;
}

export async function countUsers() {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS c FROM users");
  return Number(rows[0].c);
}

// Erase the account and everything stored for it — mirrors db.js deleteUser.
export async function deleteUser(id) {
  await ensureSchema();
  const uid = String(id);
  const { rows } = await q("SELECT workflow_ids FROM users WHERE id = $1", [uid]);
  let wfIds = [];
  try {
    wfIds = JSON.parse(rows[0]?.workflow_ids || "[]").map(String);
  } catch {
    wfIds = [];
  }
  await clearRunUsage(uid);
  if (wfIds.length) {
    await q("DELETE FROM workflow_secrets WHERE workflow_id = ANY($1::text[])", [wfIds]);
    await q("DELETE FROM executions WHERE workflow_id = ANY($1::text[])", [wfIds]);
  }
  await q("DELETE FROM workflow_secrets WHERE user_id = $1", [uid]);
  await q("DELETE FROM executions WHERE owner_id = $1", [uid]);
  await q("DELETE FROM workflows WHERE owner_id = $1", [uid]);
  await q("DELETE FROM user_credentials WHERE user_id = $1", [uid]);
  await q("DELETE FROM variables WHERE user_id = $1", [uid]);
  await q("DELETE FROM data_table_rows WHERE user_id = $1", [uid]);
  await q("DELETE FROM data_tables WHERE user_id = $1", [uid]);
  await q("DELETE FROM user_activity WHERE user_id = $1", [uid]);
  await q("DELETE FROM auth_tokens WHERE user_id = $1", [uid]);
  await q("DELETE FROM user_sessions WHERE user_id = $1", [uid]);
  await q("DELETE FROM users WHERE id = $1", [uid]);
}

export async function updateLastLogin(id) {
  await ensureSchema();
  await q("UPDATE users SET last_login = $1 WHERE id = $2", [new Date().toISOString(), id]);
}

export async function updateUserStatus(id, status, reason = "") {
  await ensureSchema();
  const next = String(status || "").trim().toLowerCase();
  if (!["active", "deactivated"].includes(next)) throw new Error("Invalid user status.");
  const normalizedReason = next === "deactivated" ? String(reason || "").trim().slice(0, 500) : "";
  if (next === "deactivated" && !normalizedReason) throw new Error("A deactivation reason is required.");
  await q("UPDATE users SET status = $1, deactivation_reason = $2, deactivated_at = $3 WHERE id = $4", [next, normalizedReason, next === "deactivated" ? new Date().toISOString() : null, id]);
  return getUserById(id);
}

export async function updateUserRole(id, role) {
  await ensureSchema();
  const next = String(role || "").trim().toLowerCase();
  if (!["user", "pro_user", "admin"].includes(next)) throw new Error("Invalid user role.");
  await q("UPDATE users SET role = $1 WHERE id = $2", [next, id]);
  return getUserById(id);
}

// ----------------------------------------------------------------------------
// workflow assignment registry
// ----------------------------------------------------------------------------
function parseIds(text) {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function setUserWorkflows(userId, ids) {
  await ensureSchema();
  const list = [...new Set((ids || []).map(String))];
  await q("UPDATE users SET workflow_ids = $1 WHERE id = $2", [JSON.stringify(list), userId]);
  return list;
}

export async function getUserWorkflowIds(userId) {
  await ensureSchema();
  const { rows } = await q("SELECT workflow_ids FROM users WHERE id = $1", [userId]);
  return rows.length ? parseIds(rows[0].workflow_ids) : [];
}

export async function addWorkflowToUser(userId, workflowId) {
  const current = await getUserWorkflowIds(userId);
  if (!current.includes(String(workflowId))) current.push(String(workflowId));
  return setUserWorkflows(userId, current);
}

export async function removeWorkflowFromUser(userId, workflowId) {
  const current = await getUserWorkflowIds(userId);
  return setUserWorkflows(userId, current.filter((id) => id !== String(workflowId)));
}

// ----------------------------------------------------------------------------
// workflows table — full workflow JSON stored in SQL (enabled from the admin
// Cloud servers page). Mirrors the file-backed store's shapes and the SQLite
// implementation in db.js: entries are the raw workflow objects with node
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

async function genWorkflowCode() {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    const { rows } = await q("SELECT 1 FROM workflows WHERE code = $1", [code]);
    if (!rows.length) return code;
  }
  return `WF-${Date.now().toString(36).toUpperCase()}`;
}

export async function workflowsCount() {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS c FROM workflows");
  return Number(rows[0].c);
}

export async function workflowsAll() {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows ORDER BY updated_at DESC"
  );
  return rows.map(workflowRowToObj);
}

export async function workflowsGet(id) {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE id = $1",
    [String(id)]
  );
  return rows.length ? workflowRowToObj(rows[0]) : null;
}

export async function workflowsListByOwner(ownerId) {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE owner_id = $1 ORDER BY updated_at DESC",
    [String(ownerId || "")]
  );
  return rows.map(workflowRowToObj);
}

export async function workflowsGetByOwner(id, ownerId) {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE id = $1 AND owner_id = $2",
    [String(id), String(ownerId || "")]
  );
  return rows.length ? workflowRowToObj(rows[0]) : null;
}

// Look a workflow up by its assigned code (the per-workflow code stored in the
// SQL database, used to reach the workflow on the server/cloud).
export async function workflowsGetByCode(code) {
  await ensureSchema();
  const { rows } = await q(
    "SELECT id, owner_id, name, data, code, created_at, updated_at FROM workflows WHERE code = $1",
    [String(code).trim().toUpperCase()]
  );
  return rows.length ? workflowRowToObj(rows[0]) : null;
}

// Insert or replace a workflow row. Assigns the per-workflow code on first
// save; re-saving keeps the same code. Returns the stored object.
export async function workflowsSave(entry) {
  await ensureSchema();
  const now = new Date().toISOString();
  const id = String(entry?.id || crypto.randomUUID());
  const existing = await workflowsGet(id);
  const createdAt = existing?.createdAt || entry?.createdAt || now;
  const code = String(entry?.code || existing?.code || (await genWorkflowCode()));
  const obj = { ...(entry || {}), id, code, createdAt, updatedAt: entry?.updatedAt || now };
  await q(
    `INSERT INTO workflows (id, owner_id, name, data, code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       owner_id = EXCLUDED.owner_id, name = EXCLUDED.name, data = EXCLUDED.data,
       code = EXCLUDED.code, updated_at = EXCLUDED.updated_at`,
    [id, String(obj.ownerId || ""), String(obj.name || ""), JSON.stringify(obj), code, createdAt, obj.updatedAt]
  );
  return obj;
}

export async function workflowsRemove(id) {
  await ensureSchema();
  const { rowCount } = await q("DELETE FROM workflows WHERE id = $1", [String(id)]);
  return (rowCount || 0) > 0;
}

export async function workflowsRemoveByOwner(id, ownerId) {
  await ensureSchema();
  const { rowCount } = await q("DELETE FROM workflows WHERE id = $1 AND owner_id = $2", [
    String(id),
    String(ownerId || ""),
  ]);
  return (rowCount || 0) > 0;
}

// --- executions (see the SQLite db.js for the shape) -----------------------
function executionRowToSummary(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    source: row.source,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: Number(row.duration_ms || 0),
    success: row.success === true || Number(row.success) === 1,
    aborted: row.aborted === true || Number(row.aborted) === 1,
    nodeCount: Number(row.node_count || 0),
    errorCount: Number(row.error_count || 0),
    // AI usage recorded with the run (0 when no model was called).
    promptTokens: Number(row.prompt_tokens || 0),
    completionTokens: Number(row.completion_tokens || 0),
    aiCostUsd: Number(row.ai_cost_usd || 0),
  };
}

export async function executionsSave(entry) {
  await ensureSchema();
  const id = String(entry?.id || crypto.randomUUID());
  const result = entry?.result || {};
  const usage = result.usage || {};
  await q(
    `INSERT INTO executions (id, workflow_id, owner_id, source, started_at, finished_at, duration_ms, success, aborted, node_count, error_count, prompt_tokens, completion_tokens, ai_cost_usd, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET
       finished_at=EXCLUDED.finished_at, duration_ms=EXCLUDED.duration_ms,
       success=EXCLUDED.success, aborted=EXCLUDED.aborted, error_count=EXCLUDED.error_count,
       prompt_tokens=EXCLUDED.prompt_tokens, completion_tokens=EXCLUDED.completion_tokens,
       ai_cost_usd=EXCLUDED.ai_cost_usd, data=EXCLUDED.data`,
    [
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
      JSON.stringify(result),
    ]
  );
  return id;
}

export async function executionsListByWorkflow(workflowId, limit = 30) {
  await ensureSchema();
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const { rows } = await q(
    "SELECT id, workflow_id, source, started_at, finished_at, duration_ms, success, aborted, node_count, error_count, prompt_tokens, completion_tokens, ai_cost_usd FROM executions WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT $2",
    [String(workflowId), n]
  );
  return rows.map(executionRowToSummary);
}

export async function executionGet(id) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM executions WHERE id = $1", [String(id)]);
  if (!rows.length) return null;
  const row = rows[0];
  let result = {};
  try {
    result = JSON.parse(row.data || "{}");
  } catch {
    result = {};
  }
  return { ...executionRowToSummary(row), result };
}

export async function executionsRemoveByWorkflow(workflowId) {
  await ensureSchema();
  await q("DELETE FROM executions WHERE workflow_id = $1", [String(workflowId)]);
}

/** Delete runs that started before `cutoffIso`. Returns how many went. */
export async function executionsPrune(cutoffIso) {
  await ensureSchema();
  const res = await q("DELETE FROM executions WHERE started_at < $1", [String(cutoffIso)]);
  return Number(res.rowCount || 0);
}

// Aggregated run statistics for the Main page (production vs editor runs,
// failures, time and duration totals). Same shape as the SQLite backend.
export async function executionStatsByOwner(ownerId) {
  await ensureSchema();
  const { rows } = await q(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN source <> 'editor' THEN 1 ELSE 0 END) AS prod,
       SUM(CASE WHEN source <> 'editor' AND success = 0 THEN 1 ELSE 0 END) AS failed_prod,
       SUM(CASE WHEN source <> 'editor' THEN duration_ms ELSE 0 END) AS prod_ms,
       SUM(prompt_tokens) AS prompt_tokens,
       SUM(completion_tokens) AS completion_tokens,
       SUM(ai_cost_usd) AS ai_cost,
       AVG(duration_ms) AS avg_ms
     FROM executions WHERE owner_id = $1`,
    [String(ownerId)]
  );
  const row = rows[0] || {};
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

export async function updateUserProfile(userId, { name, email } = {}) {
  await ensureSchema();
  if (name !== undefined) await q("UPDATE users SET name = $1 WHERE id = $2", [String(name).trim(), userId]);
  if (email !== undefined)
    await q("UPDATE users SET email = $1 WHERE id = $2", [String(email).trim().toLowerCase(), userId]);
  return getUserById(userId);
}

export async function updateUserPassword(userId, passwordHash) {
  await ensureSchema();
  await q("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
}

// ----------------------------------------------------------------------------
// user sessions (main site)
// ----------------------------------------------------------------------------
const USER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export async function createUserSession(userId) {
  await ensureSchema();
  const raw = crypto.randomBytes(32).toString("hex");
  const id = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = Date.now() + USER_SESSION_TTL_MS;
  await q("INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", [
    id,
    userId,
    expiresAt,
    new Date().toISOString(),
  ]);
  return { raw, id, expiresAt };
}

export async function getUserForUserSession(token) {
  await ensureSchema();
  const id = crypto.createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const { rows } = await q(
    `SELECT s.user_id, u.email, u.name, u.workflow_ids, u.status, u.role, u.deactivation_reason, s.expires_at
     FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id]
  );
  if (!rows.length) return null;
  if (Number(rows[0].expires_at) < now) {
    await destroyUserSession(token);
    return null;
  }
  if (rows[0].status !== "active") {
    await destroyUserSession(token);
    return null;
  }
  return {
    userId: rows[0].user_id,
    email: rows[0].email,
    name: rows[0].name,
    role: rows[0].role || "user",
    workflowIds: parseIds(rows[0].workflow_ids),
  };
}

export async function destroyUserSession(token) {
  await ensureSchema();
  const id = crypto.createHash("sha256").update(token).digest("hex");
  await q("DELETE FROM user_sessions WHERE id = $1", [id]);
}

export async function destroyAllUserSessions(userId) {
  await ensureSchema();
  await q("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
}

export async function destroyOtherUserSessions(userId, keepSessionId) {
  await ensureSchema();
  await q("DELETE FROM user_sessions WHERE user_id = $1 AND id != $2", [userId, keepSessionId || ""]);
}

export async function userSessionCount() {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS c FROM user_sessions");
  return Number(rows[0].c);
}

// ----------------------------------------------------------------------------
// workflow secrets — credentials entered on workflow nodes, kept OUT of the
// workflow JSON so exports and community posts never carry them. Encrypted at
// rest (AES-256-GCM), looked up by workflow id so webhook runs (which have no
// logged-in user) can resolve them for the workflow's owner.
// ----------------------------------------------------------------------------
export async function replaceWorkflowSecrets(workflowId, userId, secrets) {
  await ensureSchema();
  await q("DELETE FROM workflow_secrets WHERE workflow_id = $1", [workflowId]);
  const now = new Date().toISOString();
  for (const s of secrets || []) {
    await q(
      `INSERT INTO workflow_secrets (workflow_id, node_id, field, value, user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workflowId, String(s.nodeId), String(s.field), encrypt(String(s.value)), String(userId || ""), now]
    );
  }
  return (secrets || []).length;
}

export async function getWorkflowSecrets(workflowId) {
  await ensureSchema();
  const { rows } = await q("SELECT node_id, field, value FROM workflow_secrets WHERE workflow_id = $1", [
    workflowId,
  ]);
  return rows
    .map((r) => ({ nodeId: r.node_id, field: r.field, value: decrypt(r.value) }))
    .filter((s) => s.value !== null);
}

export async function deleteWorkflowSecrets(workflowId) {
  await ensureSchema();
  await q("DELETE FROM workflow_secrets WHERE workflow_id = $1", [workflowId]);
}

// ----------------------------------------------------------------------------
// agent secrets — saved AI agent credentials (model API key), encrypted at
// rest and kept out of agents.json, like workflow_secrets.
// ----------------------------------------------------------------------------
export async function replaceAgentSecrets(agentId, userId, secrets) {
  await ensureSchema();
  await q("DELETE FROM agent_secrets WHERE agent_id = $1", [agentId]);
  const now = new Date().toISOString();
  for (const s of secrets || []) {
    await q(
      `INSERT INTO agent_secrets (agent_id, field, value, user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [agentId, String(s.field), encrypt(String(s.value)), String(userId || ""), now]
    );
  }
  return (secrets || []).length;
}

export async function getAgentSecrets(agentId) {
  await ensureSchema();
  const { rows } = await q("SELECT field, value FROM agent_secrets WHERE agent_id = $1", [agentId]);
  return rows
    .map((r) => ({ field: r.field, value: decrypt(r.value) }))
    .filter((s) => s.value !== null);
}

export async function deleteAgentSecrets(agentId) {
  await ensureSchema();
  await q("DELETE FROM agent_secrets WHERE agent_id = $1", [agentId]);
}

// ----------------------------------------------------------------------------
// subscriptions — mirrors db.js (SQLite) so a site can migrate between backends.
// ----------------------------------------------------------------------------
export async function setSubscription(userId, fields = {}) {
  await ensureSchema();
  const now = new Date().toISOString();
  const existing = await getSubscription(userId);
  const ins = await q(
    `INSERT INTO subscriptions
       (user_id, customer_id, subscription_id, status, price_id, email, current_period_end, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       subscription_id = EXCLUDED.subscription_id,
       status = EXCLUDED.status,
       price_id = EXCLUDED.price_id,
       email = EXCLUDED.email,
       current_period_end = EXCLUDED.current_period_end,
       updated_at = EXCLUDED.updated_at`,
    [
      userId,
      String(fields.customerId ?? existing?.customer_id ?? ""),
      String(fields.subscriptionId ?? existing?.subscription_id ?? ""),
      String(fields.status ?? existing?.status ?? ""),
      String(fields.priceId ?? existing?.price_id ?? ""),
      String(fields.email ?? existing?.email ?? ""),
      Number(fields.currentPeriodEnd) || existing?.current_period_end || 0,
      existing?.created_at || now,
      now,
    ]
  );
  return getSubscription(userId);
}

export async function getSubscription(userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM subscriptions WHERE user_id = $1", [userId]);
  if (!rows.length) {
    return { user_id: userId, customer_id: "", subscription_id: "", status: "", price_id: "", email: "", current_period_end: 0, created_at: "", updated_at: "" };
  }
  return rows[0];
}

// Find which user owns a subscription, by Stripe subscription id first then
// customer id (used to attribute webhook events that only carry those ids).
export async function resolveSubscriptionOwner(subscriptionId, customerId) {
  await ensureSchema();
  let rows = [];
  if (subscriptionId) {
    rows = (await q("SELECT user_id FROM subscriptions WHERE subscription_id = $1", [subscriptionId])).rows;
  }
  if (!rows.length && customerId) {
    rows = (await q("SELECT user_id FROM subscriptions WHERE customer_id = $1", [customerId])).rows;
  }
  return rows.length ? rows[0].user_id : null;
}

// ----------------------------------------------------------------------------
// run usage — free-plan daily run counter (Pro accounts are exempt). Mirrors
// db.js (SQLite).
// ----------------------------------------------------------------------------
export function usageDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export async function getRunUsage(userId, day = usageDayKey()) {
  await ensureSchema();
  const { rows } = await q("SELECT count FROM usage_runs WHERE user_id = $1 AND day = $2", [String(userId), day]);
  return rows.length ? Number(rows[0].count) : 0;
}

export async function bumpRunUsage(userId, day = usageDayKey()) {
  await ensureSchema();
  await q(
    `INSERT INTO usage_runs (user_id, day, count) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = usage_runs.count + 1`,
    [String(userId), day]
  );
  return getRunUsage(userId, day);
}

export async function clearRunUsage(userId) {
  await ensureSchema();
  await q("DELETE FROM usage_runs WHERE user_id = $1", [String(userId)]);
}

// ----------------------------------------------------------------------------
// user activity — mirrors db.js for the admin Analytics chart.
// ----------------------------------------------------------------------------
export async function recordActivity(userId) {
  if (!userId) return;
  await ensureSchema();
  const now = Date.now();
  const last = await q("SELECT ts FROM user_activity WHERE user_id = $1 ORDER BY ts DESC LIMIT 1", [userId]);
  if (last.rows.length && now - Number(last.rows[0].ts) < 60_000) return; // throttle
  await q("INSERT INTO user_activity (user_id, ts) VALUES ($1, $2)", [userId, now]);
}

export async function onlineStats() {
  await ensureSchema();
  const now = Date.now();
  const stat = async (ms) => {
    const { rows } = ms === null
      ? await q("SELECT COUNT(DISTINCT user_id) AS c FROM user_activity")
      : await q("SELECT COUNT(DISTINCT user_id) AS c FROM user_activity WHERE ts >= $1", [now - ms]);
    return Number(rows[0].c);
  };
  return {
    now: await stat(5 * 60_000),
    hour: await stat(60 * 60_000),
    day: await stat(24 * 60 * 60_000),
    week: await stat(7 * 24 * 60 * 60_000),
    month: await stat(30 * 24 * 60 * 60_000),
    year: await stat(365 * 24 * 60 * 60_000),
    all: await stat(null),
  };
}

const MONTH_MS = 30 * 24 * 60 * 60_000;
export async function activitySeries(range = "day", bucketCount = 12) {
  await ensureSchema();
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
  const { rows } = await q("SELECT user_id, ts FROM user_activity WHERE ts >= $1 ORDER BY ts", [start]);
  const perBucket = new Map();
  const seen = new Map();
  for (const r of rows) {
    const ts = Number(r.ts);
    let idx;
    if (range === "all") {
      const d = new Date(ts);
      idx = (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth() + 1;
    } else {
      idx = Math.floor((ts - start) / (span / bucketCount));
      if (idx < 0) idx = 0;
      if (idx >= bucketCount) idx = bucketCount - 1;
    }
    if (!seen.has(r.user_id)) seen.set(r.user_id, new Set());
    seen.get(r.user_id).add(idx);
  }
  for (const [, set] of seen) for (const i of set) perBucket.set(i, (perBucket.get(i) || 0) + 1);
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ label: labelFor(range, i, bucketCount, start, span), count: perBucket.get(i) || 0 });
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

export async function pruneActivity() {
  await ensureSchema();
  await q("DELETE FROM user_activity WHERE ts < $1", [Date.now() - 366 * 24 * 60 * 60_000]);
}

// ----------------------------------------------------------------------------
// database overview (admin panel) + SQL console
// ----------------------------------------------------------------------------
export async function listTables() {
  await ensureSchema();
  const { rows } = await q(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  return rows.map((r) => r.name);
}

export async function tableCounts() {
  const counts = {};
  for (const t of await listTables()) {
    try {
      const { rows } = await q(`SELECT COUNT(*) AS c FROM "${t}"`);
      counts[t] = Number(rows[0].c);
    } catch {
      counts[t] = 0;
    }
  }
  return counts;
}

// Run an arbitrary SQL statement from the SQL Query node / admin console.
// Named parameters use :name or @name (pg's $n placeholders are reserved).
export async function runSql(sql, params = {}) {
  await ensureSchema();
  const bound = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const names = [];
  const keys = Object.keys(bound);
  const mapped = String(sql).replace(/[:@]([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
    if (!(name in bound)) return m;
    if (!names.includes(name)) names.push(name);
    return `$${names.indexOf(name) + 1}`;
  });
  const values = names.map((n) => bound[n]);
  const isSelect = /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(mapped);
  const res = await q(mapped, values);
  if (isSelect) {
    return {
      rows: res.rows,
      columns: res.fields.map((f) => f.name),
      rowCount: res.rowCount ?? res.rows.length,
      changes: 0,
    };
  }
  return { rows: [], columns: [], rowCount: 0, changes: Number(res.rowCount || 0), lastInsertRowid: null };
}

// closeDb is a no-op for Postgres (pool closes when the process exits) but kept
// for interface parity with db.js (the test harness calls it).
export function closeDb() {}

// ----------------------------------------------------------------------------
// backup — logical snapshot of every table as JSON. For byte-exact PostgreSQL
// backups use pg_dump / Patroni's pg_basebackup (see the admin panel guide);
// this portable fallback works anywhere the app runs and needs no extra binary.
// ----------------------------------------------------------------------------
export async function backupTo(destFile) {
  await ensureSchema();
  const dump = { engine: "postgres", createdAt: new Date().toISOString(), tables: {} };
  for (const t of await listTables()) {
    const { rows } = await q(`SELECT * FROM "${t}"`);
    dump.tables[t] = rows;
  }
  fs.writeFileSync(String(destFile), JSON.stringify(dump, null, 2));
  return { format: "json", file: String(destFile) };
}

// ----------------------------------------------------------------------------
// per-user credential vault (mirrors db.js)
// ----------------------------------------------------------------------------
function credentialRow(row) {
  if (!row) return null;
  let fields = {};
  try {
    const text = decrypt(row.data) ?? row.data;
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

const encodeFields = (fields) => encrypt(JSON.stringify(fields && typeof fields === "object" ? fields : {}));

export async function credentialsList(userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM user_credentials WHERE user_id = $1 ORDER BY lower(name), created_at", [String(userId)]);
  return rows.map(credentialRow);
}

export async function credentialGet(id, userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM user_credentials WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  return credentialRow(rows[0]);
}

export async function credentialCreate({ id, userId, name, type, fields }) {
  await ensureSchema();
  const credId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  await q(
    "INSERT INTO user_credentials (id, user_id, name, type, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [credId, String(userId), String(name || ""), String(type || ""), encodeFields(fields), now, now]
  );
  return credentialGet(credId, userId);
}

export async function credentialUpdate(id, userId, { name, type, fields } = {}) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM user_credentials WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  if (!rows.length) return null;
  const existing = rows[0];
  await q("UPDATE user_credentials SET name = $1, type = $2, data = $3, updated_at = $4 WHERE id = $5 AND user_id = $6", [
    name === undefined ? existing.name : String(name),
    type === undefined ? existing.type : String(type),
    fields === undefined ? existing.data : encodeFields(fields),
    new Date().toISOString(),
    String(id),
    String(userId),
  ]);
  return credentialGet(id, userId);
}

export async function credentialRemove(id, userId) {
  await ensureSchema();
  const res = await q("DELETE FROM user_credentials WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  return Number(res.rowCount || 0) > 0;
}

// ----------------------------------------------------------------------------
// per-user variables (mirrors db.js)
// ----------------------------------------------------------------------------
function variableRow(row) {
  if (!row) return null;
  const secret = !!row.secret;
  let value = row.value || "";
  let testValue = row.test_value || "";
  if (secret) value = decrypt(row.value) ?? row.value;
  if (secret && testValue) testValue = decrypt(testValue) ?? testValue;
  return { id: row.id, name: row.name || "", value, testValue, secret, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function variablesList(userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM variables WHERE user_id = $1 ORDER BY lower(name), created_at", [String(userId)]);
  return rows.map(variableRow);
}

export async function variableGet(id, userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM variables WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  return variableRow(rows[0]);
}

const sealVariable = (text, isSecret) => (isSecret && text ? encrypt(text) : text);

export async function variableCreate({ id, userId, name, value, testValue, secret }) {
  await ensureSchema();
  const varId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  const isSecret = !!secret;
  await q("INSERT INTO variables (id, user_id, name, value, test_value, secret, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    varId,
    String(userId),
    String(name || ""),
    isSecret ? encrypt(String(value ?? "")) : String(value ?? ""),
    sealVariable(String(testValue ?? ""), isSecret),
    isSecret ? 1 : 0,
    now,
    now,
  ]);
  return variableGet(varId, userId);
}

export async function variableUpdate(id, userId, { name, value, testValue, secret } = {}) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM variables WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  if (!rows.length) return null;
  const existing = rows[0];
  const isSecret = secret === undefined ? !!existing.secret : !!secret;
  const rawValue = value === undefined ? (existing.secret ? decrypt(existing.value) ?? "" : existing.value) : String(value ?? "");
  const oldTest = existing.test_value || "";
  const rawTest = testValue === undefined ? (existing.secret && oldTest ? decrypt(oldTest) ?? "" : oldTest) : String(testValue ?? "");
  await q("UPDATE variables SET name = $1, value = $2, test_value = $3, secret = $4, updated_at = $5 WHERE id = $6 AND user_id = $7", [
    name === undefined ? existing.name : String(name),
    isSecret ? encrypt(rawValue) : rawValue,
    sealVariable(rawTest, isSecret),
    isSecret ? 1 : 0,
    new Date().toISOString(),
    String(id),
    String(userId),
  ]);
  return variableGet(id, userId);
}

export async function variableRemove(id, userId) {
  await ensureSchema();
  const res = await q("DELETE FROM variables WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  return Number(res.rowCount || 0) > 0;
}

// ----------------------------------------------------------------------------
// per-user data tables (mirrors db.js)
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

export async function dataTablesList(userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM data_tables WHERE user_id = $1 ORDER BY lower(name), created_at", [String(userId)]);
  return rows.map(dataTableRow);
}

export async function dataTableGet(id, userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM data_tables WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  return dataTableRow(rows[0]);
}

export async function dataTableCreate({ id, userId, name, columns }) {
  await ensureSchema();
  const tableId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  const cols = Array.isArray(columns) ? columns.map((c) => String(c)) : [];
  await q("INSERT INTO data_tables (id, user_id, name, columns, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [
    tableId,
    String(userId),
    String(name || ""),
    JSON.stringify(cols),
    now,
    now,
  ]);
  return dataTableGet(tableId, userId);
}

export async function dataTableUpdate(id, userId, { name, columns } = {}) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM data_tables WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  if (!rows.length) return null;
  const existing = rows[0];
  const cols = Array.isArray(columns) ? JSON.stringify(columns.map((c) => String(c))) : existing.columns;
  await q("UPDATE data_tables SET name = $1, columns = $2, updated_at = $3 WHERE id = $4 AND user_id = $5", [
    name === undefined ? existing.name : String(name),
    cols,
    new Date().toISOString(),
    String(id),
    String(userId),
  ]);
  return dataTableGet(id, userId);
}

export async function dataTableRemove(id, userId) {
  await ensureSchema();
  const { rows } = await q("SELECT id FROM data_tables WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  if (!rows.length) return false;
  await q("DELETE FROM data_table_rows WHERE table_id = $1", [String(id)]);
  await q("DELETE FROM data_tables WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  return true;
}

export async function dataTableRowsList(tableId, userId) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM data_table_rows WHERE table_id = $1 AND user_id = $2 ORDER BY created_at", [String(tableId), String(userId)]);
  return rows.map(dataRow);
}

export async function dataTableRowCreate({ id, tableId, userId, data }) {
  await ensureSchema();
  const rowId = String(id || crypto.randomUUID());
  const now = new Date().toISOString();
  await q("INSERT INTO data_table_rows (id, table_id, user_id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [
    rowId,
    String(tableId),
    String(userId),
    JSON.stringify(data && typeof data === "object" ? data : {}),
    now,
    now,
  ]);
  const { rows } = await q("SELECT * FROM data_table_rows WHERE id = $1", [rowId]);
  return dataRow(rows[0]);
}

// Bulk insert (CSV import) — a single multi-row INSERT. `rows` is capped by the
// caller (5000 rows × 6 params stays well under PostgreSQL's 65535 bind limit).
export async function dataTableRowCreateMany({ tableId, userId, rows }) {
  await ensureSchema();
  if (!Array.isArray(rows) || !rows.length) return 0;
  const base = Date.now();
  const values = [];
  const params = [];
  rows.forEach((data, i) => {
    const at = new Date(base + i).toISOString();
    const n = params.length;
    values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6})`);
    params.push(String(crypto.randomUUID()), String(tableId), String(userId), JSON.stringify(data && typeof data === "object" ? data : {}), at, at);
  });
  await q(`INSERT INTO data_table_rows (id, table_id, user_id, data, created_at, updated_at) VALUES ${values.join(", ")}`, params);
  return rows.length;
}

export async function dataTableRowUpdate(id, userId, data) {
  await ensureSchema();
  const { rows } = await q("SELECT * FROM data_table_rows WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  if (!rows.length) return null;
  await q("UPDATE data_table_rows SET data = $1, updated_at = $2 WHERE id = $3 AND user_id = $4", [
    JSON.stringify(data && typeof data === "object" ? data : {}),
    new Date().toISOString(),
    String(id),
    String(userId),
  ]);
  const after = await q("SELECT * FROM data_table_rows WHERE id = $1", [String(id)]);
  return dataRow(after.rows[0]);
}

export async function dataTableRowRemove(id, userId) {
  await ensureSchema();
  const res = await q("DELETE FROM data_table_rows WHERE id = $1 AND user_id = $2", [String(id), String(userId)]);
  return Number(res.rowCount || 0) > 0;
}

// ----------------------------------------------------------------------------
// execution history across ALL of a user's workflows (mirrors db.js)
// ----------------------------------------------------------------------------
export async function executionsListByOwner(ownerId, limit = 50) {
  await ensureSchema();
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const { rows } = await q(
    "SELECT id, workflow_id, source, started_at, finished_at, duration_ms, success, aborted, node_count, error_count, prompt_tokens, completion_tokens, ai_cost_usd FROM executions WHERE owner_id = $1 ORDER BY started_at DESC LIMIT $2",
    [String(ownerId), n]
  );
  return rows.map(executionRowToSummary);
}

// ----------------------------------------------------------------------------
// AI usage (mirrors db.js)
// ----------------------------------------------------------------------------
export async function executionsAiUsageSince(ownerId, sinceIso, workflowId = "") {
  await ensureSchema();
  const wf = String(workflowId || "");
  const { rows } = await q(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens, COALESCE(SUM(ai_cost_usd), 0) AS cost, COUNT(*) AS runs FROM executions WHERE owner_id = $1 AND started_at >= $2${wf ? " AND workflow_id = $3" : ""}`,
    [String(ownerId), String(sinceIso), ...(wf ? [wf] : [])]
  );
  const row = rows[0] || {};
  return { tokens: Number(row.tokens || 0), costUsd: Number(row.cost || 0), runs: Number(row.runs || 0) };
}

export async function executionsAiRuns(ownerId, sinceIso, limit = 2000) {
  await ensureSchema();
  const n = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
  const { rows } = await q(
    "SELECT id, workflow_id, started_at, prompt_tokens, completion_tokens, ai_cost_usd, data FROM executions WHERE owner_id = $1 AND started_at >= $2 AND (prompt_tokens + completion_tokens) > 0 ORDER BY started_at DESC LIMIT $3",
    [String(ownerId), String(sinceIso), n]
  );
  return rows.map((r) => {
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
      calls: log.filter((l) => l && l.usage).map((l) => ({ nodeId: l.nodeId, nodeName: l.nodeName, nodeType: l.nodeType, usage: l.usage })),
    };
  });
}

// ----------------------------------------------------------------------------
// events journal (mirrors db.js)
// ----------------------------------------------------------------------------
export async function journalInsert(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  await ensureSchema();
  let count = 0;
  for (const r of rows) {
    await q(
      "INSERT INTO db_events (ts, source, actor, op, target, detail, duration_ms, ok) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        Number(r.ts || Date.now()),
        String(r.source || "server"),
        String(r.actor || ""),
        String(r.op || ""),
        String(r.target || ""),
        String(r.detail || "").slice(0, 400),
        Number(r.durationMs || 0),
        r.ok === false ? 0 : 1,
      ]
    );
    count++;
  }
  return count;
}

export async function journalList({ limit = 100, source = "", op = "", since = 0 } = {}) {
  await ensureSchema();
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const where = [];
  const params = [];
  if (source) {
    params.push(String(source));
    where.push(`source = $${params.length}`);
  }
  if (op) {
    params.push(String(op));
    where.push(`op = $${params.length}`);
  }
  if (since) {
    params.push(Number(since));
    where.push(`ts >= $${params.length}`);
  }
  params.push(n);
  const { rows } = await q(
    "SELECT id, ts, source, actor, op, target, detail, duration_ms, ok FROM db_events" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY ts DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({
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

export async function journalPrune(keepMs) {
  await ensureSchema();
  const res = await q("DELETE FROM db_events WHERE ts < $1", [Date.now() - Number(keepMs || 7 * 24 * 60 * 60_000)]);
  return Number(res.rowCount || 0);
}

export async function journalCount() {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS c FROM db_events");
  return Number(rows[0].c || 0);
}

// ----------------------------------------------------------------------------
// operational alerts (mirrors db.js)
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

export async function alertUpsert({ id, level, source, title, message }) {
  await ensureSchema();
  const found = await q("SELECT * FROM alerts WHERE resolved = 0 AND source = $1 AND title = $2 LIMIT 1", [String(source || ""), String(title || "")]);
  const now = new Date().toISOString();
  if (found.rows.length) {
    const existing = found.rows[0];
    await q("UPDATE alerts SET message = $1, level = $2, occurrences = occurrences + 1, updated_at = $3 WHERE id = $4", [
      String(message || existing.message || ""),
      String(level || existing.level),
      now,
      existing.id,
    ]);
    const after = await q("SELECT * FROM alerts WHERE id = $1", [existing.id]);
    return { alert: alertRow(after.rows[0]), created: false };
  }
  const alertId = String(id || crypto.randomUUID());
  await q(
    "INSERT INTO alerts (id, level, source, title, message, created_at, updated_at, resolved, occurrences, email_sent) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 1, 0)",
    [alertId, String(level || "warning"), String(source || ""), String(title || ""), String(message || ""), now, now]
  );
  const after = await q("SELECT * FROM alerts WHERE id = $1", [alertId]);
  return { alert: alertRow(after.rows[0]), created: true };
}

export async function alertMarkEmailed(id) {
  await ensureSchema();
  await q("UPDATE alerts SET email_sent = 1 WHERE id = $1", [String(id)]);
}

export async function alertsList({ includeResolved = false, limit = 100 } = {}) {
  await ensureSchema();
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { rows } = await q(
    "SELECT * FROM alerts" +
      (includeResolved ? "" : " WHERE resolved = 0") +
      " ORDER BY resolved ASC, updated_at DESC LIMIT $1",
    [n]
  );
  return rows.map(alertRow);
}

export async function alertResolve(id) {
  await ensureSchema();
  const res = await q("UPDATE alerts SET resolved = 1, updated_at = $1 WHERE id = $2", [new Date().toISOString(), String(id)]);
  return Number(res.rowCount || 0) > 0;
}

export async function alertRemove(id) {
  await ensureSchema();
  const res = await q("DELETE FROM alerts WHERE id = $1", [String(id)]);
  return Number(res.rowCount || 0) > 0;
}

export async function alertsStats() {
  await ensureSchema();
  const { rows } = await q("SELECT COUNT(*) AS total, SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) AS open FROM alerts");
  return { total: Number(rows[0].total || 0), open: Number(rows[0].open || 0) };
}


