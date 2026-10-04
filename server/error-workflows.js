// ----------------------------------------------------------------------------
// W FLOW — account-wide error workflows
//
// A workflow that contains an "Error Trigger" node is the account's error
// handler: whenever one of the owner's OTHER workflows finishes with an
// unhandled failure, that workflow is executed and receives one item describing
// what went wrong — which workflow, which node, the error (message + BF code)
// and the run's summary. That is how you alert yourself, open a ticket or write
// to a log without wiring an error branch into every single workflow.
//
// Deliberately conservative:
//   - only *unhandled* failures count (a node with "Continue" on error is fine),
//   - a failing workflow never triggers its own error handler,
//   - error-workflow runs never trigger further error workflows (no loops),
//   - at most MAX_ERROR_WORKFLOWS handlers run per failure, and only inside the
//     same account (owner-scoped),
//   - the handler runs without consuming the owner's free-plan run allowance:
//     it is not a run the user started.
// Nothing in here may ever break a run — every failure is caught and logged.
// ----------------------------------------------------------------------------
import { workflows, hydrateSecretsInWorkflow } from "./store.js";
import { db } from "./dbx.js";
// Runs are routed: locally, or to the remote runner set up in Setup.
import { executeRouted } from "./runner.js";
import { recordExecution } from "./executions.js";

const MAX_ERROR_WORKFLOWS = 5;
const ERROR_SOURCE = "error";

function failureEntry(entry) {
  return {
    nodeId: entry.nodeId,
    nodeName: entry.nodeName,
    nodeType: entry.nodeType,
    message: entry.error || "unknown error",
    code: entry.errorCode ?? null,
    codeShort: entry.errorShort || null,
    marker: entry.errorCode ? `BF-${entry.errorCode}` : null,
    durationMs: entry.durationMs ?? 0,
  };
}

/** Build the payload the error workflow receives (one item). */
export function buildErrorPayload(workflow, result, source, failures) {
  return {
    triggeredAt: new Date().toISOString(),
    source,
    workflow: { id: workflow.id, name: workflow.name || workflow.id },
    error: failureEntry(failures[0]),
    errors: failures.map(failureEntry),
    run: {
      startedAt: result?.startedAt || "",
      finishedAt: result?.finishedAt || "",
      durationMs: result?.durationMs ?? 0,
      nodeCount: result?.nodeCount ?? 0,
      errorCount: result?.errorCount ?? 0,
      handledErrors: result?.handledErrors ?? 0,
      aborted: !!result?.aborted,
      success: !!result?.success,
    },
  };
}

/**
 * Run the owner's error workflows for a finished run that failed.
 * Safe to call for every run: it returns [] when nothing failed or no error
 * workflow is configured.
 * @returns {Promise<Array<{workflowId:string,name:string,success:boolean}>>}
 */
export async function triggerErrorWorkflows(workflow, result, source = "editor") {
  try {
    if (!workflow?.id || !workflow.ownerId) return [];
    if (source === ERROR_SOURCE) return []; // never chain error workflows
    const failures = (result?.log || []).filter((l) => l.status === "error" && !l.handled);
    if (!failures.length) return [];

    const candidates = (await workflows.listOwned(workflow.ownerId)).filter(
      (wf) => wf.id !== workflow.id && (wf.nodes || []).some((n) => n.type === "errorTrigger")
    );
    if (!candidates.length) return [];

    const payload = buildErrorPayload(workflow, result, source, failures);
    const ran = [];
    for (const wf of candidates.slice(0, MAX_ERROR_WORKFLOWS)) {
      try {
        const full = await hydrateSecretsInWorkflow(wf, await db.getWorkflowSecrets(wf.id));
        const res = await executeRouted(full, {
          source: ERROR_SOURCE, // listed as running until recordExecution saves it
          triggerPayload: payload,
          runInput: payload,
          userId: workflow.ownerId,
          maxItemsPerNode: Math.min(Number(process.env.BF_MAX_ITEMS) || 20, 50),
        });
        await recordExecution(full, res, ERROR_SOURCE);
        ran.push({ workflowId: wf.id, name: wf.name || wf.id, success: !!res.success });
      } catch (err) {
        console.error(`[error-workflows] handler "${wf.id}" failed:`, err?.message || err);
      }
    }
    return ran;
  } catch (err) {
    console.error("[error-workflows] could not run error workflows:", err?.message || err);
    return [];
  }
}

export { ERROR_SOURCE };
