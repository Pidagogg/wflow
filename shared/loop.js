// ============================================================================
// Workflow repeat ("loop") rules — shared by the server (which enforces them)
// and the workflow settings dialog (which explains them).
//
// A loop is a Pro feature and runs on the server, so it keeps going after the
// page is closed. To keep one account from monopolising the runner, a loop
// that repeats often must also wait: fewer than FAST_LOOP_MAX_RUNS + 1 runs may
// follow each other immediately; ten or more runs (or a continuous loop) wait
// at least MIN_LOOP_INTERVAL_SECONDS between runs.
// ============================================================================

export const MIN_LOOP_INTERVAL_SECONDS = 10;
export const FAST_LOOP_MAX_RUNS = 9;

/** The shortest allowed wait between runs for a loop of `times` runs (0 = continuous). */
export function loopIntervalFloor(times) {
  const n = Math.floor(Number(times) || 0);
  return n === 0 || n > FAST_LOOP_MAX_RUNS ? MIN_LOOP_INTERVAL_SECONDS : 0;
}
