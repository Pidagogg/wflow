// ============================================================================
// W FLOW — Admin server
// Runs on its OWN port (default 3002) and is meant to be started only from
// admin.bat. It is deliberately NOT mounted on the main app, so it cannot be
// reached from the main (self-hosted) website.
//
// Security posture:
//  - security headers (CSP, frame/sniffing/XSS protections)
//  - httpOnly + SameSite session cookie (HMAC-signed token, stored hashed)
//  - CSRF protection (double-submit cookie + header) on all state-changing calls
//  - rate limiting on the login endpoint (simple token bucket)
//  - all SQL is parameterised (SQLi-safe); sensitive values encrypted at rest
//  - passwords stored as scrypt hashes only
//  - optional IP allowlist (ADMIN_ALLOWED_IPS) so the panel is only reachable
//    from your own machine(s) even when the port is exposed on a public server
//
// Restricting who can reach the panel on a hosted server:
//  - ADMIN_ALLOWED_IPS="203.0.113.7,10.0.0.0/8" — 403 everything else.
//  - ADMIN_HOST=127.0.0.1 — listen on loopback only; reach it via an SSH
//    tunnel (`ssh -L 3002:localhost:3002 user@server`). Strongest option.
//  - Or point a subdomain (admin.example.com) at this port and either keep
//    ADMIN_ALLOWED_IPS set or protect it with Cloudflare Access / Caddy auth.
//    Set TRUST_PROXY=1 in that case so req.ip sees the real client IP.
// ============================================================================
//
// Database: SQLite by default, PostgreSQL when DATABASE_URL is set (see
// server/dbx.js). Call sites `await` every db call so both backends work.
// ============================================================================
import "./env.js"; // load .env before ADMIN_PORT / DATABASE_URL are read
import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db, usingPostgres, databaseEngine, sanitizeSiteDomain } from "./dbx.js";
import { OAUTH_PROVIDERS as CONNECT_PROVIDERS } from "../shared/oauth.js";
import { clientSettingKeys } from "./oauth-connections.js";
import { verifyPassword, hashPassword } from "./security.js";
import { normalizeProjectUrl, parseProviders } from "./supabase-auth.js";
import {
  workflowStorageMode,
  setWorkflowStorageMode,
  countLocalWorkflows,
  countDbWorkflows,
} from "./store.js";
import { saveStripeConfig, publicStripeConfig, saveCryptoConfig, publicCryptoConfig } from "./billing.js";
import { seoConfig, saveSeoConfig } from "./seo.js";
import { removeAccountFolder } from "./disk.js";
import { listTeams, teamActive, decideTeam, markTeamPaid, endTeam, teamRequestsEmail } from "./teams.js";
import { sendMail, mailConfigured } from "./mail.js";
import {
  runBackup,
  listBackups,
  deleteBackup,
  restoreBackup,
  getBackupSettings,
  saveBackupSettings,
  BACKUP_DIR,
} from "./backup.js";
import {
  getAlertSettings,
  saveAlertSettings,
  raiseAlert,
  runHealthCheck,
  startHealthMonitor,
  stopHealthMonitor,
} from "./alerts.js";
import { SOURCE as JOURNAL_SOURCE, journalEnabled, journalStats } from "./journal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3002);
// Loopback is the secure default. Docker Compose overrides the bind address
// inside the container while publishing the host port on 127.0.0.1.
const ADMIN_HOST = process.env.ADMIN_HOST || "127.0.0.1";
const ENV_FILE = path.join(__dirname, "..", ".env");
const app = express();

// Behind Cloudflare / Nginx / Caddy / a subdomain proxy the real client IP
// arrives via X-Forwarded-For; TRUST_PROXY=1 lets Express use it (needed for
// the ADMIN_ALLOWED_IPS check and login rate limiting to see real IPs).
if (process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

// ----------------------------------------------------------------------------
// IP allowlist — "only I can reach the admin panel".
// ADMIN_ALLOWED_IPS is a comma-separated list of IPs and/or CIDR subnets
// (e.g. "203.0.113.7", "2001:db8::/32", "127.0.0.1,10.0.0.0/8"). When set, any
// request from an address outside the list is rejected with 403 before it can
// even hit the login page. IPv4-mapped IPv6 addresses (::ffff:1.2.3.4) are
// normalised so the check works behind proxies that hand those out.
// ----------------------------------------------------------------------------
const ALLOWED_IPS = (process.env.ADMIN_ALLOWED_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function buildAllowList(entries) {
  const bl = new net.BlockList();
  for (const entry of entries) {
    const m = entry.match(/^(.+?)\/(\d{1,3})$/);
    if (m) {
      try {
        bl.addSubnet(m[1], Number(m[2]));
      } catch {
        throw new Error(`ADMIN_ALLOWED_IPS: invalid subnet "${entry}"`);
      }
    } else {
      try {
        bl.addAddress(entry);
      } catch {
        throw new Error(`ADMIN_ALLOWED_IPS: invalid address "${entry}"`);
      }
    }
  }
  return bl;
}

const allowList = ALLOWED_IPS.length ? buildAllowList(ALLOWED_IPS) : null;

function normalizeIp(ip) {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function ipAllowed(req) {
  if (!allowList) return true; // no restriction configured — local use
  const ip = normalizeIp(req.ip || req.socket?.remoteAddress || "");
  return allowList.check(ip);
}

app.use((req, res, next) => {
  if (!ipAllowed(req)) {
    return res.status(403).json({ error: "Forbidden." });
  }
  next();
});

// ----------------------------------------------------------------------------
// .env helpers — the admin panel edits the deployment .env file directly, so
// the app's own env (PORT, DATABASE_URL, TRUST_PROXY, BF_ENCRYPTION_KEY) is
// configured from the same place the process reads it. Existing lines and
// comments are preserved; only the requested keys are written. A restart is
// required afterwards for the main server to pick the new values up.
// ----------------------------------------------------------------------------
function readEnvFile() {
  try {
    return fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    return "";
  }
}

function envValue(key) {
  const m = readEnvFile().match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "m"));
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

function writeEnvValues(updates) {
  const lines = readEnvFile().split("\n");
  const present = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      present.add(m[1]);
      lines[i] = `${m[1]}=${updates[m[1]]}`;
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!present.has(k)) lines.push(`${k}=${v}`);
  }
  const result = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, result, { mode: 0o600 });
  return result;
}

function deleteEnvValues(keys) {
  const lines = readEnvFile().split("\n").filter((l) => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !(m && keys.includes(m[1]));
  });
  const result = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, result, { mode: 0o600 });
  return result;
}

function maskUrl(url) {
  if (!url) return "";
  return String(url).replace(/\/\/[^:@/]+:[^@/]+@/, "//***:***@");
}

const COMPOSE_FILE = path.join(__dirname, "..", "docker-compose.yml");

function readComposeFile() {
  try {
    return fs.readFileSync(COMPOSE_FILE, "utf8");
  } catch {
    return "";
  }
}

// ----------------------------------------------------------------------------
// PostgreSQL service toggle for docker-compose.yml.
//
// The bundled compose file ships the `postgres` service (and the
// wflow `depends_on` block) COMMENTED OUT. Enabling uncomments exactly
// those known template markers and writes the matching DATABASE_URL into .env;
// disabling comments them back and removes DATABASE_URL. If the markers are
// missing (customised compose file) the function refuses and tells the operator
// to configure it by hand — it never guesses.
// ----------------------------------------------------------------------------
// Uncomment a line by removing the leading '# ' (keeping its indentation).
function uncommentLine(line) {
  return line.replace(/^(\s*)#\s*/, "$1");
}
// Comment a line by inserting '# ' after its indentation.
function commentLine(line) {
  return line.replace(/^(\s*)/, "$1# ");
}

// Match a (possibly commented) line whose content after '# ' equals `want`,
// e.g. "postgres:", "depends_on:", "- postgres".
export function togglePostgresInCompose(text, { enable, password }) {
  const lines = String(text || "").split("\n");
  const contentOf = (l) => l.replace(/^\s*#\s*/, "").trim();
  const enabled = lines.some((l) => l.trim() === "postgres:");
  if (enable && enabled) return { text, changed: false, already: true };
  if (!enable && !enabled) return { text, changed: false, already: true };

  const findLine = (want, from = 0) => {
    for (let i = from; i < lines.length; i++) {
      if (contentOf(lines[i]) === want || (want === "postgres:" && contentOf(lines[i]).startsWith("postgres:"))) return i;
    }
    return -1;
  };
  // The `depends_on:` block that wires the app to the bundled postgres service
  // is identified by its PAIR — the line after it is the `- postgres` entry (in
  // either comment form). Searching for the pair instead of the first
  // `depends_on:` in the file keeps this correct when another service in the
  // compose file has a depends_on of its own (e.g. the optional caddy proxy).
  const findPostgresDependsOn = () => {
    for (let i = 0; i < lines.length - 1; i++) {
      if (contentOf(lines[i]) === "depends_on:" && contentOf(lines[i + 1]) === "- postgres") return i;
    }
    return -1;
  };

  if (enable) {
    // uncomment the depends_on block (the two known lines, in either comment form)
    const dIdx = findPostgresDependsOn();
    if (dIdx < 0) {
      return { text, changed: false, error: "docker-compose.yml does not have the expected commented 'depends_on:' block — enable the postgres service manually." };
    }
    lines[dIdx] = uncommentLine(lines[dIdx]);
    lines[dIdx + 1] = uncommentLine(lines[dIdx + 1]);
    // uncomment the whole postgres service block
    const pIdx = findLine("postgres:");
    if (pIdx < 0) {
      return { text, changed: false, error: "docker-compose.yml does not contain the commented 'postgres:' service — add it manually (see the setup guide)." };
    }
    let end = pIdx;
    while (end + 1 < lines.length && /^\s*#/.test(lines[end + 1])) end++;
    for (let i = pIdx; i <= end; i++) lines[i] = uncommentLine(lines[i]);
    // apply a requested password to the block
    if (password) {
      const pwIdx = lines.slice(pIdx, end + 1).findIndex((l) => /POSTGRES_PASSWORD:/.test(l));
      if (pwIdx >= 0) lines[pIdx + pwIdx] = lines[pIdx + pwIdx].replace(/POSTGRES_PASSWORD:.*/, `POSTGRES_PASSWORD: ${password}`);
    }
    return { text: lines.join("\n"), changed: true };
  }

  // disable: comment the depends_on block and the postgres service back
  const depIdx = findPostgresDependsOn();
  if (depIdx >= 0) {
    lines[depIdx] = commentLine(lines[depIdx]);
    lines[depIdx + 1] = commentLine(lines[depIdx + 1]);
  }
  const pIdx = findLine("postgres:");
  if (pIdx >= 0) {
    let end = pIdx;
    // the block ends at a blank line, a zero-indent line, or the next service
    while (end + 1 < lines.length && /^\s+/.test(lines[end + 1]) && lines[end + 1].trim() !== "" && !/^ {2}[A-Za-z0-9_-]+:$/.test(lines[end + 1])) {
      end++;
    }
    for (let i = pIdx; i <= end; i++) {
      if (/^\s*#/.test(lines[i])) continue; // already commented
      lines[i] = commentLine(lines[i]);
    }
  }
  return { text: lines.join("\n"), changed: true };
}

function composePostgresEnabled() {
  const text = readComposeFile();
  if (!text) return false;
  return text.split("\n").some((l) => l.replace(/^\s+/, "") === "postgres:");
}


// ----------------------------------------------------------------------------
// constants & helpers
// ----------------------------------------------------------------------------
const CSRF_KEY = process.env.BF_ADMIN_CSRF_SECRET || (() => (crypto.randomBytes(32).toString("hex")))();
const COOKIE = "bf_admin";
const CSRF_COOKIE = "bf_csrf";

app.use(express.json({ limit: "2mb" }));

// ----------------------------------------------------------------------------
// security headers
// ----------------------------------------------------------------------------
app.use((_req, res, next) => {
  // Never let the browser (or any intermediary) cache the admin HTML or responses.
  // Otherwise an edited admin.html can linger as a stale cached copy and the user
  // keeps hitting old JS long after a fix is deployed.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Admin UI is a single inlined page with no external scripts.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});

// ----------------------------------------------------------------------------
// CSRF — double submit cookie
// ----------------------------------------------------------------------------
// The token travels as a non-HttpOnly SameSite=Strict cookie; the page JS reads
// it and echoes it back as the X-CSRF-Token header. We mint the token ONCE per
// browser session and keep it stable so the cookie and the echoed header never
// desync. Rotating on every response caused duplicate bf_csrf cookies to pile
// up and the server to read an older value than the one the page echoed.
//
// We accept the header if it matches ANY bf_csrf cookie value in the request
// (not an order-dependent "last cookie wins"), because while one cookie is being
// replaced a browser can transiently send two same-name cookies in any order.
function csrfTokenFrom(req) {
  const raw = req.headers.cookie || "";
  const values = [];
  for (const pair of raw.split(";").map((s) => s.trim())) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    if (pair.slice(0, eq).trim() === CSRF_COOKIE) {
      try {
        values.push(decodeURIComponent(pair.slice(eq + 1)));
      } catch {
        /* ignore malformed cookie */
      }
    }
  }
  return values;
}

function csrfOk(req) {
  const header = req.headers["x-csrf-token"];
  if (!header) return false;
  return csrfTokenFrom(req).includes(header);
}
function issueCsrfCookie(req, res) {
  // Reuse the browser's existing token when it has one (stable across requests)
  // so the response header always matches the cookie we validate next time.
  // Only mint a fresh token when the request carried none (first page load).
  const existing = req ? csrfTokenFrom(req)[0] : undefined;
  const token = existing || crypto.randomBytes(24).toString("hex");
  // NOT HttpOnly: the double-submit pattern needs the page JS to READ the token
  // from document.cookie and echo it back as the X-CSRF-Token header. SameSite=Strict
  // still blocks cross-site CSRF even without HttpOnly. Also expose the token via
  // a response header as the authoritative source for the page JS.
  res.append("Set-Cookie", `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; Max-Age=86400`);
  res.setHeader("X-CSRF-Token", token);
  return token;
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

function requireCsrf(req, res, next) {
  if (!csrfOk(req)) return res.status(403).json({ error: "Invalid or missing CSRF token." });
  next();
}

// ----------------------------------------------------------------------------
// sessions
// ----------------------------------------------------------------------------
async function authUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  return db.getUserForSession(token);
}

async function requireAuth(req, res, next) {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated. Please log in." });
  req.user = user;
  next();
}

// ----------------------------------------------------------------------------
// login rate limiting (in-memory token bucket)
// ----------------------------------------------------------------------------
const attempts = new Map();
function loginLimited(ip, username) {
  const key = `${ip}|${String(username || "").toLowerCase()}`;
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, windowStart: now };
  if (now - rec.windowStart > 60_000) {
    rec.count = 0;
    rec.windowStart = now;
  }
  rec.count++;
  attempts.set(key, rec);
  // also count per-IP aggregate
  const ipKey = `ip:${ip}`;
  const ipRec = attempts.get(ipKey) || { count: 0, windowStart: now };
  if (now - ipRec.windowStart > 60_000) {
    ipRec.count = 0;
    ipRec.windowStart = now;
  }
  ipRec.count++;
  attempts.set(ipKey, ipRec);
  return { keyRec: rec, ipRec, limited: rec.count > 5 || ipRec.count > 20 };
}

// ----------------------------------------------------------------------------
// boot: seed the default admin if none exists
// ----------------------------------------------------------------------------
// The code is public, so there is no built-in password: BF_ADMIN_USERNAME /
// BF_ADMIN_PASSWORD from .env, or else "admin" with a random password that is
// printed once, when the account is created. Change it in the panel's Account
// tab after the first login.
const DEFAULT_ADMIN = {
  username: process.env.BF_ADMIN_USERNAME || "admin",
  password: process.env.BF_ADMIN_PASSWORD || crypto.randomBytes(15).toString("base64url"),
};

function warnAboutDefaultAdmin() {
  if (!process.env.BF_ADMIN_USERNAME || !process.env.BF_ADMIN_PASSWORD) {
    console.log("");
    console.log("  ⚠ [admin] no BF_ADMIN_USERNAME / BF_ADMIN_PASSWORD in .env — created the first admin:");
    console.log(`      username: ${DEFAULT_ADMIN.username}`);
    console.log(`      password: ${DEFAULT_ADMIN.password}`);
    console.log("    This password is shown only now. Change it in the admin panel → Account tab.");
    console.log("");
  }
}

function seedIfNeeded() {
  if (usingPostgres) {
    // PostgreSQL is async — fire the seed and log the result. (SQLite seeding
    // below stays synchronous so the test suite can log in immediately.)
    db.listAdmins()
      .then((admins) => {
        if (!admins.length) return db.seedAdmin(DEFAULT_ADMIN);
        return false;
      })
      .then((created) => {
        if (created) {
          console.log("  [admin] seeded admin account.");
          warnAboutDefaultAdmin();
        }
      })
      .catch((err) => console.error("  [admin] seed failed:", err.message));
    return;
  }
  if (!db.listAdmins().length) {
    db.seedAdmin(DEFAULT_ADMIN);
    console.log("  [admin] seeded admin account.");
    warnAboutDefaultAdmin();
  }
}

// ----------------------------------------------------------------------------
// auth endpoints
// ----------------------------------------------------------------------------
app.get("/api/admin/me", async (_req, res) => {
  const user = await authUser(_req);
  // Issue/echo the stable CSRF cookie + X-CSRF-Token here (the page calls this
  // on load, before the user can log in). That makes the response header the
  // single authoritative source for the client token, so the login POST can
  // never carry a stale/duplicate value that desyncs from the server cookie.
  issueCsrfCookie(_req, res);
  res.json(user ? { authed: true, username: user.username } : { authed: false });
});

app.post("/api/admin/login", requireCsrf, async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const lim = loginLimited(ip, username);
  if (lim.limited) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }
  const user = await db.getUserByUsername(username);
  const ok = user && verifyPassword(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid username or password." });
  }
  const session = await db.createSession(user.id);
  res.append("Set-Cookie", `${COOKIE}=${session.raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(12 * 3600)}`);
  issueCsrfCookie(req, res);
  res.json({ authed: true, username: user.username });
});

app.post("/api/admin/logout", async (_req, res) => {
  const token = _req.cookies?.[COOKIE];
  if (token) await db.destroySession(token);
  res.setHeader("Set-Cookie", [
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  ]);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// protected management endpoints
// ----------------------------------------------------------------------------
function guards() {
  return [requireAuth, requireCsrf];
}

// --- deployment (VPS / Cloudflare / PostgreSQL) -----------------------------
// Current deployment state — what the app would read from .env on next start,
// plus whether the bundled PostgreSQL service is enabled in docker-compose.yml.
app.get("/api/admin/deploy", requireAuth, async (_req, res) => {
  const raw = envValue("DATABASE_URL") || "";
  res.json({
    engine: databaseEngine,
    databaseUrlSet: !!raw,
    databaseUrlMasked: maskUrl(raw),
    port: envValue("PORT") || process.env.PORT || "3001",
    trustProxy: envValue("TRUST_PROXY") === "1" || process.env.TRUST_PROXY === "1",
    encryptionKeySet: !!envValue("BF_ENCRYPTION_KEY") || !!process.env.BF_ENCRYPTION_KEY,
    envFileExists: fs.existsSync(ENV_FILE),
    adminPort: process.env.ADMIN_PORT || "3002",
    composeFileExists: fs.existsSync(COMPOSE_FILE),
    postgresServiceEnabled: composePostgresEnabled(),
    cloudflareDomain: (await db.storeGet("deploy.domain")) || "",
    awsHost: (await db.storeGet("deploy.awsHost")) || "",
    siteDomain: (await db.storeGet("site.domain")) || "",
  });
});

// Toggle the bundled PostgreSQL service in docker-compose.yml and keep .env in
// sync: enabling uncomments the service + depends_on and sets DATABASE_URL;
// disabling comments them back and removes DATABASE_URL (back to SQLite). A
// restart of the app is required afterwards either way.
app.post("/api/admin/deploy/postgres", guards(), async (req, res) => {
  const enable = !!req.body?.enable;
  const password = String(req.body?.password || "").trim();
  const text = readComposeFile();
  if (!text) {
    return res.status(400).json({ error: "docker-compose.yml not found next to the admin server." });
  }
  if (enable && password && !/^[A-Za-z0-9._-]{4,64}$/.test(password)) {
    return res.status(400).json({ error: "Password must be 4-64 characters of letters, digits, . _ -" });
  }
  const result = togglePostgresInCompose(text, { enable, password });
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.changed) {
    fs.writeFileSync(COMPOSE_FILE, result.text, { mode: 0o644 });
  }
  if (enable) {
    const usePw = password || "change-me";
    writeEnvValues({
      DATABASE_URL: `postgres://wflow:${encodeURIComponent(usePw)}@postgres:5432/wflow`,
    });
  } else {
    deleteEnvValues(["DATABASE_URL"]);
  }
  res.json({
    ok: true,
    enabled: enable,
    changed: result.changed,
    restartRequired: true,
    message: enable
      ? "PostgreSQL service enabled in docker-compose.yml and DATABASE_URL written to .env — run 'docker compose up -d' then 'docker compose restart'."
      : "PostgreSQL service disabled in docker-compose.yml and DATABASE_URL removed — the app will use SQLite again after 'docker compose restart'.",
  });
});

// The public domain this install advertises on its landing page and SEO files.
// The main server swaps it into the YOUR-DOMAIN placeholders of /landing.html,
// robots.txt and sitemap.xml at request time. Kept separate from the
// Cloudflare tunnel domain below: the marketing page can live on a different
// host, and this field has an explicit Save button instead of blur-save.
app.post("/api/admin/deploy/site-domain", guards(), async (req, res) => {
  const raw = String(req.body?.domain || "").trim();
  const domain = sanitizeSiteDomain(raw);
  if (raw && !domain) {
    return res.status(400).json({
      error: "That doesn't look like a domain — use e.g. flow.example.com (no https://, ports or paths).",
    });
  }
  await db.storeSet("site.domain", domain);
  res.json({ ok: true, domain });
});

// Remember the Cloudflare domain the operator is wiring up, so the panel can
// regenerate the exact tunnel / DNS commands on reload.
app.post("/api/admin/deploy/domain", guards(), async (req, res) => {
  const domain = String(req.body?.domain || "").trim().toLowerCase();
  await db.storeSet("deploy.domain", cleanString(domain, 253));
  res.json({ ok: true, domain });
});

// Remember the EC2 public IP / hostname the operator is deploying to, so the
// AWS command generator on this tab can rebuild its commands on reload.
app.post("/api/admin/deploy/aws-host", guards(), async (req, res) => {
  const host = String(req.body?.host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  await db.storeSet("deploy.awsHost", cleanString(host, 253));
  res.json({ ok: true, host });
});

// Write the deployment settings into .env (preserving everything else). Empty
// fields mean "keep the current value". The main server reads these at boot, so
// the panel tells the operator to restart after saving.
app.post("/api/admin/deploy/save", guards(), (req, res) => {
  const { databaseUrl, port, trustProxy, encryptionKey } = req.body || {};
  const updates = {};
  const dbUrl = String(databaseUrl || "").trim();
  if (dbUrl) {
    if (!/^postgres(ql)?:\/\//i.test(dbUrl)) {
      return res.status(400).json({ error: "DATABASE_URL must start with postgres://" });
    }
    updates.DATABASE_URL = dbUrl;
  }
  const p = String(port || "").replace(/\D/g, "").slice(0, 5);
  if (p && Number(p) > 0 && Number(p) < 65536) updates.PORT = p;
  // Only touch TRUST_PROXY when the form actually sent it — the PostgreSQL tab
  // saves just the database URL and must not silently switch the proxy off.
  if (trustProxy !== undefined && trustProxy !== null) updates.TRUST_PROXY = trustProxy ? "1" : "0";
  const key = String(encryptionKey || "").trim();
  if (key) updates.BF_ENCRYPTION_KEY = key;
  writeEnvValues(updates);
  res.json({
    ok: true,
    engine: updates.DATABASE_URL ? "postgres" : databaseEngine,
    restartRequired: true,
    message: "Saved to .env — restart the app (docker compose restart) for it to take effect.",
  });
});

// Try to connect to a PostgreSQL connection string (independent of .env — used
// to validate a URL before saving it).
app.post("/api/admin/deploy/test-db", guards(), async (req, res) => {
  const url = String(req.body?.databaseUrl || "").trim();
  if (!url) return res.json({ ok: false, detail: "Enter a PostgreSQL connection string first (postgres://…)." });
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return res.json({ ok: false, detail: "Only PostgreSQL URLs are supported (postgres://user:pass@host:port/db)." });
  }
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
    await client.connect();
    const r = await client.query("SELECT current_database() AS db, version() AS v");
    await client.end().catch(() => {});
    res.json({ ok: true, detail: `Connected to ${r.rows[0].db} — ${String(r.rows[0].v).slice(0, 60)}…` });
  } catch (err) {
    res.json({ ok: false, detail: `Could not connect: ${String(err.message || err).slice(0, 220)}` });
  }
});

// --- page setup ------------------------------------------------------------
app.get("/api/admin/settings", requireAuth, async (_req, res) => {
  res.json({
    siteName: (await db.storeGet("page.siteName")) || "W flow",
    siteTagline: (await db.storeGet("page.tagline")) || "",
    authBanner: (await db.storeGet("page.banner")) || "",
    // When on, the Pro/subscription page and every legal page (Datenschutz,
    // Impressum) are removed from the website entirely.
    hideLegalAndPro: (await db.storeGet("page.hideLegalAndPro")) === "1",
    // The "beta test" banner on the welcome page and the note in the
    // workspace — on until switched off.
    betaBanner: (await db.storeGet("page.betaBanner")) !== "0",
    // The URL prefix the workspace (cloud version) lives under — /cloud by default.
    cloudPath: (await db.storeGet("site.cloudPath")) || "cloud",
  });
});

app.post("/api/admin/settings", guards(), async (req, res) => {
  const { siteName, siteTagline, authBanner, hideLegalAndPro, betaBanner, cloudPath } = req.body || {};
  // Validate first, so a bad workspace path does not leave a half-saved form.
  // The workspace path is a single URL segment: no slashes, no leading dot.
  const rawPath = String(cloudPath ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (rawPath && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(rawPath)) {
    return res.status(400).json({
      error: "Workspace path must start with a letter or digit and contain only letters, digits, - and _ (no slashes).",
    });
  }
  await db.storeSet("page.siteName", cleanString(siteName, 80) || "W flow");
  await db.storeSet("page.tagline", cleanString(siteTagline, 160));
  await db.storeSet("page.banner", cleanString(authBanner, 240));
  await db.storeSet("page.hideLegalAndPro", hideLegalAndPro ? "1" : "0");
  // older admin pages do not send it — leave the stored value alone then
  if (betaBanner !== undefined) await db.storeSet("page.betaBanner", betaBanner ? "1" : "0");
  await db.storeSet("site.cloudPath", rawPath || "cloud");
  res.json({ ok: true, cloudPath: rawPath || "cloud" });
});

// --- auth & e-mail ---------------------------------------------------------
// SMTP settings power the password-reset / e-mail-verification mail. OAuth
// client credentials (Google / GitHub) are editable here too and stored in the
// shared DB with the secret encrypted at rest; the GOOGLE_* / GITHUB_* env vars
// act as fallbacks. Both are read per request by the main server, so a change
// takes effect without a restart.
const OAUTH_FIELDS = {
  google: { clientId: "oauth.google.clientId", clientSecret: "oauth.google.clientSecret", idEnv: "GOOGLE_CLIENT_ID", secretEnv: "GOOGLE_CLIENT_SECRET" },
  github: { clientId: "oauth.github.clientId", clientSecret: "oauth.github.clientSecret", idEnv: "GITHUB_CLIENT_ID", secretEnv: "GITHUB_CLIENT_SECRET" },
  // Every other connected-account service (Microsoft, GitLab, Slack, …) —
  // not login buttons: only the "Connect <service>" picker on the nodes uses
  // them (server/oauth-connections.js). Same key pattern as above.
  ...Object.fromEntries(
    Object.keys(CONNECT_PROVIDERS)
      .filter((id) => id !== "google" && id !== "github")
      .map((id) => {
        const k = clientSettingKeys(id);
        return [id, { clientId: k.idKey, clientSecret: k.secretKey, idEnv: k.idEnv, secretEnv: k.secretEnv }];
      })
  ),
};

/** Every connected-account service with its setup notes and current state. */
async function connectionAdminState() {
  const out = [];
  for (const [id, p] of Object.entries(CONNECT_PROVIDERS)) {
    out.push({ id, label: p.label, console: p.console, setup: p.setup, ...(await oauthAdminState(id)) });
  }
  return out;
}

// Optional Supabase login (see server/supabase-auth.js). Supabase proves the
// e-mail address; accounts stay in the local database, exactly as with the
// Google / GitHub buttons above.

/** Wording for an API path that was removed from a pasted project URL. */
function projectUrlNote(url, stripped) {
  if (!stripped) return "";
  return `The pasted URL ended in ${stripped} — that is the Data API path, not the project URL, so requests were going to the wrong place (Supabase answers "No API key found in request"). Using ${url}.`;
}

/** The stored project URL (normalised) and anon key, env vars as fallback. */
async function supabaseStoredConfig() {
  const [storedUrl, storedKey] = await Promise.all([
    db.storeGet("oauth.supabase.url"),
    db.storeGet("oauth.supabase.anonKey"),
  ]);
  const norm = normalizeProjectUrl(String(storedUrl || process.env.SUPABASE_URL || ""));
  return {
    url: norm.url,
    urlNote: norm.error ? norm.error : projectUrlNote(norm.url, norm.stripped),
    anonKey: String(storedKey || process.env.SUPABASE_ANON_KEY || "").trim(),
  };
}

async function supabaseAdminState() {
  const storedKey = await db.storeGet("oauth.supabase.anonKey");
  const stored = await supabaseStoredConfig();
  const hasAnonKey = !!storedKey || !!process.env.SUPABASE_ANON_KEY;
  const magicRaw = (await db.storeGet("oauth.supabase.magicLink")) || process.env.SUPABASE_MAGIC_LINK || "";
  return {
    url: stored.url,
    // set when the value we are using is not literally what was pasted
    urlNote: stored.urlNote,
    anonKeyMasked: mask(storedKey),
    hasAnonKey,
    configured: !!stored.url && hasAnonKey,
    providers: String((await db.storeGet("oauth.supabase.providers")) || process.env.SUPABASE_PROVIDERS || ""),
    // on unless explicitly switched off — the login card hides the form when off
    magicLink: magicRaw ? !/^(0|false|no|off)$/i.test(magicRaw) : true,
  };
}

// The site-wide Telegram app personal-account logins go through (see
// appCredentials in server/telegram-accounts.js — not imported here so the
// admin process does not load the MTProto client). With it set, users connect
// their Telegram account with only a phone number.
const TG_APP = { apiId: "telegram.apiId", apiHash: "telegram.apiHash" };

async function telegramAppAdminState() {
  const storedHash = await db.storeGet(TG_APP.apiHash);
  const apiId = (await db.storeGet(TG_APP.apiId)) || process.env.TELEGRAM_API_ID || "";
  const hasHash = !!storedHash || !!process.env.TELEGRAM_API_HASH;
  return { apiId, hashMasked: mask(storedHash), hasHash, configured: !!apiId && hasHash };
}

async function oauthAdminState(provider) {
  const f = OAUTH_FIELDS[provider];
  const storedSecret = await db.storeGet(f.clientSecret);
  const clientId = (await db.storeGet(f.clientId)) || process.env[f.idEnv] || "";
  const hasSecret = !!storedSecret || !!process.env[f.secretEnv];
  return {
    clientId,
    secretMasked: mask(storedSecret),
    hasSecret,
    configured: !!clientId && hasSecret,
  };
}

app.get("/api/admin/authsettings", requireAuth, async (_req, res) => {
  res.json({
    smtpHost: (await db.storeGet("mail.host")) || process.env.SMTP_HOST || "",
    smtpPort: (await db.storeGet("mail.port")) || process.env.SMTP_PORT || "587",
    smtpSecure: ((await db.storeGet("mail.secure")) || process.env.SMTP_SECURE || "") === "1",
    smtpUser: (await db.storeGet("mail.user")) || process.env.SMTP_USER || "",
    smtpPassMasked: mask(await db.storeGet("mail.pass")),
    hasSmtpPass: !!(await db.storeGet("mail.pass")),
    mailFrom: (await db.storeGet("mail.from")) || process.env.MAIL_FROM || "",
    // where the Settings → Contact form sends its messages; empty falls back to
    // the address inside MAIL_FROM
    contactEmail: (await db.storeGet("mail.contactEmail")) || process.env.CONTACT_EMAIL || "",
    oauth: {
      google: await oauthAdminState("google"),
      github: await oauthAdminState("github"),
      microsoft: await oauthAdminState("microsoft"),
    },
    connectionProviders: await connectionAdminState(),
    microsoftTenant: (await db.storeGet("oauth.microsoft.tenant")) || process.env.MICROSOFT_TENANT || "",
    supabase: await supabaseAdminState(),
    telegram: await telegramAppAdminState(),
    publicUrl: (await db.storeGet("auth.publicUrl")) || process.env.BF_PUBLIC_URL || "",
  });
});

app.post("/api/admin/authsettings", guards(), async (req, res) => {
  const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, mailFrom, contactEmail, publicUrl, oauth, supabase, microsoftTenant, telegram } = req.body || {};
  await db.storeSet("mail.host", cleanString(smtpHost, 200));
  await db.storeSet("mail.port", cleanString(smtpPort, 10) || "587");
  await db.storeSet("mail.secure", smtpSecure ? "1" : "0");
  await db.storeSet("mail.user", cleanString(smtpUser, 200));
  if (smtpPass && smtpPass !== mask(await db.storeGet("mail.pass"))) {
    await db.storeSet("mail.pass", smtpPass, { encrypted: true });
  }
  await db.storeSet("mail.from", cleanString(mailFrom, 200));
  await db.storeSet("mail.contactEmail", cleanString(contactEmail, 200));

  // Public URL — the external origin used for reset/verify links and OAuth
  // redirect URIs. An empty value clears it (falls back to BF_PUBLIC_URL / the
  // request host).
  const origin = cleanString(publicUrl, 300).trim().replace(/\/+$/, "");
  if (origin && !/^https?:\/\//i.test(origin)) {
    return res.status(400).json({ error: "Public URL must start with http:// or https://" });
  }
  await db.storeSet("auth.publicUrl", origin);

  // OAuth client credentials. A blank secret keeps the stored one; the masked
  // placeholder is never written back over the real value.
  for (const provider of Object.keys(OAUTH_FIELDS)) {
    const f = OAUTH_FIELDS[provider];
    const incoming = oauth && typeof oauth === "object" ? oauth[provider] || {} : {};
    if (incoming.clientId !== undefined) {
      await db.storeSet(f.clientId, cleanString(incoming.clientId, 300).trim());
    }
    const secret = String(incoming.clientSecret || "");
    if (secret && secret !== mask(await db.storeGet(f.clientSecret))) {
      await db.storeSet(f.clientSecret, secret, { encrypted: true });
    }
  }
  if (microsoftTenant !== undefined) {
    const tenant = cleanString(microsoftTenant, 100).trim();
    if (tenant && !/^[A-Za-z0-9.-]+$/.test(tenant)) return res.status(400).json({ error: "Microsoft tenant must be a tenant id, a domain or \"common\"." });
    await db.storeSet("oauth.microsoft.tenant", tenant);
  }
  // Telegram app (my.telegram.org). Validated before anything of it is stored;
  // a blank hash keeps the stored one, an empty API ID switches it off.
  if (telegram && typeof telegram === "object") {
    const apiId = cleanString(telegram.apiId, 20).trim();
    const apiHash = String(telegram.apiHash || "").trim();
    if (apiId && !/^\d{3,12}$/.test(apiId)) return res.status(400).json({ error: "The Telegram API ID is a number (App api_id on my.telegram.org)." });
    const newHash = apiHash && apiHash !== mask(await db.storeGet(TG_APP.apiHash));
    if (newHash && !/^[a-f0-9]{32}$/i.test(apiHash)) return res.status(400).json({ error: "The Telegram API hash is the 32-character App api_hash on my.telegram.org." });
    await db.storeSet(TG_APP.apiId, apiId);
    if (newHash) await db.storeSet(TG_APP.apiHash, apiHash, { encrypted: true });
  }
  // Supabase login. The project URL and anon key are stored like the other
  // provider credentials (the key encrypted at rest); a blank key keeps the
  // stored one. An empty URL switches the feature off again. The URL is
  // reduced to the bare project origin: the dashboard puts the Data API URL
  // (…/rest/v1) right next to it, and pasting that one is the mistake behind
  // "No API key found in request".
  let supabaseNote = "";
  if (supabase && typeof supabase === "object") {
    const asked = normalizeProjectUrl(cleanString(supabase.url, 300));
    if (asked.error) return res.status(400).json({ error: asked.error });
    supabaseNote = projectUrlNote(asked.url, asked.stripped);
    await db.storeSet("oauth.supabase.url", asked.url);
    const anonKey = String(supabase.anonKey || "");
    if (anonKey && anonKey !== mask(await db.storeGet("oauth.supabase.anonKey"))) {
      await db.storeSet("oauth.supabase.anonKey", anonKey, { encrypted: true });
    }
    if (supabase.providers !== undefined) {
      await db.storeSet("oauth.supabase.providers", cleanString(supabase.providers, 300).trim());
    }
    await db.storeSet("oauth.supabase.magicLink", supabase.magicLink ? "1" : "0");
  }
  res.json({
    ok: true,
    oauth: { google: await oauthAdminState("google"), github: await oauthAdminState("github"), microsoft: await oauthAdminState("microsoft") },
    connectionProviders: await connectionAdminState(),
    supabase: await supabaseAdminState(),
    telegram: await telegramAppAdminState(),
    // non-empty when the pasted project URL had to be corrected
    note: supabaseNote,
  });
});

// "Test connection" for the Supabase login. Hand-configuring this goes wrong in
// ways that only surface as an opaque error inside the browser — a project URL
// with an API path appended reaches a gateway route that wants an API key, and
// the user just sees {"message":"No API key found in request"}. So the panel
// asks Supabase itself and reports the answer, plus which providers are actually
// switched on there. Values typed but not saved yet are accepted, so a URL can
// be checked before it is stored.
app.post("/api/admin/supabase/test", guards(), async (req, res) => {
  const stored = await supabaseStoredConfig();
  const asked = normalizeProjectUrl(String(req.body?.url || stored.url));
  const typedKey = String(req.body?.anonKey || "").trim();
  const anonKey = typedKey && typedKey !== mask(stored.anonKey) ? typedKey : stored.anonKey;
  if (asked.error) return res.status(400).json({ error: asked.error });
  if (!asked.url || !anonKey) {
    return res.status(400).json({ error: "Fill in the project URL and the anon / publishable key first, then press Save." });
  }
  const providersRaw = req.body?.providers !== undefined
    ? String(req.body.providers)
    : (await db.storeGet("oauth.supabase.providers")) || process.env.SUPABASE_PROVIDERS || "";
  const providers = parseProviders(providersRaw);
  const base = {
    url: asked.url,
    note: projectUrlNote(asked.url, asked.stripped),
    // The address the user's own Google / GitHub OAuth app has to allow. Supabase
    // is the OAuth client here, and providers reject the sign-in with
    // "redirect_uri_mismatch" until their own console lists this one.
    providerCallback: `${asked.url}/auth/v1/callback`,
  };
  try {
    const response = await fetch(`${asked.url}/auth/v1/settings`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON — reported as text below */
    }
    if (!response.ok) {
      return res.json({
        ...base,
        ok: false,
        status: response.status,
        message: String(body?.message || text || `HTTP ${response.status}`).slice(0, 300),
        hint: String(body?.hint || ""),
      });
    }
    const external = body && typeof body.external === "object" && body.external ? body.external : {};
    const enabled = Object.keys(external).filter((name) => external[name] === true);
    res.json({
      ...base,
      ok: true,
      status: response.status,
      enabled,
      // offered as a button here but switched off in the Supabase project —
      // those buttons only bounce the user back with an error
      missing: providers.filter((name) => !enabled.includes(name)),
      // the e-mail provider is what sends the passwordless sign-in links
      emailOn: external.email === true,
    });
  } catch (err) {
    res.json({
      ...base,
      ok: false,
      message: `Could not reach ${asked.url} — ${String(err?.cause?.code || err?.message || err).slice(0, 200)}`,
    });
  }
});

// --- cloud connection ------------------------------------------------------
app.get("/api/admin/cloud", requireAuth, async (_req, res) => {
  res.json({
    provider: (await db.storeGet("cloud.provider")) || "custom",
    apiUrl: (await db.storeGet("cloud.apiUrl")) || "",
    host: (await db.storeGet("cloud.host")) || "",
    tokenMasked: mask(await db.storeGet("cloud.token")),
    hasToken: !!(await db.storeGet("cloud.token")),
    // where workflows are saved: "local" (this device) or "database" (SQL)
    storageMode: await workflowStorageMode(),
    localWorkflowCount: countLocalWorkflows(),
    dbWorkflowCount: await countDbWorkflows(),
  });
});

app.post("/api/admin/cloud", guards(), async (req, res) => {
  const { provider, apiUrl, host, token } = req.body || {};
  await db.storeSet("cloud.provider", cleanString(provider, 40) || "custom");
  await db.storeSet("cloud.apiUrl", cleanString(apiUrl, 500));
  await db.storeSet("cloud.host", cleanString(host, 500));
  if (token && token !== mask(await db.storeGet("cloud.token"))) {
    await db.storeSet("cloud.token", token, { encrypted: true });
  }
  res.json({ ok: true });
});

// Toggle where workflows are saved: "local" (JSON file on this device) or
// "database" (SQL workflows table, each workflow with an assigned code). The
// switch migrates existing workflows first so nothing is lost.
app.post("/api/admin/cloud/storage", guards(), async (req, res) => {
  const mode = String(req.body?.mode || "").trim() === "database" ? "database" : "local";
  try {
    const next = await setWorkflowStorageMode(mode);
    res.json({
      ok: true,
      storageMode: next,
      localWorkflowCount: countLocalWorkflows(),
      dbWorkflowCount: await countDbWorkflows(),
      message:
        next === "database"
          ? "Workflows are now saved in the SQL database (each with an assigned code)."
          : "Workflows are now saved on this device (JSON file).",
    });
  } catch (err) {
    res.status(500).json({ error: `Could not switch workflow storage: ${String(err.message || err)}` });
  }
});

app.post("/api/admin/cloud/test", guards(), async (_req, res) => {
  const apiUrl = await db.storeGet("cloud.apiUrl");
  if (!apiUrl) return res.json({ ok: false, detail: "No API URL configured yet. Save a cloud base URL first." });
  try {
    // W flow instances answer on /api/health (a bare /health would fall through
    // to the SPA page and "succeed" for any web server).
    const target = `${String(apiUrl).replace(/\/+$/, "")}/api/health`;
    const r = await fetch(target, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.text().catch(() => "");
    res.json({ ok: r.ok, status: r.status, detail: body ? body.slice(0, 200) : "Reachable (no body)." });
  } catch (err) {
    res.json({ ok: false, detail: `Could not reach server: ${(err.message || err).slice(0, 160)}` });
  }
});

// --- billing (Stripe) ------------------------------------------------------
// Where the operator connects Stripe so the main site can sell the €9.99 / month
// subscription. Values live in the shared DB (secret keys encrypted at rest);
// env vars are read as fallbacks when unset here.
app.get("/api/admin/billing", requireAuth, async (_req, res) => {
  res.json({ ...(await publicStripeConfig()), crypto: await publicCryptoConfig() });
});

app.post("/api/admin/billing", guards(), async (req, res) => {
  const body = req.body || {};
  await saveStripeConfig(body);
  // The crypto block of the same tab posts its own fields; save them together
  // so one "Save" click persists both. Stripe fields are ignored by saveCryptoConfig.
  await saveCryptoConfig({
    enabled: body.cryptoEnabled,
    apiKey: body.cryptoApiKey,
    ipnSecret: body.cryptoIpnSecret,
    priceAmount: body.cryptoPriceAmount,
    priceCurrency: body.cryptoPriceCurrency,
    payCurrency: body.cryptoPayCurrency,
  });
  res.json({ ok: true, ...(await publicStripeConfig()), crypto: await publicCryptoConfig() });
});

// --- legal pages (Impressum / Datenschutz) --------------------------------
// Operator details rendered into the legal pages on the legal subdomain
// (default info.<site domain>). The main server reads these keys at request
// time (server/legal.js); LEGAL_* env vars act as fallbacks when unset here.
// The subdomain itself is free-form here or derived from the site domain.
const LEGAL_FIELDS = [
  // operator / Imprint
  "name",
  "company",
  "legalForm",
  "address",
  "city",
  "country",
  "email",
  "phone",
  "representative",
  "registerCourt",
  "registerNumber",
  "vatId",
  "privacyEmail",
  "reportEmail",
  // privacy policy (Datenschutz) placeholders
  "updated",
  "siteDomain",
  "logRetention",
  "hoster",
  "hosterAddress",
  "hostingLocation",
  "cloudflare",
  "supabase",
  "database",
  "mailService",
  "storagePeriods",
  "extraUserFields",
  "accountDeletion",
  "workflowStorage",
  "externalData",
  "sessionTech",
  "sessionDuration",
  "processors",
  "thirdCountryService",
  "thirdCountryBasis",
  "authority",
  "securityMeasures",
];

app.get("/api/admin/legal", requireAuth, async (_req, res) => {
  const out = {
    domain: (await db.storeGet("legal.domain")) || "",
    siteDomain: (await db.storeGet("site.domain")) || "",
  };
  for (const f of LEGAL_FIELDS) out[f] = (await db.storeGet(`legal.${f}`)) || "";
  res.json(out);
});

app.post("/api/admin/legal", guards(), async (req, res) => {
  const b = req.body || {};
  const rawDomain = String(b.domain || "").trim();
  const domain = sanitizeSiteDomain(rawDomain);
  if (rawDomain && !domain) {
    return res.status(400).json({
      error: "That doesn't look like a domain — use e.g. info.example.com (no https://, ports or paths).",
    });
  }
  await db.storeSet("legal.domain", domain);
  for (const f of LEGAL_FIELDS) await db.storeSet(`legal.${f}`, cleanString(b[f], 1000));
  res.json({ ok: true, domain });
});

// --- SEO & GEO ------------------------------------------------------------
// The operator's search-engine (SEO) and generative-engine (GEO) settings:
// title / description / keywords / OG / verification / no-index, plus the
// llms.txt summary and the AI crawler policy. The main server reads these keys
// at request time and injects them into index.html, landing.html, robots.txt
// and llms.txt (server/seo.js).
app.get("/api/admin/seo", requireAuth, async (_req, res) => {
  res.json({
    ...(await seoConfig()),
    // the public host the meta tags / canonical URLs use
    siteDomain: (await db.storeGet("site.domain")) || "",
  });
});

app.post("/api/admin/seo", guards(), async (req, res) => {
  const saved = await saveSeoConfig(req.body || {});
  res.json({ ok: true, ...saved });
});

// --- analytics (online users) ----------------------------------------------
// How many users are online now / were online over each window, plus a bucketed
// bar-chart series for the selected range (hour / day / week / month / year / all).
app.get("/api/admin/analytics", requireAuth, async (req, res) => {
  const range = String(req.query.range || "day").toLowerCase();
  const series = await db.activitySeries(range, 12);
  res.json({ stats: await db.onlineStats(), series });
});

// --- database --------------------------------------------------------------
app.get("/api/admin/db", requireAuth, async (_req, res) => {
  const dbPath = path.join(__dirname, "..", "data", "admin.db");
  let size = 0;
  try {
    size = fs.statSync(dbPath).size;
  } catch {}
  const [tables, admins, sessions, users, userSessions, settings] = await Promise.all([
    db.tableCounts(),
    db.listAdmins(),
    db.sessionCount(),
    db.countUsers(),
    db.userSessionCount(),
    db.allSettingsCount ? db.allSettingsCount() : 0,
  ]);
  res.json({
    encryptedAtRest: !!process.env.BF_ENCRYPTION_KEY || fs.existsSync(path.join(__dirname, "..", "data", ".secret")),
    engine: databaseEngine === "postgres" ? "PostgreSQL" : "SQLite (node:sqlite)",
    path: databaseEngine === "postgres" ? String(process.env.DATABASE_URL).replace(/\/\/[^:@]+:[^@]+@/, "//***:***@") : dbPath,
    sizeBytes: size,
    tables,
    counts: {
      admins: admins.length,
      sessions,
      users,
      userSessions,
      settings,
    },
  });
});

function parseWorkflowIds(text) {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// Registered website users (the main-site login accounts — same SQL DB).
// Each user carries the workflow_ids column: the workflows assigned to them.
app.get("/api/admin/users", requireAuth, async (_req, res) => {
  const users = (await db.listUsers()).map((u) => {
    const { workflow_ids, ...rest } = u;
    let workflowIds = [];
    try {
      const v = JSON.parse(workflow_ids || "[]");
      if (Array.isArray(v)) workflowIds = v;
    } catch {
      workflowIds = [];
    }
    return { ...rest, workflowIds };
  });
  res.json(users);
});

app.post("/api/admin/users/status", guards(), async (req, res) => {
  const id = String(req.body?.id || "");
  const status = String(req.body?.status || "").trim().toLowerCase();
  const user = await db.getUserById(id);
  if (!user) return res.status(404).json({ error: "User not found." });
  try {
    const updated = await db.updateUserStatus(id, status, req.body?.reason);
    if (status === "deactivated") await db.destroyAllUserSessions(id);
    const { password_hash, workflow_ids, ...safe } = updated;
    res.json({ ok: true, user: { ...safe, workflowIds: parseWorkflowIds(workflow_ids) } });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/admin/users/role", guards(), async (req, res) => {
  const id = String(req.body?.id || "");
  const user = await db.getUserById(id);
  if (!user) return res.status(404).json({ error: "User not found." });
  try {
    const updated = await db.updateUserRole(id, req.body?.role);
    const { password_hash, workflow_ids, ...safe } = updated;
    res.json({ ok: true, user: { ...safe, workflowIds: parseWorkflowIds(workflow_ids) } });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/admin/users/delete", guards(), async (req, res) => {
  const id = String(req.body?.id || "");
  const user = await db.getUserById(id);
  if (!user) return res.status(404).json({ error: "User not found." });
  await db.destroyAllUserSessions(id);
  removeAccountFolder(id); // their My files folder goes with the account
  await db.deleteUser(id);
  res.json({ ok: true, email: user.email });
});

// SQL console — run any statement against the shared database.
app.post("/api/admin/db/query", guards(), async (req, res) => {
  const sql = String(req.body?.sql || "").trim();
  if (!sql) return res.status(400).json({ error: "No SQL provided." });
  if (sql.length > 5000) return res.status(400).json({ error: "SQL is too long (max 5000 characters)." });
  const t0 = performance.now();
  try {
    const result = await db.runSql(sql, {});
    res.json({
      ok: true,
      durationMs: Math.round(performance.now() - t0),
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/admin/db/download", requireAuth, (_req, res) => {
  const dbPath = path.join(__dirname, "..", "data", "admin.db");
  if (!fs.existsSync(dbPath)) return res.status(404).json({ error: "No database file yet." });
  res.download(dbPath, "wflow-admin.db", (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: "Download failed." });
  });
});

// --- account / security ----------------------------------------------------
// Update the admin account: change the username and/or the password.
app.post("/api/admin/account", guards(), async (req, res) => {
  const current = String(req.body?.current || "");
  const next = String(req.body?.next || "");
  const username = String(req.body?.username || "").trim();
  const user = await db.getUserByUsername(req.user.username);
  if (!user) return res.status(401).json({ error: "Account not found." });

  if (username && username !== user.username) {
    if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters." });
    const admins = await db.listAdmins();
    const taken = admins.some((a) => a.id !== user.id && a.username.toLowerCase() === username.toLowerCase());
    if (taken) return res.status(409).json({ error: "That username is already taken." });
    await db.setAdminUsername(user.id, username);
  }

  if (next) {
    if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
    if (!current || !verifyPassword(current, user.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    await db.setAdminPassword(user.id, hashPassword(next));
    await db.destroyAllSessionsForUser(user.id);
  }
  res.json({ ok: true });
});

app.get("/api/admin/security", requireAuth, async (_req, res) => {
  res.json({
    headers: ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"],
    csrf: "enabled (double-submit cookie)",
    loginRateLimit: "5 per user / 20 per IP per minute",
    sessions: await db.sessionCount(),
    passwordHashing: "scrypt (N=16384, r=8, p=1)",
    encryption: "AES-256-GCM",
    encryptionConfigured: !!process.env.BF_ENCRYPTION_KEY || fs.existsSync(path.join(__dirname, "..", "data", ".secret")),
  });
});

// ----------------------------------------------------------------------------
// operational alerts — raised by the health monitor / the main server and shown
// here. The operator can also add an e-mail address for notifications.
// ----------------------------------------------------------------------------
app.get("/api/admin/alerts", requireAuth, async (_req, res) => {
  res.json({
    alerts: await db.alertsList({ includeResolved: true, limit: 200 }),
    stats: await db.alertsStats(),
    settings: await getAlertSettings(),
    health: await runHealthCheck(),
    mailConfigured: await mailConfigured(),
  });
});

app.post("/api/admin/alerts/settings", guards(), async (req, res) => {
  try {
    const settings = await saveAlertSettings({ email: req.body?.email, enabled: req.body?.enabled });
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post("/api/admin/alerts/resolve", guards(), async (req, res) => {
  const ok = await db.alertResolve(String(req.body?.id || ""));
  if (!ok) return res.status(404).json({ error: "Alert not found." });
  res.json({ ok: true });
});

app.post("/api/admin/alerts/delete", guards(), async (req, res) => {
  const ok = await db.alertRemove(String(req.body?.id || ""));
  if (!ok) return res.status(404).json({ error: "Alert not found." });
  res.json({ ok: true });
});

// Send one mail through the saved SMTP settings and hand back the server's own
// answer — "535 Authentication failed" is the one line that explains why
// sign-up confirmations never arrive.
app.post("/api/admin/mail/test", guards(), async (req, res) => {
  const to = cleanString(req.body?.to, 200).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ ok: false, error: "Enter the address to send the test to." });
  const mail = await sendMail({
    to,
    subject: "[W flow] Test e-mail",
    text: `This is a test e-mail from the W flow admin panel.

If you received it, sign-up confirmations and password resets can be delivered.
Time: ${new Date().toISOString()}`,
  });
  if (!mail.ok && mail.skipped) return res.json({ ok: false, detail: "SMTP is not configured — fill in the host above and save first." });
  res.json({ ok: !!mail.ok, detail: mail.ok ? `Sent to ${to}. Check the inbox (and spam folder).` : `SMTP error: ${mail.error || "send failed"}` });
});

// Raise a test alert so the operator can confirm the e-mail path works.
app.post("/api/admin/alerts/test", guards(), async (_req, res) => {
  const settings = await getAlertSettings();
  if (!settings.email) return res.status(400).json({ error: "Add an e-mail address first." });
  const mail = await sendMail({
    to: settings.email,
    subject: "[W flow] Test alert",
    text: `This is a test alert from the W flow admin panel.\n\nIf you received it, alert e-mails are working.\nTime: ${new Date().toISOString()}`,
  });
  await raiseAlert({
    level: "info",
    source: "admin",
    title: "Test alert",
    message: `Test alert sent to ${settings.email}.`,
    email: false,
  });
  if (!mail.ok && mail.skipped) {
    return res.json({ ok: false, detail: "Alert recorded, but SMTP is not configured — set it on the Auth & e-mail tab." });
  }
  res.json({ ok: !!mail.ok, detail: mail.ok ? `Sent to ${settings.email}.` : String(mail.error || "Send failed.") });
});

// ----------------------------------------------------------------------------
// Team plans — custom plans requested on the Pro page (server/teams.js). A
// request can only be bought once it is approved here with a monthly price.
// ----------------------------------------------------------------------------
app.get("/api/admin/teams", requireAuth, async (_req, res) => {
  const teams = await listTeams();
  const out = [];
  for (const t of teams.slice().reverse()) out.push({ ...t, active: await teamActive(t) });
  res.json({ teams: out, notifyEmail: teamRequestsEmail() });
});

async function siteUrlForMail() {
  const domain = (await db.storeGet("site.domain")) || "";
  return domain ? `https://${domain}` : process.env.PUBLIC_URL || "";
}

app.post("/api/admin/teams/decide", guards(), async (req, res) => {
  const { id, approve, priceMonthly, note } = req.body || {};
  const r = await decideTeam(String(id || ""), { approve: !!approve, priceMonthly, note }, { siteUrl: await siteUrlForMail() });
  res.status(r.ok ? 200 : 400).json(r);
});

app.post("/api/admin/teams/paid", guards(), async (req, res) => {
  const r = await markTeamPaid(String(req.body?.id || ""), { months: req.body?.months });
  res.status(r.ok ? 200 : 400).json(r);
});

app.post("/api/admin/teams/end", guards(), async (req, res) => {
  const r = await endTeam(String(req.body?.id || ""));
  res.status(r.ok ? 200 : 400).json(r);
});

// ----------------------------------------------------------------------------
// Backups — snapshot ./data (database + JSON stores + files) and manage them.
// ----------------------------------------------------------------------------
app.get("/api/admin/backups", requireAuth, async (_req, res) => {
  res.json({
    engine: databaseEngine,
    settings: await getBackupSettings(),
    backups: listBackups(),
    lastRun: (await db.storeGet("backup.lastRun")) || "",
  });
});

app.post("/api/admin/backups/settings", guards(), async (req, res) => {
  try {
    const settings = await saveBackupSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post("/api/admin/backups/run", guards(), async (_req, res) => {
  try {
    const result = await runBackup({ reason: "manual" });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: `Backup failed: ${String(err?.message || err)}` });
  }
});

app.post("/api/admin/backups/delete", guards(), async (req, res) => {
  try {
    const ok = deleteBackup(req.body?.name);
    if (!ok) return res.status(404).json({ error: "Backup not found." });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.post("/api/admin/backups/restore", guards(), async (req, res) => {
  try {
    const result = await restoreBackup(req.body?.name);
    res.json({ ok: true, ...result, message: "Files restored. Restart the app so it reopens the restored database." });
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

app.get("/api/admin/backups/download", requireAuth, (req, res) => {
  const name = path.basename(String(req.query?.name || ""));
  const full = path.join(BACKUP_DIR, name);
  if (!name || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return res.status(404).json({ error: "Backup archive not found." });
  }
  res.download(full, name, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: "Download failed." });
  });
});

// ----------------------------------------------------------------------------
// Events journal — what touched the database, when and how fast.
// ----------------------------------------------------------------------------
app.get("/api/admin/journal", requireAuth, async (req, res) => {
  const limit = Number(req.query?.limit) || 100;
  const source = String(req.query?.source || "").trim();
  const op = String(req.query?.op || "").trim();
  res.json({
    enabled: journalEnabled(),
    processSource: JOURNAL_SOURCE,
    events: await db.journalList({ limit, source, op }),
    total: await db.journalCount(),
    stats: await journalStats(),
    retentionDays: Number(process.env.BF_JOURNAL_RETENTION_DAYS) || 7,
  });
});

app.post("/api/admin/journal/prune", guards(), async (req, res) => {
  const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 365);
  const removed = await db.journalPrune(days * 24 * 60 * 60_000);
  res.json({ ok: true, removed });
});

// ----------------------------------------------------------------------------
// Ops settings — hostnames / domains the deployment guides generate commands
// from (VPS, dev VPS, Patroni, Kubernetes). Remembered for next time.
// ----------------------------------------------------------------------------
// Plain (non-secret) values that only pre-fill the command generators. The
// Nginx and Kubernetes tabs keep their own domain / host so saving one tab no
// longer overwrites the others (they fall back to the VPS values when empty).
const OPS_FIELDS = ["vpsHost", "vpsUser", "domain", "devVpsHost", "patroniHost", "k8sHost", "registry", "repoUrl", "k8sDomain", "nginxDomain", "nginxHost"];

app.get("/api/admin/ops", requireAuth, async (_req, res) => {
  const out = { engine: databaseEngine, port: envValue("PORT") || process.env.PORT || "3001" };
  for (const f of OPS_FIELDS) out[f] = (await db.storeGet(`ops.${f}`)) || "";
  res.json(out);
});

app.post("/api/admin/ops", guards(), async (req, res) => {
  for (const f of OPS_FIELDS) {
    if (req.body?.[f] !== undefined) await db.storeSet(`ops.${f}`, cleanString(req.body[f], 300).trim());
  }
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// static admin UI + SPA fallback
// ----------------------------------------------------------------------------
app.get("/", (_req, res) => {
  // Issue the CSRF double-submit cookie on page load so the browser has a
  // token before the (CSRF-protected) login call.
  issueCsrfCookie(_req, res);
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Brand logo + favicon for the admin page — served from public/ so the page
// itself stays a single inlined file (CSP allows img-src 'self').
app.get(["/logo.png", "/favicon.png"], (_req, res) => {
  const file = _req.path === "/favicon.png" ? "favicon.png" : "logo.png";
  res.sendFile(path.join(__dirname, "..", "public", file));
});

// ----------------------------------------------------------------------------
// 404 / JSON error handling
// ----------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: "Not found." }));

// Malformed JSON bodies (express.json throws) and uncaught route errors must
// come back as JSON — never Express's default HTML error page with a stack
// trace. Route handlers already return their own 4xx JSON; this is the last
// line of defence.
app.use((err, _req, res, _next) => {
  const status = Number(err?.status || err?.statusCode) || (err?.type === "entity.parse.failed" ? 400 : 500);
  if (status >= 500) console.error("[admin] error:", err);
  if (res.headersSent) return;
  res.status(status).json({
    error: status >= 500 ? "Internal server error." : err?.expose ? String(err?.message || "Bad request.") : "Bad request.",
  });
});

function mask(v) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= 4) return "••••";
  return "•••• •••• " + s.slice(-4);
}
function cleanString(v, max) {
  if (v === undefined || v === null) return "";
  return String(v).slice(0, max || 500);
}

// ----------------------------------------------------------------------------
export function startAdminServer(port = ADMIN_PORT) {
  seedIfNeeded();
  // Watch the main server so a crash / hang shows up as an alert in the panel
  // (and, if configured, in the operator's inbox).
  startHealthMonitor();
  const exposed = ADMIN_HOST === "0.0.0.0" || ADMIN_HOST === "::";
  // Refuse to expose the panel on a network interface without credentials set
  // in .env — the generated first password only ever appeared in a log. Loopback is fine (reach it via an SSH tunnel); an
  // operator who really means it can override with BF_ADMIN_ALLOW_DEFAULT=1.
  const usingDefaultAdmin = !process.env.BF_ADMIN_USERNAME || !process.env.BF_ADMIN_PASSWORD;
  const allowDefault = process.env.BF_ADMIN_ALLOW_DEFAULT === "1" || process.env.BF_ADMIN_ALLOW_DEFAULT === "true";
  if (exposed && usingDefaultAdmin && !allowDefault) {
    console.error("");
    console.error("  ✖ [admin] refusing to listen on a public interface without admin credentials in .env.");
    console.error("    Set BF_ADMIN_USERNAME and BF_ADMIN_PASSWORD in .env (then restart), or bind");
    console.error("    ADMIN_HOST=127.0.0.1 and reach the panel through an SSH tunnel. To override");
    console.error("    deliberately, set BF_ADMIN_ALLOW_DEFAULT=1.");
    console.error("");
    process.exit(1);
  }
  if (exposed && !allowList) {
    console.log("");
    console.log("  ⚠ [admin] panel is reachable on every network interface with no IP restriction.");
    console.log("    If this server has a public IP, set ADMIN_ALLOWED_IPS in .env to your own");
    console.log("    IP(s) (e.g. ADMIN_ALLOWED_IPS=203.0.113.7), or bind ADMIN_HOST=127.0.0.1 and");
    console.log("    reach the panel through an SSH tunnel.");
    console.log("");
  }
  const server = app.listen(port, ADMIN_HOST, () => {
    const actual = server.address() && typeof server.address() === "object" ? server.address().port : port;
    console.log("");
    console.log("  W FLOW — ADMIN");
    console.log(`  → Admin: http://${ADMIN_HOST === "0.0.0.0" ? "localhost" : ADMIN_HOST}:${actual}`);
    console.log(allowList
      ? `  → IP allowlist: ${ALLOWED_IPS.join(", ")}`
      : "  → no IP restriction configured (ADMIN_ALLOWED_IPS)");
    console.log("  (isolated server — only launched via admin.bat / admin.sh)");
    console.log("");
  });
  return server;
}

const entryUrl =
  process.argv[1] && process.argv[1] !== "[eval]"
    ? pathToFileURL(process.argv[1]).href
    : null;
if (entryUrl && import.meta.url === entryUrl) {
  startAdminServer();
}