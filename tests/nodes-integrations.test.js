// ============================================================================
// More Integrations nodes — service descriptors that run through the shared
// request engine (server/service-exec.js). Edge cases, dropdown options and
// the credential refusal contract.
//
// Run: node --test tests/nodes-integrations.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { NODES, executeNode, deepClone, installFetch, restoreFetch, ensureFixtures, cleanupFixtures } from "./helpers/node-harness.js";
import { typesIn, registerEdgeCaseSweeps, registerEnumSweep, mkNode, loneWorkflow, INPUT } from "./helpers/node-scenarios.js";

const TYPES = typesIn("integrations");

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

registerEdgeCaseSweeps("integrations", TYPES);
registerEnumSweep("integrations", TYPES);

test("the More Integrations group exists and every node uses the service engine", () => {
  assert.ok(TYPES.length >= 20, `expected at least 20 integrations, got ${TYPES.length}`);
  for (const type of TYPES) assert.ok(NODES[type].service, `${type} has a service descriptor`);
});

test("integrations refuse to call the API without credentials (before any network I/O)", { timeout: 120000 }, async () => {
  const failures = [];
  for (const type of TYPES) {
    const def = NODES[type];
    if (def.service.auth === "none") continue;
    const r = await executeNode(loneWorkflow(type, mkNode(type, deepClone(def.defaults || {}))), "n1", INPUT);
    if (r.success) failures.push(`${type}: succeeded with empty credentials (expected MISSING_CONFIG)`);
    else if (r.errorCode !== ERROR_CODES.MISSING_CONFIG.code) failures.push(`${type}: error code ${r.errorCode} — ${r.error}`);
  }
  assert.deepEqual(failures, []);
});

test("query presets are valid JSON", () => {
  for (const type of TYPES) {
    const q = NODES[type].defaults.query;
    if (q) assert.doesNotThrow(() => JSON.parse(q), `${type} query default parses`);
  }
});
