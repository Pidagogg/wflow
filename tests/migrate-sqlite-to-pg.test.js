// ============================================================================
// SQLite → PostgreSQL migration tool (scripts/migrate-sqlite-to-pg.mjs).
//
// There is no PostgreSQL server to migrate into during a test run, so this
// covers the parts that decide whether a migration is correct — and would
// silently lose data if they were wrong:
//
//   - the schema the tool builds comes from server/pg.js, so SCHEMA_TABLES must
//     still list every table server/db.js creates (drift = forgotten tables),
//   - reading the source: only app tables are copied, foreign tables skipped,
//     row counts and column lists come out right,
//   - the generated INSERTs: one statement per batch, parameters in column
//     order, identifiers quoted, duplicates ignored,
//   - batching stays inside PostgreSQL's 65535-parameter limit,
//   - refusing to wipe the target without an explicit --yes.
//
// Run: node --test tests/migrate-sqlite-to-pg.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  buildInsert,
  chunk,
  intersectColumns,
  maskUrl,
  parseArgs,
  quoteIdent,
  readSource,
  rowsPerBatch,
  toPgValue,
} from "../scripts/migrate-sqlite-to-pg.mjs";
import { SCHEMA_TABLES } from "../server/pg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

test("SCHEMA_TABLES covers every table the app creates", () => {
  const source = fs.readFileSync(path.join(ROOT, "server", "db.js"), "utf8");
  const sqliteTables = [...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(sqliteTables.length >= 19, `expected the SQLite schema to define its tables, got ${sqliteTables.length}`);
  assert.deepEqual(
    [...SCHEMA_TABLES].sort(),
    [...sqliteTables].sort(),
    "server/pg.js and server/db.js define different tables — the migration would skip the missing ones"
  );
});

test("parseArgs: url/sqlite options, defaults and switches", () => {
  assert.deepEqual(parseArgs([]), {
    url: "",
    sqlite: "",
    dryRun: false,
    truncate: false,
    yes: false,
    help: false,
  });
  const opts = parseArgs(["--url", "postgres://u:p@h:5432/db", "--sqlite", "data/x.db", "--dry-run"]);
  assert.equal(opts.url, "postgres://u:p@h:5432/db");
  assert.equal(opts.sqlite, "data/x.db");
  assert.equal(opts.dryRun, true);
  assert.equal(parseArgs(["--url=postgres://a/b"]).url, "postgres://a/b");
  assert.equal(parseArgs(["--sqlite=./a.db"]).sqlite, "./a.db");
  assert.equal(parseArgs(["-y"]).yes, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
  assert.throws(() => parseArgs(["stray"]), /Unexpected argument/);
});

test("parseArgs: truncating needs --yes", () => {
  assert.throws(() => parseArgs(["--truncate"]), /--yes/);
  const opts = parseArgs(["--truncate", "--yes"]);
  assert.equal(opts.truncate, true);
  assert.equal(opts.yes, true);
});

test("intersectColumns keeps source order and drops columns the target lacks", () => {
  assert.deepEqual(intersectColumns(["id", "email", "role"], ["role", "id"]), ["id", "role"]);
  assert.deepEqual(intersectColumns(["a", "b"], ["a", "b"]), ["a", "b"]);
  assert.deepEqual(intersectColumns(["a"], []), []);
});

test("quoteIdent escapes double quotes", () => {
  assert.equal(quoteIdent("users"), '"users"');
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});

test("buildInsert: parameter order, one tuple per row, duplicates ignored", () => {
  const rows = [
    { id: "a", email: "a@example.com", name: "A" },
    { id: "b", email: "b@example.com", name: null },
  ];
  const { sql, params } = buildInsert("users", ["id", "email", "name"], rows);
  assert.equal(
    sql,
    'INSERT INTO "users" ("id", "email", "name") VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT DO NOTHING'
  );
  assert.deepEqual(params, ["a", "a@example.com", "A", "b", "b@example.com", null]);
});

test("buildInsert: a table with a reserved name stays quoted", () => {
  const { sql } = buildInsert("user", ["id"], [{ id: "1" }]);
  assert.match(sql, /INSERT INTO "user" \("id"\) VALUES \(\$1\) ON CONFLICT DO NOTHING/);
});

test("toPgValue: undefined becomes NULL, BigInt becomes a string", () => {
  assert.equal(toPgValue(undefined), null);
  assert.equal(toPgValue(0), 0);
  assert.equal(toPgValue(""), "");
  assert.equal(toPgValue(1731000000000n), "1731000000000");
});

test("chunk and rowsPerBatch stay inside PostgreSQL's parameter limit", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]); // a bad size never loops forever
  const perBatch = rowsPerBatch(15);
  assert.ok(perBatch * 15 <= 65535, `${perBatch} rows × 15 columns exceeds PostgreSQL's limit`);
  assert.equal(rowsPerBatch(1), 500, "wide tables are capped at a sane batch size");
});

test("maskUrl hides the password", () => {
  assert.equal(maskUrl("postgres://wflow:secret@db:5432/wflow"), "postgres://***@db:5432/wflow");
});

test("readSource: copies app tables, skips foreign ones, reports columns and counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-migrate-"));
  const file = path.join(dir, "admin.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_login TEXT,
      workflow_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
      role TEXT NOT NULL DEFAULT 'user', deactivation_reason TEXT NOT NULL DEFAULT '',
      deactivated_at TEXT
    );
    CREATE TABLE executions (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'editor', started_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 0,
      aborted INTEGER NOT NULL DEFAULT 0, node_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0, ai_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE someone_elses_table (id TEXT PRIMARY KEY);
    INSERT INTO users (id, email, password_hash, created_at, role)
      VALUES ('u1', 'a@example.com', 'hash', '2026-01-01', 'pro_user'), ('u2', 'b@example.com', 'hash', '2026-01-02', 'user');
    INSERT INTO executions (id, workflow_id, started_at) VALUES ('e1', 'w1', '2026-01-01');
    INSERT INTO someone_elses_table (id) VALUES ('x');
  `);

  const { plan, unknown } = readSource(db);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(
    plan.map((p) => p.table),
    ["users", "executions"],
    "plan should walk the app schema, not the file's table order"
  );
  const users = plan.find((p) => p.table === "users");
  assert.equal(users.count, 2);
  assert.ok(users.columns.includes("role"));
  assert.ok(users.columns.includes("deactivated_at"));
  assert.equal(plan.find((p) => p.table === "executions").count, 1);
  // A table the app does not know is reported, never half-copied.
  assert.deepEqual(unknown, ["someone_elses_table"]);
  assert.ok(!plan.some((p) => p.table === "someone_elses_table"));
  assert.ok(!plan.some((p) => p.table.startsWith("sqlite_")));
});
