// ============================================================================
// The reliability + visibility layer added from docs/workflow-builders.md:
//
//   1. per-node error handling (stop / continue / retry) on EVERY node,
//   2. the Error Trigger made real (account-wide error workflows),
//   3. AI token usage + cost accounting (per node, per run, editable prices),
//   4. the Wait for Approval node (human-in-the-loop),
//   5. starter templates that must actually run.
//
// Run: node --test tests/workflow-features.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NODES, isTriggerType, defaultOnErrorFor, DEFAULT_ON_ERROR } from "../shared/catalog.js";
import { ERROR_CODES, errorCatalog } from "../shared/errors.js";
import { TEMPLATES, TEMPLATE_CATEGORIES, templateSummaries, getTemplate } from "../shared/templates.js";

// BF_DB_PATH must be set before any module that opens the database is loaded.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-features-"));
process.env.BF_DB_PATH = path.join(tempDir, "features.db");

const { executeWorkflow } = await import("../server/executor.js");
const { priceForModel, costOfUsage, estimateRunCost, getPriceSettings, savePriceSettings, PRESET_PRICES } = await import("../server/ai-cost.js");
const { beginApproval, approvalStatus, resolveApproval, endApprovals } = await import("../server/approvals.js");
const { buildErrorPayload, triggerErrorWorkflows, ERROR_SOURCE } = await import("../server/error-workflows.js");
const { workflows } = await import("../server/store.js");

// ---------------------------------------------------------------------------
// fetch stub helpers
// ---------------------------------------------------------------------------
function makeResponse(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {
      entries: () => Object.entries({ "content-type": "application/json" }),
      get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null),
      getSetCookie: () => [],
    },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(makeResponse({ ok: true }));
});

// ---------------------------------------------------------------------------
// workflow builders
// ---------------------------------------------------------------------------
const FEED = { name: "Ada", email: "ada@example.com", message: "hello" };

function feedNode() {
  return {
    id: "feed",
    type: "manual",
    position: { x: -400, y: 0 },
    data: { label: "Feed", config: { manualOutput: true, manualOutputJson: JSON.stringify(FEED) } },
  };
}

function node(id, type, config, label) {
  return { id, type, position: { x: 0, y: 0 }, data: { label: label || type, config } };
}

function edge(source, target, sourceHandle = "out") {
  return { id: `${source}-${target}`, source, target, sourceHandle, targetHandle: "in" };
}

function wf(nodes, edges) {
  return { id: "wf-test", name: "Test", nodes, edges };
}

// ---------------------------------------------------------------------------
// 1. Per-node error handling — fields + defaults on every runnable node
// ---------------------------------------------------------------------------
test("every runnable node exposes an on-error setting with a safe default", () => {
  const runnable = Object.entries(NODES).filter(([type]) => type !== "stickyNote");
  assert.ok(runnable.length > 150, "expected the whole catalog");
  for (const [type, def] of runnable) {
    assert.ok(Array.isArray(def.fields), `${type} has fields`);
    assert.ok(def.fields.some((f) => f.key === "onError"), `${type} has an onError field`);
    assert.ok(def.fields.some((f) => f.key === "retryCount"), `${type} has a retryCount field`);
    assert.ok(
      ["stop", "continue", "retry"].includes(def.defaults?.onError),
      `${type} carries a valid default (got ${def.defaults?.onError})`
    );
  }
  // The annotation node is deliberately excluded — it never runs.
  assert.ok(!(NODES.stickyNote.fields || []).some((f) => f.key === "onError"));
});

test("on-error defaults keep actions alive but halt logic, AI and triggers", () => {
  assert.equal(DEFAULT_ON_ERROR.action, "continue");
  assert.equal(defaultOnErrorFor("http"), "continue");
  assert.equal(defaultOnErrorFor("slackSend"), "continue");
  assert.equal(defaultOnErrorFor("if"), "stop");
  assert.equal(defaultOnErrorFor("aiChat"), "stop");
  assert.equal(defaultOnErrorFor("approval"), "stop");
  assert.equal(defaultOnErrorFor("manual"), "stop");
  assert.equal(defaultOnErrorFor("nonexistent-node"), "stop");
});

test("a failing action node with onError=continue keeps the run alive", async () => {
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.reject(new Error("ECONNREFUSED 127.0.0.1"));
  };
  const result = await executeWorkflow(
    wf(
      [feedNode(), node("n1", "http", { url: "https://api.example.com/data", method: "GET", retries: 0, onError: "continue" }), node("n2", "log", { message: "{{name}}", onError: "stop" })],
      [edge("feed", "n1"), edge("n1", "n2")]
    ),
    { maxItemsPerNode: 10 }
  );

  const entry = result.log.find((l) => l.nodeId === "n1");
  assert.equal(entry.status, "error");
  assert.equal(entry.handled, true, "the failure is marked as handled");
  assert.ok(entry.errorCode, "the failure carries a BF code");
  assert.equal(calls, 1, "one attempt — no retry was requested");

  // The run as a whole still counts as successful, and the error rode on to
  // the next node inside `_error` so a branch can react to it.
  assert.equal(result.success, true);
  assert.equal(result.handledErrors, 1);
  const after = result.log.find((l) => l.nodeId === "n2");
  assert.equal(after.status, "success");
  assert.equal(after.inputItems[0]._error.marker, `BF-${entry.errorCode}`);
  assert.equal(after.inputItems[0]._error.nodeId, "n1");
});

test("a failing node with onError=stop halts the chain", async () => {
  globalThis.fetch = () => Promise.reject(new Error("boom"));
  const result = await executeWorkflow(
    wf(
      [feedNode(), node("n1", "http", { url: "https://api.example.com/data", method: "GET", retries: 0, onError: "stop" }), node("n2", "log", { message: "x", onError: "stop" })],
      [edge("feed", "n1"), edge("n1", "n2")]
    ),
    { maxItemsPerNode: 10 }
  );
  const entry = result.log.find((l) => l.nodeId === "n1");
  assert.equal(entry.status, "error");
  assert.notEqual(entry.handled, true);
  assert.equal(result.success, false);
  assert.equal(result.handledErrors, 0);
  assert.equal(result.log.find((l) => l.nodeId === "n2"), undefined, "downstream never ran");
  assert.equal(result.haltedAt, "n1");
});

test("onError=retry repeats the node and records the attempt count", async () => {
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.reject(new Error("still down"));
  };
  const result = await executeWorkflow(
    wf(
      [feedNode(), node("n1", "http", { url: "https://api.example.com/data", method: "GET", retries: 0, onError: "retry", retryCount: 2, retryDelay: 0 })],
      [edge("feed", "n1")]
    ),
    { maxItemsPerNode: 10 }
  );
  const entry = result.log.find((l) => l.nodeId === "n1");
  assert.equal(calls, 2, "the node was attempted twice");
  assert.equal(entry.attempts, 2);
  assert.equal(entry.status, "error");
  assert.notEqual(entry.handled, true, "retry ends in a stop, not a handled continue");
});

// ---------------------------------------------------------------------------
// 2. AI usage & cost
// ---------------------------------------------------------------------------
test("AI nodes report token usage per node and per run", async () => {
  globalThis.fetch = (urlOrReq) => {
    const u = String(typeof urlOrReq === "string" ? urlOrReq : urlOrReq?.url || "");
    if (u.includes("/chat/completions")) {
      return Promise.resolve(
        makeResponse({ choices: [{ message: { content: "hello there" } }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })
      );
    }
    return Promise.resolve(makeResponse({ ok: true }));
  };

  const result = await executeWorkflow(
    wf(
      [
        feedNode(),
        node(
          "n1",
          "aiChat",
          { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "test-key", model: "gpt-4o-mini", prompt: "{{message}}", onError: "stop" },
          "Ask the model"
        ),
      ],
      [edge("feed", "n1")]
    ),
    { maxItemsPerNode: 10 }
  );

  const entry = result.log.find((l) => l.nodeId === "n1");
  assert.equal(entry.status, "success");
  assert.ok(entry.usage, "the node carries its usage");
  assert.equal(entry.usage.prompt, 120);
  assert.equal(entry.usage.completion, 30);
  assert.equal(entry.usage.total, 150);
  assert.equal(entry.usage.model, "gpt-4o-mini", "the model rides along so it can be priced");

  assert.ok(result.usage, "the run aggregates its usage");
  assert.equal(result.usage.prompt, 120);
  assert.equal(result.usage.completion, 30);
  assert.equal(result.usage.calls, 1);
});

test("priceForModel matches exactly, then by longest prefix, then the fallback", () => {
  const table = {
    prices: { "gpt-4o": { input: 2.5, output: 10 }, "gpt-4o-mini": { input: 0.15, output: 0.6 } },
    fallback: { input: 1, output: 2 },
  };
  assert.deepEqual(priceForModel(table, "gpt-4o-mini"), { input: 0.15, output: 0.6 });
  assert.deepEqual(priceForModel(table, "GPT-4O"), { input: 2.5, output: 10 });
  assert.deepEqual(priceForModel(table, "gpt-4o-mini-2024-07-18"), { input: 0.15, output: 0.6 }, "longest prefix wins");
  assert.deepEqual(priceForModel(table, "some-unknown-model"), { input: 1, output: 2 });
  assert.deepEqual(priceForModel(table, ""), { input: 1, output: 2 });
});

test("costOfUsage prices tokens and reports unpriced models as null", () => {
  const table = { prices: { m: { input: 1, output: 2 } }, fallback: { input: 0, output: 0 } };
  assert.equal(costOfUsage({ prompt: 1_000_000, completion: 500_000, model: "m" }, table), 2);
  assert.equal(costOfUsage({ prompt: 10, completion: 0, model: "unknown" }, table), null, "0/0 means not priced");
  assert.equal(costOfUsage(null, table), null);
});

test("estimateRunCost walks the per-node usage of the run log", () => {
  const table = { prices: { m: { input: 1, output: 1 } }, fallback: { input: 0, output: 0 } };
  const result = { log: [{ usage: { prompt: 1_000_000, completion: 0, model: "m" } }, { usage: { prompt: 0, completion: 1_000_000, model: "m" } }] };
  const est = estimateRunCost(result, table);
  assert.equal(est.priced, true);
  assert.equal(est.calls, 2);
  assert.equal(est.costUsd, 2);
  assert.equal(est.tokens, 2_000_000);
  // A run with only unpriced models is reported as unpriced rather than $0.
  const unpriced = estimateRunCost({ log: [{ usage: { prompt: 5, completion: 5, model: "unknown" } }] }, table);
  assert.equal(unpriced.costUsd, null);
});

test("the price table is per account and preset-filled until it is edited", async () => {
  const saved = await savePriceSettings("user-1", { prices: { "My-Model": { input: 3, output: 6 } }, fallback: { input: 0.5, output: 1 } });
  assert.deepEqual(saved.prices["my-model"], { input: 3, output: 6 }, "model names are normalised to lower case");
  const again = await getPriceSettings("user-1");
  assert.deepEqual(again.prices["my-model"], { input: 3, output: 6 });
  assert.deepEqual(again.fallback, { input: 0.5, output: 1 });
  // Another account keeps the presets — one account's prices never leak.
  const other = await getPriceSettings("user-2");
  assert.deepEqual(other.prices["gpt-4o-mini"], PRESET_PRICES["gpt-4o-mini"]);
  assert.equal(other.prices["my-model"], undefined);
  // Negative / junk values fall back to 0 instead of corrupting a run's cost.
  const junk = await savePriceSettings("user-3", { prices: { weird: { input: -5, output: "x" } } });
  assert.deepEqual(junk.prices.weird, { input: 0, output: 0 });
});

// ---------------------------------------------------------------------------
// 3. Wait for Approval
// ---------------------------------------------------------------------------
test("an approval with no interactive run applies its fallback immediately", async () => {
  const approved = await beginApproval("", { onTimeout: "approve", timeoutMs: 60_000 });
  assert.equal(approved.approved, true);
  assert.equal(approved.unanswered, true);
  const rejected = await beginApproval("", { onTimeout: "reject" });
  assert.equal(rejected.approved, false);
  assert.equal(rejected.action, "reject");
});

test("a pending approval is visible, answerable and then cleared", async () => {
  const token = "run-token-answer";
  const promise = beginApproval(token, { message: "Publish this?", approveLabel: "Publish", rejectLabel: "Discard", timeoutMs: 60_000 });
  const status = approvalStatus(token);
  assert.ok(status, "the pending request is exposed to the run-status poll");
  assert.equal(status.message, "Publish this?");
  assert.equal(status.approveLabel, "Publish");
  assert.equal(status.rejectLabel, "Discard");
  assert.ok(status.expiresAt > Date.now() - 1000);

  assert.equal(resolveApproval(token, status.id, true, "ada@example.com"), true);
  const decision = await promise;
  assert.equal(decision.approved, true);
  assert.equal(decision.by, "ada@example.com");
  assert.equal(decision.timedOut, false);
  assert.equal(approvalStatus(token), null, "the slot is released");
});

test("an approval nobody answers times out into the node's setting", async () => {
  // The approval timer is unref'd (a forgotten run must not hold the process
  // open), so this test keeps the event loop alive for the wait itself — like
  // a real server whose open HTTP request does the same.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const decision = await beginApproval("run-token-timeout", { onTimeout: "reject", timeoutMs: 25 });
    assert.equal(decision.timedOut, true);
    assert.equal(decision.unanswered, true);
    assert.equal(decision.approved, false);
    assert.equal(decision.action, "reject");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a stale approval id cannot answer the pending request", async () => {
  const token = "run-token-stale";
  const promise = beginApproval(token, { timeoutMs: 60_000 });
  assert.equal(resolveApproval(token, "not-the-id", true), false, "a mismatched id is refused");
  assert.ok(approvalStatus(token), "the real request is still pending");
  endApprovals(token);
  const decision = await promise;
  assert.equal(decision.aborted, true, "stopping the run releases the wait");
  assert.equal(approvalStatus(token), null);
});

test("the Wait for Approval node runs end-to-end and routes both outputs", async () => {
  const runWith = (approved) =>
    executeWorkflow(
      wf(
        [
          feedNode(),
          node("n1", "approval", { message: "Publish {{name}}?", timeoutMinutes: 5, onTimeout: "fail", onError: "stop" }, "Ask a human"),
          node("ok", "log", { message: "approved", onError: "stop" }, "Approved"),
          node("no", "log", { message: "rejected", onError: "stop" }, "Rejected"),
        ],
        [edge("feed", "n1"), edge("n1", "ok", "approved"), edge("n1", "no", "rejected")]
      ),
      {
        maxItemsPerNode: 10,
        approval: { request: async () => ({ approved, by: "ada@example.com" }) },
      }
    );

  const yes = await runWith(true);
  assert.equal(yes.success, true);
  assert.ok(yes.log.find((l) => l.nodeId === "ok"), "the approved branch ran");
  assert.equal(yes.log.find((l) => l.nodeId === "no"), undefined);
  const approvedItem = yes.log.find((l) => l.nodeId === "ok").inputItems[0];
  assert.equal(approvedItem.approval.approved, true);
  assert.equal(approvedItem.approval.by, "ada@example.com");

  const no = await runWith(false);
  assert.equal(no.success, true);
  assert.ok(no.log.find((l) => l.nodeId === "no"), "the rejected branch ran");
  assert.equal(no.log.find((l) => l.nodeId === "ok"), undefined);

  // Nobody watching (no interactive session): the node's fallback applies.
  const unattended = await executeWorkflow(
    wf(
      [feedNode(), node("n1", "approval", { message: "Publish?", timeoutMinutes: 5, onTimeout: "fail", onError: "stop" })],
      [edge("feed", "n1")]
    ),
    { maxItemsPerNode: 10 }
  );
  const entry = unattended.log.find((l) => l.nodeId === "n1");
  assert.equal(entry.status, "error");
  assert.equal(entry.errorCode, ERROR_CODES.APPROVAL_TIMEOUT.code);
  assert.equal(ERROR_CODES.APPROVAL_TIMEOUT.code, 7003);
  const documented = errorCatalog().find((e) => e.code === 7003);
  assert.ok(documented && documented.tips.length >= 2, "BF-7003 is documented with tips");
});

// ---------------------------------------------------------------------------
// 4. Error Trigger / account-wide error workflows
// ---------------------------------------------------------------------------
test("the Error Trigger payload describes the workflow, node and code", () => {
  const payload = buildErrorPayload(
    { id: "wf1", name: "Lead sync" },
    { startedAt: "2026-09-14T10:00:00Z", finishedAt: "2026-09-14T10:00:01Z", durationMs: 12, nodeCount: 3, errorCount: 1, handledErrors: 0, success: false },
    "schedule",
    [{ nodeId: "n1", nodeName: "Call API", nodeType: "http", error: "boom", errorCode: 3001, errorShort: "HTTP request failed", durationMs: 5 }]
  );
  assert.equal(payload.workflow.name, "Lead sync");
  assert.equal(payload.source, "schedule");
  assert.equal(payload.error.marker, "BF-3001");
  assert.equal(payload.error.nodeName, "Call API");
  assert.equal(payload.errors.length, 1);
  assert.equal(payload.run.durationMs, 12);
});

test("nothing is triggered for handled failures, unknown owners or error runs", async () => {
  const handled = await triggerErrorWorkflows({ id: "w", ownerId: "u" }, { log: [{ status: "error", handled: true }] }, "editor");
  assert.deepEqual(handled, []);
  assert.deepEqual(await triggerErrorWorkflows(null, null, "editor"), []);
  assert.deepEqual(await triggerErrorWorkflows({ id: "w", ownerId: "u-nobody" }, { log: [{ status: "error" }] }, "editor"), []);
  // An error workflow must never trigger further error workflows (no loops).
  assert.deepEqual(await triggerErrorWorkflows({ id: "w", ownerId: "u" }, { log: [{ status: "error" }] }, ERROR_SOURCE), []);
});

test("a failed run actually runs the account's Error Trigger workflow once", async () => {
  await workflows.save({
    id: "wf-handler",
    name: "Alert me",
    description: "",
    ownerId: "u-err",
    folderId: "f1",
    nodes: [{ id: "t", type: "errorTrigger", position: { x: 0, y: 0 }, data: { label: "Any workflow failed", config: { onError: "stop" } } }],
    edges: [],
  });
  await workflows.save({
    id: "wf-broken",
    name: "Broken",
    description: "",
    ownerId: "u-err",
    folderId: "f1",
    nodes: [],
    edges: [],
  });

  const ran = await triggerErrorWorkflows(
    { id: "wf-broken", name: "Broken", ownerId: "u-err" },
    {
      log: [{ status: "error", handled: false, nodeId: "n1", nodeName: "Call API", nodeType: "http", error: "boom", errorCode: 3001, errorShort: "HTTP request failed" }],
      startedAt: "2026-09-14T10:00:00Z",
      finishedAt: "2026-09-14T10:00:01Z",
      durationMs: 1000,
      success: false,
      errorCount: 1,
    },
    "schedule"
  );

  assert.equal(ran.length, 1, "exactly one handler ran");
  assert.equal(ran[0].workflowId, "wf-handler");
  assert.equal(ran[0].success, true);

  // The handler never triggers itself, and a clean run triggers nothing.
  const clean = await triggerErrorWorkflows({ id: "wf-broken", ownerId: "u-err" }, { log: [{ status: "success" }] }, "schedule");
  assert.deepEqual(clean, []);
});

// ---------------------------------------------------------------------------
// 5. Starter templates
// ---------------------------------------------------------------------------
test("every starter template is a runnable workflow skeleton", () => {
  assert.ok(TEMPLATES.length >= 5, "expected a useful set of templates");
  for (const tpl of TEMPLATES) {
    assert.ok(tpl.id && tpl.name && tpl.description, `${tpl.id} has metadata`);
    assert.ok(TEMPLATE_CATEGORIES.includes(tpl.category), `${tpl.id} uses a known category`);
    assert.ok(Array.isArray(tpl.requires), `${tpl.id} lists what it needs`);

    const ids = new Set();
    for (const n of tpl.nodes) {
      assert.ok(NODES[n.type], `${tpl.id}: node type "${n.type}" exists in the catalog`);
      assert.ok(!ids.has(n.id), `${tpl.id}: duplicate node id ${n.id}`);
      ids.add(n.id);
      assert.ok(Number.isFinite(n.position?.x) && Number.isFinite(n.position?.y), `${tpl.id}: ${n.id} has a position`);
      assert.ok("onError" in (n.data.config || {}), `${tpl.id}: ${n.id} carries an onError setting`);
    }
    assert.ok(tpl.nodes.some((n) => isTriggerType(n.type)), `${tpl.id} has a trigger`);

    for (const e of tpl.edges) {
      const source = tpl.nodes.find((n) => n.id === e.source);
      assert.ok(source, `${tpl.id}: edge source ${e.source} exists`);
      assert.ok(ids.has(e.target), `${tpl.id}: edge target ${e.target} exists`);
      const allowed = NODES[source.type].sources?.length ? NODES[source.type].sources : ["out"];
      assert.ok(allowed.includes(e.sourceHandle), `${tpl.id}: ${source.type} handle "${e.sourceHandle}" is one of ${allowed.join(", ")}`);
    }

    // Credentials stay empty — a template must never ship a secret.
    const json = JSON.stringify(tpl.nodes);
    assert.ok(!/sk-[A-Za-z0-9]{8}/.test(json), `${tpl.id} contains no API key`);
    assert.ok(!/xox[baprs]-/.test(json), `${tpl.id} contains no Slack token`);
  }
});

test("template summaries and lookup line up with the templates", () => {
  const summaries = templateSummaries();
  assert.equal(summaries.length, TEMPLATES.length);
  for (const s of summaries) {
    assert.equal(s.nodeCount, getTemplate(s.id).nodes.length);
    assert.equal(s.edgeCount, getTemplate(s.id).edges.length);
    assert.equal(s.nodes, undefined, "the list view does not ship the graph");
  }
  assert.equal(getTemplate("does-not-exist"), null);
  assert.ok(getTemplate(TEMPLATES[0].id).nodes.length > 0);
});
