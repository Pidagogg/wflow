// ----------------------------------------------------------------------------
// W FLOW — pending approvals (human-in-the-loop)
//
// The "Wait for Approval" node pauses a run until a person answers. The run
// request stays open while the executor awaits this module, the editor polls
// the pending approval through the run-status endpoint and shows Approve /
// Reject buttons, and the decision resolves the promise so the run continues
// down the Approved or the Rejected output.
//
// Three ways an approval ends:
//   - a person answers (resolveApproval) — the normal case,
//   - the timeout elapses — the node's "when nobody answers" setting decides
//     (fail / reject / approve); a timeout of 0 waits forever,
//   - the run is stopped (the editor's Stop button aborts the run signal) — the
//     wait resolves as aborted so the node fails and the run halts.
//
// Entries are keyed by the runToken (one interactive run per Run click), so a
// stale browser tab can never answer a newer run's approval, and every entry is
// cleaned up when the run request finishes (endApprovals).
// ----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";

const pending = new Map(); // runToken -> { id, info, finish, timer }
// Hard ceiling on how long a run may be parked on an approval, even when the
// node is configured to wait forever — a forgotten run must not leak memory.
const MAX_WAIT_MS = 12 * 60 * 60 * 1000;

/**
 * Register a pending approval and await the decision.
 * @param {string} runToken the interactive run this approval belongs to
 * @param {object} info { nodeId, nodeName, message, approveLabel, rejectLabel, timeoutMs, onTimeout, signal }
 * @returns {Promise<{approved:boolean, by?:string|null, timedOut?:boolean, unanswered?:boolean, aborted?:boolean}>}
 */
export function beginApproval(runToken, info = {}) {
  return new Promise((resolve) => {
    if (!runToken) {
      // No interactive run (scheduler, Telegram, sub-workflow call) — nobody can
      // answer, so apply the node's fallback immediately.
      resolve({ approved: info.onTimeout === "approve", timedOut: true, unanswered: true, action: info.onTimeout });
      return;
    }

    const id = randomUUID();
    const created = Date.now();
    const timeoutMs = Math.max(0, Number(info.timeoutMs ?? 5 * 60_000)) || (Number(info.timeoutMs) === 0 ? 0 : 5 * 60_000);
    const entry = { id, info: { ...info, id, startedAt: created, expiresAt: timeoutMs > 0 ? created + timeoutMs : 0 }, timer: null, onAbort: null };

    const finish = (decision) => {
      const current = pending.get(runToken);
      if (!current || current.id !== id) return;
      if (current.timer) clearTimeout(current.timer);
      if (current.onAbort && entry.info.signal) {
        try {
          entry.info.signal.removeEventListener("abort", current.onAbort);
        } catch {
          /* signal already gone */
        }
      }
      pending.delete(runToken);
      resolve(decision);
    };
    entry.finish = finish;

    if (timeoutMs > 0) {
      entry.timer = setTimeout(
        () => finish({ approved: info.onTimeout === "approve", timedOut: true, unanswered: true, action: info.onTimeout }),
        Math.min(timeoutMs, MAX_WAIT_MS)
      );
      entry.timer.unref?.();
    } else if (Number(info.timeoutMs) === 0) {
      // "Wait forever" still gets the safety ceiling.
      entry.timer = setTimeout(() => finish({ approved: false, timedOut: true, unanswered: true, action: info.onTimeout }), MAX_WAIT_MS);
      entry.timer.unref?.();
    }

    // Stopping the run (Stop button) releases the approval as aborted.
    if (info.signal && typeof info.signal.addEventListener === "function") {
      const onAbort = () => finish({ aborted: true });
      entry.onAbort = onAbort;
      if (info.signal.aborted) {
        onAbort();
        return;
      }
      info.signal.addEventListener("abort", onAbort, { once: true });
    }

    // A newer Run for the same token replaces the old one.
    const previous = pending.get(runToken);
    if (previous) {
      if (previous.timer) clearTimeout(previous.timer);
      pending.delete(runToken);
      resolve({ approved: false, timedOut: true, unanswered: true, action: "fail", superseded: true });
    }
    pending.set(runToken, entry);
  });
}

/** The approval a run is currently waiting on (used by the run-status poll). */
export function approvalStatus(runToken) {
  const entry = runToken ? pending.get(runToken) : null;
  if (!entry) return null;
  const { info } = entry;
  return {
    id: info.id,
    nodeId: info.nodeId || null,
    nodeName: info.nodeName || null,
    message: info.message || "",
    approveLabel: info.approveLabel || "Approve",
    rejectLabel: info.rejectLabel || "Reject",
    startedAt: info.startedAt || null,
    expiresAt: info.expiresAt || 0,
  };
}

/** Answer a pending approval. Returns false when there is nothing to answer. */
export function resolveApproval(runToken, approvalId, approved, by = "", reason = "") {
  const entry = runToken ? pending.get(runToken) : null;
  if (!entry) return false;
  if (approvalId && entry.id !== approvalId) return false;
  entry.finish({ approved: !!approved, by, reason: reason || null, timedOut: false, unanswered: false });
  return true;
}

/** Release a run's pending approval (called when the run request finishes). */
export function endApprovals(runToken) {
  const entry = runToken ? pending.get(runToken) : null;
  if (!entry) return;
  entry.finish({ aborted: true });
}
