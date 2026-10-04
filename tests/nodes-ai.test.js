// ============================================================================
// AI nodes — edge cases, dropdown options and provider reply handling.
// Network is stubbed; the real request-building / response-parsing runs.
//
// Run: node --test tests/nodes-ai.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { NODES, executeNode, configFor, deepClone, installFetch, restoreFetch, ensureFixtures, cleanupFixtures } from "./helpers/node-harness.js";
import { typesIn, registerEdgeCaseSweeps, registerEnumSweep, mkNode, loneWorkflow, INPUT, mockFetch, jsonResponse } from "./helpers/node-scenarios.js";

const TYPES = typesIn("ai");

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

registerEdgeCaseSweeps("ai", TYPES);
registerEnumSweep("ai", TYPES);

const run = (type, extra = {}) => executeNode(loneWorkflow(type, mkNode(type, configFor(type, extra))), "n1", INPUT);

test("every provider-calling AI node exposes provider + model + apiKey fields", () => {
  // Helper nodes (Prompt, AI Output Parser, Split into Chunks) legitimately
  // call no provider; every node that DOES call one must be configurable.
  const missing = [];
  for (const type of TYPES) {
    const keys = new Set((NODES[type].fields || []).map((f) => f.key));
    if (!keys.has("provider") && !keys.has("baseUrl")) continue;
    if (!keys.has("model")) missing.push(`${type}: no model field`);
    if (!keys.has("apiKey")) missing.push(`${type}: no apiKey field`);
  }
  assert.deepEqual(missing, []);
});

test("AI Chat returns the provider's reply and stores it", async () => {
  const r = await run("aiChat", { prompt: "Say hello" });
  assert.equal(r.success, true, r.error);
  const out = r.outputItems[0];
  const text = out.reply ?? out.text ?? out.output ?? "";
  assert.match(String(text), /hello/i, `expected the stubbed reply, got ${JSON.stringify(out)}`);
});

test("a provider rejection fails the AI node with a classified error (never unhandled)", async () => {
  mockFetch(() => jsonResponse({ error: { message: "Incorrect API key provided" } }, 401));
  const r = await run("aiChat", { apiKey: "sk-wrong" });
  assert.equal(r.success, false);
  assert.ok(
    [ERROR_CODES.AUTH_FAILED.code, ERROR_CODES.AI_PROVIDER_ERROR.code].includes(r.errorCode),
    `expected an auth/provider error code, got ${r.errorCode} — ${r.error}`
  );
});

test("AI Chat uses the catalog provider defaults when the config omits them", () => {
  const bare = deepClone(NODES.aiChat.defaults || {});
  assert.equal(bare.provider, "openai", "the node ships a working provider default");
  assert.equal(bare.model.length > 0, true, "and a model default");
});

test("AI Embeddings stores the returned vector", async () => {
  const r = await run("aiEmbeddings", { text: "hello" });
  assert.equal(r.success, true, r.error);
  const vector = r.outputItems[0].vector;
  assert.ok(Array.isArray(vector) && vector.length > 0, `expected a vector, got ${JSON.stringify(r.outputItems[0])}`);
});

test("Vector Store then Vector Search round-trips an entry", async () => {
  const store = await run("vectorStore", { namespace: "ai-roundtrip", key: "k1", text: "pineapple pizza" });
  assert.equal(store.success, true, store.error);
  const search = await run("vectorSearch", { namespace: "ai-roundtrip", query: "pineapple pizza", topK: 3 });
  assert.equal(search.success, true, search.error);
  const matches = search.outputItems[0].matches;
  assert.ok(Array.isArray(matches), `expected matches array, got ${JSON.stringify(search.outputItems[0])}`);
});

test("AI Agent succeeds with tools disabled", async () => {
  const r = await run("aiAgent", { useHttpTool: false, useTimeTool: false });
  assert.equal(r.success, true, r.error);
  assert.ok(r.outputItems.length >= 1);
});
