// ============================================================================
// Execution history — persist every workflow run so the Execution menu can list
// past runs per workflow and reopen their full log. Saves are best-effort: a
// history write must never break a run or take the server down.
//
// Two things happen here besides the insert:
//   - the run's AI usage is priced with the owner's price table and stored
//     (tokens + estimated cost), which powers the token/cost view and the
//     Main-page spend statistic,
//   - a run that failed (unhandled) hands the failure to the owner's error
//     workflows (a workflow containing an Error Trigger node) — fire and
//     forget, so a slow alert never delays the run that failed.
//
// Runs are kept for BF_EXECUTION_RETENTION_DAYS (default 30, 0 = forever):
// their logs hold whatever the nodes returned — including data fetched from
// connected services — so they are not kept longer than someone needs to
// look back at a run.
// ============================================================================
import { db } from "./dbx.js";
import { getPriceSettings, estimateRunCost } from "./ai-cost.js";
import { triggerErrorWorkflows } from "./error-workflows.js";
import { endRunning } from "./running-executions.js";
import { notifyFailure } from "./failure-alerts.js";

// ---- retention ----
export function executionRetentionDays() {
  const raw = process.env.BF_EXECUTION_RETENTION_DAYS;
  const n = Number(raw);
  return raw === undefined || raw === "" || !Number.isFinite(n) || n < 0 ? 30 : n;
}

/** Delete runs older than the retention window. Returns the number removed. */
export async function pruneExecutions(now = Date.now()) {
  const days = executionRetentionDays();
  if (!days) return 0;
  const cutoff = new Date(now - days * 24 * 60 * 60_000).toISOString();
  return db.executionsPrune(cutoff);
}

/** Prune shortly after start and then every hour; never throws. */
export function startExecutionRetention() {
  const run = () =>
    pruneExecutions()
      .then((n) => n && console.log(`  [executions] removed ${n} run(s) older than ${executionRetentionDays()} days`))
      .catch((err) => console.error("[executions] retention prune failed:", err?.message || err));
  setTimeout(run, 60_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

/**
 * Persist one finished run.
 * @param {{id:string, ownerId?:string}} workflow the workflow that ran
 * @param {object} result the executor's ExecResult
 * @param {"editor"|"webhook"|"chat"|"schedule"|"telegram"|"error"} [source]
 */
export async function recordExecution(workflow, result, source = "editor") {
  // Account-wide error workflows first (fire and forget): a failing run should
  // alert immediately, even while its own history row is still being written.
  if (source !== "error") {
    triggerErrorWorkflows(workflow, result, source).catch((err) =>
      console.error("[executions] error workflows failed:", err?.message || err)
    );
    // The workflow's own e-mail / Telegram failure alert (never throws).
    notifyFailure(workflow, result, source);
  }

  try {
    if (!workflow?.id || !result) return null;

    // Price the run's model calls with the owner's (editable) price table.
    let aiCostUsd = 0;
    let promptTokens = Number(result.usage?.prompt || 0) || 0;
    let completionTokens = Number(result.usage?.completion || 0) || 0;
    try {
      const table = await getPriceSettings(workflow.ownerId || "");
      const cost = estimateRunCost(result, table);
      if (cost.costUsd !== null) aiCostUsd = cost.costUsd;
    } catch {
      /* pricing is best-effort — never block the history write */
    }

    return await db.executionsSave({
      // the id the run was listed under while running (executeRouted), so the
      // row turns into the saved run in place
      id: result.executionId || undefined,
      workflowId: workflow.id,
      ownerId: workflow.ownerId || "",
      source,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      success: !!result.success,
      aborted: !!result.aborted,
      nodeCount: result.nodeCount,
      errorCount: result.errorCount,
      promptTokens,
      completionTokens,
      aiCostUsd,
      result,
    });
  } catch (err) {
    console.error("[executions] could not save run:", err?.message || err);
    return null;
  } finally {
    if (result?.executionId) endRunning(result.executionId);
  }
}
