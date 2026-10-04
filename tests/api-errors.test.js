// ============================================================================
// Service error detail — a failed request must say what was wrong, not just
// "HTTP 400". Google Calendar answered a bare "Bad Request" until its
// errors[0].reason was read; Airtable can answer {"error":"NOT_FOUND"} (a
// string, so error.message was empty) or the vague
// INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND for a wrong table name.
//
// Run: node --test tests/api-errors.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { NODES, executeNode, deepClone } from "./helpers/node-harness.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answer(status, body) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return calls;
}

const run = (type, config) =>
  executeNode({ id: "wf", nodes: [{ id: "n1", type, data: { config: { ...deepClone(NODES[type].defaults), ...config } } }], edges: [] }, "n1", [{ json: {} }]);

test("Airtable: a wrong table name is explained instead of a bare 403", async () => {
  answer(403, { error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", message: "Invalid permissions, or the requested model was not found." } });
  const r = await run("airtableRead", { apiKey: "k", baseId: "appX", tableName: "Leads" });
  assert.equal(r.status, "error");
  assert.match(r.error, /cannot find table "Leads" in base appX/);
});

test("Airtable: a string error is kept as the detail", async () => {
  answer(422, { error: "INVALID_REQUEST_UNKNOWN" });
  const r = await run("airtableRead", { apiKey: "k", baseId: "appX", tableName: "Leads" });
  assert.match(r.error, /HTTP 422.*INVALID_REQUEST_UNKNOWN/);
});

test("Airtable: an empty Base ID fails before any request", async () => {
  const calls = answer(200, { records: [] });
  const r = await run("airtableRead", { apiKey: "k", baseId: "", tableName: "Leads" });
  assert.match(r.error, /Base ID/);
  assert.equal(calls.length, 0);
});

test("Outlook: Graph's error code is added to its message", async () => {
  answer(400, { error: { code: "ErrorInvalidRecipients", message: "At least one recipient is not valid." } });
  const r = await run("m365Calendar", { token: "t", start: "2026-01-01T10:00:00" });
  assert.match(r.error, /not valid\. \(ErrorInvalidRecipients\)/);
});

test("Outlook: a Manual run with blank times sends a one-hour event", async () => {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "e1" }), { status: 201 });
  };
  const r = await run("m365Calendar", { token: "t" });
  assert.equal(r.status, "success", r.error);
  assert.ok(body.start.dateTime && body.end.dateTime);
  assert.equal(Date.parse(`${body.end.dateTime}Z`) - Date.parse(`${body.start.dateTime}Z`), 3600_000);
});
