// ============================================================================
// W FLOW — operational alerts
//
// Raises alerts when the server is down or misbehaving and surfaces them in the
// admin panel. The operator can add an e-mail address, and every new alert is
// also mailed there (via the SMTP settings on the Auth & e-mail tab).
//
// - raiseAlert() deduplicates unresolved alerts by source + title and bumps the
//   occurrence counter instead of flooding the panel with duplicates.
// - The health monitor runs in the ADMIN process: it polls the main server's
//   /api/health endpoint. Because the admin panel is a separate process, it
//   keeps watching even when the app itself is wedged.
// - The main server also reports its own crashes through this module.
// ============================================================================
import "./env.js";
import { db } from "./dbx.js";
import { sendMail } from "./mail.js";

const DEFAULT_EMAIL = process.env.BF_ALERT_EMAIL || "";
const DEFAULT_ENABLED = process.env.BF_ALERTS !== "0" && process.env.BF_ALERTS !== "false";

export async function getAlertSettings() {
  const [email, enabled] = await Promise.all([
    db.storeGet("alerts.email"),
    db.storeGet("alerts.enabled"),
  ]);
  return {
    email: email !== null && email !== undefined ? String(email) : DEFAULT_EMAIL,
    enabled: enabled === null || enabled === undefined ? DEFAULT_ENABLED : enabled === "1",
  };
}

export async function saveAlertSettings({ email, enabled } = {}) {
  const clean = String(email ?? "").trim().slice(0, 200);
  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error("That does not look like an e-mail address.");
  }
  const current = await getAlertSettings();
  await db.storeSet("alerts.email", clean);
  await db.storeSet("alerts.enabled", enabled === undefined ? (current.enabled ? "1" : "0") : enabled ? "1" : "0");
  return getAlertSettings();
}

/**
 * Raise (or bump) an alert and mail it to the configured address.
 * @param {{level?:string, source:string, title:string, message?:string, email?:boolean}} alert
 */
export async function raiseAlert({ level = "warning", source = "server", title, message = "", email = true } = {}) {
  if (!title) return null;
  let result;
  try {
    result = await db.alertUpsert({ level, source, title, message });
  } catch (err) {
    console.error("[alerts] could not record alert:", err?.message || err);
    return null;
  }
  const { alert, created } = result;
  if (alert && !alert.emailSent && (created || !alert.emailSent)) {
    try {
      const settings = await getAlertSettings();
      if (settings.enabled && settings.email && email) {
        await sendMail({
          to: settings.email,
          subject: `[W flow] ${level.toUpperCase()}: ${title}`,
          text:
            `W flow alert (${level})\n\n` +
            `${title}\n${message}\n\n` +
            `Source: ${source}\nTime: ${new Date().toISOString()}\n\n` +
            `Open the admin panel to review and resolve it.`,
        });
      }
      // Mark as emailed regardless of whether SMTP is set up, so the same alert
      // is not mailed again on every occurrence.
      await db.alertMarkEmailed(alert.id);
    } catch {
      /* mailing is best-effort */
    }
  }
  return alert;
}

export async function resolveAlert(id) {
  return db.alertResolve(String(id));
}

// ----------------------------------------------------------------------------
// health monitor (admin process)
// ----------------------------------------------------------------------------
const HEALTH_URL =
  process.env.BF_HEALTH_URL ||
  `http://127.0.0.1:${process.env.PORT || 3001}/api/health`;
const FAIL_THRESHOLD = Math.max(1, Number(process.env.BF_ALERT_FAIL_THRESHOLD) || 2);
const POLL_MS = Math.max(5000, Number(process.env.BF_ALERT_POLL_MS) || 30000);
const ALERT_TITLE = "Server is not responding";

let monitorTimer = null;
let failures = 0;
let lastState = null;

export async function runHealthCheck() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (body && body.ok === false) throw new Error(String(body.error || "reported unhealthy"));
    return { ok: true, detail: body };
  } catch (err) {
    return { ok: false, detail: String(err?.message || err) };
  }
}

async function tick() {
  const result = await runHealthCheck();
  if (result.ok) {
    failures = 0;
    if (lastState === false) {
      // The server came back — close the incident and leave a short note.
      try {
        const open = await db.alertsList({ includeResolved: false, limit: 100 });
        const incident = open.find((a) => a.source === "health" && a.title === ALERT_TITLE);
        if (incident) await db.alertResolve(incident.id);
      } catch {
        /* ignore */
      }
      await raiseAlert({
        level: "info",
        source: "health",
        title: "Server recovered",
        message: `The main server answered ${HEALTH_URL} again.`,
        email: true,
      });
    }
    lastState = true;
    return result;
  }
  failures++;
  lastState = false;
  if (failures >= FAIL_THRESHOLD) {
    await raiseAlert({
      level: "critical",
      source: "health",
      title: ALERT_TITLE,
      message: `The main server did not answer ${HEALTH_URL} (${failures} failed checks in a row): ${result.detail}`,
    });
  }
  return result;
}

export function startHealthMonitor() {
  if (monitorTimer) return monitorTimer;
  if (process.env.BF_ALERTS === "0" || process.env.BF_ALERTS === "false") return null;
  // first check shortly after boot, then on the regular interval
  setTimeout(() => tick().catch(() => {}), 5000).unref?.();
  monitorTimer = setInterval(() => tick().catch(() => {}), POLL_MS);
  if (typeof monitorTimer.unref === "function") monitorTimer.unref();
  return monitorTimer;
}

export function stopHealthMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
