// ============================================================================
// End-to-end HTTP coverage for the reliability + visibility layer: the real
// server (server/index.js) is spawned with an isolated database and driven
// over HTTP like a browser would.
//
//   - starter templates can be listed, fetched and turned into a real workflow
//   - version history snapshots each graph-changing save and can restore one
//   - the AI price table round-trips per account
//   - the Main-page statistics report AI spend
//   - a Wait for Approval node pauses a run, is visible through /run/status,
//     is answered through /run/approval and then completes down the right branch
//   - a failed run executes the account's Error Trigger workflow
//
// No network is needed: every workflow here is offline (Manual trigger, a
// Stop and Error node, log sinks).
//
// Run: node --test tests/workflow-features-api.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-features-api-"));
const dbPath = path.join(tempDir, "features-api.db");
const dataDir = path.join(tempDir, "data");

let child;
let base = "";
let cookie = "";

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const raw = res.headers.getSetCookie?.() ?? [];
  if (raw[0]) cookie = raw[0].split(";")[0];
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready in time");
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: dbPath,
      BF_DATA_DIR: dataDir,
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForServer();
  const reg = await api("POST", "/api/auth/register", { email: `features-${Date.now()}@example.com`, password: "correct-horse-battery" });
  assert.equal(reg.status, 200, `register: ${JSON.stringify(reg.data)}`);
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
test("starter templates are listed and can be turned into a real workflow", async () => {
  const list = await api("GET", "/api/templates");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.templates) && list.data.templates.length >= 5);
  assert.ok(list.data.categories.includes("AI"));
  // The list view is lightweight — no graph.
  assert.equal(list.data.templates[0].nodes, undefined);
  assert.ok(list.data.templates[0].nodeCount > 0);

  const pick = list.data.templates.find((t) => t.id === "api-health-check");
  const full = await api("GET", `/api/templates/${pick.id}`);
  assert.equal(full.status, 200);
  assert.ok(full.data.nodes.length === pick.nodeCount);

  // The graph is a plain workflow payload, so creating it is a normal POST.
  const created = await api("POST", "/api/workflows", {
    name: full.data.name,
    description: full.data.description,
    nodes: full.data.nodes,
    edges: full.data.edges,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.nodes.length, pick.nodeCount);
  assert.equal(created.data.edges.length, pick.edgeCount);
  // Credentials stay empty — a template never ships a secret.
  assert.equal(created.data.nodes.find((n) => n.type === "slackSend").data.config.webhookUrl, "");

  const missing = await api("GET", "/api/templates/nope");
  assert.equal(missing.status, 404);

  // It is a normal editable workflow: it can run.
  const run = await api("POST", `/api/workflows/${created.data.id}/run`, { payload: { ok: true } });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.ok(run.data.log.length > 0);
});

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------
test("every graph-changing save snapshots the previous state and can be restored", async () => {
  const manual = { id: "m", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } };
  const created = await api("POST", "/api/workflows", {
    name: "Versioned",
    nodes: [manual],
    edges: [],
  });
  assert.equal(created.status, 200);
  const id = created.data.id;

  // A save that changes the graph snapshots what the workflow was.
  const updated = await api("PUT", `/api/workflows/${id}`, {
    ...created.data,
    nodes: [manual, { id: "l", type: "log", position: { x: 300, y: 0 }, data: { label: "Log", config: { message: "hi" } } }],
    edges: [{ id: "e", source: "m", target: "l", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.nodes.length, 2);

  const versions = await api("GET", `/api/workflows/${id}/versions`);
  assert.equal(versions.status, 200);
  assert.equal(versions.data.versions.length, 1, "one snapshot for the one graph change");
  const v = versions.data.versions[0];
  assert.equal(v.nodeCount, 1, "the snapshot is the state the workflow was leaving");
  assert.equal(v.reason, "save");
  assert.equal(v.nodes, undefined, "the list carries summaries only");

  const full = await api("GET", `/api/workflows/${id}/versions/${v.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.data.nodes.length, 1);

  const restored = await api("POST", `/api/workflows/${id}/versions/${v.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.data.nodes.length, 1, "the workflow is back to the snapshot");

  const after = await api("GET", `/api/workflows/${id}/versions`);
  assert.equal(after.data.versions.length, 2, "restoring is itself undoable");
  assert.equal(after.data.versions[0].reason, "before-restore");

  // A save that does not change the graph (a rename) does not fill the history.
  const renamed = await api("PUT", `/api/workflows/${id}`, { ...restored.data, name: "Renamed" });
  assert.equal(renamed.status, 200);
  const unchanged = await api("GET", `/api/workflows/${id}/versions`);
  assert.equal(unchanged.data.versions.length, 2);

  const unknown = await api("POST", `/api/workflows/${id}/versions/v-nope/restore`);
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------------------
// AI price table + statistics
// ---------------------------------------------------------------------------
test("the AI price table round-trips per account and feeds the Main-page stats", async () => {
  const initial = await api("GET", "/api/ai/prices");
  assert.equal(initial.status, 200);
  assert.ok(initial.data.prices["gpt-4o-mini"], "a fresh account starts with the presets");
  assert.ok(initial.data.presets["claude-sonnet-4"]);

  const saved = await api("PUT", "/api/ai/prices", {
    prices: { "my-model": { input: 3, output: 6 } },
    fallback: { input: 0.5, output: 1 },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.prices["my-model"], { input: 3, output: 6 });

  const again = await api("GET", "/api/ai/prices");
  assert.deepEqual(again.data.prices["my-model"], { input: 3, output: 6 });
  assert.deepEqual(again.data.fallback, { input: 0.5, output: 1 });

  const stats = await api("GET", "/api/stats");
  assert.equal(stats.status, 200);
  assert.equal(typeof stats.data.aiSpendUsd, "number");
  assert.equal(typeof stats.data.promptTokens, "number");
  assert.equal(typeof stats.data.completionTokens, "number");
});

// ---------------------------------------------------------------------------
// Wait for Approval, over HTTP
// ---------------------------------------------------------------------------
function approvalWorkflow() {
  return {
    name: "Approval gate",
    nodes: [
      { id: "m", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } },
      {
        id: "a",
        type: "approval",
        position: { x: 300, y: 0 },
        data: { label: "Ask a human", config: { message: "Publish {{message}}?", approveLabel: "Publish", rejectLabel: "Discard", timeoutMinutes: 5, onTimeout: "fail", onError: "stop" } },
      },
      { id: "yes", type: "log", position: { x: 600, y: -80 }, data: { label: "Approved", config: { message: "go", onError: "stop" } } },
      { id: "no", type: "log", position: { x: 600, y: 80 }, data: { label: "Rejected", config: { message: "stop", onError: "stop" } } },
    ],
    edges: [
      { id: "e1", source: "m", target: "a", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "a", target: "yes", sourceHandle: "approved", targetHandle: "in" },
      { id: "e3", source: "a", target: "no", sourceHandle: "rejected", targetHandle: "in" },
    ],
  };
}

test("a run pauses on a Wait for Approval node, is answered over HTTP and completes", async () => {
  const created = await api("POST", "/api/workflows", approvalWorkflow());
  assert.equal(created.status, 200);
  const id = created.data.id;

  const runToken = "test-run-token-approval";
  // The run request stays open while the workflow waits for a human.
  const runPromise = api("POST", `/api/workflows/${id}/run`, { runToken, payload: { message: "the report" } });

  // Poll the run status until the approval shows up.
  let approval = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await api("GET", `/api/workflows/${id}/run/status?token=${runToken}`);
    assert.equal(status.status, 200);
    if (status.data.approval) {
      approval = status.data.approval;
      break;
    }
    await sleep(50);
  }
  assert.ok(approval, "the pending approval is visible through the run-status poll");
  assert.equal(approval.message, "Publish the report?");
  assert.equal(approval.approveLabel, "Publish");
  assert.equal(approval.rejectLabel, "Discard");
  assert.equal(approval.nodeId, "a");

  // Answering it lets the run continue down the Approved branch.
  const answered = await api("POST", `/api/workflows/${id}/run/approval`, { runToken, approvalId: approval.id, approved: true });
  assert.equal(answered.status, 200);
  assert.equal(answered.data.ok, true);

  const run = await runPromise;
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.success, true);
  const approvedEntry = run.data.log.find((l) => l.nodeId === "yes");
  assert.ok(approvedEntry, "the Approved output ran");
  assert.equal(run.data.log.find((l) => l.nodeId === "no"), undefined, "the Rejected output did not");
  assert.equal(approvedEntry.inputItems[0].approval.approved, true);

  // The run was recorded, with its input kept for a replay.
  const history = await api("GET", `/api/workflows/${id}/executions`);
  assert.equal(history.status, 200);
  assert.ok(history.data.length >= 1);
  const stored = await api("GET", `/api/workflows/${id}/executions/${history.data[0].id}`);
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.data.result.input, { message: "the report" });

  // Answering a token that is not waiting is refused, not an error.
  const stale = await api("POST", `/api/workflows/${id}/run/approval`, { runToken: "nothing-waiting", approvalId: approval.id, approved: true });
  assert.equal(stale.status, 200);
  assert.equal(stale.data.ok, false);
});

test("a rejected approval routes the run down the Rejected output", async () => {
  const created = await api("POST", "/api/workflows", approvalWorkflow());
  const id = created.data.id;
  const runToken = "test-run-token-reject";
  const runPromise = api("POST", `/api/workflows/${id}/run`, { runToken });

  let approval = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await api("GET", `/api/workflows/${id}/run/status?token=${runToken}`);
    if (status.data.approval) {
      approval = status.data.approval;
      break;
    }
    await sleep(50);
  }
  assert.ok(approval, "the approval is pending");
  const answered = await api("POST", `/api/workflows/${id}/run/approval`, { runToken, approvalId: approval.id, approved: false, reason: "not today" });
  assert.equal(answered.data.ok, true);

  const run = await runPromise;
  assert.equal(run.data.success, true);
  assert.ok(run.data.log.find((l) => l.nodeId === "no"), "the Rejected output ran");
  assert.equal(run.data.log.find((l) => l.nodeId === "yes"), undefined);
});

// ---------------------------------------------------------------------------
// Error workflows, over HTTP
// ---------------------------------------------------------------------------
test("a failed run executes the account's Error Trigger workflow", async () => {
  // The handler: an Error Trigger → log sink.
  const handler = await api("POST", "/api/workflows", {
    name: "Alert on any failure",
    nodes: [
      { id: "t", type: "errorTrigger", position: { x: 0, y: 0 }, data: { label: "Any workflow failed", config: { onError: "stop" } } },
      { id: "l", type: "log", position: { x: 300, y: 0 }, data: { label: "Log it", config: { message: "{{error.marker}} in {{workflow.name}}", onError: "stop" } } },
    ],
    edges: [{ id: "e", source: "t", target: "l", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(handler.status, 200);

  // The broken workflow: a Manual trigger → Stop and Error (fails on purpose).
  const broken = await api("POST", "/api/workflows", {
    name: "Broken on purpose",
    nodes: [
      { id: "m", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } },
      { id: "x", type: "stopError", position: { x: 300, y: 0 }, data: { label: "Boom", config: { message: "bad input: {{reason}}", onError: "stop" } } },
    ],
    edges: [{ id: "e", source: "m", target: "x", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(broken.status, 200);

  const run = await api("POST", `/api/workflows/${broken.data.id}/run`, { payload: { reason: "missing field" } });
  assert.equal(run.status, 200);
  assert.equal(run.data.success, false);
  const failed = run.data.log.find((l) => l.nodeId === "x");
  assert.equal(failed.errorCode, 1004, "Stop and Error reports BF-1004");

  // The handler runs in the background — give it a moment, then look for a run
  // recorded with source "error".
  let errorRun = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !errorRun) {
    const list = await api("GET", "/api/executions?limit=50");
    assert.equal(list.status, 200);
    errorRun = list.data.find((e) => e.source === "error" && e.workflowId === handler.data.id);
    if (!errorRun) await sleep(100);
  }
  assert.ok(errorRun, "the Error Trigger workflow ran for the failed workflow");
  assert.equal(errorRun.errorCount, 0, "the handler itself completed cleanly");
  assert.equal(errorRun.success, true);

  // A workflow that only ever ran cleanly must not fire the handler.
  const clean = await api("POST", "/api/workflows", {
    name: "Just logs",
    nodes: [
      { id: "m", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } },
      { id: "l", type: "log", position: { x: 300, y: 0 }, data: { label: "Log", config: { message: "fine", onError: "stop" } } },
    ],
    edges: [{ id: "e", source: "m", target: "l", sourceHandle: "out", targetHandle: "in" }],
  });
  const before = (await api("GET", "/api/executions?limit=50")).data.filter((e) => e.source === "error").length;
  const ok = await api("POST", `/api/workflows/${clean.data.id}/run`, {});
  assert.equal(ok.data.success, true);
  await sleep(300);
  const afterCount = (await api("GET", "/api/executions?limit=50")).data.filter((e) => e.source === "error").length;
  assert.equal(afterCount, before, "no error workflow ran for a clean run");
});
