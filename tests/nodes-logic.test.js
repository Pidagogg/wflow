// ============================================================================
// Logic nodes — edge cases, dropdown options, every branch, and data flow.
//
// Run: node --test tests/nodes-logic.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { NODES, executeNode, executeWorkflow, configFor, installFetch, restoreFetch, ensureFixtures, cleanupFixtures } from "./helpers/node-harness.js";
import { typesIn, registerEdgeCaseSweeps, registerEnumSweep, mkNode, loneWorkflow, assertClassified, INPUT } from "./helpers/node-scenarios.js";

const TYPES = typesIn("logic");

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

registerEdgeCaseSweeps("logic", TYPES);
registerEnumSweep("logic", TYPES);

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------
const chain = (nodes, edges) => ({ id: "wf-branch", name: "branch", nodes, edges });
const feedNode = (payload) => ({
  id: "feed",
  type: "manual",
  position: { x: -300, y: 0 },
  data: { label: "Feed", config: { manualOutput: true, manualOutputJson: JSON.stringify(payload) } },
});
const sinkNode = (id) => ({ id, type: "log", position: { x: 200, y: 0 }, data: { label: id, config: { message: "{{name}}" } } });
const edge = (source, target, sourceHandle) => ({ id: `${source}-${target}`, source, target, sourceHandle, targetHandle: "in" });

// ---------------------------------------------------------------------------
// Branching
// ---------------------------------------------------------------------------
test("IF routes to true and false handles (and leaves the empty branch unrun)", async () => {
  const ifConfig = configFor("if", { valueA: "{{status}}", operator: "equals", valueB: "success" });

  const passWf = chain(
    [feedNode({ status: "success", name: "Ada" }), mkNode("if", ifConfig), sinkNode("yes"), sinkNode("no")],
    [edge("feed", "n1", "out"), edge("n1", "yes", "true"), edge("n1", "no", "false")]
  );
  const pass = await executeWorkflow(passWf, { maxItemsPerNode: 10 });
  assert.equal(pass.log.find((l) => l.nodeId === "yes")?.status, "success");
  assert.ok(!pass.log.some((l) => l.nodeId === "no"), "the untaken false branch must not run");

  const failWf = chain(
    [feedNode({ status: "failed", name: "Ada" }), mkNode("if", ifConfig), sinkNode("yes"), sinkNode("no")],
    [edge("feed", "n1", "out"), edge("n1", "yes", "true"), edge("n1", "no", "false")]
  );
  const fail = await executeWorkflow(failWf, { maxItemsPerNode: 10 });
  assert.equal(fail.log.find((l) => l.nodeId === "no")?.status, "success");
});

test("IF supports every operator in its dropdown", async () => {
  const opField = NODES.if.fields.find((f) => f.key === "operator");
  assert.ok(opField, "IF still exposes an operator field");
  for (const op of opField.options) {
    const value = op && typeof op === "object" ? op.value : op;
    const config = configFor("if", { valueA: "{{amount}}", operator: value, valueB: "3", caseSensitive: false });
    const r = await executeNode(loneWorkflow("if", mkNode("if", config)), "n1", INPUT);
    assertClassified("if", r, `operator=${value}`);
    assert.equal(typeof r.outputItems.length, "number");
  }
});

test("Switch routes to the matching case and the default, with empty branches left unrun", async () => {
  const sw = configFor("switch", { value: "{{status}}", matchMode: "equals", caseSensitive: false, cases: [{ key: "success" }, { key: "failed" }] });
  const wf = (status) =>
    chain(
      [feedNode({ status, name: "Ada" }), mkNode("switch", sw), sinkNode("c0"), sinkNode("c1"), sinkNode("def")],
      [edge("feed", "n1", "out"), edge("n1", "c0", "case-0"), edge("n1", "c1", "case-1"), edge("n1", "def", "default")]
    );
  const match = await executeWorkflow(wf("failed"), { maxItemsPerNode: 10 });
  assert.equal(match.log.find((l) => l.nodeId === "c1")?.status, "success");
  assert.ok(!match.log.some((l) => l.nodeId === "c0"));

  const fallback = await executeWorkflow(wf("nonsense"), { maxItemsPerNode: 10 });
  assert.equal(fallback.log.find((l) => l.nodeId === "def")?.status, "success");
  assert.ok(!fallback.log.some((l) => l.nodeId === "c0" || l.nodeId === "c1"));
});

test("Router sends each item to its rule handle and unmatched items to the fallback", async () => {
  const rules = [
    { field: "name", operator: "equals", value: "Ada", label: "Ada" },
    { field: "amount", operator: "gt", value: "2", label: "Big spenders" },
  ];
  const config = configFor("router", { rules, caseSensitive: false });
  const wf = chain(
    [feedNode({ name: "Ada", amount: 1 }), mkNode("router", config), sinkNode("r0"), sinkNode("r1"), sinkNode("fb")],
    [edge("feed", "n1", "out"), edge("n1", "r0", "case-0"), edge("n1", "r1", "case-1"), edge("n1", "fb", "fallback")]
  );
  const res = await executeWorkflow(wf, { maxItemsPerNode: 10 });
  assert.equal(res.log.find((l) => l.nodeId === "r0")?.status, "success", "the first matching rule wins");
  assert.ok(!res.log.some((l) => l.nodeId === "r1"), "later rules stay empty when an earlier one matched");
});

test("Router accepts a {{template}} rule field as well as a plain path", async () => {
  // Regression guard: the node used to treat `field` only as a template, so the
  // documented plain-path form never matched. Both must now work.
  for (const field of ["name", "{{name}}"]) {
    const config = configFor("router", { rules: [{ field, operator: "equals", value: "Ada" }], caseSensitive: false });
    const r = await executeNode(loneWorkflow("router", mkNode("router", config)), "n1", INPUT);
    assert.equal(r.success, true, `field=${field}: ${r.error}`);
    assert.equal(r.outputItems[0].name, "Ada");
  }
});

test("Router rejects an invalid rule regex with a classified error", async () => {
  const config = configFor("router", { rules: [{ field: "name", operator: "regex", value: "([unclosed" }], caseSensitive: false });
  const r = await executeNode(loneWorkflow("router", mkNode("router", config)), "n1", INPUT);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.INVALID_REGEX.code);
});

test("Stop and Error halts the run with the user's message", async () => {
  const config = configFor("stopError", { message: "Rejected: {{name}}" });
  const wf = chain([feedNode({ name: "Ada" }), mkNode("stopError", config), sinkNode("after")], [edge("feed", "n1", "out"), edge("n1", "after", "out")]);
  const res = await executeWorkflow(wf, { maxItemsPerNode: 10 });
  const entry = res.log.find((l) => l.nodeId === "n1");
  assert.ok(entry?.error, "the halt is recorded as a node error");
  assert.match(String(entry.error), /Rejected: Ada/);
  assert.ok(!res.log.some((l) => l.nodeId === "after"), "nothing downstream runs");
});

test("a halted run is not reported as successful", async () => {
  const wf = chain([feedNode({ name: "Ada" }), mkNode("stopError", configFor("stopError", { message: "halt" })), sinkNode("after")], [edge("feed", "n1", "out"), edge("n1", "after", "out")]);
  const res = await executeWorkflow(wf, { maxItemsPerNode: 10 });
  assert.notEqual(res.status, "success");
  assert.ok(!res.log.some((l) => l.nodeId === "after"));
});

// ---------------------------------------------------------------------------
// Error handling for JS logic nodes (must throw, not soft-fail)
// ---------------------------------------------------------------------------
test("JS Transform throws CODE_ERROR on broken user code instead of soft-failing", async () => {
  const config = configFor("jsTransform", { code: "throw new Error('boom');" });
  const r = await executeNode(loneWorkflow("jsTransform", mkNode("jsTransform", config)), "n1", INPUT);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.CODE_ERROR.code, r.error);
  assert.match(String(r.error), /boom/);
});

test("JS Transform still succeeds on valid user code", async () => {
  const config = configFor("jsTransform", { code: "item.upper = String(item.name).toUpperCase(); return item;" });
  const r = await executeNode(loneWorkflow("jsTransform", mkNode("jsTransform", config)), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  assert.equal(r.outputItems[0].upper, "ADA");
});

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------
test("values flow through a 3-node chain and reach the last node", async () => {
  const mid1 = { ...mkNode("stringTransform", configFor("stringTransform", { field: "name", operation: "upper" })), id: "upper" };
  const mid2 = { ...mkNode("set", configFor("set", { mode: "set", parseValues: false, fields: [{ key: "greeting", value: "Hello {{name}}!" }] })), id: "greet" };
  const wf = chain(
    [feedNode({ name: "Ada", status: "success" }), mid1, mid2, sinkNode("last")],
    [edge("feed", "upper", "out"), edge("upper", "greet", "out"), edge("greet", "last", "out")]
  );
  const res = await executeWorkflow(wf, { maxItemsPerNode: 10 });
  assert.equal(res.log.find((l) => l.nodeId === "upper")?.status, "success");
  assert.equal(res.log.find((l) => l.nodeId === "greet")?.status, "success");
  const last = res.log.find((l) => l.nodeId === "last");
  assert.equal(last?.status, "success");
  assert.equal(last.outputItems[0].greeting, "Hello ADA!", "the rendered value reached the final node");
});

// ---------------------------------------------------------------------------
// Start nodes — a node left lying on the canvas (not wired to the workflow)
// must not run.
// ---------------------------------------------------------------------------
test("with a trigger, nodes not connected to it never execute", async () => {
  const wf = chain(
    [
      feedNode({ name: "Ada" }),
      sinkNode("wired"),
      sinkNode("stray"), // no edges at all
      sinkNode("orphanHead"), // its own little chain, not reachable from the trigger
      sinkNode("orphanTail"),
    ],
    [edge("feed", "wired", "out"), edge("orphanHead", "orphanTail", "out")]
  );
  const res = await executeWorkflow(wf, { maxItemsPerNode: 10 });
  const ran = res.log.map((l) => l.nodeId);
  assert.ok(ran.includes("feed") && ran.includes("wired"), `the wired path runs: ${ran}`);
  for (const id of ["stray", "orphanHead", "orphanTail"]) assert.ok(!ran.includes(id), `${id} must not run: ${ran}`);
});

test("without a trigger, a chain still starts from its first node but a stray node does not", async () => {
  const wf = chain(
    [sinkNode("head"), sinkNode("tail"), sinkNode("stray")],
    [edge("head", "tail", "out")]
  );
  const res = await executeWorkflow(wf, { maxItemsPerNode: 10 });
  const ran = res.log.map((l) => l.nodeId);
  assert.ok(ran.includes("head") && ran.includes("tail"), `the chain runs: ${ran}`);
  assert.ok(!ran.includes("stray"), `the unconnected node must not run: ${ran}`);
});

test("a one-node workflow still runs its node", async () => {
  const res = await executeWorkflow(chain([sinkNode("only")], []), { maxItemsPerNode: 10 });
  assert.deepEqual(res.log.map((l) => l.nodeId), ["only"]);
});
