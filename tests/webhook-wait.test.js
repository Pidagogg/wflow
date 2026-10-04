// ============================================================================
// Pending webhook waits — the mechanism behind \"Run waits for a real webhook
// call\". When a webhook-only workflow is run without a test payload, the run
// route registers a pending wait; the webhook handler later completes it with
// the executed result and the editor's poll picks it up.
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { beginWebhookWait, pollWebhookWait, completeWebhookWait, isWebhookArmed, markWebhookFired, claimWait, completeWaitWithResult } from "../server/webhook-wait.js";

test("pending wait reports waiting, then returns the executed result once the webhook fires", () => {
  const { waitingId } = beginWebhookWait("wf-1", { method: "POST", webhookUrl: "/webhook/wf-1" });
  assert.ok(waitingId, "a waitingId is issued");

  let poll = pollWebhookWait("wf-1", waitingId);
  assert.equal(poll.waiting, true, "still waiting before the webhook fires");
  assert.equal(poll.method, "POST");
  assert.equal(poll.webhookUrl, "/webhook/wf-1");

  const result = { success: true, log: [{ nodeId: "n1", nodeName: "Webhook", status: "success", outputItems: [{ hello: "world" }] }] };
  completeWebhookWait("wf-1", result);

  poll = pollWebhookWait("wf-1", waitingId);
  assert.equal(poll.waiting, undefined, "a completed run is not flagged as waiting");
  assert.deepEqual(poll, result, "the executed result is handed to the waiting run");

  // the entry is consumed — a later poll reports cancelled
  poll = pollWebhookWait("wf-1", waitingId);
  assert.equal(poll.cancelled, true);
});

test("a mismatched or unknown waitingId is reported as cancelled", () => {
  beginWebhookWait("wf-2", { method: "GET", webhookUrl: "/webhook/wf-2" });
  assert.equal(pollWebhookWait("wf-2", "wrong-id").cancelled, true);
  assert.equal(pollWebhookWait("wf-2", undefined).waiting, true, "a bare poll without an id still works");
  assert.equal(pollWebhookWait("does-not-exist", "x").cancelled, true);
});

test("a newer run replaces the previous wait", () => {
  const first = beginWebhookWait("wf-3", { method: "POST", webhookUrl: "/webhook/wf-3" });
  const second = beginWebhookWait("wf-3", { method: "GET", webhookUrl: "/webhook/wf-3" });
  // the first wait is superseded
  assert.equal(pollWebhookWait("wf-3", first.waitingId).cancelled, true);
  assert.equal(pollWebhookWait("wf-3", second.waitingId).waiting, true);
  // completing with the newer id's wait resolves
  completeWebhookWait("wf-3", { success: true });
  assert.equal(pollWebhookWait("wf-3", second.waitingId).success, true);
});

test("completing a wait that no longer exists is a harmless no-op", () => {
  completeWebhookWait("no-such-workflow", { success: true });
  assert.equal(pollWebhookWait("no-such-workflow", "x").cancelled, true);
});

test("the webhook URL only fires while a run is armed (waiting for its first request)", () => {
  // before any Run: not armed → the /webhook handler must reject the call
  assert.equal(isWebhookArmed("wf-armed-1"), false);

  // pressing Run arms the URL
  beginWebhookWait("wf-armed-1", { method: "POST", webhookUrl: "/webhook/wf-armed-1" });
  assert.equal(isWebhookArmed("wf-armed-1"), true);

  // the first request to arrive fires the wait…
  markWebhookFired("wf-armed-1");
  assert.equal(isWebhookArmed("wf-armed-1"), false, "a fired wait no longer accepts further calls");

  // …while the waiting editor still sees the run as pending until the result arrives
  assert.equal(pollWebhookWait("wf-armed-1").waiting, true, "the poll keeps reporting waiting while the run executes");

  // once the run finishes and the poll picks up the result, the entry is gone
  completeWebhookWait("wf-armed-1", { success: true });
  assert.equal(pollWebhookWait("wf-armed-1").success, true);
  assert.equal(isWebhookArmed("wf-armed-1"), false);
  assert.equal(pollWebhookWait("wf-armed-1").cancelled, true);
});

test("a non-inbound wait is claimed exactly once and completed with the submitted input's result", () => {
  const { waitingId } = beginWebhookWait("wf-input-1", { awaiting: "input", triggerType: "slackTrigger", triggerLabel: "Slack In" });

  // the poll reports the awaiting metadata so the editor can show the input panel
  const poll = pollWebhookWait("wf-input-1", waitingId);
  assert.equal(poll.waiting, true);
  assert.equal(poll.awaiting, "input");
  assert.equal(poll.triggerType, "slackTrigger");

  // the first claim wins…
  assert.equal(claimWait("wf-input-1", waitingId), true);
  // …so a second submission cannot run the same workflow twice
  assert.equal(claimWait("wf-input-1", waitingId), false);
  // and a claimed wait is no longer armed for the webhook URL
  assert.equal(isWebhookArmed("wf-input-1"), false);

  const result = { success: true, log: [{ nodeId: "s", nodeName: "Set", status: "success", outputItems: [{ echo: "hi" }] }] };
  assert.equal(completeWaitWithResult("wf-input-1", waitingId, result), true);
  assert.deepEqual(pollWebhookWait("wf-input-1", waitingId), result);
});

test("claiming/completing a wait with the wrong id (or none) is rejected", () => {
  beginWebhookWait("wf-input-2", { awaiting: "input" });
  assert.equal(claimWait("wf-input-2", "wrong-id"), false);
  assert.equal(completeWaitWithResult("wf-input-2", "wrong-id", { success: true }), false);
  assert.equal(completeWaitWithResult("no-such-wf", "x", { success: true }), false);
});

test("firing marks only that workflow's wait — other armed workflows stay armed", () => {
  beginWebhookWait("wf-armed-2", { method: "POST", webhookUrl: "/webhook/wf-armed-2" });
  beginWebhookWait("wf-armed-3", { method: "GET", webhookUrl: "/webhook/wf-armed-3" });
  markWebhookFired("wf-armed-2");
  assert.equal(isWebhookArmed("wf-armed-2"), false);
  assert.equal(isWebhookArmed("wf-armed-3"), true, "an unrelated waiting workflow is unaffected");
  assert.equal(isWebhookArmed("never-armed"), false);
  markWebhookFired("never-armed"); // no-op, must not throw
});
