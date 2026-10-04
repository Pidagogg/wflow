// ----------------------------------------------------------------------------
// W FLOW — pending trigger waits
//
// Pressing Run on a workflow whose triggers are all non-manual never fabricates
// input. Instead the server registers a pending wait and returns
// { waiting: true, awaiting } where `awaiting` is:
//   - "webhook": an inbound HTTP trigger (Webhook / GitHub) — the editor polls
//     until a real request hits /webhook/:id, then the handler executes the
//     workflow and completes the wait with the result.
//   - "chat": a Chat Trigger — the editor opens a chat panel and sends each
//     message through /api/workflows/:id/chat (no pending entry needed).
//   - "input": any other trigger — the editor shows an input panel and posts
//     the payload to /api/workflows/:id/run/input, which claims + completes the
//     wait with the executed result.
//
// A newer Run replaces an older wait for the same workflow; entries expire
// after WAIT_TTL_MS if nothing ever arrives.
//
// An armed wait is listed in the executions history as "waiting for trigger"
// (armedWaits). When it fires, the run reuses the wait's id as its execution
// id, so the same row goes on to "running" and then to the saved result.
// ----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";

const pending = new Map(); // workflowId -> { id, createdAt, fired, result, info, meta, timer }
const WAIT_TTL_MS = 15 * 60 * 1000;

/**
 * Start a pending wait for a real webhook call. Returns a waitingId the
 * editor sends back when polling. `info` goes back to the editor with every
 * poll; `meta` (ownerId, triggerLabel, nodeCount) is only for the history list.
 */
export function beginWebhookWait(workflowId, info = {}, meta = {}) {
  const id = randomUUID();
  const prev = pending.get(workflowId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => pending.delete(workflowId), WAIT_TTL_MS);
  timer.unref?.();
  pending.set(workflowId, { id, createdAt: Date.now(), fired: false, result: null, info, meta, timer });
  return { waitingId: id };
}

/**
 * Whether a real /webhook/:id call may currently trigger this workflow.
 * True only while the workflow is actively waiting for its first request
 * (the owner pressed Run and no request has arrived yet). The URL is inert
 * the rest of the time — a request before Run, after the request fired, or
 * after the wait expired is rejected by the /webhook handler.
 */
export function isWebhookArmed(workflowId) {
  const entry = pending.get(workflowId);
  return !!entry && !entry.fired && !entry.result;
}

/**
 * Mark an armed wait as fired. Called synchronously by the /webhook handler
 * the moment a request arrives (before the run executes), so a second
 * concurrent caller can never double-fire the same Run. Each Run listens for
 * exactly one request; the owner presses Run again to re-arm the URL.
 */
export function markWebhookFired(workflowId) {
  const entry = pending.get(workflowId);
  if (!entry) return null;
  entry.fired = true;
  return entry.id; // the run that answers this wait takes its id
}

/**
 * Waits that are armed right now (Run pressed, trigger not fired yet), for the
 * executions list. A fired wait is left out: its run is listed as running.
 */
export function armedWaits() {
  return [...pending.entries()]
    .filter(([, e]) => !e.fired && !e.result)
    .map(([workflowId, e]) => ({
      id: e.id,
      workflowId,
      createdAt: e.createdAt,
      awaiting: e.info?.awaiting || "",
      ownerId: e.meta?.ownerId || "",
      triggerLabel: e.meta?.triggerLabel || "",
      nodeCount: Number(e.meta?.nodeCount || 0),
    }));
}

/**
 * Poll a pending wait. Returns the executed result once the webhook fired and
 * the entry is consumed, { waiting: true, ...info } while still pending, or
 * { waiting: false, cancelled: true } when the entry is gone (expired or
 * replaced by a newer run / a different waitingId).
 */
export function pollWebhookWait(workflowId, waitingId) {
  const entry = pending.get(workflowId);
  if (!entry || (waitingId && entry.id !== waitingId)) {
    return { waiting: false, cancelled: true, message: "No active webhook wait for this workflow." };
  }
  if (entry.result) {
    clearTimeout(entry.timer);
    pending.delete(workflowId);
    return entry.result;
  }
  return { waiting: true, waitingId: entry.id, ...(entry.info || {}) };
}

/**
 * The /webhook/:id handler calls this after executing the workflow, so any
 * manual run that is waiting for this call receives the result.
 */
export function completeWebhookWait(workflowId, result) {
  const entry = pending.get(workflowId);
  if (entry) entry.result = result;
}

/**
 * Atomically claim a pending wait so an input submission can execute it. Marks
 * the wait fired (the same flag isWebhookArmed checks) so two concurrent
 * submissions — or an input submission racing a webhook call — can never run
 * the same Run twice. Returns false when the wait is gone, already fired, or
 * the waitingId does not match.
 */
export function claimWait(workflowId, waitingId) {
  const entry = pending.get(workflowId);
  if (!entry) return false;
  if (waitingId && entry.id !== waitingId) return false;
  if (entry.fired) return false;
  entry.fired = true;
  return true;
}

/**
 * Complete a claimed wait (an input submission) with its executed result, so
 * the editor's poll returns it. Mirrors completeWebhookWait; the waitingId must
 * still match so an old tab cannot overwrite a newer Run.
 */
export function completeWaitWithResult(workflowId, waitingId, result) {
  const entry = pending.get(workflowId);
  if (!entry || (waitingId && entry.id !== waitingId)) return false;
  entry.result = result;
  return true;
}

/**
 * Cancel a pending wait when the editor's user presses Cancel wait. Matching
 * the id prevents an old tab from cancelling a newer Run for the same workflow.
 */
export function cancelWebhookWait(workflowId, waitingId) {
  const entry = pending.get(workflowId);
  if (!entry || (waitingId && entry.id !== waitingId)) return false;
  clearTimeout(entry.timer);
  pending.delete(workflowId);
  return true;
}
