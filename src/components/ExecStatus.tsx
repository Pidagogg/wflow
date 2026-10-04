import { AlertTriangle, CheckCircle2, Hourglass, Loader2, XCircle } from "lucide-react";
import type { ExecutionSummary } from "../types";

/** How often an executions list reloads itself while it is open (ms). */
export const EXEC_POLL_MS = 3000;

/**
 * The status cell of an executions table: waiting for its trigger (Run was
 * pressed, the webhook / input has not arrived), Running (with the node it is on),
 * OK or Failed, plus a "stopped" badge for runs ended with the Stop button.
 */
export default function ExecStatus({ run }: { run: ExecutionSummary }) {
  if (run.waiting) {
    return (
      <span className="tool-running" title={run.currentNode ? `Waiting for ${run.currentNode} to fire` : "Waiting for the trigger"}>
        <Hourglass size={13} className="pulse" /> Executing now
        <span className="wf-exec-badge">waiting for {run.currentNode || "trigger"}</span>
      </span>
    );
  }
  if (run.running) {
    return (
      <span className="tool-running" title={run.currentNode ? `Running: ${run.currentNode}` : "Running"}>
        <Loader2 size={13} className="spin" /> Executing now
        {run.currentNode && <span className="wf-exec-badge">at {run.currentNode}</span>}
      </span>
    );
  }
  return (
    <>
      {run.success ? (
        <span className="tool-ok">
          <CheckCircle2 size={13} /> OK
        </span>
      ) : (
        <span className="tool-bad">
          <XCircle size={13} /> Failed
        </span>
      )}
      {run.aborted && (
        <span className="wf-exec-badge">
          <AlertTriangle size={11} /> stopped
        </span>
      )}
    </>
  );
}
