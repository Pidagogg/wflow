// ============================================================================
// W FLOW — Stripe trigger (live webhook deliveries)
//
// A Stripe account's webhook endpoint points at the workflow's /webhook/:id
// URL. server/index.js checks the `stripe-signature` header with the
// trigger's signing secret (billing.js verifyStripeSignature) — a secret is
// required, because an unsigned "payment succeeded" could otherwise be forged
// by anyone who knows the URL — and this module decides whether the event is
// the one the trigger listens for and shapes it like the sample payload
// (shared/samples.js), so a flow built on the sample keeps working live.
// ============================================================================

// Stripe redelivers an event when our answer is slow or lost, and a captured
// delivery stays validly signed for 5 minutes — either would run the workflow
// twice for one payment. Each workflow runs a given event id once a day.
const DEDUPE_MS = 24 * 60 * 60 * 1000;
const seen = new Map(); // "wfId:evt_…" → time first accepted

export function firstDelivery(workflowId, eventId, now = Date.now()) {
  if (!eventId) return true;
  for (const [k, t] of seen) {
    if (now - t <= DEDUPE_MS) break; // insertion order: the rest are newer
    seen.delete(k);
  }
  const key = `${workflowId}:${eventId}`;
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

/** Whether a Stripe event type is the one the trigger's Event field selects. */
export function stripeEventMatches(mode, type) {
  const want = String(mode || "checkout.session.completed").trim();
  return want === "*" || want === String(type || "");
}

/** The trigger's output for one Stripe event. */
export function stripeTriggerPayload(event) {
  const obj = event?.data?.object || {};
  const type = String(event?.type || "");
  return {
    event: type,
    id: event?.id || "",
    created: event?.created || Math.floor(Date.now() / 1000),
    livemode: !!event?.livemode,
    customer: {
      email: obj.customer_details?.email || obj.customer_email || obj.receipt_email || obj.email || "",
      name: obj.customer_details?.name || obj.customer_name || obj.name || "",
    },
    ...(type.startsWith("checkout.session") ? { session: obj } : {}),
    object: obj,
  };
}
