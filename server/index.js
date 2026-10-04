// ----------------------------------------------------------------------------
// W FLOW — self-hosted server
// REST API + webhook trigger + static frontend.
// Run: npm run dev  (server on :3001, Vite on :5173)
//      npm start    (serves the built frontend from dist/ on :3001)
//
// Deployment:
//   - env vars come from a .env file if present (server/env.js)
//   - accounts/sessions use PostgreSQL when DATABASE_URL is set, otherwise the
//     built-in SQLite (server/dbx.js facade)
//   - TRUST_PROXY=1 makes req.ip honour the X-Forwarded-For header so rate
//     limiting sees real client IPs behind Cloudflare / a reverse proxy
// ----------------------------------------------------------------------------
import "./env.js"; // load .env before any module reads PORT / DATABASE_URL / …
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { CATALOG, isTriggerType } from "../shared/catalog.js";
import { samplePayloadFor } from "../shared/samples.js";
import { safeFilePath, listFilesOnDisk, writeFileBytes, deleteFileOnDisk, fitsInFolder, removeAccountFolder } from "./disk.js";
import { errorCatalog } from "../shared/errors.js";
import { csvToTable } from "../shared/csv.js";
import { applyUpdate, updateStatus } from "./updater.js";
import { selfhostReadiness, shippedVersion, buildSelfhostBundle, installerScript, installerExtension, normalizeInstallerOs, newBundleToken, verifyBundleToken } from "./selfhost.js";
import {
  seoConfig,
  seoMetaTags,
  renderRobots,
  renderLlmsTxt,
  renderLlmsFullTxt,
  structuredData,
  crawlableIntro,
  indexNowKey,
  submitIndexNow,
} from "./seo.js";
import { guidesRouter, guideUrls, guideSummaries } from "./guides.js";
import {
  parseProviders,
  providerLabel,
  normalizeProjectUrl,
  mergeLoginProviders,
  supabaseClient,
  authorizeUrl as supabaseAuthorizeUrl,
  sendMagicLink,
  completeWithCode,
  completeWithTokenHash,
  PKCE_COOKIE,
  STATE_COOKIE,
} from "./supabase-auth.js";
import {
  workflows,
  agents,
  community,
  workflowVersions,
  MAX_WORKFLOW_VERSIONS,
  workflowBackups,
  MAX_WORKFLOW_BACKUPS,
  seed,
  syncUserWorkflowAssignments,
  stripSecretsFromWorkflow,
  collectSecrets,
  blankSecretsInWorkflow,
  secretFieldPaths,
  hydrateSecretsInWorkflow,
  migrateWorkflowSecretsToDb,
  collectAgentSecrets,
  blankAgentSecrets,
  hydrateAgentSecrets,
  migrateAgentSecretsToDb,
} from "./store.js";
import { executeNode } from "./executor.js";
// Every run goes through executeRouted: it executes here, or on the remote
// runner configured in Setup (server/setup.js + server/runner.js).
import { mountRunnerRoutes, executeRouted, testRunner } from "./runner.js";
import { readSetup, saveSetup, setupAllowed, testDatabase } from "./setup.js";
import { beginWebhookWait, pollWebhookWait, completeWebhookWait, cancelWebhookWait, isWebhookArmed, markWebhookFired, claimWait, completeWaitWithResult, armedWaits } from "./webhook-wait.js";
import { beginLiveRun, endLiveRun, setLiveRunProgress, runStatus, stopLiveRun, waitForStep, stepLiveRun } from "./run-control.js";
import { normalizeEnvironment } from "./run-context.js";
import { getAlertSettingsFor, saveAlertSettingsFor, sendTestAlert } from "./failure-alerts.js";
import { normalizeMcpSettings, mountMcpRoutes, revokeMcpToken } from "./mcp.js";
import { stripPrivateFromWorkflow } from "../shared/privacy.js";
import { mountDashboardRoutes } from "./dashboards.js";
import { setPresence, workflowPresence, clearPresence } from "./presence.js";
import { startScheduler } from "./scheduler.js";
import { licenseGate, licenseStatus, licenseRequired, refreshLicense, setLocalLicenseKey, startLicenseChecks, licenseKeyFor, rotateLicenseKey, checkLicenseKey, licenseServer, DEFAULT_LICENSE_SERVER } from "./license.js";
import { teamOwnedBy, teamView, requestTeam, setTeamMembers, activateTeamFromCheckout, teamEntitlement, SUGGESTED_SEAT_PRICE, MIN_SEATS, MAX_SEATS } from "./teams.js";
import { seatAvailable, isRestricted, instanceOwnerId, installOutboundGuard, restrictedMemberGuard, teamOverview, updateTeamSettings } from "./team-admin.js";
import { newMigrationCode, consumeMigrationCode, buildMigrationPayload, sendToCloud, importMigrationPayload } from "./migrate.js";
import { currentRunContext } from "./run-context.js";
import { startLoop, stopLoop, loopStatus, loopIntervalMs } from "./loop-runner.js";
import { loopIntervalFloor } from "../shared/loop.js";
import { startTelegramPolling } from "./telegram.js";
import { listBots as listTelegramBots, connectBot as connectTelegramBot, recentChats as recentTelegramChats, botTokenFor, telegramApi } from "./telegram-bots.js";
import {
  listAccounts as listTelegramAccounts,
  startLogin as startTelegramLogin,
  appCredentials as telegramAppCredentials,
  resendCode as resendTelegramCode,
  setupLoginEmail as setupTelegramLoginEmail,
  verifyLoginEmail as verifyTelegramLoginEmail,
  startQrLogin as startTelegramQrLogin,
  qrStatus as telegramQrStatus,
  finishLogin as finishTelegramLogin,
  recentAccountChats as recentTelegramAccountChats,
  logoutAccount as logoutTelegramAccount,
  TELEGRAM_ACCOUNT_TYPE,
} from "./telegram-accounts.js";
import { recordExecution, startExecutionRetention } from "./executions.js";
import { runningForWorkflow, runningForOwner, isRunning, waitingRows } from "./running-executions.js";
import { beginApproval, approvalStatus, resolveApproval, endApprovals } from "./approvals.js";
import { getPriceSettings, savePriceSettings, PRESET_PRICES } from "./ai-cost.js";
import { getAccountSettings, saveAccountSettings, normalizeBudget, forgetAccount as forgetAiAccount } from "./ai-budget.js";
import { budgetOverview, usageDashboard, workflowEstimate } from "./ai-usage.js";
import { templateSummaries, getTemplate, TEMPLATE_CATEGORIES } from "../shared/templates.js";
import { FREE_MAX_WORKFLOWS, FREE_MAX_RUNS_PER_DAY, isProUser, runQuota, filesQuotaBytes } from "./quota.js";
import { chatCompletion, runAgent, testConnection, listModels } from "./ai.js";
import { buildWorkflow } from "./workflow-agent.js";
import { db, sanitizeSiteDomain } from "./dbx.js";
import { startBackupScheduler } from "./backup.js";
import { raiseAlert } from "./alerts.js";
import { flushJournal } from "./journal.js";
import { verifyPassword, hashPassword, digestToken } from "./security.js";
import {
  providerConfig as connectionConfig,
  connectionProviders,
  createState as createConnectionState,
  takeState as takeConnectionState,
  isConnectionState,
  authorizeUrl as connectionAuthorizeUrl,
  completeConnection,
  listConnections,
  isConnectionType,
  scopePolicy,
} from "./oauth-connections.js";
import {
  OAUTH_PROVIDERS as CONNECTION_PROVIDERS,
  oauthSpecFor,
  scopesFor,
  providerScopes,
  connectAllowed,
  unavailableConnectionNodes,
} from "../shared/oauth.js";
import { buildReferenceMarkdown, WORKFLOW_SCHEMA_PATH } from "./workflow-docs.js";
import { recordChange, listHistory, listComments, addComment, updateComment, deleteComment, forgetWorkflow as forgetWorkflowCollab } from "./workflow-collab.js";
import { buildWorkflowSchema } from "../shared/workflow-schema.js";
import {
  createCheckoutSession,
  createCustomCheckoutSession,
  createBillingPortalSession,
  updateSubscriptionCancel,
  getCancelAtPeriodEnd,
  setCancelAtPeriodEnd,
  handleStripeEvent,
  verifyStripeSignature,
  stripeConfig,
  defaultPriceLabel,
  salesOpen,
  cryptoEnabled,
  publicCryptoConfig,
  createCryptoInvoice,
  verifyNowPaymentsSignature,
  handleCryptoIpn,
  isCryptoSubscriptionId,
  cryptoConfig,
} from "./billing.js";
import { stripeEventMatches, stripeTriggerPayload, firstDelivery } from "./stripe-trigger.js";
import { legalRouter, legalDocHandler, legalDomain, legalBaseUrl } from "./legal.js";
import { sendMail, mailConfigured, mailConfig } from "./mail.js";
import { renderGuidePdf } from "./guide-pdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

seed();
// Credentials used to live inside the workflow JSON (plaintext in ./data).
// Move any that are still there into the encrypted workflow_secrets table and
// blank them in the files — from now on the JSON never holds node secrets.
const migratedSecrets = await migrateWorkflowSecretsToDb();
if (migratedSecrets) {
  console.log(`  [secrets] moved ${migratedSecrets} workflow credential(s) into the encrypted database.`);
}
const migratedAgentSecrets = await migrateAgentSecretsToDb();
if (migratedAgentSecrets) {
  console.log(`  [secrets] moved ${migratedAgentSecrets} agent credential(s) into the encrypted database.`);
}
// Posts published before personal values (recipients, chat IDs, logins, …)
// were removed on publish still carry them — clean the stored copies once.
{
  let cleaned = 0;
  for (const post of community.all()) {
    const stripped = stripPrivateFromWorkflow(post);
    if (JSON.stringify(stripped.nodes) !== JSON.stringify(post.nodes)) {
      community.save(stripped);
      cleaned += 1;
    }
  }
  if (cleaned) console.log(`  [community] removed personal values from ${cleaned} published workflow(s).`);
}
// keep the SQL users.workflow_ids column in sync with the JSON workflows file
await syncUserWorkflowAssignments();

// Background cron scheduler — fires Schedule (cron) trigger nodes on their own
// (disable with DISABLE_SCHEDULER=1). Same boot call starts the Telegram
// live-trigger poller (always-listen triggers only).
startScheduler();
startTelegramPolling();
// A self-hosted copy checks its licence with w-flow.tech every few hours (only
// the key is sent) and watches where team members' runs send data.
startLicenseChecks();
installOutboundGuard(currentRunContext);
// Scheduled backups (configured in the admin panel → Backups). No-op until the
// operator switches them on.
startBackupScheduler();
startExecutionRetention();

const app = express();
// Behind Cloudflare / Nginx / Caddy the request IP arrives via X-Forwarded-For;
// TRUST_PROXY=1 lets Express use it (needed for correct rate limiting + logs).
if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}
// CORS: same-origin by default. The Vite dev server proxies /api and /webhook,
// and in production the UI is served from the same origin — so no CORS headers
// are needed at all. Cross-origin API access is opt-in via BF_CORS_ORIGIN
// (comma-separated allowlist); the old wide-open Access-Control-Allow-Origin: *
// advertised the API to every website for no reason.
const CORS_ORIGINS = (process.env.BF_CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (CORS_ORIGINS.length) {
  app.use(cors({ origin: CORS_ORIGINS }));
}

// Basic hardening headers on every main-site response (the admin panel on its
// own port already sets these): no MIME sniffing, no framing, no referrer leak.
// API and webhook responses additionally must never be cached: GET /api/workflows/:id
// returns decrypted credentials for the editor, and a shared proxy or browser
// cache holding onto authenticated JSON would leak them to the next reader.
// The CSP only locks down framing, <base> and plugins — a script-src policy
// would need every inline script, Stripe and the dashboard pages audited
// first. HSTS is sent only over HTTPS (behind TRUST_PROXY, req.secure reads
// X-Forwarded-Proto), so a plain-HTTP self-hosted copy is never pinned.
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  if (req.path.startsWith("/api") || req.path.startsWith("/webhook")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
// A single bad request must never take the whole server down. If an async route
// handler throws an uncaught error (e.g. the recordActivity heartbeat crash that
// used to kill every authenticated request), the process would die and the
// browser shows "failed to fetch" for every click afterwards. Log and continue
// instead of crashing — a self-hosted instance should survive request errors.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception:", err);
  // Surface the crash in the admin panel's alerts feed as well.
  try {
    raiseAlert({
      level: "critical",
      source: "server",
      title: "Uncaught exception in the main server",
      message: String(err?.stack || err?.message || err).slice(0, 800),
    }).catch(() => {});
  } catch {
    /* never let alert reporting crash the handler */
  }
});
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandled promise rejection:", err);
  try {
    raiseAlert({
      level: "warning",
      source: "server",
      title: "Unhandled promise rejection in the main server",
      message: String(err?.stack || err?.message || err).slice(0, 800),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
});
// Flush buffered journal events on a clean shutdown so nothing is lost.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushJournal().finally(() => process.exit(0));
  });
}
// Stripe posts its webhooks as raw JSON; the billing route verifies the request
// signature against the raw bytes, so it must consume the body BEFORE the global
// JSON parser turns it into an object. This route stays public (webhooks have no
// login cookie) while everything else under /api/billing requires a user.
app.use("/api/billing/webhook", express.raw({ type: ["application/json", "application/*+json"], limit: "5mb" }));
// NOWPayments posts its IPN callbacks the same way (raw JSON, HMAC-SHA512 over
// the body), so it too must be read before the global JSON parser runs.
app.use("/api/billing/crypto/webhook", express.raw({ type: ["application/json", "application/*+json"], limit: "5mb" }));
app.use(express.json({ limit: "10mb" }));

const withId = (body) => ({ ...body, id: body.id || randomUUID() });

// ----------------------------------------------------------------------------
// User accounts — the main site requires login (email + password). Accounts live
// in the SQL database (data/admin.db, table `users`); every new registration is
// inserted there, and logging in verifies the scrypt hash and issues an httpOnly
// SameSite=Lax session cookie.
// ----------------------------------------------------------------------------
const USER_COOKIE = "bf_user";
const USER_SESSION_SECONDS = 14 * 24 * 3600; // 14 days

// Free-plan limits (10 workflows / 50 runs per day, lifted by Pro) live in
// ./quota.js, shared with the cron scheduler so every run path enforces them.

// Session cookies are HttpOnly + SameSite=Lax; the Secure attribute is opt-in
// via BF_COOKIE_SECURE=1 because local development runs over plain http.
// Behind TLS (Cloudflare / Caddy / Nginx) set it so cookies never travel in
// the clear — set it on logout too so the clearing cookie can replace a
// Secure one.
const COOKIE_SECURE = process.env.BF_COOKIE_SECURE === "1" || process.env.BF_COOKIE_SECURE === "true";
function cookieHeader(value, maxAgeSeconds) {
  return `${USER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE ? "; Secure" : ""}; Max-Age=${maxAgeSeconds}`;
}

// minimal cookie parser (no dependency)
app.use((req, _res, next) => {
  try {
    const raw = req.headers.cookie || "";
    req.cookies = Object.fromEntries(
      raw.split(";").map((s) => s.trim().split("=")).filter((x) => x.length === 2).map(([k, v]) => [k, decodeURIComponent(v)])
    );
  } catch {
    req.cookies = {};
  }
  next();
});

// A self-hosted copy whose licence lapsed serves only sign-in, the licence,
// Setup and the move to the cloud (server/license.js); restricted team members
// cannot add credentials of their own (server/team-admin.js).
app.use(["/api", "/webhook"], licenseGate);
app.use("/api", restrictedMemberGuard((req) => currentUser(req)));

// ----------------------------------------------------------------------------
// Legal pages on a subdomain (default info.<site domain>) — Impressum /
// Datenschutz in German, English and Russian. When the request Host matches the
// configured legal subdomain, EVERY path serves the legal site (a separate,
// login-free document site); the main app stays on the root domain. Static
// assets (logo, robots, sitemap) fall through to the normal handlers below so
// they keep working on that host too. See server/legal.js for the content.
// ----------------------------------------------------------------------------
// One address per page for search engines: www.<domain> answers with a
// permanent redirect to the bare domain (the canonical host), so Google does
// not index every page twice. Only page loads are moved — API calls and
// webhooks keep working on www so no integration breaks.
app.use(async (req, res, next) => {
  try {
    const host = String(req.hostname || "").toLowerCase();
    if (!host.startsWith("www.") || (req.method !== "GET" && req.method !== "HEAD")) return next();
    if (/^\/(api|webhook)(\/|$)/.test(req.path)) return next();
    const domain = await configuredSiteDomain();
    if (!domain || host !== `www.${domain}`) return next();
    res.redirect(301, `https://${domain}${req.originalUrl}`);
  } catch (err) {
    next(err);
  }
});

const legal = legalRouter();
// Operator switch (admin panel → Page setup): when on, the subscription (Pro)
// page and every legal page (Datenschutz, Impressum) are removed
// from the website entirely — the links disappear and the URLs answer 404.
// Read on each request so flipping the toggle takes effect without a restart.
async function legalAndProHidden() {
  try {
    return (await db.storeGet("page.hideLegalAndPro")) === "1";
  } catch {
    return false;
  }
}
// These paths pass through on the legal host so branding/SEO files still load.
const LEGAL_HOST_STATIC = new Set(["/logo.png", "/logo-square.png", "/favicon.ico", "/favicon.png", "/favicon-32.png", "/favicon-192.png", "/apple-touch-icon.png", "/robots.txt", "/sitemap.xml"]);
app.use(async (req, res, next) => {
  try {
    if (await legalAndProHidden()) return next();
    const domain = await legalDomain();
    if (!domain || String(req.hostname || "").toLowerCase() !== domain) return next();
    if (LEGAL_HOST_STATIC.has(req.path)) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(404).json({ error: "Not found." });
    }
    // Every GET on the legal host is answered by the legal site (including a
    // 404 page for unknown paths — the router never falls through to the app).
    legal(req, res, next);
  } catch (err) {
    next(err);
  }
});

// A self-hosted copy holds as many accounts as its plan has seats.
function seatsFullMessage(seat) {
  return `This self-hosted copy is full: its plan covers ${seat.seats} account${seat.seats === 1 ? "" : "s"}. Ask its admin to buy more seats (Team plan on w-flow.tech).`;
}

// in-memory rate limiter for the auth endpoints (token bucket per email + IP)
const authAttempts = new Map();
function authLimited(ip, email) {
  const now = Date.now();
  const bump = (key) => {
    const rec = authAttempts.get(key) || { count: 0, windowStart: now };
    if (now - rec.windowStart > 60_000) {
      rec.count = 0;
      rec.windowStart = now;
    }
    rec.count++;
    authAttempts.set(key, rec);
    return rec;
  };
  const rec = bump(`${ip}|${String(email || "").toLowerCase()}`);
  const ipRec = bump(`ip:${ip}`);
  return rec.count > 8 || ipRec.count > 40;
}

// Outgoing auth mail (confirmation, resend, password reset) is throttled much
// harder than the attempts above: every request can put a real e-mail into
// someone's inbox from our domain. One per address per minute
// (BF_MAIL_COOLDOWN_SECONDS), and a few per IP per ten minutes
// (BF_MAIL_IP_LIMIT) so nobody can walk a list of addresses. The public endpoints consume the slot even when
// nothing is sent, so the answer never reveals which addresses are known.
// Only enforced when SMTP is configured — without it nothing leaves the box.
const MAIL_COOLDOWN_MS = Math.max(0, Number(process.env.BF_MAIL_COOLDOWN_SECONDS || 60)) * 1000;
const MAIL_IP_LIMIT = Math.max(1, Number(process.env.BF_MAIL_IP_LIMIT) || 5);
const MAIL_IP_WINDOW_MS = 10 * 60_000;
const mailSentTo = new Map(); // address → last request (ms)
const mailSentFrom = new Map(); // ip → request times within the window

/**
 * Claim the mail slot for `email` from `ip`. Returns 0 when the mail may go out
 * (and records it), otherwise the seconds to wait.
 */
async function claimMailSlot(ip, email) {
  if (!(await mailConfigured())) return 0;
  const now = Date.now();
  const addr = String(email || "").trim().toLowerCase();
  const recent = (mailSentFrom.get(ip) || []).filter((t) => now - t < MAIL_IP_WINDOW_MS);
  const last = mailSentTo.get(addr) || 0;
  const waitAddr = last && now - last < MAIL_COOLDOWN_MS ? MAIL_COOLDOWN_MS - (now - last) : 0;
  const waitIp = recent.length >= MAIL_IP_LIMIT ? MAIL_IP_WINDOW_MS - (now - recent[0]) : 0;
  const wait = Math.max(waitAddr, waitIp);
  if (wait > 0) return Math.ceil(wait / 1000);
  if (mailSentTo.size > 10_000) {
    for (const [k, t] of mailSentTo) if (now - t >= MAIL_COOLDOWN_MS) mailSentTo.delete(k);
  }
  if (mailSentFrom.size > 10_000) {
    for (const [k, ts] of mailSentFrom) if (!ts.some((t) => now - t < MAIL_IP_WINDOW_MS)) mailSentFrom.delete(k);
  }
  mailSentTo.set(addr, now);
  recent.push(now);
  mailSentFrom.set(ip, recent);
  return 0;
}

function mailWaitResponse(res, seconds) {
  res.setHeader("Retry-After", String(seconds));
  const minutes = Math.ceil(seconds / 60);
  const span = seconds < 90 ? `${seconds} second${seconds === 1 ? "" : "s"}` : `${minutes} minutes`;
  return res.status(429).json({
    error: `Please wait ${span} before requesting another e-mail.`,
    retryAfter: seconds,
  });
}

// Generic in-memory token bucket (per key, sliding minute window) used for the
// public /webhook/:id endpoint. An idle webhook call is cheap (a 409) and an
// armed one executes at most once per Run, but the endpoint is still public:
// this stops one client hammering it (or the server's request pipeline) with
// hundreds of requests per second. The limit is per IP per minute and can be
// tuned with BF_WEBHOOK_RATE_LIMIT.
const buckets = new Map();
function rateLimited(key, limit, windowMs = 60_000) {
  const now = Date.now();
  const rec = buckets.get(key) || { count: 0, windowStart: now };
  if (now - rec.windowStart > windowMs) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count++;
  buckets.set(key, rec);
  return rec.count > limit;
}

// The in-memory rate-limit maps key on IP / e-mail, so a long-running instance
// hit by many distinct clients would otherwise grow them without bound. Sweep
// stale windows every few minutes (the record is reset on next use anyway, so
// dropping an expired one is free). Unref'd so it never holds the process open.
const RATE_SWEEP_MS = 5 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of buckets) if (now - rec.windowStart > RATE_SWEEP_MS) buckets.delete(k);
  for (const [k, rec] of authAttempts) if (now - rec.windowStart > RATE_SWEEP_MS) authAttempts.delete(k);
  for (const [k, rec] of reportLimits) if (now - rec.windowStart > 20 * 60_000) reportLimits.delete(k);
  for (const [k, times] of tgLoginAttempts) if (!times.some((t) => now - t < TG_LOGIN_WINDOW_MS)) tgLoginAttempts.delete(k);
  for (const [k, times] of contactSent) if (!times.some((t) => now - t < CONTACT_WINDOW_MS)) contactSent.delete(k);
}, RATE_SWEEP_MS).unref?.();

async function currentUser(req) {
  const token = req.cookies?.[USER_COOKIE];
  if (!token) return null;
  return db.getUserForUserSession(token);
}

async function requireUser(req, res, next) {
  let user;
  try {
    user = await currentUser(req);
  } catch (err) {
    // A DB hiccup while looking up the session must answer, not hang the request
    // (an async middleware that throws never calls next() under Express 4).
    return res.status(503).json({ error: "The server could not verify your session. Please try again." });
  }
  if (!user) return res.status(401).json({ error: "Please log in first." });
  req.user = user;
  next();
  // Record a heartbeat so the admin Analytics tab can show who was online.
  // Throttled to ~1 row per user per minute inside recordActivity. Purely
  // observational — never blocks or delays the request, and must never take
  // the server down: the SQLite backend is synchronous (returns undefined)
  // while the PostgreSQL backend returns a promise, so handle both and swallow
  // every failure.
  try {
    const p = db.recordActivity(user.userId);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // ignore — analytics must never break an API request
  }
}

app.get("/api/auth/me", async (_req, res) => {
  const user = await currentUser(_req);
  if (!user) return res.json({ authed: false });
  const full = await db.getUserById(user.userId);
  res.json({
    authed: true,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: !!full?.email_verified,
    workflowIds: user.workflowIds || [],
    // true for the owner of this instance (admin, or the first account of a
    // copy the user installed themselves) — the UI then shows the Setup tab.
    canSetup: await setupAllowed(user),
  });
});

// The absolute origin this request arrived on — used to build reset / verify
// links and OAuth redirect URIs when the app runs behind a proxy. The admin
// panel value (Auth & e-mail → Public URL) wins over BF_PUBLIC_URL. Read on
// every request so changing it takes effect without a restart.
/** The origin the operator configured (admin panel, then BF_PUBLIC_URL), or "". */
async function configuredBaseUrl() {
  let configured = "";
  try {
    configured = String((await db.storeGet("auth.publicUrl")) || "").trim();
  } catch {
    /* store hiccup — fall through to env */
  }
  if (!configured) configured = String(process.env.BF_PUBLIC_URL || "").trim();
  return configured.replace(/\/+$/, "");
}

/** The origin this request arrived on — never empty. */
function requestOrigin(req) {
  const proto = req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function requestBaseUrl(req) {
  return (await configuredBaseUrl()) || requestOrigin(req);
}

// The Host header is attacker-controlled, so a link mailed to a user (password
// reset, e-mail confirmation) must not be built from it blindly — otherwise
// someone can trigger a victim's reset and have the link point at their own
// host. Links use the configured public URL when set (the normal case: prod
// sets BF_PUBLIC_URL and the admin panel's Public URL); otherwise the request
// host is accepted only when it is loopback or explicitly trusted via
// BF_TRUSTED_HOSTS. An untrusted host with nothing configured yields "" — the
// caller then declines to send rather than mail a spoofable link.
function mailHostTrusted(req) {
  const host = String(req.get("host") || "").toLowerCase().split(":")[0];
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const allow = String(process.env.BF_TRUSTED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(host);
}
async function mailLinkBaseUrl(req) {
  const configured = await configuredBaseUrl();
  if (configured) return configured;
  if (mailHostTrusted(req)) return requestOrigin(req);
  console.warn(
    `[mail] refusing to build a link from an untrusted Host "${req.get("host")}" — set BF_PUBLIC_URL (or the admin panel's Public URL), or add the host to BF_TRUSTED_HOSTS.`
  );
  return "";
}

/**
 * Origin for OAuth redirect URIs.
 *
 * These have to be the origin the browser is actually on: the provider — and
 * Supabase — reject a redirect that does not match the one the browser started
 * from, and a "Public URL" that names a domain you have not deployed yet would
 * bounce the user to a host that does not answer. So the configured origin is
 * used only when it is the host being browsed (the normal case behind a
 * reverse proxy); browsing anywhere else — http://localhost:3001 while setting
 * the app up — uses the request's own origin. Everything else that needs an
 * absolute URL (verification and reset links in e-mails) keeps using
 * requestBaseUrl, where the configured domain is the right answer.
 */
async function oauthBaseUrl(req) {
  const configured = await configuredBaseUrl();
  if (!configured) return requestOrigin(req);
  const host = req.get("host");
  if (!host) return configured;
  try {
    if (new URL(configured).host === host) return configured;
  } catch {
    return configured; // not parseable — leave the operator's value alone
  }
  return requestOrigin(req);
}

// OAuth client credentials — configurable in the admin panel (Auth & e-mail,
// secret stored encrypted at rest) with the GOOGLE_* / GITHUB_* env vars as
// fallback. Panel values win. A provider is "configured" only when both its
// client id and secret are set.
const OAUTH_PROVIDERS = {
  google: { idKey: "oauth.google.clientId", secretKey: "oauth.google.clientSecret", idEnv: "GOOGLE_CLIENT_ID", secretEnv: "GOOGLE_CLIENT_SECRET" },
  github: { idKey: "oauth.github.clientId", secretKey: "oauth.github.clientSecret", idEnv: "GITHUB_CLIENT_ID", secretEnv: "GITHUB_CLIENT_SECRET" },
};
async function oauthSetting(key, envKey) {
  try {
    const stored = await db.storeGet(key);
    if (stored) return String(stored);
  } catch {
    /* store hiccup — fall back to env */
  }
  return String(process.env[envKey] || "");
}
async function oauthProvider(name) {
  const p = OAUTH_PROVIDERS[String(name || "").toLowerCase()];
  if (!p) return null;
  const [id, secret] = await Promise.all([
    oauthSetting(p.idKey, p.idEnv),
    oauthSetting(p.secretKey, p.secretEnv),
  ]);
  return { id, secret };
}
async function oauthEnabled() {
  const out = {};
  for (const name of Object.keys(OAUTH_PROVIDERS)) {
    const c = await oauthProvider(name);
    out[name] = !!(c && c.id && c.secret);
  }
  return out;
}

// Public instance config — the login page reads registration policy and the
// public preview reads the operator's non-sensitive Page setup values. Never
// include credentials, database settings or private workflow data here.
app.get("/api/auth/config", async (req, res) => {
  // The login card would otherwise draw two buttons for one provider: Supabase
  // brokers Google and GitHub as well, and both flows can be configured here at
  // the same time. See mergeLoginProviders().
  const supabase = await supabasePublicConfig();
  const oauth = mergeLoginProviders(await oauthEnabled(), supabase.providers.map((p) => p.id));
  res.json({
    allowRegister: !(process.env.BF_ALLOW_REGISTER === "0" || process.env.BF_ALLOW_REGISTER === "false"),
    siteName: (await db.storeGet("page.siteName")) || "W flow",
    siteTagline: (await db.storeGet("page.tagline")) || "",
    authBanner: (await db.storeGet("page.banner")) || "",
    // which OAuth providers are usable right now (client id + secret set)
    oauth,
    // optional Supabase login (server/supabase-auth.js) — the social buttons it
    // should show, and whether passwordless e-mail links are offered
    supabase,
    // whether reset / verification e-mails can actually be delivered
    mailConfigured: await mailConfigured(),
    // whether a password sign-up must open the e-mailed link before logging in
    emailVerificationRequired: await verificationRequired(),
    // where the legal pages (Impressum / Datenschutz) live — the legal
    // subdomain, e.g. https://info.example.com — so the UI can link them.
    legalBase: await legalBaseUrl(),
    // Admin switch: when true the UI hides the Pro page and every legal link.
    hideLegalAndPro: await legalAndProHidden(),
    // Admin switch (Page setup): the "beta test" banner on the welcome page and
    // the note in the workspace. On until the operator turns it off.
    betaBanner: (await db.storeGet("page.betaBanner")) !== "0",
    // Admin switch (Billing / Page setup): whether Pro can be bought right now.
    // While false the UI says "Pro opens next month" instead of "Upgrade".
    salesOpen: await salesOpen(),
    // Where the workspace (cloud version) lives — /cloud by default, movable
    // from the admin panel (Page setup → Workspace path) so the real domain can
    // use /cloud, /app, /studio, …
    cloudPath: (await db.storeGet("site.cloudPath")) || "cloud",
  });
});

// --- e-mail confirmation for password sign-ups -----------------------------
// Only enforced when mail can actually be delivered: a fresh self-hosted copy
// without SMTP would otherwise lock its own owner out. BF_REQUIRE_EMAIL_VERIFY=0
// switches it off even with mail configured.
async function verificationRequired() {
  if (/^(0|false|no|off)$/i.test(String(process.env.BF_REQUIRE_EMAIL_VERIFY || ""))) return false;
  return mailConfigured();
}

/**
 * Mail a fresh confirmation link. Returns sendMail's result, plus the link
 * itself only when BF_EXPOSE_RESET_LINK=1 (tests / local debugging) — exposing
 * it otherwise would let anyone confirm an address they do not own.
 */
async function sendVerifyMail(req, user, { welcome = false } = {}) {
  try {
    return await mailVerifyLink(req, user.email, await db.createAuthToken(user.id, "verify"), { welcome });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** Mail a confirmation link carrying `token` — an auth token or a pending sign-up. */
async function mailVerifyLink(req, email, token, { welcome = false } = {}) {
  try {
    const base = await mailLinkBaseUrl(req);
    if (!base) return { ok: false, error: "This instance has no public URL configured, so confirmation links cannot be built. Ask the operator to set BF_PUBLIC_URL." };
    const link = `${base}/?verify=${encodeURIComponent(token)}`;
    const intro = welcome ? "Welcome to W flow!" : "Here is your W flow confirmation link.";
    const mail = await sendMail({
      to: email,
      subject: "Confirm your W flow e-mail address",
      text: `${intro}\n\nConfirm your e-mail address by opening this link:\n${link}\n\nIf you did not create this account you can ignore this message.`,
      html:
        `<div style="font:15px/1.6 system-ui,sans-serif;color:#111;max-width:520px">` +
        `<p>${intro}</p><p>Confirm your e-mail address to activate your account:</p>` +
        `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#0891b2;color:#fff;border-radius:6px;text-decoration:none">Confirm e-mail address</a></p>` +
        `<p style="color:#555;font-size:13px">Or open this link: ${escapeHtml(link)}</p>` +
        `<p style="color:#555;font-size:13px">If you did not create this account you can ignore this message.</p></div>`,
    });
    return { ...mail, ...(process.env.BF_EXPOSE_RESET_LINK === "1" ? { link } : {}) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

app.post("/api/auth/register", async (req, res) => {
  if (process.env.BF_ALLOW_REGISTER === "0" || process.env.BF_ALLOW_REGISTER === "false") {
    return res.status(403).json({
      error: "Sorry, new sign-ups aren’t open yet.",
      signupDisabled: true,
    });
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (authLimited(ip, req.body?.email)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const name = String(req.body?.name || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (await db.getUserByEmail(email)) {
    return res.status(409).json({ error: "An account with this email already exists. Log in instead." });
  }
  const seat = await seatAvailable();
  if (!seat.ok) return res.status(403).json({ error: seatsFullMessage(seat) });
  // With working mail nothing is created yet: the sign-up waits in
  // pending_signups and becomes an account only when the link is opened, so an
  // address nobody confirmed never turns into an account.
  if (await verificationRequired()) {
    const wait = await claimMailSlot(ip, email);
    if (wait) return mailWaitResponse(res, wait);
    const token = await db.createPendingSignup({ email, name, passwordHash: hashPassword(password) });
    const mail = await mailVerifyLink(req, email, token, { welcome: true });
    if (!mail.ok) {
      await db.deletePendingSignup(email);
      // 503, not 502: Cloudflare swaps an origin's 502/504 for its own error
      // page, and the login card would lose this message.
      return res.status(503).json({
        error: "We could not send the confirmation e-mail, so no account was created. Check the address and try again in a minute.",
      });
    }
    return res.json({
      authed: false,
      verifyRequired: true,
      email,
      message: `We sent a confirmation link to ${email}. Open it to create your account (check the spam folder too).`,
      ...(mail.link ? { verifyLink: mail.link } : {}),
    });
  }
  const user = await db.createUser({ email, name, passwordHash: hashPassword(password) });
  // Adopt any pre-existing (unowned) workflows/agents so nothing is lost. Every
  // item from here on is private to this account (ownerId = user.id). New
  // accounts start with a clean, empty workspace (no demo workflow).
  await adoptUnownedIfOwner(user);
  await syncUserWorkflowAssignments(user.id);
  const session = await db.createUserSession(user.id);
  res.append("Set-Cookie", cookieHeader(session.raw, USER_SESSION_SECONDS));
  // No mail server: the link is only logged, so it cannot gate the login. A
  // mail failure must not block registration — it can be re-sent from Settings.
  await sendVerifyMail(req, user, { welcome: true });
  res.json({ authed: true, email: user.email, name: user.name, emailVerified: false, workflowIds: await db.getUserWorkflowIds(user.id) });
});

app.post("/api/auth/login", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (authLimited(ip, req.body?.email)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = await db.getUserByEmail(email);
  if (!user) {
    // A sign-up still waiting for its link: say so, but only to someone who
    // knows the password — otherwise the answer would reveal pending addresses.
    const pending = await db.getPendingSignup(email);
    if (pending && verifyPassword(password, pending.password_hash)) {
      return res.status(403).json({
        error: "Please confirm your e-mail address first — open the link we sent you, or resend it below.",
        needsVerification: true,
      });
    }
  }
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (String(user.status || "active") !== "active") {
    return res.status(403).json({
      error: "This account has been deactivated.",
      deactivated: true,
      reason: user.deactivation_reason || "The account is currently unavailable.",
    });
  }
  // Admins are exempt so the instance owner can never lock themselves out by
  // switching SMTP on after the fact.
  if (!user.email_verified && String(user.role || "") !== "admin" && (await verificationRequired())) {
    return res.status(403).json({
      error: "Please confirm your e-mail address first — open the link we sent you, or resend it below.",
      needsVerification: true,
    });
  }
  await db.updateLastLogin(user.id);
  // Adopt any pre-existing (unowned) workflows/agents so nothing is lost.
  await adoptUnownedIfOwner(user);
  await syncUserWorkflowAssignments(user.id);
  const session = await db.createUserSession(user.id);
  res.append("Set-Cookie", cookieHeader(session.raw, USER_SESSION_SECONDS));
  res.json({
    authed: true,
    email: user.email,
    name: user.name,
    emailVerified: !!user.email_verified,
    workflowIds: await db.getUserWorkflowIds(user.id),
  });
});

app.post("/api/auth/logout", async (_req, res) => {
  const token = _req.cookies?.[USER_COOKIE];
  if (token) await db.destroyUserSession(token);
  res.setHeader("Set-Cookie", cookieHeader("", 0));
  res.json({ ok: true });
});

// Update the logged-in account: display name, email and/or password.
app.post("/api/auth/account", requireUser, async (req, res) => {
  const user = await db.getUserById(req.user.userId);
  if (!user) return res.status(401).json({ error: "Account not found." });
  const { name, email, current, next } = req.body || {};

  const changingEmail = email !== undefined && String(email).trim().toLowerCase() !== user.email;
  if (changingEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }
    const taken = await db.getUserByEmail(email);
    if (taken && taken.id !== user.id) {
      return res.status(409).json({ error: "That email is already used by another account." });
    }
    // Changing the login address is a takeover-grade action (the new address can
    // then receive a password reset), so require the current password — a stolen
    // session alone must not be enough.
    if (!current || !verifyPassword(String(current), user.password_hash)) {
      return res.status(401).json({ error: "Enter your current password to change the e-mail address." });
    }
  }

  if (next !== undefined && next !== "") {
    if (String(next).length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
    if (!current || !verifyPassword(String(current), user.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
  }

  await db.updateUserProfile(user.id, {
    name: name !== undefined ? name : undefined,
    email: changingEmail ? email : undefined,
  });
  let message = "Account updated.";
  if (changingEmail) {
    // The new mailbox is unproven, so mark it unverified and (when mail works)
    // send a fresh confirmation link to it. Any outstanding reset/verify tokens
    // for this account are dropped so a link sent to the OLD address can't be
    // used against the new one.
    await db.setEmailVerified(user.id, false);
    await db.deleteAuthTokensForUser(user.id);
    if (await mailConfigured()) {
      const fresh = await db.getUserById(user.id);
      await sendVerifyMail(req, fresh);
      message = "E-mail changed — check the new address for a confirmation link.";
    }
  }
  if (next !== undefined && next !== "") {
    await db.updateUserPassword(user.id, hashPassword(String(next)));
    // keep this session, sign out every other device
    const token = req.cookies?.[USER_COOKIE];
    await db.destroyOtherUserSessions(user.id, token ? digestToken(token) : "");
    message = changingEmail ? "Account updated — confirm your new e-mail; other sessions were signed out." : "Account updated — other sessions were signed out.";
  }
  const updated = await db.getUserById(user.id);
  res.json({
    authed: true,
    email: updated.email,
    name: updated.name,
    emailVerified: !!updated.email_verified,
    message,
  });
});

// --- password reset ---------------------------------------------------------
// Always answers 200 so the endpoint cannot be used to probe which e-mails have
// an account. When the account exists a one-hour reset link is mailed.
app.post("/api/auth/forgot", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (authLimited(ip, req.body?.email)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  const message = "If an account exists for that address, a reset link has been sent.";
  const wait = email ? await claimMailSlot(ip, email) : 0;
  if (wait) return mailWaitResponse(res, wait);
  const user = email ? await db.getUserByEmail(email) : null;
  if (!user) return res.json({ ok: true, message });
  // The reset link must never be built from a spoofable Host header: an
  // untrusted host with no configured public URL yields "" and we decline to
  // send (the response stays the same generic message, so it still leaks
  // nothing about which addresses exist).
  const base = await mailLinkBaseUrl(req);
  if (!base) return res.json({ ok: true, message });
  const token = await db.createAuthToken(user.id, "reset");
  const link = `${base}/?reset=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: "Reset your W flow password",
    text: `We received a request to reset your W flow password.\n\nOpen this link to choose a new password (valid for one hour):\n${link}\n\nIf you did not request this, you can ignore this e-mail.`,
  });
  // Tests / self-hosted debugging can read the link directly, but only when
  // explicitly enabled (BF_EXPOSE_RESET_LINK=1). Exposing it merely because no
  // SMTP is configured would let anyone reset any account by typing its e-mail.
  const expose = process.env.BF_EXPOSE_RESET_LINK === "1";
  res.json({ ok: true, message, ...(expose ? { resetLink: link } : {}) });
});

// Finish a reset: consume the token, set the new password, sign other devices out.
app.post("/api/auth/reset", async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const userId = await db.consumeAuthToken(token, "reset");
  if (!userId) return res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
  await db.updateUserPassword(userId, hashPassword(password));
  await db.destroyAllUserSessions(userId);
  res.json({ ok: true, message: "Password updated — you can log in now." });
});

// --- e-mail verification ----------------------------------------------------
app.post("/api/auth/verify-email", async (req, res) => {
  const token = String(req.body?.token || "");
  let userId = await db.consumeAuthToken(token, "verify");
  if (!userId) {
    // A pending password sign-up: this is the moment its account is created.
    // Should the address have gained an account meanwhile (e.g. a Google login),
    // that one is confirmed instead and its password is left alone.
    const pending = await db.consumePendingSignup(token);
    if (pending) {
      const existing = await db.getUserByEmail(pending.email);
      const seat = existing ? null : await seatAvailable();
      if (seat && !seat.ok) return res.status(403).json({ error: seatsFullMessage(seat) });
      userId = (existing || (await db.createUser({ email: pending.email, name: pending.name, passwordHash: pending.password_hash }))).id;
    }
  }
  if (!userId) return res.status(400).json({ error: "This verification link is invalid or has expired." });
  await db.setEmailVerified(userId, true);
  const user = await db.getUserById(userId);
  if (!user) return res.status(400).json({ error: "This verification link is invalid or has expired." });
  // Opening the link proves the mailbox, so it signs the account straight in —
  // the same thing a login would do next.
  if (String(user.status || "active") === "active") {
    await db.updateLastLogin(user.id);
    await adoptUnownedIfOwner(user);
    await syncUserWorkflowAssignments(user.id);
    const session = await db.createUserSession(user.id);
    res.append("Set-Cookie", cookieHeader(session.raw, USER_SESSION_SECONDS));
    return res.json({
      ok: true,
      authed: true,
      emailVerified: true,
      email: user.email,
      name: user.name,
      role: user.role,
      workflowIds: await db.getUserWorkflowIds(user.id),
    });
  }
  res.json({ ok: true, emailVerified: true, email: user.email || "" });
});

// Re-send the verification link to the logged-in account.
app.post("/api/auth/resend-verification", requireUser, async (req, res) => {
  const user = await db.getUserById(req.user.userId);
  if (!user) return res.status(401).json({ error: "Account not found." });
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true, message: "This e-mail address is already verified." });
  const wait = await claimMailSlot(req.ip || req.socket?.remoteAddress || "unknown", user.email);
  if (wait) return mailWaitResponse(res, wait);
  const mail = await sendVerifyMail(req, user);
  res.json({ ok: true, message: "Verification e-mail sent.", ...(mail.link ? { verifyLink: mail.link } : {}) });
});

// Re-send from the login card, where nobody is signed in yet (a pending sign-up,
// or an older account still locked until confirmed). Public, so it answers the
// same whether or not the address is known.
app.post("/api/auth/resend-verification-public", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (authLimited(ip, req.body?.email)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  const message = `If ${email || "that address"} has an unconfirmed account, a new confirmation link is on its way.`;
  const wait = email ? await claimMailSlot(ip, email) : 0;
  if (wait) return mailWaitResponse(res, wait);
  const user = email ? await db.getUserByEmail(email) : null;
  if (!user) {
    const token = email ? await db.renewPendingSignup(email) : null;
    if (!token) return res.json({ ok: true, message });
    const mail = await mailVerifyLink(req, email, token);
    return res.json({ ok: true, message, ...(mail.link ? { verifyLink: mail.link } : {}) });
  }
  if (user.email_verified) return res.json({ ok: true, message });
  const mail = await sendVerifyMail(req, user);
  res.json({ ok: true, message, ...(mail.link ? { verifyLink: mail.link } : {}) });
});

// --- data export (GDPR Art. 20) --------------------------------------------
// Downloads everything the account owns as one JSON file. Credentials are
// blanked, exactly like an exported workflow, so secrets never leave the DB.
app.get("/api/auth/export", requireUser, async (req, res) => {
  const user = await db.getUserById(req.user.userId);
  if (!user) return res.status(401).json({ error: "Account not found." });
  const owned = await workflows.listOwned(user.id);
  const agentList = agents.listOwned(user.id);
  const executions = [];
  for (const wf of owned) {
    const runs = await db.executionsListByWorkflow(wf.id, 200);
    for (const r of runs) executions.push({ ...r, workflowId: wf.id, workflowName: wf.name });
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.created_at,
      emailVerified: !!user.email_verified,
    },
    workflows: owned.map((wf) => stripSecretsFromWorkflow(wf)),
    agents: agentList.map((a) => blankAgentSecrets(a)),
    executions,
  };
  res.setHeader("Content-Disposition", `attachment; filename="wflow-export-${user.id}.json"`);
  res.type("application/json").send(JSON.stringify(payload, null, 2));
});

// --- account deletion (GDPR Art. 17) ---------------------------------------
// Requires the current password. Removes the account's workflows, agents,
// secrets, run history, sessions and the user row itself.
app.post("/api/auth/account/delete", requireUser, async (req, res) => {
  const user = await db.getUserById(req.user.userId);
  if (!user) return res.status(401).json({ error: "Account not found." });
  if (!verifyPassword(String(req.body?.password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Password is incorrect." });
  }
  for (const wf of await workflows.listOwned(user.id)) {
    await db.deleteWorkflowSecrets(wf.id);
    await forgetWorkflowCollab(wf.id);
    await db.executionsRemoveByWorkflow(wf.id);
    await workflows.removeOwned(wf.id, user.id);
    await db.removeWorkflowFromUser(user.id, wf.id);
  }
  for (const agent of agents.listOwned(user.id)) {
    await db.deleteAgentSecrets(agent.id);
    agents.removeOwned(agent.id, user.id);
  }
  // AI-tools tokens, AI budgets and saved AI answers of the account.
  await revokeMcpToken(user.id);
  await forgetAiAccount(user.id);
  await db.deleteAuthTokensForUser(user.id);
  await db.destroyAllUserSessions(user.id);
  // the account's own file folder (My files, Write File) goes with it
  removeAccountFolder(user.id);
  await db.deleteUser(user.id);
  res.setHeader("Set-Cookie", cookieHeader("", 0));
  res.json({ ok: true, message: "Your account and its data have been deleted." });
});

// --- Supabase login (optional identity broker) ------------------------------
// Supabase runs the social providers and the passwordless e-mail links; the
// app still finds-or-creates its own account from the verified address, so
// ownership, quotas and encrypted credentials are untouched. Configurable in
// the admin panel (Auth & e-mail) with SUPABASE_* env vars as the fallback —
// panel values win. See server/supabase-auth.js for the flow itself.
const SUPABASE_FIELDS = {
  url: { key: "oauth.supabase.url", env: "SUPABASE_URL" },
  anonKey: { key: "oauth.supabase.anonKey", env: "SUPABASE_ANON_KEY" },
  providers: { key: "oauth.supabase.providers", env: "SUPABASE_PROVIDERS" },
  magicLink: { key: "oauth.supabase.magicLink", env: "SUPABASE_MAGIC_LINK" },
};
async function supabaseValue(name) {
  const f = SUPABASE_FIELDS[name];
  try {
    const stored = await db.storeGet(f.key);
    if (stored) return String(stored);
  } catch {
    /* store hiccup — fall back to env */
  }
  return String(process.env[f.env] || "");
}
async function supabaseSettings() {
  const [url, anonKey, providersRaw, magicRaw] = await Promise.all([
    supabaseValue("url"),
    supabaseValue("anonKey"),
    supabaseValue("providers"),
    supabaseValue("magicLink"),
  ]);
  // A pasted API path (…/rest/v1) is stripped here as well, so a value saved
  // before the panel started checking it still works.
  const clean = normalizeProjectUrl(url);
  const cleanUrl = clean.url;
  const cleanKey = anonKey.trim();
  return {
    url: cleanUrl,
    anonKey: cleanKey,
    providers: parseProviders(providersRaw),
    // offered by default once Supabase is configured; set 0 to hide the form
    magicLink: magicRaw ? !/^(0|false|no|off)$/i.test(magicRaw) : true,
    // set when the stored URL cannot be used — the login card stays hidden and
    // the endpoints say why instead of failing deep inside the client
    error: clean.error,
    enabled: !!(cleanUrl && cleanKey && !clean.error),
  };
}
/** The subset the login card is allowed to see (never the anon key itself). */
async function supabasePublicConfig() {
  const cfg = await supabaseSettings();
  if (!cfg.enabled) return { enabled: false, providers: [], magicLink: false };
  return {
    enabled: true,
    providers: cfg.providers.map((id) => ({ id, label: providerLabel(id) })),
    magicLink: cfg.magicLink,
  };
}
const supabaseRedirectUri = async (req) => `${await oauthBaseUrl(req)}/api/auth/oauth/supabase/callback`;
// A stored URL that cannot be parsed is reported as-is; anything else just means
// the feature has not been set up yet.
const supabaseDisabled = (cfg) => (cfg.error ? cfg.error : "Supabase login is not configured on this instance.");
const supabaseClientFor = (cfg, req, res) =>
  supabaseClient({ url: cfg.url, anonKey: cfg.anonKey, req, res, secure: COOKIE_SECURE });
const supabaseCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/api/auth/oauth/supabase; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`;

// Workflows/agents without an owner (from before accounts existed, or restored
// from an old backup) go to the instance owner only — the admin role or the
// first account ever created. Handing them to whoever logs in next would give
// a stranger on a multi-user instance someone else's workflows.
async function adoptUnownedIfOwner(user) {
  try {
    let owner = String(user?.role || "") === "admin";
    if (!owner) {
      const list = await db.listUsers();
      const users = Array.isArray(list) ? list : [];
      owner = !!users.length && String(users[users.length - 1].id) === String(user.id);
    }
    if (!owner) return;
    await workflows.claimUnowned(user.id);
    agents.claimUnowned(user.id);
  } catch (e) {
    console.warn("[auth] could not adopt unowned items:", e?.message || e);
  }
}

// Find or create the local account behind a verified external identity (Google,
// GitHub or Supabase) and open the app's own session. The local users table
// stays the single source of truth for ownership, quotas and encrypted data —
// an external login only ever proves the e-mail address. Returns `{ error,
// status }` instead of responding, so each caller keeps its own wording.
async function completeExternalLogin(res, profile) {
  let user = await db.getUserByEmail(profile.email);
  if (!user) {
    const seat = await seatAvailable();
    if (!seat.ok) return { error: seatsFullMessage(seat), status: 403 };
    user = await db.createUser({ email: profile.email, name: profile.name, passwordHash: hashPassword(randomUUID() + randomUUID()) });
    await db.setEmailVerified(user.id, true);
    await adoptUnownedIfOwner(user);
    await syncUserWorkflowAssignments(user.id);
  } else {
    if (!user.email_verified) user = await db.setEmailVerified(user.id, true);
    await adoptUnownedIfOwner(user);
  }
  if (String(user.status || "active") !== "active") {
    return { error: "This account has been deactivated.", status: 403 };
  }
  await db.updateLastLogin(user.id);
  const session = await db.createUserSession(user.id);
  res.append("Set-Cookie", cookieHeader(session.raw, USER_SESSION_SECONDS));
  res.append("Set-Cookie", `bf_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return { ok: true, user };
}

// Start: bounce to Supabase, which runs the social consent screen and comes
// back to the callback below. Each enabled provider is its own button, so the
// requested provider must be one this instance offers (an empty list means
// "whatever SUPABASE_PROVIDERS is set to" has not been filled in yet — accept
// the request then, so a hand-made link still works).
app.get("/api/auth/oauth/supabase/start", async (req, res) => {
  const cfg = await supabaseSettings();
  if (!cfg.enabled) return res.status(400).json({ error: supabaseDisabled(cfg) });
  const provider = String(req.query?.provider || cfg.providers[0] || "").toLowerCase();
  if (!provider) return res.status(400).json({ error: "Choose which provider to sign in with." });
  if (cfg.providers.length && !cfg.providers.includes(provider)) {
    return res.status(400).json({ error: `${providerLabel(provider)} login is not enabled on this instance.` });
  }
  const nonce = randomUUID();
  res.append("Set-Cookie", supabaseCookie(STATE_COOKIE, nonce, 600));
  try {
    const client = supabaseClientFor(cfg, req, res);
    res.redirect(await supabaseAuthorizeUrl({ client, provider, redirectTo: await supabaseRedirectUri(req), nonce }));
  } catch (err) {
    console.error("[supabase] start failed:", err?.message || err);
    res.status(503).json({ error: String(err?.message || "Could not start the Supabase login.") });
  }
});

// Passwordless e-mail: ask Supabase to mail a sign-in link. Supabase delivers
// the mail (its own mailer, or the SMTP configured on the project) — the app's
// own SMTP settings are not involved.
app.post("/api/auth/supabase/magic", async (req, res) => {
  const cfg = await supabaseSettings();
  if (!cfg.enabled) return res.status(400).json({ error: supabaseDisabled(cfg) });
  if (!cfg.magicLink) {
    return res.status(400).json({ error: "E-mail sign-in links are not enabled on this instance." });
  }
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (authLimited(ip, email)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }
  try {
    const client = supabaseClientFor(cfg, req, res);
    await sendMagicLink({ client, email, redirectTo: await supabaseRedirectUri(req) });
    // Deliberately vague: this endpoint is public, so it must not reveal which
    // addresses have an account.
    res.json({ ok: true, message: `If ${email} can sign in, a link is on its way. Check the inbox and the spam folder.` });
  } catch (err) {
    console.error("[supabase] magic link failed:", err?.message || err);
    res.status(503).json({ error: String(err?.message || "Could not send the sign-in link.") });
  }
});

// A provider that does not hand back a code says why with these parameters
// (`error=access_denied` when the user cancels, `error=server_error` with an
// `error_description` when its own exchange fails). Losing them turns a precise
// reason into a shrug, so they are always turned into a readable line.
function oauthRedirectError(query) {
  const q = query || {};
  const code = String(q.error_code || q.error || "").trim();
  const description = String(q.error_description || "").trim();
  const text = description || code;
  if (!text) return "";
  return code && description && !description.includes(code) ? `${code}: ${description}` : text;
}

/** The parameter names a request carried — logged so a failure can be diagnosed. */
const callbackParams = (req) => {
  const names = Object.keys(req.query || {}).sort();
  return names.length ? names.join(",") : "(none)";
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// Constant-time string compare for shared secrets (webhook X-W-Flow-Secret),
// so a caller cannot recover the secret byte-by-byte from response timing.
function timingSafeStrEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Served when a redirect arrives with nothing usable in it. The URL fragment
// never reaches a server, so if the flow came back in one (Supabase's implicit
// style: `#access_token=…` / `#error=…`) the only place to see it is the
// browser — this page reads it out instead of leaving the user with a shrug.
function callbackDiagnosticPage(res, title, detail) {
  res.status(400).type("html").send(`<!doctype html>
<meta charset="utf-8" /><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>body{font:15px/1.6 system-ui,sans-serif;margin:2.5rem auto;max-width:44rem;padding:0 1.25rem;color:#111}
code{background:#f2f2f2;padding:.15rem .35rem;border-radius:4px;word-break:break-all}
.warn{color:#8a3b00}</style>
<h2>${title}</h2>
<p>${detail}</p>
<p class="warn" id="frag">Checking the URL fragment…</p>
<p id="go"></p>
<script>
  var h = new URLSearchParams(location.hash.replace(/^#/, ""));
  var names = Array.from(h.keys()).filter(Boolean);
  var note = names.length
    ? "The URL fragment carried: " + names.join(", ") +
      (h.get("error_description") ? " — " + h.get("error_description") : "")
    : "The URL fragment is empty too.";
  document.getElementById("frag").textContent = note;
  document.getElementById("go").innerHTML = '<a href="/#/">Back to the login page</a>';
<\/script>`);
}

// Callback for both paths: `?code=` (PKCE, social and same-browser e-mail
// links) and `?token_hash=` (e-mail link opened on any device).
app.get("/api/auth/oauth/supabase/callback", async (req, res) => {
  const cfg = await supabaseSettings();
  if (!cfg.enabled) return res.status(400).send(supabaseDisabled(cfg));
  const code = String(req.query?.code || "");
  const tokenHash = String(req.query?.token_hash || "");
  const failure = oauthRedirectError(req.query);
  // Logged for every hit: which parameters came back is the one fact that
  // explains a callback that arrives without a code.
  console.log(`[supabase] callback: ${callbackParams(req)}${failure ? ` — ${failure}` : ""}`);
  if (!code && !tokenHash) {
    if (failure) {
      console.error("[supabase] the project refused the login:", failure);
      return callbackDiagnosticPage(res, "Supabase refused the sign-in", `Supabase reported: <code>${escapeHtml(failure)}</code>`);
    }
    console.error("[supabase] callback arrived without a code or token_hash");
    return callbackDiagnosticPage(
      res,
      "Supabase came back without a sign-in code",
      `The redirect had no <code>code</code> and no <code>token_hash</code> parameter. Check the server log and ` +
        `Supabase → Logs → Auth for the reason, then try again.`
    );
  }
  try {
    const client = supabaseClientFor(cfg, req, res);
    let profile;
    if (tokenHash) {
      profile = await completeWithTokenHash({ client, tokenHash, type: req.query?.type });
    } else {
      // Login-CSRF guard for the social flow. An e-mailed link can be opened in
      // another browser, where this cookie does not exist, so the comparison
      // only applies when both sides are present.
      const nonce = req.cookies?.[STATE_COOKIE];
      const state = String(req.query?.bf_state || "");
      if (nonce && state && nonce !== state) {
        return res.status(400).send("Invalid login state — please try again.");
      }
      profile = await completeWithCode({ client, code });
    }
    const done = await completeExternalLogin(res, profile);
    if (done.error) return res.status(done.status).send(done.error);
    res.append("Set-Cookie", supabaseCookie(STATE_COOKIE, "", 0));
    res.append("Set-Cookie", supabaseCookie(PKCE_COOKIE, "", 0));
    res.redirect("/#/workflows");
  } catch (err) {
    console.error("[supabase] login failed:", err?.message || err);
    res.status(503).send("Login with Supabase failed. Please try again.");
  }
});

// --- OAuth login (Google / GitHub) -----------------------------------------
// Start: bounce to the provider with a random state kept in a short-lived
// cookie. Callback: verify the state, exchange the code, then find or create
// the account and open a session. Both providers must be enabled with
// GOOGLE_CLIENT_ID/SECRET or GITHUB_CLIENT_ID/SECRET.
app.get("/api/auth/oauth/:provider/start", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  const cfg = await oauthProvider(provider);
  if (!cfg) return res.status(404).json({ error: "Unknown login provider." });
  if (!cfg.id || !cfg.secret) {
    const name = provider.charAt(0).toUpperCase() + provider.slice(1);
    return res.status(400).json({ error: `Sorry, signing in with ${name} isn’t available yet.` });
  }
  const nonce = randomUUID();
  const redirectUri = `${await oauthBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
  res.append(
    "Set-Cookie",
    `bf_oauth_state=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${COOKIE_SECURE ? "; Secure" : ""}`
  );
  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", cfg.id);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", nonce);
    url.searchParams.set("prompt", "select_account");
    return res.redirect(url.toString());
  }
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", cfg.id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", nonce);
  res.redirect(url.toString());
});

// Exchange the OAuth code for the account's verified e-mail + display name.
async function fetchOAuthProfile(provider, cfg, code, redirectUri) {
  if (provider === "google") {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.id,
        client_secret: cfg.secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error(tokens.error_description || "Google did not return an access token.");
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json();
    if (!info.email) throw new Error("Google did not return an e-mail address.");
    // Only trust an address Google itself has verified — otherwise someone could
    // sign in with an unverified Google account bearing a victim's address and
    // land in (or create) that account, since login finds-or-creates by email.
    if (info.email_verified === false || info.email_verified === "false") {
      throw new Error("Your Google account's e-mail address is not verified.");
    }
    return { email: String(info.email).toLowerCase(), name: info.name || info.given_name || "" };
  }
  // GitHub
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, client_id: cfg.id, client_secret: cfg.secret, redirect_uri: redirectUri }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) throw new Error(tokens.error_description || "GitHub did not return an access token.");
  const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "wflow" };
  const userRes = await fetch("https://api.github.com/user", { headers });
  const ghUser = await userRes.json();
  let email = ghUser.email ? String(ghUser.email).toLowerCase() : "";
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
    const emails = await emailsRes.json();
    if (Array.isArray(emails)) {
      const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
      if (primary) email = String(primary.email).toLowerCase();
    }
  }
  if (!email) throw new Error("GitHub did not expose a verified e-mail address.");
  return { email, name: ghUser.name || ghUser.login || "" };
}

app.get("/api/auth/oauth/:provider/callback", async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();
  // Connect GitHub shares this callback with GitHub login (one callback URL
  // per GitHub app) — its state tells the two apart.
  if (provider === "github" && isConnectionState(req.query?.state, "github")) {
    return handleConnectionCallback(req, res, "github", `${await oauthBaseUrl(req)}/api/auth/oauth/github/callback`);
  }
  const cfg = await oauthProvider(provider);
  if (!cfg || !cfg.id || !cfg.secret) return res.status(400).send("This login provider is not configured.");
  const nonce = req.cookies?.bf_oauth_state;
  const state = String(req.query?.state || "");
  if (!nonce || nonce !== state) return res.status(400).send("Invalid login state — please try again.");
  const code = String(req.query?.code || "");
  if (!code) {
    // Cancelling on the provider's screen lands here without a code — say so
    // rather than blaming the app for a missing parameter.
    const failure = oauthRedirectError(req.query);
    console.error(`[oauth] ${provider} callback without a code: ${callbackParams(req)}${failure ? ` — ${failure}` : ""}`);
    return res.status(400).send(failure ? `Login with ${providerLabel(provider)} failed: ${failure}` : "Missing authorization code.");
  }
  try {
    // must match the URI the start request sent, hence the same helper
    const redirectUri = `${await oauthBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
    const profile = await fetchOAuthProfile(provider, cfg, code, redirectUri);
    const done = await completeExternalLogin(res, profile);
    if (done.error) return res.status(done.status).send(done.error);
    res.redirect("/#/workflows");
  } catch (err) {
    console.error("[oauth] login failed:", err?.message || err);
    res.status(503).send(`Login with ${provider} failed. Please try again.`);
  }
});

// Every data endpoint requires a login. Webhooks stay public so external
// services can still trigger workflows without an account.
app.use(["/api/workflows", "/api/agents", "/api/ai", "/api/errors", "/api/community", "/api/profile"], requireUser);

// ----------------------------------------------------------------------------
// Workflow folders — small per-account metadata stored in the existing settings
// table. Workflow records keep only the selected folderId, so this works with
// both local JSON and SQL workflow storage without a schema migration.
// ----------------------------------------------------------------------------
const WORKFLOW_FOLDERS_KEY = (userId) => `workflow.folders.${String(userId || "")}`;
// These names belonged to the old implicit-directory implementation. The
// visible Workspace row is a UI root, not a persisted user folder, and
// "Untitled" was only a placeholder. Never expose or recreate either as a
// controllable folder.
const RESERVED_WORKFLOW_FOLDER_NAMES = new Set(["workspace", "untitled", "untitled folder"]);

async function listWorkflowFolders(userId) {
  let parsed;
  try {
    parsed = JSON.parse((await db.storeGet(WORKFLOW_FOLDERS_KEY(userId))) || "[]");
  } catch {
    parsed = [];
  }
  const folders = Array.isArray(parsed)
    ? parsed.filter((f) => f && typeof f.id === "string" && typeof f.name === "string" && !RESERVED_WORKFLOW_FOLDER_NAMES.has(String(f.name).trim().toLowerCase())).map((f) => ({
        id: f.id,
        name: f.name,
        parentId: typeof f.parentId === "string" && f.parentId ? f.parentId : undefined,
        createdAt: f.createdAt,
        home: f.home === true,
      }))
    : [];

  // A stale parent should not make a folder disappear from the directory.
  // Promote it to the workspace root while preserving the folder itself.
  const folderIds = new Set(folders.map((f) => f.id));
  for (const folder of folders) {
    if (folder.parentId && folder.parentId === folder.id) folder.parentId = undefined;
    else if (folder.parentId && !folderIds.has(folder.parentId)) folder.parentId = undefined;
  }

  // Older builds could save a workflow.folderId without saving the matching
  // folder metadata. Do not invent an "Untitled" folder for that case: return
  // the workflow to the workspace's unfiled section instead.
  const knownIds = new Set(folders.map((f) => f.id));
  for (const wf of await workflows.listOwned(userId)) {
    const folderId = String(wf.folderId || "");
    if (!folderId || knownIds.has(folderId)) continue;
    const { folderId: _folderId, ...withoutFolder } = wf;
    await workflows.save(withoutFolder);
  }
  const normalized = JSON.stringify(folders);
  if (normalized !== JSON.stringify(Array.isArray(parsed) ? parsed : [])) {
    await saveWorkflowFolders(userId, folders);
  }
  return folders;
}

async function saveWorkflowFolders(userId, folders) {
  await db.storeSet(WORKFLOW_FOLDERS_KEY(userId), JSON.stringify(folders));
}

async function hasWorkflowFolder(userId, folderId) {
  if (!folderId) return true;
  return (await listWorkflowFolders(userId)).some((f) => f.id === String(folderId));
}

app.get("/api/workflows/folders", async (req, res) => {
  // Every account has a main folder — the explorer reads folders and the
  // workflow list in parallel, so create it here too (idempotent) instead of
  // relying on the workflow-list call to win the race.
  await getOrCreateHomeFolder(req.user.userId);
  res.json(await listWorkflowFolders(req.user.userId));
});

app.post("/api/workflows/folders", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Folder name is required." });
  if (name.length > 80) return res.status(400).json({ error: "Folder names must be 80 characters or fewer." });
  if (RESERVED_WORKFLOW_FOLDER_NAMES.has(name.toLowerCase())) {
    return res.status(400).json({ error: "Workspace and Untitled are reserved directory names. Choose another folder name." });
  }
  const folders = await listWorkflowFolders(req.user.userId);
  const parentId = String(req.body?.parentId || "");
  if (parentId && !folders.some((f) => f.id === parentId)) {
    return res.status(400).json({ error: "That parent folder does not exist." });
  }
  if (folders.some((f) => f.parentId === (parentId || undefined) && f.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "A folder with that name already exists here." });
  }
  const folder = { id: randomUUID(), name, parentId: parentId || undefined, createdAt: new Date().toISOString() };
  folders.push(folder);
  await saveWorkflowFolders(req.user.userId, folders);
  res.json(folder);
});

app.put("/api/workflows/folders/:folderId", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Folder name is required." });
  if (name.length > 80) return res.status(400).json({ error: "Folder names must be 80 characters or fewer." });
  if (RESERVED_WORKFLOW_FOLDER_NAMES.has(name.toLowerCase())) {
    return res.status(400).json({ error: "Workspace and Untitled are reserved directory names. Choose another folder name." });
  }
  const folders = await listWorkflowFolders(req.user.userId);
  const folder = folders.find((f) => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: "Folder not found." });
  if (folders.some((f) => f.id !== folder.id && f.parentId === folder.parentId && f.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "A folder with that name already exists here." });
  }
  folder.name = name;
  await saveWorkflowFolders(req.user.userId, folders);
  res.json(folder);
});

app.delete("/api/workflows/folders/:folderId", async (req, res) => {
  const folders = await listWorkflowFolders(req.user.userId);
  const removed = folders.find((f) => f.id === req.params.folderId);
  if (!removed) return res.status(404).json({ error: "Folder not found." });
  if (removed.home) {
    return res.status(400).json({ error: "This is your main folder — it cannot be deleted. Workflows and subfolders live inside it." });
  }
  // Preserve the tree: deleting a folder promotes its child folders to the
  // deleted folder's parent, while workflows in the deleted folder move into
  // the account's main folder (workflows always live inside the folder tree).
  const promoted = folders
    .filter((f) => f.id !== removed.id)
    .map((f) => f.parentId === removed.id ? { ...f, parentId: removed.parentId } : f);
  await saveWorkflowFolders(req.user.userId, promoted);
  for (const wf of await workflows.listOwned(req.user.userId)) {
    if (wf.folderId === req.params.folderId) {
      const { folderId: _folderId, ...withoutFolder } = wf;
      await workflows.save({ ...withoutFolder, folderId: (await getOrCreateHomeFolder(req.user.userId)).id });
    }
  }
  // A deleted folder cannot stay shared — otherwise the stale share would keep
  // blocking the account's one allowed folder share forever.
  const shares = await listFolderShares();
  const kept = shares.filter(
    (s) => !(String(s.ownerId) === String(req.user.userId) && String(s.folderId) === String(removed.id))
  );
  if (kept.length !== shares.length) await saveFolderShares(kept);
  res.json({ ok: true });
});

// --- folder sharing ----------------------------------------------------------
// Share ONE folder (with the workflows inside it) with another account. An
// account may only have one shared folder at a time, so the explorer always has
// exactly one thing to badge and there is never any doubt about what is shared.
// `includeSubfolders` toggles whether subfolders and their workflows are
// included as well.

// The folder the account shares right now, plus the shares other accounts gave
// it — used by the explorer to badge shared folders and the workflows inside.
app.get("/api/workflows/folder-shares", async (req, res) => {
  const { mine, incoming } = await folderSharesOf(req.user.userId);
  const folders = await listWorkflowFolders(req.user.userId);
  res.json({
    mine: mine.map((s) => ({ ...s, folderName: folders.find((f) => f.id === s.folderId)?.name || s.folderName || "" })),
    incoming: await Promise.all(
      incoming.map(async (s) => {
        const ownerFolders = await listWorkflowFolders(s.ownerId);
        const owner = await db.getUserById(s.ownerId);
        return {
          ...s,
          folderName: ownerFolders.find((f) => f.id === s.folderId)?.name || s.folderName || "",
          ownerEmail: owner?.email || s.ownerEmail || "",
          ownerName: owner?.name || "",
          workflowCount: (await workflows.all()).filter((wf) => wf.folderId === s.folderId).length,
        };
      })
    ),
  });
});

app.get("/api/workflows/folders/:folderId/share", async (req, res) => {
  const folders = await listWorkflowFolders(req.user.userId);
  const folder = folders.find((f) => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: "Folder not found." });
  const current = await folderShareOfOwner(req.user.userId);
  const mine = current && String(current.folderId) === String(folder.id) ? current : null;
  res.json({
    folder: { id: folder.id, name: folder.name },
    share: mine,
    // The account may only have ONE shared folder: a share on a different
    // folder blocks this one until it is ended.
    blockedBy: current && !mine ? { folderId: current.folderId, folderName: folders.find((f) => f.id === current.folderId)?.name || "another folder" } : null,
  });
});

app.post("/api/workflows/folders/:folderId/share", async (req, res) => {
  const folders = await listWorkflowFolders(req.user.userId);
  const folder = folders.find((f) => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: "Folder not found." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address of the user you want to share this folder with." });
  }
  const target = await db.getUserByEmail(email);
  if (!target) return res.status(404).json({ error: `No account with the email "${email}" exists on this instance.` });
  if (target.id === req.user.userId) return res.status(400).json({ error: "This is your own folder already — no need to share it with yourself." });

  const shares = await listFolderShares();
  const existingOther = shares.find((s) => String(s.ownerId) === String(req.user.userId) && String(s.folderId) !== String(folder.id));
  if (existingOther) {
    const otherName = folders.find((f) => f.id === existingOther.folderId)?.name || "another folder";
    return res.status(409).json({
      error: `Only one folder can be shared per account. “${otherName}” is shared already — end that share first, then share “${folder.name}”.`,
    });
  }

  const includeSubfolders = !!req.body?.includeSubfolders;
  const me = await db.getUserById(req.user.userId);
  const next = shares.filter((s) => !(String(s.ownerId) === String(req.user.userId) && String(s.folderId) === String(folder.id)));
  const share = {
    id: `fs-${randomUUID().slice(0, 10)}`,
    folderId: folder.id,
    folderName: folder.name,
    ownerId: req.user.userId,
    ownerEmail: me?.email || "",
    userId: target.id,
    email: target.email,
    name: target.name || "",
    includeSubfolders,
    role: cleanRole(req.body?.role),
    createdAt: new Date().toISOString(),
  };
  next.push(share);
  await saveFolderShares(next);
  res.json({ ok: true, share });
});

// Toggle whether subfolders (and the workflows inside them) are shared too.
app.patch("/api/workflows/folders/:folderId/share", async (req, res) => {
  const shares = await listFolderShares();
  const share = shares.find((s) => String(s.ownerId) === String(req.user.userId) && String(s.folderId) === String(req.params.folderId));
  if (!share) return res.status(404).json({ error: "This folder is not shared." });
  if (req.body?.includeSubfolders !== undefined) share.includeSubfolders = !!req.body.includeSubfolders;
  if (req.body?.role !== undefined) share.role = cleanRole(req.body.role);
  await saveFolderShares(shares);
  res.json({ ok: true, share });
});

app.delete("/api/workflows/folders/:folderId/share", async (req, res) => {
  const shares = await listFolderShares();
  const remaining = shares.filter((s) => !(String(s.ownerId) === String(req.user.userId) && String(s.folderId) === String(req.params.folderId)));
  if (remaining.length === shares.length) return res.status(404).json({ error: "This folder is not shared." });
  await saveFolderShares(remaining);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Home folder — every account gets one main folder automatically. It cannot be
// deleted, and no workflow may live outside it: saves without a folder are
// placed into it, and moving a workflow "out" (unfiled) is rejected. Subfolders
// are allowed, so the home folder acts as the root of the user's directory.
// ----------------------------------------------------------------------------
// Folders flagged `home: true` are the account's main folder. Exactly one
// exists per user; it is created lazily the first time the directory is read.
async function getOrCreateHomeFolder(userId) {
  const folders = await listWorkflowFolders(userId);
  const home = folders.find((f) => f.home === true);
  if (home) return home;
  const folder = { id: `home-${randomUUID().slice(0, 8)}`, name: "My Workflows", home: true, createdAt: new Date().toISOString() };
  folders.unshift(folder);
  await saveWorkflowFolders(userId, folders);
  return folder;
}

// Where a workflow belongs: the requested folder if it exists, otherwise the
// account's home folder. Used by every create / move path so a workflow can
// never end up "unfiled" (outside the user's main folder).
async function resolveWorkflowFolder(userId, folderId) {
  if (folderId && (await hasWorkflowFolder(userId, folderId))) return folderId;
  return (await getOrCreateHomeFolder(userId)).id;
}

// ----------------------------------------------------------------------------
// Collaboration — "give the workflow to another user so you can work together".
// The workflow keeps its single owner; collaborators can open, edit and run it.
// Every save writes the same shared record, so both users always see the same
// workflow. Because two editors are now writing one record, saves on a shared
// workflow are throttled to 1 auto-save per minute — and each user gets one
// separate MANUAL save per minute on top of that, so pressing Save always has
// a budget of its own and the editor can show a clear "no manual saves left"
// state instead of silently dropping the work.
// ----------------------------------------------------------------------------
const COLLAB_SAVE_WINDOW_MS = 60_000;
const COLLAB_SAVE_MAX = 1;
const workflowSaveTimes = new Map(); // workflowId -> [timestamps] (auto-saves)
const workflowManualSaveTimes = new Map(); // `${workflowId}:${userId}` -> [timestamps]

function saveSlotsAllowed(map, key) {
  const now = Date.now();
  const times = (map.get(key) || []).filter((t) => now - t < COLLAB_SAVE_WINDOW_MS);
  if (times.length >= COLLAB_SAVE_MAX) return { allowed: false, retryAfterMs: COLLAB_SAVE_WINDOW_MS - (now - Math.min(...times)) };
  times.push(now);
  map.set(key, times);
  return { allowed: true, retryAfterMs: 0 };
}

// ----------------------------------------------------------------------------
// Folder sharing — "share this folder (and its workflows) with a user".
//
// A folder share is stored in one global registry (the same shape as the other
// collaboration settings) and is deliberately limited to ONE shared folder per
// account: whoever shares must unshare the current one first. That keeps it
// obvious what is shared — no surprises when a second folder quietly opens up.
// `includeSubfolders` decides whether subfolders of the shared folder (and the
// workflows inside them) are shared too.
// ----------------------------------------------------------------------------
const FOLDER_SHARES_KEY = "collab.folderShares";

async function listFolderShares() {
  let parsed;
  try {
    parsed = JSON.parse((await db.storeGet(FOLDER_SHARES_KEY)) || "[]");
  } catch {
    parsed = [];
  }
  return Array.isArray(parsed) ? parsed.filter((s) => s && s.folderId && s.ownerId && s.userId) : [];
}

async function saveFolderShares(list) {
  await db.storeSet(FOLDER_SHARES_KEY, JSON.stringify(list));
}

/** The single folder this owner currently shares with someone (or null). */
async function folderShareOfOwner(ownerId) {
  const shares = await listFolderShares();
  return shares.find((s) => String(s.ownerId) === String(ownerId)) || null;
}

/**
 * Every folder id covered by ONE share: the folder itself plus — when the share
 * includes subfolders — every folder underneath it in the owner's tree.
 */
async function folderIdsOfShare(share) {
  const ids = new Set([String(share.folderId)]);
  if (!share.includeSubfolders) return ids;
  const ownerFolders = await listWorkflowFolders(share.ownerId);
  let frontier = [String(share.folderId)];
  const seen = new Set(frontier);
  while (frontier.length) {
    const children = ownerFolders
      .filter((f) => f.parentId && frontier.includes(String(f.parentId)))
      .map((f) => String(f.id))
      .filter((id) => !seen.has(id));
    children.forEach((id) => {
      seen.add(id);
      ids.add(id);
    });
    frontier = children;
  }
  return ids;
}

/**
 * Every folder id the viewer can reach through a folder share, including the
 * subfolders when the share was created with `includeSubfolders`.
 */
async function folderIdsSharedWith(viewerId) {
  const shares = (await listFolderShares()).filter((s) => String(s.userId) === String(viewerId));
  const ids = new Set();
  for (const share of shares) {
    for (const id of await folderIdsOfShare(share)) ids.add(id);
  }
  return ids;
}

/** Every folder share the viewer granted (one at most) plus the ones granted to them. */
async function folderSharesOf(viewerId) {
  const shares = await listFolderShares();
  return {
    mine: shares.filter((s) => String(s.ownerId) === String(viewerId)),
    incoming: shares.filter((s) => String(s.userId) === String(viewerId)),
  };
}

/** True when the workflow lives in a folder that is shared with this user. */
async function isFolderSharedWith(wf, userId) {
  if (!wf || !wf.folderId || String(wf.ownerId) === String(userId)) return false;
  // Only shares granted BY this workflow's owner count — never a folder id that
  // happens to coincide with one shared by a different owner. (Defence in depth:
  // folder ids are random, but access must key on the owner, not just the id.)
  const shares = (await listFolderShares()).filter(
    (s) => String(s.userId) === String(userId) && String(s.ownerId) === String(wf.ownerId)
  );
  for (const share of shares) {
    if ((await folderIdsOfShare(share)).has(String(wf.folderId))) return true;
  }
  return false;
}

function isCollaborator(wf, userId) {
  return Array.isArray(wf?.collaborators) && wf.collaborators.some((c) => String(c?.userId) === String(userId));
}

// A workflow can be edited by its owner, a workflow collaborator, or anyone the
// folder holding it was shared with.
async function canAccessWorkflow(wf, userId) {
  if (!wf) return false;
  if (String(wf.ownerId) === String(userId)) return true;
  if (isCollaborator(wf, userId)) return true;
  return isFolderSharedWith(wf, userId);
}

// ---- roles on a shared workflow ----
// The owner decides per person what a share allows:
//   viewer — open the workflow, its runs and comments,
//   runner — also run it (Run, Debug, chat, retries),
//   editor — also change and save it (the default: shares from before roles
//            existed were full edit access and stay that way).
const WORKFLOW_ROLES = ["viewer", "runner", "editor"];
const ROLE_RANK = { viewer: 1, runner: 2, editor: 3, owner: 4 };
const cleanRole = (role) => (WORKFLOW_ROLES.includes(role) ? role : "editor");

/** "owner" | "editor" | "runner" | "viewer" | null for this user on `wf`. */
async function workflowRoleOf(wf, userId) {
  if (!wf) return null;
  if (String(wf.ownerId) === String(userId)) return "owner";
  const collab = (Array.isArray(wf.collaborators) ? wf.collaborators : []).find((c) => String(c?.userId) === String(userId));
  let best = collab ? cleanRole(collab.role) : null;
  const shares = (await listFolderShares()).filter((sh) => String(sh.ownerId) === String(wf.ownerId) && String(sh.userId) === String(userId));
  for (const share of shares) {
    if (!(await folderIdsOfShare(share)).has(String(wf.folderId || ""))) continue;
    const r = cleanRole(share.role);
    if (!best || ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  }
  return best;
}

/** Sends 403 and returns true when the user's role on `wf` is below `minRole`. */
async function denyUnlessRole(res, wf, userId, minRole) {
  const role = await workflowRoleOf(wf, userId);
  if (role && ROLE_RANK[role] >= ROLE_RANK[minRole]) return false;
  const can = role === "viewer" ? "only view" : role === "runner" ? "view and run" : "not change";
  res.status(403).json({ error: `You can ${can} this workflow — ask its owner for ${minRole} access.`, role });
  return true;
}

// A workflow is visible to a user when they own it or were given access to it.
async function getAccessibleWorkflow(id, userId) {
  const wf = await workflows.get(id);
  if (!wf) return null;
  return (await canAccessWorkflow(wf, userId)) ? wf : null;
}

// True while a workflow is being worked on by more than one account — through a
// direct workflow collaborator or because its folder is shared.
async function isSharedWorkflow(wf) {
  if (!wf) return false;
  if (Array.isArray(wf.collaborators) && wf.collaborators.length > 0) return true;
  // A folder share covers the folder itself and (when enabled) its subfolders,
  // so the workflows inside any of them are shared as well.
  const shares = (await listFolderShares()).filter((s) => String(s.ownerId) === String(wf.ownerId));
  for (const share of shares) {
    if ((await folderIdsOfShare(share)).has(String(wf.folderId || ""))) return true;
  }
  return false;
}

// Save a workflow with the 1-save-per-minute throttles that apply while a
// workflow is shared: auto-saves are limited per workflow, manual saves per
// user (each editor keeps one deliberate save of their own per minute).
// Returns { ok:true } or { ok:false, error, retryAfterMs }.
async function saveWorkflowThrottled(wf, userId, { manual = false } = {}) {
  if (await isSharedWorkflow(wf)) {
    if (manual) {
      const slot = saveSlotsAllowed(workflowManualSaveTimes, `${wf.id}:${userId}`);
      if (!slot.allowed) {
        return {
          ok: false,
          retryAfterMs: slot.retryAfterMs,
          error: "You already used your manual save for this minute — shared workflows allow 1 manual save per minute and per user. Auto-save keeps saving your changes; try again shortly.",
        };
      }
      await saveWorkflowWithSecrets(wf, userId);
      return { ok: true };
    }
    const slot = saveSlotsAllowed(workflowSaveTimes, wf.id);
    if (!slot.allowed) {
      return {
        ok: false,
        retryAfterMs: slot.retryAfterMs,
        error: "This workflow is shared, and shared workflows allow 1 auto-save per minute. Wait a moment and save again.",
      };
    }
  }
  await saveWorkflowWithSecrets(wf, userId);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Backup buffer — keep the state every save wrote, tagged with whoever saved.
//
// A shared workflow is one record written by two people, so a collaborator who
// stepped away (or whose own save was overwritten ten times) needs a way back:
// the last minute, any of the last saves, or the last save THEY made. This is
// recorded on every successful save and never let a save fail if it hiccups.
// ----------------------------------------------------------------------------
async function recordWorkflowBackup(wf, userId, reason = "save") {
  try {
    const user = userId ? await db.getUserById(userId) : null;
    // Blank every secret field (catalog-driven) before it reaches the backup
    // file — the in-memory copy can still carry the credentials a save lifted
    // into the encrypted table.
    workflowBackups.add(blankSecretsInWorkflow(wf), { userId, userName: user?.name || user?.email || "", reason });
  } catch {
    /* a backup must never break the save it belongs to */
  }
}

// ----------------------------------------------------------------------------
// Loop + execution mode
//
// A workflow can REPEAT itself (Pro): after a run finishes it runs again,
// either a fixed number of times or until it is stopped. The repetition runs
// on the server (server/loop-runner.js), so it keeps going when the page is
// closed. A workflow can also switch from "editor" execution — it runs when
// someone runs it or a trigger fires — to "background" execution, where the
// server starts its loop by itself, even when its owner is signed out. Both
// are Pro perks; a free account cannot switch them on.
// ----------------------------------------------------------------------------
const EXEC_MODES = new Set(["editor", "background"]);
const MAX_LOOP_TIMES = 1000;
const MAX_LOOP_INTERVAL_SECONDS = 86_400;

/**
 * Normalise a workflow's `loop` setting; undefined when repetition is off. Ten
 * or more runs (or a continuous loop) wait at least MIN_LOOP_INTERVAL_SECONDS
 * between runs (shared/loop.js) — a shorter wait is raised, not refused.
 */
function normalizeWorkflowLoop(raw) {
  if (!raw || typeof raw !== "object" || raw.enabled !== true) return undefined;
  const times = Math.max(0, Math.min(MAX_LOOP_TIMES, Math.floor(Number(raw.times) || 0)));
  const asked = Math.max(0, Math.min(MAX_LOOP_INTERVAL_SECONDS, Math.floor(Number(raw.intervalSeconds) || 0)));
  return { enabled: true, times, intervalSeconds: Math.max(loopIntervalFloor(times), asked) };
}

const LOOP_PRO_ERROR = "Repeating a workflow (loop) is a Pro feature — it keeps running on the server even when you close the page. Upgrade on the Pro tab to switch it on.";

/** Same loop setting (a save that only carries the loop along unchanged). */
function sameLoop(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function normalizeExecutionMode(raw, fallback = "editor") {
  const mode = String(raw || "").trim();
  return EXEC_MODES.has(mode) ? mode : fallback;
}

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------
app.get("/api/nodes", (_req, res) => {
  // attach a sample payload for every trigger so the editor's input overview
  // can show which fields a trigger produces before the workflow is run
  const samples = {};
  for (const [type, def] of Object.entries(CATALOG.nodes)) {
    if (def.kind === "trigger") {
      samples[type] = samplePayloadFor({ type, data: { config: def.defaults } });
    }
  }
  res.json({ ...CATALOG, samples });
});

// Error-code reference — shown in Settings → Error codes and mirrored in ERRORS.md
app.get("/api/errors", (_req, res) => {
  res.json(errorCatalog());
});

// ----------------------------------------------------------------------------
// Health — liveness probe for the admin panel's alerts monitor. Public but
// deliberately returns no data (only whether the DB answers), so it leaks
// nothing. A non-2xx response or ok:false raises a "server not responding"
// alert in the admin panel.
// ----------------------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  // Public liveness probe: it only confirms the DB answers. It deliberately
  // leaks nothing — no user count, no engine name, no raw error text (all of
  // which help an attacker fingerprint the instance). The admin panel's own
  // monitor reads richer status over an authenticated channel.
  try {
    await db.countUsers();
    res.json({ ok: true, time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, time: new Date().toISOString() });
  }
});

// ----------------------------------------------------------------------------
// Problem reports — sent by the warning button in Settings. The message is
// e-mailed to the address the operator configured in the admin panel (SMTP →
// From address, fallback MAIL_FROM). Rate limited per IP so the endpoint cannot
// be used to spam the operator; a report must never break the request.
// ----------------------------------------------------------------------------
const reportLimits = new Map();
function reportLimited(ip) {
  const now = Date.now();
  const rec = reportLimits.get(ip) || { count: 0, windowStart: now };
  if (now - rec.windowStart > 10 * 60_000) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count++;
  reportLimits.set(ip, rec);
  return rec.count > 5;
}

app.post("/api/report", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (reportLimited(ip)) {
    return res.status(429).json({ error: "Too many reports. Try again in a few minutes." });
  }
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Please describe the problem first." });
  if (message.length > 4000) return res.status(400).json({ error: "The report is too long (max 4000 characters)." });
  const contact = String(req.body?.contact || "").trim().slice(0, 200);
  // The operator's contact address from the admin panel (falling back to the
  // SMTP From address) — strip an optional "Name <addr>" wrapper from the
  // From fallback so only the address itself is used as recipient.
  const to = await contactRecipient();
  const result = to
    ? await sendMail({
        to,
        subject: "New problem report from W flow",
        text: `A user reported a problem:\n\n${message}\n\n${contact ? `Reported by: ${contact}` : "Reported by: (anonymous)"}`,
      })
    : { skipped: true };
  // The request always succeeds so the UI can thank the user; without SMTP the
  // message is still visible in the server console (sendMail logs it there).
  res.json({
    ok: true,
    message: result.skipped
      ? "Thanks! Your report was noted."
      : result.ok
        ? "Thanks! Your report was sent."
        : "Thanks! Your report was noted.",
  });
});

// ----------------------------------------------------------------------------
// Contact form — the Settings → Contact page. Signed-in users leave their own
// address and a message; it is e-mailed to the address the operator configured
// in the admin panel (Admin → Auth & e-mail → “Contact form e-mail”, falling
// back to the SMTP From address). Limited per account — BF_CONTACT_PER_HOUR
// messages (default 3) in any rolling hour — so a single user cannot flood the
// operator's inbox. Only accepted messages count: a typo in the form never
// uses up a slot.
// ----------------------------------------------------------------------------
const CONTACT_PER_HOUR = Math.max(1, Number(process.env.BF_CONTACT_PER_HOUR) || 3);
const CONTACT_WINDOW_MS = 60 * 60_000;
const contactSent = new Map(); // userId -> send times within the last hour

/** Seconds until this account may send again (0 = it may send now). */
function contactWait(userId) {
  const now = Date.now();
  const recent = (contactSent.get(userId) || []).filter((t) => now - t < CONTACT_WINDOW_MS);
  contactSent.set(userId, recent);
  return recent.length >= CONTACT_PER_HOUR ? Math.ceil((CONTACT_WINDOW_MS - (now - recent[0])) / 1000) : 0;
}

function noteContactSent(userId) {
  contactSent.set(userId, [...(contactSent.get(userId) || []), Date.now()]);
}

// The address contact messages go to (admin panel, then SMTP From, then env).
async function contactRecipient() {
  const stored = ((await db.storeGet("mail.contactEmail")) || process.env.CONTACT_EMAIL || "").trim();
  if (stored) return stored;
  const cfg = await mailConfig();
  const m = String(cfg.from || "").match(/<([^<>]+)>/);
  return (m ? m[1] : String(cfg.from || "")).trim();
}

app.get("/api/contact", requireUser, async (_req, res) => {
  res.json({ to: await contactRecipient() });
});

app.post("/api/contact", requireUser, async (req, res) => {
  const me = await db.getUserById(req.user.userId);
  const email = String(req.body?.email || me?.email || "").trim().slice(0, 200);
  const message = String(req.body?.message || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid e-mail address so we can answer you." });
  }
  if (!message) return res.status(400).json({ error: "Please describe your problem or question first." });
  if (message.length > 4000) return res.status(400).json({ error: "The message is too long (max 4000 characters)." });
  const wait = contactWait(req.user.userId);
  if (wait) {
    const minutes = Math.ceil(wait / 60);
    res.setHeader("Retry-After", String(wait));
    return res.status(429).json({
      error: `You can send up to ${CONTACT_PER_HOUR} message${CONTACT_PER_HOUR === 1 ? "" : "s"} per hour. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      retryAfter: wait,
    });
  }
  noteContactSent(req.user.userId);
  const to = await contactRecipient();
  const result = to
    ? await sendMail({
        to,
        subject: `Contact form — ${email}`,
        text: `A signed-in user sent a message through the contact form.\n\nFrom: ${email}${me?.name ? ` (${me.name})` : ""}\nAccount: ${me?.email || ""}\n\n${message}`,
      })
    : { skipped: true, reason: "no-recipient" };
  // Never lose a message: whenever it could not be e-mailed (no contact address,
  // no SMTP, or a send failure) it is written to the server log instead.
  if (!result.ok) {
    console.log(`[contact] message from ${email}${me?.email && me.email !== email ? ` (account ${me.email})` : ""} — not e-mailed (${result.reason || result.error || "mail not configured"}):
${message}`);
  }
  res.json({
    ok: true,
    message: result.ok
      ? "Thanks! Your message was sent — we will reply to your address."
      : "Thanks! Your message was recorded — we will reply to your address.",
  });
});

// ----------------------------------------------------------------------------
// Credentials vault — per-account secrets (API keys, tokens, passwords) stored
// in the SQL database, encrypted at rest. Only the owning account can read them
// back (GET returns the decrypted fields for the editor).
// ----------------------------------------------------------------------------
async function readCredentialBody(req) {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  const type = String(req.body?.type || "custom").trim().slice(0, 60) || "custom";
  const fields = req.body?.fields && typeof req.body.fields === "object" && !Array.isArray(req.body.fields) ? req.body.fields : {};
  return { name, type, fields };
}

// Connected accounts (type "oauth:*") live in the vault too, but their tokens
// never leave the server: the list shows who is connected, nothing more.
function vaultView(cred) {
  if (!cred || !isConnectionType(cred.type)) return cred;
  const f = cred.fields || {};
  return { ...cred, fields: { provider: f.provider || "", email: f.email || "", scope: f.scope || "" } };
}

app.get("/api/credentials", requireUser, async (req, res) => {
  res.json((await db.credentialsList(req.user.userId)).map(vaultView));
});

app.get("/api/credentials/:id", requireUser, async (req, res) => {
  const cred = await db.credentialGet(req.params.id, req.user.userId);
  if (!cred) return res.status(404).json({ error: "Credential not found." });
  res.json(vaultView(cred));
});

app.post("/api/credentials", requireUser, async (req, res) => {
  const { name, type, fields } = await readCredentialBody(req);
  if (!name) return res.status(400).json({ error: "Give the credential a name." });
  const cred = await db.credentialCreate({ userId: req.user.userId, name, type, fields });
  res.status(201).json(cred);
});

app.put("/api/credentials/:id", requireUser, async (req, res) => {
  const { name, type, fields } = await readCredentialBody(req);
  if (!name) return res.status(400).json({ error: "Give the credential a name." });
  const existing = await db.credentialGet(req.params.id, req.user.userId);
  if (!existing) return res.status(404).json({ error: "Credential not found." });
  // A connected account can only be renamed — the editor never sees its
  // tokens, so saving its (masked) fields back would disconnect it.
  const cred = isConnectionType(existing.type)
    ? await db.credentialUpdate(existing.id, req.user.userId, { name, type: existing.type, fields: existing.fields })
    : await db.credentialUpdate(req.params.id, req.user.userId, { name, type, fields });
  res.json(vaultView(cred));
});

// ----------------------------------------------------------------------------
// Connected accounts — "Connect Google / GitHub / Slack / …" on workflow nodes
// (server/oauth-connections.js). The node's picker opens /start in a popup;
// the provider sends the user back to /callback, which stores the connection
// and tells the opener through postMessage.
// ----------------------------------------------------------------------------
app.get("/api/connections", requireUser, async (req, res) => {
  const provider = CONNECTION_PROVIDERS[String(req.query.provider || "")] ? String(req.query.provider) : undefined;
  res.json({
    providers: await connectionProviders(),
    // node types that keep their pasted-token field here (unverified Google scopes)
    unavailable: unavailableConnectionNodes(scopePolicy()),
    labels: Object.fromEntries(Object.entries(CONNECTION_PROVIDERS).map(([id, p]) => [id, p.label])),
    connections: await listConnections(req.user.userId, provider),
  });
});

// GitHub allows one callback URL per OAuth app. Connect GitHub reuses the
// login app, so it redirects to EXACTLY the login callback — not a path below
// it, which GitHub rejects ("redirect_uri is not associated with this
// application") whenever the registered URL is not that exact callback. The
// login callback hands a request whose `state` came from a Connect flow over
// to handleConnectionCallback. The older sub-path stays routed so a connect
// started before a deploy can still finish.
const GITHUB_CONNECT_PATH = "/api/auth/oauth/github/callback/connect";
const connectionRedirectUri = async (req, provider) =>
  `${await oauthBaseUrl(req)}${provider === "github" ? "/api/auth/oauth/github/callback" : `/api/connections/${provider}/callback`}`;

app.get("/api/connections/:provider/start", requireUser, async (req, res) => {
  const provider = String(req.params.provider || "");
  if (!CONNECTION_PROVIDERS[provider]) return res.status(404).send("Unknown account provider.");
  const cfg = await connectionConfig(provider);
  if (!cfg) {
    return connectionPopup(res, req, { ok: false, error: `Sorry, connecting ${CONNECTION_PROVIDERS[provider].label} isn’t available yet.` });
  }
  // Scopes come from the catalog, never from the query string, so a crafted
  // link cannot ask for more than the service's nodes need. Without a node
  // (Credentials → Connected accounts) the connection asks for every scope the
  // service's nodes use, so one connection works on all of them. Either way
  // only scopes this instance may ask for (scopePolicy) reach the consent screen.
  const nodeType = String(req.query.node || "");
  const policy = scopePolicy();
  let scopes;
  if (nodeType) {
    const spec = oauthSpecFor(nodeType);
    if (!spec || spec.provider !== provider) return res.status(400).send("This node does not use that account type.");
    if (!connectAllowed(spec, policy)) {
      return connectionPopup(res, req, { ok: false, error: `This node can’t connect a ${CONNECTION_PROVIDERS[provider].label} account here. Paste an access token in its advanced field instead.` });
    }
    scopes = scopesFor(spec);
  } else {
    scopes = providerScopes(provider, policy);
  }
  const state = createConnectionState({ userId: req.user.userId, provider, scopes });
  res.redirect(connectionAuthorizeUrl(provider, cfg, { redirectUri: await connectionRedirectUri(req, provider), state, scopes }));
});

app.get(["/api/connections/:provider/callback", GITHUB_CONNECT_PATH], (req, res) =>
  handleConnectionCallback(req, res, req.path === GITHUB_CONNECT_PATH ? "github" : String(req.params.provider || ""))
);

async function handleConnectionCallback(req, res, provider, redirectUri) {
  if (!CONNECTION_PROVIDERS[provider]) return res.status(404).send("Unknown account provider.");
  const entry = takeConnectionState(req.query.state, provider);
  if (!entry) return connectionPopup(res, req, { ok: false, error: "This sign-in link has expired. Close this window and click Connect again." });
  // The state was issued to a signed-in account; the same browser session must
  // finish it, or someone could plant their mailbox in another workspace.
  const session = await currentUser(req);
  if (!session || String(session.userId) !== entry.userId) {
    return connectionPopup(res, req, { ok: false, error: "Sign in to W flow in this browser, then click Connect again." });
  }
  const code = String(req.query.code || "");
  if (!code) {
    const failure = oauthRedirectError(req.query);
    return connectionPopup(res, req, { ok: false, error: failure || "The sign-in was cancelled." });
  }
  try {
    const cfg = await connectionConfig(provider);
    if (!cfg) throw new Error("sign-in is not configured");
    const connection = await completeConnection({
      provider,
      cfg,
      code,
      // the token exchange must repeat the redirect the authorize step used
      redirectUri: redirectUri || (req.path === GITHUB_CONNECT_PATH ? `${await oauthBaseUrl(req)}${GITHUB_CONNECT_PATH}` : await connectionRedirectUri(req, provider)),
      userId: entry.userId,
      entry,
      query: req.query,
    });
    connectionPopup(res, req, { ok: true, connection });
  } catch (err) {
    console.error(`[connections] ${provider} connect failed:`, err?.message || err);
    connectionPopup(res, req, { ok: false, error: `Connecting the ${CONNECTION_PROVIDERS[provider].label} account failed: ${err?.message || err}` });
  }
}

/** The page the popup lands on: hand the result to the opener and close. */
async function connectionPopup(res, req, result) {
  const origin = await oauthBaseUrl(req);
  // JSON inside <script>: escape "<" so a crafted error text cannot end the tag
  const payload = JSON.stringify({ type: "wflow-oauth", ...result }).replace(/</g, "\\u003c");
  const message = result.ok ? "Account connected — you can close this window." : String(result.error || "Something went wrong.");
  res
    .status(result.ok ? 200 : 400)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>W flow</title>` +
        `<body style="font:15px system-ui,sans-serif;background:#0b1020;color:#e6ecff;display:grid;place-items:center;min-height:90vh;margin:0">` +
        `<p style="max-width:420px;text-align:center;padding:0 16px">${escapeHtml(message)}</p>` +
        `<script>try{window.opener&&window.opener.postMessage(${payload},${JSON.stringify(origin)});}catch(e){}` +
        (result.ok ? "setTimeout(function(){window.close()},600);" : "") +
        "</script></body>"
    );
}

// ----------------------------------------------------------------------------
// Connected Telegram bots (server/telegram-bots.js). Telegram has no OAuth for
// bots, so "Connect" takes the @BotFather token once; "Find my chat" lists the
// chats that messaged the bot so the user can link their own account.
// ----------------------------------------------------------------------------
app.get("/api/telegram/bots", requireUser, async (req, res) => {
  res.json({ bots: await listTelegramBots(req.user.userId) });
});

app.post("/api/telegram/bots", requireUser, async (req, res) => {
  try {
    res.status(201).json({ bot: await connectTelegramBot(req.user.userId, req.body?.botToken) });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get("/api/telegram/bots/:id/chats", requireUser, async (req, res) => {
  try {
    res.json({ chats: await recentTelegramChats({ id: req.params.id, userId: req.user.userId }) });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// ----------------------------------------------------------------------------
// Connected Telegram accounts (server/telegram-accounts.js) — a personal
// account instead of a bot. Login is two steps: the phone number (Telegram
// sends a code; the user's own API ID + hash only without a site-wide app), then the code and, when the
// account has one, its 2-step password. Code requests are capped per user so
// the form cannot be used to spam someone's phone.
// ----------------------------------------------------------------------------
const TG_LOGIN_LIMIT = 5;
const TG_LOGIN_WINDOW_MS = 60 * 60_000;
const tgLoginAttempts = new Map(); // userId → [epoch ms]

app.get("/api/telegram/accounts", requireUser, async (req, res) => {
  // needsApiKeys: no site-wide Telegram app is set up, so the login form has
  // to ask for the user's own API ID + hash next to the phone number.
  res.json({ accounts: await listTelegramAccounts(req.user.userId), needsApiKeys: !(await telegramAppCredentials()) });
});

// Every step that makes Telegram send something (a code, an SMS, a mail)
// counts against the same per-user budget.
function tgSendAllowed(req, res) {
  const now = Date.now();
  const recent = (tgLoginAttempts.get(req.user.userId) || []).filter((t) => now - t < TG_LOGIN_WINDOW_MS);
  if (recent.length >= TG_LOGIN_LIMIT) {
    res.status(429).json({ error: "Too many login codes requested — try again in an hour." });
    return false;
  }
  tgLoginAttempts.set(req.user.userId, [...recent, now]);
  return true;
}

const tgStep = (fn, { sends = false } = {}) => async (req, res) => {
  if (sends && !tgSendAllowed(req, res)) return;
  try {
    res.json(await fn(req.user.userId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
};

app.post("/api/telegram/accounts/login", requireUser, tgStep(startTelegramLogin, { sends: true }));
// "Send the code another way" — Telegram's next delivery method (e.g. SMS).
app.post("/api/telegram/accounts/resend", requireUser, tgStep(resendTelegramCode, { sends: true }));
// Telegram demanded a login e-mail before it sends codes to apps.
app.post("/api/telegram/accounts/email", requireUser, tgStep(setupTelegramLoginEmail, { sends: true }));
app.post("/api/telegram/accounts/email/verify", requireUser, tgStep(verifyTelegramLoginEmail));
// QR login — scan in the Telegram app instead of waiting for a code. The form
// polls /qr/status until the scan (a 2-step password then goes to /verify).
app.post("/api/telegram/accounts/qr", requireUser, tgStep(startTelegramQrLogin, { sends: true }));
app.post("/api/telegram/accounts/qr/status", requireUser, tgStep(telegramQrStatus));

app.post("/api/telegram/accounts/verify", requireUser, async (req, res) => {
  try {
    res.json(await finishTelegramLogin(req.user.userId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get("/api/telegram/accounts/:id/chats", requireUser, async (req, res) => {
  try {
    res.json({ chats: await recentTelegramAccountChats({ id: req.params.id, userId: req.user.userId }) });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.delete("/api/credentials/:id", requireUser, async (req, res) => {
  // A Telegram account's session is a full login — end it at Telegram too.
  const cred = await db.credentialGet(req.params.id, req.user.userId);
  if (cred?.type === TELEGRAM_ACCOUNT_TYPE) await logoutTelegramAccount(cred);
  const ok = await db.credentialRemove(req.params.id, req.user.userId);
  if (!ok) return res.status(404).json({ error: "Credential not found." });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// My files — the account's own folder the file nodes work in (server/disk.js):
// Write File saves there, Read File / List Files read from it. The page lists
// it and lets the user download, upload and delete. Storage per account
// depends on the plan (filesQuotaBytes: Free 25 MB, Pro 500 MB), so the shared
// disk cannot be filled by one account; a single upload is capped too.
// ----------------------------------------------------------------------------
const FILES_MAX_UPLOAD_MB = Math.max(1, Number(process.env.BF_FILES_MAX_UPLOAD_MB || 25));
const fmtMb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

app.get("/api/files", requireUser, async (req, res) => {
  const listed = listFilesOnDisk("", "", true, req.user.userId);
  if (!listed.ok) return res.status(400).json({ error: listed.error });
  const files = listed.files.filter((f) => !f.isDir).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  res.set("Cache-Control", "no-store");
  res.json({
    files,
    usedBytes: files.reduce((n, f) => n + (f.size || 0), 0),
    limitBytes: await filesQuotaBytes(req.user.userId),
    maxUploadBytes: FILES_MAX_UPLOAD_MB * 1024 * 1024,
    pro: await isProUser(req.user.userId),
  });
});

app.get("/api/files/download", requireUser, (req, res) => {
  const target = safeFilePath(String(req.query.path || ""), req.user.userId);
  if (!target.ok) return res.status(400).json({ error: target.error });
  if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
    return res.status(404).json({ error: "That file is no longer on the server." });
  }
  res.set("Cache-Control", "no-store");
  res.download(target.fullPath, path.basename(target.fullPath));
});

// The body is the raw file; its name travels in ?path= (relative to the folder).
app.post(
  "/api/files/upload",
  requireUser,
  express.raw({ type: () => true, limit: `${FILES_MAX_UPLOAD_MB}mb` }),
  async (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) return res.status(400).json({ error: "The file is empty." });
    const rel = String(req.query.path || "");
    const target = safeFilePath(rel, req.user.userId);
    if (!target.ok) return res.status(400).json({ error: target.error });
    const limit = await filesQuotaBytes(req.user.userId);
    if (!fitsInFolder(rel, data.length, req.user.userId, limit)) {
      const upsell = (await isProUser(req.user.userId)) ? "" : " — or go Pro for 500 MB";
      return res.status(413).json({ error: `Your files would use more than your ${fmtMb(limit)}. Delete some files first${upsell}.` });
    }
    const saved = writeFileBytes(rel, data, req.user.userId);
    if (!saved.ok) return res.status(400).json({ error: saved.error });
    res.json({ ok: true, path: saved.path, size: saved.size });
  }
);

app.delete("/api/files", requireUser, (req, res) => {
  const removed = deleteFileOnDisk(String(req.query.path || ""), req.user.userId);
  if (!removed.ok) return res.status(/not found/i.test(removed.error) ? 404 : 400).json({ error: removed.error });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Variables — named values an account can reference from its workflows.
// Secrets are encrypted at rest; values are only ever returned to their owner.
// ----------------------------------------------------------------------------
app.get("/api/variables", requireUser, async (req, res) => {
  res.json(await db.variablesList(req.user.userId));
});

app.post("/api/variables", requireUser, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "Give the variable a name." });
  const variable = await db.variableCreate({
    userId: req.user.userId,
    name,
    value: req.body?.value === undefined ? "" : String(req.body.value),
    testValue: req.body?.testValue === undefined ? "" : String(req.body.testValue),
    secret: !!req.body?.secret,
  });
  res.status(201).json(variable);
});

app.put("/api/variables/:id", requireUser, async (req, res) => {
  const variable = await db.variableUpdate(req.params.id, req.user.userId, {
    name: req.body?.name === undefined ? undefined : String(req.body.name).trim().slice(0, 120),
    value: req.body?.value === undefined ? undefined : String(req.body.value),
    testValue: req.body?.testValue === undefined ? undefined : String(req.body.testValue),
    secret: req.body?.secret === undefined ? undefined : !!req.body.secret,
  });
  if (!variable) return res.status(404).json({ error: "Variable not found." });
  res.json(variable);
});

app.delete("/api/variables/:id", requireUser, async (req, res) => {
  const ok = await db.variableRemove(req.params.id, req.user.userId);
  if (!ok) return res.status(404).json({ error: "Variable not found." });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Data tables — lightweight spreadsheets stored in SQL, one set per account.
// Columns are a JSON array of names; each row is a JSON object of values.
// ----------------------------------------------------------------------------
async function requireOwnedTable(req, res) {
  const table = await db.dataTableGet(req.params.id, req.user.userId);
  if (!table) {
    res.status(404).json({ error: "Data table not found." });
    return null;
  }
  return table;
}

app.get("/api/data-tables", requireUser, async (req, res) => {
  res.json(await db.dataTablesList(req.user.userId));
});

app.post("/api/data-tables", requireUser, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "Give the data table a name." });
  const rawColumns = Array.isArray(req.body?.columns) ? req.body.columns : [];
  const columns = rawColumns.map((c) => String(c).trim().slice(0, 120)).filter(Boolean).slice(0, 60);
  const table = await db.dataTableCreate({ userId: req.user.userId, name, columns: columns.length ? columns : ["name", "value"] });
  res.status(201).json(table);
});

// Import a CSV / TSV document into a data table in one request: with a tableId
// the parsed rows are appended to that table (any column the file brings along
// is added first), without one a new table is created. The whole file arrives as
// text, so a pasted or uploaded CSV never turns into one request per row.
const DATA_TABLE_IMPORT_MAX_ROWS = 5000; // 5000 × 6 params stays under PostgreSQL's bind limit
const DATA_TABLE_MAX_COLUMNS = 60; // same caps as POST /api/data-tables

app.post("/api/data-tables/import", requireUser, async (req, res) => {
  const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
  if (!csv.trim()) return res.status(400).json({ error: "Paste CSV content or choose a .csv file first." });

  const parsed = csvToTable(csv, {
    delimiter: typeof req.body?.delimiter === "string" ? req.body.delimiter : "auto",
    headerRow: req.body?.headerRow !== false,
    maxRows: DATA_TABLE_IMPORT_MAX_ROWS,
  });
  const columns = parsed.columns.map((c) => String(c).trim().slice(0, 120)).filter(Boolean).slice(0, DATA_TABLE_MAX_COLUMNS);
  if (!columns.length) return res.status(400).json({ error: "Could not find any columns in that CSV." });

  const userId = req.user.userId;
  let table = null;
  if (req.body?.tableId) {
    table = await db.dataTableGet(String(req.body.tableId), userId);
    if (!table) return res.status(404).json({ error: "Data table not found." });
  } else {
    const name = String(req.body?.name || "Imported table").trim().slice(0, 120) || "Imported table";
    table = await db.dataTableCreate({ userId, name, columns });
  }

  const merged = [...table.columns];
  for (const c of columns) if (!merged.includes(c) && merged.length < DATA_TABLE_MAX_COLUMNS) merged.push(c);
  if (merged.length !== table.columns.length) table = await db.dataTableUpdate(table.id, userId, { columns: merged });

  const rows = parsed.rows.map((r) => {
    const row = {};
    for (const c of merged) row[c] = r[c] === undefined ? "" : r[c];
    return row;
  });
  const imported = await db.dataTableRowCreateMany({ tableId: table.id, userId, rows });
  res.status(201).json({ table, imported, columns: merged });
});

app.put("/api/data-tables/:id", requireUser, async (req, res) => {
  if (!(await requireOwnedTable(req, res))) return;
  const columns = Array.isArray(req.body?.columns) ? req.body.columns.map((c) => String(c).trim().slice(0, 120)).filter(Boolean).slice(0, 60) : undefined;
  const table = await db.dataTableUpdate(req.params.id, req.user.userId, {
    name: req.body?.name === undefined ? undefined : String(req.body.name).trim().slice(0, 120),
    columns,
  });
  res.json(table);
});

app.delete("/api/data-tables/:id", requireUser, async (req, res) => {
  const ok = await db.dataTableRemove(req.params.id, req.user.userId);
  if (!ok) return res.status(404).json({ error: "Data table not found." });
  res.json({ ok: true });
});

app.get("/api/data-tables/:id/rows", requireUser, async (req, res) => {
  if (!(await requireOwnedTable(req, res))) return;
  res.json(await db.dataTableRowsList(req.params.id, req.user.userId));
});

app.post("/api/data-tables/:id/rows", requireUser, async (req, res) => {
  if (!(await requireOwnedTable(req, res))) return;
  const data = req.body?.data && typeof req.body.data === "object" && !Array.isArray(req.body.data) ? req.body.data : {};
  res.status(201).json(await db.dataTableRowCreate({ tableId: req.params.id, userId: req.user.userId, data }));
});

app.put("/api/data-tables/:id/rows/:rowId", requireUser, async (req, res) => {
  if (!(await requireOwnedTable(req, res))) return;
  const data = req.body?.data && typeof req.body.data === "object" && !Array.isArray(req.body.data) ? req.body.data : {};
  const row = await db.dataTableRowUpdate(req.params.rowId, req.user.userId, data);
  if (!row) return res.status(404).json({ error: "Row not found." });
  res.json(row);
});

app.delete("/api/data-tables/:id/rows/:rowId", requireUser, async (req, res) => {
  if (!(await requireOwnedTable(req, res))) return;
  const ok = await db.dataTableRowRemove(req.params.rowId, req.user.userId);
  if (!ok) return res.status(404).json({ error: "Row not found." });
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Executions — every run of any workflow the account owns, newest first. Powers
// the global Executions page (the per-workflow history lives under /api/workflows).
// ----------------------------------------------------------------------------
app.get("/api/executions", requireUser, async (req, res) => {
  const limit = Number(req.query?.limit) || 50;
  const live = [...waitsFor((w) => w.ownerId === req.user.userId), ...runningForOwner(req.user.userId)];
  res.json(withRunning(live, await db.executionsListByOwner(req.user.userId, limit)));
});

// User guide (markdown) — the raw docs/guide.md, for tooling / the PDF renderer
// below. Served from a file so the docs live outside the UI code.
app.get("/api/docs", (_req, res) => {
  const guidePath = path.join(__dirname, "..", "docs", "guide.md");
  try {
    res.type("text/markdown; charset=utf-8").send(fs.readFileSync(guidePath, "utf8"));
  } catch {
    res.status(500).json({ error: "Guide not available." });
  }
});

// User guide as a downloadable PDF (Settings → Download PDF). Rendered from the
// same docs/guide.md with PDFKit; served as an attachment so the browser saves
// the file instead of showing it.
app.get("/api/docs/pdf", async (_req, res) => {
  const guidePath = path.join(__dirname, "..", "docs", "guide.md");
  try {
    const pdf = await renderGuidePdf(fs.readFileSync(guidePath, "utf8"));
    res.setHeader("Content-Disposition", 'attachment; filename="wflow-user-guide.pdf"');
    res.type("application/pdf").send(pdf);
  } catch (err) {
    console.error("[docs] PDF render failed:", err);
    res.status(500).json({ error: "Guide not available." });
  }
});

// ----------------------------------------------------------------------------
// Workflows — every workflow belongs to the logged-in account (ownerId). A
// user can only list / read / edit / run / delete their own workflows; other
// accounts' workflows are invisible (404).
//
// Credentials entered on nodes (AI Agent inline model key, HTTP auth, Slack /
// Telegram tokens, …) are lifted out of the JSON on save into the encrypted
// workflow_secrets table and blanked in the stored copy; when the owner opens
// (GET) or runs the workflow they are re-injected. Exported JSON and community
// posts read the stored copy, so they never contain the values.
// ----------------------------------------------------------------------------
async function hydrateWorkflowSecrets(wf) {
  return hydrateSecretsInWorkflow(wf, await db.getWorkflowSecrets(wf.id));
}

// A custom webhook URL part ("slug") — the workflow's public webhook URL can be
// changed by the user to something readable, e.g. /webhook/my-scraper. Slug is
// unique across all workflows; when set, /webhook/<slug> resolves to this
// workflow exactly like /webhook/<workflow-id>.
function normalizeWebhookSlug(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s;
}

async function slugTaken(slug, excludeId) {
  if (!slug) return false;
  for (const wf of await workflows.all()) {
    if (String(wf.webhookSlug || "").toLowerCase() === slug && wf.id !== excludeId) return true;
  }
  return false;
}

app.get("/api/workflows", async (req, res) => {
  // Normalize legacy folder metadata and ensure the account's home folder
  // exists; then return everything the user can see: their own workflows and
  // workflows other users shared with them (collaboration).
  await getOrCreateHomeFolder(req.user.userId);
  const owned = await workflows.listOwned(req.user.userId);
  const shared = await workflows.listSharedWith(req.user.userId);
  // Workflows that live in a folder another account shared with this user are
  // reachable too (when the share includes subfolders, everything below it).
  const folderSharedIds = await folderIdsSharedWith(req.user.userId);
  const viaFolder = folderSharedIds.size
    ? (await workflows.all()).filter(
        (wf) =>
          String(wf.ownerId) !== String(req.user.userId) &&
          wf.folderId &&
          folderSharedIds.has(String(wf.folderId)) &&
          !shared.some((s) => s.id === wf.id)
      )
    : [];
  const sharedIds = new Set([...shared, ...viaFolder].map((wf) => wf.id));
  // Workflows must always live inside a folder — legacy unfiled records are
  // moved into the home folder on read so they are never "outside".
  const home = await getOrCreateHomeFolder(req.user.userId);
  const normalize = async (wf) => {
    if (wf.folderId) return wf;
    const fixed = { ...wf, folderId: home.id };
    await workflows.save(fixed);
    return fixed;
  };
  const ownList = await Promise.all(owned.map(normalize));
  // Shared workflows are the OWNER's record — the viewer must never write
  // their own folder id into it (that would hide the workflow from the owner's
  // explorer). For display they are mapped into the viewer's home folder, so
  // they stay visible in the explorer without touching the stored record. A
  // workflow reached through a folder share also carries the OWNER's folder id
  // (read-only display data) so the explorer can list it under "shared with
  // you" alongside the rest of that folder.
  const myFolderShares = (await listFolderShares()).filter((s) => String(s.userId) === String(req.user.userId));
  // The shared folder's name is resolved live (a rename must not leave a stale
  // label in the viewer's explorer).
  const sharedFolderName = new Map();
  for (const share of myFolderShares) {
    const ownerFolders = await listWorkflowFolders(share.ownerId);
    sharedFolderName.set(String(share.folderId), ownerFolders.find((f) => f.id === share.folderId)?.name || share.folderName || "");
  }
  const sharedList = [...shared, ...viaFolder].map((wf) => {
    const sharedViaFolder = folderSharedIds.has(String(wf.folderId || ""));
    return {
      ...wf,
      folderId: home.id,
      sharedViaFolder: sharedViaFolder || undefined,
      sharedFolderId: sharedViaFolder ? wf.folderId : undefined,
      sharedFolderName: sharedViaFolder ? sharedFolderName.get(String(wf.folderId)) || "" : undefined,
    };
  });
  // The OWNER also needs to know when a folder share covers one of their
  // workflows — the editor then enables the shared-editing features (save
  // budget, “who is editing which node” marker) for their side as well.
  const ownShare = (await listFolderShares()).find((s) => String(s.ownerId) === String(req.user.userId));
  const ownSharedFolderIds = ownShare ? await folderIdsOfShare(ownShare) : new Set();
  res.json(
    [...ownList, ...sharedList].map((wf) => ({
      ...wf,
      shared: wf.ownerId !== req.user.userId,
      collaborators: wf.ownerId === req.user.userId ? (wf.collaborators || []) : undefined,
      folderShared: ownShare && ownSharedFolderIds.has(String(wf.folderId || "")) ? true : undefined,
      folderSharedWith: ownShare && ownSharedFolderIds.has(String(wf.folderId || "")) ? ownShare.email : undefined,
    }))
  );
});

// Creating and saving a workflow — shared by the editor's API below and the
// MCP builder tools (server/mcp.js), so a workflow an AI assistant writes goes
// through exactly the same plan limits, folder rules, secret handling and
// version snapshots as one saved in the editor. Each returns { status, json }.
const reply = (status, json) => ({ status, json });

async function createWorkflowForUser(userId, body) {
  // Free plan: a saved-workflow cap (Pro removes it). Deleting one frees a slot.
  if (!(await isProUser(userId))) {
    const owned = await workflows.listOwned(userId);
    if (owned.length >= FREE_MAX_WORKFLOWS) {
      return reply(403, {
        error: `The free plan allows up to ${FREE_MAX_WORKFLOWS} saved workflows. Delete one to free a slot, or go Pro for unlimited workflows (Pro tab in the top bar).`,
      });
    }
  }
  const wf = { ...(body || {}) };
  // Never trust a client-supplied identity. Workflow ids are not secret (they
  // appear in webhook URLs and are visible to collaborators), and saving is an
  // upsert on id — so honouring body.id would let anyone overwrite another
  // account's workflow and seize its secrets. Always mint a fresh id here and
  // drop the server-owned fields; ownerId is set from the session below.
  wf.id = randomUUID();
  delete wf.ownerId;
  delete wf.code;
  delete wf.collaborators;
  wf.name = wf.name || "Untitled workflow";
  wf.nodes = wf.nodes || [];
  wf.edges = wf.edges || [];
  // `shared` is computed per viewer (owner vs collaborator) — never stored.
  delete wf.shared;
  // Every workflow lives in a folder — no folder requested means the account's
  // home folder, never "unfiled" outside it.
  wf.folderId = await resolveWorkflowFolder(userId, String(wf.folderId || ""));
  const slug = normalizeWebhookSlug(body?.webhookSlug);
  if (body?.webhookSlug && !slug) {
    return reply(400, { error: "The webhook URL part can only contain letters, digits and dashes." });
  }
  if (slug && (await slugTaken(slug, wf.id))) {
    return reply(409, { error: "Another workflow already uses that webhook URL part — choose a different one." });
  }
  wf.webhookSlug = slug || undefined;
  // Repeat + execution mode are settings of the workflow itself. Background
  // execution (running while the owner is offline) is the Pro perk.
  wf.loop = normalizeWorkflowLoop(wf.loop);
  if (wf.loop && !(await isProUser(userId))) {
    return reply(403, { error: LOOP_PRO_ERROR });
  }
  if (normalizeExecutionMode(body?.executionMode) === "background" && !(await isProUser(userId))) {
    return reply(403, { error: "Running a workflow while you are offline (background execution) is a Pro feature — upgrade on the Pro tab to switch it on." });
  }
  wf.executionMode = normalizeExecutionMode(body?.executionMode);
  // Normalise the same workflow settings the update path validates, so a create
  // can't smuggle in a malformed Test/Live environment, AI-tool listing or budget.
  wf.environment = normalizeEnvironment(wf.environment);
  wf.mcp = normalizeMcpSettings(wf.mcp);
  wf.aiBudget = normalizeBudget(wf.aiBudget);
  // automatically assign the workflow to the account that creates it
  wf.ownerId = userId;
  await saveWorkflowWithSecrets(wf, userId);
  await db.addWorkflowToUser(userId, wf.id);
  await recordWorkflowBackup(wf, userId, "created");
  return reply(200, await hydrateWorkflowSecrets(wf));
}

app.post("/api/workflows", async (req, res) => {
  const r = await createWorkflowForUser(req.user.userId, req.body || {});
  res.status(r.status).json(r.json);
});

app.get("/api/workflows/:id", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  // Owner gets its credentials back; a collaborator/folder-share viewer never does.
  const hydrated = await hydrateWorkflowForViewer(wf, req.user.userId);
  const role = await workflowRoleOf(wf, req.user.userId);
  const shared = wf.ownerId !== req.user.userId;
  // A collaborator needs to see WHO shared the workflow with them, so the
  // editor can show it and they know who owns it.
  let sharedBy;
  if (shared) {
    const owner = await db.getUserById(wf.ownerId);
    sharedBy = { userId: wf.ownerId, email: owner?.email || "", name: owner?.name || "" };
  }
  // A folder share gives access to every workflow inside the folder — the
  // editor says so instead of pretending it is a one-off workflow share.
  let sharedViaFolder;
  if (shared && !isCollaborator(wf, req.user.userId)) {
    sharedViaFolder = (await folderIdsSharedWith(req.user.userId)).has(String(wf.folderId || ""));
  }
  // The owner of a shared folder gets the same hint, so their editor turns on
  // the shared-editing features too.
  const ownShare = (await listFolderShares()).find((s) => String(s.ownerId) === String(req.user.userId));
  const folderShared = !!ownShare && (await folderIdsOfShare(ownShare)).has(String(wf.folderId || ""));
  res.json({
    ...hydrated,
    shared,
    sharedBy,
    sharedViaFolder,
    folderShared: folderShared || undefined,
    folderSharedWith: folderShared ? ownShare.email : undefined,
    // what this viewer may do: owner / editor / runner / viewer
    role,
  });
});

// Look a workflow up by its assigned code (stored in the SQL workflows table
// when "Save workflows in the SQL database" is enabled on the admin Cloud
// servers page). Owner-scoped: only the owning account can fetch by code.
app.get("/api/workflows/by-code/:code", async (req, res) => {
  const wf = await workflows.getByCode(req.params.code, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found for that code" });
  res.json(await hydrateWorkflowSecrets(wf));
});

app.patch("/api/workflows/:id/folder", async (req, res) => {
  const existing = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!existing) return res.status(404).json({ error: "Workflow not found" });
  // A shared workflow is the owner's record — only they decide which folder it
  // lives in. A collaborator moving it into their own folder would make it
  // invisible in the owner's explorer (their folder ids don't exist for the
  // owner), so that is rejected.
  if (existing.ownerId !== req.user.userId) {
    return res.status(403).json({ error: "Only the owner of a shared workflow can move it between folders." });
  }
  // A workflow can never leave the account's folder tree: moving it out
  // (unfiled / outside the home folder) is rejected.
  const requestedFolderId = String(req.body?.folderId || "");
  if (!requestedFolderId) {
    return res.status(400).json({ error: "Workflows must live inside a folder — pick one of yours." });
  }
  const folderId = await resolveWorkflowFolder(req.user.userId, requestedFolderId);
  const moved = { ...existing, folderId, updatedAt: new Date().toISOString() };
  await saveWorkflowThrottled(moved, req.user.userId);
  res.json(await hydrateWorkflowSecrets(moved));
});

async function updateWorkflowForUser(userId, id, body, { versionReason = "save" } = {}) {
  const existing = await getAccessibleWorkflow(id, userId);
  if (!existing) return reply(404, { error: "Workflow not found" });
  const role = await workflowRoleOf(existing, userId);
  if (ROLE_RANK[role] < ROLE_RANK.editor) {
    return reply(403, { error: `You can ${role === "viewer" ? "only view" : "view and run"} this workflow — ask its owner for editor access to change it.`, role });
  }
  const patch = { ...(body || {}) };
  delete patch.shared; // per-viewer flag — never stored
  // The editor flags a Save click so the server can enforce the per-user manual
  // save budget of a shared workflow separately from auto-saves.
  const manual = patch.manual === true;
  delete patch.manual;
  const wf = { ...existing, ...patch, id: existing.id, ownerId: existing.ownerId, collaborators: existing.collaborators || [] };
  const isOwner = existing.ownerId === userId;
  // Folder placement is the owner's decision: a collaborator editing a shared
  // workflow must never move the owner's record into the collaborator's own
  // folder (their folder ids don't exist for the owner, which would hide the
  // workflow from the owner's explorer).
  wf.folderId = isOwner
    ? await resolveWorkflowFolder(userId, String(wf.folderId || ""))
    : existing.folderId;
  const slug = normalizeWebhookSlug(wf.webhookSlug);
  if (wf.webhookSlug && !slug) {
    return reply(400, { error: "The webhook URL part can only contain letters, digits and dashes." });
  }
  wf.webhookSlug = slug || undefined;
  if (slug && (await slugTaken(slug, wf.id))) {
    return reply(409, { error: "Another workflow already uses that webhook URL part — choose a different one." });
  }
  wf.updatedAt = new Date().toISOString();
  // Repeat + execution mode belong to the workflow. Switching a workflow to
  // background execution (it runs while its owner is offline) is the Pro perk —
  // a free account cannot turn it on, and a workflow that already had it keeps
  // it (so a lapsed subscription never silently rewrites the setting).
  const requestedMode = body?.executionMode === undefined ? existing.executionMode : normalizeExecutionMode(body?.executionMode);
  if (requestedMode === "background" && existing.executionMode !== "background" && !(await isProUser(userId))) {
    return reply(403, { error: "Running a workflow while you are offline (background execution) is a Pro feature — upgrade on the Pro tab to switch it on." });
  }
  wf.executionMode = requestedMode === "background" ? "background" : "editor";
  wf.loop = normalizeWorkflowLoop(body?.loop === undefined ? existing.loop : body.loop);
  // Test / Live environment (server/run-context.js) and the AI-tool listing
  // (server/mcp.js) are plain workflow settings.
  wf.environment = normalizeEnvironment(wf.environment);
  wf.mcp = normalizeMcpSettings(wf.mcp);
  wf.aiBudget = normalizeBudget(wf.aiBudget);
  // Turning the loop on (or changing it) is Pro. A save that carries an
  // existing loop along unchanged is not refused, so a lapsed subscription
  // never blocks editing — the runner itself stops the loop for non-Pro owners.
  if (wf.loop && !sameLoop(wf.loop, normalizeWorkflowLoop(existing.loop)) && !(await isProUser(userId))) {
    return reply(403, { error: LOOP_PRO_ERROR });
  }
  // Switching the loop off stops a loop that is running on the server.
  if (!wf.loop) stopLoop(wf.id);
  // Snapshot the state the workflow is LEAVING before this save overwrites it,
  // so Versions can undo an accidental rewrite (by hand or by the AI builder).
  // Graph-identical saves are skipped inside add(), so a rename never fills it.
  if (isOwner) workflowVersions.add(existing, { reason: versionReason });
  // Shared workflows are throttled to 1 auto-save per minute, plus one manual
  // save per minute and per user, so two collaborating editors can't write over
  // each other faster than the UI can keep up.
  const saved = await saveWorkflowThrottled(wf, userId, { manual });
  if (!saved.ok) return reply(429, { error: saved.error, retryAfterMs: saved.retryAfterMs || 0, manualSavesLeft: manual ? 0 : undefined });
  // "Who changed what" (server/workflow-collab.js) — never fails the save.
  try {
    const author = await db.getUserById(userId);
    await recordChange(existing, wf, { userId, name: author?.name || "", email: author?.email || "" });
  } catch (err) {
    console.error("[history] could not record the change:", err?.message || err);
  }
  // Keep the state this save wrote in the rolling backup buffer, tagged with
  // whoever saved it — that is what the shared-mode Backup button rewinds to.
  await recordWorkflowBackup(wf, userId, manual ? "manual" : "autosave");
  const hydrated = await hydrateWorkflowForViewer(wf, userId);
  const shared = wf.ownerId !== userId;
  let sharedBy;
  if (shared) {
    const owner = await db.getUserById(wf.ownerId);
    sharedBy = { userId: wf.ownerId, email: owner?.email || "", name: owner?.name || "" };
  }
  return reply(200, { ...hydrated, shared, sharedBy });
}

app.put("/api/workflows/:id", async (req, res) => {
  const r = await updateWorkflowForUser(req.user.userId, req.params.id, req.body || {});
  res.status(r.status).json(r.json);
});

app.delete("/api/workflows/:id", async (req, res) => {
  if (!(await workflows.removeOwned(req.params.id, req.user.userId))) {
    return res.status(404).json({ error: "Workflow not found" });
  }
  await db.removeWorkflowFromUser(req.user.userId, req.params.id);
  await db.deleteWorkflowSecrets(req.params.id);
  await db.executionsRemoveByWorkflow(req.params.id);
  workflowVersions.removeByWorkflow(req.params.id);
  workflowBackups.removeByWorkflow(req.params.id);
  await forgetWorkflowCollab(req.params.id);
  res.json({ ok: true });
});

// --- comments + change history (server/workflow-collab.js) --------------------
// Everyone who can open a workflow can read and write comments; resolving a
// thread needs editor access (or being its author); deleting needs being the
// author or the owner. The people list feeds the @mention picker.
async function workflowPeople(wf) {
  const people = [];
  const owner = await db.getUserById(wf.ownerId);
  if (owner) people.push({ userId: String(owner.id), name: owner.name || "", email: owner.email || "", role: "owner" });
  for (const c of Array.isArray(wf.collaborators) ? wf.collaborators : []) {
    if (!people.some((p) => p.userId === String(c.userId))) people.push({ userId: String(c.userId), name: c.name || "", email: c.email || "", role: cleanRole(c.role) });
  }
  for (const share of (await listFolderShares()).filter((sh) => String(sh.ownerId) === String(wf.ownerId))) {
    if (!(await folderIdsOfShare(share)).has(String(wf.folderId || ""))) continue;
    if (!people.some((p) => p.userId === String(share.userId))) people.push({ userId: String(share.userId), name: share.name || "", email: share.email || "", role: cleanRole(share.role) });
  }
  return people;
}

/** Record a change in the history (restores, saves) — never throws. */
async function noteChange(before, after, userId) {
  try {
    const author = await db.getUserById(userId);
    await recordChange(before, after, { userId, name: author?.name || "", email: author?.email || "" });
  } catch (err) {
    console.error("[history] could not record the change:", err?.message || err);
  }
}

const collabError = (res, err) => res.status(err?.status || 400).json({ error: String(err?.message || err) });

app.get("/api/workflows/:id/comments", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  res.json({ comments: await listComments(wf.id), people: await workflowPeople(wf), role: await workflowRoleOf(wf, req.user.userId), me: String(req.user.userId) });
});

app.post("/api/workflows/:id/comments", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  try {
    const me = await db.getUserById(req.user.userId);
    const cloud = (await db.storeGet("site.cloudPath")) || "cloud";
    const appUrl = `${await requestBaseUrl(req)}/${cloud}/workflow/${wf.id}`;
    const comment = await addComment(wf, { userId: req.user.userId, name: me?.name || "", email: me?.email || "" }, req.body || {}, { people: await workflowPeople(wf), appUrl });
    res.json({ comment });
  } catch (err) {
    collabError(res, err);
  }
});

app.patch("/api/workflows/:id/comments/:commentId", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  try {
    const role = await workflowRoleOf(wf, req.user.userId);
    const comment = await updateComment(wf.id, req.params.commentId, { userId: req.user.userId }, req.body || {}, { canModerate: ROLE_RANK[role] >= ROLE_RANK.editor });
    res.json({ comment });
  } catch (err) {
    collabError(res, err);
  }
});

app.delete("/api/workflows/:id/comments/:commentId", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  try {
    await deleteComment(wf.id, req.params.commentId, { userId: req.user.userId }, { isOwner: String(wf.ownerId) === String(req.user.userId) });
    res.json({ ok: true });
  } catch (err) {
    collabError(res, err);
  }
});

app.get("/api/workflows/:id/history", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  res.json({ entries: await listHistory(wf.id) });
});

// --- workflow version history -------------------------------------------------
// Every graph-changing save snapshots the state the workflow was leaving (see
// server/store.js), so an earlier version can be restored. The list is
// summaries only; the single-version call returns the full graph to preview.
app.get("/api/workflows/:id/versions", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  res.json({ versions: workflowVersions.list(req.params.id), max: MAX_WORKFLOW_VERSIONS });
});

app.get("/api/workflows/:id/versions/:versionId", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  const version = workflowVersions.get(req.params.id, req.params.versionId);
  if (!version) return res.status(404).json({ error: "Version not found" });
  res.json(version);
});

app.post("/api/workflows/:id/versions/:versionId/restore", async (req, res) => {
  const existing = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!existing) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, existing, req.user.userId, "editor")) return;
  if (existing.ownerId !== req.user.userId) {
    return res.status(403).json({ error: "Only the owner of a shared workflow can restore a version." });
  }
  const version = workflowVersions.get(req.params.id, req.params.versionId);
  if (!version) return res.status(404).json({ error: "Version not found" });
  // Snapshot the current state first, so restoring is itself undoable.
  workflowVersions.add(existing, { reason: "before-restore" });
  const restored = {
    ...existing,
    nodes: version.nodes || [],
    edges: version.edges || [],
    updatedAt: new Date().toISOString(),
  };
  const saved = await saveWorkflowThrottled(restored, req.user.userId);
  if (!saved.ok) return res.status(429).json({ error: saved.error });
  await noteChange(existing, restored, req.user.userId);
  res.json(await hydrateWorkflowSecrets(restored));
});

// ----------------------------------------------------------------------------
// Backup & rewind — the rolling buffer a SHARED workflow can roll back to.
//
//   GET  /api/workflows/:id/backups                        → recent saves + the
//        "one minute ago" and "last save I made" targets
//   POST /api/workflows/:id/backups/:backupId/restore      → roll the workflow
//        back to that saved state
//
// Unlike the version history (owner-only, coarse) this is available to every
// editor of the workflow: when two people write one record, the one who was
// away needs a way back to their own last save. Restoring itself is recorded
// in the buffer first, so it can be rolled back too.
// ----------------------------------------------------------------------------
function backupSummaryForViewer(backup, viewerId) {
  return {
    id: backup.id,
    workflowId: backup.workflowId,
    savedAt: backup.savedAt,
    reason: backup.reason,
    userId: backup.userId || "",
    userName: backup.userName || "",
    mine: !!backup.userId && String(backup.userId) === String(viewerId),
    name: backup.name || "",
    description: backup.description || "",
    // list() already strips the graph and carries the counts; a full backup
    // (the rewind target) still has nodes/edges, so fall back to counting them.
    nodeCount: typeof backup.nodeCount === "number" ? backup.nodeCount : (backup.nodes || []).length,
    edgeCount: typeof backup.edgeCount === "number" ? backup.edgeCount : (backup.edges || []).length,
  };
}

app.get("/api/workflows/:id/backups", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  const limit = Math.max(1, Math.min(MAX_WORKFLOW_BACKUPS, Number(req.query?.limit) || 10));
  const all = workflowBackups.list(wf.id, MAX_WORKFLOW_BACKUPS);
  const mine = all.filter((b) => String(b.userId) === String(req.user.userId));
  const rewind = workflowBackups.rewindPoint(wf.id, 60_000);
  res.json({
    backups: all.slice(0, limit).map((b) => backupSummaryForViewer(b, req.user.userId)),
    total: all.length,
    max: MAX_WORKFLOW_BACKUPS,
    // the state ~1 minute ago (null when there is nothing old enough)
    rewind: rewind ? backupSummaryForViewer(rewind, req.user.userId) : null,
    // the newest save THIS account made (null when they never saved)
    myLast: mine.length ? backupSummaryForViewer(mine[0], req.user.userId) : null,
  });
});

app.post("/api/workflows/:id/backups/:backupId/restore", async (req, res) => {
  const existing = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!existing) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, existing, req.user.userId, "editor")) return;
  const backup = workflowBackups.get(req.params.id, req.params.backupId);
  if (!backup) return res.status(404).json({ error: "Backup not found" });
  // Keep the CURRENT state first, so a rewind is itself undoable.
  await recordWorkflowBackup(existing, req.user.userId, "before-rewind");
  const restored = {
    ...existing,
    name: backup.name || existing.name,
    description: backup.description ?? existing.description,
    nodes: backup.nodes || [],
    edges: backup.edges || [],
    updatedAt: new Date().toISOString(),
  };
  // A recovery action must never be blocked by the shared-save throttle.
  await saveWorkflowWithSecrets(restored, req.user.userId);
  await recordWorkflowBackup(restored, req.user.userId, "rewind");
  await noteChange(existing, restored, req.user.userId);
  res.json(await hydrateWorkflowForViewer(restored, req.user.userId));
});

// --- collaboration endpoints ------------------------------------------------
// Share a workflow with another registered user (by email). The collaborator
// can open, edit and run the workflow; every save updates the single shared
// record, so both users work on the same copy.
app.post("/api/workflows/:id/share", async (req, res) => {
  const wf = await workflows.getOwned(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address of the user you want to collaborate with." });
  }
  const target = await db.getUserByEmail(email);
  if (!target) return res.status(404).json({ error: `No account with the email "${email}" exists on this instance.` });
  if (target.id === req.user.userId) return res.status(400).json({ error: "This is your own workflow already — no need to share it with yourself." });
  const collabs = Array.isArray(wf.collaborators) ? wf.collaborators : [];
  if (collabs.some((c) => String(c.userId) === String(target.id))) {
    return res.status(409).json({ error: "That user already has access to this workflow — change their role instead." });
  }
  collabs.push({ userId: target.id, email: target.email, name: target.name || "", role: cleanRole(req.body?.role), addedAt: new Date().toISOString() });
  wf.collaborators = collabs;
  wf.updatedAt = new Date().toISOString();
  await saveWorkflowWithSecrets(wf, req.user.userId);
  res.json({ ok: true, collaborators: collabs });
});

// Change what a collaborator may do (viewer / runner / editor) — owner only.
app.put("/api/workflows/:id/share/:userId", async (req, res) => {
  const wf = await workflows.getOwned(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  const collab = (Array.isArray(wf.collaborators) ? wf.collaborators : []).find((c) => String(c.userId) === String(req.params.userId));
  if (!collab) return res.status(404).json({ error: "That person is not a collaborator on this workflow." });
  collab.role = cleanRole(req.body?.role);
  wf.updatedAt = new Date().toISOString();
  await saveWorkflowWithSecrets(wf, req.user.userId);
  res.json({ ok: true, collaborators: wf.collaborators });
});

app.delete("/api/workflows/:id/share/:userId", async (req, res) => {
  const wf = await workflows.getOwned(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  wf.collaborators = (Array.isArray(wf.collaborators) ? wf.collaborators : []).filter(
    (c) => String(c.userId) !== String(req.params.userId)
  );
  wf.updatedAt = new Date().toISOString();
  await saveWorkflowWithSecrets(wf, req.user.userId);
  res.json({ ok: true, collaborators: wf.collaborators });
});

// End the shared session. The owner's editor sends its CURRENT workflow state
// in the request body, so everything that was still pending in the browser is
// persisted by the same operation that removes all collaborators — nothing is
// lost even if a save was throttled a moment before. Once the collaborators
// are gone, their next access check / save returns not-accessible, so they are
// thrown out of the workflow and lose the ability to rework it.
app.post("/api/workflows/:id/stop-sharing", async (req, res) => {
  const wf = await workflows.getOwned(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  // Carry only the editor's pending CONTENT. This endpoint bypasses the normal
  // update path, so it must NOT accept privileged settings (loop, executionMode,
  // webhookSlug, environment, mcp, aiBudget, collaborators, ownerId): merging the
  // raw body let a free account switch on Pro-only loop / background execution
  // and claim another workflow's webhook slug, none of which went through their
  // own checks. Those are changed through PUT /api/workflows/:id, which validates.
  const body = req.body || {};
  const next = { ...wf, id: wf.id, ownerId: wf.ownerId, collaborators: [], updatedAt: new Date().toISOString() };
  if (Array.isArray(body.nodes)) next.nodes = body.nodes;
  if (Array.isArray(body.edges)) next.edges = body.edges;
  if (typeof body.name === "string") next.name = body.name;
  if (body.description !== undefined) next.description = body.description;
  // No collaborator remains after this save, so it is not subject to the
  // shared-workflow save throttle.
  await saveWorkflowWithSecrets(next, req.user.userId);
  res.json({ ok: true, collaborators: [] });
});

// Lightweight access check the editor polls while a workflow is open. When the
// owner ends a shared session the collaborator is removed from the record and
// this flips to accessible:false — their editor then throws them out with a
// "session ended" screen instead of letting them keep working on a copy they
// no longer have access to.
app.get("/api/workflows/:id/access", async (req, res) => {
  const wf = await workflows.get(req.params.id);
  if (!wf) {
    return res.json({ accessible: false });
  }
  const isOwner = String(wf.ownerId) === String(req.user.userId);
  const isCollab = isCollaborator(wf, req.user.userId);
  const viaFolder = !isOwner && !isCollab && (await isFolderSharedWith(wf, req.user.userId));
  if (!isOwner && !isCollab && !viaFolder) return res.json({ accessible: false });
  // Who is on the canvas right now (excluding the caller) — the editor draws a
  // small marker on the node each of them is editing.
  const editing = workflowPresence(wf.id).filter((p) => p.userId !== String(req.user.userId));
  if (isOwner) {
    return res.json({
      accessible: true,
      shared: Array.isArray(wf.collaborators) && wf.collaborators.length > 0,
      sharedWith: (wf.collaborators || []).map((c) => ({ userId: c.userId, email: c.email, name: c.name })),
      editing,
    });
  }
  const owner = await db.getUserById(wf.ownerId);
  return res.json({
    accessible: true,
    shared: true,
    sharedViaFolder: viaFolder || undefined,
    sharedBy: { userId: wf.ownerId, email: owner?.email || "", name: owner?.name || "" },
    editing,
  });
});

// --- shared-editing presence -------------------------------------------------
// The editor POSTs the node its user currently edits (and gets everyone else's
// position back) while a shared workflow is open. An empty nodeId means "just
// looking at the canvas" — the user still counts as present.
app.post("/api/workflows/:id/presence", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  const me = await db.getUserById(req.user.userId);
  const nodeId = req.body?.nodeId ? String(req.body.nodeId) : null;
  setPresence(wf.id, { userId: req.user.userId, name: me?.name || me?.email || "", email: me?.email || "" }, nodeId, req.body?.nodeLabel);
  res.json({ ok: true, editing: workflowPresence(wf.id).filter((p) => p.userId !== String(req.user.userId)) });
});

app.delete("/api/workflows/:id/presence", async (req, res) => {
  clearPresence(req.params.id, req.user.userId);
  res.json({ ok: true });
});

// Store a workflow's node credentials in the encrypted workflow_secrets table,
// then write the JSON with every secret blanked. Responding with the hydrated
// copy keeps the owner's in-memory workflow intact (the editor only reads
// id/name/description from the response).
async function saveWorkflowWithSecrets(wf, userId) {
  // The submitted graph carries only the secret fields the saver actually had a
  // value for. Non-owners are never sent the owner's secrets (see
  // hydrateWorkflowForViewer), and even the owner may leave a secret field
  // blank, so merge: a blank-but-still-present field keeps the stored secret; a
  // field whose node/path is gone drops it. This stops a save from a viewer or
  // a blanked form from silently wiping the owner's credentials.
  const incoming = collectSecrets(wf);
  const incomingKeys = new Set(incoming.map((s) => `${s.nodeId}\u0000${s.field}`));
  const presentPaths = new Set(secretFieldPaths(wf).map((s) => `${s.nodeId}\u0000${s.field}`));
  const merged = [...incoming];
  for (const s of await db.getWorkflowSecrets(wf.id)) {
    const key = `${s.nodeId}\u0000${s.field}`;
    if (!incomingKeys.has(key) && presentPaths.has(key)) merged.push(s);
  }
  await db.replaceWorkflowSecrets(wf.id, userId, merged);
  await workflows.save(blankSecretsInWorkflow(wf));
}

// What to return to the editor after a read/save. The OWNER gets the workflow
// with its credentials re-injected (they typed them and must be able to edit
// them); everyone the workflow is shared with — any role — gets the blanked
// copy, so a collaborator or folder-share viewer can never read the owner's API
// keys, tokens or passwords. Runs still hydrate server-side, so sharing a
// workflow to RUN it keeps working without exposing the secrets.
async function hydrateWorkflowForViewer(wf, userId) {
  if (String(wf.ownerId) === String(userId)) return hydrateWorkflowSecrets(wf);
  return blankSecretsInWorkflow(wf);
}

// A run started from the editor can answer an approval (the "Wait for Approval"
// node) through server/approvals.js. Runs with no interactive session — webhook,
// schedule, Telegram, sub-workflow — expose no request, so the node applies its
// "when nobody answers" setting immediately instead of hanging forever.
function interactiveApproval(runToken, live) {
  return {
    request: (info) => beginApproval(runToken, { ...(info || {}), signal: live?.signal }),
  };
}

// The server-side loop of a workflow (server/loop-runner.js): is it running,
// how far is it, and a Stop that works from any device.
app.get("/api/workflows/:id/loop", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  res.json(loopStatus(wf.id));
});

app.post("/api/workflows/:id/loop/stop", async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, wf, req.user.userId, "runner")) return;
  res.json({ stopped: stopLoop(wf.id) });
});

// Run a workflow on demand (manual trigger)
app.post("/api/workflows/:id/run", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const wf = await hydrateWorkflowSecrets(owned);
  const payload = req.body?.payload;

  // Non-manual triggers never invent input. When Run is pressed without a test
  // payload the workflow WAITS for the event it actually reacts to:
  //   - an inbound HTTP trigger (Webhook / GitHub) → wait for a real request at
  //     /webhook/:id (the handler below executes and completes the wait),
  //   - a Chat Trigger → the editor opens a chat panel; each message runs the
  //     workflow through POST /api/workflows/:id/chat,
  //   - any other trigger (Slack, Gmail, Schedule, RSS, …) → the editor shows an
  //     input panel and submits the payload via POST /api/workflows/:id/run/input.
  // A workflow that also contains a Manual trigger still executes immediately.
  const triggerNodes = (wf.nodes || []).filter((n) => isTriggerType(n.type));
  const hasManual = triggerNodes.some((n) => n.type === "manual");
  const inboundNode = triggerNodes.find((n) => n.type === "webhook" || n.type === "githubTrigger" || n.type === "stripeTrigger");
  const chatNode = triggerNodes.find((n) => n.type === "chatTrigger");
  if (payload === undefined && triggerNodes.length > 0 && !hasManual) {
    const baseResult = {
      workflowId: wf.id,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      durationMs: 0,
      log: [],
      consoleLog: [],
      success: false,
      nodeCount: wf.nodes.length,
      errorCount: 0,
    };

    // (a) inbound HTTP trigger — wait for the real request.
    if (inboundNode) {
      const kind = inboundNode.type;
      const method = kind === "githubTrigger" || kind === "stripeTrigger" ? "POST" : (inboundNode.data?.config?.method || "POST").toUpperCase();
      const webhookUrl = `/webhook/${wf.id}`;
      const { waitingId } = beginWebhookWait(
        wf.id,
        { awaiting: "webhook", method, webhookUrl, kind },
        { ownerId: wf.ownerId || req.user.userId, triggerLabel: inboundNode.data?.label || CATALOG.nodes[kind]?.name || kind, nodeCount: wf.nodes.length }
      );
      const waitingFor =
        kind === "githubTrigger"
          ? `a GitHub webhook delivery to ${webhookUrl} (point the repo's webhook at that URL; the Secret must match the trigger's Webhook secret)`
          : kind === "stripeTrigger"
            ? `a Stripe event at ${webhookUrl} (add that URL as a webhook endpoint in Stripe and paste its signing secret into the trigger; "Send test event" in Stripe works)`
            : `a ${method} request to ${webhookUrl}`;
      return res.json({
        ...baseResult,
        waiting: true,
        awaiting: "webhook",
        waitingId,
        method,
        webhookUrl,
        kind,
        message: `Waiting for ${waitingFor} — this run was not triggered yet, so no test data was invented. Send one to complete the run.`,
      });
    }

    // (b) chat trigger — the chat panel drives the run; nothing to poll.
    if (chatNode) {
      return res.json({
        ...baseResult,
        waiting: true,
        awaiting: "chat",
        waitingId: null,
        method: "CHAT",
        webhookUrl: "",
        kind: "chatTrigger",
        triggerType: "chatTrigger",
        triggerLabel: chatNode.data?.label || "Chat Trigger",
        message:
          "Chat is ready — send a message in the Chat panel to run the workflow. Nothing executes until you do.",
      });
    }

    // (c) any other trigger — wait for a payload the editor submits.
    const triggerType = triggerNodes[0].type;
    const triggerLabel = triggerNodes[0].data?.label || CATALOG.nodes[triggerType]?.name || triggerType;
    const { waitingId } = beginWebhookWait(
      wf.id,
      { awaiting: "input", triggerType, triggerLabel },
      { ownerId: wf.ownerId || req.user.userId, triggerLabel, nodeCount: wf.nodes.length }
    );
    return res.json({
      ...baseResult,
      waiting: true,
      awaiting: "input",
      waitingId,
      method: "INPUT",
      webhookUrl: "",
      kind: triggerType,
      triggerType,
      triggerLabel,
      message: `Waiting for input — “${triggerLabel}” reacts to an external event, so pressing Run does not invent test data. Paste the event payload below (or turn on the trigger's live mode) to run the workflow.`,
    });
  }

  // Free-plan daily-run cap. The webhook-only waiting branch returned above,
  // so reaching here means the workflow actually executes now — consume a run.
  // Nested sub-workflow calls never count: one logical run, one allowance.
  const quota = await runQuota(req.user.userId);
  if (!quota.allowed) {
    return res.status(403).json({
      error: `The free plan allows ${quota.limit} workflow runs per day and you've used all ${quota.used}. Runs reset at midnight (UTC) — or go Pro for unlimited runs (Pro tab in the top bar).`,
    });
  }
  if (quota.limit !== null) await db.bumpRunUsage(req.user.userId);

  // The workflow's repeat setting (Pro): this Run executes the first pass
  // while the editor watches, then the loop runner (server/loop-runner.js)
  // repeats it on the server — it keeps going when the page is closed, like
  // "Always on". A workflow owned by an account that is no longer Pro runs once.
  const ownerPro = wf.loop?.enabled ? await isProUser(wf.ownerId || req.user.userId) : false;
  const loop = wf.loop && wf.loop.enabled && ownerPro ? wf.loop : null;
  const loopedWithoutPro = !!wf.loop?.enabled && !ownerPro;

  // Optional client-generated id for THIS run click. It lets the editor poll
  // live per-node progress and press Stop (see server/run-control.js). Runs
  // started outside the editor (scheduler, external callers) omit it.
  const runToken = String(req.body?.runToken || "");
  // Debug mode ("step": true) pauses before every node until Next / Continue.
  const stepping = req.body?.step === true && !!runToken;
  const live = runToken ? beginLiveRun(runToken, wf.id, { step: stepping }) : null;
  try {
    let result;
    {
      result = await executeRouted(wf, {
        source: "editor", // listed as running until recordExecution saves it
        // a payload supplied with the run acts as the inbound trigger's request
        // body (the Webhook node / GitHub trigger receive it instead of a sample)
        webhookPayload: inboundNode && payload !== undefined ? payload : undefined,
        triggerPayload: req.body?.payload ?? req.body,
        // Kept with the saved run so Replay can start it with the same input.
        runInput: payload === undefined ? null : payload,
        maxItemsPerNode: req.body?.maxItemsPerNode,
        userId: req.user.userId,
        // Stop support: the executor checks this signal between nodes and stops
        // scheduling new nodes once the Stop button aborts it.
        signal: live?.signal,
        // Progress support: reported before every node so the editor can show
        // which node is executing right now.
        onNodeStart: (nodeId) => live && setLiveRunProgress(runToken, nodeId),
        beforeNode: stepping ? (nodeId, input) => waitForStep(runToken, nodeId, input) : undefined,
        approval: interactiveApproval(runToken, live),
      });
      // Reward the console with the run's priced AI cost (the history row
      // carries it; the executor's result does not know about prices).
      const saved = await recordExecution(wf, result, "editor");
      if (saved && saved.aiCostUsd != null) result.aiCostUsd = Number(saved.aiCostUsd);
    }
    // Stop on the first pass also means "do not start the loop".
    if (loop && !result?.aborted && loop.times !== 1) {
      const stored = await workflows.get(wf.id);
      if (stored) {
        result.loop = startLoop(stored, { done: 1 });
        const wait = loopIntervalMs(loop) / 1000;
        const left = loop.times === 0 ? "keeps repeating" : `runs ${loop.times - 1} more time(s)`;
        result.consoleLog = [
          `↻ loop: run 1${loop.times ? ` of ${loop.times}` : ""} is shown below — the server ${left} every ${wait} s, even if you close this page. Stop it from the loop badge or by switching the loop off.`,
          ...(result.consoleLog || []),
        ];
      }
    } else if (loopedWithoutPro) {
      result.consoleLog = ["↻ loop: repeating a workflow is a Pro feature — this run executed once.", ...(result.consoleLog || [])];
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    endApprovals(runToken);
    endLiveRun(runToken);
  }
});

// Poll a pending webhook wait (started by POST /run on a webhook-only
// workflow). Returns the executed result once a real request hits /webhook/:id,
// or { waiting: true } while the run is still waiting for the call.
app.post("/api/workflows/:id/run/poll", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  res.json(pollWebhookWait(req.params.id, req.body?.waitingId));
});

// Cancel a pending webhook wait when the editor is closed or the user chooses
// Cancel wait. This avoids leaving an old one-shot webhook armed for up to the
// full wait TTL after the user has abandoned the run.
app.post("/api/workflows/:id/run/cancel", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  res.json({ ok: cancelWebhookWait(req.params.id, String(req.body?.waitingId || "")) });
});

// Supply the input a waiting run asked for (non-manual triggers that are not
// inbound HTTP ones). Claims the pending wait atomically so a Run can never
// execute twice, then runs the workflow with the submitted payload as the
// trigger event. The executed result is also stored on the wait, so a poller
// that is still running picks it up.
app.post("/api/workflows/:id/run/input", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const wf = await hydrateWorkflowSecrets(owned);
  const waitingId = String(req.body?.waitingId || "");
  const payload = req.body?.payload;
  if (!claimWait(wf.id, waitingId)) {
    return res.status(409).json({
      error: "This run is no longer waiting for input — it already ran, was cancelled, or was replaced by a newer Run.",
    });
  }
  const quota = await runQuota(req.user.userId);
  if (!quota.allowed) {
    const limitError = {
      success: false,
      error: `The free plan allows ${quota.limit} workflow runs per day and you've used all ${quota.used}. Runs reset at midnight (UTC).`,
      errorCount: 0,
      durationMs: 0,
      log: [],
      consoleLog: [],
      nodeCount: (wf.nodes || []).length,
    };
    completeWaitWithResult(wf.id, waitingId, limitError);
    return res.status(403).json({ error: limitError.error });
  }
  if (quota.limit !== null) await db.bumpRunUsage(req.user.userId);
  try {
    const result = await executeRouted(wf, {
      source: "editor", // listed as running until recordExecution saves it
      executionId: waitingId || undefined, // carries on the "waiting for trigger" row
      triggerPayload: payload ?? {},
      webhookPayload: payload ?? undefined,
      runInput: payload ?? null,
      userId: req.user.userId,
    });
    await recordExecution(wf, result, "editor");
    completeWaitWithResult(wf.id, waitingId, result);
    res.json(result);
  } catch (err) {
    const failure = {
      success: false,
      errorCount: 1,
      durationMs: 0,
      log: [],
      consoleLog: [],
      nodeCount: (wf.nodes || []).length,
      error: String(err.message || err),
    };
    completeWaitWithResult(wf.id, waitingId, failure);
    res.status(500).json(failure);
  }
});

// Chat Trigger: run the workflow once per chat message. The message is the
// trigger event ({ channel: "chat", message, text, history }); a downstream
// Chat Output node produces the reply the editor appends to the panel.
app.post("/api/workflows/:id/chat", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const wf = await hydrateWorkflowSecrets(owned);
  if (!(wf.nodes || []).some((n) => n.type === "chatTrigger")) {
    return res.status(400).json({ error: "This workflow has no Chat Trigger node." });
  }
  const message = String(req.body?.message ?? "");
  if (!message.trim()) return res.status(400).json({ error: "A chat message is required." });
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const quota = await runQuota(req.user.userId);
  if (!quota.allowed) {
    return res.status(403).json({
      error: `The free plan allows ${quota.limit} workflow runs per day and you've used all ${quota.used}. Runs reset at midnight (UTC) — or go Pro for unlimited runs.`,
    });
  }
  if (quota.limit !== null) await db.bumpRunUsage(req.user.userId);
  const runToken = String(req.body?.runToken || "");
  const live = runToken ? beginLiveRun(runToken, wf.id) : null;
  try {
    const chatPayload = { channel: "chat", role: "user", message, text: message, history, at: new Date().toISOString() };
    const result = await executeRouted(wf, {
      source: "chat", // listed as running until recordExecution saves it
      triggerPayload: chatPayload,
      runInput: { channel: "chat", message },
      userId: req.user.userId,
      signal: live?.signal,
      onNodeStart: (nodeId) => live && setLiveRunProgress(runToken, nodeId),
      approval: interactiveApproval(runToken, live),
    });
    const saved = await recordExecution(wf, result, "chat");
    if (saved && saved.aiCostUsd != null) result.aiCostUsd = Number(saved.aiCostUsd);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    endApprovals(runToken);
    endLiveRun(runToken);
  }
});

// Stop a live run started from the editor (the toolbar Stop button). The
// executor aborts at the next node boundary: the node currently in flight
// finishes, nothing downstream starts, and the /run response resolves with an
// `aborted: true` result.
app.post("/api/workflows/:id/run/stop", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const stopped = stopLiveRun(String(req.body?.runToken || ""), req.params.id);
  res.json({
    ok: stopped,
    message: stopped
      ? "Stop requested — the run halts after the node currently executing."
      : "No active run to stop for this workflow.",
  });
});

// Failure alerts (server/failure-alerts.js): e-mail / Telegram when this
// workflow fails. Only the owner changes where its alerts go.
app.get("/api/workflows/:id/alerts", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  res.json(await getAlertSettingsFor(owned.id));
});

app.put("/api/workflows/:id/alerts", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (owned.ownerId !== req.user.userId) return res.status(403).json({ error: "Only the workflow's owner can change its alerts." });
  try {
    res.json(await saveAlertSettingsFor(owned.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/workflows/:id/alerts/test", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  // Sending a test alert puts an e-mail / Telegram message into the owner's
  // configured destination, so only the owner may trigger it (a viewer must not
  // be able to spam it). Alert settings themselves are already owner-only.
  if (owned.ownerId !== req.user.userId) {
    return res.status(403).json({ error: "Only the workflow's owner can send a test alert." });
  }
  try {
    const out = await sendTestAlert(owned);
    const failed = Object.entries(out).filter(([, r]) => r && r.ok === false);
    res.json({
      ok: !failed.length,
      results: out,
      message: failed.length
        ? `Could not send via ${failed.map(([ch, r]) => `${ch}${r.skipped ? " (the server has no SMTP set up)" : r.error ? ` (${r.error})` : ""}`).join(", ")}.`
        : "Test alert sent.",
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Debug mode: let a run parked before a node go on — one node ("next") or the
// rest of the run without further pauses ("continue").
app.post("/api/workflows/:id/run/step", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const action = req.body?.action === "continue" ? "continue" : "next";
  const ok = stepLiveRun(String(req.body?.runToken || ""), req.params.id, action);
  res.json({ ok, message: ok ? (action === "continue" ? "Continuing without pauses." : "Running the next node.") : "The run is not paused." });
});

// Live per-node progress of a run started from the editor (which node is
// executing right now). The editor polls this while a run is in flight and
// draws a loading ring over the current node.
app.get("/api/workflows/:id/run/status", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  const token = String(req.query?.token || "");
  res.json({ ...runStatus(token, req.params.id), approval: approvalStatus(token) });
});

// Answer a pending "Wait for Approval" node (the editor's Approve / Reject
// buttons on the stalled run). Only an interactive run has something to answer.
app.post("/api/workflows/:id/run/approval", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const runToken = String(req.body?.runToken || "");
  const approved = !!req.body?.approved;
  const by = req.user?.email || req.user?.userId || "a user";
  const ok = resolveApproval(runToken, String(req.body?.approvalId || ""), approved, by, req.body?.reason || "");
  res.json({
    ok,
    message: ok
      ? approved
        ? "Approved — the run continues down the Approved output."
        : "Rejected — the run continues down the Rejected output."
      : "That approval is no longer waiting for an answer.",
  });
});

// ----------------------------------------------------------------------------
// Execution history — every run is saved (see server/executions.js). The
// Execution menu lists these and reopens a past run's full log. Runs still in
// progress (server/running-executions.js) are listed first, with running: true.
//   GET /api/workflows/:id/executions            → recent run summaries
//   GET /api/workflows/:id/executions/:execId    → one run's full result
// ----------------------------------------------------------------------------

/** Running runs on top of the saved ones; a run saved meanwhile appears once. */
function withRunning(live, saved) {
  const ids = new Set(saved.map((r) => r.id));
  return [...live.filter((r) => !ids.has(r.id)), ...saved];
}

// Run-button waits (the trigger has not fired yet) are listed as well, as
// "waiting for trigger" — only those: always-listen triggers and manual runs
// never create one.
const waitsFor = (pred) => waitingRows(armedWaits().filter(pred));

app.get("/api/workflows/:id/executions", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  const limit = Number(req.query?.limit) || 30;
  const live = [...waitsFor((w) => w.workflowId === req.params.id), ...runningForWorkflow(req.params.id)];
  res.json(withRunning(live, await db.executionsListByWorkflow(req.params.id, limit)));
});

// Retry a failed run from the node that failed: that node runs again with the
// input it had, then everything downstream of it. Nodes before it are not run
// again, so orders, messages or charges they already made are not repeated.
app.post("/api/workflows/:id/executions/:execId/retry", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const entry = await db.executionGet(req.params.execId);
  if (!entry || entry.workflowId !== req.params.id) return res.status(404).json({ error: "Execution not found" });
  const failed = (entry.result?.log || []).find((l) => l.status === "error" && !l.handled);
  if (!failed) return res.status(400).json({ error: "This run has no failed node to retry from." });
  const input = Array.isArray(failed.inputItems) ? failed.inputItems : [];
  // Older runs, or runs with more items than the log keeps, do not carry the
  // node's full input — retrying with a partial input would silently skip items.
  if (typeof failed.inputCount !== "number" || failed.inputCount > input.length) {
    return res.status(409).json({
      error: `The saved log kept ${input.length} of the failed node's input items, so it cannot be retried from there without losing data. Use Replay to run the whole workflow again, or raise “Maximum log items per node” in Settings.`,
    });
  }
  const quota = await runQuota(req.user.userId);
  if (!quota.allowed) {
    return res.status(403).json({ error: `The free plan allows ${quota.limit} workflow runs per day and you've used all ${quota.used}.` });
  }
  if (quota.limit !== null) await db.bumpRunUsage(req.user.userId);
  const wf = await hydrateWorkflowSecrets(owned);
  try {
    const result = await executeRouted(wf, {
      source: "retry",
      resumeFrom: { nodeId: failed.nodeId, items: input },
      maxItemsPerNode: req.body?.maxItemsPerNode,
      userId: req.user.userId,
    });
    result.retriedFrom = { executionId: entry.id, nodeId: failed.nodeId, nodeName: failed.nodeName };
    await recordExecution(wf, result, "retry");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/workflows/:id/executions/:execId", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  const entry = await db.executionGet(req.params.execId);
  if (!entry && isRunning(req.params.execId, req.params.id)) {
    return res.status(409).json({ error: "This run is still in progress — its log opens once it finishes.", running: true });
  }
  if (!entry && armedWaits().some((w) => w.id === req.params.execId && w.workflowId === req.params.id)) {
    return res.status(409).json({ error: "This run is waiting for its trigger — its log opens once it has run.", running: true, waiting: true });
  }
  if (!entry || entry.workflowId !== req.params.id) return res.status(404).json({ error: "Execution not found" });
  res.json(entry);
});

// ----------------------------------------------------------------------------
// Manual stepping — "Run next node" after a node failed (execution halts).
// The frontend picks the downstream node(s) of a halted node and calls this with
// the halted node's manually-set output as `input`, so the chain continues
// without re-running the previous node.
//   POST /api/workflows/:id/run-node { nodeId, input }
// ----------------------------------------------------------------------------
// Download a file a Write File node saved. File nodes work in the workflow
// owner's own folder (server/disk.js), so the file is looked up there — anyone
// allowed to run the workflow may fetch what it wrote, nobody else.
app.get("/api/workflows/:id/files", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const target = safeFilePath(String(req.query.path || ""), owned.ownerId || req.user.userId);
  if (!target.ok) return res.status(400).json({ error: target.error });
  if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
    return res.status(404).json({ error: "That file is no longer on the server." });
  }
  res.set("Cache-Control", "no-store");
  res.download(target.fullPath, path.basename(target.fullPath));
});

app.post("/api/workflows/:id/run-node", async (req, res) => {
  const owned = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!owned) return res.status(404).json({ error: "Workflow not found" });
  if (await denyUnlessRole(res, owned, req.user.userId, "runner")) return;
  const wf = await hydrateWorkflowSecrets(owned);
  const { nodeId, input } = req.body || {};
  if (!nodeId) return res.status(400).json({ error: "nodeId is required" });
  // Running a single node still executes a node (and can call paid AI / HTTP),
  // so it counts against the free daily-run cap like any other run.
  const quota = await runQuota(req.user.userId);
  if (!quota.allowed) {
    return res.status(403).json({
      error: `The free plan allows ${quota.limit} workflow runs per day and you've used all ${quota.used}. Runs reset at midnight (UTC) — or go Pro for unlimited runs.`,
    });
  }
  if (quota.limit !== null) await db.bumpRunUsage(req.user.userId);
  const inputItems = Array.isArray(input) ? input : input != null ? [{ json: input }] : [];
  try {
    const result = await executeNode(wf, nodeId, inputItems, { userId: req.user.userId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Verify GitHub's X-Hub-Signature-256 header: "sha256=<hex HMAC of the raw
// body with the shared secret>" — computed over the EXACT bytes GitHub sent.
function verifyGithubSignature(rawBody, secret, headerSig) {
  try {
    const expected = "sha256=" + createHmac("sha256", String(secret)).update(rawBody || Buffer.from("")).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(headerSig || "").trim(), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// GitHub trigger — a delivery for this workflow's /webhook/:id URL. Mirrors the
// webhook path below (arm/live, quota, execute, respond) but with GitHub's
// conventions: POST only, X-GitHub-Event routing, optional HMAC signature
// check, and owner/repo/label filters. GitHub retries non-2xx answers, so once
// a delivery is accepted (right event, signature OK) we always answer 200 and
// report failures in the body instead of the HTTP status.
async function handleGitHubDelivery(req, res, wf, node) {
  const c = node.data?.config || {};
  const event = String(req.headers["x-github-event"] || "").toLowerCase();
  // The raw body is the Buffer that express.raw() mounted (rawRequest.body);
  // without it the signature cannot be verified. Parse it once here — the
  // rest of the handler works on the plain object.
  const raw =
    Buffer.isBuffer(req.body) && req.body.length
      ? req.body
      : Buffer.from(JSON.stringify(req.body || {}), "utf8");
  let payload = {};
  try {
    payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    return res.status(400).json({ error: "Delivery body is not valid JSON." });
  }
  const secret = c.webhookSecret;
  if (secret) {
    const sig = String(req.headers["x-hub-signature-256"] || "");
    if (!sig || !verifyGithubSignature(raw, secret, sig)) {
      return res.status(401).json({ error: "Invalid or missing X-Hub-Signature-256 header." });
    }
  }
  const expectedEvent = String(c.event || "issues").toLowerCase();
  if (event !== expectedEvent) {
    return res.json({ ok: true, ignored: `GitHub event "${event}" is not "${expectedEvent}" for this workflow.` });
  }
  // Owner / repository filters (compared against repository.full_name).
  const repo = payload?.repository;
  const fullName = String(repo?.full_name || "").toLowerCase();
  const wantOwner = String(c.owner || "").trim().toLowerCase();
  const wantRepo = String(c.repo || "").trim().toLowerCase();
  if ((wantOwner || wantRepo) && !fullName.includes("/")) {
    return res.json({ ok: true, ignored: "delivery has no repository info to match" });
  }
  if (wantOwner && wantRepo && fullName !== `${wantOwner}/${wantRepo}`) {
    return res.json({ ok: true, ignored: "delivery is for a different repository" });
  }
  if (wantOwner && !wantRepo && !fullName.startsWith(wantOwner + "/")) {
    return res.json({ ok: true, ignored: "delivery is for a different owner" });
  }
  if (wantRepo && fullName.slice(fullName.indexOf("/") + 1) !== wantRepo) {
    return res.json({ ok: true, ignored: "delivery is for a different repository" });
  }
  // Optional label filter (issues / pull requests).
  if (c.filterLabel) {
    const target = payload?.issue || payload?.pull_request;
    const labels = Array.isArray(target?.labels) ? target.labels.map((l) => String(l?.name || "").toLowerCase()) : [];
    if (labels.length && !labels.includes(String(c.filterLabel).trim().toLowerCase())) {
      return res.json({ ok: true, ignored: `no label matches "${c.filterLabel}"` });
    }
  }

  return runInboundDelivery(req, res, wf, c, payload, "GitHub");
}

// Stripe trigger — a delivery from a Stripe webhook endpoint. The signing
// secret is required: without it anyone who knows the URL could post a fake
// "payment succeeded". Events of another type are acknowledged and ignored, so
// Stripe does not retry them.
async function handleStripeDelivery(req, res, wf, node) {
  const c = node.data?.config || {};
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}), "utf8");
  if (!String(c.webhookSecret || "").trim()) {
    return res.status(400).json({ error: "This Stripe trigger has no signing secret yet. Paste the endpoint's whsec_… secret into the trigger." });
  }
  if (!verifyStripeSignature(req.headers["stripe-signature"], raw, String(c.webhookSecret).trim())) {
    return res.status(400).json({ error: "Invalid or missing Stripe signature." });
  }
  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Delivery body is not valid JSON." });
  }
  if (!stripeEventMatches(c.mode, event?.type)) {
    return res.json({ ok: true, ignored: `Stripe event "${event?.type}" is not "${c.mode}" for this workflow.` });
  }
  return runInboundDelivery(req, res, wf, c, stripeTriggerPayload(event), "Stripe", event?.id);
}

// An accepted delivery from a service's own webhook (GitHub, Stripe): the same
// arming model as the plain webhook — one-shot while a Run waits, or continuous
// with the trigger's "Always listen" — then quota, run and answer. The services
// retry non-2xx answers, so once a delivery is accepted the answer is 200 and
// failures are reported in the body instead.
async function runInboundDelivery(req, res, wf, c, payload, service, eventId = "") {
  // Same arming model as the webhook: one-shot while a Run waits, or
  // continuous when the trigger's "Always listen" option is on.
  const live = !!c.live;
  // Waits are keyed by the workflow id (that is what POST /run registers), so
  // arm / fire / complete must use wf.id — never req.params.id, which is the
  // custom slug when the webhook is called by its readable URL.
  if (!live && !isWebhookArmed(wf.id)) {
    return res.status(409).json({
      error: `This ${service} webhook is not listening right now.`,
      hint: "Press Run in the editor (no test payload) to listen for the next delivery, or enable 'Always listen' on the trigger so the server keeps it armed.",
    });
  }
  // A redelivered or replayed event runs once (checked only now, so a delivery
  // refused above while nobody listened still runs when Stripe retries it).
  if (eventId && !firstDelivery(wf.id, eventId)) {
    return res.json({ ok: true, ignored: `${service} event ${eventId} was already handled.` });
  }
  const firedWaitId = live ? null : markWebhookFired(wf.id);

  // A delivery counts as a run of the owner's account (free-plan daily cap).
  // Denials are answered 200 so GitHub does not retry a delivery we will never
  // accept.
  const quota = await runQuota(wf.ownerId);
  if (!quota.allowed) {
    const limitError = {
      success: false,
      error: `The free plan allows ${quota.limit} workflow runs per day and this workflow's owner has used all ${quota.used}. Runs reset at midnight (UTC).`,
      errorCount: 0,
      durationMs: 0,
      log: [],
      consoleLog: [],
      nodeCount: (wf.nodes || []).length,
    };
    completeWebhookWait(wf.id, limitError);
    return res.status(200).json({ ok: false, error: limitError.error });
  }
  if (quota.limit !== null) await db.bumpRunUsage(wf.ownerId);

  try {
    const result = await executeRouted(wf, {
      source: "webhook", // listed as running until recordExecution saves it
      executionId: firedWaitId || undefined, // carries on the "waiting for trigger" row
      webhookPayload: payload,
      webhookHeaders: req.headers,
      webhookQuery: req.query,
      method: "POST",
      runInput: payload ?? null,
      userId: wf.ownerId,
    });
    await recordExecution(wf, result, "webhook");
    completeWebhookWait(wf.id, result);
    // A Webhook Respond node can still answer (useful for manual curl tests).
    const respond = result.webhookResponse;
    if (respond) {
      const code = respond.status || (result.success ? 200 : 500);
      if (typeof respond.body === "string") return res.status(code).type("application/json").send(respond.body);
      return res.status(code).json(respond.body);
    }
    if (!result.success) {
      return res.status(200).json({ ok: false, success: false, errorCount: result.errorCount ?? 0 });
    }
    return res.json({ ok: true, success: true });
  } catch (err) {
    completeWebhookWait(wf.id, {
      success: false,
      errorCount: 1,
      durationMs: 0,
      log: [],
      consoleLog: [],
      nodeCount: (wf.nodes || []).length,
      error: String(err.message || err),
    });
    return res.status(200).json({ ok: false, error: String(err.message || err) });
  }
}

// Resolve a webhook URL's path part to a workflow: the workflow id itself, or
// the user-chosen custom slug (set on the Webhook trigger node / workflow
// settings, e.g. /webhook/my-scraper). Slugs are unique across workflows.
async function resolveWebhookWorkflow(idOrSlug) {
  const direct = await workflows.get(idOrSlug);
  if (direct) return direct;
  const slug = String(idOrSlug || "").trim().toLowerCase();
  if (!slug) return null;
  for (const w of await workflows.all()) {
    if (String(w.webhookSlug || "").trim().toLowerCase() === slug) return w;
  }
  return null;
}

// ----------------------------------------------------------------------------
// GitHub trigger — POST /webhook/:id receives GitHub webhook deliveries
// ----------------------------------------------------------------------------
// GitHub signs each delivery with X-Hub-Signature-256 over the RAW body, so
// this route reads the bytes with express.raw() before the global JSON parser
// would turn them into an object — and it only takes requests that carry the
// X-GitHub-Event header GitHub always sends. Everything else keeps flowing to
// the plain Webhook route below.
app.post(
  "/webhook/:id",
  (req, res, next) => {
    if (!req.headers["x-github-event"]) return next("route");
    return next();
  },
  express.raw({ type: "application/json", limit: "10mb" }),
  async (req, res) => {
    // Public endpoint — same per-IP rate limit as the plain webhook route.
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const webhookRateLimit = Math.max(1, Number(process.env.BF_WEBHOOK_RATE_LIMIT || 60));
    if (rateLimited(`webhook:${ip}`, webhookRateLimit, 60_000)) {
      return res.status(429).json({ error: "Too many requests to this webhook endpoint — try again in a minute." });
    }
    const stored = await resolveWebhookWorkflow(req.params.id);
    if (!stored) return res.status(404).json({ error: "Workflow not found" });
    const wf = await hydrateWorkflowSecrets(stored);
    const node = (wf.nodes || []).find((n) => n.type === "githubTrigger");
    if (!node) {
      return res
        .status(400)
        .json({ error: "This workflow has no GitHub trigger — point GitHub's webhook at a workflow with one." });
    }
    return handleGitHubDelivery(req, res, wf, node);
  }
);

// ----------------------------------------------------------------------------
// Stripe trigger — POST /webhook/:id receives Stripe webhook deliveries
// ----------------------------------------------------------------------------
// Like GitHub: Stripe signs the RAW body, so this route reads the bytes before
// the JSON parser, and only takes requests with Stripe's signature header.
app.post(
  "/webhook/:id",
  (req, res, next) => {
    if (!req.headers["stripe-signature"]) return next("route");
    return next();
  },
  express.raw({ type: "application/json", limit: "10mb" }),
  async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const webhookRateLimit = Math.max(1, Number(process.env.BF_WEBHOOK_RATE_LIMIT || 60));
    if (rateLimited(`webhook:${ip}`, webhookRateLimit, 60_000)) {
      return res.status(429).json({ error: "Too many requests to this webhook endpoint — try again in a minute." });
    }
    const stored = await resolveWebhookWorkflow(req.params.id);
    if (!stored) return res.status(404).json({ error: "Workflow not found" });
    const wf = await hydrateWorkflowSecrets(stored);
    const node = (wf.nodes || []).find((n) => n.type === "stripeTrigger");
    if (!node) {
      return res.status(400).json({ error: "This workflow has no Stripe trigger — point the Stripe webhook at a workflow with one." });
    }
    return handleStripeDelivery(req, res, wf, node);
  }
);

// ----------------------------------------------------------------------------
// Webhook trigger — POST /webhook/:id starts the workflow
// ----------------------------------------------------------------------------
// Workflows as tools for AI assistants (MCP) — server/mcp.js.
mountMcpRoutes(app, {
  requireUser,
  // public endpoint (the handshake and tool list need no token): per-IP cap
  rateLimit: (req) =>
    rateLimited(`mcp:${req.ip || req.socket?.remoteAddress || "unknown"}`, Math.max(1, Number(process.env.BF_MCP_RATE_LIMIT || 120)), 60_000),
  publicUrl: requestOrigin,
  // The builder tools save through the editor's own create / update logic.
  createWorkflow: createWorkflowForUser,
  updateWorkflow: updateWorkflowForUser,
  workflowUrl: async (id) => {
    const base = (await configuredBaseUrl()) || `http://localhost:${PORT}`;
    const cloud = (await db.storeGet("site.cloudPath")) || "cloud";
    return `${base.replace(/\/+$/, "")}/${cloud}/workflow/${id}`;
  },
});
// Shareable chart pages written by the Dashboard node — server/dashboards.js.
mountDashboardRoutes(app, { requireUser });

app.all("/webhook/:id", async (req, res) => {
  // Public endpoint — keep one client from hammering it (per IP, per minute).
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const webhookRateLimit = Math.max(1, Number(process.env.BF_WEBHOOK_RATE_LIMIT || 60));
  if (rateLimited(`webhook:${ip}`, webhookRateLimit, 60_000)) {
    return res.status(429).json({ error: "Too many requests to this webhook endpoint — try again in a minute." });
  }
  // Re-inject the owner's stored credentials before the run (and before the
  // X-W-Flow-Secret check below, which lives in the same node config).
  const stored = await resolveWebhookWorkflow(req.params.id);
  if (!stored) return res.status(404).json({ error: "Workflow not found" });
  const wf = await hydrateWorkflowSecrets(stored);
  const hasWebhook = (wf.nodes || []).some((n) => n.type === "webhook");
  if (!hasWebhook) return res.status(400).json({ error: "This workflow has no webhook trigger" });

  // The trigger's Method selector is enforced: a webhook configured for GET
  // only fires on GET requests, POST only on POST, etc. Anything else is a 405
  // so a wrong caller gets an actionable error instead of a silent no-op.
  const triggerNode = (wf.nodes || []).find((n) => n.type === "webhook");
  const method = (triggerNode?.data?.config?.method || "POST").toUpperCase();
  if (req.method !== method) {
    const bodyHint = method === "GET" ? "GET sends no body — data travels in the query string" : `a ${method} request with a JSON body`;
    const curl =
      method === "GET"
        ? `curl "${req.protocol}://${req.get("host")}${req.originalUrl}?message=hello"`
        : `curl -X ${method} "${req.protocol}://${req.get("host")}${req.originalUrl}" -H "Content-Type: application/json" -d '{"message":"hello"}'`;
    return res.status(405).json({
      error:
        `This webhook only accepts ${method} requests, but you sent ${req.method}. ` +
        `To call it, send ${bodyHint}, e.g. ${curl}. ` +
        `Alternatively, open the Webhook trigger node and change its Method to ${req.method} if that is the request you want to accept.`,
    });
  }

  // optional secret: the webhook node can require an X-W-Flow-Secret header
  const secret = triggerNode?.data?.config?.secret;
  if (secret && !timingSafeStrEqual(String(req.headers["x-w-flow-secret"] || ""), String(secret))) {
    return res.status(401).json({ error: "Invalid or missing X-W-Flow-Secret header" });
  }

  // When is the URL live? Either (a) the owner's Run is waiting for a request
  // — pressing Run on a webhook-only workflow registers an armed wait
  // (webhook-wait.js) — or (b) the trigger's "Always listen" option is on, in
  // which case the server keeps accepting requests continuously (even when
  // nobody is in the editor) as long as it is running. Without either the
  // webhook is inert and the request is rejected instead of executing the
  // workflow out of the blue. A one-shot Run wait is marked fired right here,
  // synchronously, so two concurrent callers can never double-fire the same
  // Run; in live mode every request executes.
  const liveWebhook = !!triggerNode?.data?.config?.live;
  // Waits are keyed by the workflow id (POST /run registers them under wf.id),
  // so a webhook called by its custom slug must still arm/fire/complete on
  // wf.id — using req.params.id (the slug) left the Run waiting forever.
  if (!liveWebhook && !isWebhookArmed(wf.id)) {
    return res.status(409).json({
      error: "This webhook is not listening right now.",
      hint: "The webhook URL only accepts a request while the workflow run is waiting for one (press Run in the editor), or when the trigger's 'Always listen' option is enabled so the server keeps it armed.",
    });
  }
  const firedWaitId = liveWebhook ? null : markWebhookFired(wf.id);

  // A webhook call counts as a run of its owner's account (free-plan daily
  // cap). Pro workflows are unlimited. On denial, hand the waiting editor an
  // error result so its poll completes with the real reason.
  const quota = await runQuota(wf.ownerId);
  if (!quota.allowed) {
    const limitError = {
      success: false,
      error: `The free plan allows ${quota.limit} workflow runs per day and this workflow's owner has used all ${quota.used}. Runs reset at midnight (UTC).`,
      errorCount: 0,
      durationMs: 0,
      log: [],
      consoleLog: [],
      nodeCount: (wf.nodes || []).length,
    };
    completeWebhookWait(wf.id, limitError);
    return res.status(403).json({ error: limitError.error });
  }
  if (quota.limit !== null) await db.bumpRunUsage(wf.ownerId);

  try {
    const result = await executeRouted(wf, {
      source: "webhook", // listed as running until recordExecution saves it
      executionId: firedWaitId || undefined, // carries on the "waiting for trigger" row
      // GET requests have no body — the query string is the input
      webhookPayload: req.method === "GET" ? { ...(req.query || {}) } : req.body ?? {},
      webhookHeaders: req.headers,
      webhookQuery: req.query,
      method: req.method,
      // webhooks stay public, but the run still resolves agents as the owner
      userId: wf.ownerId,
    });
    await recordExecution(wf, result, "webhook");
    // A manual run (Run button) may be waiting for this call — hand the result
    // over so the editor's poll completes. The caller still gets the response
    // below, this is fire-and-forget.
    completeWebhookWait(wf.id, result);
    // Preferred: a Webhook Respond node captured the HTTP response during the
    // run — send that back to the caller. This is the new (receive → … →
    // respond) model: the Webhook trigger only receives input.
    const respond = result.webhookResponse;
    if (respond) {
      const code = respond.status || (result.success ? 200 : 500);
      // A string body (contentType "body") must be sent as-is — passing it to
      // res.json() would double-encode it into a JSON string literal.
      if (typeof respond.body === "string") {
        return res.status(code).type("application/json").send(respond.body);
      }
      return res.status(code).json(respond.body);
    }
    // Legacy fallback: if no Webhook Respond node exists, answer from the
    // trigger node's responseMode (keeps old workflows working). The response
    // goes to an ANONYMOUS caller, so it must never ship the full run log /
    // node outputs — those can carry data the workflow pulled from the owner's
    // authenticated services. A failed run is reported as a plain error; the
    // full log stays in the editor's Execution history for the owner.
    const trigger = triggerNode;
    const mode = trigger?.data?.config?.responseMode || "json";
    const failureBody = {
      ok: false,
      success: false,
      errorCount: result.errorCount ?? 0,
      error:
        "The workflow ran with errors (no Webhook Respond node answered). Open it in the editor and check the Execution log for details.",
    };
    if (!result.success) return res.status(500).json(failureBody);
    if (mode === "custom") {
      try {
        return res.type("application/json").send(trigger.data.config.customResponse || "{}");
      } catch {
        return res.send(trigger.data.config.customResponse || "{}");
      }
    }
    // Both "ok" and the old "json" default now answer with a minimal receipt —
    // use a Webhook Respond node to return data on purpose.
    res.status(200).json({ ok: true });
  } catch (err) {
    // Hand the failure to any waiting Run too, so the editor's poll completes
    // with an error instead of waiting forever.
    completeWebhookWait(wf.id, {
      success: false,
      errorCount: 1,
      durationMs: 0,
      log: [],
      consoleLog: [],
      nodeCount: (wf.nodes || []).length,
      error: String(err.message || err),
    });
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ----------------------------------------------------------------------------
// Agents (AI agent builder) — private to the logged-in account, like workflows.
// The model API key is lifted out of agents.json into the encrypted
// agent_secrets table on save and re-injected when the owner lists/opens the
// agent or chats with it (and when a workflow runs it — see the executor).
// ----------------------------------------------------------------------------
async function hydrateAgent(agent) {
  return hydrateAgentSecrets(agent, await db.getAgentSecrets(agent.id));
}

async function saveAgentWithSecrets(agent, userId) {
  await db.replaceAgentSecrets(agent.id, userId, collectAgentSecrets(agent));
  agents.save(blankAgentSecrets(agent));
}

app.get("/api/agents", async (req, res) => {
  const list = [];
  for (const agent of agents.listOwned(req.user.userId)) {
    list.push(await hydrateAgent(agent));
  }
  res.json(list);
});

app.post("/api/agents", async (req, res) => {
  const agent = { ...(req.body || {}) };
  // A client-supplied id would overwrite another account's agent (save is an
  // upsert on id), so always mint a fresh one and set ownership from the session.
  agent.id = randomUUID();
  delete agent.ownerId;
  agent.name = agent.name || "Untitled agent";
  agent.model = agent.model || {};
  agent.tools = agent.tools || {};
  agent.ownerId = req.user.userId;
  await saveAgentWithSecrets(agent, req.user.userId);
  res.json(await hydrateAgent(agent));
});

app.get("/api/agents/:id", async (req, res) => {
  const agent = agents.getOwned(req.params.id, req.user.userId);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(await hydrateAgent(agent));
});

app.put("/api/agents/:id", async (req, res) => {
  const existing = agents.getOwned(req.params.id, req.user.userId);
  if (!existing) return res.status(404).json({ error: "Agent not found" });
  const agent = { ...existing, ...req.body, id: existing.id, ownerId: existing.ownerId };
  agent.updatedAt = new Date().toISOString();
  await saveAgentWithSecrets(agent, req.user.userId);
  res.json(await hydrateAgent(agent));
});

app.delete("/api/agents/:id", async (req, res) => {
  if (!agents.removeOwned(req.params.id, req.user.userId)) {
    return res.status(404).json({ error: "Agent not found" });
  }
  await db.deleteAgentSecrets(req.params.id);
  res.json({ ok: true });
});

// Chat with an agent
app.post("/api/agents/:id/chat", async (req, res) => {
  const stored = agents.getOwned(req.params.id, req.user.userId);
  if (!stored) return res.status(404).json({ error: "Agent not found" });
  const agent = await hydrateAgent(stored);
  const history = req.body?.messages || [];
  try {
    const result = await runAgent(agent, history);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Test a model connection (used by the config panel)
app.post("/api/ai/test", async (req, res) => {
  try {
    const result = await testConnection(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// One-off chat used by the inline node config tester
app.post("/api/ai/chat", async (req, res) => {
  const { config, messages } = req.body || {};
  try {
    const result = await chatCompletion(config || {}, messages || []);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Live model list — the config panel asks for the models the chosen provider
// exposes using the user's own base URL + API key, so the model dropdown is
// always up to date (and auto-filled together with the base URL).
app.post("/api/ai/models", async (req, res) => {
  try {
    const models = await listModels(req.body || {});
    res.json({ ok: true, models });
  } catch (err) {
    res.json({ ok: false, models: [], error: String(err.message || err) });
  }
});

// ----------------------------------------------------------------------------
// AI workflow builder — the in-editor agent that writes workflows for you.
//
// The agent has NO built-in model: every account brings its own credentials
// (provider + base URL + API key + model). They are stored per account in the
// encrypted settings store, are never returned to the browser (only a
// hasKey flag), and are only used to call the provider the user configured.
//
//   GET    /api/ai-builder          → is it configured? (never the key)
//   PUT    /api/ai-builder          → save credentials / model choice
//   DELETE /api/ai-builder          → forget the stored credentials
//   POST   /api/ai-builder/models   → live model list for the chosen provider
//   POST   /api/ai-builder/build    → prompt + workflow JSON in → new workflow out
// ----------------------------------------------------------------------------
const builderKey = (userId) => `ai.builder.${userId}`;

async function getBuilderSettings(userId) {
  const raw = await db.storeGet(builderKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function saveBuilderSettings(userId, cfg) {
  await db.storeSet(builderKey(userId), JSON.stringify(cfg || {}), { encrypted: true });
}

// Shape sent to the browser — the API key is replaced by a boolean.
function publicBuilderSettings(cfg) {
  return {
    configured: !!(cfg && cfg.model && (cfg.apiKey || cfg.provider === "ollama" || cfg.provider === "lmstudio")),
    provider: cfg?.provider || "openai",
    baseUrl: cfg?.baseUrl || "",
    model: cfg?.model || "",
    hasKey: !!cfg?.apiKey,
  };
}

app.get("/api/ai-builder", requireUser, async (req, res) => {
  res.json(publicBuilderSettings(await getBuilderSettings(req.user.userId)));
});

app.put("/api/ai-builder", requireUser, async (req, res) => {
  const existing = (await getBuilderSettings(req.user.userId)) || {};
  const provider = String(req.body?.provider || existing.provider || "openai").trim().slice(0, 40);
  const baseUrl = String(req.body?.baseUrl ?? existing.baseUrl ?? "").trim().slice(0, 300);
  const model = String(req.body?.model ?? existing.model ?? "").trim().slice(0, 160);
  // An empty apiKey keeps the stored one (the browser never receives it, so a
  // save that only changes the model must not wipe the key).
  const apiKey =
    req.body?.apiKey === undefined || req.body?.apiKey === null || req.body?.apiKey === ""
      ? existing.apiKey || ""
      : String(req.body.apiKey).trim().slice(0, 400);
  const next = { provider, baseUrl, model, apiKey };
  await saveBuilderSettings(req.user.userId, next);
  res.json(publicBuilderSettings(next));
});

app.delete("/api/ai-builder", requireUser, async (req, res) => {
  await db.storeSet(builderKey(req.user.userId), JSON.stringify({}), { encrypted: true });
  res.json({ ok: true });
});

app.post("/api/ai-builder/models", requireUser, async (req, res) => {
  const stored = (await getBuilderSettings(req.user.userId)) || {};
  const config = {
    provider: req.body?.provider || stored.provider,
    baseUrl: req.body?.baseUrl ?? stored.baseUrl,
    apiKey: req.body?.apiKey || stored.apiKey,
  };
  try {
    const models = await listModels(config);
    res.json({ ok: true, models });
  } catch (err) {
    res.json({ ok: false, models: [], error: String(err.message || err) });
  }
});

// The main call: the user's prompt + the workflow on their canvas + the
// generated node documentation go to their model; the new workflow comes back
// and is handed to the editor, which imports it into the canvas automatically.
app.post("/api/ai-builder/build", requireUser, async (req, res) => {
  const settings = await getBuilderSettings(req.user.userId);
  if (!settings || !settings.model) {
    return res.status(400).json({ error: "Set up your model credentials for the builder agent first." });
  }
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Describe the workflow you want the agent to build." });

  // The workflow the user is looking at. Prefer the canvas state the editor
  // sent; fall back to the stored copy. Credentials are stripped before the
  // JSON is ever sent to a third-party model.
  let current = req.body?.workflow;
  if (!current && req.body?.workflowId) {
    const owned = await getAccessibleWorkflow(String(req.body.workflowId), req.user.userId);
    if (owned) current = await hydrateWorkflowSecrets(owned);
  }
  if (!current || typeof current !== "object") current = { nodes: [], edges: [] };
  const safeWorkflow = stripSecretsFromWorkflow({
    id: current.id,
    name: current.name,
    description: current.description,
    nodes: Array.isArray(current.nodes) ? current.nodes : [],
    edges: Array.isArray(current.edges) ? current.edges : [],
  });

  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
  // Nodes the user pinned in the editor as "references" for this request. They
  // tell the agent exactly which step the user means, so a config the user set
  // by hand is not guessed away. Credentials are stripped here as well, since
  // the pinned config is user input.
  const references = (Array.isArray(req.body?.references) ? req.body.references : [])
    .filter((r) => r && typeof r === "object")
    .slice(0, 12)
    .map((r) => {
      const scrubbed = stripSecretsFromWorkflow({ nodes: [{ data: { config: r.config && typeof r.config === "object" ? r.config : {} } }] });
      return {
        nodeId: String(r.nodeId || "").slice(0, 80),
        label: String(r.label || "").slice(0, 120),
        type: String(r.type || "").slice(0, 60),
        config: scrubbed.nodes[0]?.data?.config || {},
      };
    });
  try {
    const result = await buildWorkflow({ settings, prompt, workflow: safeWorkflow, history, references });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ----------------------------------------------------------------------------
// Statistics for the Main page — production runs, failures and time saved.
//
// "Production" means every run the account did NOT start by hand in the editor
// (webhook, schedule, chat, Telegram, …), because those are the runs that
// replace manual work. Time saved estimates the human effort those runs would
// have taken at MANUAL_MINUTES_PER_RUN, minus the machine time they actually
// took — the same idea as n8n's "time saved" metric, and just as much of an
// estimate: adjust it with BF_MANUAL_MINUTES_PER_RUN.
// ----------------------------------------------------------------------------
const MANUAL_MINUTES_PER_RUN = Number(process.env.BF_MANUAL_MINUTES_PER_RUN || 5);

app.get("/api/stats", requireUser, async (req, res) => {
  const stats = await db.executionStatsByOwner(req.user.userId);
  const prodExecutions = Number(stats.prodExecutions || 0);
  const failedProd = Number(stats.failedProd || 0);
  const prodDurationMs = Number(stats.prodDurationMs || 0);
  const manualMs = prodExecutions * MANUAL_MINUTES_PER_RUN * 60_000;
  res.json({
    prodExecutions,
    failedProdExecutions: failedProd,
    failureRate: prodExecutions ? Math.round((failedProd / prodExecutions) * 1000) / 10 : 0,
    timeSavedMs: Math.max(0, manualMs - prodDurationMs),
    avgRunTimeMs: Number(stats.avgDurationMs || 0),
    totalExecutions: Number(stats.totalExecutions || 0),
    editorExecutions: Number(stats.editorExecutions || 0),
    manualMinutesPerRun: MANUAL_MINUTES_PER_RUN,
    // AI usage across every run: tokens the models saw/returned and what that
    // costs according to the account's editable price table (Settings → AI).
    promptTokens: Number(stats.promptTokens || 0),
    completionTokens: Number(stats.completionTokens || 0),
    aiSpendUsd: Math.round(Number(stats.aiCostUsd || 0) * 1e6) / 1e6,
  });
});

// ----------------------------------------------------------------------------
// Starter templates — curated, runnable skeletons offered on the Workflows
// page ("Start from a template") and to the AI builder as house style. They are
// plain workflow payloads, so creating one is a normal POST /api/workflows with
// the template's nodes + edges; credentials always come out empty.
// ----------------------------------------------------------------------------
app.get("/api/templates", (_req, res) => {
  res.json({ categories: TEMPLATE_CATEGORIES, templates: templateSummaries() });
});

app.get("/api/templates/:id", (req, res) => {
  const template = getTemplate(req.params.id);
  if (!template) return res.status(404).json({ error: "Template not found" });
  res.json(template);
});

// ----------------------------------------------------------------------------
// AI usage & cost — the account's own editable price table (USD per 1M tokens
// per model, plus a fallback). Used to price every run's token usage; the
// presets are only a starting point and can be edited or emptied.
// ----------------------------------------------------------------------------
app.get("/api/ai/prices", requireUser, async (req, res) => {
  const table = await getPriceSettings(req.user.userId);
  res.json({ ...table, presets: PRESET_PRICES });
});

app.put("/api/ai/prices", requireUser, async (req, res) => {
  res.json(await savePriceSettings(req.user.userId, req.body || {}));
});

// Spending control (server/ai-budget.js): the account's token / USD budgets,
// the cheaper-model fallback and where budget alerts go; the usage dashboard
// and the editor's per-workflow cost preview (server/ai-usage.js).
app.get("/api/ai/budget", requireUser, async (req, res) => {
  const overview = await budgetOverview(req.user.userId);
  const bots = await listTelegramBots(req.user.userId).catch(() => []);
  res.json({ ...overview, bots });
});

app.put("/api/ai/budget", requireUser, async (req, res) => {
  await saveAccountSettings(req.user.userId, req.body || {});
  res.json(await budgetOverview(req.user.userId));
});

app.post("/api/ai/budget/test-alert", requireUser, async (req, res) => {
  const settings = await getAccountSettings(req.user.userId);
  if (!settings.alerts.telegram) return res.status(400).json({ error: "Switch Telegram alerts on and pick a bot and chat first." });
  try {
    const token = await botTokenFor({ id: settings.alerts.botId, userId: req.user.userId });
    if (!token) return res.status(400).json({ error: "The chosen bot is no longer connected — pick another one under Credentials." });
    await telegramApi(token, "sendMessage", { chat_id: settings.alerts.chatId, text: "W flow — test: AI budget alerts arrive here." });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get("/api/ai/usage", requireUser, async (req, res) => {
  const owned = await workflows.listOwned(req.user.userId);
  const workflowNames = Object.fromEntries(owned.map((w) => [w.id, w.name || w.id]));
  res.json(await usageDashboard(req.user.userId, { days: req.query.days, workflowNames }));
});

app.get("/api/workflows/:id/ai-estimate", requireUser, async (req, res) => {
  const wf = await getAccessibleWorkflow(req.params.id, req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  // Budgets and history belong to the workflow's owner.
  res.json(await workflowEstimate(wf.ownerId || req.user.userId, wf));
});

// ----------------------------------------------------------------------------
// Community — workflows users published on the instance. Every post has a
// visibility: "public" (everyone can browse/import), "private" (only the
// author) or "restricted" (only the author + explicitly allowed users). The
// whole area requires a registered account (guests get 401). Secrets (API
// keys, passwords, webhook URLs) are scrubbed on publish.
// ----------------------------------------------------------------------------
// Older posts were saved before engagement existed — make sure every post has
// the arrays the like/save/comment endpoints mutate.
function normalizePost(post) {
  if (!Array.isArray(post.likes)) post.likes = [];
  if (!Array.isArray(post.saves)) post.saves = [];
  if (!Array.isArray(post.comments)) post.comments = [];
  if (typeof post.imports !== "number") post.imports = 0;
  return post;
}

// The feed's "popular" ranking: comments and likes weigh most, saves and
// imports break ties. Cheap to compute and stable across restarts.
function popularityScore(post) {
  return (
    (post.likes || []).length * 3 +
    (post.comments || []).length * 3 +
    (post.saves || []).length * 2 +
    (Number(post.imports) || 0)
  );
}

// What a viewer may see: counts plus whether THEY liked/saved it. Raw id
// arrays and the workflow body never leave the server.
function publicPostShape(post, userId) {
  // Internal-only fields: the workflow body, raw engagement id lists and the
  // allowed-user list never leave the server through this shape.
  const { nodes, edges, likes, saves, comments, allowedUserIds, ...meta } = post;
  return {
    ...meta,
    nodeCount: (nodes || []).length,
    edgeCount: (edges || []).length,
    likeCount: (likes || []).length,
    commentCount: (comments || []).length,
    saveCount: (saves || []).length,
    importCount: Number(post.imports) || 0,
    liked: (likes || []).some((id) => String(id) === String(userId)),
    saved: (saves || []).some((id) => String(id) === String(userId)),
    popularity: popularityScore(post),
    anonymous: !!post.anonymous,
    // An anonymous post never reveals who published it — not even by id.
    ownerName: post.anonymous ? "Anonymous" : meta.ownerName,
    ownerId: post.anonymous ? "" : meta.ownerId,
  };
}

function canViewPost(post, userId) {
  const visibility = String(post.visibility || "public");
  if (visibility === "public") return true;
  if (String(post.ownerId) === String(userId)) return true;
  if (visibility === "restricted") {
    return Array.isArray(post.allowedUserIds) && post.allowedUserIds.some((id) => String(id) === String(userId));
  }
  return false; // private — author only
}

// Sorters for the community feed. "popular" is the combined score; the rest
// isolate one signal so users can browse by what matters to them.
const COMMUNITY_SORTERS = {
  newest: (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  oldest: (a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
  popular: (a, b) =>
    popularityScore(b) - popularityScore(a) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  likes: (a, b) => (b.likes || []).length - (a.likes || []).length,
  comments: (a, b) => (b.comments || []).length - (a.comments || []).length,
  saves: (a, b) => (b.saves || []).length - (a.saves || []).length,
  imports: (a, b) => (Number(b.imports) || 0) - (Number(a.imports) || 0),
};

function shapeCommunityPost(post, viewerId) {
  return {
    ...publicPostShape(post, viewerId),
    mine: String(post.ownerId) === String(viewerId),
    // Only the author sees the exact list of users a restricted post was
    // shared with — everyone else just knows it is not public.
    allowedUserIds: String(post.ownerId) === String(viewerId) ? (post.allowedUserIds || []) : undefined,
  };
}

// The feed: 50 posts per page by default (a busy instance would otherwise ship
// every post ever published to the browser). `sort` picks a ranking, `saved=1`
// shows only posts the viewer bookmarked and `author=<id>` a user's public
// posts. The response stays a plain array for existing clients; the match
// total rides along in X-Total-Count for the UI's “showing X of Y”.
app.get("/api/community", (req, res) => {
  const q = String(req.query?.q || "").trim().toLowerCase();
  const mine = req.query?.mine === "1";
  const savedOnly = req.query?.saved === "1";
  const author = String(req.query?.author || "");
  const sort = String(req.query?.sort || "newest").toLowerCase();
  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query?.offset) || 0, 0);

  let list = community.all().map(normalizePost).filter((p) => canViewPost(p, req.user.userId));
  if (mine) list = list.filter((p) => String(p.ownerId) === String(req.user.userId));
  if (savedOnly) list = list.filter((p) => (p.saves || []).some((id) => String(id) === String(req.user.userId)));
  if (author) {
    // Anonymous posts never show up under their author's name.
    list = list.filter((p) => String(p.ownerId) === author && String(p.visibility || "public") === "public" && (!p.anonymous || String(req.user.userId) === author));
  }
  if (q) {
    list = list.filter(
      (p) =>
        (p.title || "").toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q) ||
        (!p.anonymous && (p.ownerName || "").toLowerCase().includes(q))
    );
  }

  list = [...list].sort(COMMUNITY_SORTERS[sort] || COMMUNITY_SORTERS.newest);
  const total = list.length;
  const page = list.slice(offset, offset + limit);

  res.set("X-Total-Count", String(total));
  res.set("Cache-Control", "no-store");
  res.json(page.map((p) => shapeCommunityPost(p, req.user.userId)));
});

// One post: everything the detail page needs, including the comment thread.
app.get("/api/community/:id", (req, res) => {
  const post = community.get(req.params.id);
  if (!post || !canViewPost(post, req.user.userId)) return res.status(404).json({ error: "Post not found" });
  const normalized = normalizePost(post);
  res.set("Cache-Control", "no-store");
  res.json({
    ...shapeCommunityPost(normalized, req.user.userId),
    comments: (normalized.comments || []).map((c) => ({
      ...c,
      mine: String(c.userId) === String(req.user.userId),
      // same rule as DELETE /api/community/:id/comments/:commentId
      canRemove: String(c.userId) === String(req.user.userId) || String(normalized.ownerId) === String(req.user.userId),
    })),
  });
});

// Toggle a like. Returns the fresh count so the card can update in place.
app.post("/api/community/:id/like", (req, res) => {
  const post = community.get(req.params.id);
  if (!post || !canViewPost(post, req.user.userId)) return res.status(404).json({ error: "Post not found" });
  normalizePost(post);
  const uid = String(req.user.userId);
  const liked = post.likes.some((id) => String(id) === uid);
  post.likes = liked ? post.likes.filter((id) => String(id) !== uid) : [...post.likes, uid];
  community.save(post);
  res.json({ liked: !liked, likeCount: post.likes.length });
});

// Toggle a bookmark ("save for later"). Saved posts are filterable in the feed.
app.post("/api/community/:id/save", (req, res) => {
  const post = community.get(req.params.id);
  if (!post || !canViewPost(post, req.user.userId)) return res.status(404).json({ error: "Post not found" });
  normalizePost(post);
  const uid = String(req.user.userId);
  const saved = post.saves.some((id) => String(id) === uid);
  post.saves = saved ? post.saves.filter((id) => String(id) !== uid) : [...post.saves, uid];
  community.save(post);
  res.json({ saved: !saved, saveCount: post.saves.length });
});

// Add a comment to the thread.
app.post("/api/community/:id/comments", (req, res) => {
  const post = community.get(req.params.id);
  if (!post || !canViewPost(post, req.user.userId)) return res.status(404).json({ error: "Post not found" });
  const text = String(req.body?.text || "").trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: "Write a comment first." });
  normalizePost(post);
  const comment = {
    id: `c-${randomUUID().slice(0, 8)}`,
    userId: req.user.userId,
    userName: req.user.name || String(req.user.email || "").split("@")[0] || "user",
    text,
    createdAt: new Date().toISOString(),
  };
  post.comments.push(comment);
  community.save(post);
  res.json({ ...comment, mine: true, commentCount: post.comments.length });
});

// Remove a comment — its author or the post's owner.
app.delete("/api/community/:id/comments/:commentId", (req, res) => {
  const post = community.get(req.params.id);
  if (!post || !canViewPost(post, req.user.userId)) return res.status(404).json({ error: "Post not found" });
  normalizePost(post);
  const comment = post.comments.find((c) => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ error: "Comment not found" });
  const canRemove =
    String(comment.userId) === String(req.user.userId) || String(post.ownerId) === String(req.user.userId);
  if (!canRemove) return res.status(403).json({ error: "You can only remove your own comments." });
  post.comments = post.comments.filter((c) => c.id !== req.params.commentId);
  community.save(post);
  res.json({ ok: true, commentCount: post.comments.length });
});

app.post("/api/community", async (req, res) => {
  const wf = await workflows.getOwned(String(req.body?.workflowId || ""), req.user.userId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "Give the shared workflow a title." });
  if ((wf.nodes || []).length > 300) {
    return res.status(400).json({ error: "This workflow is too large to share (max 300 nodes)." });
  }
  const visibility = String(req.body?.visibility || "public");
  if (!["public", "private", "restricted"].includes(visibility)) {
    return res.status(400).json({ error: "Visibility must be public, private or restricted." });
  }
  // Resolve allowed users by email for restricted posts.
  const allowedEmails = Array.isArray(req.body?.allowedUsers)
    ? req.body.allowedUsers.map((e) => String(e || "").trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    : [];
  const allowedUserIds = [];
  for (const email of allowedEmails) {
    const u = await db.getUserByEmail(email);
    if (u && String(u.id) !== String(req.user.userId)) allowedUserIds.push(u.id);
  }
  // Credentials AND personal values (recipients, chat IDs, logins, hosts,
  // wallets — shared/privacy.js) stay with the author.
  const scrubbed = stripPrivateFromWorkflow(stripSecretsFromWorkflow(wf));
  const post = {
    id: `p-${randomUUID().slice(0, 8)}`,
    workflowId: wf.id,
    title,
    description: String(req.body?.description || "").trim().slice(0, 2000),
    ownerId: req.user.userId,
    ownerName: req.user.name || String(req.user.email || "").split("@")[0] || "user",
    nodes: scrubbed.nodes,
    edges: scrubbed.edges || [],
    visibility,
    allowedUserIds: visibility === "restricted" ? allowedUserIds : [],
    createdAt: new Date().toISOString(),
    // Engagement starts empty; the author can publish anonymously so the post
    // shows "Anonymous" and hides their profile link.
    anonymous: !!req.body?.anonymous,
    likes: [],
    saves: [],
    comments: [],
    imports: 0,
  };
  community.save(post);
  res.json(publicPostShape(post, req.user.userId));
});

app.delete("/api/community/:id", (req, res) => {
  const post = community.get(req.params.id);
  if (!post) return res.status(404).json({ error: "Post not found" });
  if (post.ownerId !== req.user.userId) {
    return res.status(403).json({ error: "Only the author can remove this post." });
  }
  community.remove(req.params.id);
  res.json({ ok: true });
});

// Copy a community post into the caller's account as their own workflow.
app.post("/api/community/:id/import", async (req, res) => {
  const post = community.get(req.params.id);
  if (!post || !canViewPost(post, req.user.userId)) return res.status(404).json({ error: "Post not found" });
  // Importing counts against the free workflow cap, exactly like creating one.
  if (!(await isProUser(req.user.userId))) {
    const owned = await workflows.listOwned(req.user.userId);
    if (owned.length >= FREE_MAX_WORKFLOWS) {
      return res.status(403).json({
        error: `The free plan allows up to ${FREE_MAX_WORKFLOWS} saved workflows. Delete one to free a slot, or go Pro for unlimited workflows.`,
      });
    }
  }
  const wf = {
    id: `wf-${randomUUID().slice(0, 8)}`,
    name: `${post.title || "Community workflow"} (fork)`,
    description: post.description || `Imported from the community: ${post.title}`,
    // stripped again: posts published before personal values were removed
    nodes: stripPrivateFromWorkflow({ nodes: JSON.parse(JSON.stringify(post.nodes || [])) }).nodes,
    edges: JSON.parse(JSON.stringify(post.edges || [])),
    ownerId: req.user.userId,
    updatedAt: new Date().toISOString(),
  };
  await workflows.save(wf);
  await db.addWorkflowToUser(req.user.userId, wf.id);
  // Importing improves the post's popularity ranking without touching likes.
  normalizePost(post);
  post.imports = (Number(post.imports) || 0) + 1;
  community.save(post);
  res.json(wf);
});

// ----------------------------------------------------------------------------
// Profiles — a small, user-editable public page (display name, bio, links,
// avatar). Stored as JSON in the settings table, keyed per account, so no
// schema migration is needed; the account's login name/e-mail stay in users.
// ----------------------------------------------------------------------------
const PROFILE_KEY = (userId) => `profile.${String(userId || "")}`;
const DEFAULT_PROFILE = { displayName: "", bio: "", location: "", website: "", avatar: "", anonymousByDefault: false };

async function readProfile(userId) {
  let stored = {};
  try {
    stored = JSON.parse((await db.storeGet(PROFILE_KEY(userId))) || "{}") || {};
  } catch {
    stored = {};
  }
  return { ...DEFAULT_PROFILE, ...stored };
}

function profileShape(profile, user) {
  return {
    displayName: profile.displayName || user?.name || String(user?.email || "").split("@")[0] || "user",
    bio: profile.bio || "",
    location: profile.location || "",
    website: profile.website || "",
    avatar: profile.avatar || "",
    anonymousByDefault: !!profile.anonymousByDefault,
  };
}

// The logged-in user's own profile (including their private e-mail).
app.get("/api/profile", async (req, res) => {
  const user = await db.getUserById(req.user.userId);
  const profile = await readProfile(req.user.userId);
  const mine = community.all().filter((p) => String(p.ownerId) === String(req.user.userId));
  res.set("Cache-Control", "no-store");
  res.json({
    ...profileShape(profile, user),
    id: req.user.userId,
    email: user?.email || "",
    joinedAt: user?.created_at || "",
    // Profile is purely for the community, so "postCount" means public posts.
    postCount: mine.filter((p) => String(p.visibility || "public") === "public").length,
    likeCount: mine.reduce((n, p) => n + (Array.isArray(p.likes) ? p.likes.length : 0), 0),
  });
});

// Update the editable profile fields. Bounded lengths, and a website that is
// normalised to http(s) so a bare "example.com" still becomes a usable link.
app.put("/api/profile", async (req, res) => {
  const user = await db.getUserById(req.user.userId);
  const current = await readProfile(req.user.userId);
  const cleanUrl = (v) => {
    const s = String(v || "").trim().slice(0, 200);
    if (!s) return "";
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  };
  const next = {
    displayName: String(req.body?.displayName ?? current.displayName).trim().slice(0, 60),
    bio: String(req.body?.bio ?? current.bio).trim().slice(0, 600),
    location: String(req.body?.location ?? current.location).trim().slice(0, 80),
    website: cleanUrl(req.body?.website ?? current.website),
    avatar: String(req.body?.avatar ?? current.avatar).trim().slice(0, 200),
    anonymousByDefault:
      req.body?.anonymousByDefault !== undefined ? !!req.body.anonymousByDefault : !!current.anonymousByDefault,
    updatedAt: new Date().toISOString(),
  };
  try {
    await db.storeSet(PROFILE_KEY(req.user.userId), JSON.stringify(next));
  } catch {
    return res.status(500).json({ error: "Could not save the profile." });
  }
  const mine = community.all().filter((p) => String(p.ownerId) === String(req.user.userId));
  res.json({
    ...profileShape(next, user),
    id: req.user.userId,
    email: user?.email || "",
    joinedAt: user?.created_at || "",
    postCount: mine.filter((p) => String(p.visibility || "public") === "public").length,
    likeCount: mine.reduce((n, p) => n + (Array.isArray(p.likes) ? p.likes.length : 0), 0),
  });
});

// Anyone's public profile: their info + their public community posts.
app.get("/api/profile/:userId", async (req, res) => {
  const user = await db.getUserById(req.params.userId);
  if (!user) return res.status(404).json({ error: "Profile not found" });
  const profile = await readProfile(user.id);
  const posts = community
    .all()
    .map(normalizePost)
    .filter(
      (p) =>
        String(p.ownerId) === String(user.id) &&
        String(p.visibility || "public") === "public" &&
        // anonymous posts stay off the public profile (the author still sees them)
        (!p.anonymous || String(req.user?.userId) === String(user.id))
    )
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  res.set("Cache-Control", "no-store");
  res.json({
    id: user.id,
    ...profileShape(profile, user),
    joinedAt: user?.created_at || "",
    postCount: posts.length,
    likeCount: posts.reduce((n, p) => n + (Array.isArray(p.likes) ? p.likes.length : 0), 0),
    // A profile's "public workflows" are its public community posts — the only
    // items a user explicitly chooses to publish.
    publicWorkflows: posts.slice(0, 50).map((p) => publicPostShape(p, req.user.userId)),
  });
});

// ----------------------------------------------------------------------------
// Billing — paid subscription (€9.99 / month) bought via Stripe Checkout.
// Config is connected from the admin panel (admin → Billing (Stripe) tab) and
// stored in the shared DB (secret keys encrypted at rest); env vault values act
// as fallbacks. The webhook is public (Stripe has no login cookie); every other
// /api/billing route requires the logged-in account.
// ----------------------------------------------------------------------------
// The current account's subscription + whether the site has Stripe wired up.
app.get("/api/billing", requireUser, async (req, res) => {
  const sub = await db.getSubscription(req.user.userId);
  const cfg = await stripeConfig();
  const subActive = sub?.status === "active" || sub?.status === "trialing";
  // Pro can come from two places and BOTH must be honoured here: an active
  // Stripe subscription, or the account's role being `pro_user` (an operator
  // grant from the admin panel → Users). isProUser() — which lifts the caps and
  // unlocks the Pro features — already accepts either, so this endpoint has to
  // agree with it; otherwise a role-granted account is Pro on the server and
  // still looks free in the UI (locked switches, "FREE PLAN" badge).
  const rolePro = String(req.user.role || "").toLowerCase() === "pro_user";
  // A crypto (NOWPayments) subscription is a real subscription too, but it has
  // no Stripe customer/portal and never auto-renews — the UI treats it apart.
  const cryptoSub = isCryptoSubscriptionId(sub?.subscription_id);
  const active = rolePro || subActive;
  // current usage so the Pro page (and any UI) can show the free tier state
  const workflowCount = (await workflows.listOwned(req.user.userId)).length;
  const runsToday = await db.getRunUsage(req.user.userId);
  // Per-account state that changes the moment an operator grants the Pro role:
  // never let a browser or proxy serve a stale copy of it.
  res.set("Cache-Control", "no-store");
  res.json({
    configured: !!(cfg.secretKey && cfg.priceId),
    // whether the operator is accepting Pro purchases right now (admin toggle).
    // A fresh install starts closed: everyone is on free, Pro opens next month.
    salesOpen: await salesOpen(),
    priceLabel: defaultPriceLabel(),
    active,
    // where the Pro access comes from: "role" (granted by the operator),
    // "subscription" (Stripe) or "none" (free plan).
    source: rolePro ? "role" : subActive ? "subscription" : "none",
    status: sub?.status || "none",
    since: sub?.created_at || "",
    periodEnd: sub?.current_period_end || 0,
    // Self-service billing state: whether there is a Stripe customer to open
    // the Billing Portal for, and whether the plan is set to end at period end.
    // A crypto subscription is excluded: it has no portal and cannot be
    // cancelled or resumed through Stripe.
    hasCustomer: !cryptoSub && !!sub?.customer_id,
    hasSubscription: !cryptoSub && !!sub?.subscription_id,
    cancelAtPeriodEnd: subActive && !cryptoSub ? await getCancelAtPeriodEnd(req.user.userId) : false,
    // true when the active plan was bought with crypto (renews manually)
    crypto: cryptoSub,
    // whether this instance accepts crypto payments, and how they are priced
    cryptoPayments: await publicCryptoConfig(),
    // free-plan caps (null = unlimited — Pro)
    plan: active ? "pro" : "free",
    workflowCount,
    workflowLimit: active ? null : FREE_MAX_WORKFLOWS,
    runsToday,
    runsPerDayLimit: active ? null : FREE_MAX_RUNS_PER_DAY,
  });
});

// Buy the subscription: create a Stripe Checkout Session, then send the user to
// Stripe's hosted page. The account id is carried so the webhook attributes it.
app.post("/api/billing/checkout", requireUser, async (req, res) => {
  // Sales gate (same rule createCheckoutSession enforces): on a fresh install
  // sales are closed and users are on the free plan — the subscription page
  // shows "Pro opens next month" and this endpoint refuses until the admin
  // toggles sales open.
  if (!(await salesOpen())) {
    return res.status(403).json({ error: "Pro subscriptions are not open yet — check back next month." });
  }
  try {
    const { url } = await createCheckoutSession({
      userId: req.user.userId,
      email: req.user.email,
      name: req.user.name,
    });
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Open Stripe's own Billing Portal: the account updates its card, downloads
// invoices and cancels there — no operator involvement needed.
app.post("/api/billing/portal", requireUser, async (req, res) => {
  const sub = await db.getSubscription(req.user.userId);
  try {
    const { url } = await createBillingPortalSession({
      customerId: sub?.customer_id || "",
      returnUrl: `${await requestBaseUrl(req)}/subscription`,
    });
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Cancel at the end of the paid period (access stays until then).
app.post("/api/billing/cancel", requireUser, async (req, res) => {
  const sub = await db.getSubscription(req.user.userId);
  if (!sub?.subscription_id) {
    return res.status(400).json({
      error: "This account has no subscription to cancel — your Pro access was given to you, so there is nothing to pay or cancel.",
    });
  }
  try {
    const result = await updateSubscriptionCancel({ subscriptionId: sub.subscription_id, cancelAtPeriodEnd: true });
    await setCancelAtPeriodEnd(req.user.userId, result.cancelAtPeriodEnd);
    await db.setSubscription(req.user.userId, {
      status: result.status || undefined,
      currentPeriodEnd: result.currentPeriodEnd || undefined,
    });
    res.json({ ok: true, cancelAtPeriodEnd: result.cancelAtPeriodEnd, periodEnd: result.currentPeriodEnd });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Undo a scheduled cancellation ("keep my subscription").
app.post("/api/billing/resume", requireUser, async (req, res) => {
  const sub = await db.getSubscription(req.user.userId);
  if (!sub?.subscription_id) return res.status(400).json({ error: "This account has no Stripe subscription." });
  try {
    const result = await updateSubscriptionCancel({ subscriptionId: sub.subscription_id, cancelAtPeriodEnd: false });
    await setCancelAtPeriodEnd(req.user.userId, result.cancelAtPeriodEnd);
    await db.setSubscription(req.user.userId, {
      status: result.status || undefined,
      currentPeriodEnd: result.currentPeriodEnd || undefined,
    });
    res.json({ ok: true, cancelAtPeriodEnd: result.cancelAtPeriodEnd, periodEnd: result.currentPeriodEnd });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Stripe subscription lifecycle webhook:
//   1. the raw body is verified against the `stripe-signature` header (HMAC)
//   2. checkout.session.completed / customer.subscription.* events update the DB
// Any malformed or unverifiable request is rejected (Stripe retries with 4xx).
app.post("/api/billing/webhook", async (req, res) => {
  const cfg = await stripeConfig();
  if (!cfg.webhookSecret) {
    return res.status(500).json({ error: "Stripe webhook secret is not configured." });
  }
  const sig = req.headers["stripe-signature"] || "";
  if (!verifyStripeSignature(sig, req.body, cfg.webhookSecret)) {
    return res.status(400).json({ error: "Invalid or missing Stripe signature." });
  }
  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Malformed webhook body." });
  }
  try {
    const result = await handleStripeEvent(event);
    // A Team plan purchase (createCustomCheckoutSession) carries its team id.
    const obj = event?.data?.object || {};
    if (event?.type === "checkout.session.completed" && obj.metadata?.team_id) {
      await activateTeamFromCheckout(obj.metadata.team_id, obj.subscription);
    }
    res.json({ received: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ----------------------------------------------------------------------------
// Crypto billing (NOWPayments) — the card-free way to buy the same Pro plan.
//
//   POST /api/billing/crypto/checkout → create an invoice, return its URL
//   POST /api/billing/crypto/webhook  → NOWPayments IPN; verifies the HMAC and
//                                       switches the account to Pro on success
// ----------------------------------------------------------------------------
app.post("/api/billing/crypto/checkout", requireUser, async (req, res) => {
  if (!(await salesOpen())) {
    return res.status(403).json({ error: "Pro subscriptions are not open yet — check back next month." });
  }
  if (!(await cryptoEnabled())) {
    return res.status(400).json({ error: "Crypto payments are not available on this site." });
  }
  try {
    const { url } = await createCryptoInvoice({ userId: req.user.userId, email: req.user.email });
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/billing/crypto/webhook", async (req, res) => {
  const cfg = await cryptoConfig();
  if (!cfg.ipnSecret) {
    return res.status(500).json({ error: "NOWPayments IPN secret is not configured." });
  }
  const sig = req.headers["x-nowpayments-sig"] || "";
  if (!verifyNowPaymentsSignature(sig, req.body, cfg.ipnSecret)) {
    return res.status(400).json({ error: "Invalid or missing NOWPayments signature." });
  }
  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Malformed webhook body." });
  }
  try {
    const result = await handleCryptoIpn(payload);
    res.json({ received: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ----------------------------------------------------------------------------
// Self-hosted installer (Pro perk) — Settings → Defaults → “Run it self-hosted”.
//
//   GET /api/selfhosted            → is this account Pro, and CAN this instance
//                                    ship a runnable copy at all?
//   GET /api/selfhosted/installer  → the one-file installer (bash / batch) with
//                                    a signed, expiring bundle link inside it
//   GET /api/selfhosted/bundle     → the app ZIP itself, fetched by curl/wget
//                                    on the user's machine (token, not cookie)
// ----------------------------------------------------------------------------
app.get("/api/selfhosted", requireUser, async (req, res) => {
  const state = selfhostReadiness();
  res.json({ pro: await isProUser(req.user.userId), ...state });
});

app.get("/api/selfhosted/installer", requireUser, async (req, res) => {
  if (!(await isProUser(req.user.userId))) {
    return res.status(403).json({ error: "Downloading the self-hosted installer is a Pro feature (Pro tab in the top bar)." });
  }
  const state = selfhostReadiness();
  if (!state.ready) return res.status(409).json({ error: state.reason });

  // windows | mac | linux — the client sends the visitor's own platform.
  const os = normalizeInstallerOs(req.query?.os);
  const baseUrl = await requestBaseUrl(req);
  const script = installerScript({
    os,
    baseUrl,
    token: newBundleToken(),
    port: state.port,
    // the copy checks this account's plan with this server (server/license.js)
    licenseKey: await licenseKeyFor(req.user.userId),
    licenseServer: baseUrl,
  });
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="wflow-selfhost.${installerExtension(os)}"`);
  res.send(script);
});

// The bundle is fetched by curl/wget on the user's own machine, so it cannot
// present a session cookie — it carries the short-lived signed token instead.
app.get("/api/selfhosted/bundle", async (req, res) => {
  if (!verifyBundleToken(req.query?.token)) {
    return res.status(401).json({ error: "This download link is invalid or has expired — download the installer again from Settings → Defaults." });
  }
  const bundle = buildSelfhostBundle();
  if (!bundle) return res.status(409).json({ error: "This instance has no application files to package." });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="wflow.zip"');
  res.setHeader("X-W-Flow-Bundle-Files", String(bundle.files));
  res.send(bundle.zip);
});

// ----------------------------------------------------------------------------
// Self-hosted licence (server/license.js)
//
// Cloud:  GET  /api/selfhosted/license         the account's key (Pro only)
//         POST /api/selfhosted/license/rotate  a new key; the old one stops
//         POST /api/license/check              a copy asks what its key is worth
// Copy:   GET  /api/license                    this copy's licence (lock screen)
//         POST /api/license/key                paste a key (instance owner)
//         POST /api/license/refresh            check again now
// ----------------------------------------------------------------------------

// Pro by subscription / role, or a Team plan — what a licence key is worth.
async function licenseEntitlement(userId) {
  const user = await db.getUserById(userId);
  const team = await teamEntitlement(user);
  if (team?.plan === "team") return team;
  if (await isProUser(userId)) return { pro: true, plan: "pro", seats: 1 };
  return { pro: false };
}

app.get("/api/selfhosted/license", requireUser, async (req, res) => {
  // keys are issued by the cloud only — a copy has its own in .env
  if (licenseRequired()) return res.status(404).json({ error: "Licence keys are issued on w-flow.tech." });
  if (!(await isProUser(req.user.userId))) {
    return res.status(403).json({ error: "Self-hosting is a Pro feature (Pro tab in the top bar)." });
  }
  res.json({ key: await licenseKeyFor(req.user.userId), ...(await licenseEntitlement(req.user.userId)) });
});

app.post("/api/selfhosted/license/rotate", requireUser, async (req, res) => {
  if (licenseRequired()) return res.status(404).json({ error: "Licence keys are issued on w-flow.tech." });
  if (!(await isProUser(req.user.userId))) {
    return res.status(403).json({ error: "Self-hosting is a Pro feature (Pro tab in the top bar)." });
  }
  res.json({ key: await rotateLicenseKey(req.user.userId) });
});

// Public: a copy sends its key (and nothing else). Rate limited per IP so it
// cannot be used to guess keys.
app.post("/api/license/check", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(`license:${ip}`, 30)) return res.status(429).json({ valid: false, reason: "Too many licence checks — try again in a minute." });
  if (licenseRequired()) return res.status(400).json({ valid: false, reason: "This server is itself a self-hosted copy and issues no licences." });
  const answer = await checkLicenseKey(String(req.body?.key || ""), licenseEntitlement);
  // a valid answer also names the version this server ships (one-click update)
  res.json(answer.valid ? { ...answer, latestVersion: shippedVersion() } : answer);
});

// A copy fetches the new version with its licence key — the same check as
// above decides, so a lapsed plan gets no updates.
app.post("/api/selfhosted/update/bundle", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(`update:${ip}`, 6)) return res.status(429).json({ error: "Too many update downloads — try again in a minute." });
  if (licenseRequired()) return res.status(400).json({ error: "Updates come from w-flow.tech, not from another copy." });
  const answer = await checkLicenseKey(String(req.body?.key || ""), licenseEntitlement);
  if (!answer.valid) return res.status(403).json({ error: answer.reason });
  const bundle = buildSelfhostBundle();
  if (!bundle) return res.status(409).json({ error: "This server has no application files to ship." });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("X-W-Flow-Version", bundle.version);
  res.send(bundle.zip);
});

// ---- one-click update on a copy (server/updater.js) ----
app.get("/api/update", requireUser, async (req, res) => {
  res.json({ ...(await updateStatus()), isOwner: await setupAllowed(req.user) });
});

app.post("/api/update/check", requireUser, async (req, res) => {
  if (licenseRequired()) await refreshLicense();
  res.json({ ...(await updateStatus()), isOwner: await setupAllowed(req.user) });
});

app.post("/api/update/apply", requireUser, async (req, res) => {
  if (!(await setupAllowed(req.user))) return res.status(403).json({ error: "Only the owner of this copy can update it." });
  const status = await updateStatus();
  if (!status.canUpdate) return res.status(400).json({ error: status.reason });
  if (!status.available) return res.status(400).json({ error: "This copy already runs the latest version." });
  // runs in the background: the page polls GET /api/update, then the restart
  applyUpdate().catch((err) => console.error(`  [update] failed: ${err.message}`));
  res.status(202).json({ ok: true });
});

app.get("/api/license", async (req, res) => {
  const status = await licenseStatus();
  const user = await currentUser(req);
  res.json({
    ...status,
    isOwner: !!user && (await setupAllowed(user)),
    restricted: !!user && (await isRestricted(user.userId)),
  });
});

app.post("/api/license/key", requireUser, async (req, res) => {
  if (!licenseRequired()) return res.status(400).json({ error: "Only a self-hosted copy takes a licence key." });
  // Before the first account exists nobody could paste it; afterwards only the owner.
  if (!(await setupAllowed(req.user))) return res.status(403).json({ error: "Only the owner of this copy can change its licence." });
  const r = await setLocalLicenseKey(req.body?.key);
  res.status(r.ok ? 200 : 400).json(r);
});

app.post("/api/license/refresh", requireUser, async (_req, res) => {
  if (!licenseRequired()) return res.json(await licenseStatus());
  await refreshLicense();
  res.json(await licenseStatus());
});

// ----------------------------------------------------------------------------
// Custom Team plan (server/teams.js) — request → operator approval → purchase.
// ----------------------------------------------------------------------------
app.get("/api/billing/team", requireUser, async (req, res) => {
  res.json({
    team: await teamView(await teamOwnedBy(req.user.userId)),
    minSeats: MIN_SEATS,
    maxSeats: MAX_SEATS,
    seatPrice: SUGGESTED_SEAT_PRICE,
  });
});

app.post("/api/billing/team/request", requireUser, async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(`team-request:${ip}`, 5)) return res.status(429).json({ error: "Too many requests — try again in a minute." });
  const adminPort = process.env.ADMIN_PORT || 3002;
  const r = await requestTeam(req.user, req.body || {}, { adminUrl: process.env.ADMIN_PUBLIC_URL || `http://localhost:${adminPort}` });
  res.status(r.ok ? 200 : 400).json(r);
});

app.post("/api/billing/team/checkout", requireUser, async (req, res) => {
  const team = await teamOwnedBy(req.user.userId);
  if (!team || team.status !== "approved") return res.status(400).json({ error: "Your Team plan has not been approved yet." });
  try {
    const { url } = await createCustomCheckoutSession({
      userId: req.user.userId,
      email: req.user.email,
      amountCents: Math.round(team.priceMonthly * 100),
      currency: team.currency || "eur",
      productName: `W flow Team — ${team.seats} accounts`,
      metadata: { team_id: team.id },
      baseUrl: await requestBaseUrl(req),
    });
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.put("/api/billing/team/members", requireUser, async (req, res) => {
  const r = await setTeamMembers(req.user.userId, req.body?.members);
  res.status(r.ok ? 200 : 400).json(r);
});

// ----------------------------------------------------------------------------
// Team admin of a self-hosted copy (server/team-admin.js) — the instance owner
// sees every account, where their runs send data, and shares credentials.
// ----------------------------------------------------------------------------
async function requireTeamAdmin(req, res) {
  if (!licenseRequired()) {
    res.status(404).json({ error: "Team administration exists on self-hosted copies only." });
    return false;
  }
  return requireSetupOwner(req, res);
}

app.get("/api/team", requireUser, async (req, res) => {
  if (!(await requireTeamAdmin(req, res))) return;
  res.json(await teamOverview());
});

app.put("/api/team", requireUser, async (req, res) => {
  if (!(await requireTeamAdmin(req, res))) return;
  const r = await updateTeamSettings(req.body || {});
  if (!r.ok) return res.status(400).json(r);
  res.json(await teamOverview());
});

// ----------------------------------------------------------------------------
// Move a self-hosted account to the cloud (server/migrate.js)
//
// Cloud: POST /api/migrate/code    a one-time code for the signed-in account
//        POST /api/migrate/import  the copy sends the data with that code
// Copy:  POST /api/migrate/send    gather this account's data and send it
// ----------------------------------------------------------------------------
const migrationDeps = {
  listWorkflows: (userId) => workflows.listOwned(userId),
  hydrateWorkflow: (wf) => hydrateWorkflowSecrets(wf),
  listAgents: (userId) => agents.listOwned(userId),
  hydrateAgent: (a) => hydrateAgent(a),
  createWorkflow: (userId, body) => createWorkflowForUser(userId, body),
  saveAgent: async (userId, agent) => {
    const a = withId({ ...agent, ownerId: userId });
    await saveAgentWithSecrets(a, userId);
  },
};

app.post("/api/migrate/code", requireUser, async (req, res) => {
  if (licenseRequired()) return res.status(400).json({ error: "Create the move code on w-flow.tech, then paste it into this copy." });
  res.json(await newMigrationCode(req.user.userId));
});

app.post("/api/migrate/import", async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (rateLimited(`migrate:${ip}`, 10)) return res.status(429).json({ error: "Too many attempts — try again in a minute." });
  if (licenseRequired()) return res.status(400).json({ error: "A self-hosted copy does not take moves — send them to w-flow.tech." });
  const code = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const userId = await consumeMigrationCode(code);
  if (!userId) return res.status(401).json({ error: "This move code is invalid, used or expired — create a new one in Settings → Self-hosted." });
  try {
    const counts = await importMigrationPayload(userId, req.body, migrationDeps);
    res.json({ ok: true, ...counts });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/migrate/send", requireUser, async (req, res) => {
  if (!licenseRequired()) return res.status(400).json({ error: "This is already the cloud." });
  const cloudUrl = String(req.body?.cloudUrl || licenseServer() || DEFAULT_LICENSE_SERVER).trim();
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(cloudUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(cloudUrl)) {
    return res.status(400).json({ error: "The cloud address must be https://…" });
  }
  try {
    const payload = await buildMigrationPayload(req.user.userId, migrationDeps);
    const result = await sendToCloud({ cloudUrl, code: req.body?.code, payload });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// ----------------------------------------------------------------------------
// Instance setup — the Setup tab (server/setup.js)
//
// Where this copy stores its data (SQLite file or a PostgreSQL server) and where
// its runs execute (this machine or a remote runner). Answers are written into
// the copy's own .env, so the next start uses them. Only the instance's owner
// may read or change them: an admin, or the first account of a copy the user
// installed themselves.
// ----------------------------------------------------------------------------
async function requireSetupOwner(req, res) {
  if (!(await setupAllowed(req.user))) {
    res.status(403).json({ error: "Only the owner of this instance can open its Setup." });
    return false;
  }
  return true;
}

app.get("/api/setup", requireUser, async (req, res) => {
  if (!(await requireSetupOwner(req, res))) return;
  res.json({ allowed: true, ...readSetup() });
});

app.post("/api/setup", requireUser, async (req, res) => {
  if (!(await requireSetupOwner(req, res))) return;
  const result = saveSetup(req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error, errors: result.errors || [] });
  res.json({ ...result, setup: readSetup() });
});

app.post("/api/setup/test-db", requireUser, async (req, res) => {
  if (!(await requireSetupOwner(req, res))) return;
  res.json(await testDatabase(req.body?.databaseUrl));
});

app.post("/api/setup/test-runner", requireUser, async (req, res) => {
  if (!(await requireSetupOwner(req, res))) return;
  res.json(await testRunner(req.body?.url, req.body?.token));
});

// The other half of that story: when this copy has a runner token it also
// accepts runs from a remote builder (server/runner.js). Without the token both
// endpoints answer 403, so an instance never becomes somebody else's runner by
// accident.
mountRunnerRoutes(app);

// ----------------------------------------------------------------------------
// Static frontend (production)
// ----------------------------------------------------------------------------
// Anything under /api or /webhook that reached here is an unknown route:
// answer with a JSON 404, never Express's HTML 404 or the SPA fallback (the
// frontend fetch()s these and expects JSON).
app.use(["/api", "/webhook"], (_req, res) => res.status(404).json({ error: "Not found." }));

// Legal pages (Impressum / Datenschutz) are served on the main site at root
// paths, so they always work — no subdomain or DNS needed. /legal/* stays as an
// alias, and the middleware above still serves the standalone legal site on the
// legal subdomain when one is configured. There is no AGB / terms page and no
// withdrawal notice: those URLs intentionally return 404.
// When the operator hid the legal pages, these URLs return 404 instead of the
// documents (the links are gone from the UI too).
function legalDocRoute(key) {
  const handler = legalDocHandler(key);
  return async (req, res, next) => {
    if (await legalAndProHidden()) return res.status(404).type("text/plain").send("Not found");
    return handler(req, res, next);
  };
}
app.get(["/impressum", "/imprint"], legalDocRoute("impressum"));
app.get(["/datenschutz", "/privacy"], legalDocRoute("datenschutz"));
// Removed documents: there is deliberately no AGB / terms page and no
// withdrawal notice. Answering 404 (instead of falling through to the SPA
// shell) keeps them clearly gone.
app.get(["/agb", "/terms", "/widerruf", "/withdrawal"], (_req, res) =>
  res.status(404).type("text/plain").send("Not found")
);
app.use("/legal", async (req, res, next) => {
  if (await legalAndProHidden()) return res.status(404).type("text/plain").send("Not found");
  next();
}, legal);

const distDir = path.join(__dirname, "..", "dist");

// Landing page + SEO files ship with YOUR-DOMAIN placeholders (canonical /
// og:url / og:image tags, sitemap URLs, the robots Sitemap line). When the
// operator sets the site's public domain — admin panel → Deployment → Landing
// page / SEO domain, or BF_SITE_DOMAIN — the placeholders are swapped for the
// real domain at request time, so the live files always match the actual host
// without editing the sources.
const SEO_FILES = {
  "/landing.html": { file: "landing.html", type: "text/html; charset=utf-8" },
  "/robots.txt": { file: "robots.txt", type: "text/plain; charset=utf-8" },
  "/sitemap.xml": { file: "sitemap.xml", type: "application/xml; charset=utf-8" },
};
function readStaticText(file) {
  for (const dir of [distDir, path.join(__dirname, "..", "public")]) {
    try {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    } catch {
      /* fall through to the next candidate */
    }
  }
  return null;
}
// The configured public domain: the admin-panel setting wins, BF_SITE_DOMAIN
// is the env fallback. Empty means "keep the YOUR-DOMAIN placeholders".
async function configuredSiteDomain() {
  try {
    const stored = await db.storeGet("site.domain");
    if (stored) return sanitizeSiteDomain(stored);
  } catch {
    /* DB hiccup — fall back to env */
  }
  return sanitizeSiteDomain(process.env.BF_SITE_DOMAIN || "");
}
// The managed SEO/GEO head: the operator edits these in the admin panel
// (SEO & GEO tab); the public pages get the block injected at request time, so
// the live meta tags always match the settings.
async function seoHead(pagePath = "/") {
  const cfg = await seoConfig();
  const domain = await configuredSiteDomain();
  let siteName = "W flow";
  let tagline = "";
  try {
    siteName = (await db.storeGet("page.siteName")) || "W flow";
    tagline = (await db.storeGet("page.tagline")) || "";
  } catch {
    /* a DB hiccup must never break the public page */
  }
  return { cfg, domain, siteName, tagline, html: seoMetaTags(cfg, { domain, siteName, tagline, path: pagePath }) };
}

// Strip the tags we manage from a static page before injecting fresh ones, so a
// document never carries two <title> or two descriptions.
function applySeoHead(html, tags) {
  const cleaned = String(html)
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    // (the author meta is kept — seoMetaTags does not generate one)
    .replace(/<meta\s+name="(description|keywords|robots)"[\s\S]*?\/>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/i, "")
    .replace(/<meta\s+(property|name)="(og|twitter):[^"]*"[\s\S]*?\/>\s*/gi, "");
  return cleaned.replace(/<head>/i, `<head>\n    ${tags}`);
}

app.get(Object.keys(SEO_FILES), async (req, res) => {
  const spec = SEO_FILES[req.path];
  const text = readStaticText(spec.file);
  if (text === null) return res.status(404).end();
  const { cfg, domain, html } = await seoHead(req.path === "/landing.html" ? "/landing.html" : "/");
  if (req.path === "/robots.txt") {
    return res.type(spec.type).send(renderRobots(text, cfg, domain));
  }
  if (req.path === "/landing.html") {
    const withMeta = applySeoHead(text, html);
    return res.type(spec.type).send(domain ? withMeta.split("YOUR-DOMAIN").join(domain) : withMeta);
  }
  let body = domain ? text.split("YOUR-DOMAIN").join(domain) : text;
  // The legal pages are listed in the sitemap unless the admin removed them.
  if (req.path === "/sitemap.xml" && (await legalAndProHidden())) {
    body = body.replace(/\s*<url>\s*<loc>[^<]*\/(impressum|datenschutz)<\/loc>[\s\S]*?<\/url>/g, "");
  }
  // The guides (server/guides.js) are generated, so their entries are too.
  if (req.path === "/sitemap.xml") {
    const origin = `https://${domain || "YOUR-DOMAIN"}`;
    const entries = guideUrls()
      .map((u) => `  <url>\n    <loc>${origin}${u.path}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}\n    <changefreq>monthly</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`)
      .join("\n");
    body = body.replace("</urlset>", `${entries}\n</urlset>`);
  }
  res.type(spec.type).send(body);
});

// Guides — public how-to pages (/guides, /de/guides) for search engines and
// new visitors. Plain HTML from server/guides.js; the domain and switches are
// read per request so admin changes apply at once.
app.use(
  guidesRouter(async () => ({
    domain: await configuredSiteDomain(),
    legalHidden: await legalAndProHidden(),
    beta: (await db.storeGet("page.betaBanner")) !== "0",
  }))
);

// llms.txt — a markdown summary generative engines can read (GEO). Generated
// from the SEO & GEO settings; 404 when the operator switched it off.
async function llmsSummary() {
  const { cfg, domain, siteName, tagline } = await seoHead();
  const guides = guideSummaries("en");
  const text = renderLlmsTxt(cfg, {
    domain,
    siteName,
    tagline,
    guides,
    nodeCount: Object.keys(CATALOG.nodes).length,
    beta: (await db.storeGet("page.betaBanner")) !== "0",
  });
  return { cfg, domain, siteName, guides, text };
}

app.get("/llms.txt", async (_req, res) => {
  const { text } = await llmsSummary();
  if (!text) return res.status(404).type("text/plain").send("llms.txt is disabled on this site.\n");
  res.type("text/plain; charset=utf-8").send(text);
});

// The summary plus the complete text of every guide, for answer engines.
app.get("/llms-full.txt", async (_req, res) => {
  const { cfg, domain, siteName, guides, text } = await llmsSummary();
  const full = text ? renderLlmsFullTxt(cfg, { domain, siteName, guides, summaryDoc: text }) : "";
  if (!full) return res.status(404).type("text/plain").send("llms-full.txt is disabled on this site.\n");
  res.type("text/plain; charset=utf-8").send(full);
});

// ---- workflow reference for AI agents ----
// The same text the in-app builder reads (server/workflow-docs.js), so an
// outside agent (Claude Code, Cursor, …) writes workflows by the same rules.
// Both are generated from the catalog — cached per public base URL.
const agentDocCache = new Map();
function cachedAgentDoc(key, build) {
  if (!agentDocCache.has(key)) agentDocCache.set(key, build());
  return agentDocCache.get(key);
}

app.get("/docs/workflow-reference.md", async (req, res) => {
  const base = await oauthBaseUrl(req);
  res.type("text/markdown; charset=utf-8").send(cachedAgentDoc(`md|${base}`, () => buildReferenceMarkdown(base)));
});

app.get(WORKFLOW_SCHEMA_PATH, async (req, res) => {
  const base = await oauthBaseUrl(req);
  res.set("Access-Control-Allow-Origin", "*");
  res.type("application/schema+json; charset=utf-8").send(cachedAgentDoc(`schema|${base}`, () => JSON.stringify(buildWorkflowSchema(CATALOG.nodes, { baseUrl: base }))));
});

// IndexNow ownership file: /<key>.txt answers with the key itself.
app.get(/^\/([a-f0-9]{32})\.txt$/, async (req, res, next) => {
  try {
    const key = await indexNowKey();
    if (!key || req.params[0] !== key) return next();
    res.type("text/plain; charset=utf-8").send(key);
  } catch (err) {
    next(err);
  }
});

// After a deploy that changed the list of public pages, tell IndexNow
// engines (Bing & co.) about them instead of waiting for a crawl. Tied to the
// background scheduler so tests and DISABLE_SCHEDULER=1 installs stay quiet.
if (process.env.DISABLE_SCHEDULER !== "1" && process.env.BF_INDEXNOW !== "0") {
  setTimeout(async () => {
    try {
      const domain = await configuredSiteDomain();
      const cfg = await seoConfig();
      if (!domain || !cfg.indexable) return;
      const origin = `https://${domain}`;
      const paths = ["/", "/landing.html", ...guideUrls().map((u) => u.path)];
      if (!(await legalAndProHidden())) paths.push("/impressum", "/datenschutz");
      await submitIndexNow({ domain, urls: paths.map((p) => origin + p) });
    } catch (err) {
      console.log(`  [seo] IndexNow skipped: ${String(err?.message || err).slice(0, 120)}`);
    }
  }, 30_000).unref();
}

if (fs.existsSync(distDir)) {
  // The SPA shell (index.html) also carries the managed meta tags — the app is
  // the crawlable entry point once the operator points a domain at it.
  // The home page additionally gets a static copy of its hero and schema.org
  // data (server/seo.js) so search engines have real text to index.
  const spaShell = async (res, { home = false } = {}) => {
    const html = readStaticText("index.html");
    if (html === null) return res.status(404).end();
    const { cfg, domain, siteName, tagline, html: tags } = await seoHead();
    let page = applySeoHead(html, tags);
    if (home) {
      const description =
        cfg.description ||
        "W flow is a visual workflow builder: connect triggers, actions, logic and AI nodes and automate anything with your own API keys — in the cloud or on your own server.";
      page = page
        .replace(/<\/head>/i, `    ${structuredData({ domain, siteName, description })}\n  </head>`)
        .replace('<div id="root"></div>', `<div id="root">${crawlableIntro({ siteName, tagline, description })}</div>`);
    }
    // The shell names the hashed bundle of the current release, so it must be
    // revalidated on every load — a cached shell keeps an old bundle running
    // after a deploy. The bundles themselves are content-hashed and cache fine.
    res.set("Cache-Control", "no-cache");
    res.type("text/html; charset=utf-8").send(page);
  };
  app.get(["/", "/index.html"], (_req, res) => spaShell(res, { home: true }));
  app.use(express.static(distDir));
  app.get(/^\/(?!api|webhook).*/, (_req, res) => spaShell(res));
}

// Errors — malformed JSON bodies (express.json throws) and any uncaught route
// error must come back as JSON, never Express's default HTML error page (which
// can leak a stack trace in development and breaks API clients).
app.use((err, _req, res, _next) => {
  const status = Number(err?.status || err?.statusCode) || (err?.type === "entity.parse.failed" ? 400 : 500);
  if (status >= 500) console.error("[error]", err);
  if (res.headersSent) return;
  res.status(status).json({
    error: status >= 500 ? "Internal server error." : err?.expose ? String(err?.message || "Bad request.") : "Bad request.",
  });
});

app.listen(PORT, () => {
  console.log(`\n  W FLOW server running`);
  console.log(`  → API:        http://localhost:${PORT}/api`);
  console.log(`  → Webhooks:   http://localhost:${PORT}/webhook/:workflowId`);
  console.log(`  → Frontend:   ${fs.existsSync(distDir) ? `http://localhost:${PORT}` : "http://localhost:5173 (vite dev)"}\n`);
});
