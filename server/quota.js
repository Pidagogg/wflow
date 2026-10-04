// ----------------------------------------------------------------------------
// W FLOW — free-plan quota helpers
//
// Free-plan limits — Pro (a paid subscription) removes them. A fresh instance
// starts with no caps; these make the "Free: 10 workflows / 50 runs per day,
// Pro: unlimited" tier real. Override per deployment via env:
//   BF_FREE_MAX_WORKFLOWS    (default 10 — 0 disables the cap)
//   BF_FREE_MAX_RUNS_PER_DAY (default 50 — 0 disables the cap)
//
// What counts against the daily run cap: any run the account starts — editor
// Run clicks, webhook calls to its workflows, and cron-scheduled fires.
// Nested sub-workflow calls never count: from the account's point of view a
// parent run that calls helpers is still one execution.
//
// Shared by server/index.js (HTTP entry points) and server/scheduler.js (cron
// fires) so every path into the executor enforces the same quota.
// ----------------------------------------------------------------------------
import "./env.js"; // .env must be loaded before the BF_FREE_* vars are read
import { db } from "./dbx.js";
import { licenseRequired, licenseActive } from "./license.js";
import { teamEntitlement } from "./teams.js";

export const FREE_MAX_WORKFLOWS = Math.max(0, Number(process.env.BF_FREE_MAX_WORKFLOWS || 10));
export const FREE_MAX_RUNS_PER_DAY = Math.max(0, Number(process.env.BF_FREE_MAX_RUNS_PER_DAY || 50));

const PRO_STATUSES = new Set(["active", "trialing"]);

// true when the account holds an active / trialing subscription, or a Team
// plan covers it (server/teams.js). On a self-hosted copy the licence decides
// for everyone: every account there is Pro while the copy's licence is active
// (registration is capped at the plan's seats), and none is once it lapsed.
export async function isProUser(userId) {
  try {
    if (licenseRequired()) return await licenseActive();
    const user = await db.getUserById(userId);
    if (String(user?.role || "").toLowerCase() === "pro_user") return true;
    const sub = await db.getSubscription(userId);
    if (sub && PRO_STATUSES.has(String(sub.status))) return true;
    return !!(await teamEntitlement(user))?.pro;
  } catch {
    return false; // DB hiccup must never block a run behind a false "free" verdict
  }
}

// File storage per account (My files + Write File, server/disk.js), by plan:
//   BF_FILES_FREE_TOTAL_MB (default 25), BF_FILES_PRO_TOTAL_MB (default 500).
export const FILES_FREE_TOTAL_MB = Math.max(1, Number(process.env.BF_FILES_FREE_TOTAL_MB || 25));
export const FILES_PRO_TOTAL_MB = Math.max(1, Number(process.env.BF_FILES_PRO_TOTAL_MB || 500));

/** Bytes of files the account may store in total. */
export async function filesQuotaBytes(userId) {
  const mb = (await isProUser(userId)) ? FILES_PRO_TOTAL_MB : FILES_FREE_TOTAL_MB;
  return mb * 1024 * 1024;
}

// Daily-run cap for the account. Returns { allowed, used, limit }.
// A locked self-hosted copy allows no runs at all (reason "license").
export async function runQuota(userId) {
  if (licenseRequired() && !(await licenseActive())) return { allowed: false, used: 0, limit: 0, reason: "license" };
  if (await isProUser(userId)) return { allowed: true, used: 0, limit: null };
  if (FREE_MAX_RUNS_PER_DAY <= 0) return { allowed: true, used: 0, limit: null }; // 0 disables the cap
  const used = await db.getRunUsage(userId);
  return { allowed: used < FREE_MAX_RUNS_PER_DAY, used, limit: FREE_MAX_RUNS_PER_DAY };
}
