// ============================================================================
// Merging an imported workflow into the workflow on the canvas.
//
// Dropping (or picking) a workflow JSON on a canvas that already has nodes must
// never destroy the current workflow: the host graph stays byte for byte and
// the imported nodes are appended next to it, with their own settings and
// connections, re-identified so nothing collides.
//
// Run: node --test tests/workflow-merge.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";

const { mergeWorkflows, MERGE_GAP_X } = await import("../shared/workflow-merge.js");

function node(id, type, x, y, config = {}, label = type) {
  return { id, type, position: { x, y }, data: { label, config } };
}

const HOST = {
  nodes: [node("n-host1", "webhook", 80, 160, { method: "POST" }, "Webhook"), node("n-host2", "slackSend", 400, 160, { channel: "#ops" }, "Slack")],
  edges: [{ id: "e-host", source: "n-host1", target: "n-host2", sourceHandle: "out", targetHandle: "in" }],
};

const INCOMING = {
  name: "Digest",
  nodes: [node("n-1", "schedule", 0, 0, { cron: "0 9 * * *" }, "Every day"), node("n-2", "http", 300, 0, { url: "https://example.com" }, "Fetch")],
  edges: [{ id: "e-1", source: "n-1", target: "n-2", sourceHandle: "out", targetHandle: "in" }],
};

test("a merge appends the imported graph and never touches the host graph", () => {
  const before = JSON.parse(JSON.stringify(HOST));
  const merged = mergeWorkflows(HOST, INCOMING);

  // The host's nodes and edges are exactly as they were (same objects, untouched).
  assert.deepEqual(HOST, before);
  assert.equal(merged.stats.nodes, 2);
  assert.equal(merged.stats.edges, 1);

  // Only the imported side comes back, and it carries no host node.
  const hostIds = new Set(HOST.nodes.map((n) => n.id));
  for (const n of merged.nodes) assert.ok(!hostIds.has(n.id), `imported id ${n.id} must be fresh`);
  assert.deepEqual(merged.nodes.map((n) => n.type).sort(), ["http", "schedule"]);
});

test("a merge keeps the imported node settings, labels and internal layout", () => {
  const merged = mergeWorkflows(HOST, INCOMING);
  const schedule = merged.nodes.find((n) => n.type === "schedule");
  const http = merged.nodes.find((n) => n.type === "http");
  assert.equal(schedule.data.label, "Every day");
  assert.deepEqual(schedule.data.config, { cron: "0 9 * * *" });
  assert.deepEqual(http.data.config, { url: "https://example.com" });

  // Same relative position (30 px apart in x), same row.
  assert.equal(http.position.x - schedule.position.x, 300);
  assert.equal(http.position.y, schedule.position.y);
});

test("a merge places the imported graph to the RIGHT of the host graph", () => {
  const merged = mergeWorkflows(HOST, INCOMING);
  const hostRight = Math.max(...HOST.nodes.map((n) => n.position.x));
  const importedLeft = Math.min(...merged.nodes.map((n) => n.position.x));
  assert.equal(importedLeft, hostRight + MERGE_GAP_X);
  // Top-aligned with the host graph.
  assert.equal(Math.min(...merged.nodes.map((n) => n.position.y)), Math.min(...HOST.nodes.map((n) => n.position.y)));
});

test("a merge onto an EMPTY canvas keeps the imported layout where it is", () => {
  const merged = mergeWorkflows({ nodes: [], edges: [] }, INCOMING);
  assert.equal(merged.nodes[0].position.x, 0);
  assert.equal(merged.nodes[0].position.y, 0);
});

test("imported edges are re-pointed at the new ids", () => {
  const merged = mergeWorkflows(HOST, INCOMING);
  assert.equal(merged.edges.length, 1);
  const edge = merged.edges[0];
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert.ok(ids.has(edge.source));
  assert.ok(ids.has(edge.target));
  assert.equal(edge.source, merged.nodes.find((n) => n.type === "schedule").id);
  assert.equal(edge.target, merged.nodes.find((n) => n.type === "http").id);
  assert.notEqual(edge.id, "e-1"); // fresh id, the host may already use it
  assert.equal(edge.sourceHandle, "out");
});

test("a merge survives an imported file that reuses the host's own ids", () => {
  const clashing = {
    nodes: [node("n-host1", "manual", 0, 0, {}, "Copy of your webhook"), node("n-host2", "noop", 300, 0, {}, "Copy")],
    edges: [{ id: "e-host", source: "n-host1", target: "n-host2" }],
  };
  const merged = mergeWorkflows(HOST, clashing);
  const all = [...HOST.nodes, ...merged.nodes].map((n) => n.id);
  assert.equal(new Set(all).size, all.length, "every id in the merged workflow is unique");
  assert.equal(merged.edges.length, 1);
  assert.equal(merged.edges[0].id === "e-host", false, "the edge id is fresh too");
});

test("duplicate ids inside the imported file still yield distinct nodes", () => {
  const broken = {
    nodes: [node("same", "noop", 0, 0), node("same", "log", 300, 0)],
    edges: [],
  };
  const merged = mergeWorkflows(HOST, broken);
  assert.equal(merged.nodes.length, 2);
  assert.notEqual(merged.nodes[0].id, merged.nodes[1].id);
});

test("edges pointing at a node the file does not contain are dropped", () => {
  const merged = mergeWorkflows(HOST, {
    nodes: [node("a", "manual", 0, 0)],
    edges: [
      { id: "e1", source: "a", target: "ghost" },
      { id: "e2", source: "ghost", target: "a" },
      { id: "e3", source: "a", target: "a" },
    ],
  });
  assert.equal(merged.nodes.length, 1);
  assert.equal(merged.edges.length, 0);
});

test("merging a file without nodes is refused", () => {
  assert.throws(() => mergeWorkflows(HOST, { nodes: [] }), /no nodes/i);
  assert.throws(() => mergeWorkflows(HOST, {}), /no nodes/i);
});
