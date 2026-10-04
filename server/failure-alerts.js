// ============================================================================
// W FLOW — failure alerts per workflow
//
// Error workflows (server/error-workflows.js) let a user build any reaction to
// a failure, but they have to build it first. This is the switch most people
// actually want: "tell me when this workflow breaks", by e-mail and/or
// Telegram, set in the workflow's settings.
//
// Settings live in the key-value store under the workflow id, not in the
// workflow JSON: the Telegram bot token is a secret, and workflow JSON gets
// exported, versioned and published. The token is encrypted at rest and never
// sent back to the browser (only whether one is set).
//
// Alerts fire for unhandled failures only, by default only for runs nobody was
// watching (schedule, webhook, background, triggers) — an editor run already
// shows its error on screen. One alert per workflow per cooldown, so a cron
// that fails every minute sends one message, not sixty.
// ============================================================================
import { db } from "./dbx.js";
import { sendMail } from "./mail.js";
import { encryptText, decryptText } from "./security.js";
import { publicBaseUrl } from "./dashboards.js";

const COOLDOWN_MS = 15 * 60 * 1000;
const lastSent = new Map(); // workflowId → epoch ms of the last alert

const key = (workflowId) => `wf.alerts.${workflowId}`;

const DEFAULTS = { enabled: false, email: "", telegramChatId: "", telegramBotToken: "", includeEditorRuns: false };

async function readRaw(workflowId) {
  try {
    const raw = await db.storeGet(key(workflowId));
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Settings as the browser sees them — the bot token is never returned. */
export async function getAlertSettingsFor(workflowId) {
  const s = await readRaw(workflowId);
  return {
    enabled: !!s.enabled,
    email: s.email || "",
    telegramChatId: s.telegramChatId || "",
    telegramBotTokenSet: !!s.telegramBotToken,
    includeEditorRuns: !!s.includeEditorRuns,
  };
}

/** Save settings. An omitted or empty bot token keeps the stored one unless `clearTelegramBotToken` is set. */
export async function saveAlertSettingsFor(workflowId, body = {}) {
  const current = await readRaw(workflowId);
  const email = String(body.email ?? current.email ?? "").trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That does not look like an e-mail address.");
  const chat = String(body.telegramChatId ?? current.telegramChatId ?? "").trim().slice(0, 64);
  if (chat && !/^(-?\d+|@[\w]{4,})$/.test(chat)) throw new Error("The Telegram chat ID is a number (e.g. 123456789, or -100… for a group) or a @channel name.");
  const newToken = String(body.telegramBotToken ?? "").trim();
  if (newToken && !/^\d+:[\w-]{20,}$/.test(newToken)) throw new Error("That does not look like a Telegram bot token (123456:ABC-…).");
  const next = {
    enabled: body.enabled === undefined ? !!current.enabled : !!body.enabled,
    email,
    telegramChatId: chat,
    telegramBotToken: body.clearTelegramBotToken ? "" : newToken ? encryptText(newToken) : current.telegramBotToken,
    includeEditorRuns: body.includeEditorRuns === undefined ? !!current.includeEditorRuns : !!body.includeEditorRuns,
  };
  await db.storeSet(key(workflowId), JSON.stringify(next));
  return getAlertSettingsFor(workflowId);
}

export async function removeAlertSettingsFor(workflowId) {
  try {
    await db.storeSet(key(workflowId), "");
  } catch {
    /* nothing stored */
  }
}

function alertText(workflow, failure, source, appUrl) {
  const code = failure.errorCode ? ` (BF-${failure.errorCode})` : "";
  const link = appUrl ? `\n\nOpen W flow: ${appUrl.replace(/\/+$/, "")}` : "";
  return (
    `Workflow “${workflow.name || workflow.id}” failed.\n\n` +
    `Node: ${failure.nodeName || failure.nodeId}\n` +
    `Error${code}: ${String(failure.error || "unknown error").slice(0, 600)}\n` +
    `Started by: ${source}\n` +
    `Time: ${new Date().toISOString()}${link}`
  );
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram returned HTTP ${res.status}`);
}

/**
 * Deliver an alert through every configured channel.
 * @returns {Promise<{email?: object, telegram?: object}>} per-channel outcome
 */
export async function deliverAlert(settings, workflow, failure, source, { appUrl } = {}) {
  if (appUrl === undefined) appUrl = await publicBaseUrl();
  const text = alertText(workflow, failure, source, appUrl);
  const subject = `⚠ W flow: “${workflow.name || workflow.id}” failed`;
  const out = {};
  if (settings.email) out.email = await sendMail({ to: settings.email, subject, text });
  const token = settings.telegramBotToken ? decryptText(settings.telegramBotToken) : "";
  if (token && settings.telegramChatId) {
    try {
      await sendTelegram(token, settings.telegramChatId, `${subject}\n\n${text}`);
      out.telegram = { ok: true };
    } catch (err) {
      out.telegram = { ok: false, error: String(err?.message || err) };
    }
  }
  return out;
}

/** Called for every finished run (server/executions.js). Never throws. */
export async function notifyFailure(workflow, result, source = "editor", now = Date.now()) {
  try {
    if (!workflow?.id || source === "error") return null;
    const failure = (result?.log || []).find((l) => l.status === "error" && !l.handled);
    if (!failure || result?.aborted) return null;
    const settings = await readRaw(workflow.id);
    if (!settings.enabled) return null;
    if (source === "editor" && !settings.includeEditorRuns) return null;
    if (!settings.email && !(settings.telegramBotToken && settings.telegramChatId)) return null;
    const last = lastSent.get(workflow.id) || 0;
    if (now - last < COOLDOWN_MS) return null;
    lastSent.set(workflow.id, now);
    return await deliverAlert(settings, workflow, failure, source);
  } catch (err) {
    console.error("[failure-alerts] could not send alert:", err?.message || err);
    return null;
  }
}

/** Send a sample alert so the user can check the channels. */
export async function sendTestAlert(workflow) {
  const settings = await readRaw(workflow.id);
  if (!settings.email && !(settings.telegramBotToken && settings.telegramChatId)) {
    throw new Error("Add an e-mail address or a Telegram bot token and chat ID first.");
  }
  const sample = { nodeId: "example", nodeName: "Example node", error: "This is a test alert — nothing failed.", errorCode: null };
  return deliverAlert(settings, workflow, sample, "test");
}

export function resetAlertCooldowns() {
  lastSent.clear();
}
