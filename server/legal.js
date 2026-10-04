// ============================================================================
// W FLOW — Legal pages (Impressum · Datenschutzerklärung)
//
// A small, self-contained legal site. The documents are served at root paths
// on the main site (/impressum, /datenschutz — plus /legal/* as an alias), and
// optionally on a dedicated subdomain (default: info.<site domain>) when the
// operator configures one.
//
// Two documents in German, English and Russian:
//   /impressum    — Legal notice / imprint
//   /datenschutz  — Privacy policy (Datenschutzerklärung)
// There is deliberately NO AGB / terms page and NO withdrawal notice: this
// service publishes an imprint and a privacy policy only.
// Language is chosen with ?lang=de|en|ru and remembered in a cookie
// (bf_legal_lang); the switcher in the header sets it on every page.
//
// Operator details (company name, address, e-mail, …) are resolved as:
//   1. admin panel settings (legal.* keys) — operator-editable at runtime
//   2. LEGAL_* env vars                      — fallback for static deploys
//   3. per-language placeholders            — a fresh install still renders
//      complete pages with clearly marked gaps the operator must fill in.
//
// The Impressum and Datenschutzerklärung content lives in ./legal-docs.js.
// ============================================================================
import "./env.js"; // .env must be loaded before LEGAL_* / BF_LEGAL_DOMAIN are read
import express from "express";
import { db, sanitizeSiteDomain } from "./dbx.js";
import { IMPRESSUM_DOC, DATENSCHUTZ_DOC } from "./legal-docs.js";

export const LEGAL_LANGS = ["de", "en", "ru"];
export const LEGAL_DEFAULT_LANG = "de";
const LEGAL_COOKIE = "bf_legal_lang";
const LANG_LABEL = { de: "Deutsch", en: "English", ru: "Русский" };

// ---------------------------------------------------------------------------
// Operator data — admin settings (legal.*) → env (LEGAL_*) → placeholder
// ---------------------------------------------------------------------------
const DATA_FIELDS = {
  company:        { key: "legal.company",         env: "LEGAL_COMPANY" },
  legalForm:      { key: "legal.legalForm",       env: "LEGAL_LEGAL_FORM" },
  address:        { key: "legal.address",         env: "LEGAL_ADDRESS" },
  city:           { key: "legal.city",            env: "LEGAL_CITY" },
  country:        { key: "legal.country",         env: "LEGAL_COUNTRY" },
  email:          { key: "legal.email",           env: "LEGAL_EMAIL" },
  phone:          { key: "legal.phone",           env: "LEGAL_PHONE" },
  representative: { key: "legal.representative",  env: "LEGAL_REPRESENTATIVE" },
  registerCourt:  { key: "legal.registerCourt",   env: "LEGAL_REGISTER_COURT" },
  registerNumber: { key: "legal.registerNumber",  env: "LEGAL_REGISTER_NUMBER" },
  vatId:          { key: "legal.vatId",           env: "LEGAL_VAT_ID" },
  privacyEmail:   { key: "legal.privacyEmail",    env: "LEGAL_PRIVACY_EMAIL" },
  // Operator / privacy-policy details used by the Impressum and Datenschutz
  name:            { key: "legal.name",             env: "LEGAL_NAME" },
  reportEmail:     { key: "legal.reportEmail",      env: "LEGAL_REPORT_EMAIL" },
  updated:         { key: "legal.updated",          env: "LEGAL_UPDATED" },
  siteDomain:      { key: "legal.siteDomain",       env: "LEGAL_SITE_DOMAIN" },
  logRetention:    { key: "legal.logRetention",     env: "LEGAL_LOG_RETENTION" },
  hoster:          { key: "legal.hoster",           env: "LEGAL_HOSTER" },
  hosterAddress:   { key: "legal.hosterAddress",    env: "LEGAL_HOSTER_ADDRESS" },
  hostingLocation: { key: "legal.hostingLocation", env: "LEGAL_HOSTING_LOCATION" },
  // deployment details the privacy policy names explicitly
  cloudflare:      { key: "legal.cloudflare",       env: "LEGAL_CLOUDFLARE" },
  supabase:        { key: "legal.supabase",         env: "LEGAL_SUPABASE" },
  database:        { key: "legal.database",         env: "LEGAL_DATABASE" },
  mailService:     { key: "legal.mailService",      env: "LEGAL_MAIL_SERVICE" },
  storagePeriods:  { key: "legal.storagePeriods",   env: "LEGAL_STORAGE_PERIODS" },
  extraUserFields: { key: "legal.extraUserFields",  env: "LEGAL_EXTRA_USER_FIELDS" },
  accountDeletion: { key: "legal.accountDeletion",  env: "LEGAL_ACCOUNT_DELETION" },
  workflowStorage: { key: "legal.workflowStorage",  env: "LEGAL_WORKFLOW_STORAGE" },
  externalData:    { key: "legal.externalData",     env: "LEGAL_EXTERNAL_DATA" },
  sessionTech:     { key: "legal.sessionTech",      env: "LEGAL_SESSION_TECH" },
  sessionDuration: { key: "legal.sessionDuration",  env: "LEGAL_SESSION_DURATION" },
  processors:      { key: "legal.processors",       env: "LEGAL_PROCESSORS" },
  thirdCountryService: { key: "legal.thirdCountryService", env: "LEGAL_THIRD_COUNTRY_SERVICE" },
  thirdCountryBasis:   { key: "legal.thirdCountryBasis",   env: "LEGAL_THIRD_COUNTRY_BASIS" },
  authority:       { key: "legal.authority",        env: "LEGAL_AUTHORITY" },
  securityMeasures:{ key: "legal.securityMeasures", env: "LEGAL_SECURITY_MEASURES" },
};

const PLACEHOLDER = {
  de: {
    company: "[Firmenname]",
    legalForm: "",
    address: "[Straße und Hausnummer]",
    city: "[PLZ und Ort]",
    country: "[Land]",
    email: "[E-Mail-Adresse]",
    phone: "",
    representative: "[Name der vertretungsberechtigten Person]",
    registerCourt: "[Registergericht]",
    registerNumber: "[Handelsregisternummer]",
    vatId: "[Umsatzsteuer-Identifikationsnummer]",
    privacyEmail: "[E-Mail-Adresse für Datenschutzanfragen]",
    name: "[Vor- und Nachname]",
    reportEmail: "[E-Mail-Adresse für Meldungen rechtswidriger Inhalte]",
    updated: "[Datum]",
    siteDomain: "[Domain-Name]",
    logRetention: "[z. B. 7 Tage — an die tatsächliche Logrotation anpassen]",
    hoster: "[Name des Hosting-Anbieters, z. B. Hetzner Online GmbH]",
    hosterAddress: "[Adresse des Hosters]",
    hostingLocation: "[Standort des Servers, z. B. Nürnberg, Deutschland]",
    cloudflare: "[optional: Hinweise zu Cloudflare, z. B. Tarif, Proxy-Modus oder Zugriffsregeln]",
    supabase: "[optional: Supabase-Projekt und Region, wenn Supabase Auth aktiv ist]",
    database: "[optional: Details zu Ihrer Datenbank, z. B. eigener PostgreSQL-Server in Deutschland]",
    mailService: "[optional: der eingesetzte E-Mail-Dienstleister bzw. SMTP-Server]",
    storagePeriods: "[optional: weitere Aufbewahrungsfristen für einzelne Datenarten]",
    extraUserFields: "[weitere Felder, z. B. Benutzername, Anzeigename]",
    accountDeletion: "[Löschweg, z. B. die Kontoeinstellungen oder eine E-Mail an …]",
    workflowStorage: "[Art der Speicherung, z. B. verschlüsselt in einer Datenbank]",
    externalData: "[Beschreibung, welche Daten bei externen Aufrufen an wen fließen]",
    sessionTech: "[technisch notwendige Session-Cookies / JWT im lokalen Speicher]",
    sessionDuration: "[z. B. Session-Ende oder 30 Tage bei „Angemeldet bleiben“]",
    processors: "[weitere Dienstleister, z. B. E-Mail-Versand-, Monitoring- oder CDN-Anbieter]",
    thirdCountryService: "[Dienst und Land]",
    thirdCountryBasis: "[Standardvertragsklauseln der EU-Kommission / Angemessenheitsbeschluss]",
    authority: "[zuständige Landesdatenschutzbehörde]",
    securityMeasures: "[weitere Maßnahmen, z. B. Zugriffsbeschränkungen, regelmäßige Backups]",
  },
  en: {
    company: "[Company name]",
    legalForm: "",
    address: "[Street and house number]",
    city: "[Postal code and city]",
    country: "[Country]",
    email: "[E-mail address]",
    phone: "",
    representative: "[Name of the authorised representative]",
    registerCourt: "[Court of registry]",
    registerNumber: "[Commercial register number]",
    vatId: "[VAT identification number]",
    privacyEmail: "[E-mail address for privacy requests]",
    name: "[First and last name]",
    reportEmail: "[E-mail address for reports of unlawful content]",
    updated: "[date]",
    siteDomain: "[domain name]",
    logRetention: "[e.g. 7 days — match your actual log rotation]",
    hoster: "[name of the hosting provider]",
    hosterAddress: "[address of the hosting provider]",
    hostingLocation: "[server location, e.g. Nuremberg, Germany]",
    cloudflare: "[optional: notes on Cloudflare, e.g. plan, proxy mode or access rules]",
    supabase: "[optional: Supabase project and region, when Supabase Auth is enabled]",
    database: "[optional: database details, e.g. your own PostgreSQL server in Germany]",
    mailService: "[optional: the e-mail provider or SMTP server you use]",
    storagePeriods: "[optional: further retention periods for individual data types]",
    extraUserFields: "[further fields, e.g. username, display name]",
    accountDeletion: "[how to delete, e.g. the account settings or an e-mail to …]",
    workflowStorage: "[storage description, e.g. encrypted in a database]",
    externalData: "[description of what data flows to whom on external requests]",
    sessionTech: "[technically necessary session cookies / JWT in local storage]",
    sessionDuration: "[e.g. end of session or 30 days with “stay logged in”]",
    processors: "[further processors, e.g. e-mail delivery, monitoring or CDN providers]",
    thirdCountryService: "[service and country]",
    thirdCountryBasis: "[EU standard contractual clauses / adequacy decision]",
    authority: "[competent supervisory authority]",
    securityMeasures: "[further measures, e.g. access restrictions, regular backups]",
  },
  ru: {
    company: "[Название компании]",
    legalForm: "",
    address: "[Улица и номер дома]",
    city: "[Почтовый индекс и город]",
    country: "[Страна]",
    email: "[Адрес электронной почты]",
    phone: "",
    representative: "[Имя представителя компании]",
    registerCourt: "[Реестровый суд]",
    registerNumber: "[Номер записи в реестре]",
    vatId: "[Идентификационный номер НДС]",
    privacyEmail: "[Адрес электронной почты для запросов о конфиденциальности]",
    name: "[Имя и фамилия]",
    reportEmail: "[адрес электронной почты для сообщений о противоправном содержании]",
    updated: "[дата]",
    siteDomain: "[доменное имя]",
    logRetention: "[например, 7 дней — в соответствии с фактической ротацией журналов]",
    hoster: "[название хостинг-провайдера, например Hetzner Online GmbH]",
    hosterAddress: "[адрес хостинг-провайдера]",
    hostingLocation: "[расположение сервера, например Нюрнберг, Германия]",
    cloudflare: "[необязательно: сведения о Cloudflare, например тариф, режим прокси или правила доступа]",
    supabase: "[необязательно: проект и регион Supabase, если включён Supabase Auth]",
    database: "[необязательно: сведения о вашей базе данных, например собственный сервер PostgreSQL в Германии]",
    mailService: "[необязательно: используемый почтовый сервис или SMTP-сервер]",
    storagePeriods: "[необязательно: дополнительные сроки хранения для отдельных видов данных]",
    extraUserFields: "[дополнительные поля, например имя пользователя, отображаемое имя]",
    accountDeletion: "[способ удаления, например настройки учётной записи или письмо на …]",
    workflowStorage: "[описание хранения, например в зашифрованном виде в базе данных]",
    externalData: "[описание того, какие данные кому передаются при внешних запросах]",
    sessionTech: "[технически необходимые сессионные файлы cookie / JWT в локальном хранилище]",
    sessionDuration: "[например, до конца сеанса или 30 дней при «запомнить меня»]",
    processors: "[другие поставщики услуг, например рассылка писем, мониторинг или CDN]",
    thirdCountryService: "[сервис и страна]",
    thirdCountryBasis: "[стандартные договорные условия ЕС / решение об адекватности]",
    authority: "[компетентный надзорный орган по защите данных]",
    securityMeasures: "[дополнительные меры, например ограничение доступа, регулярные резервные копии]",
  },
};

// The legal subdomain: admin setting legal.domain → env BF_LEGAL_DOMAIN →
// derived "info." + site domain. Resolved lazily and cached briefly so the
// admin panel can change it without a restart.
let configCache = { at: 0, cfg: null };
export async function legalConfig() {
  const now = Date.now();
  if (configCache.cfg && now - configCache.at < 15_000) return configCache.cfg;
  let cfg = { domain: "", values: {} };
  try {
    const read = async (key) => (await db.storeGet(key)) || "";
    // 1. explicit admin setting
    let domain = sanitizeSiteDomain(await read("legal.domain"));
    // 2. env fallback
    if (!domain) domain = sanitizeSiteDomain(process.env.BF_LEGAL_DOMAIN || "");
    // the site's public domain — used for the subdomain and the privacy policy
    const site = sanitizeSiteDomain((await read("site.domain")) || process.env.BF_SITE_DOMAIN || "");
    // 3. derived from the site's public domain
    if (!domain && site && site !== "localhost") domain = `info.${site}`;
    const values = {};
    for (const [field, spec] of Object.entries(DATA_FIELDS)) {
      values[field] = (await read(spec.key)) || process.env[spec.env] || "";
    }
    // the policy names the site's public domain unless the operator set one
    if (!values.siteDomain) values.siteDomain = site;
    cfg = { domain, values, appUrl: appUrlFor(site) };
  } catch {
    // DB hiccup — degrade to env + derived domain only
    const site = sanitizeSiteDomain(process.env.BF_SITE_DOMAIN || "");
    const values = {};
    for (const [field, spec] of Object.entries(DATA_FIELDS)) values[field] = process.env[spec.env] || "";
    cfg = {
      domain: sanitizeSiteDomain(process.env.BF_LEGAL_DOMAIN || "") || (site && site !== "localhost" ? `info.${site}` : ""),
      values,
      appUrl: appUrlFor(site),
    };
  }
  configCache = { at: now, cfg };
  return cfg;
}

// Where "back to the app" leads. On the legal subdomain a relative "/" would
// stay on the legal site, so it must name the app's own domain; without one
// (localhost) the pages are served by the app itself and "/" is right.
function appUrlFor(site) {
  return site && site !== "localhost" ? `https://${site}/` : "/";
}

export async function legalDomain() {
  return (await legalConfig()).domain;
}

// https://info.example.com — the base the frontend links legal pages with.
export async function legalBaseUrl() {
  const domain = await legalDomain();
  return domain ? `https://${domain}` : "";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Replace {{token}} in a content string: operator value when set, otherwise a
// clearly marked per-language placeholder.
function fill(text, values, lang) {
  return String(text).replace(/\{\{(\??)(\w+)\}\}/g, (m, _opt, token) => {
    const raw = values[token];
    if (raw) return esc(raw);
    return esc(PLACEHOLDER[lang][token] ?? `[${token}]`);
  });
}

// Like fill(), but understands optional tokens written as {{?token}}: a line
// that contains an empty optional token is dropped, and a block whose lines all
// disappear returns null so the caller can omit it (a table row, a paragraph or
// a whole section). Used for details that only apply to some operators — e.g.
// a commercial register entry, a hosting provider or third-country transfers.
function fillBlock(text, values, lang) {
  const kept = [];
  for (const line of String(text).split("<br/>")) {
    let optional = false;
    const html = line.replace(/\{\{(\??)(\w+)\}\}/g, (m, opt, token) => {
      const raw = values[token];
      if (raw) return esc(raw);
      if (opt) {
        optional = true;
        return "";
      }
      return esc(PLACEHOLDER[lang][token] ?? `[${token}]`);
    });
    if (optional) continue;
    kept.push(html);
  }
  return kept.length ? kept.join("<br/>") : null;
}

// ---------------------------------------------------------------------------
// Document content — the canonical German text plus English / Russian
// translations. The documents themselves live in ./legal-docs.js; only the
// Impressum and the privacy policy exist (no AGB, no withdrawal notice).
// ---------------------------------------------------------------------------
const DOCS = {
  impressum: IMPRESSUM_DOC,
  datenschutz: DATENSCHUTZ_DOC,
};

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------
const PAGE_CSS = `
  :root{--bg:#0a0f1d;--panel:#111a2e;--line:#22304f;--line-strong:#2c3d68;--ink:#eef2fc;--dim:#a9b6d0;--faint:#5f6f92;--accent:#4fd1ff;--accent2:#45c98a;--red:#e06a6a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;line-height:1.7;font-size:15px}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  header.site{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:16px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(10,15,29,.96);backdrop-filter:blur(6px);z-index:10}
  .brand{display:flex;align-items:center;gap:8px;font-size:18px;font-weight:700;letter-spacing:2px;color:var(--ink)}
  .brand .dot{color:var(--accent)}
  .brand:hover{text-decoration:none}
  a.back{font-size:12px;letter-spacing:1px;color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
  a.back:hover{background:var(--panel);text-decoration:none}
  .brand .tag{margin-left:6px;font-size:10px;letter-spacing:2px;color:var(--faint);font-weight:600}
  nav.docs{display:flex;gap:4px;flex-wrap:wrap}
  nav.docs a{color:var(--dim);font-size:12px;letter-spacing:1.5px;text-transform:uppercase;padding:6px 10px;border:1px solid transparent;border-radius:6px}
  nav.docs a:hover{color:var(--ink);text-decoration:none}
  nav.docs a.active{color:var(--accent);border-color:var(--line);background:var(--panel)}
  .langs{margin-left:auto;display:flex;gap:2px;font-size:12px}
  .langs a{padding:5px 8px;border-radius:5px;color:var(--faint)}
  .langs a:hover{color:var(--ink);text-decoration:none}
  .langs a.active{color:var(--ink);background:var(--panel);border:1px solid var(--line)}
  main{max-width:860px;margin:0 auto;padding:36px 24px 60px}
  h1{font-size:30px;line-height:1.25;letter-spacing:-.4px;margin:0 0 6px}
  .intro{color:var(--dim);font-size:14px;margin:0 0 26px}
  .updated{color:var(--faint);font-size:12px;margin-bottom:26px}
  section.doc{margin:0 0 10px}
  section.doc h2{font-size:14px;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);margin:26px 0 8px}
  section.doc p{margin:8px 0;color:var(--dim)}
  section.doc strong{color:var(--ink)}
  section.doc ul{margin:8px 0 10px 22px;padding:0;color:var(--dim)}
  section.doc ul li{margin:4px 0}
  .impressum-table{width:100%;border-collapse:collapse}
  .impressum-table td{padding:10px 0;vertical-align:top;border-bottom:1px solid var(--line);color:var(--dim)}
  .impressum-table td:first-child{width:38%;color:var(--ink);font-weight:600;padding-right:18px}
  .impressum-note{margin:22px 0 0;color:var(--dim);font-size:13.5px}
  .impressum-note a{word-break:break-all}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:26px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
  .card h3{margin:0 0 6px;font-size:14px;letter-spacing:1px;text-transform:uppercase;color:var(--accent2)}
  .card p{margin:0 0 12px;color:var(--dim);font-size:13.5px}
  .card a{font-size:13px}
  .notfound{color:var(--red)}
  footer.site{border-top:1px solid var(--line);padding:22px 24px 46px;color:var(--faint);font-size:12.5px;text-align:center}
  footer.site a{color:var(--faint)}
  footer.site a:hover{color:var(--ink)}
  @media(max-width:640px){header.site{gap:10px}.langs{margin-left:0;width:100%}}
`;

function langLinks(lang) {
  return LEGAL_LANGS.map((l) => `<a href="?lang=${l}"${l === lang ? ' class="active"' : ""}>${LANG_LABEL[l]}</a>`).join("");
}

function docNav(docKey, lang) {
  return Object.entries(DOCS)
    .map(([key, doc]) => `<a href="/${key}"${key === docKey ? ' class="active"' : ""}>${doc[lang].nav}</a>`)
    .join("");
}

const BACK_LABEL = { de: "Zurück zur App", en: "Back to the app", ru: "Назад в приложение" };

function shell({ lang, docKey, title, body, values, appUrl = "/", status = 200 }) {
  const year = new Date().getFullYear();
  // A private operator has no company: the copyright line then names the
  // operator, and the placeholder only shows while neither is filled in.
  const company = esc(values.company || values.name || PLACEHOLDER[lang].company);
  const app = esc(appUrl);
  const backLabel = BACK_LABEL[lang] || BACK_LABEL.en;
  const back = `<a href="${app}">W flow</a> · <a href="${app}">${backLabel}</a>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<meta name="robots" content="index,follow"/>
<title>${esc(title)} — W flow</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header class="site">
  <a class="brand" href="${app}" title="${backLabel}">W <span class="dot">flow</span> <span class="tag">LEGAL</span></a>
  <a class="back" href="${app}">← ${backLabel}</a>
  <nav class="docs" aria-label="Legal documents">${docNav(docKey, lang)}</nav>
  <div class="langs" aria-label="Language">${langLinks(lang)}</div>
</header>
<main>
${body}
</main>
<footer class="site">
  © ${year} ${company} · ${back}
</footer>
</body>
</html>`;
}

function indexBody(lang, values, domain) {
  const t = {
    de: { kicker: "RECHTLICHES", h1: "Rechtliche Informationen", intro: "Auf dieser Seite finden Sie die rechtlichen Informationen zu diesem Dienst. Bitte lesen Sie die Dokumente in der für Sie geltenden Fassung.", cards: [["Impressum", "Angaben zum Betreiber gemäß § 5 DDG.", "/impressum"], ["Datenschutz", "Informationen zur Verarbeitung personenbezogener Daten (DSGVO).", "/datenschutz"]] },
    en: { kicker: "LEGAL", h1: "Legal information", intro: "This page provides the legal information for this service. Please read the documents in the version that applies to you.", cards: [["Imprint", "Operator information pursuant to § 5 DDG.", "/impressum"], ["Privacy Policy", "How we process personal data (GDPR).", "/datenschutz"]] },
    ru: { kicker: "ПРАВОВАЯ ИНФОРМАЦИЯ", h1: "Правовая информация", intro: "На этой странице размещена правовая информация о данном сервисе. Пожалуйста, ознакомьтесь с документами в действующей редакции.", cards: [["Импрессум", "Информация об операторе в соответствии с § 5 DDG.", "/impressum"], ["Политика конфиденциальности", "Как мы обрабатываем персональные данные (GDPR).", "/datenschutz"]] },
  }[lang];
  return `<div class="kicker" style="color:var(--faint);font-size:12px;letter-spacing:2px">${t.kicker}</div>
<h1>${t.h1}</h1>
<p class="intro">${t.intro}</p>
<div class="cards">
${t.cards.map(([name, desc, href]) => `<div class="card"><h3>${name}</h3><p>${desc}</p><a href="${href}">${name} →</a></div>`).join("\n")}
</div>`;
}

function notFoundBody(lang) {
  const msg = {
    de: "Diese Seite wurde nicht gefunden. Wählen Sie ein Dokument aus dem Menü oben.",
    en: "This page was not found. Choose a document from the menu above.",
    ru: "Страница не найдена. Выберите документ в меню выше.",
  }[lang];
  return `<div class="notfound">404</div><h1>${msg}</h1>`;
}

// One document section: a heading plus paragraphs and (optional) bullet lists.
// A section whose every block was dropped by an empty optional token is omitted
// entirely — that is how the conditional parts of the privacy policy vanish.
function renderSection(s, values, lang) {
  const parts = [];
  for (const block of s.body || s.p || []) {
    if (typeof block === "string") {
      const html = fillBlock(block, values, lang);
      if (html !== null) parts.push(`<p>${html}</p>`);
    } else if (Array.isArray(block.list)) {
      const items = block.list.map((li) => fillBlock(li, values, lang)).filter((li) => li !== null);
      if (items.length) parts.push(`<ul>${items.map((li) => `<li>${li}</li>`).join("\n")}</ul>`);
    }
  }
  if (!parts.length) return "";
  return `<section class="doc"><h2>${fill(s.h, values, lang)}</h2>${parts.join("\n")}</section>`;
}

function renderDocPage(docKey, lang, values, appUrl, res) {
  const doc = DOCS[docKey][lang];
  const parts = [`<h1>${doc.title}</h1>`];
  if (doc.subtitle) parts.push(`<p class="updated">${fill(doc.subtitle, values, lang)}</p>`);
  if (doc.intro) parts.push(`<p class="intro">${fill(doc.intro, values, lang)}</p>`);
  if (doc.blocks) {
    const rows = doc.blocks
      .map((b) => {
        // a row is kept only when its value survives; a label may also act as
        // the gate for the whole row (e.g. "{{?registerCourt}}Registereintrag")
        const value = fillBlock(b.value, values, lang);
        const label = b.label ? fillBlock(b.label, values, lang) : "";
        if (value === null || label === null) return "";
        return `<tr><td>${label}</td><td>${value}</td></tr>`;
      })
      .filter(Boolean);
    parts.push(`<table class="impressum-table">\n${rows.join("\n")}\n</table>`);
  }
  if (doc.sections) parts.push(doc.sections.map((s) => renderSection(s, values, lang)).join("\n"));
  if (doc.notes) parts.push(doc.notes.map((n) => `<p class="impressum-note">${fill(n, values, lang)}</p>`).join("\n"));
  res.status(200).send(shell({ lang, docKey, title: doc.title, body: parts.join("\n"), values, appUrl }));
}

function pickLang(req, res) {
  const q = String(req.query?.lang || "").toLowerCase();
  if (LEGAL_LANGS.includes(q)) {
    // remember the choice on every page the visitor switches on
    res.setHeader("Set-Cookie", `${LEGAL_COOKIE}=${q}; Path=/; Max-Age=31536000; SameSite=Lax`);
    return q;
  }
  const c = String(req.cookies?.[LEGAL_COOKIE] || "").toLowerCase();
  return LEGAL_LANGS.includes(c) ? c : LEGAL_DEFAULT_LANG;
}

// Render one legal document (Impressum / Datenschutz) for the current request.
// Used at root paths on the main site (/impressum, /datenschutz), on the
// /legal/* alias, and on the legal subdomain.
export function legalDocHandler(docKey) {
  return async (req, res) => {
    const cfg = await legalConfig();
    const lang = pickLang(req, res);
    renderDocPage(docKey, lang, cfg.values, cfg.appUrl, res);
  };
}

// ---------------------------------------------------------------------------
// Express router — used on the legal subdomain (mounted at /) and as the
// /legal/* alias on the main site. Every request ends here with a response.
// ---------------------------------------------------------------------------
export function legalRouter() {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const cfg = await legalConfig();
    const lang = pickLang(req, res);
    const title = { de: "Rechtliche Informationen", en: "Legal information", ru: "Правовая информация" }[lang];
    res.status(200).send(shell({ lang, docKey: null, title, body: indexBody(lang, cfg.values, cfg.domain), values: cfg.values, appUrl: cfg.appUrl }));
  });

  router.get(["/impressum", "/imprint"], legalDocHandler("impressum"));
  router.get(["/datenschutz", "/privacy"], legalDocHandler("datenschutz"));

  // anything else on the legal site — a real 404 page, never the app
  router.use(async (req, res) => {
    const cfg = await legalConfig();
    const lang = pickLang(req, res);
    const title = { de: "Nicht gefunden", en: "Not found", ru: "Не найдено" }[lang];
    res.status(404).send(shell({ lang, docKey: null, title, body: notFoundBody(lang), values: cfg.values, appUrl: cfg.appUrl }));
  });

  return router;
}
