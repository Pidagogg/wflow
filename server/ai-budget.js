// ============================================================================
// W FLOW — AI spending control
//
// Every model call a workflow run makes passes through server/ai.js, which
// asks this module first (beforeModelCall) and reports afterwards
// (afterModelCall). That single choke point covers every AI node, saved
// agents and tool rounds alike, without touching the node handlers.
//
//   budgets   — tokens and/or USD per day and per month, for the whole account
//               (Settings → AI usage & cost) and per workflow (Workflow
//               settings → AI budget). "Used" = finished runs since the start
//               of the UTC day / month (the executions table) + this run so
//               far. At 100 % the call is refused with BF-5006; a call never
//               gets more output tokens than the token budget has left.
//   fallback  — optional: from N % of a budget on, calls switch to a cheaper
//               model the user picked, so runs continue for less. The hard
//               stop at 100 % stays.
//   node cap  — optional per AI node: at most N tokens per run for that node.
//   alerts    — crossing 80 % and 100 % of a budget writes a warning into the
//               run's log (Log console) and, when switched on, sends a Telegram
//               message through a bot connected under Credentials. One alert
//               per budget, window and threshold.
//   reuse     — optional per AI node: an identical request (same model,
//               settings and messages) within N hours returns the saved answer
//               and spends no tokens.
//
// Runs happening at the same time are not added to each other's "used" until
// they finish — a budget is a safety net, not an accounting system.
// ============================================================================
import { createHash } from "node:crypto";
import { db } from "./dbx.js";
import { attachCode } from "../shared/errors.js";
import { getPriceSettings, costOfUsage } from "./ai-cost.js";
import { botTokenFor, telegramApi } from "./telegram-bots.js";

const settingsKey = (userId) => `ai.budget.${userId}`;
const notifiedKey = (userId) => `ai.budget.notified.${userId}`;
const cacheKey = (userId, hash) => `ai.cache.${userId}.${hash}`;
const cacheIndexKey = (userId) => `ai.cache.index.${userId}`;
const MAX_CACHE_ENTRIES = 500;
const THRESHOLDS = [80, 100];

// ---- settings ----
const num = (v) => Math.max(0, Number(v) || 0);
const cleanWindow = (w = {}) => ({ tokens: Math.floor(num(w.tokens)), usd: Math.round(num(w.usd) * 10000) / 10000 });

/** Budget limits: { daily: { tokens, usd }, monthly: { tokens, usd } } — 0 = no limit. */
export function normalizeBudget(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = { daily: cleanWindow(raw.daily), monthly: cleanWindow(raw.monthly) };
  const any = out.daily.tokens || out.daily.usd || out.monthly.tokens || out.monthly.usd;
  return any ? out : undefined;
}

export const DEFAULT_ACCOUNT_SETTINGS = {
  daily: { tokens: 0, usd: 0 },
  monthly: { tokens: 0, usd: 0 },
  fallback: { enabled: false, model: "", at: 80 },
  alerts: { telegram: false, botId: "", chatId: "" },
};

export function normalizeAccountSettings(raw = {}) {
  const budget = normalizeBudget(raw) || { daily: { tokens: 0, usd: 0 }, monthly: { tokens: 0, usd: 0 } };
  const fb = raw.fallback || {};
  const al = raw.alerts || {};
  return {
    ...budget,
    fallback: {
      enabled: !!fb.enabled && !!String(fb.model || "").trim(),
      model: String(fb.model || "").trim().slice(0, 120),
      at: Math.min(99, Math.max(1, Math.round(Number(fb.at) || 80))),
    },
    alerts: {
      telegram: !!al.telegram && !!al.botId && !!String(al.chatId || "").trim(),
      botId: String(al.botId || "").slice(0, 80),
      chatId: String(al.chatId || "").trim().slice(0, 40),
    },
  };
}

export async function getAccountSettings(userId) {
  try {
    const raw = await db.storeGet(settingsKey(userId));
    return raw ? normalizeAccountSettings(JSON.parse(raw)) : structuredClone(DEFAULT_ACCOUNT_SETTINGS);
  } catch {
    return structuredClone(DEFAULT_ACCOUNT_SETTINGS);
  }
}

export async function saveAccountSettings(userId, body) {
  const clean = normalizeAccountSettings(body || {});
  await db.storeSet(settingsKey(userId), JSON.stringify(clean));
  return clean;
}

// ---- windows ----
export function windowStart(kind, now = Date.now()) {
  const d = new Date(now);
  return kind === "daily"
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
    : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** What finished runs used in each window: { account: { daily, monthly }, workflow: { daily, monthly } }. */
export async function usedSoFar(ownerId, workflowId, now = Date.now()) {
  const out = { account: {}, workflow: {} };
  for (const kind of ["daily", "monthly"]) {
    const since = windowStart(kind, now);
    out.account[kind] = await db.executionsAiUsageSince(ownerId, since);
    out.workflow[kind] = workflowId ? await db.executionsAiUsageSince(ownerId, since, workflowId) : { tokens: 0, costUsd: 0, runs: 0 };
  }
  return out;
}

/**
 * The run's budget, loaded on its first model call (runs that never call a
 * model never pay for the lookups). `scope` is the run context's `ai` slot.
 */
export async function runBudget(scope) {
  if (!scope) return null;
  if (!scope.promise) scope.promise = loadRunBudget(scope).catch(() => null);
  const b = await scope.promise;
  if (b) {
    b.node = scope.node || null;
    b.logLines = scope.logLines || b.logLines;
  }
  return b;
}

/** Everything a run needs to check its model calls — built once per run. */
export async function loadRunBudget({ ownerId, workflow, logLines }) {
  if (!ownerId) return null;
  const [settings, prices, used] = await Promise.all([getAccountSettings(ownerId), getPriceSettings(ownerId), usedSoFar(ownerId, workflow?.id)]);
  return {
    ownerId: String(ownerId),
    workflowId: workflow?.id || "",
    workflowName: workflow?.name || "",
    settings,
    workflowBudget: normalizeBudget(workflow?.aiBudget),
    prices,
    used,
    run: { tokens: 0, costUsd: 0 },
    nodes: new Map(), // nodeId → tokens this run
    node: null, // the node currently running: { id, label, config }
    logLines: logLines || null,
  };
}

// ---- checks ----
/** Every configured limit with how much of it is used: [{ scope, window, unit, limit, used, pct }]. */
export function budgetStatus(b) {
  const out = [];
  const add = (scope, kind, limits, used) => {
    if (!limits) return;
    const w = limits[kind] || {};
    const tokens = used[kind].tokens + b.run.tokens;
    const usd = used[kind].costUsd + b.run.costUsd;
    if (w.tokens) out.push({ scope, window: kind, unit: "tokens", limit: w.tokens, used: tokens, pct: (tokens / w.tokens) * 100 });
    if (w.usd) out.push({ scope, window: kind, unit: "usd", limit: w.usd, used: usd, pct: (usd / w.usd) * 100 });
  };
  for (const kind of ["daily", "monthly"]) {
    add("account", kind, b.settings, b.used.account);
    add("workflow", kind, b.workflowBudget, b.used.workflow);
  }
  return out;
}

const fmt = (s) => (s.unit === "usd" ? `$${s.used.toFixed(4)} of $${s.limit}` : `${Math.round(s.used).toLocaleString("en")} of ${s.limit.toLocaleString("en")} tokens`);
const label = (s, b) => `${s.scope === "account" ? "account" : `workflow “${b.workflowName}”`} ${s.window === "daily" ? "daily" : "monthly"} budget`;

// The run's console lines are plain text ("[node] message"), shown in the Log console.
function log(b, level, message) {
  const mark = level === "error" ? "⛔" : level === "warn" ? "⚠" : "ℹ";
  if (b.logLines) b.logLines.push(`[${b.node?.label || "AI budget"}] ${mark} ${message}`);
}

/**
 * Called before every model call of a run. Returns the config to use (maybe
 * with a cheaper model and fewer output tokens) or throws BF-5006.
 */
export async function beforeModelCall(b, cfg) {
  if (!b) return cfg;
  const next = { ...cfg };
  const status = budgetStatus(b);
  const over = status.find((s) => s.pct >= 100);
  if (over) {
    await announce(b, over, 100);
    throw attachCode(new Error(`The ${label(over, b)} is used up (${fmt(over)}) — the model was not called. Raise the limit or wait for the next ${over.window === "daily" ? "day" : "month"}.`), "AI_BUDGET_EXCEEDED");
  }
  for (const s of status) if (s.pct >= 80) await announce(b, s, 80);

  // The node's own cap for this run.
  const cap = Math.floor(num(b.node?.config?.maxRunTokens));
  if (cap) {
    const usedByNode = b.nodes.get(b.node.id) || 0;
    if (usedByNode >= cap) {
      throw attachCode(new Error(`“${b.node.label}” reached its cap of ${cap.toLocaleString("en")} tokens for this run — the model was not called again.`), "AI_BUDGET_EXCEEDED");
    }
    next.maxTokens = Math.max(1, Math.min(Number(next.maxTokens) || 1024, cap - usedByNode));
  }
  // Never ask for more output than the tightest token budget has left.
  for (const s of status) {
    if (s.unit !== "tokens") continue;
    next.maxTokens = Math.max(1, Math.min(Number(next.maxTokens) || 1024, Math.floor(s.limit - s.used)));
  }
  // Cheaper model once a budget is nearly used up.
  const fb = b.settings.fallback;
  if (fb.enabled && fb.model && fb.model !== next.model) {
    const near = status.find((s) => s.pct >= fb.at);
    if (near) {
      if (!b.fallbackLogged) {
        log(b, "warn", `AI budget: the ${label(near, b)} is at ${Math.floor(near.pct)} % — using the cheaper model ${fb.model} instead of ${next.model || "the configured model"}.`);
        b.fallbackLogged = true;
      }
      next.model = fb.model;
    }
  }
  return next;
}

/** Called after every model call with what it used. */
export async function afterModelCall(b, cfg, rawUsage) {
  if (!b || !rawUsage) return;
  const prompt = Number(rawUsage.prompt ?? rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0) || 0;
  const completion = Number(rawUsage.completion ?? rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0) || 0;
  const tokens = Number(rawUsage.total ?? rawUsage.total_tokens ?? 0) || prompt + completion;
  if (!tokens) return;
  const cost = costOfUsage({ prompt, completion, model: cfg.model }, b.prices) || 0;
  b.run.tokens += tokens;
  b.run.costUsd += cost;
  if (b.node) b.nodes.set(b.node.id, (b.nodes.get(b.node.id) || 0) + tokens);
  for (const s of budgetStatus(b)) {
    if (s.pct >= 100) await announce(b, s, 100);
    else if (s.pct >= 80) await announce(b, s, 80);
  }
}

// ---- alerts ----
// Once per (budget, window period, threshold): the key carries the period
// start, so a new day or month can alert again.
async function announce(b, s, threshold) {
  const period = windowStart(s.window).slice(0, s.window === "daily" ? 10 : 7);
  const id = `${s.scope}:${s.scope === "workflow" ? b.workflowId : ""}:${s.window}:${s.unit}:${period}:${threshold}`;
  let seen = {};
  try {
    seen = JSON.parse((await db.storeGet(notifiedKey(b.ownerId))) || "{}");
  } catch {
    seen = {};
  }
  const text =
    threshold >= 100
      ? `AI budget reached: the ${label(s, b)} is used up (${fmt(s)}). Model calls are refused until it resets or the limit is raised.`
      : `AI budget warning: the ${label(s, b)} is at ${Math.floor(s.pct)} % (${fmt(s)}).`;
  // The run log always says it (it is what the user is looking at).
  if (!b.announced?.has(id)) {
    (b.announced ||= new Set()).add(id);
    log(b, threshold >= 100 ? "error" : "warn", text);
  }
  if (seen[id]) return;
  // Keep the set small: only this and the previous periods matter.
  const keep = Object.fromEntries(Object.entries(seen).filter(([k]) => k.includes(period)));
  keep[id] = new Date().toISOString();
  await db.storeSet(notifiedKey(b.ownerId), JSON.stringify(keep));
  const al = b.settings.alerts;
  if (al.telegram) {
    try {
      const token = await botTokenFor({ id: al.botId, userId: b.ownerId });
      if (token) await telegramApi(token, "sendMessage", { chat_id: al.chatId, text: `W flow — ${text}` });
    } catch (err) {
      log(b, "warn", `AI budget alert could not be sent to Telegram: ${String(err?.message || err)}`);
    }
  }
}

// ---- reusing identical answers ----
export function requestHash(ownerId, cfg, messages, opts = {}) {
  const payload = JSON.stringify({ p: cfg.provider, u: cfg.baseUrl, m: cfg.model, t: cfg.temperature, x: cfg.maxTokens, j: !!cfg.jsonMode, msgs: messages, tools: (opts.tools || []).map((t) => t.name) });
  return createHash("sha256").update(`${ownerId}\n${payload}`).digest("hex");
}

/** The saved answer for an identical request, when the node reuses answers and it is fresh. */
export async function cachedAnswer(b, hash) {
  if (!b?.node?.config?.reuseAnswers) return null;
  try {
    const raw = await db.storeGet(cacheKey(b.ownerId, hash));
    if (!raw) return null;
    const hit = JSON.parse(raw);
    const ttlMs = Math.max(1, Number(b.node.config.reuseHours) || 24) * 3600_000;
    if (Date.now() - Date.parse(hit.at) > ttlMs) return null;
    log(b, "info", `Reused a saved answer (identical request from ${hit.at}) — no tokens spent.`);
    return hit.response;
  } catch {
    return null;
  }
}

export async function saveAnswer(b, hash, response) {
  if (!b?.node?.config?.reuseAnswers || !response || response.toolCalls?.length) return;
  try {
    await db.storeSet(cacheKey(b.ownerId, hash), JSON.stringify({ at: new Date().toISOString(), response: { text: response.text, toolCalls: [], usage: null, finishReason: response.finishReason } }));
    // Bounded: the oldest entries are forgotten first.
    let index = [];
    try {
      index = JSON.parse((await db.storeGet(cacheIndexKey(b.ownerId))) || "[]");
    } catch {
      index = [];
    }
    index = [...index.filter((h) => h !== hash), hash];
    while (index.length > MAX_CACHE_ENTRIES) await db.storeSet(cacheKey(b.ownerId, index.shift()), "");
    await db.storeSet(cacheIndexKey(b.ownerId), JSON.stringify(index));
  } catch {
    /* reuse is an optimisation — never fail the call over it */
  }
}

/** Erase everything this module keeps for an account (account deletion). */
export async function forgetAccount(userId) {
  let index = [];
  try {
    index = JSON.parse((await db.storeGet(cacheIndexKey(userId))) || "[]");
  } catch {
    index = [];
  }
  for (const hash of index) await db.storeSet(cacheKey(userId, hash), "");
  for (const key of [cacheIndexKey(userId), settingsKey(userId), notifiedKey(userId)]) await db.storeSet(key, "");
}
