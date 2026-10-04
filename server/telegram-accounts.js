// ============================================================================
// Connected Telegram accounts — send and receive as the person, not a bot.
//
// A bot uses the HTTP Bot API; a personal account can only talk MTProto,
// Telegram's own client protocol. This module is the one place that uses a
// client library for it (GramJS, package "telegram") — there is no HTTP API
// for personal accounts, so plain fetch cannot do it.
//
// Connecting: phone number → code Telegram sends → 2-step password (when set),
// or a QR code scanned in the Telegram app (no code to deliver) → password,
// through the instance's own Telegram app (see appCredentials; users enter
// their own API ID + hash only when the operator has not configured one). The resulting session string is a full login, so it lives only in the
// encrypted credential vault (type "oauth:telegram-user"; the "oauth:" prefix
// keeps it masked like every other connected account) and is never returned
// to the browser. Disconnecting logs the session out at Telegram too.
//
// Runtime: one MTProto connection per connected account, shared by every node
// and trigger that uses it; idle connections close after IDLE_MS, listening
// ones stay open. Chat IDs use the Bot API's format ({{message.chat.id}}), so a
// workflow can switch between a bot and an account without other changes.
// ============================================================================
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { CustomFile } from "telegram/client/uploads.js";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { db } from "./dbx.js";
import { credentialOwner, withPooledCredentials } from "./team-admin.js";
import { attachCode } from "../shared/errors.js";

export const TELEGRAM_ACCOUNT_TYPE = "oauth:telegram-user";
export const TELEGRAM_ACCOUNT_FIELD = "telegramAccount";
const LOGIN_TTL_MS = 10 * 60_000;
const IDLE_MS = 10 * 60_000;
const quiet = () => new Logger(LogLevel.NONE);

function newClient(session, apiId, apiHash) {
  return new TelegramClient(new StringSession(session || ""), Number(apiId), String(apiHash), {
    connectionRetries: 3,
    baseLogger: quiet(),
    // no "update the app" prompts or device noise in the account's session list
    deviceModel: "W flow",
    appVersion: "1.0",
  });
}

// Telegram reports errors as RPC codes; turn the common ones into sentences.
function friendly(err) {
  const code = String(err?.errorMessage || err?.message || err);
  const map = {
    PHONE_NUMBER_INVALID: "That phone number is not valid. Use the international format, e.g. +491701234567.",
    PHONE_CODE_INVALID: "That code is not right. Check the code Telegram sent and try again.",
    PHONE_CODE_EXPIRED: "The code has expired. Start again to get a new one.",
    PASSWORD_HASH_INVALID: "That 2-step verification password is not right.",
    API_ID_INVALID: "Telegram does not accept this API ID / API hash. Copy both again from my.telegram.org → API development tools (for the site-wide app: admin panel → Auth & e-mail → Telegram).",
    PHONE_NUMBER_BANNED: "Telegram has banned this phone number.",
    AUTH_KEY_UNREGISTERED: "This Telegram login was ended (logged out on another device). Connect the account again.",
    SESSION_REVOKED: "This Telegram login was ended (logged out on another device). Connect the account again.",
    USER_DEACTIVATED: "This Telegram account is deactivated.",
    CHAT_WRITE_FORBIDDEN: "Your account is not allowed to write in this chat.",
    PEER_ID_INVALID: "Telegram does not know this chat for your account. Use @username, or open the chat once in Telegram.",
    MESSAGE_ID_INVALID: "There is no message with that ID in this chat.",
    MESSAGE_NOT_MODIFIED: "The new text is the same as the old one.",
  };
  if (map[code]) return attachCode(new Error(map[code]), /AUTH|SESSION|API_ID/.test(code) ? "AUTH_FAILED" : "SERVICE_ERROR");
  if (/FLOOD_WAIT_(\d+)/.test(code) || err?.seconds) {
    const secs = err?.seconds || Number(code.match(/FLOOD_WAIT_(\d+)/)?.[1] || 0);
    return attachCode(new Error(`Telegram asks to slow down — try again in ${secs} s. (Sending many messages from a personal account can get it banned.)`), "RATE_LIMITED");
  }
  return attachCode(new Error(`Telegram reported an error: ${code.slice(0, 200)}`), "SERVICE_ERROR");
}

// ---- logging in ----

// loginId → { userId, client, phone, phoneCodeHash, apiId, apiHash, timer }
const pendingLogins = new Map();

function dropLogin(loginId) {
  const p = pendingLogins.get(loginId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingLogins.delete(loginId);
  p.client.disconnect().catch(() => {});
}

// ---- the instance's Telegram app ----
// MTProto has no login without an api_id/api_hash — every Telegram client
// ships one. The operator registers ONE app at my.telegram.org (admin panel →
// Auth & e-mail → Telegram, or TELEGRAM_API_ID / TELEGRAM_API_HASH) and every
// user logs in through it with just a phone number, like in the Telegram app.
// Without it, users fall back to entering their own pair.
export const TELEGRAM_APP_KEYS = { apiId: "telegram.apiId", apiHash: "telegram.apiHash" };

async function settingOrEnv(key, envKey) {
  try {
    const stored = await db.storeGet(key);
    if (stored) return String(stored).trim();
  } catch {
    /* store hiccup — fall back to env */
  }
  return String(process.env[envKey] || "").trim();
}

/** The instance-wide { apiId, apiHash }, or null when none is configured. */
export async function appCredentials() {
  const [apiId, apiHash] = await Promise.all([
    settingOrEnv(TELEGRAM_APP_KEYS.apiId, "TELEGRAM_API_ID"),
    settingOrEnv(TELEGRAM_APP_KEYS.apiHash, "TELEGRAM_API_HASH"),
  ]);
  return /^\d{3,12}$/.test(apiId) && /^[a-f0-9]{32}$/i.test(apiHash) ? { apiId, apiHash } : null;
}

/** Step 1: check the API credentials and have Telegram send a login code. */
export async function startLogin(userId, { apiId, apiHash, phone }) {
  // The instance's app wins: users only type their phone number. A pair typed
  // by the user is only used when the operator has not set one up.
  const app = await appCredentials();
  const id = app ? app.apiId : String(apiId ?? "").trim();
  const hash = app ? app.apiHash : String(apiHash ?? "").trim();
  const number = String(phone ?? "").replace(/[\s()-]/g, "");
  if (!/^\d{3,12}$/.test(id)) throw attachCode(new Error("The API ID is a number from my.telegram.org → API development tools."), "MISSING_CONFIG");
  if (!/^[a-f0-9]{32}$/i.test(hash)) throw attachCode(new Error("The API hash is the 32-character code next to the API ID on my.telegram.org."), "MISSING_CONFIG");
  if (!/^\+?\d{6,16}$/.test(number)) throw attachCode(new Error("Enter your phone number in the international format, e.g. +491701234567."), "MISSING_CONFIG");
  // one login at a time per user
  for (const [key, p] of pendingLogins) if (p.userId === String(userId)) dropLogin(key);

  const client = newClient("", id, hash);
  try {
    await client.connect();
    // auth.sendCode directly, not client.sendCode(): GramJS folds every
    // delivery method into "app or not", so a code sent by e-mail — or
    // Telegram asking for a login e-mail first — looked like an SMS that never
    // came. The real type tells the form where to look.
    const sent = await sendCodeRequest(client, { apiId: Number(id), apiHash: hash }, number);
    const loginId = crypto.randomUUID();
    const timer = setTimeout(() => dropLogin(loginId), LOGIN_TTL_MS);
    timer.unref?.();
    const p = { userId: String(userId), client, phone: number, phoneCodeHash: sent.phoneCodeHash, apiId: id, apiHash: hash, timer, delivery: null };
    pendingLogins.set(loginId, p);
    p.delivery = describeSentCode(sent);
    return { loginId, delivery: p.delivery, viaApp: p.delivery.kind === "app" };
  } catch (err) {
    client.disconnect().catch(() => {});
    throw friendly(err);
  }
}

async function sendCodeRequest(client, { apiId, apiHash }, phoneNumber) {
  try {
    const sent = await client.invoke(new Api.auth.SendCode({ phoneNumber, apiId, apiHash, settings: new Api.CodeSettings({}) }));
    if (sent instanceof Api.auth.SentCodeSuccess) throw new Error("Telegram logged in without a code — start again.");
    return sent;
  } catch (err) {
    if (err?.errorMessage === "AUTH_RESTART") return sendCodeRequest(client, { apiId, apiHash }, phoneNumber);
    throw err;
  }
}

// Where Telegram sent the code, in words for the form. `canResend` is set when
// Telegram offers another way (auth.resendCode), e.g. SMS after the app.
function nextWay(nextType) {
  if (!nextType) return "";
  if (nextType instanceof Api.auth.CodeTypeSms) return "by SMS";
  if (nextType instanceof Api.auth.CodeTypeCall) return "by a phone call";
  if (nextType instanceof Api.auth.CodeTypeFlashCall || nextType instanceof Api.auth.CodeTypeMissedCall) return "by a missed call";
  if (nextType instanceof Api.auth.CodeTypeFragmentSms) return "through Fragment";
  return "another way";
}

export function describeSentCode(sent) {
  const t = sent.type;
  const next = nextWay(sent.nextType);
  const base = { canResend: !!sent.nextType, nextWay: next, timeout: Number(sent.timeout || 0) };
  if (t instanceof Api.auth.SentCodeTypeApp) {
    return { ...base, kind: "app", message: "Telegram sent the code to your Telegram app — open the chat named “Telegram” (blue tick) on any device where you are logged in." };
  }
  if (t instanceof Api.auth.SentCodeTypeSms || t instanceof Api.auth.SentCodeTypeSmsWord || t instanceof Api.auth.SentCodeTypeSmsPhrase || t instanceof Api.auth.SentCodeTypeFirebaseSms) {
    return { ...base, kind: "sms", message: "Telegram sent the code by SMS to your phone." };
  }
  if (t instanceof Api.auth.SentCodeTypeCall) return { ...base, kind: "call", message: "Telegram is calling your phone — the code is read out in the call." };
  if (t instanceof Api.auth.SentCodeTypeFlashCall || t instanceof Api.auth.SentCodeTypeMissedCall) {
    const prefix = t.prefix ? ` It starts with ${t.prefix}; the code is the last ${t.length} digits of the number that called.` : " The code is the last digits of the number that called.";
    return { ...base, kind: "call", message: `Telegram gives you a missed call.${prefix}` };
  }
  if (t instanceof Api.auth.SentCodeTypeEmailCode) {
    return { ...base, kind: "email", message: `Telegram sent the code to your login e-mail (${t.emailPattern}). Check the spam folder too.` };
  }
  if (t instanceof Api.auth.SentCodeTypeSetUpEmailRequired) {
    return { ...base, kind: "setupEmail", message: "Telegram wants a login e-mail on your account before it sends codes to apps. Enter an e-mail address — Telegram mails a code to confirm it." };
  }
  if (t instanceof Api.auth.SentCodeTypeFragmentSms) {
    return { ...base, kind: "fragment", url: t.url, message: "Your number is an anonymous Fragment number — the code arrives on fragment.com." };
  }
  return { ...base, kind: "unknown", message: "Telegram sent a login code. Check your Telegram app, SMS and e-mail." };
}

function pendingFor(userId, loginId) {
  const p = pendingLogins.get(String(loginId || ""));
  if (!p || p.userId !== String(userId)) throw attachCode(new Error("This login has expired. Start again to get a new code."), "MISSING_CONFIG");
  return p;
}

/** Ask Telegram to send the code the next way it offers (e.g. SMS after the app). */
export async function resendCode(userId, { loginId }) {
  const p = pendingFor(userId, loginId);
  try {
    const sent = await p.client.invoke(new Api.auth.ResendCode({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash }));
    if (sent instanceof Api.auth.SentCodeSuccess) throw new Error("Telegram logged in without a code — start again.");
    p.phoneCodeHash = sent.phoneCodeHash;
    p.delivery = describeSentCode(sent);
    return { delivery: p.delivery };
  } catch (err) {
    if (String(err?.errorMessage || "") === "SEND_CODE_UNAVAILABLE") {
      throw attachCode(new Error("Telegram has no other way to send the code right now. Wait a few minutes and start again."), "SERVICE_ERROR");
    }
    throw err?._bfCode ? err : friendly(err);
  }
}

/** Telegram asked for a login e-mail first: send a confirmation code to it. */
export async function setupLoginEmail(userId, { loginId, email }) {
  const p = pendingFor(userId, loginId);
  const address = String(email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw attachCode(new Error("Enter a valid e-mail address."), "MISSING_CONFIG");
  try {
    const purpose = new Api.EmailVerifyPurposeLoginSetup({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash });
    const res = await p.client.invoke(new Api.account.SendVerifyEmailCode({ purpose, email: address }));
    p.setupEmail = address;
    return { emailPattern: res.emailPattern || address };
  } catch (err) {
    throw err?._bfCode ? err : friendly(err);
  }
}

/** Confirm the login e-mail with the code Telegram mailed; Telegram then sends the login code. */
export async function verifyLoginEmail(userId, { loginId, code }) {
  const p = pendingFor(userId, loginId);
  try {
    const purpose = new Api.EmailVerifyPurposeLoginSetup({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash });
    const res = await p.client.invoke(
      new Api.account.VerifyEmail({ purpose, verification: new Api.EmailVerificationCode({ code: String(code || "").trim() }) })
    );
    if (res instanceof Api.account.EmailVerifiedLogin && res.sentCode instanceof Api.auth.SentCode) {
      p.phoneCodeHash = res.sentCode.phoneCodeHash;
      p.delivery = describeSentCode(res.sentCode);
    } else {
      p.delivery = { kind: "email", canResend: false, nextWay: "", timeout: 0, message: `Telegram sent the login code to ${p.setupEmail || "your e-mail"}.` };
    }
    return { delivery: p.delivery };
  } catch (err) {
    const code = String(err?.errorMessage || "");
    if (code === "CODE_INVALID" || code === "EMAIL_VERIFY_EXPIRED") {
      throw attachCode(new Error("That e-mail code is not right or has expired. Check the latest mail from Telegram."), "AUTH_FAILED");
    }
    throw err?._bfCode ? err : friendly(err);
  }
}

/**
 * Step 2: the code (and, when the account has one, the 2-step password).
 * Returns { needPassword: true } when Telegram asks for the password.
 */
export async function finishLogin(userId, { loginId, code, password }) {
  const p = pendingFor(userId, loginId);
  const creds = { apiId: Number(p.apiId), apiHash: p.apiHash };
  const typed = String(code || "").replace(/\s/g, "");
  try {
    if (password) {
      await p.client.signInWithPassword(creds, {
        password: async () => String(password),
        onError: async (err) => {
          throw err;
        },
      });
    } else {
      // A code Telegram mailed goes in as an e-mail verification, not a phone code.
      const res = await p.client.invoke(
        p.delivery?.kind === "email"
          ? new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, emailVerification: new Api.EmailVerificationCode({ code: typed }) })
          : new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: typed })
      );
      if (res instanceof Api.auth.AuthorizationSignUpRequired) {
        dropLogin(loginId);
        throw attachCode(new Error("There is no Telegram account for this phone number yet — sign up in the Telegram app first."), "MISSING_CONFIG");
      }
    }
  } catch (err) {
    if (String(err?.errorMessage || "") === "SESSION_PASSWORD_NEEDED") return { needPassword: true };
    throw err?._bfCode ? err : friendly(err);
  }
  return saveLogin(userId, loginId, p);
}

/** The login went through (code, password or QR): store the session. */
async function saveLogin(userId, loginId, p) {
  const me = await p.client.getMe();
  const handle = me.username ? `@${me.username}` : [me.firstName, me.lastName].filter(Boolean).join(" ") || String(me.id);
  const fields = {
    provider: "telegram-user",
    email: handle,
    apiId: p.apiId,
    apiHash: p.apiHash,
    session: p.client.session.save(),
    extra: { account: handle, userId: String(me.id) },
  };
  // Logging in to the same account again replaces its session.
  const existing = (await db.credentialsList(userId)).find(
    (c) => c.type === TELEGRAM_ACCOUNT_TYPE && String(c.fields?.extra?.userId || "") === String(me.id)
  );
  const name = `Telegram account ${handle}`;
  const saved = existing
    ? await db.credentialUpdate(existing.id, userId, { name: existing.name || name, type: TELEGRAM_ACCOUNT_TYPE, fields })
    : await db.credentialCreate({ userId, name, type: TELEGRAM_ACCOUNT_TYPE, fields });
  // keep the fresh connection for the first run instead of reconnecting
  clearTimeout(p.timer);
  pendingLogins.delete(loginId);
  if (existing) await release(existing.id, { force: true });
  pool.set(saved.id, { client: p.client, listeners: 0, idle: null });
  scheduleIdle(saved.id);
  return { account: accountView(saved) };
}

// ---- logging in with a QR code ----
// No code has to be delivered: the form shows a QR code (tg://login?token=…)
// and the user scans it in the Telegram app (Settings → Devices → Link
// Desktop Device) — the same way Telegram Desktop and Web log in. The browser
// polls qrStatus(); Telegram announces the scan with UpdateLoginToken, then
// exporting the token again yields the authorization. A 2-step password, when
// set, goes through finishLogin({ password }) like after a phone code.

async function exportQr(p) {
  const res = await p.client.invoke(new Api.auth.ExportLoginToken({ apiId: Number(p.apiId), apiHash: p.apiHash, exceptIds: [] }));
  if (res instanceof Api.auth.LoginToken) {
    const url = `tg://login?token=${Buffer.from(res.token).toString("base64url")}`;
    p.qr = { url, expires: Number(res.expires) * 1000, image: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
    return { waiting: true };
  }
  if (res instanceof Api.auth.LoginTokenMigrateTo) {
    // the account lives on another data center: finish the login there
    await p.client._switchDC(res.dcId);
    const moved = await p.client.invoke(new Api.auth.ImportLoginToken({ token: res.token }));
    if (moved instanceof Api.auth.LoginTokenSuccess) return { done: true };
    throw new Error("Telegram did not finish the QR login — try again.");
  }
  if (res instanceof Api.auth.LoginTokenSuccess) return { done: true };
  throw new Error("Telegram did not finish the QR login — try again.");
}

const qrView = (p) => ({ qr: p.qr.image, url: p.qr.url, expiresIn: Math.max(0, Math.round((p.qr.expires - Date.now()) / 1000)) });

/** Start a QR login: returns { loginId, qr (PNG data URL), url, expiresIn }. */
export async function startQrLogin(userId, { apiId, apiHash } = {}) {
  const app = await appCredentials();
  const id = app ? app.apiId : String(apiId ?? "").trim();
  const hash = app ? app.apiHash : String(apiHash ?? "").trim();
  if (!/^\d{3,12}$/.test(id)) throw attachCode(new Error("The API ID is a number from my.telegram.org → API development tools."), "MISSING_CONFIG");
  if (!/^[a-f0-9]{32}$/i.test(hash)) throw attachCode(new Error("The API hash is the 32-character code next to the API ID on my.telegram.org."), "MISSING_CONFIG");
  for (const [key, old] of pendingLogins) if (old.userId === String(userId)) dropLogin(key);

  const client = newClient("", id, hash);
  try {
    await client.connect();
    const loginId = crypto.randomUUID();
    const timer = setTimeout(() => dropLogin(loginId), LOGIN_TTL_MS);
    timer.unref?.();
    const p = { userId: String(userId), client, phone: "", phoneCodeHash: "", apiId: id, apiHash: hash, timer, delivery: null, qr: null, scanned: false };
    // Telegram pushes UpdateLoginToken the moment the code is scanned.
    client.addEventHandler((update) => {
      if (update instanceof Api.UpdateLoginToken) p.scanned = true;
    });
    pendingLogins.set(loginId, p);
    await exportQr(p);
    return { loginId, ...qrView(p) };
  } catch (err) {
    client.disconnect().catch(() => {});
    throw err?._bfCode ? err : friendly(err);
  }
}

/**
 * Poll a QR login: { waiting, qr, url, expiresIn } until the code is scanned,
 * then { account } — or { needPassword } when the account has a 2-step password.
 * An expired code is replaced by a fresh one.
 */
export async function qrStatus(userId, { loginId }) {
  const p = pendingFor(userId, loginId);
  if (!p.qr) throw attachCode(new Error("This is not a QR login. Start again."), "MISSING_CONFIG");
  // Before the scan, exporting again would only rotate the code under the
  // user's camera, so it is refreshed only when it is about to expire.
  if (!p.scanned && Date.now() < p.qr.expires - 5000) return { waiting: true, ...qrView(p) };
  try {
    const res = await exportQr(p);
    if (res.done) return saveLogin(userId, loginId, p);
    return { waiting: true, ...qrView(p) };
  } catch (err) {
    if (String(err?.errorMessage || "") === "SESSION_PASSWORD_NEEDED") return { needPassword: true };
    throw err?._bfCode ? err : friendly(err);
  }
}

function accountView(cred) {
  const f = cred.fields || {};
  return { id: cred.id, provider: "telegram-user", email: String(f.email || ""), name: cred.name, scopes: [], extra: f.extra || {}, updatedAt: cred.updatedAt };
}

export async function listAccounts(userId) {
  const matches = (c) => c.type === TELEGRAM_ACCOUNT_TYPE;
  const own = (await db.credentialsList(userId)).filter(matches).map(accountView);
  return withPooledCredentials(userId, own, matches, accountView);
}

// ---- the connection pool ----

// credentialId → { client, listeners, idle }
const pool = new Map();

function scheduleIdle(credId) {
  const entry = pool.get(credId);
  if (!entry) return;
  clearTimeout(entry.idle);
  if (entry.listeners > 0) return; // a live trigger keeps it open
  entry.idle = setTimeout(() => release(credId, { force: true }), IDLE_MS);
  entry.idle.unref?.();
}

async function release(credId, { force = false } = {}) {
  const entry = pool.get(credId);
  if (!entry || (!force && entry.listeners > 0)) return;
  clearTimeout(entry.idle);
  pool.delete(credId);
  await entry.client.disconnect().catch(() => {});
}

/** A connected client for account `id` of `userId` (reused while it is warm). */
export async function clientFor({ id, userId }) {
  if (!userId) throw attachCode(new Error("This node uses a connected Telegram account, which only works in a signed-in workspace."), "AUTH_FAILED");
  const cred = await db.credentialGet(String(id), await credentialOwner(id, userId));
  if (!cred || cred.type !== TELEGRAM_ACCOUNT_TYPE || !cred.fields?.session) {
    throw attachCode(new Error("The Telegram account picked on this node is no longer connected. Pick or connect it again."), "MISSING_CONFIG");
  }
  let entry = pool.get(cred.id);
  if (!entry) {
    const client = newClient(cred.fields.session, cred.fields.apiId, cred.fields.apiHash);
    try {
      await client.connect();
    } catch (err) {
      throw friendly(err);
    }
    entry = { client, listeners: 0, idle: null };
    pool.set(cred.id, entry);
  }
  scheduleIdle(cred.id);
  return entry.client;
}

/** Log the session out at Telegram and forget the connection (Disconnect). */
export async function logoutAccount(cred) {
  if (cred?.type !== TELEGRAM_ACCOUNT_TYPE) return;
  try {
    const client = pool.get(cred.id)?.client || newClient(cred.fields?.session, cred.fields?.apiId, cred.fields?.apiHash);
    if (!client.connected) await client.connect();
    await client.invoke(new Api.auth.LogOut());
  } catch {
    /* best effort — the vault entry is deleted either way */
  }
  await release(cred.id, { force: true });
}

// ---- chats ----

/** "me", @username, a t.me link or a numeric (Bot API style) chat ID → peer. */
async function peerFor(client, raw) {
  const v = String(raw ?? "").trim();
  if (!v) throw attachCode(new Error("Chat ID is empty — fill it in on the node (\"me\" sends to your Saved Messages)."), "MISSING_CONFIG");
  if (/^(me|self|saved)$/i.test(v)) return "me";
  const link = v.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})/);
  if (link) return `@${link[1]}`;
  if (!/^-?\d+$/.test(v)) return v; // @username or phone
  try {
    return await client.getInputEntity(BigInt(v));
  } catch {
    // A fresh connection has not seen this chat yet — reading the dialog list
    // teaches the client every chat the account is in.
    await client.getDialogs({ limit: 200 });
    try {
      return await client.getInputEntity(BigInt(v));
    } catch (err) {
      throw friendly({ errorMessage: "PEER_ID_INVALID" });
    }
  }
}

function chatShape(entity, id) {
  const person = [entity?.firstName, entity?.lastName].filter(Boolean).join(" ");
  const type = entity?.className === "User" ? "private" : entity?.broadcast ? "channel" : entity?.megagroup ? "supergroup" : "group";
  return { id: String(id ?? ""), type, title: String(entity?.title || person || entity?.username || id), username: entity?.username ? `@${entity.username}` : "" };
}

/** The account's most recent chats — for "Find my chat" on a node. */
export async function recentAccountChats({ id, userId }) {
  const client = await clientFor({ id, userId });
  try {
    const dialogs = await client.getDialogs({ limit: 25 });
    return dialogs.map((d) => chatShape(d.entity, d.id?.toString()));
  } catch (err) {
    throw friendly(err);
  }
}

// ---- sending (the Telegram action nodes, "Connect as: my account") ----

export const ACCOUNT_NODE_TYPES = new Set([
  "telegramSend",
  "telegramSendPhoto",
  "telegramSendDocument",
  "telegramSendMedia",
  "telegramSendLocation",
  "telegramEditMessage",
  "telegramDeleteMessage",
  "telegramForward",
  "telegramPin",
  "telegramChatAction",
  "telegramGetChat",
]);

const TYPING = {
  typing: () => new Api.SendMessageTypingAction(),
  upload_photo: () => new Api.SendMessageUploadPhotoAction({ progress: 0 }),
  upload_document: () => new Api.SendMessageUploadDocumentAction({ progress: 0 }),
  record_voice: () => new Api.SendMessageRecordAudioAction(),
  find_location: () => new Api.SendMessageGeoLocationAction(),
};

function parseModeOf(c) {
  if (c.parseMode === "HTML") return "html";
  if (c.parseMode === "MarkdownV2") return "md";
  return false; // exactly as written
}

function messageOut(msg, chatId) {
  return {
    ok: true,
    sent: true,
    message_id: msg?.id,
    chat: { id: String(chatId ?? msg?.chatId ?? "") },
    date: msg?.date,
    text: msg?.message ?? "",
  };
}

// A file for sendFile: an upload prepared by the executor, or a URL Telegram fetches.
function fileArg(media) {
  if (media && typeof media === "object" && media.__upload) {
    return new CustomFile(media.fileName || "file", media.bytes.length, "", media.bytes);
  }
  const v = String(media ?? "");
  if (!/^https?:\/\//i.test(v)) {
    throw attachCode(new Error("With a personal account, send a file by URL or from an earlier node (“Upload from field”) — Bot API file_ids only work for bots."), "MISSING_CONFIG");
  }
  return v;
}

/**
 * Run one Telegram node as the person's account. `p` holds the node's values
 * already rendered for this item (chatId, text, media, …).
 */
export async function runAsAccount(type, c, p, { id, userId }) {
  const client = await clientFor({ id, userId });
  try {
    const peer = type === "telegramForward" || p.chatId !== undefined ? await peerFor(client, p.chatId) : null;
    switch (type) {
      case "telegramSend": {
        const msg = await client.sendMessage(peer, {
          message: p.text,
          parseMode: parseModeOf(c),
          replyTo: p.replyTo ? Number(p.replyTo) : undefined,
          silent: c.silent === true,
          linkPreview: c.disablePreview !== true,
        });
        return messageOut(msg, p.chatId);
      }
      case "telegramSendPhoto":
      case "telegramSendDocument":
      case "telegramSendMedia": {
        const kind = type === "telegramSendMedia" ? String(c.kind || "video") : type === "telegramSendPhoto" ? "photo" : "document";
        const msg = await client.sendFile(peer, {
          file: fileArg(p.media),
          caption: kind === "sticker" || kind === "video_note" ? undefined : p.caption || undefined,
          parseMode: parseModeOf(c),
          forceDocument: kind === "document",
          voiceNote: kind === "voice",
          videoNote: kind === "video_note",
          silent: c.silent === true,
        });
        return messageOut(msg, p.chatId);
      }
      case "telegramSendLocation": {
        const msg = await client.sendFile(peer, {
          file: new Api.InputMediaGeoPoint({ geoPoint: new Api.InputGeoPoint({ lat: p.latitude, long: p.longitude }) }),
        });
        return messageOut(msg, p.chatId);
      }
      case "telegramEditMessage": {
        const msg = await client.editMessage(peer, { message: Number(p.messageId), text: p.text, parseMode: parseModeOf(c) });
        return messageOut(msg, p.chatId);
      }
      case "telegramDeleteMessage": {
        await client.deleteMessages(peer, [Number(p.messageId)], { revoke: true });
        return { ok: true, deleted: true, message_id: Number(p.messageId) };
      }
      case "telegramForward": {
        const from = await peerFor(client, p.fromChatId);
        const [msg] = await client.forwardMessages(peer, { messages: [Number(p.messageId)], fromPeer: from });
        return messageOut(msg, p.chatId);
      }
      case "telegramPin": {
        await client.pinMessage(peer, Number(p.messageId), { notify: c.silent === false });
        return { ok: true, pinned: true, message_id: Number(p.messageId) };
      }
      case "telegramChatAction": {
        await client.invoke(new Api.messages.SetTyping({ peer, action: (TYPING[c.action] || TYPING.typing)() }));
        return { ok: true, action: c.action || "typing" };
      }
      case "telegramGetChat": {
        const entity = await client.getEntity(peer);
        return { ...chatShape(entity, p.chatId), ok: true };
      }
      default:
        throw attachCode(new Error("This Telegram node only works with a bot."), "MISSING_CONFIG");
    }
  } catch (err) {
    // our own classified errors pass through; Telegram's RPC errors get a sentence
    throw err?._bfCode ? err : friendly(err);
  }
}

// ---- listening (the Telegram trigger, "Connect as: my account") ----

// A GramJS message → the Bot API update shape the trigger already emits, so
// {{message.text}}, {{message.chat.id}} and friends work unchanged.
async function toUpdate(event) {
  const m = event.message;
  let chat = null;
  let sender = null;
  try {
    chat = await m.getChat();
  } catch {
    /* shape without names */
  }
  try {
    sender = await m.getSender();
  } catch {
    /* shape without names */
  }
  const chatId = m.chatId?.toString();
  return {
    update_id: m.id,
    account: true,
    message: {
      message_id: m.id,
      chat: chatShape(chat, chatId),
      from: sender
        ? { id: String(sender.id), first_name: sender.firstName || sender.title || "", last_name: sender.lastName || "", username: sender.username || "", is_bot: !!sender.bot }
        : undefined,
      text: m.message || "",
      date: m.date,
      ...(m.media ? { has_media: true, media_type: m.media.className } : {}),
    },
  };
}

/**
 * Start listening to incoming messages on account `id`; `onUpdate` receives
 * Bot-API-shaped updates. Returns a stop function.
 */
export async function listenAccount({ id, userId }, onUpdate) {
  const client = await clientFor({ id, userId });
  const entry = pool.get(String(id));
  entry.listeners++;
  scheduleIdle(String(id));
  const event = new NewMessage({ incoming: true });
  const handler = async (e) => {
    try {
      onUpdate(await toUpdate(e));
    } catch (err) {
      console.error(`  [telegram] account update failed: ${String(err?.message || err).slice(0, 160)}`);
    }
  };
  client.addEventHandler(handler, event);
  // make sure the server pushes updates to this connection
  client.getMe().catch(() => {});
  return async () => {
    client.removeEventHandler(handler, event);
    const e = pool.get(String(id));
    if (e) {
      e.listeners = Math.max(0, e.listeners - 1);
      scheduleIdle(String(id));
    }
  };
}

export async function closeAllAccounts() {
  for (const key of [...pool.keys()]) await release(key, { force: true });
  for (const key of [...pendingLogins.keys()]) dropLogin(key);
}
