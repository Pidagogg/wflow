// ----------------------------------------------------------------------------
// W FLOW — Telegram trigger live poller
//
// The "Telegram — New Message" trigger runs the workflow for real bot updates
// when its "Always listen (while the server runs)" option is on. This module
// long-polls the Telegram Bot API (getUpdates):
//
//   - Only workflows whose trigger has live:true AND a bot (a connected bot or
//     a pasted token) are polled. Manual Run from the editor is untouched — it
//     still fires a sample update.
//   - ONE poller per bot token, fanning each update out to every workflow that
//     listens on that bot. Telegram allows a single getUpdates caller per bot;
//     a poller per workflow made two workflows on one bot knock each other off
//     with 409 Conflict.
//   - Cheap when idle: a poller holds one long-poll request open (Telegram
//     answers the moment a message arrives, or after LONG_POLL_SECONDS with
//     nothing) — no busy timers, no per-tick work. A 30 s reconcile pass only
//     starts pollers for new bots and stops those nobody listens to any more.
//   - Updates are acknowledged in order (offset = last update_id + 1) and each
//     update fires at most once, deduped across polls. Errors back off
//     exponentially so a revoked token never hammers the API.
//   - Every fired update counts toward the owner's free-plan daily run cap,
//     exactly like cron / RSS fires and webhook calls (quota.js).
//   - The trigger's "Listen for" setting and chat ID decide which updates
//     fire it.
//   - A trigger set to "Connect as: my Telegram account" is not polled: the
//     account's own connection pushes new messages (server/telegram-accounts.js),
//     one listener per account shared by all its workflows.
//
// Exported for tests: pollTelegramBots() runs one reconcile + polling pass
// with an injectable clock (`now`) and HTTP layer (`callApi`), so the whole
// poller is exercised without a real bot. startTelegramPolling() is what
// server/index.js boots.
//
// Disable with DISABLE_SCHEDULER=1 (same env switch as cron/RSS — the poller
// shares the scheduler's on/off intent; see .env.example).
// ----------------------------------------------------------------------------
import { workflows, hydrateSecretsInWorkflow } from "./store.js";
import { db } from "./dbx.js";
import { runQuota } from "./quota.js";
// Runs are routed: locally, or to the remote runner set up in Setup.
import { executeRouted } from "./runner.js";
import { recordExecution } from "./executions.js";
import { botTokenFor, rememberChat, TELEGRAM_FIELD_KEY } from "./telegram-bots.js";
import { listenAccount, TELEGRAM_ACCOUNT_FIELD } from "./telegram-accounts.js";

// Poller keys for personal accounts ("account:<credential id>"); bot pollers
// are keyed by their token.
const ACCOUNT_KEY = "account:";

const RECONCILE_MS = 30_000;
const POLL_MIN_INTERVAL_MS = 20_000;
const LONG_POLL_SECONDS = 50;
const MAX_BACKOFF_MS = 5 * 60_000;
const TELEGRAM_API = "https://api.telegram.org";

// Per-bot poller state, keyed by the bot token.
//   subs        — [{ wf, node }] workflows listening on this bot right now
//   nextPollAt  — earliest epoch ms the Bot API may be hit again (test pass)
//   offset      — Telegram offset for the next getUpdates call (last seen + 1)
//   lastFired   — update_ids already handled, in case Telegram replays one
//   failures    — consecutive failed calls, for the backoff
//   worker      — { stop } of the long-poll loop in production
const pollers = new Map();

// Which updates the trigger's "Listen for" choices need from Telegram.
const LISTEN_UPDATES = {
  "text messages": ["message"],
  "all messages": ["message"],
  commands: ["message"],
  "button presses": ["callback_query"],
  everything: ["message", "edited_message", "channel_post", "callback_query", "my_chat_member"],
};

function listenFor(c) {
  const v = String(c?.updates || "text messages");
  return LISTEN_UPDATES[v] ? v : "text messages";
}

function liveTriggerNodes(stored) {
  // "Always listen" is opt-in (default false) — a plain saved workflow with the
  // toggle off must never be polled.
  return (stored.nodes || []).filter((n) => n.type === "telegramTrigger" && !!n.data?.config?.live);
}

// Real HTTP layer. Errors are returned as { ok:false, error, status } (never
// thrown) so a network blip only delays the next call.
async function callTelegramApi(method, query) {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${query.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query.params),
      signal: query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout((LONG_POLL_SECONDS + 15) * 1000)]) : AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) return { ok: false, status: Number(body.error_code || res.status), error: String(body?.description || `HTTP ${res.status}`) };
    return { ok: true, result: body.result || [] };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.name === "AbortError" ? "aborted" : err?.message || err) };
  }
}

async function fireUpdate(wf, update) {
  const ownerId = wf.ownerId;
  const quota = await runQuota(ownerId);
  if (!quota.allowed) {
    console.log(
      `  [telegram] skipped "${wf.name}" (${wf.id}) — free-plan owner used all ${quota.limit} daily runs (Pro lifts the cap)`
    );
    return;
  }
  // Credentials live encrypted in the workflow_secrets table — re-inject them
  // so downstream nodes (Send Telegram, AI, …) get the real token.
  const wfWithSecrets = hydrateSecretsInWorkflow(wf, await db.getWorkflowSecrets(wf.id));
  if (quota.limit !== null) await db.bumpRunUsage(ownerId);
  const result = await executeRouted(wfWithSecrets, {
    source: "telegram", // listed as running until recordExecution saves it
    triggerPayload: update,
    maxItemsPerNode: 5,
    userId: ownerId,
  });
  await recordExecution(wf, result, "telegram");
  const failed = (result.log || []).filter((l) => l.status === "error").length;
  console.log(
    `  [telegram] ran "${wf.name}" (${wf.id}) — update ${update.update_id}, ${failed ? `${failed} node(s) failed` : "all nodes OK"} (${result.durationMs} ms)`
  );
}

// The chat an update belongs to (messages, button presses, channel posts).
function chatOf(update) {
  const msg = update?.message || update?.edited_message || update?.channel_post || update?.callback_query?.message;
  return msg?.chat || update?.my_chat_member?.chat || null;
}

// Decide whether one update should fire a trigger with config `c`.
export function updateMatches(update, c) {
  const mode = listenFor(c);
  const msg = update?.message;
  if (mode === "button presses") {
    if (!update?.callback_query) return false;
  } else if (mode === "everything") {
    if (!chatOf(update) && !update?.callback_query) return false;
  } else {
    if (!msg) return false;
    const text = String(msg.text || msg.caption || "");
    if (mode === "text messages" && !text) return false; // nothing to act on
    if (mode === "commands") {
      if (!text.startsWith("/")) return false;
      // "/start@MyBot args" → "/start"
      const cmd = text.split(/\s/)[0].split("@")[0].toLowerCase();
      const want = String(c.command || "").trim().toLowerCase();
      if (want && cmd !== (want.startsWith("/") ? want : `/${want}`)) return false;
    }
  }
  const wantChat = String(c.chatId || "").trim();
  if (wantChat) {
    const chat = chatOf(update);
    if (String(chat?.id ?? "") !== wantChat && Number(chat?.id) !== Number(wantChat)) return false;
  }
  return true;
}

// Every live trigger grouped by bot token: token → [{ wf, node }].
async function collectSubscriptions() {
  const byToken = new Map();
  for (const stored of await workflows.all()) {
    const nodes = liveTriggerNodes(stored);
    if (!nodes.length) continue;
    // In database mode the stored config's botToken is blanked (credentials
    // live encrypted in workflow_secrets) — hydrate to read it.
    const hydrated = hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(stored.id));
    for (const node of nodes) {
      const live = (hydrated.nodes || []).find((n) => n.id === node.id) || node;
      const c = live.data?.config || {};
      // "Connect as: my Telegram account" — listened to over that account's
      // own connection, keyed so it never mixes with bot tokens.
      if (c.connectAs === "account") {
        const accountId = String(c[TELEGRAM_ACCOUNT_FIELD] || "").trim();
        if (!accountId) continue;
        const key = `${ACCOUNT_KEY}${accountId}`;
        if (!byToken.has(key)) byToken.set(key, []);
        byToken.get(key).push({ wf: stored, node: live });
        continue;
      }
      let token = "";
      const botId = String(c[TELEGRAM_FIELD_KEY] || "").trim();
      if (botId) {
        try {
          token = await botTokenFor({ id: botId, userId: stored.ownerId });
        } catch {
          continue; // bot disconnected — nothing to listen on
        }
      } else {
        token = String(c.botToken || "").trim();
      }
      if (!token) continue;
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push({ wf: stored, node: live });
    }
  }
  return byToken;
}

function newState(now) {
  return { subs: [], nextPollAt: now + POLL_MIN_INTERVAL_MS, offset: 0, lastFired: new Set(), failures: 0, worker: null };
}

function allowedUpdates(subs) {
  return [...new Set(subs.flatMap(({ node }) => LISTEN_UPDATES[listenFor(node.data?.config)]))];
}

// One getUpdates call for one bot and the dispatch of what came back. Returns
// false when the call failed (the caller decides how long to back off).
async function pollOnce(token, state, callApi, { timeout = 0, signal } = {}) {
  const res = await callApi("getUpdates", {
    botToken: token,
    signal,
    params: { timeout, offset: Math.max(0, state.offset), allowed_updates: allowedUpdates(state.subs) },
  });
  if (!res.ok) {
    if (res.error !== "aborted" && !/timeout/i.test(String(res.error))) {
      const names = state.subs.map((s) => `"${s.wf.name}"`).join(", ");
      console.error(`  [telegram] ${names} poll failed: ${String(res.error).slice(0, 160)}`);
    }
    return false;
  }
  const updates = Array.isArray(res.result) ? res.result : [];
  let highest = state.offset - 1;
  for (const u of updates) {
    const id = Number(u?.update_id);
    if (!Number.isFinite(id)) continue;
    if (id > highest) highest = id;
    if (state.lastFired.has(id)) continue;
    state.lastFired.add(id);
    const chat = chatOf(u);
    if (chat) rememberChat(token, chat);
    for (const { wf, node } of state.subs) {
      if (!updateMatches(u, node.data?.config || {})) continue;
      try {
        await fireUpdate(wf, u);
      } catch (err) {
        console.error(`  [telegram] "${wf.name}" (${wf.id}) run failed: ${String(err?.message || err).slice(0, 160)}`);
      }
    }
  }
  state.offset = Math.max(state.offset, highest + 1);
  // Cap the dedupe set so long-running pollers don't grow without bound.
  if (state.lastFired.size > 500) state.lastFired = new Set([...state.lastFired].slice(-250));
  return true;
}

function backoffMs(failures) {
  return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, failures - 1));
}

// Sync the poller map with what is saved: new bots get state, bots nobody
// listens to any more are dropped (and their worker stopped).
async function reconcile(now) {
  const byToken = await collectSubscriptions();
  for (const [token, state] of pollers) {
    if (!byToken.has(token)) {
      state.worker?.stop();
      pollers.delete(token);
    }
  }
  for (const [token, subs] of byToken) {
    let state = pollers.get(token);
    if (!state) pollers.set(token, (state = newState(now)));
    state.subs = subs;
  }
}

// One reconcile + polling pass (exported for tests — inject `now` and a fake
// `callApi` to drive it deterministically). Bots are polled concurrently with
// a zero timeout; the first sight of a bot only arms it, so a restart never
// hammers Telegram at boot.
export async function pollTelegramBots({ now = Date.now(), callApi = callTelegramApi } = {}) {
  await reconcile(now);
  await Promise.all(
    [...pollers].map(async ([token, state]) => {
      if (token.startsWith(ACCOUNT_KEY)) return; // accounts push updates; nothing to poll
      if (now < state.nextPollAt) return;
      const ok = await pollOnce(token, state, callApi);
      state.failures = ok ? 0 : state.failures + 1;
      state.nextPollAt = now + (ok ? POLL_MIN_INTERVAL_MS : backoffMs(state.failures));
    })
  );
}

// Production: a long-poll loop per bot. It ends when reconcile() drops the bot.
function startWorker(token, state, callApi = callTelegramApi) {
  const ctl = new AbortController();
  let stopped = false;
  state.worker = {
    stop() {
      stopped = true;
      ctl.abort();
    },
  };
  (async () => {
    // Stagger the first call so a restart does not open every poll at once.
    await sleep(1_000 + Math.random() * 4_000, ctl.signal);
    while (!stopped) {
      const ok = await pollOnce(token, state, callApi, { timeout: LONG_POLL_SECONDS, signal: ctl.signal }).catch(() => false);
      if (stopped) break;
      state.failures = ok ? 0 : state.failures + 1;
      if (!ok) await sleep(backoffMs(state.failures), ctl.signal);
    }
  })();
}

// Production: a personal account pushes new messages over its connection —
// dispatch each to the workflows listening on it, with the same filters,
// dedupe and run caps as a bot.
function startAccountWorker(key, state) {
  const accountId = key.slice(ACCOUNT_KEY.length);
  const ownerId = state.subs[0]?.wf.ownerId;
  let stop = null;
  let stopped = false;
  state.worker = {
    stop() {
      stopped = true;
      stop?.();
    },
  };
  listenAccount({ id: accountId, userId: ownerId }, async (update) => {
    const id = Number(update.update_id);
    const dedupe = `${update.message?.chat?.id}:${id}`;
    if (state.lastFired.has(dedupe)) return;
    state.lastFired.add(dedupe);
    if (state.lastFired.size > 500) state.lastFired = new Set([...state.lastFired].slice(-250));
    for (const { wf, node } of state.subs) {
      if (!updateMatches(update, node.data?.config || {})) continue;
      try {
        await fireUpdate(wf, update);
      } catch (err) {
        console.error(`  [telegram] "${wf.name}" (${wf.id}) run failed: ${String(err?.message || err).slice(0, 160)}`);
      }
    }
  })
    .then((fn) => {
      stop = fn;
      if (stopped) fn();
    })
    .catch((err) => {
      console.error(`  [telegram] account listener could not start: ${String(err?.message || err).slice(0, 160)}`);
      // let the next reconcile pass try again
      if (pollers.get(key) === state) state.worker = null;
    });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

export function startTelegramPolling() {
  if (String(process.env.DISABLE_SCHEDULER || "").trim() === "1") {
    console.log("  [telegram] disabled (DISABLE_SCHEDULER=1)");
    return () => {};
  }
  let busy = false;
  const pass = async () => {
    if (busy) return; // a slow database never stacks reconcile passes
    busy = true;
    try {
      await reconcile(Date.now());
      for (const [token, state] of pollers) {
        if (state.worker) continue;
        if (token.startsWith(ACCOUNT_KEY)) startAccountWorker(token, state);
        else startWorker(token, state);
      }
    } catch (err) {
      console.error(`  [telegram] reconcile error: ${String(err?.message || err)}`);
    } finally {
      busy = false;
    }
  };
  pass();
  const timer = setInterval(pass, RECONCILE_MS);
  timer.unref?.();
  console.log("  [telegram] live Telegram trigger polling active (always-listen triggers only, one long-poll per bot)");
  return () => {
    clearInterval(timer);
    resetTelegramPollers();
  };
}

export function resetTelegramPollers() {
  for (const state of pollers.values()) state.worker?.stop();
  pollers.clear();
}
