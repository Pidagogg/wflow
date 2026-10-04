// ============================================================================
// Running executions — runs that have started but are not saved yet.
//
// The execution history (server/executions.js) is written when a run ends, so
// a long run — or a webhook / schedule run nobody watches in the editor — used
// to be invisible until it finished. Every run goes through executeRouted()
// (server/runner.js), which registers it here for its lifetime; the executions
// endpoints list these entries above the saved runs.
//
// Deliberately in memory only: a run cannot outlive the process that executes
// it, so a restart can never leave a stale "running" row behind. The entry's id
// becomes the saved execution's id (recordExecution reads result.executionId),
// so the row turns into the finished run in place instead of jumping.
// ============================================================================
import crypto from "node:crypto";

const running = new Map(); // id → entry
// A finished run normally leaves the moment recordExecution saves it; this is
// only the fallback for a caller that never records its result.
const UNRECORDED_TTL_MS = 10_000;

/**
 * Register a run that is starting. Returns its id (the future execution id) —
 * `id` when given: a run answering a Run-button trigger wait keeps the wait's
 * id, so its row carries on from "waiting for trigger".
 */
export function beginRunning(workflow, { source = "run", ownerId = "", id: givenId = "" } = {}) {
  const id = givenId && !running.has(givenId) ? String(givenId) : crypto.randomUUID();
  const labels = new Map((workflow?.nodes || []).map((n) => [n.id, String(n?.data?.label || n?.type || n?.id || "node")]));
  running.set(id, {
    id,
    workflowId: String(workflow?.id || ""),
    ownerId: String(workflow?.ownerId || ownerId || ""),
    source: String(source || "run"),
    startedAt: new Date().toISOString(),
    nodeCount: labels.size,
    nodesStarted: 0,
    currentNode: "",
    labels,
    timer: null,
  });
  return id;
}

/** The executor reports each node as it starts. */
export function noteRunningNode(id, nodeId) {
  const entry = running.get(id);
  if (!entry) return;
  entry.nodesStarted++;
  entry.currentNode = entry.labels.get(nodeId) || String(nodeId || "");
}

/**
 * The run returned. By default it stays listed until its history row exists
 * (endRunning), so the list has no gap in between; a run that threw (and will
 * never be recorded) passes awaitRecord: false and is removed at once.
 */
export function finishRunning(id, { awaitRecord = true } = {}) {
  const entry = running.get(id);
  if (!entry) return;
  if (!awaitRecord) return void running.delete(id);
  entry.timer = setTimeout(() => running.delete(id), UNRECORDED_TTL_MS);
  entry.timer.unref?.();
}

/** The history row is saved — the saved run takes over from here. */
export function endRunning(id) {
  const entry = running.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  running.delete(id);
}

function summary(entry) {
  return {
    id: entry.id,
    workflowId: entry.workflowId,
    source: entry.source,
    startedAt: entry.startedAt,
    finishedAt: "",
    durationMs: Date.now() - Date.parse(entry.startedAt),
    success: false,
    aborted: false,
    nodeCount: entry.nodeCount,
    errorCount: 0,
    running: true,
    currentNode: entry.currentNode,
    nodesStarted: entry.nodesStarted,
  };
}

/** Running runs of one workflow, newest first. */
export function runningForWorkflow(workflowId) {
  return [...running.values()].filter((e) => e.workflowId === workflowId).map(summary).reverse();
}

/** Running runs of every workflow one account owns, newest first. */
export function runningForOwner(ownerId) {
  return [...running.values()].filter((e) => ownerId && e.ownerId === ownerId).map(summary).reverse();
}

/**
 * Rows for Run-button trigger waits (server/webhook-wait.js armedWaits): the
 * run is armed but its trigger has not fired, so no node has started yet.
 */
export function waitingRows(waits) {
  return waits
    .filter((w) => !running.has(w.id))
    .map((w) => ({
      id: w.id,
      workflowId: w.workflowId,
      // what the run will be saved as once the trigger fires
      source: w.awaiting === "webhook" ? "webhook" : "editor",
      startedAt: new Date(w.createdAt).toISOString(),
      finishedAt: "",
      durationMs: Date.now() - w.createdAt,
      success: false,
      aborted: false,
      nodeCount: w.nodeCount,
      errorCount: 0,
      running: true,
      waiting: true,
      currentNode: w.triggerLabel,
      nodesStarted: 0,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Is this execution id a run of that workflow that is still going? */
export function isRunning(id, workflowId) {
  return running.get(id)?.workflowId === String(workflowId || "");
}
