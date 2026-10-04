// ============================================================================
// Loop runner — repeats a workflow on the server (the workflow's "loop"
// setting, a Pro feature).
//
// An editor Run of a looping workflow executes the first pass while the user
// watches, then hands the remaining passes to this module, so the loop keeps
// going after the page is closed or the owner signs out — the same guarantee
// "Always on" gives. Background ("Always on") workflows start their loop here
// from the scheduler without anyone pressing Run.
//
// One timer per running loop and nothing else: no polling. Before every pass
// the workflow is re-read, so switching the loop off, deleting the workflow or
// a lapsed Pro subscription ends it, and edits to the count or interval apply
// to the next pass. State is in memory — a restart ends editor-started loops;
// background workflows are picked up again by the scheduler.
// ============================================================================
import { workflows, hydrateSecretsInWorkflow } from "./store.js";
import { db } from "./dbx.js";
import { runQuota, isProUser } from "./quota.js";
import { executeRouted } from "./runner.js";
import { recordExecution } from "./executions.js";
import { loopIntervalFloor } from "../shared/loop.js";

// workflowId → { done, total, nextAt, timer, stopped }
const loops = new Map();
// workflowId → loop signature of a finite loop that already ran to the end,
// so the scheduler does not restart it every tick (a changed setting does).
const finished = new Map();

const signature = (loop) => `${loop?.times}:${loop?.intervalSeconds}`;

/** The effective wait between two passes, with the shared minimum applied. */
export function loopIntervalMs(loop) {
  const times = Math.max(0, Math.floor(Number(loop?.times) || 0));
  const secs = Math.max(loopIntervalFloor(times), Math.floor(Number(loop?.intervalSeconds) || 0));
  // even a zero interval yields to other work for a second
  return Math.max(1, secs) * 1000;
}

export function loopStatus(id) {
  const l = loops.get(String(id));
  if (!l) return { running: false };
  return { running: true, done: l.done, total: l.total, nextAt: new Date(l.nextAt).toISOString() };
}

export function isLoopRunning(id) {
  return loops.has(String(id));
}

export function loopFinished(stored) {
  return finished.get(String(stored.id)) === signature(stored.loop);
}

/**
 * Start (or restart) the server-side loop for `stored`. `done` counts passes
 * that already ran (the editor's first pass); `immediate` runs the next pass
 * now instead of after one interval.
 */
export function startLoop(stored, { done = 0, immediate = false } = {}) {
  const id = String(stored.id);
  stopLoop(id);
  finished.delete(id);
  const state = { done, total: Math.max(0, Math.floor(Number(stored.loop?.times) || 0)), nextAt: 0, timer: null, stopped: false };
  loops.set(id, state);
  schedule(id, state, immediate ? 0 : loopIntervalMs(stored.loop));
  return loopStatus(id);
}

export function stopLoop(id) {
  const l = loops.get(String(id));
  if (!l) return false;
  l.stopped = true;
  clearTimeout(l.timer);
  loops.delete(String(id));
  return true;
}

export function stopAllLoops() {
  for (const id of [...loops.keys()]) stopLoop(id);
  finished.clear();
}

function schedule(id, state, delay) {
  state.nextAt = Date.now() + delay;
  state.timer = setTimeout(() => pass(id, state), delay);
  state.timer.unref?.();
}

function end(id, state, reason, stored) {
  if (loops.get(id) === state) loops.delete(id);
  if (stored && state.total > 0 && state.done >= state.total) finished.set(id, signature(stored.loop));
  console.log(`  [loop] "${stored?.name || id}" stopped after ${state.done} run(s) — ${reason}`);
}

async function pass(id, state) {
  if (state.stopped) return;
  let stored;
  try {
    stored = await workflows.get(id);
  } catch {
    stored = null;
  }
  if (!stored) return end(id, state, "the workflow was deleted");
  if (!stored.loop?.enabled) return end(id, state, "the loop was switched off", stored);
  // the count may have been edited while the loop ran
  state.total = Math.max(0, Math.floor(Number(stored.loop.times) || 0));
  if (state.total > 0 && state.done >= state.total) return end(id, state, "every run is done", stored);
  if (!(await isProUser(stored.ownerId))) return end(id, state, "repeating a workflow is a Pro feature", stored);

  try {
    const quota = await runQuota(stored.ownerId);
    if (quota.allowed) {
      const wf = hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(stored.id));
      if (quota.limit !== null) await db.bumpRunUsage(stored.ownerId);
      const result = await executeRouted(wf, {
        source: "loop", // listed as running until recordExecution saves it
        triggerPayload: { triggeredAt: new Date().toISOString(), loop: true, run: state.done + 1, intervalSeconds: loopIntervalMs(stored.loop) / 1000 },
        maxItemsPerNode: 5,
        userId: stored.ownerId,
      });
      await recordExecution(stored, result, "loop");
      const failed = (result.log || []).filter((l) => l.status === "error").length;
      console.log(`  [loop] "${stored.name}" run ${state.done + 1}${state.total ? `/${state.total}` : ""} — ${failed ? `${failed} node(s) failed` : "all nodes OK"} (${result.durationMs} ms)`);
    }
  } catch (err) {
    console.error(`  [loop] "${stored.name}" (${id}) run failed: ${String(err?.message || err).slice(0, 160)}`);
  }
  // A failed or skipped pass still counts and still waits, so a broken
  // workflow never retries in a tight loop.
  state.done++;
  if (state.stopped) return;
  if (state.total > 0 && state.done >= state.total) return end(id, state, "every run is done", stored);
  schedule(id, state, loopIntervalMs(stored.loop));
}
