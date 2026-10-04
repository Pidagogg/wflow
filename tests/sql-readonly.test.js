// ============================================================================
// Read-only SQL guard (server/dbx.js isReadOnlySql) — the workflow SQL Query
// node may only read data (SELECT / WITH / VALUES / EXPLAIN). Writes would let
// a workflow — which can be triggered by a public webhook with no login —
// tamper with user accounts, sessions and secrets. The admin panel's SQL
// console is not affected (it bypasses this check).
//
// Run: node --test tests/sql-readonly.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the DB file before any module that touches it loads.
process.env.BF_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-sqlro-")), "ro.db");

const { isReadOnlySql } = await import("../server/dbx.js");

test("read queries are allowed", () => {
  assert.equal(isReadOnlySql("SELECT * FROM users"), true);
  assert.equal(isReadOnlySql("  select id, email from users where id = :id;"), true);
  assert.equal(isReadOnlySql("WITH recent AS (SELECT * FROM users) SELECT * FROM recent;"), true);
  assert.equal(isReadOnlySql("VALUES (1, 'a'), (2, 'b')"), true);
  assert.equal(isReadOnlySql("EXPLAIN SELECT * FROM users"), true);
  // keywords inside string literals, identifiers or comments do not count
  assert.equal(isReadOnlySql("SELECT 'update' AS word, \"delete\" AS name"), true);
  assert.equal(isReadOnlySql("SELECT * FROM users -- delete later"), true);
  assert.equal(isReadOnlySql("SELECT * FROM [create] WHERE x = 'drop'"), true);
});

test("write statements are rejected — including sneaked-in ones", () => {
  const writes = [
    "INSERT INTO users (id) VALUES (1)",
    "UPDATE users SET name = 'x'",
    "DELETE FROM users",
    "DELETE FROM user_sessions WHERE 1=1",
    "DROP TABLE users",
    "CREATE TABLE x (id INT)",
    "ALTER TABLE users ADD COLUMN x",
    "REPLACE INTO users (id) VALUES (1)",
    "WITH c AS (SELECT 1) DELETE FROM users", // WITH prefix does not slip past
    "WITH c AS (SELECT 1) INSERT INTO users SELECT * FROM c",
    "PRAGMA journal_mode = wal",
    "BEGIN; DELETE FROM users; COMMIT;",
    "ATTACH DATABASE '/tmp/x' AS x",
    "VACUUM",
  ];
  for (const sql of writes) {
    assert.equal(isReadOnlySql(sql), false, `should reject: ${sql}`);
  }
});

test("empty or non-SQL input is rejected", () => {
  assert.equal(isReadOnlySql(""), false);
  assert.equal(isReadOnlySql("   "), false);
  assert.equal(isReadOnlySql("users"), false);
  assert.equal(isReadOnlySql("SELECT *"), true); // minimal but read-only
});
