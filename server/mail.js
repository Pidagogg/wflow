// ============================================================================
// Mail — transactional e-mails for password reset and e-mail verification.
//
// SMTP settings come from the admin panel (mail.* keys) and fall back to env:
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE=1, SMTP_USER, SMTP_PASS, MAIL_FROM
// When no host is configured the message is logged to the console instead of
// being sent, so a fresh install still surfaces the reset/verify link in dev.
// ============================================================================
import "./env.js"; // .env must be loaded before SMTP_* are read
import nodemailer from "nodemailer";
import { db } from "./dbx.js";

async function setting(key, env) {
  try {
    const stored = await db.storeGet(key);
    if (stored) return stored;
  } catch {
    /* store hiccup — fall back to env */
  }
  return process.env[env] || "";
}

export async function mailConfig() {
  const [host, user, pass, from, secure] = await Promise.all([
    setting("mail.host", "SMTP_HOST"),
    setting("mail.user", "SMTP_USER"),
    setting("mail.pass", "SMTP_PASS"),
    setting("mail.from", "MAIL_FROM"),
    setting("mail.secure", "SMTP_SECURE"),
  ]);
  const portRaw = await setting("mail.port", "SMTP_PORT");
  const port = Number(portRaw) || 587;
  return {
    host,
    port,
    // 465 only speaks implicit TLS — a plain connection there just hangs until
    // the timeout, which looks like "mail does not work at all".
    secure: secure === "1" || secure === "true" || port === 465,
    user,
    pass,
    from,
  };
}

// A host with a login but no password can never deliver. Counting it as
// configured would switch on the sign-up confirmation gate and lock every new
// account out — the production template ships SMTP_HOST/SMTP_USER pre-filled
// with SMTP_PASS still empty.
export async function mailConfigured() {
  const cfg = await mailConfig();
  return !!cfg.host && (!cfg.user || !!cfg.pass);
}

/** Send one e-mail. Never throws — a mail failure must not break a request. */
export async function sendMail({ to, subject, text, html }) {
  try {
    const cfg = await mailConfig();
    if (!cfg.host) {
      console.log(`  [mail] SMTP not configured — "${subject}" for ${to}:\n${text}`);
      return { ok: false, skipped: true };
    }
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      // fail in seconds, not minutes, when host/port are wrong
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    });
    const info = await transporter.sendMail({
      from: cfg.from || cfg.user || "no-reply@localhost",
      to,
      subject,
      text,
      html: html || undefined,
    });
    // "Sent" only means our SMTP relay took it. When some recipients never see
    // a mail, this line tells a relay refusal apart from the receiving side
    // (Gmail, Outlook, …) dropping or spam-filtering it later.
    const rejected = (info.rejected || []).map(String);
    console.log(`  [mail] "${subject}" to ${to}: ${info.response || "accepted"}${rejected.length ? ` (rejected: ${rejected.join(", ")})` : ""}`);
    if (rejected.length) return { ok: false, error: `Recipient rejected: ${rejected.join(", ")}` };
    return { ok: true };
  } catch (err) {
    console.error(`  [mail] failed to send "${subject}" to ${to}:`, err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}
