// ============================================================================
// HTTP failure contract for EVERY network-calling node.
//
// The node list is derived from server/executor.js itself (every `case "x"`
// block that calls fetch()), so a newly added HTTP node is covered
// automatically. For each one: point it at a service that answers 500 and
// assert the node FAILS with a classified code instead of reporting success
// with an `error` field hidden in the item.
//
// `http` is deliberately exempt: the HTTP Request node's whole purpose is to
// hand the caller the raw status/body (users branch on it with an IF node).
//
// Run: node --test tests/nodes-http-errors.test.js
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { NODES, executeNode, configFor, installFetch, restoreFetch, ensureFixtures, cleanupFixtures, deepClone } from "./helpers/node-harness.js";
import { mkNode, loneWorkflow, INPUT, mockFetch, jsonResponse, withCreds } from "./helpers/node-scenarios.js";

// --- discover every fetch-calling node from the executor source -------------
const EXECUTOR_SRC = fs.readFileSync(new URL("../server/executor.js", import.meta.url), "utf8");
const CASE_START = /^ {4}case "([A-Za-z0-9]+)"/gm;
const marks = [...EXECUTOR_SRC.matchAll(CASE_START)].map((m) => ({ name: m[1], at: m.index }));
const FETCH_NODES = [];
for (let i = 0; i < marks.length; i++) {
  const end = i + 1 < marks.length ? marks[i + 1].at : EXECUTOR_SRC.length;
  const block = EXECUTOR_SRC.slice(marks[i].at, end);
  if (!/fetch\(/.test(block)) continue;
  if (!NODES[marks[i].name]) continue; // legacy aliases with no catalog entry
  if (FETCH_NODES.includes(marks[i].name)) continue; // grouped cases share a handler
  FETCH_NODES.push(marks[i].name);
}

// The low-level HTTP Request node returns the status/body by design.
const BY_DESIGN_STATUS_NODES = new Set(["http"]);
const TESTABLE = FETCH_NODES.filter((t) => !BY_DESIGN_STATUS_NODES.has(t));

before(() => {
  installFetch();
  ensureFixtures();
});
after(() => {
  restoreFetch();
  cleanupFixtures();
});
beforeEach(() => {
  installFetch();
});

/** Fill every blank text/secret/textarea/number field so the node proceeds to
 *  the network call instead of failing on missing configuration. */
function filledConfig(type) {
  const def = NODES[type];
  const cfg = { ...configFor(type) };
  for (const f of def.fields || []) {
    const v = cfg[f.key];
    const blank = v === "" || v === undefined || v === null;
    if (!blank) continue;
    if (["text", "textarea", "secret", "code", "json"].includes(f.type)) cfg[f.key] = f.type === "json" ? "{}" : "stub";
    else if (f.type === "number") cfg[f.key] = 1;
    else if (f.type === "select") {
      const first = (f.options || []).map((o) => (o && typeof o === "object" ? o.value : o))[0];
      if (first) cfg[f.key] = first;
    }
  }
  return withCreds(type, cfg);
}

test("every network node fails (never reports success) on any error response", { timeout: 180000 }, async () => {
  assert.ok(TESTABLE.length > 50, `expected many network nodes, found ${TESTABLE.length}`);
  const failures = [];
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    for (const type of TESTABLE) {
      mockFetch(() => jsonResponse({ error: { message: "boom" }, message: "boom" }, status));
      let r;
      try {
        r = await executeNode(loneWorkflow(type, mkNode(type, filledConfig(type))), "n1", INPUT);
      } catch (err) {
        failures.push(`${type} [${status}]: threw out of executeNode: ${err.message}`);
        continue;
      }
      if (r.success) failures.push(`${type} [${status}]: reported SUCCESS on HTTP ${status} (${JSON.stringify(r.outputItems).slice(0, 160)})`);
      else if (!r.errorCode) failures.push(`${type} [${status}]: failed without a BF error code (${r.error})`);
    }
  }
  assert.deepEqual(failures, [], `${failures.length} node/status combination(s) treated an HTTP error as success`);
});

test("a 2xx response carrying an application-level error still fails the node", async () => {
  const cases = [
    ["slackBotSend", { ok: false, error: "channel_not_found" }, "slack"],
    ["pushoverSend", { status: 0, errors: ["invalid token"] }, "pushover"],
    ["pipedriveDeal", { success: false, error: "bad token" }, "pipedrive"],
    ["githubCreatePr", { message: "Validation Failed" }, "github"],
    ["weather", { cod: "404", message: "city not found" }, "weather"],
    ["ipGeo", { status: "fail", message: "reserved range" }, "ipgeo"],
  ];
  const failures = [];
  for (const [type, body] of cases) {
    mockFetch(() => jsonResponse(body, 200));
    const r = await executeNode(loneWorkflow(type, mkNode(type, filledConfig(type))), "n1", INPUT);
    if (r.success) failures.push(`${type}: accepted an application-level error as success`);
    else if (r.errorCode !== ERROR_CODES.SERVICE_ERROR.code) failures.push(`${type}: code ${r.errorCode} (expected ${ERROR_CODES.SERVICE_ERROR.code}) — ${r.error}`);
  }
  assert.deepEqual(failures, []);
});

test("a 4xx response maps to the auth / rate-limit / service codes", async () => {
  // One representative node per implemented shape.
  const cases = [
    ["slackSend", 429, ERROR_CODES.RATE_LIMITED.code],
    ["discordSend", 401, ERROR_CODES.AUTH_FAILED.code],
    ["teamsSend", 500, ERROR_CODES.SERVICE_ERROR.code],
    ["ntfySend", 403, ERROR_CODES.AUTH_FAILED.code],
    ["webdavUpload", 507, ERROR_CODES.SERVICE_ERROR.code],
  ];
  const failures = [];
  for (const [type, status, expected] of cases) {
    mockFetch(() => jsonResponse({ error: "nope" }, status));
    const r = await executeNode(loneWorkflow(type, mkNode(type, filledConfig(type))), "n1", INPUT);
    if (r.success) failures.push(`${type}: reported success on HTTP ${status}`);
    else if (r.errorCode !== expected) failures.push(`${type}: HTTP ${status} → ${r.errorCode}, expected ${expected} (${r.error})`);
  }
  assert.deepEqual(failures, []);
});

test("a network failure is classified, never swallowed", async () => {
  const cases = ["slackSend", "githubIssue", "googleSheetsRead", "s3Upload", "redditSearch"];
  const failures = [];
  for (const type of cases) {
    mockFetch(() => {
      throw new Error("fetch failed");
    });
    const r = await executeNode(loneWorkflow(type, mkNode(type, filledConfig(type))), "n1", INPUT);
    if (r.success) failures.push(`${type}: reported success on a network failure`);
    else if (r.errorCode !== ERROR_CODES.HTTP_REQUEST_FAILED.code) failures.push(`${type}: code ${r.errorCode} (expected ${ERROR_CODES.HTTP_REQUEST_FAILED.code}) — ${r.error}`);
  }
  assert.deepEqual(failures, []);
});

test("the HTTP Request node still returns the status by design (exempt)", async () => {
  mockFetch(() => jsonResponse({ error: "server down" }, 500));
  const r = await executeNode(loneWorkflow("http", mkNode("http", { ...configFor("http"), url: "http://localhost/stub", retries: 0 })), "n1", INPUT);
  assert.equal(r.success, true, "the raw HTTP node hands the caller the status");
  assert.ok("ok" in r.outputItems[0]);
});

test("discovered network nodes are sane", () => {
  assert.ok(TESTABLE.includes("slackSend"));
  assert.ok(TESTABLE.includes("googleSheetsRead"));
  assert.ok(!TESTABLE.includes("set"), "only fetch-calling nodes are listed");
  // deepClone is used by the config builder above
  assert.deepEqual(deepClone({ a: 1 }), { a: 1 });
});
