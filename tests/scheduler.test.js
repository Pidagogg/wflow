// ============================================================================
// Cron scheduler — fires Schedule (cron) triggers on their own in the
// background. These tests drive the scheduler's tick loop with an injected
// clock to verify the important timing guarantees:
//   - a cron only fires when its next occurrence has arrived (never early)
//   - each occurrence fires exactly once (no double runs)
//   - after a restart (state reset) the next fire is recomputed from now —
//     missed occurrences are NOT backfilled
//
// The SQL database (BF_DB_PATH) and the JSON data dir (BF_DATA_DIR) are
// pointed at a temp folder so the real ./data is never touched.
// ============================================================================
import assert from "node:assert/strict";
import { test, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-sched-"));
process.env.BF_DB_PATH = path.join(tempDir, "sched.db");
process.env.BF_DATA_DIR = tempDir;

const { workflows, setWorkflowStorageMode } = await import("../server/store.js");
const { tick, resetSchedulerState } = await import("../server/scheduler.js");
const { db, closeDb } = await import("../server/dbx.js");
const { FREE_MAX_RUNS_PER_DAY } = await import("../server/quota.js");

after(() => {
  try {
    closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// A workflow with a Schedule (cron) trigger feeding a Log node — runs fully
// offline, and every successful fire is visible in the scheduler's log line.
function cronWorkflow(id, cron, timezone = "UTC", ownerId = "u1") {
  return {
    id,
    ownerId,
    name: `Cron Test WF ${id}`,
    nodes: [
      { id: "trig", type: "schedule", data: { config: { cron, timezone } } },
      { id: "sink", type: "log", data: { config: {} } },
    ],
    edges: [{ id: "e1", source: "trig", target: "sink", sourceHandle: "out", targetHandle: "in" }],
  };
}

// Anchor the fake clock at 10s past a minute boundary: the next occurrence of
// a "* * * * *" cron is then exactly 50s away, so ticks at +60s and +120s
// deterministically hit one occurrence each — never the boundary itself (the
// real Date.now() can land exactly on a boundary and make ticks ambiguous).
function alignedMinute() {
  return Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
}

// Run a tick while capturing console output; returns how many fires of the
// named workflow happened (other workflows' fires don't count against it).
async function runTick(now, name = "Cron Test WF") {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try {
    await tick(now);
  } finally {
    console.log = orig;
  }
  return lines.filter((l) => l.includes(`[scheduler] ran \"${name}`)).length;
}

test("scheduler fires each cron occurrence exactly once, no backfill", async () => {
  await setWorkflowStorageMode("database");
  await workflows.save(cronWorkflow("wf-cron-1", "* * * * *"));
  resetSchedulerState();

  const t0 = Date.now();
  // 1. next occurrence is still in the future → nothing fires
  assert.equal(await runTick(t0), 0, "no fire before the next occurrence");

  // 2. past the next occurrence → fires exactly once
  assert.equal(await runTick(t0 + 60_000), 1, "fire when due");

  // 3. same clock again → must NOT fire the same occurrence twice
  assert.equal(await runTick(t0 + 60_000), 0, "each occurrence fires only once");

  // 4. the following occurrence → fires again
  assert.equal(await runTick(t0 + 120_000), 1, "advances to the next occurrence");

  // 5. restart (state cleared): next fire is recomputed from the new time,
  //    which is in the future → no backfill of missed occurrences
  resetSchedulerState();
  assert.equal(await runTick(t0 + 3_600_000), 0, "no backfill after restart");
});

test("scheduler skips workflows with empty or invalid crons without crashing", async () => {
  await setWorkflowStorageMode("database");
  await workflows.save(cronWorkflow("wf-cron-empty", ""));
  await workflows.save(cronWorkflow("wf-cron-bad", "not-a-cron"));
  resetSchedulerState();

  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try {
    await tick(Date.now() + 60_000); // would fire anything due
  } finally {
    console.log = orig;
  }
  const ran = lines.filter((l) => l.includes("[scheduler] ran \"Cron Test WF")).length;
  assert.equal(ran, 0, "empty/invalid crons never fire");
  const crashed = lines.filter((l) => l.includes("failed") || l.includes("tick error")).length;
  assert.equal(crashed, 0, "no scheduler errors for malformed crons");
});

test("scheduler counts cron fires against the free-plan daily run cap", async () => {
  await setWorkflowStorageMode("database");
  const owner = "u-quota-ok";
  db.clearRunUsage(owner);
  await workflows.save(cronWorkflow("wf-cron-quota-ok", "* * * * *", "UTC", owner));
  resetSchedulerState();

  const t0 = alignedMinute();
  await runTick(t0, "Cron Test WF wf-cron-quota-ok"); // seed the next-occurrence clock (no fire yet)
  // Under the cap → the fire executes and consumes exactly one daily run.
  assert.equal(await runTick(t0 + 60_000, "Cron Test WF wf-cron-quota-ok"), 1, "free owner under the cap fires normally");
  assert.equal(await db.getRunUsage(owner), 1, "a cron fire consumes one daily run");

  // The following occurrence fires again and the counter advances.
  assert.equal(await runTick(t0 + 120_000, "Cron Test WF wf-cron-quota-ok"), 1, "fires again on the next occurrence");
  assert.equal(await db.getRunUsage(owner), 2, "each fire consumes one more run");
});

test("scheduler skips cron fires once the owner hits the daily cap", async () => {
  await setWorkflowStorageMode("database");
  const owner = "u-quota-out";
  db.clearRunUsage(owner);
  // Exhaust the free daily allowance up front.
  for (let i = 0; i < FREE_MAX_RUNS_PER_DAY; i++) await db.bumpRunUsage(owner);
  assert.equal(await db.getRunUsage(owner), FREE_MAX_RUNS_PER_DAY, "cap exhausted before the tick");

  await workflows.save(cronWorkflow("wf-cron-quota-out", "* * * * *", "UTC", owner));
  resetSchedulerState();

  const t0 = alignedMinute();
  await tick(t0); // seed the next-occurrence clock (no fire: it is in the future)
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try {
    await tick(t0 + 60_000); // the occurrence is due now
  } finally {
    console.log = orig;
  }
  const ran = lines.filter((l) => l.includes("[scheduler] ran \"Cron Test WF wf-cron-quota-out")).length;
  assert.equal(ran, 0, "no execution while the owner is at the cap");
  const skipped = lines.filter((l) => l.includes("[scheduler] skipped \"Cron Test WF wf-cron-quota-out")).length;
  assert.equal(skipped, 1, "the due occurrence is skipped with an explanatory log line");
  assert.equal(await db.getRunUsage(owner), FREE_MAX_RUNS_PER_DAY, "usage never exceeds the cap");
});
