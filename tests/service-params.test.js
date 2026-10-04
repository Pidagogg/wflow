// ============================================================================
// Service-node parameters — every {{placeholder}} in a service node's request
// template (shared/services.js applyParamFields) is a field of its own, so
// Docs "Append Text" has a Text box instead of needing a hand-edited JSON body
// or an upstream item that happens to carry `text`.
//
// Run: node --test tests/service-params.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { NODES, executeNode, installFetch, restoreFetch, capturedRequests, deepClone } from "./helpers/node-harness.js";

beforeEach(() => installFetch());
after(() => restoreFetch());

const run = (type, config, json = {}) =>
  executeNode({ id: "wf", nodes: [{ id: "n1", type, data: { config: { ...deepClone(NODES[type].defaults), ...config } } }], edges: [] }, "n1", [{ json }]);

const placeholders = (v) => [...(typeof v === "string" ? v : JSON.stringify(v ?? "")).matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)].map((m) => m[1]);

test("every request placeholder of every service node can be filled from a field", () => {
  const missing = [];
  for (const [type, def] of Object.entries(NODES)) {
    if (!def.service) continue;
    const s = def.service;
    const names = new Set(placeholders(s.base).concat(placeholders(s.defaultPath), placeholders(s.defaultBody), placeholders(def.defaults.query), placeholders(def.defaults.headers)));
    const covered = new Set([...(s.params || []).map((p) => p.name), ...def.fields.map((f) => f.key)]);
    for (const n of names) if (n !== "raw" && !covered.has(n)) missing.push(`${type}: {{${n}}}`);
  }
  assert.deepEqual(missing, []);
});

test("parameter fields sit in an open, non-optional Parameters section with a default", () => {
  const def = NODES.googleDocsAppend;
  const text = def.fields.find((f) => f.key === "text");
  assert.ok(text, "Docs Append has a Text field");
  assert.equal(text.section, "Parameters");
  assert.equal(text.type, "textarea");
  assert.ok(!text.optional);
  assert.equal(def.defaults.text, "");
  assert.ok(def.fields.findIndex((f) => f.key === "text") < def.fields.findIndex((f) => f.key === "body"), "above the raw request");
  assert.equal(def.fields.find((f) => f.key === "documentId").label, "Document ID");
});

test("Docs Append sends the text typed into its field, with item placeholders filled", async () => {
  const r = await run("googleDocsAppend", { token: "t", documentId: "doc-1", text: "Hello {{name}}" }, { name: "Ada" });
  assert.equal(r.status, "success", r.error);
  const req = capturedRequests.at(-1);
  assert.match(req.url, /\/v1\/documents\/doc-1:batchUpdate$/);
  assert.equal(JSON.parse(req.init.body).requests[0].insertText.text, "Hello Ada");
});

test("an empty parameter keeps reading the item's own field (older workflows)", async () => {
  const r = await run("googleDocsAppend", { token: "t" }, { documentId: "doc-2", text: "from the item" });
  assert.equal(r.status, "success", r.error);
  const req = capturedRequests.at(-1);
  assert.match(req.url, /doc-2:batchUpdate$/);
  assert.equal(JSON.parse(req.init.body).requests[0].insertText.text, "from the item");
  // the field values never leak into the node's output item
  const out = await run("googleDocsAppend", { token: "t", documentId: "d", text: "x" }, { a: 1 });
  assert.equal(out.outputItems[0].text, undefined);
});

test("an empty placeholder in the URL path names its field instead of sending a broken URL", async () => {
  const sent = capturedRequests.length;
  const r = await run("googleDocsAppend", { token: "t", text: "x" });
  assert.equal(r.status, "error");
  assert.match(r.error, /\{\{documentId\}\}.*"Document ID"/);
  assert.equal(capturedRequests.length, sent, "nothing was sent");
  // an empty query-string placeholder is fine (optional filters)
  const ok = await run("googleDriveMoveFile", { token: "t", fileId: "f1", folderId: "d1" });
  assert.equal(ok.status, "success", ok.error);
});

test("Google Calendar List Events reads the primary calendar by default", async () => {
  assert.equal(NODES.googleCalendarListEvents.defaults.calendarId, "primary");
  const r = await run("googleCalendarListEvents", { token: "t" });
  assert.equal(r.status, "success", r.error);
  assert.match(capturedRequests.at(-1).url, /\/calendars\/primary\/events$/);
});

test("a placeholder named like a request field gets its own key", async () => {
  const def = NODES.bigqueryQuery;
  const f = def.fields.find((x) => x.key === "queryValue");
  assert.ok(f, "BigQuery's {{query}} is the queryValue field");
  assert.equal(f.label, "Query");
  assert.equal(def.fields.filter((x) => x.key === "query").length, 1, "the raw Query parameters field stays");
  const r = await run("bigqueryQuery", { token: "t", projectId: "p1", queryValue: "SELECT 1" });
  assert.equal(r.status, "success", r.error);
  assert.equal(JSON.parse(capturedRequests.at(-1).init.body).query, "SELECT 1");
});
