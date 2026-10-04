// ============================================================================
// Catalog-wide executor contract: every registered node type must dispatch.
//
// Run: node --test tests/nodes-executor-contract.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { buildWorkflow, configFor, executeNode, installFetch, restoreFetch, ensureFixtures, cleanupFixtures, RICH_PAYLOAD, nodeTypes } from "./helpers/node-harness.js";
import { mkNode, loneWorkflow, withCreds, INPUT, assertClassified } from "./helpers/node-scenarios.js";

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

test("no catalog node is dispatched off the end of the executor", { timeout: 120000 }, async () => {
  const failures = [];
  for (const type of nodeTypes) {
    const r = await executeNode(loneWorkflow(type, mkNode(type, withCreds(type, configFor(type)))), "n1", INPUT);
    if (/Unsupported node type/i.test(String(r.error || ""))) failures.push(type);
  }
  assert.deepEqual(failures, [], "catalog entries the executor cannot dispatch");
});

test("every catalog node produces a classified result with a rich payload", { timeout: 180000 }, async () => {
  const failures = [];
  for (const type of nodeTypes) {
    const r = await executeNode(loneWorkflow(type, mkNode(type, withCreds(type, configFor(type)))), "n1", INPUT);
    try {
      assertClassified(type, r, "rich payload");
    } catch (err) {
      failures.push(`${type}: ${err.message.split("\n")[0]}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("harness sanity — buildWorkflow wires a manual feed into the target", () => {
  const wf = buildWorkflow("set", configFor("set"));
  assert.equal(wf.nodes.length, 2);
  assert.equal(wf.edges.length, 1);
  assert.equal(wf.nodes[0].data.config.manualOutputJson, JSON.stringify(RICH_PAYLOAD));
});
