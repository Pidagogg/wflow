// ============================================================================
// W FLOW — spending limits for nodes that move money
//
// Exchange orders and wallet transfers can carry two guards, both in the
// node's own amount unit (the base coin, or the quote coin when “Amount is in”
// says so): a maximum per order and a maximum total per UTC day. A trigger
// that misfires or a loop that runs away then stops at the limit instead of
// emptying the account.
//
// The daily total lives in the key-value store under the workflow and node, so
// it survives restarts. Only real orders count; test-mode orders are checked
// against the limit (so a test shows the block) but never added to the total.
// Two runs racing on the same node can both pass the check — the limit is a
// safety net, not an accounting system.
// ============================================================================
import { db } from "./dbx.js";
import { attachCode } from "../shared/errors.js";

const dayKey = (workflowId, nodeId, now) => `spend:${workflowId || "adhoc"}:${nodeId}:${new Date(now).toISOString().slice(0, 10)}`;

const limitOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Today's recorded total for one node. */
export async function spentToday(workflowId, nodeId, now = Date.now()) {
  try {
    return Number(await db.storeGet(dayKey(workflowId, nodeId, now))) || 0;
  } catch {
    return 0;
  }
}

/**
 * Throw SPENDING_LIMIT when `amount` breaks the node's per-order or daily
 * limit. Limits of 0 / empty mean “no limit”.
 */
export async function checkSpend({ workflowId, nodeId, amount, maxAmount, maxDaily, unit = "", now = Date.now() }) {
  const value = Number(amount);
  const perOrder = limitOf(maxAmount);
  const daily = limitOf(maxDaily);
  const u = unit ? ` ${unit}` : "";
  if (perOrder && value > perOrder) {
    throw attachCode(new Error(`Spending limit: ${value}${u} is above this node's maximum of ${perOrder}${u} per order. Nothing was sent.`), "SPENDING_LIMIT");
  }
  if (daily) {
    const spent = await spentToday(workflowId, nodeId, now);
    if (spent + value > daily) {
      throw attachCode(
        new Error(`Spending limit: ${value}${u} would take today's total to ${spent + value}${u}, above this node's daily maximum of ${daily}${u} (${spent}${u} already used). Nothing was sent.`),
        "SPENDING_LIMIT"
      );
    }
  }
}

/** Add a completed real order / transfer to today's total. */
export async function recordSpend({ workflowId, nodeId, amount, now = Date.now() }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return;
  const key = dayKey(workflowId, nodeId, now);
  try {
    const spent = Number(await db.storeGet(key)) || 0;
    await db.storeSet(key, String(spent + value));
  } catch (err) {
    console.error("[spend-limits] could not record spend:", err?.message || err);
  }
}
