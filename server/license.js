// ============================================================================
// W FLOW — self-hosted licence (Pro / Team)
//
// Running W flow on your own machine or server is a Pro perk, so a copy needs a
// live subscription behind it. Both halves live here:
//
//   Cloud (w-flow.tech)  issues one licence key per Pro account and answers
//                        POST /api/license/check with what the key is worth
//                        right now: { valid, plan, seats, validUntil }.
//   Copy  (standalone)   keeps its key in its own .env (WFLOW_LICENSE_KEY —
//                        the installer writes it, the lock screen takes a
//                        pasted one), asks the cloud every few hours and locks
//                        itself once the subscription is over.
//
// Privacy: the check sends the key and nothing else — no account, workflow,
// run or credential of the copy ever reaches the cloud. The only path that
// does move data is the explicit "Move to the cloud" action (server/migrate.js).
//
// Offline grace: a copy that cannot reach the cloud keeps working until the
// last good answer's validUntil (GRACE_MS after it was given), so a network
// blip or a cloud restart never stops someone's automations.
//
// Locked copy: the API answers 402 (LICENSE_INACTIVE) except for signing in,
// the licence itself, Setup and the move to the cloud, and scheduled / webhook
// runs are refused — the data stays on the copy and is never deleted.
// ============================================================================
import { createHash, randomBytes } from "node:crypto";
import { db } from "./dbx.js";
import { standaloneMode, writeEnvValues } from "./setup.js";

/** How long a good answer keeps a copy unlocked without reaching the cloud. */
export const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** How often a copy asks the cloud again. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The cloud a copy checks against unless WFLOW_LICENSE_SERVER says otherwise. */
export const DEFAULT_LICENSE_SERVER = "https://w-flow.tech";

const KEY_PREFIX = "wfl_";

// ---- key helpers ----

export function newLicenseKey() {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

function digest(key) {
  return createHash("sha256").update(String(key || "").trim()).digest("hex");
}

export function looksLikeLicenseKey(key) {
  return /^wfl_[A-Za-z0-9_-]{20,64}$/.test(String(key || "").trim());
}

// ============================================================================
// Cloud side — issuing and answering
// ============================================================================

// The key is kept encrypted (so Settings can show it again) and indexed by its
// hash (so a check never decrypts every key to find the right one).
const userKey = (userId) => `license.user.${userId}`;
const hashKey = (hash) => `license.key.${hash}`;

/** The account's licence key, issued on first use. */
export async function licenseKeyFor(userId) {
  const existing = await db.storeGet(userKey(userId));
  if (existing) return existing;
  return rotateLicenseKey(userId);
}

/** Replace the account's key — the old one stops working at the copy's next check. */
export async function rotateLicenseKey(userId) {
  const old = await db.storeGet(userKey(userId));
  if (old) await db.storeDelete(hashKey(digest(old)));
  const key = newLicenseKey();
  await db.storeSet(userKey(userId), key, { encrypted: true });
  await db.storeSet(hashKey(digest(key)), String(userId));
  return key;
}

/** The account a key belongs to ("" when unknown). */
export async function licenseOwner(key) {
  if (!looksLikeLicenseKey(key)) return "";
  return String((await db.storeGet(hashKey(digest(key)))) || "");
}

/**
 * What a key is worth right now. `entitlement(userId)` decides the plan — it is
 * passed in so this module stays free of the billing and team modules:
 *   → { pro: boolean, plan: "pro" | "team", seats: number }
 */
export async function checkLicenseKey(key, entitlement) {
  const userId = await licenseOwner(key);
  if (!userId) return { valid: false, reason: "This licence key is not known. Copy it again from Settings → Self-hosted on w-flow.tech." };
  const user = await db.getUserById(userId);
  if (!user || user.status === "deactivated") return { valid: false, reason: "The account this licence belongs to is no longer active." };
  const ent = await entitlement(userId);
  if (!ent?.pro) {
    return { valid: false, reason: "The Pro subscription behind this licence has ended. Renew it on w-flow.tech to keep using this copy." };
  }
  return {
    valid: true,
    plan: ent.plan === "team" ? "team" : "pro",
    seats: Math.max(1, Number(ent.seats) || 1),
    validUntil: Date.now() + GRACE_MS,
    checkedAt: Date.now(),
  };
}

// ============================================================================
// Copy side — checking and locking
// ============================================================================

const STATE_KEY = "license.local.state";
let memState = null;
let timer = null;

/** A copy needs a licence; the cloud (and dev / test servers) do not. */
export function licenseRequired() {
  return standaloneMode();
}

export function licenseServer() {
  return String(process.env.WFLOW_LICENSE_SERVER || DEFAULT_LICENSE_SERVER).trim().replace(/\/+$/, "");
}

export function localLicenseKey() {
  return String(process.env.WFLOW_LICENSE_KEY || "").trim();
}

async function loadState() {
  if (memState) return memState;
  try {
    memState = JSON.parse((await db.storeGet(STATE_KEY)) || "null");
  } catch {
    memState = null;
  }
  return memState;
}

async function saveState(state) {
  memState = state;
  try {
    await db.storeSet(STATE_KEY, JSON.stringify(state));
  } catch {
    /* the in-memory copy still applies until the next restart */
  }
}

/**
 * Ask the cloud about this copy's key. A network failure keeps the last good
 * answer (its validUntil is the grace period); a clear "no" locks at once.
 */
export async function refreshLicense({ fetchImpl = globalThis.fetch } = {}) {
  const key = localLicenseKey();
  const prev = await loadState();
  if (!key) {
    const state = { valid: false, reason: "This copy has no licence key yet. Paste the key from Settings → Self-hosted on w-flow.tech.", checkedAt: Date.now() };
    await saveState(state);
    return state;
  }
  try {
    const res = await fetchImpl(`${licenseServer()}/api/license/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The key and nothing else — see the privacy note at the top.
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status >= 500) throw new Error(`licence server answered ${res.status}`);
    const state = body?.valid
      ? {
          valid: true,
          plan: body.plan === "team" ? "team" : "pro",
          seats: Math.max(1, Number(body.seats) || 1),
          validUntil: Math.min(Number(body.validUntil) || 0, Date.now() + GRACE_MS),
          checkedAt: Date.now(),
          keyHash: digest(key),
          // the version the cloud ships now — the copy offers it as an update
          latestVersion: String(body.latestVersion || ""),
        }
      : { valid: false, reason: String(body?.reason || "The licence was not accepted."), checkedAt: Date.now(), keyHash: digest(key) };
    await saveState(state);
    return state;
  } catch (err) {
    // Offline: keep what we had for this key; it expires on its own.
    const kept = prev && prev.keyHash === digest(key) ? { ...prev, lastError: String(err.message || err), lastTryAt: Date.now() } : null;
    const state = kept || { valid: false, reason: `Could not reach ${licenseServer()} to check the licence: ${String(err.message || err)}`, checkedAt: Date.now(), keyHash: digest(key) };
    await saveState(state);
    return state;
  }
}

/** The copy's licence as the UI shows it. */
export async function licenseStatus() {
  if (!licenseRequired()) return { required: false, active: true, plan: "cloud", seats: 0 };
  const state = (await loadState()) || { valid: false, reason: "The licence has not been checked yet." };
  const active = !!state.valid && Number(state.validUntil || 0) > Date.now();
  return {
    required: true,
    active,
    plan: state.plan || "",
    seats: state.seats || 0,
    validUntil: state.validUntil || 0,
    checkedAt: state.checkedAt || 0,
    reason: active ? "" : state.valid ? "The licence could not be confirmed for a few days — connect this copy to the internet so it can check again." : state.reason || "",
    hasKey: !!localLicenseKey(),
    keyHint: localLicenseKey() ? `${localLicenseKey().slice(0, 8)}…${localLicenseKey().slice(-4)}` : "",
    server: licenseServer(),
    offlineSince: state.lastError ? state.lastTryAt || 0 : 0,
    latestVersion: state.latestVersion || "",
  };
}

/** True when this instance may run workflows and serve its API. */
export async function licenseActive() {
  return (await licenseStatus()).active;
}

/** Seats of the copy's plan (how many accounts may exist), 0 on the cloud. */
export async function licenseSeats() {
  const s = await licenseStatus();
  return s.required ? Math.max(1, s.seats || 1) : 0;
}

/** Store a pasted key in the copy's .env and check it right away. */
export async function setLocalLicenseKey(key) {
  const clean = String(key || "").trim();
  if (!looksLikeLicenseKey(clean)) return { ok: false, error: "That does not look like a W flow licence key (it starts with wfl_)." };
  writeEnvValues({ WFLOW_LICENSE_KEY: clean });
  process.env.WFLOW_LICENSE_KEY = clean;
  memState = null;
  const state = await refreshLicense();
  return { ok: !!state.valid, error: state.valid ? "" : state.reason, status: await licenseStatus() };
}

export function startLicenseChecks() {
  if (!licenseRequired() || timer) return;
  refreshLicense().catch(() => {});
  timer = setInterval(() => refreshLicense().catch(() => {}), CHECK_EVERY_MS);
  timer.unref?.();
}

export function stopLicenseChecks() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test hook: forget the cached state. */
export function resetLicenseCache() {
  memState = null;
}

// Paths a locked copy still serves: signing in and out, the licence itself,
// Setup (to fix the licence server or database) and the move to the cloud.
const OPEN_WHEN_LOCKED = [
  /^\/api\/auth\//,
  /^\/api\/license(\/|$)/,
  /^\/api\/setup(\/|$)/,
  /^\/api\/migrate\//,
  /^\/api\/catalog$/,
];

/** Express middleware for /api and /webhook on a copy. */
export async function licenseGate(req, res, next) {
  if (!licenseRequired()) return next();
  const full = req.originalUrl.split("?")[0];
  if (OPEN_WHEN_LOCKED.some((re) => re.test(full))) return next();
  if (await licenseActive()) return next();
  const status = await licenseStatus();
  res.status(402).json({ error: status.reason || "This self-hosted copy has no active licence.", code: "LICENSE_INACTIVE" });
}
