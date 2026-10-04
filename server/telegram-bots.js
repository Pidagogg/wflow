// ============================================================================
// Connected Telegram bots — "Connect Telegram" on the Telegram nodes.
//
// Telegram has no OAuth for bots: a bot is a token from @BotFather. Pasting
// that token into every node spreads it through workflow files, so the user
// connects the bot ONCE here instead. The token is checked with getMe, stored
// in the per-user credential vault (user_credentials, AES-256-GCM) with type
// "oauth:telegram" — the "oauth:" prefix makes the vault treat it like every
// other connected account: the list shows the bot's @name, never the token.
//
// Connecting the user's own Telegram account to the bot is the other half:
// the user sends the bot a message, and recentChats() finds that chat so the
// node can fill in its chat ID without anyone copying numbers around.
// ============================================================================
import { db } from "./dbx.js";
import { credentialOwner, withPooledCredentials } from "./team-admin.js";
import { attachCode } from "../shared/errors.js";

export const TELEGRAM_CONN_TYPE = "oauth:telegram";
export const TELEGRAM_FIELD_KEY = "telegramBot";
const TELEGRAM_API = "https://api.telegram.org";
// "123456789:AA…" — digits, colon, 30+ url-safe characters.
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

// ---- Bot API ----

/**
 * One Bot API call. Returns `result`; throws classified errors so the run log
 * can explain them. The token is never part of an error message.
 */
export async function telegramApi(token, method, params = {}, { timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  let res;
  // A FormData body is a file upload — fetch sets the multipart boundary.
  const multipart = typeof FormData !== "undefined" && params instanceof FormData;
  try {
    res = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: multipart ? {} : { "Content-Type": "application/json" },
      body: multipart ? params : JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") throw attachCode(new Error(`Telegram did not answer ${method} in time.`), "HTTP_TIMEOUT");
    throw attachCode(new Error(`Could not reach Telegram (${String(err?.message || err).slice(0, 120)}).`), "HTTP_REQUEST_FAILED");
  }
  const data = await res.json().catch(() => ({}));
  if (data.ok) return data.result;
  const detail = String(data.description || `HTTP ${res.status}`).slice(0, 300);
  const status = Number(data.error_code || res.status);
  if (status === 401 || status === 404) {
    throw attachCode(new Error(`Telegram rejected the bot token (${detail}). Check it with @BotFather, or reconnect the bot.`), "AUTH_FAILED");
  }
  if (status === 429) throw attachCode(new Error(`Telegram rate-limited the bot (${detail}).`), "RATE_LIMITED");
  const err = attachCode(new Error(`Telegram reported an error: ${detail}`), "SERVICE_ERROR");
  err.telegramStatus = status;
  throw err;
}

// ---- chats the bot has seen ----
// The live poller records every chat it receives a message from, so "find my
// chat" works even while the bot is being listened to (Telegram then refuses a
// second getUpdates caller with 409 Conflict).
const seenChats = new Map(); // botId → Map(chatId → chat summary)

function botIdOf(token) {
  return String(token || "").split(":")[0];
}

export function rememberChat(token, chat) {
  if (!chat || chat.id === undefined) return;
  const botId = botIdOf(token);
  let chats = seenChats.get(botId);
  if (!chats) seenChats.set(botId, (chats = new Map()));
  chats.delete(String(chat.id));
  chats.set(String(chat.id), chatSummary(chat));
  // newest last; keep a small window per bot
  if (chats.size > 20) chats.delete(chats.keys().next().value);
}

function chatSummary(chat) {
  const person = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  return {
    id: String(chat.id),
    type: String(chat.type || ""),
    title: String(chat.title || person || chat.username || chat.id),
    username: chat.username ? `@${chat.username}` : "",
  };
}

// ---- the vault ----

function connectionView(cred) {
  const f = cred.fields || {};
  return {
    id: cred.id,
    provider: "telegram",
    email: String(f.email || ""),
    name: cred.name,
    scopes: [],
    extra: f.extra && typeof f.extra === "object" ? f.extra : {},
    updatedAt: cred.updatedAt,
  };
}

export async function listBots(userId) {
  const all = await db.credentialsList(userId);
  const matches = (c) => c.type === TELEGRAM_CONN_TYPE;
  return withPooledCredentials(userId, all.filter(matches).map(connectionView), matches, connectionView);
}

/** Check a pasted token with getMe and store (or refresh) the bot for this user. */
export async function connectBot(userId, rawToken, { fetchImpl } = {}) {
  const token = String(rawToken || "").trim();
  if (!TOKEN_RE.test(token)) {
    throw attachCode(new Error("That does not look like a bot token. It comes from @BotFather and looks like 123456789:AAH…"), "MISSING_CONFIG");
  }
  const me = await telegramApi(token, "getMe", {}, { timeoutMs: 10_000, fetchImpl });
  const handle = me.username ? `@${me.username}` : String(me.first_name || me.id);
  const fields = {
    provider: "telegram",
    email: handle,
    botToken: token,
    extra: { bot: handle, botId: String(me.id) },
  };
  // Reconnecting the same bot (e.g. after /revoke) replaces its token instead
  // of adding a duplicate entry.
  const existing = (await db.credentialsList(userId)).find(
    (c) => c.type === TELEGRAM_CONN_TYPE && String(c.fields?.extra?.botId || "") === String(me.id)
  );
  const name = `Telegram ${handle}`;
  const saved = existing
    ? await db.credentialUpdate(existing.id, userId, { name: existing.name || name, type: TELEGRAM_CONN_TYPE, fields })
    : await db.credentialCreate({ userId, name, type: TELEGRAM_CONN_TYPE, fields });
  return connectionView(saved);
}

/** The token of connected bot `id`, for a run or the poller. */
export async function botTokenFor({ id, userId }) {
  if (!userId) {
    throw attachCode(new Error("This node uses a connected Telegram bot, which only works in a signed-in workspace."), "AUTH_FAILED");
  }
  const cred = await db.credentialGet(String(id), await credentialOwner(id, userId));
  if (!cred || cred.type !== TELEGRAM_CONN_TYPE || !cred.fields?.botToken) {
    throw attachCode(new Error("The Telegram bot picked on this node is no longer connected. Pick or connect it again."), "MISSING_CONFIG");
  }
  return String(cred.fields.botToken);
}

/**
 * Chats that recently wrote to the bot, newest first — how the user links
 * their own Telegram account: message the bot, then pick the chat.
 */
export async function recentChats({ id, userId, fetchImpl }) {
  const token = await botTokenFor({ id, userId });
  const found = new Map(seenChats.get(botIdOf(token)) || []);
  try {
    // offset -100 only peeks: nothing is acknowledged, so a trigger that
    // starts listening later still receives these messages.
    const updates = await telegramApi(token, "getUpdates", { offset: -100, limit: 100, timeout: 0 }, { timeoutMs: 10_000, fetchImpl });
    for (const u of updates || []) {
      const msg = u.message || u.edited_message || u.channel_post || u.callback_query?.message;
      if (msg?.chat) {
        found.delete(String(msg.chat.id));
        found.set(String(msg.chat.id), chatSummary(msg.chat));
      }
    }
  } catch (err) {
    // 409: a live trigger or a webhook owns the updates — the poller's own
    // record above is all we can offer. Anything else is a real failure.
    if (err.telegramStatus !== 409) throw err;
  }
  return [...found.values()].reverse();
}

export function resetSeenChats() {
  seenChats.clear();
}
