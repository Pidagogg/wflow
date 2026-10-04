// ----------------------------------------------------------------------------
// W FLOW — live-run registry
//
// A workflow run that is triggered from the editor (POST /api/workflows/:id/run
// with a `runToken`) registers itself here for the duration of the run. The
// editor then uses the registry for two things:
//
//   1. Progress — the executor reports which node is currently executing
//      (setLiveRunProgress) and the editor polls runStatus to draw a loading
//      ring over that node while the run is in flight.
//   2. Stopping — the Stop button calls stopLiveRun, which aborts the run's
//      AbortController. The executor checks the signal at every node boundary
//      (and inside the Wait/Delay node), so the run halts after the current
//      node finishes and no further downstream nodes start.
//   3. Debugging — a run started in step mode parks before every node
//      (waitForStep) until the editor presses Next (one node) or Continue (the
//      rest of the run without pausing). runStatus reports the parked node and
//      the input it is about to receive.
//
// Entries are keyed by a client-generated runToken (a UUID created per Run
// click), which keeps concurrent runs of different workflows apart. Entries are
// removed when the run request finishes (endLiveRun) or expire after a safety
// timeout if the client disappears mid-run.
// ----------------------------------------------------------------------------

const active = new Map(); // runToken -> { wfId, controller, currentNodeId, startedAt, timer }
const TTL_MS = 30 * 60 * 1000;

export function beginLiveRun(runToken, wfId, { step = false } = {}) {
  endLiveRun(runToken);
  if (!runToken) return null;
  const controller = new AbortController();
  const entry = {
    wfId,
    controller,
    signal: controller.signal,
    currentNodeId: null,
    nodeIndex: 0,
    startedAt: Date.now(),
    timer: null,
    // step mode: pause before every node until Next / Continue
    stepping: !!step,
    paused: null, // { nodeId, input, resolve }
  };
  entry.timer = setTimeout(() => active.delete(runToken), TTL_MS);
  entry.timer.unref?.();
  active.set(runToken, entry);
  return entry;
}

/** The executor calls this just before running each node. */
export function setLiveRunProgress(runToken, nodeId, index = 0) {
  const entry = runToken ? active.get(runToken) : null;
  if (!entry) return;
  entry.currentNodeId = nodeId;
  entry.nodeIndex = index;
}

/**
 * Debug mode: resolve once the editor lets the run go on. Returns at once for
 * runs that are not stepping (or were switched to Continue), and when the run
 * is stopped while parked.
 */
export function waitForStep(runToken, nodeId, input = []) {
  const entry = runToken ? active.get(runToken) : null;
  if (!entry || !entry.stepping || entry.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      entry.signal.removeEventListener("abort", done);
      entry.paused = null;
      resolve();
    };
    entry.paused = { nodeId, input, resolve: done };
    entry.signal.addEventListener("abort", done);
  });
}

/**
 * Release a parked debug run: "next" runs one node and pauses again,
 * "continue" runs the rest without pausing. Returns false when nothing waits.
 */
export function stepLiveRun(runToken, wfId, action = "next") {
  const entry = runToken ? active.get(runToken) : null;
  if (!entry || (wfId && entry.wfId !== wfId) || !entry.paused) return false;
  if (action === "continue") entry.stepping = false;
  entry.paused.resolve();
  return true;
}

/** Live view used by the editor's progress poller. */
export function runStatus(runToken, wfId) {
  const entry = runToken ? active.get(runToken) : null;
  if (!entry || (wfId && entry.wfId !== wfId)) {
    return { active: false };
  }
  return {
    active: true,
    workflowId: entry.wfId,
    nodeId: entry.currentNodeId,
    nodeIndex: entry.nodeIndex,
    elapsedMs: Date.now() - entry.startedAt,
    stepping: entry.stepping,
    paused: entry.paused ? { nodeId: entry.paused.nodeId, input: entry.paused.input } : null,
  };
}

/**
 * Ask a live run to stop. Returns true when a matching live run was found and
 * its AbortController was triggered; false when there is nothing to stop.
 */
export function stopLiveRun(runToken, wfId) {
  const entry = runToken ? active.get(runToken) : null;
  if (!entry || (wfId && entry.wfId !== wfId)) return false;
  try {
    entry.controller.abort();
  } catch {
    /* already aborted */
  }
  return true;
}

/** Remove a run from the registry once its run request has finished. */
export function endLiveRun(runToken) {
  const entry = runToken ? active.get(runToken) : null;
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  active.delete(runToken);
}
