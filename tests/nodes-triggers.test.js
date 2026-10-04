// ============================================================================
// Trigger nodes — edge cases, dropdown options and real-event passthrough.
//
// Run: node --test tests/nodes-triggers.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { NODES, executeNode, configFor, installFetch, restoreFetch, ensureFixtures, cleanupFixtures } from "./helpers/node-harness.js";
import { typesIn, registerEdgeCaseSweeps, registerEnumSweep, mkNode, loneWorkflow } from "./helpers/node-scenarios.js";

const TYPES = typesIn("triggers");

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

registerEdgeCaseSweeps("triggers", TYPES);
registerEnumSweep("triggers", TYPES);

test("live-capable triggers pass the real inbound event through", async () => {
  const cases = [
    { type: "webhook", ctx: { webhookPayload: { marker: "WEBHOOK-EVENT" } }, find: (o) => JSON.stringify(o).includes("WEBHOOK-EVENT") },
    { type: "githubTrigger", ctx: { webhookPayload: { marker: "GITHUB-EVENT" } }, find: (o) => JSON.stringify(o).includes("GITHUB-EVENT") },
    { type: "telegramTrigger", ctx: { triggerPayload: { marker: "TELEGRAM-EVENT" } }, find: (o) => JSON.stringify(o).includes("TELEGRAM-EVENT") },
    { type: "chatTrigger", ctx: { triggerPayload: { message: "CHAT-EVENT" } }, find: (o) => JSON.stringify(o).includes("CHAT-EVENT") },
    { type: "schedule", ctx: { triggerPayload: { marker: "CRON-EVENT" } }, find: (o) => JSON.stringify(o).includes("CRON-EVENT") },
    { type: "rssTrigger", ctx: { triggerPayload: { items: [{ title: "RSS-EVENT" }], feed: "http://localhost/feed.xml" } }, find: (o) => JSON.stringify(o).includes("RSS-EVENT") },
    { type: "executeWorkflowTrigger", ctx: { triggerPayload: { marker: "SUBFLOW-EVENT" } }, find: (o) => JSON.stringify(o).includes("SUBFLOW-EVENT") },
  ];
  const failures = [];
  for (const { type, ctx, find } of cases) {
    const config = configFor(type);
    const r = await executeNode(loneWorkflow(type, mkNode(type, config)), "n1", [], ctx);
    if (!r.success) failures.push(`${type}: ${r.error}`);
    else if (!r.outputItems.some(find)) failures.push(`${type}: inbound event not present in output ${JSON.stringify(r.outputItems)}`);
  }
  assert.deepEqual(failures, []);
});

test("every trigger emits a non-empty payload on a plain run (never an empty workflow)", { timeout: 60000 }, async () => {
  const failures = [];
  for (const type of TYPES) {
    const r = await executeNode(loneWorkflow(type, mkNode(type, configFor(type))), "n1", []);
    if (!r.success) failures.push(`${type}: ${r.error}`);
    else if (!r.outputItems.length) failures.push(`${type}: produced no items`);
    else if (!r.outputItems[0] || Object.keys(r.outputItems[0]).length === 0) failures.push(`${type}: produced an empty object`);
  }
  assert.deepEqual(failures, []);
});

test("service triggers declare the sample-only note so the UI can tell the truth", () => {
  // A trigger that cannot ingest live events must say so in its config.
  // Live-capable ones (webhook / schedule / RSS / GitHub / Telegram / chat)
  // are excluded — their real paths are covered above.
  const live = new Set(["manual", "webhook", "schedule", "rssTrigger", "githubTrigger", "telegramTrigger", "chatTrigger", "errorTrigger", "formTrigger", "executeWorkflowTrigger"]);
  const missing = [];
  for (const type of TYPES) {
    if (live.has(type)) continue;
    const fields = NODES[type].fields || [];
    if (!fields.some((f) => f.key === "sampleInfo" && f.type === "note")) missing.push(type);
  }
  assert.deepEqual(missing, [], "sample-only triggers must carry the sampleInfo note field");
});
