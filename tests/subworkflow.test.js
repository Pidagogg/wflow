// ============================================================================
// Execute Sub-Workflow node — calling one of your own saved workflows from
// another workflow. The caller's items arrive at the sub-workflow's entry
// points; the outputs of its end nodes come back as the result.
//
// Run: node --test tests/subworkflow.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-subflow-"));
process.env.BF_DATA_DIR = path.join(tempDir, "data");
process.env.BF_DB_PATH = path.join(tempDir, "data", "admin.db");
fs.mkdirSync(process.env.BF_DATA_DIR, { recursive: true });

const { workflows, agents } = await import("../server/store.js");
const { executeWorkflow } = await import("../server/executor.js");
const { closeDb } = await import("../server/dbx.js");

const OWNER = "u-subflow-owner";

function wf(id, name, nodes, edges) {
  return { id, name, ownerId: OWNER, nodes, edges };
}

const manualPort = (id, label = "Input") => ({
  id,
  type: "manual",
  data: { label, config: {} },
});

const feed = (manualJson) => ({
  id: "feed",
  type: "manual",
  data: { label: "Feed", config: { manualOutput: true, manualOutputJson: JSON.stringify(manualJson) } },
});

after(() => {
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows may keep the DB file locked — best effort */
  }
});

test("sub-workflow returns its end node's output to the caller", async () => {
  // sub-workflow: [manual port] -> [Set: add seen:"yes"]  (leaf = Set)
  const sub = wf(
    "wf-sub-basic",
    "Basic sub",
    [
      manualPort("s-in"),
      { id: "s-set", type: "set", data: { label: "Enrich", config: { fields: [{ key: "seen", value: "yes" }] } } },
    ],
    [{ id: "e1", source: "s-in", target: "s-set" }]
  );
  await workflows.save(sub);

  // outer workflow: feed {a:1} -> Execute Sub-Workflow -> (nothing after)
  const outer = {
    id: "wf-outer-basic",
    name: "Outer",
    ownerId: OWNER,
    nodes: [
      feed({ a: 1 }),
      { id: "n-sub", type: "subworkflow", data: { label: "Call basic sub", config: { workflowId: "wf-sub-basic", storeIn: "result" } } },
    ],
    edges: [{ id: "e1", source: "feed", target: "n-sub" }],
  };
  const res = await executeWorkflow(outer, { userId: OWNER, maxItemsPerNode: 20 });
  assert.equal(res.success, true, JSON.stringify(res.log?.map((l) => ({ n: l.nodeName, s: l.status, e: l.error }))));
  const entry = res.log.find((l) => l.nodeId === "n-sub");
  assert.equal(entry.status, "success");
  const json = entry.outputItems[0];
  assert.equal(json.a, 1, "caller fields pass through");
  assert.equal(json.subflow.success, true);
  assert.equal(json.subflow.workflowName, "Basic sub");
  assert.deepEqual(json.result, { a: 1, seen: "yes" }, "single end-node output arrives directly");
});

test("multiple end nodes return an { outputs } array", async () => {
  // sub-workflow with two independent chains: [manual port] -> [A] and [B]
  const sub = wf(
    "wf-sub-multi",
    "Multi sub",
    [
      manualPort("s-a"),
      manualPort("s-b"),
      { id: "s-setA", type: "set", data: { label: "A", config: { fields: [{ key: "from", value: "A" }] } } },
      { id: "s-setB", type: "set", data: { label: "B", config: { fields: [{ key: "from", value: "B" }] } } },
    ],
    [
      { id: "e1", source: "s-a", target: "s-setA" },
      { id: "e2", source: "s-b", target: "s-setB" },
    ]
  );
  await workflows.save(sub);

  const outer = {
    id: "wf-outer-multi",
    name: "Outer multi",
    ownerId: OWNER,
    nodes: [
      feed({ x: 9 }),
      { id: "n-sub", type: "subworkflow", data: { label: "Call multi", config: { workflowId: "wf-sub-multi" } } },
    ],
    edges: [{ id: "e1", source: "feed", target: "n-sub" }],
  };
  const res = await executeWorkflow(outer, { userId: OWNER, maxItemsPerNode: 20 });
  assert.equal(res.success, true);
  const json = res.log.find((l) => l.nodeId === "n-sub").outputItems[0];
  assert.equal(json.subflow.outputCount, 2);
  assert.deepEqual(
    json.result.outputs.map((o) => o.from).sort(),
    ["A", "B"],
    "several end nodes return { outputs: [...] }"
  );
});

test("errors inside the sub-workflow fail the calling node with a clear message", async () => {
  const sub = wf(
    "wf-sub-broken",
    "Broken sub",
    [
      manualPort("s-in"),
      // Code node that throws on purpose
      {
        id: "s-code",
        type: "code",
        data: { label: "Boom", config: { code: "throw new Error('boom in sub');" } },
      },
    ],
    [{ id: "e1", source: "s-in", target: "s-code" }]
  );
  await workflows.save(sub);

  const outer = {
    id: "wf-outer-broken",
    name: "Outer broken",
    ownerId: OWNER,
    nodes: [
      feed({ q: 1 }),
      { id: "n-sub", type: "subworkflow", data: { label: "Call broken", config: { workflowId: "wf-sub-broken" } } },
    ],
    edges: [{ id: "e1", source: "feed", target: "n-sub" }],
  };
  const res = await executeWorkflow(outer, { userId: OWNER, maxItemsPerNode: 20 });
  const entry = res.log.find((l) => l.nodeId === "n-sub");
  assert.equal(entry.status, "error");
  assert.match(entry.error || "", /Broken sub.*boom in sub/, "the caller learns which sub-workflow and node failed");
});

test("self-reference and unknown targets are safe soft errors", async () => {
  const outer = {
    id: "wf-self",
    name: "Self caller",
    ownerId: OWNER,
    nodes: [
      feed({ z: 1 }),
      { id: "n-self", type: "subworkflow", data: { label: "Call self", config: { workflowId: "wf-self" } } },
      { id: "n-missing", type: "subworkflow", data: { label: "Call missing", config: { workflowId: "wf-nope" } } },
    ],
    edges: [
      { id: "e1", source: "feed", target: "n-self" },
      { id: "e2", source: "feed", target: "n-missing" },
    ],
  };
  const res = await executeWorkflow(outer, { userId: OWNER, maxItemsPerNode: 20 });
  assert.equal(res.success, true, "soft errors must not crash the outer run");
  const self = res.log.find((l) => l.nodeId === "n-self").outputItems[0];
  assert.match(self.error, /cannot call itself/);
  const missing = res.log.find((l) => l.nodeId === "n-missing").outputItems[0];
  assert.match(missing.error, /not found|another account/);
});

test("an empty selection is reported instead of crashing", async () => {
  const outer = {
    id: "wf-empty",
    name: "Empty caller",
    ownerId: OWNER,
    nodes: [
      feed({ z: 2 }),
      { id: "n-none", type: "subworkflow", data: { label: "No pick", config: { workflowId: "" } } },
    ],
    edges: [{ id: "e1", source: "feed", target: "n-none" }],
  };
  const res = await executeWorkflow(outer, { userId: OWNER, maxItemsPerNode: 20 });
  assert.equal(res.success, true);
  const json = res.log.find((l) => l.nodeId === "n-none").outputItems[0];
  assert.match(json.error, /no workflow selected/);
});

test("a custom storeIn key receives the result instead of the default", async () => {
  const outer = {
    id: "wf-outer-storein",
    name: "Outer storeIn",
    ownerId: OWNER,
    nodes: [
      feed({ k: "v" }),
      {
        id: "n-sub",
        type: "subworkflow",
        data: { label: "Call basic sub", config: { workflowId: "wf-sub-basic", storeIn: "outcome" } },
      },
    ],
    edges: [{ id: "e1", source: "feed", target: "n-sub" }],
  };
  const res = await executeWorkflow(outer, { userId: OWNER, maxItemsPerNode: 20 });
  assert.equal(res.success, true);
  const json = res.log.find((l) => l.nodeId === "n-sub").outputItems[0];
  assert.equal(json.outcome.seen, "yes", "result lands under the custom key");
  assert.equal(json.result, undefined, "the default key is not also set");
  assert.equal(json.subflow.workflowName, "Basic sub");
});

test("two workflows calling each other are bounded by the nesting cap", async () => {
  // wf-sub-loop-a → wf-sub-loop-b → wf-sub-loop-a → … would recurse forever
  // without the depth guard. Each level just passes the item through a Set
  // node, so an unbounded run would never finish (or explode the stack).
  const callerNode = (label, workflowId, outNodeId) => ({
    id: "call",
    type: "subworkflow",
    data: { label, config: { workflowId } },
  });
  const passThrough = (id, from) => ({
    id,
    type: "set",
    data: { label: "Pass through", config: { fields: [{ key: "hops", value: "{{hops + 1}}" }] } },
  });

  await workflows.save(
    wf(
      "wf-sub-loop-a",
      "Loop A",
      [manualPort("a-in"), passThrough("a-set", "a-in"), callerNode("Call B", "wf-sub-loop-b", "a-set")],
      [
        { id: "e1", source: "a-in", target: "a-set" },
        { id: "e2", source: "a-set", target: "call" },
      ]
    )
  );
  await workflows.save(
    wf(
      "wf-sub-loop-b",
      "Loop B",
      [manualPort("b-in"), passThrough("b-set", "b-in"), callerNode("Call A", "wf-sub-loop-a", "b-set")],
      [
        { id: "e1", source: "b-in", target: "b-set" },
        { id: "e2", source: "b-set", target: "call" },
      ]
    )
  );

  const outer = {
    id: "wf-outer-loop",
    name: "Outer loop",
    ownerId: OWNER,
    nodes: [feed({ hops: 0 }), { id: "n-sub", type: "subworkflow", data: { label: "Call A", config: { workflowId: "wf-sub-loop-a" } } }],
    edges: [{ id: "e1", source: "feed", target: "n-sub" }],
  };
  // If the depth cap regressed this would recurse until the process died — the
  // test completing at all is the assertion; we additionally require a sane
  // result so a silent short-circuit can't hide either.
  const res = await executeWorkflow(outer, { userId: OWNER, maxItemsPerNode: 20 });
  assert.equal(res.success, true, "mutual recursion is stopped, not fatal");
  const entry = res.log.find((l) => l.nodeId === "n-sub");
  assert.equal(entry.status, "success");
  const json = entry.outputItems[0];
  assert.equal(json.subflow.success, true);
  assert.ok(Number.isFinite(json.subflow.durationMs), "the bounded chain finishes");
});

// keep agents imported to mirror app startup (store facade parity)
void agents;
