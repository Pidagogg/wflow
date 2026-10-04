#!/usr/bin/env node
// ============================================================================
// Fill the admin panel with the production values for https://w-flow.tech —
// page setup, SEO & GEO, legal-page details (everything except your personal
// Impressum data), the site domain, backups and the command-generator defaults.
//
// It talks to the admin panel's own API, so it works for the local panel and
// for the one on the STRATO VPS (through the SSH tunnel):
//
//   node scripts/fill-admin.mjs                          # http://127.0.0.1:3002
//   ssh -L 3002:127.0.0.1:3002 root@<VPS-IP>             # in another terminal
//   node scripts/fill-admin.mjs --url http://127.0.0.1:3002
//
// Login: ADMIN_USER / ADMIN_PASS env vars, else BF_ADMIN_USERNAME /
// BF_ADMIN_PASSWORD from ./.env. Safe to run again — personal legal fields
// (name, address, e-mail, …) that are already filled in are kept, and no
// secret (Stripe, SMTP password, OAuth, …) is ever written.
// ============================================================================
import fs from "node:fs";
import path from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const BASE = (arg("--url") || "http://127.0.0.1:3002").replace(/\/+$/, "");

function envFile() {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.resolve(".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
const env = envFile();
const USER = process.env.ADMIN_USER || env.BF_ADMIN_USERNAME;
const PASS = process.env.ADMIN_PASS || env.BF_ADMIN_PASSWORD;
if (!USER || !PASS) {
  console.error("No admin login found — set ADMIN_USER and ADMIN_PASS (or BF_ADMIN_USERNAME / BF_ADMIN_PASSWORD in .env).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The values
// ---------------------------------------------------------------------------
const DOMAIN = "w-flow.tech";
const SITE = `https://${DOMAIN}`;

const PAGE = {
  siteName: "W flow",
  siteTagline: "Build workflows and AI agents — hosted in Germany or on your own server.",
  authBanner:
    "Automate anything on a visual canvas: 445 nodes, webhooks, schedules and AI agents with your own keys. Free to start — no credit card.",
  hideLegalAndPro: false,
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "W flow",
      url: `${SITE}/`,
      applicationCategory: "BusinessApplication",
      applicationSubCategory: "Workflow automation",
      operatingSystem: "Web, Windows, macOS, Linux",
      description:
        "Visual workflow automation and AI agent builder with 445 nodes: webhooks, cron schedules, 244 integrations, feeds and AI agents with your own API keys.",
      image: `${SITE}/logo.png`,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR", description: "Free plan" },
      featureList: [
        "Visual workflow canvas",
        "445 node types",
        "Webhook and cron triggers",
        "AI agents with bring-your-own model keys",
        "Encrypted credential storage",
        "Self-hosted installer",
      ],
    },
    { "@type": "Organization", name: "W flow", url: `${SITE}/`, logo: `${SITE}/logo.png` },
    { "@type": "WebSite", name: "W flow", url: `${SITE}/`, inLanguage: "en" },
  ],
};

const SEO = {
  title: "W flow — Visual workflow automation & AI agent builder",
  description:
    "Build automations on a visual canvas: 445 nodes, webhooks, schedules and AI agents with your own keys. Free cloud workspace hosted in Germany, or self-host it.",
  keywords:
    "workflow automation, workflow builder, n8n alternative, Zapier alternative, Make alternative, AI agent builder, no-code automation, low-code, webhooks, cron scheduler, RSS automation, self-hosted automation, GDPR, hosted in Germany",
  ogImage: `${SITE}/logo.png`,
  indexable: true,
  // the app behind the login and the API are not search results
  robotsExtra: ["User-agent: *", "Disallow: /api/", "Disallow: /webhook/", "Disallow: /cloud/", "Disallow: /home"].join("\n"),
  extraHead: `<script type="application/ld+json">${JSON.stringify(JSON_LD)}</script>`,
  // GEO — generative engine optimization (llms.txt + AI crawler policy)
  llmsEnabled: true,
  aiCrawlers: true,
  llmsSummary:
    "W flow is a visual workflow automation and AI agent builder, similar to n8n or Zapier. Users connect triggers, actions, logic and AI nodes on a canvas to automate tasks. It runs as a free hosted cloud workspace at w-flow.tech (hosted by STRATO in Germany) or as a self-hosted copy on the user's own machine.",
  llmsFacts: [
    "445 node types in 7 groups: triggers, files & data, actions, logic, AI & agents, feeds & sources, more integrations.",
    "244 service integrations (Slack, Discord, Telegram, GitHub, Gitea, Notion, Google, Microsoft 365, Stripe, Mastodon, …) plus 18 ready-made feed readers (YouTube, Reddit, Hacker News, GitHub releases, podcasts, arXiv).",
    "Triggers: manual, webhook, cron schedule, chat, forms, RSS and service events (Gmail, Slack, GitHub, Stripe, …).",
    "AI: bring your own model keys — OpenAI-compatible, Anthropic, Gemini, Groq, Mistral, DeepSeek, OpenRouter or local models; agents with tools, embeddings and vector search.",
    "Free plan in the cloud workspace: 10 workflows and 50 runs per day.",
    "Credentials are stored encrypted (AES-256-GCM) in the instance's own database; every run is logged per node with inputs, outputs and timings.",
    "Hosted in Germany (STRATO) and built for GDPR; a self-hosted installer for Windows, macOS and Linux is available.",
  ].join("\n"),
};

// Legal pages: everything that describes the service. Personal fields (name,
// address, e-mail, phone, register, VAT id, authority) are left to you.
const LEGAL = {
  domain: `info.${DOMAIN}`,
  updated: "September 2026",
  siteDomain: DOMAIN,
  country: "Deutschland",
  logRetention: "7 Tage",
  hoster: "STRATO GmbH",
  hosterAddress: "Otto-Ostrowski-Straße 7, 10249 Berlin, Deutschland",
  hostingLocation: "Deutschland",
  database: "SQLite-Datenbank auf dem eigenen STRATO-Server in Deutschland",
  mailService: "STRATO GmbH (E-Mail-Postfach der Domain w-flow.tech)",
  storagePeriods:
    "Server-Logs: 7 Tage; automatische Datenbank-Sicherungen: 14 Tage; Konto-, Workflow- und Ausführungsdaten: bis zur Löschung des Kontos",
  extraUserFields: "Anzeigename sowie freiwillige Profilangaben (Bio, Website, Avatar)",
  accountDeletion: "die Kontoeinstellungen (Einstellungen → Konto) oder eine formlose E-Mail",
  workflowStorage: "in der Datenbank dieser Instanz; Zugangsdaten (API-Schlüssel, Tokens) AES-256-GCM-verschlüsselt",
  externalData:
    "Workflows übermitteln nur die Daten, die Sie selbst in einem Knoten konfigurieren, an den dort gewählten Dienst (z. B. KI-Anbieter, E-Mail-, Chat- oder Cloud-Dienste). Diese Übermittlung erfolgt in Ihrem Auftrag.",
  sessionTech: "ein technisch notwendiges Session-Cookie (HttpOnly) sowie die lokale Speicherung Ihrer Cookie-Auswahl",
  sessionDuration: "14 Tage bzw. bis zur Abmeldung",
  processors: "STRATO GmbH (Hosting, E-Mail-Versand)",
  securityMeasures:
    "Weitere Maßnahmen: TLS-Verschlüsselung (HTTPS), verschlüsselt gespeicherte Zugangsdaten, Passwort-Hashing (scrypt), Firewall und tägliche Datensicherungen.",
};
// never overwritten when they already hold a value
const PERSONAL = [
  "name", "company", "legalForm", "address", "city", "email", "phone", "representative",
  "registerCourt", "registerNumber", "vatId", "privacyEmail", "reportEmail", "authority",
  "cloudflare", "supabase", "thirdCountryService", "thirdCountryBasis",
];

const OPS = { domain: DOMAIN, vpsUser: "root", repoUrl: "https://github.com/Pidagogg/wwb.git", nginxDomain: DOMAIN, k8sDomain: DOMAIN };
const BACKUPS = { enabled: true, intervalHours: 24, keep: 14 };

// ---------------------------------------------------------------------------
// Admin API client (CSRF double-submit cookie + session cookie)
// ---------------------------------------------------------------------------
const jar = {};
function remember(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const t = res.headers.get("x-csrf-token");
  if (t) jar.bf_csrf = jar.bf_csrf || t;
}
async function call(method, url, body) {
  const headers = { Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = jar.bf_csrf || "";
  }
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  remember(res);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.status >= 300) throw new Error(`${method} ${url} → ${res.status} ${data.error || ""}`.trim());
  return data;
}

async function main() {
  await call("GET", "/api/admin/me");
  await call("POST", "/api/admin/login", { username: USER, password: PASS });
  console.log(`Logged in to ${BASE}`);

  const page = await call("GET", "/api/admin/settings");
  await call("POST", "/api/admin/settings", { ...PAGE, cloudPath: page.cloudPath || "cloud" });
  console.log("  ✓ Page setup");

  await call("POST", "/api/admin/deploy/site-domain", { domain: DOMAIN });
  console.log(`  ✓ Site domain → ${DOMAIN}`);

  await call("POST", "/api/admin/seo", SEO);
  console.log("  ✓ SEO & GEO");

  // /legal writes every field, so start from the current values
  const current = await call("GET", "/api/admin/legal");
  const legal = { ...(current.fields || current), domain: current.domain || "" };
  for (const [k, v] of Object.entries(LEGAL)) {
    if (PERSONAL.includes(k) && legal[k]) continue;
    legal[k] = v;
  }
  await call("POST", "/api/admin/legal", legal);
  const missing = ["name", "address", "city", "email", "privacyEmail"].filter((k) => !legal[k]);
  console.log("  ✓ Legal pages" + (missing.length ? ` — still to fill in yourself: ${missing.join(", ")}` : ""));

  await call("POST", "/api/admin/ops", OPS);
  console.log("  ✓ Command generators (domain, SSH user, repository)");

  await call("POST", "/api/admin/backups/settings", BACKUPS);
  console.log("  ✓ Backups: daily, keep 14");

  const billing = await call("GET", "/api/admin/billing");
  console.log(`  • Subscriptions for sale: ${billing.salesOpen ? "OPEN" : "closed (\"Pro opens next month\")"} — unchanged`);
  console.log("Done. Secrets (Stripe, SMTP password, OAuth, Supabase) and your personal Impressum data are not touched.");
}

// --direct: write the same settings keys straight into THIS machine's database
// (for when the admin login is not at hand). Same keys the admin API writes.
async function direct() {
  const { db, sanitizeSiteDomain } = await import("../server/dbx.js");
  const { saveSeoConfig } = await import("../server/seo.js");
  const set = (k, v) => db.storeSet(k, String(v ?? ""));
  await set("page.siteName", PAGE.siteName);
  await set("page.tagline", PAGE.siteTagline);
  await set("page.banner", PAGE.authBanner);
  await set("page.hideLegalAndPro", PAGE.hideLegalAndPro ? "1" : "0");
  console.log("  ✓ Page setup");
  await set("site.domain", sanitizeSiteDomain ? sanitizeSiteDomain(DOMAIN) : DOMAIN);
  console.log(`  ✓ Site domain → ${DOMAIN}`);
  await saveSeoConfig(SEO);
  console.log("  ✓ SEO & GEO");
  const missing = [];
  for (const [k, v] of Object.entries(LEGAL)) {
    const key = `legal.${k}`;
    if (PERSONAL.includes(k) && (await db.storeGet(key))) continue;
    await set(key, v);
  }
  for (const k of ["name", "address", "city", "email", "privacyEmail"]) if (!(await db.storeGet(`legal.${k}`))) missing.push(k);
  console.log("  ✓ Legal pages" + (missing.length ? ` — still to fill in yourself: ${missing.join(", ")}` : ""));
  for (const [k, v] of Object.entries(OPS)) await set(`ops.${k}`, v);
  console.log("  ✓ Command generators (domain, SSH user, repository)");
  await set("backup.settings", JSON.stringify(BACKUPS));
  console.log("  ✓ Backups: daily, keep 14 (active after the next server start)");
  console.log("Done (direct database mode).");
}

(process.argv.includes("--direct") ? direct() : main()).then(() => process.exit(0)).catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
