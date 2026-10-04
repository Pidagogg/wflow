// ============================================================================
// W FLOW — SEO & GEO (generative engine optimization) settings
//
// One place that reads the operator's search-engine and AI-crawler settings
// from the shared settings table, so the main server (meta tags, robots.txt,
// llms.txt) and the admin panel (the SEO & GEO tab) agree on the same keys.
//
// SEO  — the classic search engine surface: title, meta description, keywords,
//        Open Graph / Twitter card, canonical domain, verification codes and an
//        optional "no-index" switch plus extra head HTML.
// GEO  — the generative-engine surface: an llms.txt summary that AI answer
//        engines can read, a small list of citable facts, and a switch for
//        whether AI crawlers (GPTBot, ClaudeBot, PerplexityBot, …) may index
//        the site at all.
//
// Values live in the DB as `seo.*` / `geo.*` keys (editable at runtime in the
// admin panel); every field also falls back to an env var:
//   BF_SEO_TITLE, BF_SEO_DESCRIPTION, BF_SEO_KEYWORDS, BF_SEO_OG_IMAGE,
//   BF_SEO_TWITTER, BF_SEO_INDEX, BF_SEO_GOOGLE_VERIFICATION,
//   BF_SEO_BING_VERIFICATION, BF_SEO_EXTRA_HEAD, BF_GEO_LLMS,
//   BF_GEO_SUMMARY, BF_GEO_FACTS, BF_GEO_AI_CRAWLERS
// ============================================================================
import { db } from "./dbx.js";

const KEY = (field) => `seo.${field}`;

/** Every editable field, in the order the admin panel shows them. */
export const SEO_FIELDS = [
  "title",
  "description",
  "keywords",
  "ogImage",
  "twitter",
  "indexable",
  "googleVerification",
  "bingVerification",
  "robotsExtra",
  "extraHead",
  "llmsEnabled",
  "llmsSummary",
  "llmsFacts",
  "aiCrawlers",
];

const ENV = {
  title: "BF_SEO_TITLE",
  description: "BF_SEO_DESCRIPTION",
  keywords: "BF_SEO_KEYWORDS",
  ogImage: "BF_SEO_OG_IMAGE",
  twitter: "BF_SEO_TWITTER",
  indexable: "BF_SEO_INDEX",
  googleVerification: "BF_SEO_GOOGLE_VERIFICATION",
  bingVerification: "BF_SEO_BING_VERIFICATION",
  robotsExtra: "BF_SEO_ROBOTS_EXTRA",
  extraHead: "BF_SEO_EXTRA_HEAD",
  llmsEnabled: "BF_GEO_LLMS",
  llmsSummary: "BF_GEO_SUMMARY",
  llmsFacts: "BF_GEO_FACTS",
  aiCrawlers: "BF_GEO_AI_CRAWLERS",
};

// Boolean fields default to ON: a fresh install is indexable and readable by AI
// answer engines, and the operator switches either off on purpose.
const BOOL_DEFAULT_ON = new Set(["indexable", "llmsEnabled", "aiCrawlers"]);

const asBool = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === true;
};

/** Read the whole SEO/GEO configuration (DB settings, with env fallbacks). */
export async function seoConfig() {
  const out = {};
  for (const field of SEO_FIELDS) {
    let raw;
    try {
      raw = await db.storeGet(KEY(field));
    } catch {
      raw = "";
    }
    if (!raw) raw = process.env[ENV[field]] || "";
    out[field] = BOOL_DEFAULT_ON.has(field)
      ? asBool(raw, true)
      : String(raw || "");
  }
  return out;
}

/** Persist the SEO/GEO configuration from the admin panel. */
export async function saveSeoConfig(body = {}) {
  for (const field of SEO_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    if (BOOL_DEFAULT_ON.has(field)) {
      await db.storeSet(KEY(field), asBool(v, true) ? "1" : "0");
    } else {
      await db.storeSet(KEY(field), String(v ?? "").slice(0, 4000));
    }
  }
  return seoConfig();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * The <meta> block for the public pages. `domain` is the configured public
 * host (may be empty on a fresh install — the tags then simply omit the URL).
 */
// Used whenever the admin panel's SEO & GEO fields are left empty. Written for
// what people search for ("workflow automation", "n8n / Zapier alternative")
// and kept within the lengths Google shows (~60 / ~155 characters).
export const DEFAULT_TITLE = "Workflow Automation & AI Agent Builder";
export const DEFAULT_DESCRIPTION =
  "Build automations and AI agents on a visual canvas. 400+ integrations, your own AI models. Privacy first: you decide what is stored and shared. Free.";
export const DEFAULT_KEYWORDS =
  "workflow automation, AI agent builder, n8n alternative, Zapier alternative, Make alternative, no-code automation, self-hosted automation, low-code, integrations";

export function seoMetaTags(cfg, { domain = "", siteName = "W flow", tagline = "", path: pagePath = "/" } = {}) {
  const title = cfg.title || `${siteName} — ${tagline || DEFAULT_TITLE}`;
  const description = cfg.description || tagline || DEFAULT_DESCRIPTION;
  const keywords = cfg.keywords || DEFAULT_KEYWORDS;
  const url = domain ? `https://${domain}${pagePath}` : "";
  // 1200×630 share card (public/og-image.png) — the square logo looked lost
  // in link previews.
  const image = cfg.ogImage || (domain ? `https://${domain}/og-image.png` : "");
  const customImage = !!cfg.ogImage;
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
  ];
  tags.push(`<meta name="keywords" content="${esc(keywords)}" />`);
  tags.push(
    cfg.indexable
      ? `<meta name="robots" content="index,follow,max-image-preview:large" />`
      : `<meta name="robots" content="noindex,nofollow" />`
  );
  if (url) tags.push(`<link rel="canonical" href="${esc(url)}" />`);
  // Open Graph
  tags.push(`<meta property="og:type" content="website" />`);
  tags.push(`<meta property="og:site_name" content="${esc(siteName)}" />`);
  tags.push(`<meta property="og:title" content="${esc(title)}" />`);
  tags.push(`<meta property="og:description" content="${esc(description)}" />`);
  if (url) tags.push(`<meta property="og:url" content="${esc(url)}" />`);
  tags.push(`<meta property="og:locale" content="en_US" />`);
  if (image) {
    tags.push(`<meta property="og:image" content="${esc(image)}" />`);
    // the size is only known for the built-in card
    if (!customImage) tags.push(`<meta property="og:image:width" content="1200" />`, `<meta property="og:image:height" content="630" />`);
    tags.push(`<meta property="og:image:alt" content="${esc(`${siteName} — workflow automation and AI agents on a visual canvas`)}" />`);
  }
  // Twitter card
  tags.push(`<meta name="twitter:card" content="summary_large_image" />`);
  if (cfg.twitter) tags.push(`<meta name="twitter:site" content="${esc(cfg.twitter)}" />`);
  tags.push(`<meta name="twitter:title" content="${esc(title)}" />`);
  tags.push(`<meta name="twitter:description" content="${esc(description)}" />`);
  if (image) tags.push(`<meta name="twitter:image" content="${esc(image)}" />`);
  tags.push(`<meta name="theme-color" content="#0a0f1d" />`);
  tags.push(`<link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt" />`);
  // verification codes
  if (cfg.googleVerification) tags.push(`<meta name="google-site-verification" content="${esc(cfg.googleVerification)}" />`);
  if (cfg.bingVerification) tags.push(`<meta name="msvalidate.01" content="${esc(cfg.bingVerification)}" />`);
  // operator-supplied extra head HTML (trusted: only the admin panel can set it)
  if (cfg.extraHead) tags.push(String(cfg.extraHead));
  return tags.join("\n    ");
}

/**
 * AI crawler / answer-engine directives appended to robots.txt. When AI access
 * is switched off, the well-known crawlers are disallowed explicitly (a plain
 * `User-agent: *` rule is often ignored by them).
 */
export function aiCrawlerRules(allow = true) {
  const bots = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "anthropic-ai",
    "PerplexityBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
    "Bytespider",
    "Amazonbot",
    "meta-externalagent",
  ];
  const lines = [
    "",
    "# ---------------------------------------------------------------------------",
    "# Generative engine optimization (GEO) — AI crawler policy",
    "# Toggle this in the admin panel under SEO & GEO.",
    "# ---------------------------------------------------------------------------",
  ];
  for (const bot of bots) {
    lines.push(`User-agent: ${bot}`);
    lines.push(allow ? "Allow: /" : "Disallow: /");
    lines.push("");
  }
  if (allow) lines.push("# llms.txt for AI answer engines: /llms.txt");
  return lines.join("\n");
}

/** Replace the YOUR-DOMAIN placeholder and append the operator's extra rules. */
export function renderRobots(base, cfg, domain = "") {
  let text = String(base || "").replace(/YOUR-DOMAIN/g, domain || "YOUR-DOMAIN");
  if (!cfg.indexable) {
    // Rewrite the base "Allow: /" rules instead of appending a second
    // `User-agent: *` group — crawlers merge groups for the same agent and
    // Google lets the Allow win a tie, so an appended Disallow did nothing.
    text = text.replace(/^Allow:\s*\/\s*$/gm, "Disallow: /");
    text = text.trimEnd() + "\n\n# The operator switched search indexing off (admin panel → SEO & GEO).";
  }
  const parts = [text.trimEnd()];
  // With indexing off the AI crawlers are shut out too.
  parts.push(aiCrawlerRules(cfg.aiCrawlers && cfg.indexable));
  if (cfg.robotsExtra) parts.push("", "# Operator rules", String(cfg.robotsExtra));
  return parts.join("\n") + "\n";
}

/**
 * The llms.txt document: a short markdown summary of the site that generative
 * engines can quote. Built from the operator's summary + facts, with sensible
 * defaults so the file is useful even before it is filled in.
 */
export function renderLlmsTxt(cfg, { domain = "", siteName = "W flow", tagline = "", guides = [], nodeCount = 0, beta = false } = {}) {
  if (!cfg.llmsEnabled) return "";
  const url = domain ? `https://${domain}` : "";
  const summary =
    cfg.llmsSummary ||
    tagline ||
    "W flow is a visual workflow automation and AI agent builder — an alternative to n8n, Zapier and Make. Users connect triggers, actions, logic and AI nodes on a canvas. It runs as a hosted cloud workspace or as a self-hosted copy on the user's own server; workflows and encrypted credentials are stored in the instance's own database.";
  const lines = [`# ${siteName}`, "", `> ${summary}`, ""];
  if (cfg.llmsFacts) {
    lines.push("## Key facts", "");
    for (const line of String(cfg.llmsFacts).split("\n")) {
      const fact = line.trim().replace(/^[-*]\s*/, "");
      if (fact) lines.push(`- ${fact}`);
    }
    lines.push("");
  } else {
    lines.push(
      "## Key facts",
      "",
      "- Visual workflow builder with a node canvas: triggers, actions, logic, file and AI nodes.",
      `- ${nodeCount ? `${nodeCount} node types` : "Hundreds of node types"}, including Gmail, Google Sheets, Google Drive, Google Calendar, Outlook, OneDrive, Slack, Telegram, Discord, GitHub, Notion, Airtable, Stripe, HubSpot, databases, RSS and a generic HTTP Request node for any API.`,
      "- Triggers: webhooks, schedules (cron), chat, forms, RSS feeds, Telegram bots; the server runs them without the editor open.",
      "- AI: chat models, AI agents with tools, structured data extraction, embeddings and vector search. Bring your own model: OpenAI-compatible, Anthropic, Gemini, local or custom endpoints — no AI markup.",
      "- Google and Microsoft accounts are connected with one click (OAuth) instead of passwords or pasted tokens; access renews automatically.",
      "- Every run is inspectable: input, output, duration and a classified error code (BF-xxxx) per node.",
      "- Credentials are encrypted at rest (AES-256-GCM) in the instance's own database (SQLite or PostgreSQL).",
      "- Pricing: a free plan with limits on workflows and daily runs; Pro removes the limits, adds always-on background execution and the self-hosted installer (Windows, macOS, Linux).",
      ...(beta ? ["- Status: open beta — features may still change."] : []),
      ""
    );
  }
  // For agents that should BUILD workflows, not just describe the product.
  lines.push(
    "## Building workflows (for AI agents)",
    "",
    "Workflows are plain JSON (nodes, edges and {{placeholders}}). Read the reference before writing one — it covers the JSON format, how data moves between nodes, what every node accepts and outputs, and complete examples.",
    "",
    `- [Workflow reference for AI agents](${url}/docs/workflow-reference.md): format, engine rules, placeholders, examples and the full node catalog`,
    `- [Workflow JSON Schema](${url}/schema/workflow.schema.json): machine-checkable schema of a workflow file`,
    `- MCP server: ${url || ""}/mcp (Streamable HTTP, "Authorization: Bearer <token>" from Settings → AI tools) — run workflows offered as tools, and list, read, validate, create, update and run workflows`,
    ""
  );
  if (guides.length) {
    lines.push("## Guides", "");
    for (const g of guides) lines.push(`- [${g.title}](${url}${g.path}): ${g.description}`);
    lines.push("");
  }
  lines.push(
    "## FAQ",
    "",
    "### What is W flow?",
    "A visual builder for workflow automations and AI agents. You connect nodes on a canvas — for example a webhook, a Google Sheets row and a Slack message — and the server runs the workflow for you.",
    "",
    "### How is W flow different from n8n, Zapier or Make?",
    "Like n8n it can be self-hosted; like Zapier and Make it can be used as a hosted cloud service. It lets you bring your own AI model and key, connects Google and Microsoft accounts with one click, and shows every run node by node. Its integration catalogue is smaller than Zapier's; a generic HTTP node covers other APIs.",
    "",
    "### Is W flow free?",
    "Yes, there is a free plan with limits on the number of workflows and runs per day. The Pro plan removes the limits and includes self-hosting.",
    "",
    "### Can I run W flow on my own server?",
    "Yes. Pro accounts get a one-file installer for Windows, macOS and Linux; a Docker setup is available for servers. Data and credentials then stay on your machine.",
    "",
    "### Which AI models does W flow support?",
    "Any OpenAI-compatible endpoint, Anthropic, Google Gemini, local models (for example via Ollama or LM Studio) and custom endpoints, each with the user's own API key.",
    ""
  );
  if (url) {
    lines.push(
      "## Links",
      "",
      `- Product / landing page: ${url}/landing.html`,
      `- App: ${url}/`,
      `- Guides (how-tos): ${url}/guides (German: ${url}/de/guides)`,
      `- Full text of the guides for language models: ${url}/llms-full.txt`,
      `- Imprint: ${url}/impressum`,
      `- Privacy policy: ${url}/datenschutz`,
      `- Robots: ${url}/robots.txt`,
      ""
    );
  }
  return lines.join("\n");
}

// ---- crawlable home page ----
// The app is a single-page React bundle: without running JavaScript a crawler
// sees an empty <div id="root">. Google does render JS, but later and not
// always, and other engines and link previews often do not. So the home page
// ships a small static version of its hero inside #root (React replaces it on
// start) plus schema.org data describing the product.

/** JSON-LD for the home page: the product and who runs it. */
export function structuredData({ domain = "", siteName = "W flow", description = "" } = {}) {
  const url = domain ? `https://${domain}/` : undefined;
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: siteName,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, Windows, macOS, Linux",
      description,
      ...(url ? { url, image: `${url}logo.png` } : {}),
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: siteName,
      ...(url ? { url } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: siteName,
      ...(url ? { url, logo: `${url}logo-square.png` } : {}),
    },
  ];
  // "<" escaped so no value can close the script tag
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

/** Static hero shown until the app starts — and all a non-JS crawler reads. */
export function crawlableIntro({ siteName = "W flow", tagline = "", description = "" } = {}) {
  const h1 = tagline || "Build workflows and AI agents on your own server.";
  const features = [
    ["Visual workflows", "Start with a manual trigger, webhook or schedule, then connect actions and logic with inspectable run logs."],
    ["Flexible AI agents", "Bring an OpenAI-compatible, Anthropic, Gemini, local or custom model endpoint and configure tools in one place."],
    ["Hundreds of integrations", "Gmail, Google Sheets, Slack, Telegram, GitHub, Notion, Stripe, databases, files, RSS and many more nodes."],
    ["Cloud or self-hosted", "Use the hosted workspace or run the whole builder on your own machine with your own database and encryption key."],
  ];
  return (
    `<main style="max-width:880px;margin:0 auto;padding:64px 20px;font-family:system-ui,sans-serif;color:#e6ecff;background:#0a0f1d">` +
    `<p style="letter-spacing:2px;font-size:12px;color:#6f8cff">${esc(siteName.toUpperCase())} · SELF-HOSTED AUTOMATION</p>` +
    `<h1 style="font-size:40px;line-height:1.15;margin:8px 0 16px">${esc(h1)}</h1>` +
    `<p style="font-size:17px;line-height:1.6;color:#a9b6d0">${esc(description)}</p>` +
    `<ul style="line-height:1.6;color:#a9b6d0;padding-left:18px">` +
    features.map(([t, d]) => `<li><strong style="color:#e6ecff">${esc(t)}</strong> — ${esc(d)}</li>`).join("") +
    `</ul>` +
    `<p><a href="/landing.html" style="color:#6f8cff">Product overview</a> · <a href="/guides" style="color:#6f8cff">Guides</a> · <a href="/de/guides" style="color:#6f8cff">Anleitungen</a> · <a href="/impressum" style="color:#6f8cff">Impressum</a> · <a href="/datenschutz" style="color:#6f8cff">Datenschutz</a></p>` +
    `</main>`
  );
}

// ---- llms-full.txt ----
// llms.txt is the summary; llms-full.txt carries the complete text of the
// guides as markdown, so an answer engine can quote the steps without
// crawling each page.

/** Minimal HTML → markdown for the trusted guide bodies (server/guides.js). */
export function htmlToMarkdown(html) {
  return String(html || "")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|ul|ol|table|div|tr)>/gi, "\n")
    .replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, "| $1 ")
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderLlmsFullTxt(cfg, { domain = "", siteName = "W flow", guides = [], summaryDoc = "" } = {}) {
  if (!cfg.llmsEnabled) return "";
  const url = domain ? `https://${domain}` : "";
  const parts = [summaryDoc.trim(), "", "---", "", `# ${siteName} guides (full text)`, ""];
  for (const g of guides) {
    parts.push(`## ${g.title}`, "", `Source: ${url}${g.path}`, "", `> ${g.description}`, "", htmlToMarkdown(g.body).replace(/^## /gm, "### "), "", "---", "");
  }
  return parts.join("\n");
}

// ---- IndexNow ----
// Bing, Yandex, Seznam and Naver (and through Bing, ChatGPT search and
// DuckDuckGo) accept a push of changed URLs instead of waiting for a crawl.
// The key is generated once and kept in the settings table; the engines fetch
// /<key>.txt to confirm the site is ours.

export async function indexNowKey() {
  let key = "";
  try {
    key = String((await db.storeGet("seo.indexNowKey")) || "");
  } catch {
    return "";
  }
  if (!/^[a-f0-9]{32}$/.test(key)) {
    const { randomBytes } = await import("node:crypto");
    key = randomBytes(16).toString("hex");
    await db.storeSet("seo.indexNowKey", key);
  }
  return key;
}

/**
 * Submit the site's URLs to IndexNow when the list (or a guide's date)
 * changed since the last submission — typically once after a deploy that
 * added pages. Never throws; SEO pings must not affect the server.
 */
export async function submitIndexNow({ domain, urls }) {
  try {
    if (!domain || !urls?.length) return { skipped: "no domain" };
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256").update(JSON.stringify(urls)).digest("hex");
    if ((await db.storeGet("seo.indexNowSent")) === fingerprint) return { skipped: "unchanged" };
    const key = await indexNowKey();
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: domain, key, keyLocation: `https://${domain}/${key}.txt`, urlList: urls }),
    });
    // 200 = accepted, 202 = accepted, key check pending
    if (res.status === 200 || res.status === 202) {
      await db.storeSet("seo.indexNowSent", fingerprint);
      console.log(`  [seo] IndexNow: submitted ${urls.length} URL(s) (HTTP ${res.status})`);
    } else {
      console.log(`  [seo] IndexNow answered HTTP ${res.status} — will retry after the next restart`);
    }
    return { status: res.status };
  } catch (err) {
    console.log(`  [seo] IndexNow skipped: ${String(err?.message || err).slice(0, 120)}`);
    return { error: true };
  }
}
