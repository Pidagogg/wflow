// ============================================================================
// Action nodes — edge cases, dropdown options, credential refusal, manual
// output, and the hard-failure contract (a failing node must THROW so its
// "If this node fails" setting decides what happens, never report success with
// an `error` field hidden in the item).
//
// Run: node --test tests/nodes-actions.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { NODES, executeNode, configFor, deepClone, installFetch, restoreFetch, ensureFixtures, cleanupFixtures } from "./helpers/node-harness.js";
import { typesIn, registerEdgeCaseSweeps, registerEnumSweep, mkNode, loneWorkflow, INPUT, withCreds, mockFetch, jsonResponse } from "./helpers/node-scenarios.js";

const TYPES = typesIn("actions");

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

registerEdgeCaseSweeps("actions", TYPES);
registerEnumSweep("actions", TYPES);

const run = (type, extra = {}) => executeNode(loneWorkflow(type, mkNode(type, configFor(type, extra))), "n1", INPUT);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
test("service nodes refuse to call the API without credentials (before any network I/O)", { timeout: 120000 }, async () => {
  const failures = [];
  for (const type of TYPES) {
    const def = NODES[type];
    if (!def.service || def.service.auth === "none") continue;
    // Catalog defaults only: every credential field is empty.
    const r = await executeNode(loneWorkflow(type, mkNode(type, deepClone(def.defaults || {}))), "n1", INPUT);
    if (r.success) failures.push(`${type}: succeeded with empty credentials (expected MISSING_CONFIG)`);
    else if (r.errorCode !== ERROR_CODES.MISSING_CONFIG.code) failures.push(`${type}: error code ${r.errorCode} (expected ${ERROR_CODES.MISSING_CONFIG.code}) — ${r.error}`);
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// Manual output
// ---------------------------------------------------------------------------
test("invalid manual-output JSON is reported as a handled error, not a crash", async () => {
  const r = await run("http", { manualOutput: true, manualOutputJson: "{ not json" });
  assert.equal(r.success, false);
  assert.ok(r.errorCode, "a manual-output typo must still carry an error code");
  assert.match(String(r.error), /Manual output/i);
});

test("manual output bypasses the node and passes the typed JSON on unchanged", async () => {
  const manual = { hello: "world", n: 7, list: [1, 2] };
  let called = false;
  mockFetch(() => {
    called = true;
    return jsonResponse({});
  });
  const r = await run("http", { manualOutput: true, manualOutputJson: JSON.stringify(manual) });
  assert.equal(r.success, true);
  assert.deepEqual(r.outputItems, [manual]);
  assert.equal(called, false, "manual output must skip the HTTP call");
});

// ---------------------------------------------------------------------------
// Hard failures: hand-written senders must THROW (so onError applies)
// ---------------------------------------------------------------------------
test("WhatsApp rejects a 401 by throwing AUTH_FAILED (no fake success)", async () => {
  mockFetch(() => jsonResponse({ error: { message: "bad token" } }, 401));
  const r = await run("whatsappSend", { accessToken: "t", phoneNumberId: "1", to: "49123" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.AUTH_FAILED.code, r.error);
});

test("ClickUp rejects a 429 by throwing RATE_LIMITED", async () => {
  mockFetch(() => jsonResponse({ err: "slow down" }, 429));
  const r = await run("clickupTask", { token: "t", listId: "123" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.RATE_LIMITED.code, r.error);
});

test("Todoist rejects a 500 by throwing SERVICE_ERROR", async () => {
  mockFetch(() => jsonResponse({ error: "server exploded" }, 500));
  const r = await run("todoistTask", { token: "t", content: "hi" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.SERVICE_ERROR.code, r.error);
});

test("a successful hand-written sender no longer leaks an `error` field into the item", async () => {
  mockFetch(() => jsonResponse({ messages: [{ id: "wamid.1" }] }));
  const r = await run("whatsappSend", { accessToken: "t", phoneNumberId: "1", to: "49123" });
  assert.equal(r.success, true, r.error);
  assert.equal(r.outputItems[0].sent, true);
  assert.ok(!("error" in r.outputItems[0]), "a successful send must not carry an error field");
});

test("SMTP failures throw SERVICE_ERROR instead of a soft `sent:false` item", async () => {
  const r = await run("emailSend", { host: "127.0.0.1", port: 1, secure: false, user: "", appPassword: "", to: "a@b.c", subject: "s", body: "b" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.SERVICE_ERROR.code, r.error);
});

test("an unreachable PostgreSQL throws QUERY_FAILED instead of a soft `error` item", async () => {
  const r = await run("sqlPostgres", { host: "127.0.0.1", port: 1, database: "x", user: "u", password: "p", query: "SELECT 1;", connectTimeoutMs: 500 });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.QUERY_FAILED.code, r.error);
});

// ---------------------------------------------------------------------------
// Happy paths that must keep working
// ---------------------------------------------------------------------------
test("QR Code still produces a PNG data URL on success", async () => {
  const r = await run("qrcode", { text: "https://example.com", size: 128 });
  assert.equal(r.success, true, r.error);
  assert.match(String(r.outputItems[0].qrDataUrl), /^data:image\/png;base64,/);
});
