// ============================================================================
// Files & Data nodes — edge cases, dropdown options, disk round-trips and the
// hard-failure contract for the local data nodes.
//
// Run: node --test tests/nodes-files.test.js
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { executeNode, configFor, installFetch, restoreFetch, ensureFixtures, cleanupFixtures, writeFileBytes, FILES_DIR } from "./helpers/node-harness.js";
import { typesIn, registerEdgeCaseSweeps, registerEnumSweep, mkNode, loneWorkflow, INPUT } from "./helpers/node-scenarios.js";

const TYPES = typesIn("files");

// A file name only THIS test file uses: node --test runs test files in
// parallel and tests/all-nodes.test.js deletes its own fixture in after().
const FIXTURE = "nodes-files-fixture.txt";

before(() => {
  installFetch();
  ensureFixtures();
  writeFileBytes(FIXTURE, Buffer.from("hello from the fixture\n"));
});
after(() => {
  restoreFetch();
  cleanupFixtures();
  try {
    fs.rmSync(path.join(FILES_DIR, FIXTURE), { force: true });
  } catch {
    /* best-effort */
  }
});
beforeEach(() => {
  installFetch();
});

registerEdgeCaseSweeps("files", TYPES);
registerEnumSweep("files", TYPES);

const run = (type, extra = {}, items = INPUT) => executeNode(loneWorkflow(type, mkNode(type, configFor(type, extra))), "n1", items);

test("Read File from Disk reads the sandbox fixture", async () => {
  const r = await run("readFile", { path: FIXTURE });
  assert.equal(r.success, true, r.error);
  assert.match(JSON.stringify(r.outputItems[0]), /hello from the fixture/);
});

test("Read File from Disk reports a missing file with BF-6008", async () => {
  const r = await run("readFile", { path: "definitely-not-here-12345.txt" });
  const txt = `${r.error || ""} ${JSON.stringify(r.outputItems)}`;
  assert.ok(r.errorCode || /not found/i.test(txt), `expected a not-found outcome, got ${txt}`);
});

test("Extract File decodes base64 content from a payload field", async () => {
  const r = await run("extractFile", { fileSource: "field", sourceField: "data", contentMode: "base64", fileName: "input.txt" });
  assert.equal(r.success, true, r.error);
  assert.match(JSON.stringify(r.outputItems[0]), /hello/);
});

test("Data Store set → get round-trips a value", async () => {
  const set = await run("dataStore", { operation: "set", namespace: "files-test", key: "greeting", value: "{{name}}" });
  assert.equal(set.success, true, set.error);
  const get = await run("dataStore", { operation: "get", namespace: "files-test", key: "greeting", storeIn: "value" });
  assert.equal(get.success, true, get.error);
  assert.equal(get.outputItems[0].value, "Ada");
});

test("SQL Query runs a read-only statement and returns rows", async () => {
  const r = await run("sqlQuery", { sql: "SELECT 1 AS one;", params: "{}", storeIn: "rows" });
  assert.equal(r.success, true, r.error);
  // node:sqlite rows are null-prototype objects — normalize before comparing.
  assert.deepEqual(JSON.parse(JSON.stringify(r.outputItems[0].rows)), [{ one: 1 }]);
});

test("SQL Query fails with QUERY_FAILED on a bad statement instead of soft-failing", async () => {
  const r = await run("sqlQuery", { sql: "SELEC 1;", params: "{}" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.QUERY_FAILED.code, r.error);
});

test("SQL Query refuses a write statement", async () => {
  const r = await run("sqlQuery", { sql: "DELETE FROM users;", params: "{}" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.QUERY_FAILED.code, r.error);
  assert.match(String(r.error), /read-only/i);
});

test("Compress with no upstream files fails with BF-6005 instead of a fake success", async () => {
  const r = await run("compress", { sources: "*", format: "zip" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.FILE_CONTENT_MISSING.code, r.error);
});
