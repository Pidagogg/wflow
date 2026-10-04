// ----------------------------------------------------------------------------
// W FLOW — AI usage & cost accounting
//
// The providers already tell us how many tokens every call used (see
// normalizeUsage in server/ai.js); this module turns that into money. The
// prices are NOT hard-coded business logic — they are a per-account, editable
// table (Settings → AI usage & cost) holding USD per 1M tokens per model, plus
// one fallback price used when a model is not listed.
//
// PRESET_PRICES below is only a starting point for a fresh account so the
// numbers are useful before anyone opens the settings: verify them against your
// own contract, and edit or delete what does not apply. A model with no price
// (input + output both 0) is reported as "not priced" instead of $0.00.
// ----------------------------------------------------------------------------
import { db } from "./dbx.js";

const PRICE_KEY = (userId) => `ai.prices.${userId}`;

/** USD per 1M tokens. Example starting values — edit them in the app. */
export const PRESET_PRICES = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "mistral-large-latest": { input: 2, output: 6 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  // Newer families added alongside the expanded provider catalog. As with every
  // preset these are only a starting point — edit them in Settings → AI usage.
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-image-1": { input: 5, output: 40 },
  "o3": { input: 2, output: 8 },
  "claude-sonnet-4-1": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "grok-4": { input: 3, output: 15 },
  "command-a-03-2025": { input: 2.5, output: 10 },
  "sonar-pro": { input: 3, output: 15 },
  "llama-3.3-70b": { input: 0.59, output: 0.79 },
  "gpt-oss-120b": { input: 0.15, output: 0.6 },
  "voyage-3-large": { input: 0.18, output: 0 },
  "jina-embeddings-v4": { input: 0.02, output: 0 },
};

function normalizePriceEntry(raw) {
  const input = Number(raw?.input);
  const output = Number(raw?.output);
  return {
    input: Number.isFinite(input) && input >= 0 ? input : 0,
    output: Number.isFinite(output) && output >= 0 ? output : 0,
  };
}

/** A price table as stored: { prices: { model: {input, output} }, fallback: {input, output} } */
function normalizePrices(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const models = {};
  for (const [key, value] of Object.entries(source.prices || {})) {
    const model = String(key || "").trim().toLowerCase();
    if (!model) continue;
    models[model] = normalizePriceEntry(value);
  }
  return { prices: models, fallback: normalizePriceEntry(source.fallback) };
}

/** The account's price table, preset-filled the first time it is read. */
export async function getPriceSettings(userId) {
  if (!userId) return normalizePrices({ prices: PRESET_PRICES });
  let raw = null;
  try {
    raw = await db.storeGet(PRICE_KEY(userId));
  } catch {
    raw = null;
  }
  if (!raw) return normalizePrices({ prices: PRESET_PRICES });
  try {
    return normalizePrices(JSON.parse(raw));
  } catch {
    return normalizePrices({ prices: PRESET_PRICES });
  }
}

export async function savePriceSettings(userId, body) {
  const clean = normalizePrices(body);
  await db.storeSet(PRICE_KEY(userId), JSON.stringify(clean));
  return clean;
}

/**
 * Look a model up in the table. Exact match first, then the longest prefix
 * match (so "gpt-4o-mini-2024-07-18" finds "gpt-4o-mini"), then the fallback.
 */
export function priceForModel(table, model) {
  const key = String(model || "").trim().toLowerCase();
  if (key && table.prices[key]) return table.prices[key];
  let best = null;
  if (key) {
    for (const [candidate, price] of Object.entries(table.prices)) {
      if (candidate && key.startsWith(candidate) && (!best || candidate.length > best.length)) best = { length: candidate.length, price };
    }
  }
  return best ? best.price : table.fallback;
}

function priced(price) {
  return !!price && (price.input > 0 || price.output > 0);
}

/** The cost of one usage record, or null when the model has no price set. */
export function costOfUsage(usage, table) {
  const prompt = Number(usage?.prompt || usage?.promptTokens || 0) || 0;
  const completion = Number(usage?.completion || usage?.completionTokens || 0) || 0;
  if (!prompt && !completion) return null;
  const price = priceForModel(table, usage?.model);
  if (!priced(price)) return null;
  return (prompt / 1_000_000) * price.input + (completion / 1_000_000) * price.output;
}

/**
 * Estimate a finished run's AI cost from its log (every node that called a
 * model carries its own `usage`). Returns { costUsd, priced, calls, tokens } —
 * `costUsd` is null when the run used no priced model.
 */
export function estimateRunCost(result, table) {
  const calls = [];
  for (const entry of result?.log || []) {
    if (entry?.usage) calls.push(entry.usage);
  }
  if (!calls.length && result?.usage) calls.push(result.usage);
  let cost = 0;
  let pricedAny = false;
  let tokens = 0;
  for (const usage of calls) {
    tokens += Number(usage.total || 0) || Number(usage.prompt || 0) + Number(usage.completion || 0);
    const c = costOfUsage(usage, table);
    if (c !== null) {
      cost += c;
      pricedAny = true;
    }
  }
  return {
    costUsd: pricedAny ? Math.round(cost * 1e6) / 1e6 : null,
    priced: pricedAny,
    calls: calls.length,
    tokens,
  };
}
