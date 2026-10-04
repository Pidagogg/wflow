// ============================================================================
// End-to-end HTTP coverage for the three newer workflow-level features:
//
//   - LOOP (Pro): a workflow with its repeat setting on runs the whole graph
//     again after each pass. The editor Run returns the first pass; the rest
//     run on the server (they survive a closed page) and the execution history
//     shows one row per pass. Ten or more runs, or a continuous loop, wait at
//     least 10 s between runs; Stop ends a running loop.
//   - EXECUTION MODE: switching a workflow to background execution (it runs
//     while its owner is offline) is a Pro perk, so a free account is refused.
//   - BACKUPS: every save lands in a rolling buffer tagged with its author, and
//     the Backup & rewind endpoints expose "the last saves", "my last save" and
//     a rewind target, and can roll the workflow back to any of them.
//
// The server is spawned against an isolated database/data dir, exactly like
// tests/workflow-features-api.test.js. No network is needed: the workflows here
// are offline (Manual trigger + log/error sinks).
//
// Run: node --test tests/workflow-loop-backups.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-loop-backups-"));
const dbPath = path.join(tempDir, "loop-backups.db");
const dataDir = path.join(tempDir, "data");

let child;
let base = "";
let cookie = "";
// the account every test in this file uses (also used to flip the Pro role)
const EMAIL = `loop-${Date.now()}@example.com`;

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
  const reg = await api("POST", "/api/auth/register", { email: EMAIL, password: "correct-horse-battery" });
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

const manual = { id: "m", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } };
const logNode = (id, x = 300) => ({ id, type: "log", position: { x, y: 0 }, data: { label: "Log", config: { message: "tick" } } });
const edge = (source, target, id = "e") => ({ id, source, target, sourceHandle: "out", targetHandle: "in" });

async function newWorkflow(name, extra = {}) {
  const created = await api("POST", "/api/workflows", { name, nodes: [manual, logNode("l")], edges: [edge("m", "l")], ...extra });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  return created.data;
}

// ---------------------------------------------------------------------------
// Loop — the whole workflow repeats (Pro, on the server)
// ---------------------------------------------------------------------------
test("the loop is a Pro feature", async () => {
  const created = await api("POST", "/api/workflows", { name: "Free looper", nodes: [manual], edges: [], loop: { enabled: true, times: 3, intervalSeconds: 0 } });
  assert.equal(created.status, 403, JSON.stringify(created.data));
  assert.match(String(created.data.error || ""), /Pro/);

  const wf = await newWorkflow("Free plain");
  const put = await api("PUT", `/api/workflows/${wf.id}`, { ...wf, loop: { enabled: true, times: 2, intervalSeconds: 0 } });
  assert.equal(put.status, 403, JSON.stringify(put.data));
});

test("a looping workflow runs its first pass in the request and the rest on the server", async () => {
  db2UpdateRole("pro_user");
  try {
    const wf = await newWorkflow("Looper", { loop: { enabled: true, times: 3, intervalSeconds: 0 } });
    assert.deepEqual(wf.loop, { enabled: true, times: 3, intervalSeconds: 0 }, "fewer than 10 runs may follow each other directly");

    const run = await api("POST", `/api/workflows/${wf.id}/run`, { payload: { hello: "world" } });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.ok(run.data.success);
    assert.equal(run.data.loop?.running, true, "the loop continues on the server");
    assert.equal(run.data.loop?.done, 1);
    assert.ok(run.data.consoleLog.some((l) => l.includes("loop")), "the log says the workflow repeats");

    // The remaining passes run without the editor (1 s apart for a zero interval).
    let history;
    for (let i = 0; i < 40; i++) {
      history = await api("GET", `/api/workflows/${wf.id}/executions?limit=10`);
      if (history.data.length >= 3) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(history.data.length, 3, "every pass is recorded in the execution history");
    const status = await api("GET", `/api/workflows/${wf.id}/loop`);
    assert.equal(status.data.running, false, "a finite loop ends by itself");
    await api("DELETE", `/api/workflows/${wf.id}`); // stay under the free workflow cap
  } finally {
    db2UpdateRole("user");
  }
});

test("ten or more runs, or a continuous loop, wait at least 10 s — and Stop ends it", async () => {
  db2UpdateRole("pro_user");
  try {
    const many = await newWorkflow("Many", { loop: { enabled: true, times: 10, intervalSeconds: 2 } });
    assert.equal(many.loop.intervalSeconds, 10, "the wait is raised to the 10 s minimum");
    const forever = await newWorkflow("Forever", { loop: { enabled: true, times: 0, intervalSeconds: 0 } });
    assert.equal(forever.loop.intervalSeconds, 10);

    const run = await api("POST", `/api/workflows/${forever.id}/run`, { payload: {} });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.equal(run.data.loop?.running, true, "a continuous loop runs from the editor too");
    const stop = await api("POST", `/api/workflows/${forever.id}/loop/stop`);
    assert.equal(stop.data.stopped, true);
    const status = await api("GET", `/api/workflows/${forever.id}/loop`);
    assert.equal(status.data.running, false);
    await api("DELETE", `/api/workflows/${many.id}`);
    await api("DELETE", `/api/workflows/${forever.id}`);
  } finally {
    db2UpdateRole("user");
  }
});

test("a workflow without a loop setting still runs exactly once", async () => {
  const wf = await newWorkflow("Single");
  const run = await api("POST", `/api/workflows/${wf.id}/run`, { payload: {} });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.loop, undefined, "no loop for a plain run");
  const history = await api("GET", `/api/workflows/${wf.id}/executions?limit=10`);
  assert.equal(history.data.length, 1);
});

test("turning the loop off clears it (null is not a no-op)", async () => {
  db2UpdateRole("pro_user");
  let wf;
  try {
    wf = await newWorkflow("Looper off", { loop: { enabled: true, times: 2, intervalSeconds: 0 } });
  } finally {
    db2UpdateRole("user");
  }
  // Switching it off works on any plan.
  const cleared = await api("PUT", `/api/workflows/${wf.id}`, { ...wf, loop: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.loop, undefined, "the repeat setting is gone");

  const run = await api("POST", `/api/workflows/${wf.id}/run`, { payload: {} });
  assert.equal(run.data.loop, undefined);
  await api("DELETE", `/api/workflows/${wf.id}`);
});

// ---------------------------------------------------------------------------
// Execution mode — background execution is a Pro perk
// ---------------------------------------------------------------------------
test("background execution mode is refused on the free plan", async () => {
  const wf = await newWorkflow("Offline mode");
  const put = await api("PUT", `/api/workflows/${wf.id}`, { ...wf, executionMode: "background" });
  assert.equal(put.status, 403, JSON.stringify(put.data));
  assert.match(String(put.data.error || ""), /Pro/i);

  // The editor mode stays available and is stored as such.
  const editor = await api("PUT", `/api/workflows/${wf.id}`, { ...wf, executionMode: "editor" });
  assert.equal(editor.status, 200);
  assert.equal(editor.data.executionMode, "editor");
});

test("creating a workflow directly in background mode is refused too", async () => {
  const created = await api("POST", "/api/workflows", { name: "Sneaky", nodes: [manual], edges: [], executionMode: "background" });
  assert.equal(created.status, 403, JSON.stringify(created.data));
});

// ---------------------------------------------------------------------------
// Backups — the rolling buffer behind the shared-mode Backup button
// ---------------------------------------------------------------------------
test("every save is kept with its author and the workflow can be rewound", async () => {
  const wf = await newWorkflow("Backup me");

  // Two graph-changing saves (each adds a node to the chain).
  const first = await api("PUT", `/api/workflows/${wf.id}`, { ...wf, nodes: [manual, logNode("l"), logNode("l2", 600)], edges: [edge("m", "l"), edge("l", "l2", "e2")] });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const second = await api("PUT", `/api/workflows/${wf.id}`, {
    ...first.data,
    nodes: [manual, logNode("l"), logNode("l2", 600), logNode("l3", 900)],
    edges: [edge("m", "l"), edge("l", "l2", "e2"), edge("l2", "l3", "e3")],
  });
  assert.equal(second.status, 200, JSON.stringify(second.data));

  const list = await api("GET", `/api/workflows/${wf.id}/backups`);
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.ok(list.data.backups.length >= 2, "each save is kept");
  assert.ok(list.data.max > 0);
  // Every entry carries who saved it; the account's own saves are flagged.
  assert.equal(list.data.backups[0].mine, true);
  assert.ok(typeof list.data.backups[0].userName === "string");
  assert.equal(list.data.backups[0].nodeCount, 4, "the newest backup is the state just saved");
  assert.equal(list.data.backups[0].edges, undefined, "the list carries summaries only");

  // "My last save" points at the newest save this account made, and the rewind
  // target is the furthest back the buffer can go.
  assert.ok(list.data.myLast && list.data.myLast.mine);
  assert.ok(list.data.rewind, "a rewind target exists once something was saved");

  // Rewinding to an earlier state replaces the graph and records the rewind.
  const older = list.data.backups.find((b) => b.nodeCount === 2);
  assert.ok(older, "the state before the first save is kept");
  const restored = await api("POST", `/api/workflows/${wf.id}/backups/${older.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.nodes.length, 2, "the workflow is back to the earlier state");

  const after = await api("GET", `/api/workflows/${wf.id}/backups`);
  assert.equal(after.data.backups[0].reason, "rewind", "the rewind itself is recorded");
  // The state that was replaced is still recoverable (it is either the newest
  // save that already sat in the buffer, or the explicit before-rewind entry).
  assert.ok(after.data.backups.some((b) => b.nodeCount === 4), "the replaced state is kept");
  // And the rewind can be undone by rolling back to it again.
  const backAgain = await api("POST", `/api/workflows/${wf.id}/backups/${after.data.backups.find((b) => b.nodeCount === 4).id}/restore`);
  assert.equal(backAgain.status, 200);
  assert.equal(backAgain.data.nodes.length, 4, "rewinding is itself undoable");
});

// ---------------------------------------------------------------------------
// The operator grants Pro by role — the API must agree everywhere
// ---------------------------------------------------------------------------
test("granting the pro_user role in the admin panel unlocks Pro in the app", async () => {
  // Free plan first: the caps apply and the UI would keep every Pro switch locked.
  const before = await api("GET", "/api/billing");
  assert.equal(before.status, 200);
  assert.equal(before.data.active, false);
  assert.equal(before.data.plan, "free");
  assert.equal(before.data.source, "none");
  assert.ok(before.data.workflowLimit > 0, "the free plan caps workflows");

  // Exactly what the admin panel's Users role selector does.
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE users SET role = 'pro_user' WHERE email = ?").run(EMAIL);
  db.close();

  // /api/billing is what the editor reads for the Pro gates (background
  // execution, continuous loops) and what the Pro page displays — it has to
  // report Pro from the role alone, with no Stripe subscription involved.
  const after = await api("GET", "/api/billing");
  assert.equal(after.status, 200);
  assert.equal(after.data.active, true, "the role alone makes the account Pro");
  assert.equal(after.data.plan, "pro");
  assert.equal(after.data.source, "role");
  assert.equal(after.data.workflowLimit, null, "the workflow cap is lifted");
  assert.equal(after.data.runsPerDayLimit, null, "the daily run cap is lifted");

  // The same verdict everywhere else the server decides what Pro means.
  const selfhost = await api("GET", "/api/selfhosted");
  assert.equal(selfhost.data.pro, true);

  // …and the unlocked feature actually works now: background execution mode.
  const wf = await newWorkflow("Now pro");
  const put = await api("PUT", `/api/workflows/${wf.id}`, { ...wf, executionMode: "background" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.executionMode, "background");

  // A continuous loop is accepted on the same account.
  const forever = await newWorkflow("Now forever", { loop: { enabled: true, times: 0, intervalSeconds: 30 } });
  assert.equal(forever.loop.times, 0);

  // Back to free: the caps and the gates return.
  db2UpdateRole("user");
  const reverted = await api("GET", "/api/billing");
  assert.equal(reverted.data.active, false);
  assert.equal(reverted.data.plan, "free");
  assert.equal(reverted.data.workflowLimit > 0, true);
});

/** Small helper so the role flips read like the admin panel's action. */
function db2UpdateRole(role) {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE users SET role = ? WHERE email = ?").run(role, EMAIL);
  db.close();
}

test("an unknown backup cannot be restored, and backups do not survive the workflow", async () => {
  const wf = await newWorkflow("Disposable");
  const missing = await api("POST", `/api/workflows/${wf.id}/backups/b-nope/restore`);
  assert.equal(missing.status, 404);

  const removed = await api("DELETE", `/api/workflows/${wf.id}`);
  assert.equal(removed.status, 200);
  const gone = await api("GET", `/api/workflows/${wf.id}/backups`);
  assert.equal(gone.status, 404);
});
