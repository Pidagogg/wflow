// ============================================================================
// W FLOW — polling crypto triggers
//
// Three triggers the scheduler (server/scheduler.js) polls on their interval:
//
//   cryptoPriceTrigger   — an exchange price rises above / falls below a level,
//                          or moves by a percentage,
//   polymarketTrigger    — a Polymarket outcome's chance does the same,
//   walletDepositTrigger — an EVM wallet's coin or token balance goes up.
//
// They fire on the EVENT, not the state: "above 70 000" fires once when the
// price crosses the line, not on every poll while it stays above (otherwise a
// Telegram alert would repeat every minute). Like the RSS trigger, the first
// poll after a start only records a baseline, so a restart never fires on
// something that happened while the server was down.
//
// State is in memory; the fetchers are injectable so tests run offline.
// ============================================================================
import { runExchange } from "./crypto-exchanges.js";
import { runPolymarket } from "./polymarket.js";
import { runEvmWallet } from "./crypto-wallets.js";
import { getNodeDef } from "../shared/catalog.js";

export const CRYPTO_TRIGGER_TYPES = new Set(["cryptoPriceTrigger", "polymarketTrigger", "walletDepositTrigger"]);

const state = new Map(); // "wfId::nodeId" → { nextPoll, last, ref }

export function cryptoTriggerNodes(wf) {
  return (wf.nodes || []).filter((n) => CRYPTO_TRIGGER_TYPES.has(n.type));
}

export function pollIntervalMs(config) {
  const minutes = Number(config?.pollInterval) > 0 ? Number(config.pollInterval) : 1;
  return Math.max(60_000, minutes * 60_000);
}

// ---- readers ----
async function readPrice(c, { assertUrl }) {
  const type = `${c.exchange || "binance"}Exchange`;
  if (!getNodeDef(type)) throw new Error(`Unknown exchange "${c.exchange}".`);
  const baseUrl = String(c.baseUrl || getNodeDef(type).defaults?.baseUrl || "").replace(/\/+$/, "");
  if (baseUrl) await assertUrl(baseUrl);
  const r = await runExchange(type, { operation: "price", symbol: String(c.symbol || "").trim(), baseUrl });
  return { value: r.price, extra: { symbol: r.symbol, change24h: r.change24h } };
}

async function readChance(c) {
  const r = await runPolymarket({ operation: "price", market: String(c.market || "").trim(), outcome: String(c.outcome || "Yes").trim() });
  // Chances are shown and compared in percent (0.62 → 62).
  return { value: r.price === null ? null : Number((r.price * 100).toFixed(2)), extra: { question: r.question, outcome: r.outcome, url: r.url } };
}

async function readBalance(c, { assertUrl }) {
  const cfg = {
    operation: c.tokenAddress ? "tokenBalance" : "balance",
    network: c.network || "ethereum",
    address: String(c.address || "").trim(),
    tokenAddress: String(c.tokenAddress || "").trim(),
    rpcUrl: String(c.rpcUrl || "").trim().replace(/\/+$/, ""),
  };
  const r = await runEvmWallet(cfg, { assertUrl });
  return { value: Number(r.balance), extra: { address: r.address, asset: r.asset, network: cfg.network, token: r.token || null } };
}

export const READERS = { cryptoPriceTrigger: readPrice, polymarketTrigger: readChance, walletDepositTrigger: readBalance };

// ---- firing rules ----
/**
 * Decide whether a new reading fires. Returns the event payload or null.
 * `prev` is the previous reading, `ref` the level a "change" condition is
 * measured from (the value at the last fire, or the baseline).
 */
export function evaluate(type, c, prev, ref, value) {
  if (value === null || !Number.isFinite(value) || prev === null || prev === undefined) return null;
  if (type === "walletDepositTrigger") {
    const received = Number((value - prev).toFixed(12));
    const min = Number(c.minAmount) > 0 ? Number(c.minAmount) : 0;
    return received > 0 && received >= min ? { received } : null;
  }
  const threshold = Number(c.threshold);
  const condition = c.condition || "above";
  if (condition === "above") return Number.isFinite(threshold) && prev <= threshold && value > threshold ? { crossed: "above" } : null;
  if (condition === "below") return Number.isFinite(threshold) && prev >= threshold && value < threshold ? { crossed: "below" } : null;
  if (condition === "change") {
    if (!(threshold > 0) || !ref) return null;
    // Price: percent change. Polymarket chance: percentage points.
    const moved = type === "polymarketTrigger" ? value - ref : ((value - ref) / ref) * 100;
    return Math.abs(moved) >= threshold ? { moved: Number(moved.toFixed(4)) } : null;
  }
  return null;
}

function payloadFor(type, c, reading, prev, ref, event, now) {
  const base = { triggeredAt: new Date(now).toISOString(), ...reading.extra };
  if (type === "cryptoPriceTrigger") {
    return { ...base, exchange: c.exchange || "binance", price: reading.value, previousPrice: prev, condition: c.condition || "above", threshold: Number(c.threshold) || 0, ...event, ...(event.moved !== undefined ? { referencePrice: ref } : {}) };
  }
  if (type === "polymarketTrigger") {
    return { ...base, chance: reading.value, previousChance: prev, condition: c.condition || "above", threshold: Number(c.threshold) || 0, ...event, ...(event.moved !== undefined ? { referenceChance: ref } : {}) };
  }
  return { ...base, amount: event.received, balance: reading.value, previousBalance: prev };
}

/**
 * One poll of one trigger node. Calls `fire(payload)` when the event happened.
 * Returns "baseline" | "fired" | "quiet" | "skipped" (not due yet).
 */
export async function pollCryptoTrigger(stored, node, now, fire, { assertUrl = async () => {}, readers = READERS } = {}) {
  const key = `${stored.id}::${node.id}`;
  const c = node.data?.config || {};
  const s = state.get(key);
  if (s && now < s.nextPoll) return "skipped";
  const interval = pollIntervalMs(c);
  // Advance first: a failing poll is never retried in a tight loop.
  state.set(key, { ...(s || {}), nextPoll: now + interval });
  const reading = await readers[node.type](c, { assertUrl });
  const current = state.get(key);
  if (!s || s.last === undefined) {
    state.set(key, { ...current, last: reading.value, ref: reading.value });
    return "baseline";
  }
  const event = evaluate(node.type, c, s.last, s.ref, reading.value);
  state.set(key, { ...current, last: reading.value, ref: event ? reading.value : s.ref });
  if (!event) return "quiet";
  await fire(payloadFor(node.type, c, reading, s.last, s.ref, event, now));
  return "fired";
}

export function resetCryptoTriggerState() {
  state.clear();
}
