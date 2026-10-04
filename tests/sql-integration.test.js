// ============================================================================
// SQL node integration tests — REAL PostgreSQL / MySQL.
//
// These are the only tests that need a live database, so they are SKIPPED
// unless you point them at one. Nothing is installed; the nodes use the `pg`
// and `mysql2` packages the project already depends on.
//
//   # start servers (docker compose has neither by default — use any Postgres/MySQL)
//   export TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/testdb
//   export TEST_MYSQL_URL=mysql://user:pass@localhost:3306/testdb
//   npm test
//
// Run just these: node --test tests/sql-integration.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { executeNode, configFor, installFetch, restoreFetch, ensureFixtures, cleanupFixtures } from "./helpers/node-harness.js";
import { mkNode, loneWorkflow, INPUT } from "./helpers/node-scenarios.js";

const TARGETS = [
  { label: "PostgreSQL", type: "sqlPostgres", url: process.env.TEST_POSTGRES_URL || "", env: "TEST_POSTGRES_URL", port: 5432 },
  { label: "MySQL", type: "sqlMysql", url: process.env.TEST_MYSQL_URL || "", env: "TEST_MYSQL_URL", port: 3306 },
];

function connConfig(target) {
  const u = new URL(target.url);
  return {
    host: u.hostname,
    port: Number(u.port || target.port),
    database: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    params: "{}",
    storeIn: "rows",
    connectTimeoutMs: 5000,
  };
}

const run = (type, extra) => executeNode(loneWorkflow(type, mkNode(type, configFor(type, extra))), "n1", INPUT);

before(() => {
  installFetch();
  ensureFixtures();
});
after(() => {
  restoreFetch();
  cleanupFixtures();
});

for (const target of TARGETS) {
  if (!target.url) {
    test(`${target.label} SQL node integration (skipped — no server configured)`, { skip: `set ${target.env} to run` }, () => {});
    continue;
  }

  const base = connConfig(target);

  test(`${target.label}: SELECT with no parameters returns rows`, async () => {
    const r = await run(target.type, { ...base, query: "SELECT 1 AS one;" });
    assert.equal(r.success, true, r.error);
    assert.equal(r.outputItems[0].rowCount, 1);
    assert.equal(Number(r.outputItems[0].rows[0].one), 1);
  });

  test(`${target.label}: :name object parameters are bound`, async () => {
    const r = await run(target.type, { ...base, query: "SELECT :value AS v;", params: '{"value": 42}' });
    assert.equal(r.success, true, r.error);
    assert.equal(Number(r.outputItems[0].rows[0].v), 42);
  });

  test(`${target.label}: array parameters are bound to positional placeholders`, async () => {
    const placeholder = target.type === "sqlPostgres" ? "$1" : "?";
    const r = await run(target.type, { ...base, query: `SELECT ${placeholder} AS v;`, params: "[7]" });
    assert.equal(r.success, true, r.error);
    assert.equal(Number(r.outputItems[0].rows[0].v), 7);
  });

  test(`${target.label}: rows land under the configured storeIn field`, async () => {
    const r = await run(target.type, { ...base, query: "SELECT 1 AS one;", storeIn: "result" });
    assert.equal(r.success, true, r.error);
    assert.ok(Array.isArray(r.outputItems[0].result));
    assert.equal(r.outputItems[0].fetched, true);
  });

  test(`${target.label}: a query against a missing table fails with QUERY_FAILED`, async () => {
    const r = await run(target.type, { ...base, query: "SELECT * FROM wflow_missing_table_98765;" });
    assert.equal(r.success, false);
    assert.equal(r.errorCode, ERROR_CODES.QUERY_FAILED.code, r.error);
  });

  test(`${target.label}: an unreachable host fails with QUERY_FAILED (no soft error)`, async () => {
    const r = await run(target.type, { ...base, host: "127.0.0.1", port: 1, connectTimeoutMs: 500, query: "SELECT 1;" });
    assert.equal(r.success, false);
    assert.equal(r.errorCode, ERROR_CODES.QUERY_FAILED.code, r.error);
  });
}
