// ----------------------------------------------------------------------------
// W FLOW — workflow executor
// Walks the node graph starting from trigger nodes, runs each node handler,
// passes items along edges (honouring source handles for branching nodes) and
// produces a detailed execution log.
// ----------------------------------------------------------------------------
import { getNodeDef, isTriggerType, defaultOnErrorFor } from "../shared/catalog.js";
import { mimeTypeFor, detectFileType } from "../shared/filetypes.js";
import { samplePayloadFor } from "../shared/samples.js";
import { resolvePath } from "../shared/paths.js";
import { ERROR_CODES, codeForError, attachCode } from "../shared/errors.js";
import { chatCompletion, embedText, extractStructured, generateImage, runAgent, normalizeUsage } from "./ai.js";
import { workflows, agents, vectors, searchVectors, datastore, hydrateAgentSecrets, hydrateSecretsInWorkflow } from "./store.js";
import { runSql, db, isReadOnlySql } from "./dbx.js";
import nodemailer from "nodemailer";
import pg from "pg";
import cronParser from "cron-parser";
import ExcelJS from "exceljs";
import QRCode from "qrcode";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { resolveFileInput, extractFileContent, createZipBuffer, convertToFormat, csvCell, parseRssFeed } from "./fileextract.js";
import { readFileBytes, writeFileBytes, listFilesOnDisk, fitsInFolder } from "./disk.js";
import { filesQuotaBytes } from "./quota.js";
import { runServiceNode } from "./service-exec.js";
import { runExchange } from "./crypto-exchanges.js";
import { runEvmWallet, runSolanaWallet } from "./crypto-wallets.js";
import { runPolymarket } from "./polymarket.js";
import { resolveRunPath, withRunContext, currentRunContext, loadRunVars, normalizeEnvironment, inTestEnvironment } from "./run-context.js";
import { checkSpend, recordSpend } from "./spend-limits.js";
import { writeSeries, publicBaseUrl } from "./dashboards.js";
import { accessTokenFor, scopePolicy } from "./oauth-connections.js";
import { telegramApi, botTokenFor } from "./telegram-bots.js";
import { runAsAccount, ACCOUNT_NODE_TYPES } from "./telegram-accounts.js";
import { OAUTH_FIELD_KEY, oauthSpecFor, scopesFor, injectionFor, connectAllowed, OAUTH_PROVIDERS } from "../shared/oauth.js";
import { exec as execCb, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { runSandboxedCode } from "./code-sandbox.js";
import { assertPublicHttpUrl, safeFetch } from "./ssrf.js";

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

// ----------------------------------------------------------------------------
// System-command nodes (Execute Command, SSH, FTP/SFTP, Git, Docker) run local
// programs and so can reach the whole host. They are ALL off unless the operator
// opts in with BF_ALLOW_COMMANDS=1 — the cloud never sets it, so a signed-in
// account there can neither run shell commands nor smuggle one in through the
// Git/SSH/FTP/Docker arguments. Self-hosters who trust their own users turn it
// on. (Historically only Execute Command checked this, which left the other
// four as an RCE hole on the cloud.)
// ----------------------------------------------------------------------------
function assertCommandsAllowed(nodeName) {
  if (process.env.BF_ALLOW_COMMANDS === "1" || process.env.BF_ALLOW_COMMANDS === "true") return;
  throw attachCode(
    new Error(`${nodeName} is disabled on this server because it can run programs on the host. The operator can enable it with BF_ALLOW_COMMANDS=1.`),
    "MISSING_CONFIG"
  );
}

// A value that an external program would read as an option (leading "-") lets a
// crafted host/user/argument turn into a flag — e.g. ssh's -oProxyCommand= or
// git's -c core.sshCommand=, both of which run arbitrary commands. Reject those.
function rejectOptionLike(value, label) {
  if (/^-/.test(String(value || ""))) {
    throw attachCode(new Error(`${label} must not start with "-".`), "MISSING_CONFIG");
  }
  return String(value);
}

const MAX_ITEMS_IN_LOG = 5;
const MAX_TEXT_LENGTH = 4000;

// Maximum number of items shown per node in the log; the client can override
// this via the run request body ({ maxItemsPerNode }) to match the user's app
// setting (Settings → Maximum log items per node).
const DEFAULT_MAX_ITEMS = 5;

// ----------------------------------------------------------------------------
// SSRF guard — private / internal URL blocking. The implementation lives in
// server/ssrf.js (shared with ai.js and the scheduler); re-exported here so the
// many call sites in this file, and importers that reach it through the
// executor, keep working unchanged.
// ----------------------------------------------------------------------------
export { assertPublicHttpUrl, safeFetch };

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function truncate(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return s.length > MAX_TEXT_LENGTH ? s.slice(0, MAX_TEXT_LENGTH) + "\n… [truncated]" : s;
}

// Fake-value generators for the Random Data node (n8n-style test data).
const FAKE_FIRST = ["Ada", "Grace", "Linus", "Alan", "Margaret", "Dennis", "Barbara", "Ken", "Radia", "Guido", "Brendan", "Yukihiro"];
const FAKE_LAST = ["Lovelace", "Hopper", "Torvalds", "Turing", "Hamilton", "Ritchie", "Liskov", "Thompson", "Perlman", "van Rossum", "Eich", "Matsumoto"];
const FAKE_WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "nova", "flux", "pulse", "drift"];
function randomValue(type) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const n = (max) => Math.floor(Math.random() * max);
  switch (type) {
    case "name":
      return `${pick(FAKE_FIRST)} ${pick(FAKE_LAST)}`;
    case "email":
      return `${pick(FAKE_FIRST).toLowerCase()}.${pick(FAKE_LAST).toLowerCase()}${n(99)}@example.com`;
    case "phone":
      return `+1${String(n(1e10)).padStart(10, "0")}`;
    case "word":
      return pick(FAKE_WORDS);
    case "sentence":
      return `The quick brown fox jumps over the lazy dog ${n(1000)}`;
    case "number":
      return n(10000);
    case "boolean":
      return Math.random() < 0.5;
    case "date":
      return new Date(Date.now() - n(1e12)).toISOString();
    case "uuid":
      return randomUUID();
    case "color":
      return `#${n(0xffffff).toString(16).padStart(6, "0")}`;
    case "ip":
      return `${n(256)}.${n(256)}.${n(256)}.${n(256)}`;
    default:
      return `value-${n(1e6)}`;
  }
}

function renderTemplate(template, item) {
  if (typeof template !== "string") return template;
  const json = item?.json || {};
  // {{$vars.NAME}} / {{$env}} come from the run's context (server/run-context.js).
  return template.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, path) => {
    const runValue = resolveRunPath(path);
    const val = runValue !== undefined ? runValue : resolvePath(json, path);
    if (val === undefined || val === null) return "";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });
}

// "Field with the file" on the file nodes holds a field NAME, but dragging a
// field in from INPUT drops a {{template}} there (sometimes with a stray brace
// left over). A lone template is read as the field path it names; any other
// text with templates is rendered and used as the file's text content.
function fileInputConfig(c, item) {
  const raw = String(c.sourceField ?? "");
  if (!raw.includes("{{")) return c;
  const lone = raw.match(/^[\s{}]*\{\{\s*([\w.$]+)\s*\}\}[\s{}]*$/);
  if (lone) return { ...c, sourceField: lone[1].replace(/^\$json\./, "") };
  return { ...c, sourceField: "", sourceValue: renderTemplate(raw, item) };
}

// The node error for a payload field that held no file — names the field it
// read and the fields the item does have, so the fix is in the message itself.
function missingFileFieldError(message, c, item) {
  const keys = Object.keys(item?.json || {});
  const field = String(c.sourceField || "").trim();
  const looked = field ? ` (looked in "${field}")` : "";
  const has = keys.length
    ? ` The incoming item has: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""}.`
    : " The incoming item is empty.";
  return attachCode(new Error(`${message}${looked}.${has}`), "FILE_CONTENT_MISSING");
}

// ----------------------------------------------------------------------------
// Token usage accounting
//
// Every provider reports its token counts in a slightly different shape (OpenAI
// `prompt_tokens`/`completion_tokens`, Anthropic `input_tokens`/`output_tokens`),
// so each AI node normalises its usage and hands it back with the items; the
// graph walker adds it to the run's running total and keeps the per-node figure
// in the log entry. That is what powers the token / cost view in the Log
// console and the estimated AI spend on the Main page.
// ----------------------------------------------------------------------------
function mergeUsage(list) {
  const acc = { prompt: 0, completion: 0, total: 0 };
  let any = false;
  const models = new Set();
  for (const raw of list || []) {
    const usage = normalizeUsage(raw);
    if (!usage) continue;
    any = true;
    acc.prompt += usage.prompt;
    acc.completion += usage.completion;
    acc.total += usage.total;
    const model = String(raw?.model || "").trim();
    if (model) models.add(model);
  }
  if (!any) return null;
  // Keep the model when every call in this node used the same one — it is what
  // the cost estimate prices the node's tokens with.
  return models.size === 1 ? { ...acc, model: [...models][0] } : acc;
}

function addRunUsage(ctx, rawUsage) {
  const usage = normalizeUsage(rawUsage);
  if (!usage) return null;
  const total = ctx.aiUsage || (ctx.aiUsage = { prompt: 0, completion: 0, total: 0, calls: 0 });
  total.prompt += usage.prompt;
  total.completion += usage.completion;
  total.total += usage.total;
  total.calls += 1;
  return usage;
}

function parseJsonField(str, fallback) {
  if (str === undefined || str === null || str === "") return fallback ?? {};
  try {
    return JSON.parse(str);
  } catch {
    return fallback ?? {};
  }
}

// Render a Webhook Respond node's body and parse it as JSON. AI replies often
// contain literal double quotes, newlines or backslashes, which would break a
// plain JSON.parse of the rendered template — so a {{field}} standing alone
// inside quotes is first interpolated as a properly escaped JSON string.
function renderRespondBody(template, item) {
  const json = item?.json || {};
  const valueOf = (path) => {
    const runValue = resolveRunPath(path);
    return runValue !== undefined ? runValue : resolvePath(json, path);
  };
  // "{{field}}" → the value JSON-escaped (handles quotes/newlines/backslashes)
  const escaped = String(template).replace(/"\{\{\s*([\w.$]+)\s*\}\}"/g, (_, path) => {
    const val = valueOf(path);
    return JSON.stringify(val === undefined || val === null ? "" : val);
  });
  try {
    return JSON.parse(escaped);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(renderTemplate(template, item));
  } catch {
    return undefined; // not JSON → caller sends the raw rendered string
  }
}

function sleep(ms, signal) {
  // Interruptible sleep — resolves early (without erroring) when the run's
  // AbortController fires, so a Stop button halts a Wait node immediately
  // instead of waiting out the whole delay.
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

// ----------------------------------------------------------------------------
// Named files — "Save output as file" on a node registers its output under a
// name; a downstream Extract File node can request that file by name. Files
// live in runCtx.files (a Map scoped to one workflow run).
// ----------------------------------------------------------------------------

// Turn a node's output items into a file buffer. Prefers explicit binary
// payloads (Word/Excel nodes emit fileBase64), then table rows → CSV, then
// extracted text, then structured data → JSON, then a generic JSON dump.
function serializeOutputToFile(items, fileName) {
  const json = items.length === 1 ? items[0]?.json : null;
  if (json) {
    if (typeof json.fileBase64 === "string" && json.fileBase64) {
      return { data: Buffer.from(json.fileBase64, "base64"), mimeType: mimeTypeFor(fileName) };
    }
    if (json.rows !== undefined && json.rows !== null) {
      const rows = jsonToRows(json.rows);
      if (rows.length) {
        const csv = rows.map((r) => (Array.isArray(r) ? r.map(csvCell).join(",") : csvCell(r))).join("\n");
        return { data: Buffer.from(csv, "utf8"), mimeType: "text/csv" };
      }
    }
    if (typeof json.text === "string") {
      return { data: Buffer.from(json.text, "utf8"), mimeType: mimeTypeFor(fileName) };
    }
    if (json.structured !== undefined) {
      return { data: Buffer.from(JSON.stringify(json.structured, null, 2), "utf8"), mimeType: "application/json" };
    }
    if (typeof json.html === "string") {
      return { data: Buffer.from(json.html, "utf8"), mimeType: "text/html" };
    }
    // HTTP node shape: { status, headers, data } — save the raw body when it is text
    if (typeof json.data === "string" && json.data) {
      return { data: Buffer.from(json.data, "utf8"), mimeType: mimeTypeFor(fileName) };
    }
  }
  const text = items.length === 1 ? JSON.stringify(items[0].json, null, 2) : JSON.stringify(items.map((i) => i.json), null, 2);
  return { data: Buffer.from(text, "utf8"), mimeType: mimeTypeFor(fileName) };
}

// Default unique file name for a node's output — every node's output is
// registered as a named file so a downstream node can pick "a real file" as its
// input (or a field out of it). The name is deterministic per node: readable
// label + short node id + an extension matching the payload shape.
function defaultOutputFileName(node, items) {
  const label = String(node?.data?.label || node?.id || "node")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "output";
  const shortId = String(node?.id || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-10);
  const first = items?.[0]?.json;
  let ext = "json";
  if (first && typeof first === "object") {
    if (typeof first.fileBase64 === "string" && first.fileName) ext = String(first.fileName).split(".").pop()?.toLowerCase() || "bin";
    else if (first.rows !== undefined) ext = "csv";
    else if (typeof first.text === "string") ext = "txt";
    else if (typeof first.html === "string") ext = "html";
  }
  return `${label}-${shortId || "out"}.${ext}`;
}

// Register a node's output as a named file. With an explicit "Save output as
// file" name (config.outputFile) that name is used; otherwise every node gets a
// default unique file name so downstream nodes can always consume its output as
// a real file. Returns the list of files written so the run log can show them.
function registerOutputFiles(node, items, ctx) {
  const c = node?.data?.config || {};
  if (!ctx?.files || !items?.length) return [];
  const name = String(c.outputFile || defaultOutputFileName(node, items)).trim();
  if (!name) return [];
  // Don't register a named file from items that soft-failed (error fields set).
  const okItems = items.filter(
    (it) =>
      !it.json?.error &&
      !it.json?.extractionError &&
      it.json?.compressed !== false &&
      it.json?.written !== false &&
      it.json?.converted !== false
  );
  if (!okItems.length) return [];
  const rendered = renderTemplate(name, okItems[0]);
  if (!rendered) return [];
  // A node's own handler may already have registered this exact file (e.g. the
  // QR Code node writes a binary PNG). Don't clobber it with a text copy.
  if (ctx.files.get(rendered)?.sourceNodeId === node.id) return [];
  const { data, mimeType } = serializeOutputToFile(okItems, rendered);
  ctx.files.set(rendered, { name: rendered, data, mimeType, sourceNodeId: node.id, size: data.length });
  return [{ name: rendered, mimeType, size: data.length }];
}

async function uploadToOneDrive(token, path, content, contentType) {
  const cleanPath = String(path).replace(/^\/+/, "");
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${cleanPath}:/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: content,
  });
  const data = await res.json().catch(() => ({}));
  return { uploaded: res.ok, status: res.status, webUrl: data.webUrl, error: data.error?.message };
}

function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : String(text);
  const start = candidate.search(/[{\[]/);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  try {
    return JSON.parse(candidate.slice(start));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Input preprocessing — the node config modal lets the user choose what the
// node consumes (whole payload / one field / parsed JSON / CSV / raw text).
// ----------------------------------------------------------------------------
function getPath(obj, path) {
  return String(path || "")
    .split(".")
    .reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setPathIn(obj, path, value) {
  const keys = String(path || "").split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined || typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (last) cur[last] = value;
  return obj;
}

// ----------------------------------------------------------------------------
// Helpers for the extra core nodes (HTML / Markdown / XML / Redis / CLI)
// ----------------------------------------------------------------------------
function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let inList = false;
  const flushList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of String(md).split(/\r?\n/)) {
    const t = line.trim();
    if (/^[-*+]\s+/.test(t)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(t.replace(/^[-*+]\s+/, ""))}</li>`);
      continue;
    }
    flushList();
    if (!t) continue;
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    out.push(`<p>${inline(t)}</p>`);
  }
  flushList();
  return out.join("\n");
}

function htmlToMarkdown(html) {
  let s = String(html);
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n").replace(/<\s*\/p\s*>/gi, "\n\n");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `${"#".repeat(Number(l))} ${t.trim()}\n\n`);
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  s = s.replace(/<[^>]+>/g, "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function parseXml(text, opts = {}) {
  const attributePrefix = opts.attributePrefix || "@";
  const textKey = opts.textKey || "#text";
  const src = String(text).replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  let i = 0;
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  function element() {
    i++;
    let name = "";
    while (i < src.length && !/[\s/>]/.test(src[i])) name += src[i++];
    const obj = {};
    let selfClose = false;
    while (i < src.length) {
      skipWs();
      if (src[i] === "/") {
        selfClose = true;
        i++;
        if (src[i] === ">") i++;
        break;
      }
      if (src[i] === ">") {
        i++;
        break;
      }
      let an = "";
      while (i < src.length && !/[\s=/>]/.test(src[i])) an += src[i++];
      skipWs();
      let av = "";
      if (src[i] === "=") {
        i++;
        skipWs();
        const q = src[i];
        if (q === '"' || q === "'") {
          i++;
          while (i < src.length && src[i] !== q) av += src[i++];
          i++;
        } else {
          while (i < src.length && !/[\s/>]/.test(src[i])) av += src[i++];
        }
      }
      if (an) obj[attributePrefix + an] = av;
    }
    if (selfClose) return [name, obj];
    let textVal = "";
    const kids = [];
    while (i < src.length) {
      if (src[i] === "<") {
        if (src[i + 1] === "/") {
          while (i < src.length && src[i] !== ">") i++;
          i++;
          break;
        }
        if (src.startsWith("<![CDATA[", i)) {
          const end = src.indexOf("]]>", i);
          textVal += src.slice(i + 9, end);
          i = end + 3;
          continue;
        }
        if (src[i + 1] === "!") {
          while (i < src.length && src[i] !== ">") i++;
          i++;
          continue;
        }
        kids.push(element());
      } else {
        textVal += src[i++];
      }
    }
    if (textVal.trim()) obj[textKey] = textVal.trim();
    for (const [k, v] of kids) {
      if (obj[k] === undefined) obj[k] = v;
      else if (Array.isArray(obj[k])) obj[k].push(v);
      else obj[k] = [obj[k], v];
    }
    return [name, obj];
  }
  skipWs();
  while (i < src.length && src[i] !== "<") i++;
  const [, root] = element();
  return root;
}

function buildXml(value, rootName = "root") {
  const esc = (s) => String(s).replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));
  const node = (name, val) => {
    if (val === null || val === undefined) return `<${name}/>`;
    if (Array.isArray(val)) return val.map((v) => node(name, v)).join("");
    if (typeof val === "object") {
      let attrs = "";
      let inner = "";
      for (const [k, v] of Object.entries(val)) {
        if (k.startsWith("@")) attrs += ` ${k.slice(1)}="${esc(v)}"`;
        else if (k === "#text") inner += esc(v);
        else inner += node(k, v);
      }
      return `<${name}${attrs}>${inner}</${name}>`;
    }
    return `<${name}>${esc(val)}</${name}>`;
  };
  const header = '<?xml version="1.0" encoding="UTF-8"?>';
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value[keys[0]] === "object") return header + node(keys[0], value[keys[0]]);
    return header + node(rootName, value);
  }
  return header + node(rootName, value);
}

function parseResp(text) {
  const lines = String(text).split("\r\n");
  const head = lines[0] || "";
  const type = head[0];
  if (type === "+") return head.slice(1);
  if (type === "-") throw attachCode(new Error(`Redis error: ${head.slice(1)}`), "SERVICE_ERROR");
  if (type === ":") return Number(head.slice(1));
  if (type === "$") {
    const n = Number(head.slice(1));
    return n < 0 ? null : lines[1];
  }
  if (type === "*") return lines.slice(1).filter((l) => l && !/^[*$:+-]/.test(l[0]));
  return text;
}

function redisCommand({ host, port, password, db, args }) {
  return new Promise((resolve, reject) => {
    const enc = (a) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(String(x))}\r\n${x}\r\n`).join("");
    const socket = net.createConnection({ host, port }, () => {
      let queue = "";
      if (password) queue += enc(["AUTH", password]);
      if (db) queue += enc(["SELECT", String(db)]);
      queue += enc(args);
      socket.write(queue);
    });
    let buf = "";
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(attachCode(new Error("Redis request timed out."), "HTTP_TIMEOUT"));
    });
    socket.on("data", (d) => {
      buf += d.toString();
      if (/\r\n/.test(buf)) {
        socket.end();
        try {
          resolve(parseResp(buf));
        } catch (err) {
          reject(err);
        }
      }
    });
    socket.on("error", (e) => reject(attachCode(new Error(`Redis connection failed: ${e.message}`), "SERVICE_ERROR")));
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// Turn a JSON value into spreadsheet rows: array of arrays as-is,
// array of objects → header row + value rows, single object → key/value rows.
function jsonToRows(value) {
  const parsed = typeof value === "string" ? extractJson(value) : value;
  if (Array.isArray(parsed)) {
    if (parsed.every((r) => Array.isArray(r))) return parsed;
    const headers = [...new Set(parsed.flatMap((r) => Object.keys(r || {})))];
    return [headers, ...parsed.map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? "" : typeof r[h] === "object" ? JSON.stringify(r[h]) : r[h])))];
  }
  if (parsed && typeof parsed === "object") {
    return [Object.keys(parsed).map(String), Object.values(parsed).map((v) => (typeof v === "object" ? JSON.stringify(v) : v))];
  }
  return [];
}

// Apply the node's chosen input mode before its handler runs. `ctx` carries the
// run's named files so the "file" mode can resolve a real file an upstream node
// produced (every node's output is registered as a file, see registerOutputFiles).
function preprocessInput(node, items, ctx = {}) {
  const c = node.data?.config || {};
  const mode = c.inputMode || "auto";
  // When the user picks a specific upstream node ("inputFromNode"), only keep
  // the items that actually originated from that node, dropping the rest.
  if (c.inputFromNode) {
    items = (items || []).filter((it) => it && it._src === c.inputFromNode);
  }
  if (mode === "auto") return items;
  const out = [];
  for (const item of items) {
    const json = item.json ?? {};
    if (mode === "field") {
      const val = getPath(json, c.inputField);
      if (Array.isArray(val)) {
        val.forEach((v) => out.push({ json: v && typeof v === "object" ? v : { value: v } }));
      } else if (val !== undefined) {
        out.push({ json: val && typeof val === "object" ? val : { value: val } });
      }
    } else if (mode === "text") {
      out.push({ json: { text: typeof json === "string" ? json : JSON.stringify(json) } });
    } else if (mode === "json") {
      const raw = typeof json === "string" ? json : json.text ?? JSON.stringify(json);
      const parsed = extractJson(String(raw));
      if (Array.isArray(parsed)) parsed.forEach((v) => out.push({ json: v && typeof v === "object" ? v : { value: v } }));
      else if (parsed && typeof parsed === "object") out.push({ json: parsed });
      else out.push({ json: { value: parsed } });
    } else if (mode === "csv") {
      const raw = typeof json === "string" ? json : json.text ?? JSON.stringify(json);
      const rows = parseCsv(String(raw));
      rows.forEach((r, i) => out.push({ json: { row: r, index: i, record: Object.fromEntries(rows[0].map((h, hi) => [h, r[hi]])) } }));
    } else if (mode === "file") {
      // Consume a named file an upstream node produced during this run — either
      // the whole file or one field out of it (JSON files expose their fields).
      const fileName = String(c.inputFile || "").trim();
      const file = ctx.files?.get(fileName);
      if (!file) {
        out.push({ json: { ...json, error: `No file named '${fileName}' was produced by an upstream node — run the workflow once so the file exists.` } });
        continue;
      }
      const text = file.data.toString("utf8");
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null; // plain text / binary — the node receives the raw text
      }
      const field = String(c.inputFileField || "").trim();
      if (field) {
        const val = parsed && typeof parsed === "object" ? getPath(parsed, field) : undefined;
        if (Array.isArray(val)) {
          val.forEach((v) => out.push({ json: v && typeof v === "object" ? v : { value: v } }));
        } else if (val !== undefined) {
          out.push({ json: val && typeof val === "object" ? val : { value: val } });
        } else {
          out.push({ json: { ...json, error: `Field '${field}' was not found in the file '${fileName}'.` } });
        }
      } else if (Array.isArray(parsed)) {
        parsed.forEach((v) => out.push({ json: v && typeof v === "object" ? v : { value: v } }));
      } else if (parsed !== null && typeof parsed === "object") {
        out.push({ json: parsed });
      } else {
        out.push({ json: { text } });
      }
    }
  }
  return out;
}

function scheduleNextRuns(cron, timezone) {
  try {
    const interval = cronParser.parseExpression(cron, { tz: timezone || undefined });
    return [interval.next().toString(), interval.next().toString(), interval.next().toString()];
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// Execute Sub-Workflow node — call one of the owner's other saved workflows as
// a reusable building block:
//   input   : every incoming item is handed to the sub-workflow (its trigger /
//             entry nodes act as input ports and receive the items directly).
//   output  : the sub-workflow runs to completion; the outputs of its END nodes
//             (nodes that ran successfully and have nothing connected out of
//             them) come back. One output item → its JSON is stored under
//             `storeIn`; several → { outputs: [ … ] }.
// Cycles are bounded (a workflow cannot call itself, nesting is capped) and
// lookups are owner-scoped, so a webhook-triggered run can only reach the same
// account's workflows.
// ----------------------------------------------------------------------------
const MAX_SUBFLOW_DEPTH = 5;

async function runSubWorkflow(node, items, ctx) {
  const c = node?.data?.config || {};
  const storeIn = String(c.storeIn || "result").trim() || "result";
  const depth = Number(ctx.subflowDepth || 0);
  const out = [];
  for (const item of items) {
    const base = { ...item.json };
    const targetId = String(renderTemplate(String(c.workflowId || ""), item)).trim();
    if (!targetId) {
      out.push({ json: { ...base, error: "Execute Sub-Workflow: no workflow selected — open the node and pick one of your workflows." } });
      continue;
    }
    if (ctx.workflowId && targetId === ctx.workflowId) {
      out.push({ json: { ...base, error: "Execute Sub-Workflow: a workflow cannot call itself." } });
      continue;
    }
    if (depth >= MAX_SUBFLOW_DEPTH) {
      out.push({ json: { ...base, error: `Execute Sub-Workflow: nesting deeper than ${MAX_SUBFLOW_DEPTH} levels is not allowed (is there a loop between workflows?).` } });
      continue;
    }
    // A remote runner (see server/runner.js) has no database: the caller sends
    // the sub-workflow along with its own credentials already re-injected.
    const bundled = ctx.subWorkflows?.[targetId] || null;
    const stored = bundled || (ctx.userId ? await workflows.getOwned(targetId, ctx.userId) : await workflows.get(targetId));
    if (!stored) {
      out.push({ json: { ...base, error: "Execute Sub-Workflow: workflow not found — it was deleted or belongs to another account." } });
      continue;
    }
    // Re-inject the sub-workflow's own stored credentials for its run.
    const target = bundled || !ctx.userId ? stored : await hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(targetId));
    const subResult = await executeWorkflow(target, {
      // the caller's item becomes the sub-workflow's input (entry ports)
      subworkflowItems: [item.json],
      userId: ctx.userId,
      signal: ctx.signal,
      maxItemsPerNode: ctx.maxItemsPerNode,
      subflowDepth: depth + 1,
      // carried through so nested calls and agents resolve on a runner too
      subWorkflows: ctx.subWorkflows,
      agents: ctx.agents,
    });
    if (!subResult.success) {
      const fails = (subResult.log || [])
        .filter((l) => l.status === "error")
        .slice(0, 3)
        .map((f) => `${f.nodeName}: ${f.error || "error"}`);
      throw new Error(
        `Sub-workflow “${target.name || target.id}” finished with ${subResult.errorCount} error(s)${fails.length ? " — " + fails.join(" | ") : ""}. Fix it (or its sub-workflows) and run again.`
      );
    }
    // Collect the outputs of the sub-workflow's end nodes.
    const hasOutEdges = new Set();
    for (const e of target.edges || []) hasOutEdges.add(e.source);
    const leafOutput = [];
    for (const entry of subResult.log || []) {
      if (entry.status !== "success" || hasOutEdges.has(entry.nodeId)) continue;
      for (const j of entry.outputItems || []) {
        // The run log annotates items with the display-only `filesWritten` list
        // (every node registers its output as a named file). That annotation is
        // for the log console — it must not leak into the data a sub-workflow
        // hands back to its caller.
        if (j && typeof j === "object" && "filesWritten" in j) {
          const { filesWritten: _displayOnly, ...rest } = j;
          leafOutput.push(rest);
        } else {
          leafOutput.push(j);
        }
      }
    }
    const value = leafOutput.length === 1 ? leafOutput[0] : { outputs: leafOutput };
    out.push({
      json: {
        ...base,
        subflow: {
          workflowId: target.id,
          workflowName: target.name || target.id,
          success: true,
          durationMs: subResult.durationMs,
          errorCount: 0,
          outputCount: leafOutput.length,
        },
        [storeIn]: value,
      },
    });
  }
  return { byHandle: { out } };
}

// ----------------------------------------------------------------------------
// Node handlers — each returns { byHandle: { handleId: items[] } }
// ----------------------------------------------------------------------------

// Shared extraction for Extract File / Read File from Disk: run the extraction
// engine on a resolved source ({ buffer, fileName, mimeType } or { error }) and
// produce one output item.
async function extractFileFromSource(c, item, source, mode) {
  const base = { ...item.json };
  if (!source) return { json: { ...base, extractionError: "No file source available" } };
  if (source.error) return { json: { ...base, extractionError: source.error } };
  try {
    const result = await extractFileContent({
      fileName: source.fileName,
      mimeType: source.mimeType,
      data: source.buffer,
      mode,
      opts: {
        encoding: c.encoding,
        format: c.format,
        delimiter: c.delimiter,
        headerRow: c.headerRow !== false,
        maxTextLength: Number(c.maxTextLength || 100000),
        maxRows: Number(c.maxRows || 1000),
        maxEntries: Number(c.maxEntries || 500),
        sheetIndex: Number(c.sheetIndex || 1),
        entryPattern: c.entryPattern,
      },
    });
    const { detected, ...rest } = result;
    return { json: { ...base, ...rest, fileType: detected, extractionError: result.error || null } };
  } catch (err) {
    return { json: { ...base, extractionError: String(err.message || err) } };
  }
}

// Turn a rejected HTTP response into the same classified error that
// server/service-exec.js raises for the descriptor-driven service nodes
// (401/403 → auth, 429 → rate limit, anything else → service error), so the
// hand-written senders honour the node's "If this node fails" setting too.
function httpFailure(status, detail = "") {
  const suffix = String(detail || "").trim() ? ` ${String(detail).slice(0, 300)}` : "";
  if (status === 401 || status === 403) return attachCode(new Error(`The service rejected the credentials (HTTP ${status}).${suffix}`), "AUTH_FAILED");
  if (status === 429) return attachCode(new Error(`The service rate-limited the request (HTTP 429).${suffix}`), "RATE_LIMITED");
  return attachCode(new Error(`The service returned HTTP ${status}.${suffix}`), "SERVICE_ERROR");
}

// The useful part of an `{ error: … }` body. A top-level message alone is
// often just "Bad Request"; the detail that names the wrong value sits
// elsewhere per provider: Google's errors[0].reason/location, Microsoft
// Graph's string code, Airtable's type (or a bare string error), Stripe's
// param and Meta's error_data.details.
function apiErrorDetail(data) {
  const e = data?.error;
  if (!e) return "";
  if (typeof e === "string") return e;
  const first = Array.isArray(e.errors) ? e.errors[0] : null;
  const extra = [
    first && [first.reason, first.location].filter(Boolean).join(" at "),
    typeof e.code === "string" && e.code,
    e.type,
    e.param && `field: ${e.param}`,
    e.error_data?.details,
  ].filter((x) => x && typeof x === "string" && !String(e.message || "").includes(x));
  return [e.message, extra.length && `(${extra.join("; ")})`].filter(Boolean).join(" ");
}

// Start / end of a Google Calendar event. A blank start means "now" — the
// Manual trigger has no {{triggeredAt}}, so the old default rendered to ""
// and Google answered a bare 400. A blank end is one hour after the start. A
// plain date (2026-01-01) makes an all-day event; a datetime without an
// offset is read in the node's time zone, so the computed end keeps that form.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
export function calendarEventTimes(startRaw, endRaw, timeZone) {
  let start = String(startRaw || "").trim();
  let end = String(endRaw || "").trim();
  if (!start) start = new Date().toISOString();
  const allDay = DATE_ONLY.test(start);
  const asUtc = (s) => Date.parse(DATE_ONLY.test(s) || HAS_OFFSET.test(s) ? s : `${s}Z`);
  const startMs = asUtc(start);
  if (Number.isNaN(startMs)) throw attachCode(new Error(`Start "${start}" is not a date — use an ISO datetime like 2026-01-01T10:00:00 or a date like 2026-01-01.`), "MISSING_CONFIG");
  if (!end) {
    if (allDay) end = new Date(startMs + 86400_000).toISOString().slice(0, 10);
    else if (HAS_OFFSET.test(start)) end = new Date(startMs + 3600_000).toISOString();
    else end = new Date(startMs + 3600_000).toISOString().slice(0, 19);
  }
  if (allDay !== DATE_ONLY.test(end)) throw attachCode(new Error("Start and End must both be dates (all-day event) or both be datetimes."), "MISSING_CONFIG");
  const endMs = asUtc(end);
  if (Number.isNaN(endMs)) throw attachCode(new Error(`End "${end}" is not a date — use an ISO datetime like 2026-01-01T11:00:00, or leave it empty for one hour after the start.`), "MISSING_CONFIG");
  if (endMs < startMs) throw attachCode(new Error(`End (${end}) is before Start (${start}).`), "MISSING_CONFIG");
  if (allDay) return { start: { date: start }, end: { date: end } };
  const tz = timeZone || "UTC";
  return { start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz } };
}

// The same rules for Outlook (Microsoft Graph), which wants a local dateTime
// without an offset next to its timeZone, and midnight-to-midnight plus
// isAllDay for all-day events. An offset is converted to UTC.
export function graphEventTimes(startRaw, endRaw, timeZone) {
  const t = calendarEventTimes(startRaw, endRaw, timeZone);
  if (t.start.date) {
    return {
      isAllDay: true,
      start: { dateTime: `${t.start.date}T00:00:00`, timeZone: timeZone || "UTC" },
      end: { dateTime: `${t.end.date}T00:00:00`, timeZone: timeZone || "UTC" },
    };
  }
  const local = (p) => (HAS_OFFSET.test(p.dateTime)
    ? { dateTime: new Date(p.dateTime).toISOString().slice(0, 19), timeZone: "UTC" }
    : { dateTime: p.dateTime, timeZone: p.timeZone });
  return { start: local(t.start), end: local(t.end) };
}

// A 2xx response that still carries an application-level failure — Slack /
// Telegram `ok:false`, a GraphQL-only failure, "coin not found", an empty
// short URL. These are failures even though the HTTP layer succeeded.
function serviceFailure(detail) {
  const suffix = String(detail || "").trim() ? ` ${String(detail).slice(0, 300)}` : "";
  return attachCode(new Error(`The service reported an error.${suffix}`), "SERVICE_ERROR");
}

// Fetch an RSS / Atom feed and return one output item: the incoming fields plus
// feedTitle, the parsed entries under `storeIn` and their count. Shared by the
// RSS Read node and every Feeds & Sources preset.
async function readFeed(url, limitIn, storeIn, item) {
  const limit = Math.max(0, Math.min(Number(limitIn || 20), 200));
  await assertPublicHttpUrl(url);
  const res = await fetch(url);
  const xml = await res.text().catch(() => "");
  if (!res.ok) throw httpFailure(res.status, xml);
  const { feedTitle, items: feedItems } = parseRssFeed(xml, limit);
  // A valid feed with no entries is fine; a body that is not a feed at all
  // (no channel/feed title and no entries) is an error.
  if (!feedTitle && !feedItems.length) throw serviceFailure("No items found (is this an RSS/Atom feed?)");
  return {
    json: {
      ...item.json,
      fetched: true,
      status: res.status,
      feedTitle,
      [storeIn || "items"]: feedItems,
      count: feedItems.length,
    },
  };
}

// Build a feed preset's URL: {{field}} placeholders come from the node's own
// settings (each value may itself use {{vars}} from the incoming item). Values
// are URL-encoded, except host-like fields (`url`, `site`, `instance`) which
// are inserted as given, minus a scheme / trailing slash where the template
// already has one. Every placeholder must be filled in.
const FEED_HOST_KEYS = new Set(["site", "instance"]);
function feedUrlFor(template, config, item, nodeName) {
  const missing = [];
  const url = String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    let v = renderTemplate(String(config?.[key] ?? ""), item).trim();
    if (!v) missing.push(key);
    if (key === "url") return v;
    if (FEED_HOST_KEYS.has(key)) return v.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return encodeURIComponent(v.replace(/^[@#]/, ""));
  });
  if (missing.length) {
    throw attachCode(new Error(`${nodeName || "This feed node"} needs ${missing.join(", ")} filled in.`), "MISSING_CONFIG");
  }
  return url;
}

// ---- connected accounts ----
// A node with a connected account picked (shared/oauth.js) gets a valid
// access token in its credential field before it runs, so every handler below
// — hand-written or the generic service runner — reads it where it always
// read the pasted token. `__authBearer` switches nodes that normally send a
// different header (GitLab's PRIVATE-TOKEN) to Bearer for the run.
export async function withConnectedAccount(node, ctx) {
  const c = node.data?.config;
  const spec = oauthSpecFor(node.type);
  const id = String(c?.[OAUTH_FIELD_KEY] || "").trim();
  if (!spec || !id || c?.manualOutput) return node;
  // A node whose scopes this instance may not use (unverified Google scopes on
  // the cloud) runs on its pasted token, never on an older connection that
  // happens to hold the scope.
  if (!connectAllowed(spec, scopePolicy())) {
    const inject = injectionFor(spec);
    if (String(c?.[inject.key] || "").trim()) return node;
    const label = OAUTH_PROVIDERS[spec.provider]?.label || spec.provider;
    throw attachCode(
      new Error(`This node can’t use a connected ${label} account here. Paste an access token in its advanced credential field instead.`),
      "MISSING_CONFIG"
    );
  }
  // "Send as: me" swaps the bot token for the person's own (shared/oauth.js asUser).
  const asUser = !!spec.asUser && c?.sendAs === "me";
  const token = await accessTokenFor({ id, userId: ctx?.userId, provider: spec.provider, scopes: scopesFor(spec), asUser });
  const inject = injectionFor(spec);
  const config = { ...c, [inject.key]: inject.prefix + token, ...(inject.bearer ? { __authBearer: true } : {}) };
  return { ...node, data: { ...node.data, config } };
}

// ---- Telegram ----
// All Telegram action nodes share one runner: resolve the bot (a connected
// bot from server/telegram-bots.js, else the pasted token), turn the node's
// fields into Bot API parameters per item, and call the method.

async function telegramToken(c, ctx) {
  const botId = String(c.telegramBot || "").trim();
  if (botId) return botTokenFor({ id: botId, userId: ctx?.userId });
  const token = String(c.botToken || "").trim();
  if (!token) throw attachCode(new Error("Connect a Telegram bot on this node (or paste a bot token under the advanced options)."), "MISSING_CONFIG");
  return token;
}

function tgJson(raw, item, label) {
  const text = renderTemplate(String(raw ?? ""), item).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw attachCode(new Error(`${label} is not valid JSON: ${err.message}`), "INVALID_JSON");
  }
}

function tgRequired(value, label) {
  const v = String(value ?? "").trim();
  if (!v) throw attachCode(new Error(`${label} is empty — fill it in on the node.`), "MISSING_CONFIG");
  return v;
}

// type → (config, item, render) → [method, params]
const TELEGRAM_CALLS = {
  telegramSend: (c, item, r) => [
    "sendMessage",
    {
      chat_id: tgRequired(r(c.chatId), "Chat ID"),
      text: tgRequired(r(c.text), "Message text"),
      reply_markup: tgKeyboard(c, item) || tgReplyKeyboard(c, r),
      reply_parameters: String(r(c.replyTo)).trim() ? { message_id: Number(r(c.replyTo)), allow_sending_without_reply: true } : undefined,
      disable_notification: c.silent === true || undefined,
      link_preview_options: c.disablePreview === true ? { is_disabled: true } : undefined,
    },
  ],
  telegramSendPhoto: (c, item, r) => [
    "sendPhoto",
    { chat_id: tgRequired(r(c.chatId), "Chat ID"), photo: tgMedia(c, item, r(c.photo), "Photo"), caption: r(c.caption) || undefined, reply_markup: tgKeyboard(c, item), disable_notification: c.silent === true || undefined },
  ],
  telegramSendDocument: (c, item, r) => [
    "sendDocument",
    { chat_id: tgRequired(r(c.chatId), "Chat ID"), document: tgMedia(c, item, r(c.document), "File"), caption: r(c.caption) || undefined, reply_markup: tgKeyboard(c, item), disable_notification: c.silent === true || undefined },
  ],
  telegramSendMedia: (c, item, r) => {
    const kind = TG_MEDIA_METHODS[c.kind] ? c.kind : "video";
    const caption = kind === "sticker" || kind === "video_note" ? undefined : r(c.caption) || undefined;
    return [TG_MEDIA_METHODS[kind], { chat_id: tgRequired(r(c.chatId), "Chat ID"), [kind]: tgMedia(c, item, r(c.media), "Media"), caption, disable_notification: c.silent === true || undefined }];
  },
  telegramSetCommands: (c, item, r) => {
    const commands = String(r(c.commands))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^\/?([a-z0-9_]{1,32})\s*(?:[-–—:]\s*)?(.*)$/i);
        if (!m) throw attachCode(new Error(`"${line}" is not a command line — write it as /command - description.`), "MISSING_CONFIG");
        return { command: m[1].toLowerCase(), description: (m[2] || m[1]).slice(0, 256) };
      });
    if (!commands.length) throw attachCode(new Error("Add at least one command, e.g. /start - Start the bot."), "MISSING_CONFIG");
    return ["setMyCommands", { commands }];
  },
  telegramSendLocation: (c, item, r) => {
    const latitude = Number(r(c.latitude));
    const longitude = Number(r(c.longitude));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw attachCode(new Error("Latitude and longitude must be numbers."), "MISSING_CONFIG");
    return ["sendLocation", { chat_id: tgRequired(r(c.chatId), "Chat ID"), latitude, longitude }];
  },
  telegramSendPoll: (c, item, r) => {
    const options = String(r(c.options)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 10) throw attachCode(new Error(`A poll needs 2 to 10 answers, one per line (got ${options.length}).`), "MISSING_CONFIG");
    return [
      "sendPoll",
      { chat_id: tgRequired(r(c.chatId), "Chat ID"), question: tgRequired(r(c.question), "Question"), options: options.map((text) => ({ text })), is_anonymous: c.anonymous !== false, allows_multiple_answers: c.multiple === true },
    ];
  },
  telegramEditMessage: (c, item, r) => [
    "editMessageText",
    { chat_id: tgRequired(r(c.chatId), "Chat ID"), message_id: Number(tgRequired(r(c.messageId), "Message ID")), text: tgRequired(r(c.text), "New text"), reply_markup: tgKeyboard(c, item) },
  ],
  telegramDeleteMessage: (c, item, r) => ["deleteMessage", { chat_id: tgRequired(r(c.chatId), "Chat ID"), message_id: Number(tgRequired(r(c.messageId), "Message ID")) }],
  telegramForward: (c, item, r) => [
    "forwardMessage",
    { chat_id: tgRequired(r(c.chatId), "To chat ID"), from_chat_id: tgRequired(r(c.fromChatId), "From chat ID"), message_id: Number(tgRequired(r(c.messageId), "Message ID")) },
  ],
  telegramPin: (c, item, r) => ["pinChatMessage", { chat_id: tgRequired(r(c.chatId), "Chat ID"), message_id: Number(tgRequired(r(c.messageId), "Message ID")), disable_notification: c.silent !== false }],
  telegramChatAction: (c, item, r) => ["sendChatAction", { chat_id: tgRequired(r(c.chatId), "Chat ID"), action: String(c.action || "typing") }],
  telegramAnswerCallback: (c, item, r) => ["answerCallbackQuery", { callback_query_id: tgRequired(r(c.callbackQueryId), "Button press ID"), text: r(c.text) || undefined, show_alert: c.showAlert === true || undefined }],
  telegramGetChat: (c, item, r) => ["getChat", { chat_id: tgRequired(r(c.chatId), "Chat ID") }],
  telegramGetFile: (c, item, r) => ["getFile", { file_id: tgRequired(r(c.fileId), "File ID") }],
  telegramApi: (c, item, r) => {
    const method = tgRequired(r(c.method), "Method");
    if (!/^[A-Za-z]+$/.test(method)) throw attachCode(new Error(`"${method}" is not a Bot API method name.`), "MISSING_CONFIG");
    return [method, tgJson(c.params, item, "Parameters") || {}];
  },
};

const TG_MEDIA_METHODS = { video: "sendVideo", audio: "sendAudio", voice: "sendVoice", animation: "sendAnimation", sticker: "sendSticker", video_note: "sendVideoNote" };

// A file from an earlier node is marked here and turned into a multipart
// upload by runTelegramNode; a URL / file_id is passed through as text.
function tgMedia(c, item, value, label) {
  const field = String(c.fileField || "").trim();
  if (field) {
    const json = item?.json || {};
    const raw = getPath(json, field);
    const data = raw && typeof raw === "object" ? raw.base64 || raw.data : raw;
    let b64 = String(data || "");
    let mime = raw?.mimeType || "";
    const dataUrl = b64.match(/^data:([^;,]+)?;base64,(.*)$/s);
    if (dataUrl) {
      mime = mime || dataUrl[1] || "";
      b64 = dataUrl[2];
    }
    if (!b64) throw attachCode(new Error(`The incoming item has no file in "${field}" — point “Upload from field” at a base64 field.`), "FILE_CONTENT_MISSING");
    const fileName = String(raw?.fileName || json.fileName || `file${mime.includes("/") ? "." + mime.split("/")[1].split("+")[0] : ""}`);
    return { __upload: true, bytes: Buffer.from(b64, "base64"), fileName, mimeType: mime || mimeTypeFor(fileName) };
  }
  return tgRequired(value, label);
}

// Reply keyboard from "A | B" lines, or the remove-keyboard marker.
function tgReplyKeyboard(c, r) {
  if (c.removeKeyboard === true) return { remove_keyboard: true };
  const rows = String(r(c.keyboard))
    .split(/\r?\n/)
    .map((line) => line.split("|").map((t) => t.trim()).filter(Boolean).map((text) => ({ text })))
    .filter((row) => row.length);
  return rows.length ? { keyboard: rows, resize_keyboard: true } : undefined;
}

function tgKeyboard(c, item) {
  const rows = tgJson(c.buttons, item, "Buttons");
  if (rows === undefined) return undefined;
  if (!Array.isArray(rows)) throw attachCode(new Error("Buttons must be a JSON array of rows, e.g. [[{\"text\":\"Yes\",\"callback_data\":\"yes\"}]]."), "INVALID_JSON");
  return { inline_keyboard: rows.map((row) => (Array.isArray(row) ? row : [row])) };
}

async function runTelegramNode(type, c, items, ctx) {
  // "Connect as: my Telegram account" — the same node values, sent through
  // the person's own account (server/telegram-accounts.js) instead of a bot.
  if (c.connectAs === "account" && ACCOUNT_NODE_TYPES.has(type)) {
    const accountId = String(c.telegramAccount || "").trim();
    if (!accountId) throw attachCode(new Error("Pick your Telegram account on this node (or switch “Connect as” back to a bot)."), "MISSING_CONFIG");
    const out = [];
    for (const item of items) {
      const r = (v) => renderTemplate(String(v ?? ""), item);
      const [, p] = TELEGRAM_CALLS[type](c, item, r);
      const media = p.photo ?? p.document ?? (type === "telegramSendMedia" ? p[c.kind || "video"] : undefined);
      const values = {
        chatId: p.chat_id,
        text: p.text,
        caption: p.caption,
        media,
        replyTo: r(c.replyTo).trim(),
        messageId: p.message_id,
        fromChatId: p.from_chat_id,
        latitude: p.latitude,
        longitude: p.longitude,
      };
      out.push({ json: await runAsAccount(type, c, values, { id: accountId, userId: ctx?.userId }) });
    }
    return { byHandle: { out } };
  }
  const token = await telegramToken(c, ctx);
  const out = [];
  for (const item of items) {
    const r = (v) => renderTemplate(String(v ?? ""), item);
    const [method, raw] = TELEGRAM_CALLS[type](c, item, r);
    const params = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    if (c.parseMode && c.parseMode !== "none" && ("text" in params || "caption" in params)) params.parse_mode = c.parseMode;
    const result = await telegramApi(token, method, tgBody(params), { timeoutMs: 60_000 });
    if (type === "telegramGetFile") {
      out.push({ json: await telegramDownload(token, result) });
    } else if (type === "telegramGetChat") {
      const members = await telegramApi(token, "getChatMemberCount", { chat_id: params.chat_id }).catch(() => null);
      out.push({ json: { ...result, memberCount: members } });
    } else {
      out.push({ json: result && typeof result === "object" ? { ok: true, sent: true, ...result } : { ok: true, result } });
    }
  }
  return { byHandle: { out } };
}

// JSON unless a parameter is a file upload; then multipart, with nested
// objects (reply_markup, …) JSON-encoded as the Bot API expects.
function tgBody(params) {
  if (!Object.values(params).some((v) => v?.__upload)) return params;
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) {
    if (v?.__upload) form.append(k, new Blob([v.bytes], { type: v.mimeType || "application/octet-stream" }), v.fileName);
    else form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return form;
}

// The file URL embeds the bot token, so the node returns the bytes, never the URL.
async function telegramDownload(token, file) {
  if (!file?.file_path) throw attachCode(new Error("Telegram did not return a downloadable file (files over 20 MB cannot be fetched by bots)."), "SERVICE_ERROR");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw httpFailure(res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const fileName = path.basename(file.file_path);
  return { fileId: file.file_id, fileName, size: buf.length, mimeType: mimeTypeFor(fileName), base64: buf.toString("base64") };
}

// RFC 2047 encoded-word, so a subject with umlauts or emoji survives.
function mimeHeader(value) {
  const v = String(value ?? "").replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** The base64url RFC 2822 message Gmail's send / draft endpoints expect. */
function gmailRawMessage({ to, cc, subject, message, html }) {
  const lines = [
    `To: ${mimeHeader(to)}`,
    ...(cc ? [`Cc: ${mimeHeader(cc)}`] : []),
    `Subject: ${mimeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(String(message ?? ""), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/**
 * A Sheets A1 range for a tab. No tab name means the first tab — Google names
 * it after the account's language ("Sheet1", "Tabellenblatt1", "Лист1"), so a
 * fixed default broke every non-English sheet. Names are quoted so spaces and
 * punctuation work ('Q1 Leads'!A1).
 */
function sheetsRange(sheet, range) {
  const name = String(sheet ?? "").trim();
  if (!name) return range;
  return `'${name.replace(/'/g, "''")}'!${range}`;
}

/** Turn Google's "Unable to parse range" into advice about the tab name. */
function sheetsFailure(status, data, sheet) {
  if (/unable to parse range/i.test(data?.error?.message || "") && String(sheet ?? "").trim()) {
    return attachCode(
      new Error(`This spreadsheet has no tab named "${String(sheet).trim()}". Enter the exact tab name shown at the bottom of the sheet, or leave “Sheet name” empty to use the first tab.`),
      "MISSING_CONFIG"
    );
  }
  return httpFailure(status, apiErrorDetail(data));
}

/**
 * An Airtable table URL. An empty Base ID used to send /v0//Table%201 and a
 * wrong table name gets Airtable's vague INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND,
 * so both are checked here and explained in airtableFailure.
 */
function airtableUrl(c, suffix = "") {
  const base = String(c.baseId ?? "").trim();
  const table = String(c.tableName ?? "").trim();
  if (!base) throw attachCode(new Error("Enter the Base ID (it starts with app…, from the base's URL or airtable.com/developers/web/api)."), "MISSING_CONFIG");
  if (!table) throw attachCode(new Error("Enter the table name exactly as it appears on its tab, or the table ID (tbl…)."), "MISSING_CONFIG");
  return `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(table)}${suffix}`;
}

function airtableFailure(status, data, c) {
  const kind = typeof data?.error === "string" ? data.error : data?.error?.type;
  if ((status === 403 || status === 404) && /NOT_FOUND|INVALID_PERMISSIONS/i.test(kind || "")) {
    return attachCode(
      new Error(`Airtable cannot find table "${String(c.tableName ?? "").trim()}" in base ${String(c.baseId ?? "").trim()}, or the token may not use it. Check the table name on its tab (or use its tbl… ID), and that the token has this base and the data.records scopes. (${kind})`),
      "MISSING_CONFIG"
    );
  }
  return httpFailure(status, apiErrorDetail(data));
}

/** Sheets auth: bearer token when an account is connected, else the API key. */
function sheetsAuth(c, extraHeaders = {}) {
  if (c.token) return { key: "", headers: { ...extraHeaders, Authorization: `Bearer ${c.token}` } };
  return { key: `key=${encodeURIComponent(c.apiKey || "")}`, headers: extraHeaders };
}

// {{$vars.NAME}} / {{$env}} in a node's settings resolve before the node runs,
// so they work in fields that are never rendered per item — credentials above
// all, which is what makes a Test / Live credential switch possible.
const RUN_VAR_PATTERN = /\{\{\s*(\$vars\.[\w.$]+|\$env)\s*\}\}/g;
function withRunVars(node) {
  const config = node.data?.config;
  if (!config) return node;
  let changed = false;
  const next = {};
  for (const [k, v] of Object.entries(config)) {
    next[k] = typeof v === "string" && /\{\{\s*\$/.test(v) ? v.replace(RUN_VAR_PATTERN, (_, path) => String(resolveRunPath(path) ?? "")) : v;
    if (next[k] !== v) changed = true;
  }
  return changed ? { ...node, data: { ...node.data, config: next } } : node;
}

async function runNode(node, items, ctx) {
  node = withRunVars(await withConnectedAccount(node, ctx));
  const c = node.data?.config || {};
  // Manual output override — when the user enables it on a node, the JSON they
  // set is used as the node's output and the node is NOT executed (handy for
  // testing with fixed data, e.g. simulating a webhook payload).
  if (c.manualOutput) {
    const raw = String(c.manualOutputJson ?? "").trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Manual output is enabled but the JSON is invalid: ${err.message}`);
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return { byHandle: { out: arr.map((json) => ({ json })) } };
  }
  items = preprocessInput(node, items, ctx);
  const first = items[0];

  // A real inbound event: when the server waits for input (non-manual
  // triggers) or a background watcher fires, the payload arrives on
  // ctx.triggerPayload. Trigger nodes prefer it over their representative
  // sample, so "Waiting for input" actually feeds the workflow.
  const realTrigger =
    ctx?.triggerPayload && typeof ctx.triggerPayload === "object" && Object.keys(ctx.triggerPayload).length
      ? ctx.triggerPayload
      : null;

  switch (node.type) {
    // --- triggers -----------------------------------------------------------
    // Every catalog trigger emits a representative sample payload when the
    // workflow is run from the editor (see shared/samples.js), so downstream
    // logic can be exercised without external accounts. Triggers are matched
    // by kind rather than a hardcoded type list, so every trigger in the
    // catalog works — including the Discord / RSS / HubSpot / Supabase / …
    // ones that were previously missing from the executor.
    case "schedule": {
      const payload = samplePayloadFor(node, ctx);
      payload.nextRuns = scheduleNextRuns(c.cron, c.timezone);
      // A manually submitted input (the "Waiting for input" panel) merges over
      // the schedule metadata, so scheduled workflows can be test-run with a
      // real payload too.
      return { byHandle: { out: [{ json: realTrigger ? { ...payload, ...realTrigger } : payload }] } };
    }

    // RSS trigger — real live events come from the background scheduler, which
    // passes the newly-seen items through ctx.triggerPayload. A manual Run from
    // the editor still fires the sample payload so downstream steps can be
    // designed before a feed produces anything.
    case "rssTrigger": {
      const tp = ctx?.triggerPayload && typeof ctx.triggerPayload === "object" ? ctx.triggerPayload : null;
      if (tp && Array.isArray(tp.items)) {
        return { byHandle: { out: [{ json: { ...tp, feed: tp.feed || c.url || "", polledAt: tp.polledAt || new Date().toISOString() } }] } };
      }
      return { byHandle: { out: [{ json: samplePayloadFor(node, ctx) }] } };
    }

    // GitHub / Stripe triggers — a real delivery arrives via /webhook/:id (the
    // server verifies the signature and hands the event over as
    // webhookPayload). A manual Run from the editor still fires the sample so
    // downstream steps can be designed first.
    case "githubTrigger":
    case "stripeTrigger": {
      const real =
        ctx?.webhookPayload && typeof ctx.webhookPayload === "object" && Object.keys(ctx.webhookPayload).length
          ? ctx.webhookPayload
          : null;
      if (real) return { byHandle: { out: [{ json: { ...real } }] } };
      return { byHandle: { out: [{ json: samplePayloadFor(node, ctx) }] } };
    }

    // Telegram trigger — real updates come from the live poller
    // (server/telegram.js), which passes each update (an object with
    // update_id + message) as ctx.triggerPayload. A manually submitted input
    // (the "Waiting for input" panel) is honoured too.
    case "telegramTrigger": {
      if (realTrigger) return { byHandle: { out: [{ json: realTrigger }] } };
      return { byHandle: { out: [{ json: samplePayloadFor(node, ctx) }] } };
    }

    // Chat trigger — the message typed in the chat panel (server passes it as
    // ctx.triggerPayload). Falls back to the sample only when the node is run
    // on its own (e.g. single-step execution).
    case "chatTrigger": {
      if (realTrigger) return { byHandle: { out: [{ json: { channel: "chat", role: "user", ...realTrigger } }] } };
      return { byHandle: { out: [{ json: samplePayloadFor(node, ctx) }] } };
    }

    // --- actions ------------------------------------------------------------
    case "http": {
      const out = [];
      for (const item of items) {
        let url = renderTemplate(c.url, item);
        // query parameters (key → value rows) get appended to the URL
        const qs = (c.query || []).filter((r) => r?.key);
        if (qs.length) {
          const params = new URLSearchParams();
          for (const r of qs) params.append(r.key, renderTemplate(r.value ?? "", item));
          url += (url.includes("?") ? "&" : "?") + params.toString();
        }
        const headers = JSON.parse(renderTemplate(JSON.stringify(parseJsonField(c.headers, {})), item));
        if (c.authType === "bearer" && c.authToken) headers.Authorization = `Bearer ${renderTemplate(c.authToken, item)}`;
        if (c.authType === "basic") {
          const user = renderTemplate(c.authUser || "", item);
          const pass = renderTemplate(c.authPass || "", item);
          headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
        }
        let body;
        try {
          body = renderTemplate(c.body ?? "", item);
        } catch {
          body = c.body ?? "";
        }
        await assertPublicHttpUrl(url);
        const method = c.method || "GET";
        const attempts = Math.max(1, Number(c.retries || 0) + 1);
        let res = null;
        for (let i = 0; i < attempts; i++) {
          try {
            // safeFetch re-checks each redirect hop against the SSRF guard, so a
            // public URL cannot bounce the request to an internal address.
            res = await safeFetch(url, {
              method,
              headers,
              body: ["GET", "HEAD"].includes(method) ? undefined : body,
              redirect: c.followRedirects === false ? "manual" : "follow",
              signal: AbortSignal.timeout((c.timeout || 15) * 1000),
            });
            break;
          } catch (err) {
            if (i === attempts - 1) throw err;
            await sleep(300 * (i + 1));
          }
        }
        const text = await res.text();
        let data = text;
        const parseAs = c.parseAs || "auto";
        if (parseAs === "json" || (parseAs === "auto" && text.trim().startsWith("{") || (parseAs === "auto" && text.trim().startsWith("[")))) {
          try {
            data = JSON.parse(text);
          } catch {
            /* keep raw */
          }
        }
        out.push({ json: { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), data } });
      }
      return { byHandle: { out } };
    }

    // GraphQL — one POST, the query and its variables in the body, the answer
    // under `data` (errors under `errors`).
    case "graphqlRequest": {
      const out = [];
      for (const item of items) {
        const endpoint = renderTemplate(c.endpoint ?? "", item);
        await assertPublicHttpUrl(endpoint);
        const headers = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.headers, {})), item), {});
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
        const token = renderTemplate(c.token ?? "", item);
        if (token) headers.Authorization = `Bearer ${token}`;
        const variables = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.variables, {})), item), {});
        const res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: renderTemplate(c.query ?? "", item), variables }),
        });
        const data = await res.json().catch(() => ({}));
        // A transport failure is an error; GraphQL-level `errors` in a 200 body
        // are part of the response and stay in the output (graphqlOk/graphqlErrors).
        if (!res.ok) throw httpFailure(res.status, data.errors ? JSON.stringify(data.errors).slice(0, 300) : "");
        const storeIn = c.storeIn || "data";
        out.push({
          json: {
            ...item.json,
            [storeIn]: data.data ?? null,
            graphqlOk: !data.errors,
            graphqlStatus: res.status,
            ...(data.errors ? { graphqlErrors: data.errors } : {}),
          },
        });
      }
      return { byHandle: { out } };
    }

    case "emailSend": {
      const results = [];
      for (const item of items) {
        const transporter = nodemailer.createTransport({
          host: c.host,
          port: Number(c.port || 465),
          secure: c.secure !== false,
          auth: { user: c.user, pass: c.appPassword },
        });
        try {
          const info = await transporter.sendMail({
            from: renderTemplate(c.from, item),
            to: renderTemplate(c.to, item),
            cc: c.cc ? renderTemplate(c.cc, item) : undefined,
            replyTo: c.replyTo ? renderTemplate(c.replyTo, item) : undefined,
            subject: renderTemplate(c.subject, item),
            text: renderTemplate(c.body, item),
          });
          results.push({ json: { sent: true, messageId: info.messageId, to: renderTemplate(c.to, item) } });
        } catch (err) {
          throw attachCode(new Error(`Could not send the e-mail: ${String(err.message || err)}`), "SERVICE_ERROR");
        }
      }
      return { byHandle: { out: results } };
    }

    case "slackSend": {
      const out = [];
      for (const item of items) {
        const payload = { text: renderTemplate(c.text, item) };
        if (c.channel) payload.channel = renderTemplate(c.channel, item);
        if (c.blocks) {
          const rendered = renderTemplate(String(c.blocks), item);
          try {
            const blocks = JSON.parse(rendered);
            if (Array.isArray(blocks) && blocks.length) payload.blocks = blocks;
          } catch {
            /* keep plain text if blocks are invalid */
          }
        }
        await assertPublicHttpUrl(c.webhookUrl);
        const res = await fetch(c.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!res.ok) throw httpFailure(res.status, await res.text().catch(() => ""));
        out.push({ json: { sent: true, status: res.status } });
      }
      return { byHandle: { out } };
    }

    case "discordSend": {
      const out = [];
      for (const item of items) {
        await assertPublicHttpUrl(c.webhookUrl);
        const res = await fetch(c.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: renderTemplate(c.content, item) }),
        });
        if (!res.ok) throw httpFailure(res.status, await res.text().catch(() => ""));
        out.push({ json: { sent: true, status: res.status } });
      }
      return { byHandle: { out } };
    }

    case "telegramSend":
    case "telegramSendPhoto":
    case "telegramSendDocument":
    case "telegramSendMedia":
    case "telegramSetCommands":
    case "telegramSendLocation":
    case "telegramSendPoll":
    case "telegramEditMessage":
    case "telegramDeleteMessage":
    case "telegramForward":
    case "telegramPin":
    case "telegramChatAction":
    case "telegramAnswerCallback":
    case "telegramGetChat":
    case "telegramGetFile":
    case "telegramApi":
      return runTelegramNode(node.type, c, items, ctx);

    case "githubIssue": {
      const out = [];
      for (const item of items) {
        const owner = renderTemplate(c.owner, item);
        const repo = renderTemplate(c.repo, item);
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
          body: JSON.stringify({
            title: renderTemplate(c.title, item),
            body: renderTemplate(c.body, item),
            labels: String(c.labels || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { created: true, status: res.status, number: data.number, url: data.html_url, message: data.message } });
      }
      return { byHandle: { out } };
    }

    case "notionPage": {
      const out = [];
      for (const item of items) {
        const res = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
          body: JSON.stringify({
            parent: { database_id: c.parentDatabaseId },
            properties: { title: { title: [{ text: { content: renderTemplate(c.title, item) } }] } },
            children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: renderTemplate(c.content, item) } }] } }],
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { created: true, status: res.status, id: data.id, url: data.url } });
      }
      return { byHandle: { out } };
    }

    case "webhookRespond": {
      // Capture the HTTP response for the caller of the webhook that started
      // this run. The /webhook handler returns it (via ctx.webhookResponse)
      // once the run finishes. The node's own output is passed downstream.
      const out = [];
      const status = Number(c.status || 200);
      for (const item of items) {
        const body = renderTemplate(c.body ?? "", item);
        const bodyParsed = renderRespondBody(c.body ?? "", item);
        const contentType = c.contentType || "json";
        // contentType "body" returns just the response body. "json" merges it
        // into the execution result so callers can also read node outputs
        // (e.g. the AI agent's "reply").
        if (contentType === "body") {
          ctx.webhookResponse = { status, body, bodyOnly: true };
        } else {
          ctx.webhookResponse = { status, body: bodyParsed !== undefined ? bodyParsed : body };
        }
        out.push({ json: { responded: true, status, body: bodyParsed !== undefined ? bodyParsed : body } });
      }
      return { byHandle: { out } };
    }

    case "webhookOut": {
      const out = [];
      for (const item of items) {
        const url = renderTemplate(c.url, item);
        const headers = JSON.parse(renderTemplate(JSON.stringify(parseJsonField(c.headers, {})), item));
        const body = renderTemplate(c.body ?? "", item);
        const res = await fetch(url, {
          method: c.method || "POST",
          headers,
          body: ["GET", "HEAD"].includes(c.method || "POST") ? undefined : body,
        });
        if (!res.ok) throw httpFailure(res.status, await res.text().catch(() => ""));
        out.push({ json: { sent: true, status: res.status } });
      }
      return { byHandle: { out } };
    }

    case "wait": {
      const unitMs = { seconds: 1000, minutes: 60000, hours: 3600000 }[c.unit || "seconds"] || 1000;
      const ms = Math.max(0, Number(c.duration || 0)) * unitMs;
      await sleep(ms, ctx.signal);
      return { byHandle: { out: items } };
    }

    // --- Microsoft 365 ------------------------------------------------------
    case "teamsSend": {
      const out = [];
      for (const item of items) {
        await assertPublicHttpUrl(c.webhookUrl);
        const res = await fetch(c.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: renderTemplate(c.text, item) }),
        });
        if (!res.ok) throw httpFailure(res.status, await res.text().catch(() => ""));
        out.push({ json: { sent: true, status: res.status } });
      }
      return { byHandle: { out } };
    }

    case "outlookSend": {
      const out = [];
      for (const item of items) {
        const to = renderTemplate(c.to, item)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((address) => ({ emailAddress: { address } }));
        const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject: renderTemplate(c.subject, item),
              body: { contentType: "text", content: renderTemplate(c.body, item) },
              toRecipients: to,
            },
            saveToSentItems: true,
          }),
        });
        const text = await res.text().catch(() => "");
        if (!res.ok) throw httpFailure(res.status, text);
        out.push({ json: { sent: true, status: res.status } });
      }
      return { byHandle: { out } };
    }

    case "m365Calendar": {
      const out = [];
      for (const item of items) {
        const attendees = renderTemplate(c.attendees ?? "", item)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((address) => ({ emailAddress: { address }, type: "required" }));
        const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: renderTemplate(c.subject, item),
            ...graphEventTimes(renderTemplate(c.start ?? "", item), renderTemplate(c.end ?? "", item), c.timeZone),
            attendees,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { created: true, status: res.status, id: data.id, webLink: data.webLink } });
      }
      return { byHandle: { out } };
    }

    case "onedriveUpload": {
      const out = [];
      for (const item of items) {
        const path = renderTemplate(c.path, item).replace(/^\/+/, "");
        const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}:/content`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "text/plain" },
          body: renderTemplate(c.content, item),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { uploaded: true, status: res.status, id: data.id, name: data.name, size: data.size, webUrl: data.webUrl } });
      }
      return { byHandle: { out } };
    }

    // --- Microsoft: SharePoint / Planner / Excel Online ----------------------
    case "sharepointUpload": {
      const out = [];
      for (const item of items) {
        const path = renderTemplate(c.path, item).replace(/^\/+/, "");
        const res = await fetch(`https://graph.microsoft.com/v1.0/sites/${c.siteId}/drive/root:/${path}:/content`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "text/plain" },
          body: renderTemplate(c.content, item),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { uploaded: true, status: res.status, id: data.id, name: data.name, size: data.size, webUrl: data.webUrl } });
      }
      return { byHandle: { out } };
    }

    case "sharepointListItem": {
      const out = [];
      for (const item of items) {
        const fields = renderTemplate(JSON.stringify(parseJsonField(c.fields, {})), item);
        const res = await fetch(`https://graph.microsoft.com/v1.0/sites/${c.siteId}/lists/${c.listId}/items`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: JSON.parse(fields) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { created: true, status: res.status, id: data.id, webUrl: data.webUrl } });
      }
      return { byHandle: { out } };
    }

    case "plannerTask": {
      const out = [];
      for (const item of items) {
        const body = { planId: c.planId, title: renderTemplate(c.title, item) };
        if (c.bucketId) body.bucketId = c.bucketId;
        if (c.dueDateTime) body.dueDateTime = renderTemplate(c.dueDateTime, item);
        const res = await fetch("https://graph.microsoft.com/v1.0/planner/tasks", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { created: true, status: res.status, id: data.id, title: data.title } });
      }
      return { byHandle: { out } };
    }

    case "excelAddRow": {
      const out = [];
      for (const item of items) {
        const path = renderTemplate(c.path, item).replace(/^\/+/, "");
        let values = [];
        try {
          const parsed = JSON.parse(renderTemplate(c.values ?? "[]", item));
          values = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          values = [];
        }
        const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${path}:/workbook/tables/${encodeURIComponent(c.tableName)}/rows/add`;
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [values] }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { added: true, status: res.status, index: data.index } });
      }
      return { byHandle: { out } };
    }

    // --- Excel / Word file generation ----------------------------------------
    case "excelCreate": {
      const out = [];
      for (const item of items) {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet(renderTemplate(c.sheetName || "Sheet1", item));
        let rows;
        if (c.inputParse === "json") {
          rows = jsonToRows(item.json?.text ?? item.json?.value ?? item.json);
        } else if (c.inputParse === "csv") {
          const raw = String(item.json?.text ?? item.json?.value ?? (typeof item.json === "string" ? item.json : JSON.stringify(item.json)));
          rows = parseCsv(raw);
        } else if (c.mode === "items") {
          rows = items.map((it) =>
            Object.values(it.json || {})
              .filter((v) => typeof v !== "object" || v === null)
              .map((v) => String(v))
          );
        } else {
          try {
            const parsed = JSON.parse(renderTemplate(c.rows ?? "[]", item));
            rows = Array.isArray(parsed) ? parsed : [];
          } catch {
            rows = [];
          }
        }
        rows.forEach((r) => ws.addRow(Array.isArray(r) ? r : [r]));
        if (rows.length > 0) ws.getRow(1).font = { bold: true };
        const buffer = await workbook.xlsx.writeBuffer();
        const fileName = renderTemplate(c.fileName, item) || "workbook.xlsx";
        const result = { fileName, size: buffer.length, rows: rows.length, fileBase64: buffer.toString("base64") };
        if (c.token && c.uploadTo) {
          try {
            Object.assign(
              result,
              await uploadToOneDrive(
                c.token,
                renderTemplate(c.uploadTo, item),
                buffer,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              )
            );
          } catch (err) {
            result.uploaded = false;
            result.error = String(err.message || err);
          }
        }
        out.push({ json: result });
      }
      return { byHandle: { out } };
    }

    case "wordCreate": {
      const out = [];
      for (const item of items) {
        const title = renderTemplate(c.title, item) || "Document";
        const style = c.style || "paragraphs";
        const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
        let contentCount = 0;
        if (style === "bullets") {
          const bullets = String(c.items || "")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((b) => renderTemplate(b, item));
          contentCount = bullets.length;
          bullets.forEach((b) => children.push(new Paragraph({ children: [new TextRun({ text: b })], bullet: { level: 0 } })));
        } else if (style === "numbered") {
          const list = String(c.items || "")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((b) => renderTemplate(b, item));
          contentCount = list.length;
          list.forEach((b, i) => children.push(new Paragraph({ text: `${i + 1}. ${b}` })));
        } else {
          const paragraphs = String(c.paragraphs || "")
            .split(/\n\s*\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((p) => renderTemplate(p, item));
          contentCount = paragraphs.length;
          paragraphs.forEach((p) => children.push(new Paragraph({ text: p })));
        }
        const doc = new Document({
          sections: [{ children }],
        });
        const buffer = await Packer.toBuffer(doc);
        const fileName = renderTemplate(c.fileName, item) || "document.docx";
        const result = { fileName, size: buffer.length, paragraphs: contentCount, style, fileBase64: buffer.toString("base64") };
        if (c.token && c.uploadTo) {
          try {
            Object.assign(
              result,
              await uploadToOneDrive(
                c.token,
                renderTemplate(c.uploadTo, item),
                buffer,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              )
            );
          } catch (err) {
            result.uploaded = false;
            result.error = String(err.message || err);
          }
        }
        out.push({ json: result });
      }
      return { byHandle: { out } };
    }

    // --- Other services: Twilio / SendGrid / Stripe / HubSpot / Airtable / GitLab / Trello / Asana / Supabase / Jira
    case "twilioSms": {
      const out = [];
      for (const item of items) {
        const body = new URLSearchParams({
          From: renderTemplate(c.from, item),
          To: renderTemplate(c.to, item),
          Body: renderTemplate(c.body, item),
        });
        const auth = "Basic " + Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64");
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { sent: true, status: res.status, sid: data.sid } });
      }
      return { byHandle: { out } };
    }

    case "sendgridEmail": {
      const out = [];
      for (const item of items) {
        const to = renderTemplate(c.to, item)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((email) => ({ email }));
        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to }],
            from: { email: renderTemplate(c.fromEmail, item), name: renderTemplate(c.fromName || "", item) || undefined },
            subject: renderTemplate(c.subject, item),
            content: [{ type: "text/plain", value: renderTemplate(c.content, item) }],
          }),
        });
        const text = await res.text().catch(() => "");
        if (!res.ok) throw httpFailure(res.status, text);
        out.push({ json: { sent: true, status: res.status } });
      }
      return { byHandle: { out } };
    }

    case "stripePaymentLink": {
      const out = [];
      for (const item of items) {
        const body = new URLSearchParams({
          "line_items[0][price_data][currency]": renderTemplate(c.currency || "usd", item),
          "line_items[0][price_data][unit_amount]": String(renderTemplate(Number(c.amount ?? 0), item)),
          "line_items[0][price_data][product_data][name]": renderTemplate(c.description || "Payment", item),
          "line_items[0][quantity]": String(Number(c.quantity ?? 1)),
        });
        const res = await fetch("https://api.stripe.com/v1/payment_links", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { created: true, status: res.status, url: data.url, id: data.id } });
      }
      return { byHandle: { out } };
    }

    case "hubspotContact": {
      const out = [];
      for (const item of items) {
        const props = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.properties, {})), item), {});
        const res = await fetch("https://api.hubspot.com/crm/v3/objects/contacts", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ properties: props }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { created: true, status: res.status, id: data.id } });
      }
      return { byHandle: { out } };
    }

    case "airtableRow": {
      const out = [];
      for (const item of items) {
        const fields = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.fields, {})), item), {});
        const res = await fetch(airtableUrl(c), {
          method: "POST",
          headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw airtableFailure(res.status, data, c);
        out.push({ json: { created: true, status: res.status, id: data.id } });
      }
      return { byHandle: { out } };
    }

    case "gitlabIssue": {
      const out = [];
      for (const item of items) {
        const res = await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(c.projectId)}/issues`, {
          method: "POST",
          // a connected GitLab account sends an OAuth token, which needs Bearer
          headers: { ...(c.__authBearer ? { Authorization: `Bearer ${c.token}` } : { "PRIVATE-TOKEN": c.token }), "Content-Type": "application/json" },
          body: JSON.stringify({ title: renderTemplate(c.title, item), description: renderTemplate(c.description, item) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { created: true, status: res.status, iid: data.iid, url: data.web_url } });
      }
      return { byHandle: { out } };
    }

    case "trelloCard": {
      const out = [];
      for (const item of items) {
        const params = new URLSearchParams({ key: c.apiKey, token: c.token, idList: c.listId, name: renderTemplate(c.name, item), desc: renderTemplate(c.description, item) });
        const res = await fetch(`https://api.trello.com/1/cards?${params}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { created: true, status: res.status, id: data.id, url: data.url } });
      }
      return { byHandle: { out } };
    }

    case "asanaTask": {
      const out = [];
      for (const item of items) {
        const res = await fetch("https://app.asana.com/api/1.0/tasks", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ data: { projects: [c.projectId], name: renderTemplate(c.name, item), notes: renderTemplate(c.notes, item) } }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.errors?.[0]?.message || "");
        out.push({ json: { created: true, status: res.status, gid: data.data?.gid, url: data.data?.permalink_url } });
      }
      return { byHandle: { out } };
    }

    case "supabaseInsert": {
      const out = [];
      for (const item of items) {
        const row = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.row, {})), item), {});
        const res = await fetch(`${String(c.url).replace(/\/+$/, "")}/rest/v1/${encodeURIComponent(c.tableName)}`, {
          method: "POST",
          headers: { apikey: c.anonKey, Authorization: `Bearer ${c.anonKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify(row),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { inserted: true, status: res.status, data } });
      }
      return { byHandle: { out } };
    }

    case "jiraIssue": {
      const out = [];
      for (const item of items) {
        const base = String(c.baseUrl || "").replace(/\/+$/, "");
        const auth = "Basic " + Buffer.from(`${c.email}:${c.apiToken}`).toString("base64");
        const res = await fetch(`${base}/rest/api/2/issue`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              project: { key: renderTemplate(c.projectKey, item) },
              issuetype: { name: renderTemplate(c.issueType || "Task", item) },
              summary: renderTemplate(c.summary, item),
              description: renderTemplate(c.description, item),
            },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.errorMessages?.[0] || "");
        out.push({ json: { created: true, status: res.status, key: data.key, url: `${base}/browse/${data.key || ""}` } });
      }
      return { byHandle: { out } };
    }

    case "hash": {
      const algorithm = ["md5", "sha1", "sha256"].includes(c.algorithm) ? c.algorithm : "sha256";
      const storeIn = c.storeIn || "hash";
      const out = items.map((item) => {
        const value = renderTemplate(c.value ?? "", item);
        const digest = createHash(algorithm).update(String(value)).digest("hex");
        return { json: { ...item.json, [storeIn]: digest } };
      });
      return { byHandle: { out } };
    }

    // --- additional services --------------------------------------------------
    case "weather": {
      const out = [];
      for (const item of items) {
        const city = renderTemplate(c.city ?? "", item);
        const units = c.units || "metric";
        const res = await fetch(
          `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=${units}&appid=${c.apiKey}`
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        // OpenWeather answers 200 with cod != 200 for an unknown city.
        if (data.cod !== 200) throw serviceFailure(data.message || `City '${city}' not found`);
        out.push({
          json: {
            fetched: true,
            status: res.status,
            city,
            units,
            temp: data.main?.temp,
            feelsLike: data.main?.feels_like,
            humidity: data.main?.humidity,
            pressure: data.main?.pressure,
            description: data.weather?.[0]?.description,
            icon: data.weather?.[0]?.icon,
            windSpeed: data.wind?.speed,
            windDeg: data.wind?.deg,
            clouds: data.clouds?.all,
            sunrise: data.sys?.sunrise,
            sunset: data.sys?.sunset,
            coordinates: data.coord,
          },
        });
      }
      return { byHandle: { out } };
    }

    case "cryptoPrice": {
      const out = [];
      for (const item of items) {
        const coin = renderTemplate(c.coinId ?? "bitcoin", item);
        const vs = renderTemplate(c.vsCurrency ?? "usd", item);
        const url =
          `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=${encodeURIComponent(vs)}` +
          (c.include24h !== false ? "&include_24hr_change=true" : "");
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        const row = data[coin] || {};
        if (!res.ok) throw httpFailure(res.status, data.error ? String(data.error) : "");
        if (row[vs] === undefined) throw serviceFailure(data.error ? String(data.error) : `Coin '${coin}' not found`);
        out.push({
          json: {
            ...item.json,
            fetched: true,
            status: res.status,
            coin,
            vs,
            [c.storeIn || "price"]: row[vs] ?? null,
            change24h: row[`${vs}_24h_change`] ?? null,
          },
        });
      }
      return { byHandle: { out } };
    }

    // Crypto exchanges — signing and per-exchange shapes live in
    // server/crypto-exchanges.js; this only renders {{vars}} per item.
    case "coinbaseExchange":
    case "binanceExchange":
    case "krakenExchange":
    case "bybitExchange":
    case "okxExchange":
    case "kucoinExchange": {
      const out = [];
      for (const item of items) {
        const text = (key) => String(renderTemplate(c[key] ?? "", item)).trim();
        const cfg = {
          operation: c.operation || "price",
          symbol: text("symbol"),
          side: c.side || "buy",
          amount: text("amount"),
          amountIn: c.amountIn || "base",
          limitPrice: text("limitPrice"),
          // A workflow in the Test environment never places real orders.
          testMode: c.testMode !== false || inTestEnvironment(),
          orderId: text("orderId"),
          apiKey: String(c.apiKey ?? "").trim(),
          secret: String(c.secret ?? "").trim(),
          passphrase: String(c.passphrase ?? "").trim(),
          baseUrl: String(c.baseUrl || getNodeDef(node.type)?.defaults?.baseUrl || "").trim().replace(/\/+$/, ""),
        };
        if (cfg.baseUrl) await assertPublicHttpUrl(cfg.baseUrl);
        const isOrder = cfg.operation === "marketOrder" || cfg.operation === "limitOrder";
        const spend = { workflowId: ctx?.workflowId, nodeId: node.id, amount: cfg.amount, maxAmount: c.maxAmount, maxDaily: c.maxDaily };
        if (isOrder) await checkSpend(spend);
        const result = await runExchange(node.type, cfg);
        if (isOrder && !result?.test) await recordSpend(spend);
        out.push({ json: { ...item.json, exchange: node.type.replace("Exchange", ""), operation: cfg.operation, [c.storeIn || "result"]: result } });
      }
      return { byHandle: { out } };
    }

    // On-chain wallets (server/crypto-wallets.js). The private key is only
    // needed to send; reading any address's balance works without one.
    case "evmWallet":
    case "solanaWallet": {
      const out = [];
      for (const item of items) {
        const text = (key) => String(renderTemplate(c[key] ?? "", item)).trim();
        const cfg = {
          operation: c.operation || "balance",
          network: c.network || "ethereum",
          rpcUrl: text("rpcUrl").replace(/\/+$/, ""),
          coinSymbol: text("coinSymbol"),
          address: text("address"),
          tokenAddress: text("tokenAddress"),
          to: text("to"),
          amount: text("amount"),
          txHash: text("txHash"),
          testMode: c.testMode !== false || inTestEnvironment(),
          privateKey: String(c.privateKey ?? "").trim(),
        };
        const isSend = node.type === "evmWallet" && (cfg.operation === "send" || cfg.operation === "sendToken");
        const spend = { workflowId: ctx?.workflowId, nodeId: node.id, amount: cfg.amount, maxAmount: c.maxAmount, maxDaily: c.maxDaily };
        if (isSend) await checkSpend(spend);
        const run = node.type === "evmWallet" ? runEvmWallet : runSolanaWallet;
        const result = await run(cfg, { assertUrl: assertPublicHttpUrl });
        if (isSend && !result?.test) await recordSpend(spend);
        out.push({ json: { ...item.json, operation: cfg.operation, [c.storeIn || "result"]: result } });
      }
      return { byHandle: { out } };
    }

    // Dashboard — one data point per item (or the items replace the series),
    // drawn on the shareable page /d/<id> (server/dashboards.js).
    case "dashboard": {
      const points = [];
      for (const item of items) {
        const raw = String(renderTemplate(c.value ?? "", item)).trim();
        const v = Number(raw.replace(/[, _]/g, ""));
        if (raw === "" || !Number.isFinite(v)) {
          throw attachCode(new Error(`Value “${raw.slice(0, 60)}” is not a number. Point Value at a numeric field, e.g. {{result.price}}.`), "PARSE_FAILED");
        }
        points.push({ v, label: String(renderTemplate(c.label ?? "", item)).trim() });
      }
      if (!points.length) return { byHandle: { out: [] } };
      const saved = await writeSeries({
        userId: ctx?.userId,
        name: renderTemplate(c.dashboard ?? "", items[0]),
        series: renderTemplate(c.series ?? "", items[0]),
        chart: c.chart || "line",
        points,
        replace: c.mode === "replace",
        keep: c.keep,
      });
      const path = `/d/${saved.id}`;
      const base = await publicBaseUrl();
      const dashboardUrl = base ? `${base}${path}` : path;
      return { byHandle: { out: items.map((item, i) => ({ json: { ...item.json, dashboardUrl, dashboard: saved.name, series: saved.series, value: points[i].v, pointsStored: saved.points } })) } };
    }

    case "polymarket": {
      const out = [];
      for (const item of items) {
        const text = (key) => String(renderTemplate(c[key] ?? "", item)).trim();
        const cfg = {
          operation: c.operation || "search",
          query: text("query"),
          market: text("market"),
          outcome: text("outcome") || "Yes",
          wallet: text("wallet"),
          interval: c.interval || "1d",
          limit: c.limit,
        };
        const result = await runPolymarket(cfg);
        out.push({ json: { ...item.json, operation: cfg.operation, [c.storeIn || "result"]: result } });
      }
      return { byHandle: { out } };
    }

    case "ipGeo": {
      const out = [];
      for (const item of items) {
        const ip = String(renderTemplate(c.ip ?? "", item)).trim();
        // ip-api.com — free, 45 requests/min, no API key (HTTP endpoint)
        const fields = "status,message,country,countryCode,region,regionName,city,lat,lon,timezone,isp,org,query";
        const res = await fetch(`http://ip-api.com/json/${ip}?fields=${fields}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || data.error || "");
        if (data.status !== "success") throw serviceFailure(data.message || data.error || `Could not look up '${ip || "this IP"}'`);
        out.push({
          json: {
            ...item.json,
            fetched: true,
            status: res.status,
            [c.storeIn || "geo"]: data,
            city: data.city,
            region: data.regionName,
            country: data.country,
            countryCode: data.countryCode,
            lat: data.lat,
            lon: data.lon,
            timezone: data.timezone,
            isp: data.isp,
          },
        });
      }
      return { byHandle: { out } };
    }

    case "wordpressPost": {
      const out = [];
      for (const item of items) {
        const base = String(c.baseUrl || "").replace(/\/+$/, "");
        const auth = "Basic " + Buffer.from(`${c.user}:${c.appPassword}`).toString("base64");
        const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            title: renderTemplate(c.title ?? "", item),
            content: renderTemplate(c.content ?? "", item),
            status: c.status || "publish",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || data.code || "");
        out.push({ json: { created: true, status: res.status, id: data.id, link: data.link, slug: data.slug } });
      }
      return { byHandle: { out } };
    }

    case "googleCalendar": {
      const out = [];
      for (const item of items) {
        const body = {
          summary: renderTemplate(c.summary ?? "", item),
          description: renderTemplate(c.description ?? "", item) || undefined,
          ...calendarEventTimes(renderTemplate(c.start ?? "", item), renderTemplate(c.end ?? "", item), c.timeZone),
        };
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.calendarId || "primary")}/events`,
          { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { created: true, status: res.status, id: data.id, htmlLink: data.htmlLink } });
      }
      return { byHandle: { out } };
    }

    case "dropboxUpload": {
      const out = [];
      for (const item of items) {
        const content = renderTemplate(c.content ?? "", item);
        const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.token}`,
            "Content-Type": "application/octet-stream",
            "Dropbox-API-Arg": JSON.stringify({
              path: renderTemplate(c.path ?? "", item),
              mode: c.mode === "add" ? "add" : "overwrite",
              autorename: true,
            }),
          },
          body: content,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.error_summary || data.error?.summary || "");
        out.push({ json: { uploaded: true, status: res.status, name: data.name, id: data.id, size: data.size, rev: data.rev } });
      }
      return { byHandle: { out } };
    }

    case "mailchimpSub": {
      const out = [];
      for (const item of items) {
        const key = String(c.apiKey || "");
        const dc = key.includes("-") ? key.split("-").pop() : "us1";
        const email = renderTemplate(c.email ?? "", item);
        const body = { email_address: email, status: c.status || "subscribed", merge_fields: {} };
        if (c.firstName) body.merge_fields.FNAME = renderTemplate(c.firstName, item);
        if (c.lastName) body.merge_fields.LNAME = renderTemplate(c.lastName, item);
        const res = await fetch(
          `https://${dc}.api.mailchimp.com/3.0/lists/${c.listId}/members/${encodeURIComponent(email.toLowerCase())}`,
          { method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.detail || data.title || "");
        out.push({ json: { saved: true, status: res.status, id: data.id, email: data.email_address, memberStatus: data.status } });
      }
      return { byHandle: { out } };
    }

    case "resendEmail": {
      const out = [];
      for (const item of items) {
        const body = {
          from: renderTemplate(c.from ?? "", item),
          to: renderTemplate(c.to ?? "", item)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          subject: renderTemplate(c.subject ?? "", item),
        };
        if (c.html) body.html = renderTemplate(c.html, item);
        if (c.text) body.text = renderTemplate(c.text, item);
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { sent: true, status: res.status, id: data.id } });
      }
      return { byHandle: { out } };
    }

    case "zendeskTicket": {
      const out = [];
      for (const item of items) {
        const auth = "Basic " + Buffer.from(`${c.email}/token:${c.token}`).toString("base64");
        const res = await fetch(`https://${c.subdomain}.zendesk.com/api/v2/tickets.json`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket: {
              subject: renderTemplate(c.subject ?? "", item),
              comment: { body: renderTemplate(c.comment ?? "", item) },
              priority: c.priority || "normal",
              type: c.type || "question",
            },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.error?.message || data.error || "");
        out.push({ json: { created: true, status: res.status, id: data.ticket?.id, url: data.ticket?.url } });
      }
      return { byHandle: { out } };
    }

    case "pagerdutyIncident": {
      const out = [];
      for (const item of items) {
        const body = {
          routing_key: c.routingKey,
          event_action: "trigger",
          payload: {
            summary: renderTemplate(c.summary ?? "", item),
            source: renderTemplate(c.source ?? "wflow", item),
            severity: c.severity || "critical",
          },
        };
        if (c.dedupKey) body.dedup_key = renderTemplate(c.dedupKey, item);
        const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.error?.message || data.message || "");
        out.push({ json: { triggered: true, status: res.status, dedupKey: data.dedup_key } });
      }
      return { byHandle: { out } };
    }

    case "redditSearch": {
      const out = [];
      for (const item of items) {
        const query = renderTemplate(c.query ?? "", item);
        const sub = renderTemplate(c.subreddit ?? "", item).trim();
        const limit = Number(c.limit || 10);
        const sort = c.sort || "relevance";
        const url = sub
          ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}&restrict_sr=1`
          : `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}`;
        const res = await fetch(url, { headers: { "User-Agent": "wflow/1.0" } });
        const contentType = res.headers.get("content-type") || "";
        const blocked = contentType.includes("text/html");
        const data = await res.json().catch(() => ({}));
        const posts = (data.data?.children || []).map((ch) => {
          const d = ch.data || {};
          return {
            id: d.id,
            title: d.title,
            author: d.author,
            subreddit: d.subreddit,
            url: `https://www.reddit.com${d.permalink || ""}`,
            score: d.score,
            numComments: d.num_comments,
            createdUtc: d.created_utc,
            selftext: (d.selftext || "").slice(0, 500),
          };
        });
        if (blocked) throw serviceFailure("Reddit blocked this request (returned HTML). Try from a home connection or a different network.");
        if (!res.ok) throw httpFailure(res.status, data.error ? String(data.error) : "");
        if (data.error) throw serviceFailure(String(data.error));
        if (data.data === undefined) throw serviceFailure(`Unexpected response (HTTP ${res.status})`);
        out.push({
          json: {
            ...item.json,
            fetched: true,
            status: res.status,
            [c.storeIn || "posts"]: posts,
            count: posts.length,
          },
        });
      }
      return { byHandle: { out } };
    }

    // --- JavaScript list operations ------------------------------------------
    // All four run the user's code in an isolated child process (see
    // server/code-sandbox.js): no filesystem, no child processes, no secrets in
    // the environment. A broken JS Transform still fails the node so the user's
    // "If this node fails" setting decides what happens.
    case "jsTransform": {
      try {
        const out = await runSandboxedCode("jsTransform", c.code, items);
        return { byHandle: { out } };
      } catch (err) {
        throw attachCode(new Error(String(err.message || err)), "CODE_ERROR");
      }
    }

    case "jsFilter": {
      const out = await runSandboxedCode("jsFilter", c.code, items);
      return { byHandle: { out } };
    }

    case "jsAggregate": {
      const out = await runSandboxedCode("jsAggregate", c.code, items);
      return { byHandle: { out } };
    }

    // --- AI output parser -----------------------------------------------------
    case "aiParser": {
      const out = [];
      for (const item of items) {
        const text = String(item.json?.[c.sourceField || "reply"] ?? "");
        let parsed = null;
        let error = null;
        if (c.mode === "json") {
          parsed = extractJson(text);
          if (parsed === null) error = "No valid JSON found in the reply";
        } else if (c.mode === "keyvalue") {
          parsed = {};
          for (const line of text.split(/\r?\n/)) {
            const m = line.match(/^([^:]+):\s*(.*)$/);
            if (m) parsed[m[1].trim()] = m[2].trim();
          }
          if (Object.keys(parsed).length === 0) error = "No 'key: value' lines found";
        } else if (c.mode === "regex") {
          try {
            const re = new RegExp(c.pattern, "g");
            const names = String(c.fieldNames || "").split(",").map((s) => s.trim()).filter(Boolean);
            const matches = [...text.matchAll(re)];
            const list = matches.map((m) => {
              const obj = {};
              names.forEach((n, idx) => (obj[n] = m[idx + 1] ?? ""));
              return obj;
            });
            parsed = list.length === 1 ? list[0] : list;
            if (list.length === 0) error = "Regex did not match";
          } catch (err) {
            error = String(err.message || err);
          }
        }
        out.push({ json: { ...item.json, parsed, parseError: error, parsedOk: !error } });
      }
      return { byHandle: { out } };
    }

    case "log": {
      for (const item of items) {
        const line = renderTemplate(c.message ?? "{{json}}", item);
        ctx?.logLines?.push(`[${node.data?.label || node.type}] ${line}`);
      }
      return { byHandle: { out: items } };
    }

    // --- logic --------------------------------------------------------------
    case "if": {
      const truthy = [];
      const falsy = [];
      for (const item of items) {
        const a = renderTemplate(c.valueA ?? "", item);
        const b = renderTemplate(c.valueB ?? "", item);
        const cs = c.caseSensitive;
        const A = cs ? a : String(a).toLowerCase();
        const B = cs ? b : String(b).toLowerCase();
        let ok = false;
        switch (c.operator) {
          case "equals": ok = A === B; break;
          case "notEquals": ok = A !== B; break;
          case "contains": ok = String(A).includes(String(B)); break;
          case "notContains": ok = !String(A).includes(String(B)); break;
          case "startsWith": ok = String(A).startsWith(String(B)); break;
          case "regex": {
            try {
              ok = new RegExp(String(B)).test(String(A));
            } catch {
              ok = false;
            }
            break;
          }
          case "gt": ok = Number(A) > Number(B); break;
          case "lt": ok = Number(A) < Number(B); break;
          case "exists": ok = a !== "" && a !== undefined && a !== null; break;
          case "notExists": ok = a === "" || a === undefined || a === null; break;
          default: ok = false;
        }
        (ok ? truthy : falsy).push(item);
      }
      return { byHandle: { true: truthy, false: falsy } };
    }

    case "switch": {
      const cases = c.cases || [];
      const out = { default: [] };
      cases.forEach((_row, i) => {
        out[`case-${i}`] = [];
      });
      const cs = !!c.caseSensitive;
      const norm = (v) => (cs ? String(v) : String(v).toLowerCase());
      const mode = c.matchMode === "contains" || c.matchMode === "startsWith" ? c.matchMode : "equals";
      for (const item of items) {
        const a = norm(renderTemplate(c.value ?? "", item));
        let matched = false;
        cases.forEach((row, i) => {
          if (matched) return;
          const raw = String(row?.key ?? "");
          if (!raw) return;
          const b = norm(raw);
          let ok = false;
          if (mode === "contains") ok = a.includes(b);
          else if (mode === "startsWith") ok = a.startsWith(b);
          else ok = a === b;
          if (ok) {
            out[`case-${i}`].push(item);
            matched = true;
          }
        });
        if (!matched) out.default.push(item);
      }
      return { byHandle: out };
    }

    case "set": {
      const parseValues = !!c.parseValues;
      const parseValue = (v) => {
        if (!parseValues) return v;
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      };
      const out = items.map((item) => {
        const json = { ...item.json };
        for (const row of c.fields || []) {
          if (!row?.key) continue;
          if (c.mode === "delete") delete json[row.key];
          else json[row.key] = parseValue(renderTemplate(row.value, item));
        }
        return { json };
      });
      return { byHandle: { out } };
    }

    case "code": {
      // Runs in the isolated child process (server/code-sandbox.js); user code
      // may use await / fetch but reaches no filesystem, process or secret.
      const out = await runSandboxedCode("code", c.code, items);
      return { byHandle: { out } };
    }

    case "subworkflow":
      return runSubWorkflow(node, items, ctx);

    case "loop": {
      const out = items.map((item, i) => ({ json: { ...item.json, loop: { index: i, total: items.length } } }));
      return { byHandle: { out } };
    }

    case "loopEnd":
      return { byHandle: { out: items } };

    case "merge": {
      // merge is applied at the graph level; passthrough here
      return { byHandle: { out: items } };
    }

    case "limit": {
      const n = Math.max(0, Number(c.maxItems || 0));
      return { byHandle: { out: items.slice(0, n) } };
    }

    case "sort": {
      const field = String(c.field || "");
      const dir = c.order === "desc" ? -1 : 1;
      const numeric = !!c.numeric;
      const out = [...items].sort((a, b) => {
        const va = getPath(a.json, field);
        const vb = getPath(b.json, field);
        let cmp;
        if (numeric) {
          cmp = (Number(va) || 0) - (Number(vb) || 0);
        } else {
          cmp = String(va ?? "").localeCompare(String(vb ?? ""));
        }
        return (Number.isFinite(cmp) ? cmp : 0) * dir;
      });
      return { byHandle: { out } };
    }

    case "dedupe": {
      const field = String(c.field || "");
      const seen = new Set();
      const out = [];
      for (const item of items) {
        const val = getPath(item.json, field);
        const key = typeof val === "object" ? JSON.stringify(val) : String(val ?? "");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return { byHandle: { out } };
    }

    case "pluck": {
      const field = String(c.field || "");
      const value = items.map((item) => getPath(item.json, field));
      if (!c.keep) {
        return { byHandle: { out: value.map((v) => ({ json: v && typeof v === "object" ? v : { value: v } })) } };
      }
      const storeIn = c.storeIn || "value";
      return {
        byHandle: {
          out: items.map((item, i) => ({ json: { ...item.json, [storeIn]: value[i] } })),
        },
      };
    }

    case "stringTransform": {
      const field = String(c.field || "");
      const op = c.operation || "upper";
      const out = items.map((item) => {
        const joined = { ...item.json };
        const current = getPath(joined, field);
        const raw = current === undefined || current === null ? "" : String(current);
        let res = raw;
        if (op === "upper") res = raw.toUpperCase();
        else if (op === "lower") res = raw.toLowerCase();
        else if (op === "trim") res = raw.trim();
        else if (op === "title") res = raw.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
        else if (op === "replace") res = raw.split(c.target ?? "").join(c.replacement ?? "");
        const storeIn = String(c.storeIn || "").trim() || field;
        setPathIn(joined, storeIn, res);
        return { json: joined };
      });
      return { byHandle: { out } };
    }

    case "splitOut": {
      const field = String(c.field || "");
      const include = c.includeOtherFields === true;
      const out = [];
      for (const item of items) {
        const val = getPath(item.json, field);
        const list = Array.isArray(val) ? val : [val];
        for (const el of list) {
          if (el === undefined || el === null) continue;
          out.push({ json: include ? { ...item.json, [field]: el } : el && typeof el === "object" ? { ...el } : { value: el } });
        }
      }
      return { byHandle: { out } };
    }

    case "stickyNote": {
      // A note on the canvas — passes items through untouched.
      return { byHandle: { out: items } };
    }

    case "math": {
      const op = c.operation || "add";
      const field = String(c.field || "amount");
      const num = Number(c.number ?? 0);
      const outField = String(c.outputField || field);
      const out = items.map((item) => {
        const joined = { ...item.json };
        const current = Number(getPath(joined, field) ?? 0);
        let res;
        switch (op) {
          case "add": res = current + num; break;
          case "subtract": res = current - num; break;
          case "multiply": res = current * num; break;
          case "divide": res = num !== 0 ? current / num : NaN; break;
          case "round": res = Math.round(current); break;
          case "floor": res = Math.floor(current); break;
          case "ceil": res = Math.ceil(current); break;
          case "abs": res = Math.abs(current); break;
          case "modulo": res = num !== 0 ? current % num : NaN; break;
          case "power": res = Math.pow(current, num); break;
          default: res = current;
        }
        setPathIn(joined, outField, res);
        return { json: joined };
      });
      return { byHandle: { out } };
    }

    case "dateAndTime": {
      const op = c.operation || "now";
      const outField = String(c.outputField || "timestamp");
      const unit = c.unit || "days";
      const amount = Number(c.amount ?? 0);
      const format = c.format || "ISO";
      const pad = (n) => String(n).padStart(2, "0");
      const fmt = (d) => {
        if (!d || isNaN(d.getTime())) return null;
        switch (format) {
          case "unix": return Math.floor(d.getTime() / 1000);
          case "unixMs": return d.getTime();
          case "dateOnly": return d.toISOString().slice(0, 10);
          case "dateTime": return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          case "readable": return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
          case "custom": {
            const map = { YYYY: String(d.getFullYear()), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
            return String(c.customFormat || "YYYY-MM-DD HH:mm").replace(/YYYY|MM|DD|HH|mm|ss/g, (k) => map[k]);
          }
          default: return d.toISOString();
        }
      };
      const addTime = (d, delta) => {
        const outDate = new Date(d.getTime());
        if (unit === "months") outDate.setMonth(outDate.getMonth() + delta);
        else if (unit === "years") outDate.setFullYear(outDate.getFullYear() + delta);
        else if (unit === "weeks") outDate.setTime(outDate.getTime() + delta * 7 * 86400000);
        else if (unit === "hours") outDate.setTime(outDate.getTime() + delta * 3600000);
        else if (unit === "minutes") outDate.setTime(outDate.getTime() + delta * 60000);
        else if (unit === "seconds") outDate.setTime(outDate.getTime() + delta * 1000);
        else outDate.setTime(outDate.getTime() + delta * 86400000);
        return outDate;
      };
      const out = items.map((item) => {
        const joined = { ...item.json };
        const inputRaw = c.inputField ? renderTemplate(c.inputField, item) : "";
        const base = inputRaw ? new Date(inputRaw) : new Date();
        let res;
        if (op === "now") res = fmt(new Date());
        else if (op === "format" || op === "parse") res = fmt(base);
        else if (op === "add") res = fmt(addTime(base, amount));
        else if (op === "subtract") res = fmt(addTime(base, -amount));
        else if (op === "diff") {
          const otherRaw = c.inputField2 ? renderTemplate(c.inputField2, item) : "";
          const other = otherRaw ? new Date(otherRaw) : new Date();
          res = base.getTime() - other.getTime();
        } else res = fmt(base);
        setPathIn(joined, outField, res);
        return { json: joined };
      });
      return { byHandle: { out } };
    }

    // Do Nothing — a deliberate no-op step; input passes straight through.
    case "noop":
      return { byHandle: { out: items } };

    // Stop and Error — fail the run on purpose with a readable message.
    case "stopError": {
      const message = renderTemplate(c.message || "Workflow stopped on purpose.", items[0] || { json: {} });
      throw attachCode(new Error(message), "STOPPED_ON_PURPOSE");
    }

    // Parse / Stringify JSON — read a JSON string field into real data, or turn
    // data back into a JSON string.
    case "jsonParse": {
      const out = items.map((item) => {
        const source = getPath(item.json, renderTemplate(c.field || "", item));
        const storeIn = c.storeIn || "parsed";
        let value;
        if (c.mode === "stringify") {
          value = typeof source === "string" ? source : JSON.stringify(source ?? null);
        } else {
          if (typeof source === "object" && source !== null) value = source;
          else {
            try {
              value = JSON.parse(String(source ?? ""));
            } catch {
              throw attachCode(new Error(`JSON parse failed: '${truncate(source)}' is not valid JSON.`), "PARSE_FAILED");
            }
          }
        }
        const base = c.keepRest === false ? {} : { ...item.json };
        return { json: { ...base, [storeIn]: value } };
      });
      return { byHandle: { out } };
    }

    // Base64 encode / decode
    case "base64": {
      const storeIn = c.storeIn || "base64";
      const out = items.map((item) => {
        const value = renderTemplate(c.value ?? "", item);
        if (c.mode === "decode") {
          return { json: { ...item.json, [storeIn]: Buffer.from(String(value), "base64").toString("utf8") } };
        }
        return { json: { ...item.json, [storeIn]: Buffer.from(String(value), "utf8").toString("base64") } };
      });
      return { byHandle: { out } };
    }

    // Encrypt / Decrypt — AES-256-GCM with a scrypt-derived key. The output is
    // base64 of [salt | iv | authTag | ciphertext], so decrypting in a later run
    // only needs the same passphrase.
    case "encrypt": {
      const storeIn = c.storeIn || (c.mode === "decrypt" ? "plaintext" : "ciphertext");
      const out = items.map((item) => {
        const passphrase = renderTemplate(c.passphrase ?? "", item);
        if (!passphrase) throw attachCode(new Error("Encrypt / Decrypt needs a passphrase."), "MISSING_CONFIG");
        const value = renderTemplate(c.value ?? "", item);
        if (c.mode === "decrypt") {
          let plaintext;
          try {
            const raw = Buffer.from(String(value), "base64");
            const salt = raw.subarray(0, 16);
            const iv = raw.subarray(16, 28);
            const tag = raw.subarray(28, 44);
            const data = raw.subarray(44);
            const key = scryptSync(passphrase, salt, 32);
            const decipher = createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
          } catch {
            throw attachCode(new Error("Decrypt failed — wrong passphrase or corrupted value."), "CRYPTO_FAILED");
          }
          return { json: { ...item.json, [storeIn]: plaintext } };
        }
        const salt = randomBytes(16);
        const iv = randomBytes(12);
        const key = scryptSync(passphrase, salt, 32);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const enc = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
        const payload = Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString("base64");
        return { json: { ...item.json, [storeIn]: payload } };
      });
      return { byHandle: { out } };
    }

    // URL — parse into parts, or build one from parts.
    case "urlParse": {
      const storeIn = c.storeIn || "url";
      const out = items.map((item) => {
        if (c.mode === "build") {
          const base = renderTemplate(c.base ?? "", item).replace(/\/+$/, "");
          let url;
          try {
            url = new URL(base);
          } catch {
            throw attachCode(new Error(`URL build failed: '${base}' is not a valid base URL.`), "PARSE_FAILED");
          }
          const p = renderTemplate(c.path ?? "", item);
          if (p) url.pathname = `${url.pathname.replace(/\/+$/, "")}/${String(p).replace(/^\/+/, "")}`;
          for (const row of c.query || []) {
            if (!row?.key) continue;
            url.searchParams.set(renderTemplate(row.key, item), renderTemplate(row.value ?? "", item));
          }
          return { json: { ...item.json, [storeIn]: url.toString() } };
        }
        const raw = String(renderTemplate(c.url ?? "", item)).trim();
        try {
          const url = new URL(raw);
          const query = {};
          for (const [k, v] of url.searchParams.entries()) query[k] = v;
          return {
            json: {
              ...item.json,
              [storeIn]: {
                url: url.toString(),
                protocol: url.protocol.replace(":", ""),
                host: url.host,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                query,
                hash: url.hash,
              },
            },
          };
        } catch {
          throw attachCode(new Error(`URL parse failed: '${raw}' is not a valid URL.`), "PARSE_FAILED");
        }
      });
      return { byHandle: { out } };
    }

    case "summarize": {
      const groupBy = String(c.groupBy || "");
      const ops = Array.isArray(c.operations) ? c.operations : parseJsonField(c.operations, []);
      const groups = new Map();
      for (const item of items) {
        const key = groupBy ? String(getPath(item.json, groupBy) ?? "") : "__all__";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item.json);
      }
      const out = [];
      for (const [key, rows] of groups) {
        const row = groupBy ? { [groupBy]: key } : {};
        for (const o of ops) {
          const f = String(o.field || "");
          const opName = String(o.operation || "count");
          const raws = rows.map((r) => getPath(r, f));
          const nums = raws.map((v) => Number(v)).filter((v) => !isNaN(v));
          let val;
          switch (opName) {
            case "sum": val = nums.reduce((a, b) => a + b, 0); break;
            case "avg": val = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; break;
            case "count": val = rows.length; break;
            case "min": val = nums.length ? Math.min(...nums) : null; break;
            case "max": val = nums.length ? Math.max(...nums) : null; break;
            case "first": val = raws[0] ?? null; break;
            case "last": val = raws[raws.length - 1] ?? null; break;
            default: val = rows.length;
          }
          row[o.field] = val;
        }
        out.push({ json: row });
      }
      return { byHandle: { out } };
    }

    case "filter": {
      const conds = Array.isArray(c.conditions) ? c.conditions : parseJsonField(c.conditions, []);
      const out = items.filter((item) => {
        for (const cond of conds) {
          const A = getPath(item.json, String(cond.field || ""));
          const a = A === undefined || A === null ? "" : A;
          const op = cond.operator || "equals";
          const strA = String(a);
          const strB = String(cond.value ?? "");
          let ok = false;
          switch (op) {
            case "equals": ok = strA === strB; break;
            case "notEquals": ok = strA !== strB; break;
            case "contains": ok = strA.includes(strB); break;
            case "notContains": ok = !strA.includes(strB); break;
            case "startsWith": ok = strA.startsWith(strB); break;
            case "gt": ok = Number(a) > Number(cond.value); break;
            case "lt": ok = Number(a) < Number(cond.value); break;
            case "exists": ok = a !== "" && a !== undefined && a !== null; break;
            case "regex": {
              try {
                ok = new RegExp(String(cond.value)).test(strA);
              } catch {
                ok = false;
              }
              break;
            }
            default: ok = false;
          }
          if (!ok) return false;
        }
        return true;
      });
      return { byHandle: { out } };
    }

    // --- AI ---------------------------------------------------------------
    case "prompt": {
      const field = c.outputField || "prompt";
      const out = items.map((item) => ({ json: { ...item.json, [field]: renderTemplate(c.template, item) } }));
      return { byHandle: { out } };
    }

    case "aiChat": {
      const out = [];
      const usages = [];
      for (const item of items) {
        const messages = [
          { role: "system", content: c.systemPrompt || "You are a helpful assistant." },
          { role: "user", content: renderTemplate(c.prompt ?? "{{json}}", item) },
        ];
        const res = await chatCompletion(c, messages);
        usages.push({ ...(res.usage || {}), model: res.usage?.model || c.model });
        out.push({ json: { ...item.json, reply: res.text, usage: res.usage || {} } });
      }
      return { byHandle: { out }, usage: mergeUsage(usages) };
    }

    // LangChain — LLM Chain: prompt → model, then — when the second step is on —
    // that answer is fed through the refine template (as {{chain}}) and the
    // refined text becomes the node's output. Both calls are priced into the
    // node's usage, since the run really made two of them.
    case "langchainChain": {
      const field = c.outputField || "text";
      const out = [];
      const usages = [];
      for (const item of items) {
        // Usage is kept per item (like the Chat Model node) — the run's total is
        // the sum returned at the end, not each item's running figure.
        const itemUsages = [];
        const first = await chatCompletion(c, [
          { role: "system", content: c.systemPrompt || "You are a helpful assistant." },
          { role: "user", content: renderTemplate(c.template ?? "{{json}}", item) },
        ]);
        itemUsages.push({ ...(first.usage || {}), model: first.usage?.model || c.model });
        let answer = first.text;
        if (c.refine) {
          const second = await chatCompletion(c, [
            { role: "system", content: c.systemPrompt || "You are a helpful assistant." },
            { role: "user", content: renderTemplate(c.refineTemplate ?? "{{chain}}", { json: { ...item.json, chain: answer } }) },
          ]);
          itemUsages.push({ ...(second.usage || {}), model: second.usage?.model || c.model });
          answer = second.text;
        }
        usages.push(...itemUsages);
        const json = { ...item.json, [field]: answer, usage: mergeUsage(itemUsages) };
        // Keep the intermediate answer when a second step ran, so a user can see
        // what the chain started from (and log both).
        if (c.refine) json.chain = first.text;
        out.push({ json });
      }
      return { byHandle: { out }, usage: mergeUsage(usages) };
    }

    case "aiAgent": {
      const out = [];
      // Which kind of agent is configured: a saved one, configured inline, or a
      // foreign agent reached over an HTTP API. Falls back to the legacy field.
      const source = c.agentSource || (c.useInline ? "inline" : "saved");

      // --- foreign agent over HTTP -----------------------------------------
      if (source === "api") {
        for (const item of items) {
          const url = renderTemplate(c.apiUrl ?? "", item);
          if (!url) throw new Error("Foreign agent: no endpoint URL configured.");
          const method = (c.apiMethod || "POST").toUpperCase();
          const renderedBody = renderTemplate(c.apiBody ?? "{}", item);
          let body;
          try {
            body = JSON.parse(renderedBody);
          } catch {
            body = renderedBody; // not JSON → send as-is
          }
          let headers = {};
          try {
            headers = parseJsonField(renderTemplate(c.apiHeaders ?? "{}", item), {});
          } catch {
            headers = {};
          }
          if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
          const res = await fetch(url, {
            method,
            headers,
            body: ["GET", "HEAD"].includes(method) ? undefined : typeof body === "string" ? body : JSON.stringify(body),
            signal: AbortSignal.timeout(Number(c.apiTimeout || 30) * 1000),
          });
          const text = await res.text().catch(() => "");
          let data = text;
          try {
            data = JSON.parse(text);
          } catch {
            /* keep raw */
          }
          const replyPath = String(c.apiReplyPath || "").trim();
          let reply = replyPath ? getPath(data, replyPath) : data;
          if (reply === undefined || reply === null) reply = "";
          if (typeof reply === "object") reply = JSON.stringify(reply);
          out.push({
            json: { ...item.json, reply: String(reply), replyStatus: res.status, replyRaw: text.slice(0, MAX_TEXT_LENGTH) },
          });
        }
        return { byHandle: { out } };
      }

      // --- saved / inline --------------------------------------------------
      let agentConfig = null;
      if (source === "saved") {
        // A remote runner has no database — the saved agent (with its model key)
        // arrives in the run bundle instead.
        const bundled = ctx.agents?.[c.agentId] || null;
        if (bundled) {
          agentConfig = bundled;
        } else {
          // Agents are private per account — resolve the saved agent as the
          // workflow's owner so one user can never run another user's agent.
          const stored = ctx.userId ? agents.getOwned(c.agentId, ctx.userId) : agents.get(c.agentId);
          if (!stored) throw new Error(`Agent "${c.agentId}" not found. Build it in the AI Agent Builder.`);
          // The agent's model key lives encrypted in the agent_secrets table, not
          // in agents.json — re-inject it before running.
          agentConfig = await hydrateAgentSecrets(stored, await db.getAgentSecrets(stored.id));
        }
      }
      const usages = [];
      for (const item of items) {
        const userMessage = renderTemplate(c.prompt ?? "{{json}}", item);
        const modelConfig = agentConfig
          ? { ...agentConfig.model, apiKey: c.apiKey || agentConfig.model.apiKey }
          : c;
        const tools = agentConfig
          ? agentConfig.tools
          : {
              http: !!c.useHttpTool,
              time: !!c.useTimeTool,
              httpMethod: c.httpMethod,
              httpUrl: c.httpUrl,
              httpHeaders: c.httpHeaders,
              httpBody: c.httpBody,
            };
        const res = await runAgent(
          {
            model: modelConfig,
            systemPrompt: c.systemPrompt || agentConfig?.systemPrompt || "You are a helpful AI agent.",
            memory: c.memory ?? agentConfig?.memory ?? false,
            tools,
          },
          [{ role: "user", content: userMessage }]
        );
        usages.push(res.usage);
        out.push({ json: { ...item.json, reply: res.reply, toolRuns: res.toolRuns || [], usage: res.usage || {} } });
      }
      return { byHandle: { out }, usage: mergeUsage(usages) };
    }

    case "aiImage": {
      const out = [];
      for (const item of items) {
        const res = await generateImage(c, renderTemplate(c.prompt, item));
        out.push({ json: { ...item.json, imageUrl: res.url, revisedPrompt: res.revisedPrompt } });
      }
      return { byHandle: { out } };
    }

    case "aiEmbeddings": {
      const storeIn = c.storeIn || "vector";
      const out = [];
      const usages = [];
      for (const item of items) {
        const text = renderTemplate(c.text ?? "", item);
        const res = await embedText(c, text);
        if (!res.vector) throw new Error("Embedding API returned no vector for the given text.");
        usages.push({ ...(res.usage || {}), model: res.usage?.model || c.model });
        out.push({ json: { ...item.json, [storeIn]: res.vector, [`${storeIn}Dims`]: res.dimensions } });
      }
      return { byHandle: { out } };
    }

    case "vectorStore": {
      const out = [];
      const usages = [];
      for (const item of items) {
        const namespace = String(renderTemplate(c.namespace ?? "default", item) || "default");
        const key = String(renderTemplate(c.key ?? "item", item) || "item");
        const text = renderTemplate(c.text ?? "", item);
        let meta = {};
        try {
          meta = parseJsonField(renderTemplate(c.meta ?? "{}", item), {});
        } catch {
          meta = {};
        }
        const res = await embedText(c, text);
        if (!res.vector) throw new Error("Embedding API returned no vector for the given text.");
        usages.push({ ...(res.usage || {}), model: res.usage?.model || c.model });
        vectors.upsert({ namespace, key, vector: res.vector, text, meta });
        out.push({ json: { ...item.json, stored: true, namespace, key, dimensions: res.dimensions } });
      }
      return { byHandle: { out }, usage: mergeUsage(usages) };
    }

    case "vectorSearch": {
      const storeIn = c.storeIn || "matches";
      const out = [];
      const usages = [];
      for (const item of items) {
        const namespace = String(renderTemplate(c.namespace ?? "default", item) || "default");
        const query = renderTemplate(c.query ?? "", item);
        const topK = Math.max(1, Number(c.topK || 5));
        const res = await embedText(c, query);
        if (!res.vector) throw new Error("Embedding API returned no vector for the given query.");
        usages.push({ ...(res.usage || {}), model: res.usage?.model || c.model });
        const matches = searchVectors(namespace, res.vector, topK);
        out.push({ json: { ...item.json, [storeIn]: matches, [`${storeIn}Count`]: matches.length } });
      }
      return { byHandle: { out }, usage: mergeUsage(usages) };
    }

    // Split Text into Chunks — one item per chunk (or one item with an array).
    case "chunkText": {
      const field = c.field || "text";
      const size = Math.max(1, Number(c.chunkSize || 1000));
      const overlap = Math.min(Math.max(0, Number(c.overlap || 0)), size - 1);
      const storeIn = c.storeIn || "chunk";
      const out = [];
      for (const item of items) {
        const text = String(getPath(item.json, field) ?? "");
        const chunks = [];
        for (let i = 0; i < text.length; i += size - overlap) {
          chunks.push(text.slice(i, i + size));
          if (i + size >= text.length) break;
        }
        if (!chunks.length) chunks.push("");
        if (c.mode === "array") {
          out.push({ json: { ...item.json, [storeIn]: chunks, chunkCount: chunks.length } });
        } else {
          chunks.forEach((chunk, i) => {
            out.push({ json: { ...item.json, [storeIn]: chunk, chunkIndex: i, chunkCount: chunks.length } });
          });
        }
      }
      return { byHandle: { out } };
    }

    case "aiExtract": {
      const storeIn = c.storeIn || "parsed";
      const out = [];
      const usages = [];
      for (const item of items) {
        const text = String(item.json?.[c.sourceField ?? "body"] ?? "");
        const schema = parseJsonField(c.schema, {});
        const res = await extractStructured(c, { text, schema, targetType: c.targetType || "object" });
        usages.push({ ...(res.usage || {}), model: res.usage?.model || c.model });
        const parsed = extractJson(res.text);
        out.push({ json: { ...item.json, [storeIn]: parsed, [`${storeIn}Raw`]: res.text } });
      }
      return { byHandle: { out }, usage: mergeUsage(usages) };
    }

    // --- Wait for Approval --------------------------------------------------
    // Human-in-the-loop: the run pauses here until a person answers in the
    // editor's Log console (Approve / Reject), or until the timeout applies the
    // "when nobody answers" setting. Runs started outside the editor (webhook,
    // schedule, Telegram, sub-workflow) have no interactive session, so they go
    // straight to that setting instead of hanging.
    case "approval": {
      const message = renderTemplate(c.message ?? "Approve this run?", first || { json: {} });
      const approvedItem = c.approvedItem ? parseJsonField(renderTemplate(String(c.approvedItem), first || { json: {} }), {}) : {};
      const timeoutMinutes = Math.max(0, Number(c.timeoutMinutes ?? 5));
      const onTimeout = ["approve", "reject", "fail"].includes(c.onTimeout) ? c.onTimeout : "fail";
      const request = ctx?.approval?.request;

      let decision;
      if (typeof request === "function") {
        decision = await request({
          nodeId: node.id,
          nodeName: node.data?.label || getNodeDef(node.type)?.name || "Wait for Approval",
          message,
          approveLabel: c.approveLabel || "Approve",
          rejectLabel: c.rejectLabel || "Reject",
          timeoutMs: timeoutMinutes * 60_000,
          onTimeout,
        });
      } else {
        decision = { approved: onTimeout === "approve", timedOut: true, unanswered: true, action: onTimeout };
      }

      if (decision?.aborted) throw new Error("Run stopped while waiting for approval.");
      if (decision?.approved) {
        return { byHandle: { approved: items.map((it) => ({ json: { ...it.json, ...approvedItem, approval: { approved: true, by: decision.by || null, at: new Date().toISOString(), timedOut: !!decision.timedOut } } })), rejected: [] } };
      }
      if (decision?.unanswered && onTimeout === "fail") {
        throw attachCode(new Error(`Nobody answered the approval request within ${timeoutMinutes} minute(s): ${message}`), "APPROVAL_TIMEOUT");
      }
      return { byHandle: { approved: [], rejected: items.map((it) => ({ json: { ...it.json, approval: { approved: false, by: decision?.by || null, at: new Date().toISOString(), timedOut: !!decision?.timedOut, reason: decision?.reason || null } } })) } };
    }

    // --- Google Drive / Sheets ---------------------------------------------
    case "googleDriveUpload": {
      const out = [];
      for (const item of items) {
        const fileName = renderTemplate(c.fileName ?? "file.txt", item);
        const content = renderTemplate(c.content ?? "", item);
        const contentType = c.contentType || "text/plain";
        const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=media&supportsAllDrives=true`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": contentType },
          body: content,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        let placedIn = null;
        if (data.id && c.folderId) {
          const mv = await fetch(
            `https://www.googleapis.com/drive/v3/files/${data.id}?addParents=${encodeURIComponent(c.folderId)}&removeParents=root&supportsAllDrives=true`,
            { method: "PATCH", headers: { Authorization: `Bearer ${c.token}` } }
          );
          if (!mv.ok) {
            const mvd = await mv.json().catch(() => ({}));
            throw httpFailure(mv.status, mvd.error?.message || "The file was uploaded but could not be moved into the folder.");
          }
          placedIn = c.folderId;
        }
        out.push({ json: { uploaded: true, status: res.status, id: data.id, name: fileName, folderId: placedIn } });
      }
      return { byHandle: { out } };
    }

    case "googleDriveList": {
      const out = [];
      for (const item of items) {
        const q = c.folderId ? `'${c.folderId}' in parents` : "trashed = false";
        const max = Math.min(Number(c.maxResults || 100), 1000);
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${max}&fields=files(id,name,mimeType,size,modifiedTime)&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${c.token}` } }
        );
        const data = await res.json().catch(() => ({}));
        const files = (data.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, modifiedTime: f.modifiedTime }));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        out.push({ json: { fetched: true, status: res.status, count: files.length, files } });
      }
      return { byHandle: { out } };
    }

    // Sheets take either a connected Google account (private sheets, writes)
    // or an API key (public sheets, read-only) — see sheetsAuth().
    case "googleSheetsRead": {
      const out = [];
      for (const item of items) {
        const sid = renderTemplate(c.spreadsheetId ?? "", item);
        const sheet = renderTemplate(c.sheetName ?? "", item);
        const range = c.range || "A:Z";
        const maxRows = Number(c.maxRows || 100);
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(sheetsRange(sheet, range))}?${sheetsAuth(c).key}`,
          { headers: sheetsAuth(c).headers }
        );
        const data = await res.json().catch(() => ({}));
        const rows = (data.values || []).slice(0, maxRows);
        const headers = rows[0] || [];
        if (!res.ok) throw sheetsFailure(res.status, data, sheet);
        out.push({ json: { fetched: true, status: res.status, rows, count: rows.length, headers } });
      }
      return { byHandle: { out } };
    }

    case "googleSheetsAppend": {
      const out = [];
      for (const item of items) {
        const sid = renderTemplate(c.spreadsheetId ?? "", item);
        const sheet = renderTemplate(c.sheetName ?? "", item);
        const values = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.values, [])), item), []);
        const rows = Array.isArray(values[0]) ? values : [values];
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(sheetsRange(sheet, "A1"))}:append?valueInputOption=USER_ENTERED&${sheetsAuth(c).key}`,
          { method: "POST", headers: sheetsAuth(c, { "Content-Type": "application/json" }).headers, body: JSON.stringify({ values: rows }) }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw sheetsFailure(res.status, data, sheet);
        out.push({ json: { appended: true, status: res.status, updatedRows: data.updates?.updatedRows ?? 0, range: data.updates?.updatedRange } });
      }
      return { byHandle: { out } };
    }

    case "sheetsUpdate": {
      const out = [];
      for (const item of items) {
        const sid = renderTemplate(c.spreadsheetId ?? "", item);
        const sheet = renderTemplate(c.sheetName ?? "", item);
        const startCell = renderTemplate(c.range || "A2", item);
        const values = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.values, [])), item), []);
        const rows = Array.isArray(values[0]) ? values : [values];
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${encodeURIComponent(sheetsRange(sheet, startCell))}?valueInputOption=USER_ENTERED&${sheetsAuth(c).key}`,
          { method: "PUT", headers: sheetsAuth(c, { "Content-Type": "application/json" }).headers, body: JSON.stringify({ values: rows }) }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw sheetsFailure(res.status, data, sheet);
        out.push({
          json: {
            updated: true,
            status: res.status,
            updatedCells: data.updatedCells ?? 0,
            updatedRows: data.updatedRows ?? 0,
            range: data.updatedRange,
          },
        });
      }
      return { byHandle: { out } };
    }

    // --- Notion -------------------------------------------------------------
    case "notionQueryDb": {
      const out = [];
      for (const item of items) {
        const body = { page_size: Math.min(Number(c.maxResults || 100), 100) };
        const filter = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.filter, {})), item), {});
        if (filter && Object.keys(filter).length) body.filter = filter;
        const sorts = parseJsonField(c.sorts, null);
        if (sorts && Array.isArray(sorts) && sorts.length) body.sorts = sorts;
        const res = await fetch(`https://api.notion.com/v1/databases/${c.databaseId}/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        const results = (data.results || []).map((p) => ({
          id: p.id,
          title: p.properties?.title?.title?.[0]?.plain_text ?? p.properties?.Name?.title?.[0]?.plain_text ?? "",
          url: p.url,
          createdTime: p.created_time,
          properties: p.properties,
        }));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { fetched: true, status: res.status, count: results.length, results } });
      }
      return { byHandle: { out } };
    }

    case "notionUpdatePage": {
      const out = [];
      for (const item of items) {
        const props = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.properties, {})), item), {});
        const res = await fetch(`https://api.notion.com/v1/pages/${c.pageId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${c.token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
          body: JSON.stringify({ properties: props }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { updated: true, status: res.status, id: data.id, url: data.url } });
      }
      return { byHandle: { out } };
    }

    // --- MongoDB (Data API) -------------------------------------------------
    case "mongoFind": {
      const out = [];
      for (const item of items) {
        const body = { dataSource: c.dataSource || "cluster0", database: c.database, collection: c.collection, filter: parseJsonField(c.filter, {}), limit: Number(c.limit || 100) };
        const sort = parseJsonField(c.sort, null);
        if (sort && Object.keys(sort).length) body.sort = sort;
        const res = await fetch(c.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": c.apiKey, Accept: "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.error || "");
        out.push({ json: { fetched: true, status: res.status, count: data.documents?.length ?? 0, documents: data.documents || [] } });
      }
      return { byHandle: { out } };
    }

    case "mongoInsert": {
      const out = [];
      for (const item of items) {
        const doc = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.document, {})), item), {});
        const res = await fetch(c.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": c.apiKey, Accept: "application/json" },
          body: JSON.stringify({ dataSource: c.dataSource || "cluster0", database: c.database, collection: c.collection, document: doc }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.error || "");
        out.push({ json: { inserted: true, status: res.status, insertedId: data.insertedId } });
      }
      return { byHandle: { out } };
    }

    // --- Airtable read / update ---------------------------------------------
    case "airtableRead": {
      const out = [];
      for (const item of items) {
        const params = new URLSearchParams({ maxRecords: String(Number(c.maxRecords || 100)) });
        if (c.filter) params.set("filterByFormula", c.filter);
        if (c.sort) params.set("sort[0][field]", c.sort);
        const res = await fetch(airtableUrl(c, `?${params}`), {
          headers: { Authorization: `Bearer ${c.apiKey}` },
        });
        const data = await res.json().catch(() => ({}));
        const records = (data.records || []).map((r) => ({ id: r.id, ...(r.fields || {}) }));
        if (!res.ok) throw airtableFailure(res.status, data, c);
        out.push({ json: { fetched: true, status: res.status, count: records.length, records } });
      }
      return { byHandle: { out } };
    }

    case "airtableUpdate": {
      const out = [];
      for (const item of items) {
        const fields = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.fields, {})), item), {});
        const recordId = renderTemplate(c.recordId, item);
        const res = await fetch(airtableUrl(c, `/${encodeURIComponent(recordId)}`), {
          method: "PATCH",
          headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw airtableFailure(res.status, data, c);
        out.push({ json: { updated: true, status: res.status, id: data.id } });
      }
      return { byHandle: { out } };
    }

    case "airtableDelete": {
      const out = [];
      for (const item of items) {
        const recordId = renderTemplate(c.recordId, item);
        const res = await fetch(
          airtableUrl(c, `/${encodeURIComponent(recordId)}`),
          { method: "DELETE", headers: { Authorization: `Bearer ${c.apiKey}` } }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw airtableFailure(res.status, data, c);
        out.push({ json: { deleted: true, status: res.status, id: data.id || recordId } });
      }
      return { byHandle: { out } };
    }

    // --- Supabase read / update ---------------------------------------------
    case "supabaseRead": {
      const out = [];
      for (const item of items) {
        const base = String(c.url || "").replace(/\/+$/, "");
        const params = new URLSearchParams({ select: c.select || "*", limit: String(Number(c.limit || 100)) });
        if (c.filter) {
          const [k, ...rest] = String(c.filter).split("=");
          if (k) params.set(k.trim(), rest.join("="));
        }
        const res = await fetch(`${base}/rest/v1/${encodeURIComponent(c.tableName)}?${params}`, {
          headers: { apikey: c.anonKey, Authorization: `Bearer ${c.anonKey}` },
        });
        const data = await res.json().catch(() => ([]));
        const rows = Array.isArray(data) ? data : [];
        if (!res.ok) throw httpFailure(res.status, Array.isArray(data) ? "" : data.message || "");
        out.push({ json: { fetched: true, status: res.status, count: rows.length, rows } });
      }
      return { byHandle: { out } };
    }

    case "supabaseUpdate": {
      const out = [];
      for (const item of items) {
        const base = String(c.url || "").replace(/\/+$/, "");
        const match = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.match, {})), item), {});
        const update = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.update, {})), item), {});
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(match)) params.set(k, `eq.${v}`);
        const res = await fetch(`${base}/rest/v1/${encodeURIComponent(c.tableName)}?${params}`, {
          method: "PATCH",
          headers: { apikey: c.anonKey, Authorization: `Bearer ${c.anonKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify(update),
        });
        const data = await res.json().catch(() => ({}));
        const rows = Array.isArray(data) ? data : [];
        if (!res.ok) throw httpFailure(res.status, Array.isArray(data) ? "" : data.message || "");
        out.push({ json: { updated: true, status: res.status, count: rows.length, rows } });
      }
      return { byHandle: { out } };
    }

    // --- X (Twitter) / Salesforce / Slack Bot --------------------------------
    case "twitterPost": {
      const out = [];
      for (const item of items) {
        const text = renderTemplate(c.text, item);
        const res = await fetch("https://api.twitter.com/2/tweets", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.bearerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.title || data.detail || "");
        if (!data.data?.id) throw serviceFailure(data.title || data.detail || "X did not return the new tweet id");
        out.push({ json: { posted: true, status: res.status, id: data.data?.id } });
      }
      return { byHandle: { out } };
    }

    case "salesforceContact": {
      const out = [];
      for (const item of items) {
        const base = String(c.instanceUrl || "").replace(/\/+$/, "");
        const res = await fetch(`${base}/services/data/v59.0/sobjects/Contact`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            FirstName: renderTemplate(c.firstName, item),
            LastName: renderTemplate(c.lastName, item),
            Email: renderTemplate(c.email, item),
          }),
        });
        const data = await res.json().catch(() => ({}));
        const err = Array.isArray(data) ? data[0]?.message : data.message;
        if (!res.ok) throw httpFailure(res.status, err || "");
        if (!data.id) throw serviceFailure(err || "Salesforce did not return the new contact id");
        out.push({ json: { created: true, status: res.status, id: data.id } });
      }
      return { byHandle: { out } };
    }

    case "slackBotSend": {
      const out = [];
      for (const item of items) {
        const body = { channel: renderTemplate(c.channel, item), text: renderTemplate(c.text, item) };
        if (c.threadTs) body.thread_ts = renderTemplate(c.threadTs, item);
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.error || "");
        if (data.ok === false) throw serviceFailure(data.error || "Slack rejected the message");
        out.push({ json: { sent: true, status: res.status, ts: data.ts, channel: data.channel } });
      }
      return { byHandle: { out } };
    }

    case "githubCreatePr": {
      const out = [];
      for (const item of items) {
        const owner = renderTemplate(c.owner, item);
        const repo = renderTemplate(c.repo, item);
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", "User-Agent": "wflow", Accept: "application/vnd.github+json" },
          body: JSON.stringify({ title: renderTemplate(c.title, item), head: renderTemplate(c.head, item), base: renderTemplate(c.base, item), body: renderTemplate(c.body, item) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        if (!data.number) throw serviceFailure(data.message || "GitHub did not return the new pull request number");
        out.push({ json: { created: true, status: res.status, number: data.number, url: data.html_url } });
      }
      return { byHandle: { out } };
    }

    case "githubCreateRelease": {
      const out = [];
      for (const item of items) {
        const owner = renderTemplate(c.owner, item);
        const repo = renderTemplate(c.repo, item);
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", "User-Agent": "wflow", Accept: "application/vnd.github+json" },
          body: JSON.stringify({ tag_name: renderTemplate(c.tagName, item), name: renderTemplate(c.name, item), body: renderTemplate(c.body, item) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        if (!data.id) throw serviceFailure(data.message || "GitHub did not return the new release id");
        out.push({ json: { created: true, status: res.status, id: data.id, url: data.html_url } });
      }
      return { byHandle: { out } };
    }

    // --- Mailgun / Vonage / Opsgenie / Pushover / ntfy ----------------------
    case "mailgunSend": {
      const out = [];
      for (const item of items) {
        const form = new URLSearchParams({
          from: renderTemplate(c.from, item),
          to: renderTemplate(c.to, item),
          subject: renderTemplate(c.subject, item),
        });
        if (c.text) form.set("text", renderTemplate(c.text, item));
        if (c.html) form.set("html", renderTemplate(c.html, item));
        const auth = "Basic " + Buffer.from(`api:${c.apiKey}`).toString("base64");
        const res = await fetch(`https://api.mailgun.net/v3/${encodeURIComponent(c.domain)}/messages`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { sent: true, status: res.status, id: data.id } });
      }
      return { byHandle: { out } };
    }

    case "vonageSms": {
      const out = [];
      for (const item of items) {
        const form = new URLSearchParams({
          api_key: c.apiKey,
          api_secret: c.apiSecret,
          from: renderTemplate(c.from, item),
          to: renderTemplate(c.to, item),
          text: renderTemplate(c.text, item),
        });
        const res = await fetch("https://rest.nexmo.com/sms/json", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
        const data = await res.json().catch(() => ({}));
        const msg = data.messages?.[0];
        if (!res.ok) throw httpFailure(res.status, msg?.error_text || "");
        if (msg?.status !== "0") throw serviceFailure(msg?.error_text || `Vonage returned status ${msg?.status ?? "unknown"}`);
        out.push({ json: { sent: true, status: res.status, messageId: msg?.["message-id"] } });
      }
      return { byHandle: { out } };
    }

    case "opsgenieAlert": {
      const out = [];
      for (const item of items) {
        const body = { message: renderTemplate(c.message, item), description: renderTemplate(c.description ?? "", item), priority: c.priority || "P3" };
        if (c.tags) body.tags = String(c.tags).split(",").map((s) => s.trim()).filter(Boolean);
        const res = await fetch("https://api.opsgenie.com/v2/alerts", {
          method: "POST",
          headers: { Authorization: `GenieKey ${c.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        out.push({ json: { created: true, status: res.status, alertId: data.alertId, requestId: data.requestId } });
      }
      return { byHandle: { out } };
    }

    case "pushoverSend": {
      const out = [];
      for (const item of items) {
        const form = new URLSearchParams({
          token: c.token,
          user: c.user,
          title: renderTemplate(c.title ?? "", item),
          message: renderTemplate(c.message ?? "", item),
          priority: String(c.priority ?? 0),
        });
        if (c.sound) form.set("sound", c.sound);
        const res = await fetch("https://api.pushover.net/1/messages.json", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.errors?.[0] || "");
        if (data.status !== 1) throw serviceFailure(data.errors?.[0] || "Pushover rejected the notification");
        out.push({ json: { sent: true, status: res.status, receipt: data.receipt } });
      }
      return { byHandle: { out } };
    }

    case "ntfySend": {
      const out = [];
      for (const item of items) {
        const server = String(c.server || "https://ntfy.sh").replace(/\/+$/, "");
        const topic = renderTemplate(c.topic, item);
        const headers = { Title: String(renderTemplate(c.title ?? "", item) || "W flow"), Priority: c.priority || "default" };
        if (c.tags) headers.Tags = String(c.tags);
        await assertPublicHttpUrl(`${server}/${encodeURIComponent(topic)}`);
        const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
          method: "POST",
          headers,
          body: renderTemplate(c.message ?? "", item),
        });
        if (!res.ok) throw httpFailure(res.status, await res.text().catch(() => ""));
        out.push({ json: { sent: true, status: res.status, topic } });
      }
      return { byHandle: { out } };
    }

    // --- S3 / WebDAV --------------------------------------------------------
    case "s3Upload": {
      const out = [];
      for (const item of items) {
        const region = String(c.region || "us-east-1");
        const bucket = renderTemplate(c.bucket, item);
        const key = String(renderTemplate(c.key ?? "", item)).replace(/^\/+/, "");
        const content = renderTemplate(c.content ?? "", item);
        const contentType = c.contentType || "text/plain";
        const payload = Buffer.from(content, "utf8");
        const encKey = key.split("/").map(encodeURIComponent).join("/");
        const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
        const dateStamp = amzDate.slice(0, 8);
        const service = "s3";
        const host = `${bucket}.s3.${region}.amazonaws.com`;
        const payloadHash = createHash("sha256").update(payload).digest("hex");
        const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        const canonicalRequest = ["PUT", `/${encKey}`, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
        const scope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
        const hmac = (k, data) => createHmac("sha256", k).update(data).digest();
        const kDate = hmac(`AWS4${c.secretAccessKey}`, dateStamp);
        const kRegion = hmac(kDate, region);
        const kService = hmac(kRegion, service);
        const kSigning = hmac(kService, "aws4_request");
        const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
        const res = await fetch(`https://${host}/${encKey}`, {
          method: "PUT",
          headers: {
            Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
            "x-amz-date": amzDate,
            "x-amz-content-sha256": payloadHash,
            "Content-Type": contentType,
            "Content-Length": String(payload.length),
          },
          body: payload,
        });
        const bodyText = await res.text().catch(() => "");
        if (!res.ok) throw httpFailure(res.status, bodyText);
        out.push({ json: { uploaded: true, status: res.status, bucket, key, eTag: res.headers?.get?.("etag") || null } });
      }
      return { byHandle: { out } };
    }

    case "webdavUpload": {
      const out = [];
      for (const item of items) {
        const base = String(c.url || "").replace(/\/+$/, "");
        const path = String(renderTemplate(c.path, item)).replace(/^\/+/, "");
        const content = renderTemplate(c.content ?? "", item);
        const auth = "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64");
        await assertPublicHttpUrl(`${base}/${path}`);
        const res = await fetch(`${base}/${path}`, {
          method: "PUT",
          headers: { Authorization: auth, "Content-Type": "application/octet-stream" },
          body: content,
        });
        if (!res.ok) throw httpFailure(res.status, await res.text().catch(() => ""));
        out.push({ json: { uploaded: true, status: res.status, path } });
      }
      return { byHandle: { out } };
    }

    // --- Pipedrive / Linear -------------------------------------------------
    case "pipedriveDeal": {
      const out = [];
      for (const item of items) {
        const body = { title: renderTemplate(c.title, item) };
        if (c.value !== "" && c.value !== undefined && c.value !== null) body.value = Number(c.value);
        if (c.currency) body.currency = String(c.currency);
        const res = await fetch(`https://api.pipedrive.com/v1/deals?api_token=${encodeURIComponent(c.apiToken)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.error || "");
        const dealId = data.data?.id;
        if (!dealId) throw serviceFailure(data.error || "Pipedrive did not return a deal id");
        let noteId = null;
        if (c.note) {
          const n = await fetch(`https://api.pipedrive.com/v1/notes?api_token=${encodeURIComponent(c.apiToken)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: renderTemplate(c.note, item), deal_id: dealId }),
          });
          const nd = await n.json().catch(() => ({}));
          if (!n.ok) throw httpFailure(n.status, nd.error || "The deal was created but the note could not be added.");
          noteId = nd.data?.id ?? null;
        }
        out.push({ json: { created: true, status: res.status, id: dealId, url: data.data?.url, noteId } });
      }
      return { byHandle: { out } };
    }

    case "linearIssue": {
      const out = [];
      for (const item of items) {
        const query =
          "mutation IssueCreate($teamId: String!, $title: String!, $description: String) { issueCreate(input: { teamId: $teamId, title: $title, description: $description }) { success issue { id identifier url } } }";
        const variables = { teamId: renderTemplate(c.teamId, item), title: renderTemplate(c.title, item), description: renderTemplate(c.description ?? "", item) };
        const res = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: c.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
        });
        const data = await res.json().catch(() => ({}));
        const issue = data.data?.issueCreate;
        if (!res.ok) throw httpFailure(res.status, data.errors?.[0]?.message || "");
        if (issue?.success !== true) throw serviceFailure(data.errors?.[0]?.message || "Linear did not create the issue");
        out.push({ json: { created: true, status: res.status, id: issue?.issue?.id, identifier: issue?.issue?.identifier, url: issue?.issue?.url } });
      }
      return { byHandle: { out } };
    }

    // --- Translation / knowledge / URL utilities ----------------------------
    case "deeplTranslate": {
      const out = [];
      for (const item of items) {
        const key = String(c.apiKey || "");
        const endpoint = key.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
        const form = new URLSearchParams({ text: renderTemplate(c.text ?? "", item), target_lang: String(c.targetLang || "EN").toUpperCase() });
        if (c.sourceLang) form.set("source_lang", String(c.sourceLang).toUpperCase());
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw httpFailure(res.status, data.message || "");
        const translation = data.translations?.[0]?.text ?? "";
        out.push({
          json: {
            ...item.json,
            translated: translation,
            detectedSource: data.translations?.[0]?.detected_source_language ?? null,
            [c.storeIn || "translation"]: translation,
          },
        });
      }
      return { byHandle: { out } };
    }

    case "wikipediaSearch": {
      const out = [];
      for (const item of items) {
        const lang = String(c.language || "en");
        const query = renderTemplate(c.query ?? "", item);
        const limit = Math.min(Number(c.limit || 10), 50);
        const res = await fetch(
          `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${limit}`
        );
        const data = await res.json().catch(() => ({}));
        const results = (data.query?.search || []).map((r) => ({
          title: r.title,
          snippet: (r.snippet || "").replace(/<[^>]*>/g, ""),
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
          size: r.size,
        }));
        if (!res.ok) throw httpFailure(res.status, data.error?.info || "");
        if (!data.query) throw serviceFailure(data.error?.info || "Wikipedia returned no search block");
        out.push({ json: { ...item.json, fetched: true, status: res.status, [c.storeIn || "results"]: results, count: results.length } });
      }
      return { byHandle: { out } };
    }

    case "hackernewsSearch": {
      const out = [];
      for (const item of items) {
        const query = renderTemplate(c.query ?? "", item);
        const limit = Math.min(Number(c.limit || 10), 100);
        const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`);
        const data = await res.json().catch(() => ({}));
        const hits = (data.hits || []).map((h) => ({
          title: h.title,
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          points: h.points,
          author: h.author,
          comments: h.num_comments,
          createdAt: h.created_at,
          objectID: h.objectID,
        }));
        if (!res.ok) throw httpFailure(res.status, data.error || "");
        if (data.error) throw serviceFailure(String(data.error));
        out.push({ json: { ...item.json, fetched: true, status: res.status, [c.storeIn || "stories"]: hits, count: hits.length } });
      }
      return { byHandle: { out } };
    }

    case "tinyurlShorten": {
      const out = [];
      for (const item of items) {
        const url = renderTemplate(c.url ?? "", item);
        const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
        const text = await res.text().catch(() => "");
        if (!res.ok) throw httpFailure(res.status, text);
        const short = /^https?:\/\//.test(text.trim()) ? text.trim() : "";
        if (!short) throw serviceFailure(text.trim() || "TinyURL did not return a short URL");
        out.push({
          json: {
            ...item.json,
            [c.storeIn || "shortUrl"]: short,
          },
        });
      }
      return { byHandle: { out } };
    }

    // --- Feeds / AWS / random data / YouTube ------------------------------
    case "rssRead": {
      const out = [];
      for (const item of items) {
        out.push(await readFeed(renderTemplate(c.url ?? "", item), c.limit, c.storeIn, item));
      }
      return { byHandle: { out } };
    }

    case "snsPublish": {
      const out = [];
      for (const item of items) {
        const region = String(c.region || "us-east-1");
        const topicArn = renderTemplate(c.topicArn ?? "", item);
        const phoneNumber = renderTemplate(c.phoneNumber ?? "", item);
        const message = renderTemplate(c.message ?? "", item);
        const params = { Action: "Publish", Version: "2010-03-31" };
        if (topicArn) params.TopicArn = topicArn;
        if (phoneNumber) params.PhoneNumber = phoneNumber;
        if (c.subject) params.Subject = renderTemplate(c.subject, item);
        params.Message = message;
        const body = Object.entries(params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&");
        const host = `sns.${region}.amazonaws.com`;
        const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
        const dateStamp = amzDate.slice(0, 8);
        const service = "sns";
        const payloadHash = createHash("sha256").update(body).digest("hex");
        const contentType = "application/x-www-form-urlencoded; charset=utf-8";
        const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = "content-type;host;x-amz-date";
        const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
        const scope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
        const hmac = (k, data) => createHmac("sha256", k).update(data).digest();
        const kDate = hmac(`AWS4${c.secretAccessKey}`, dateStamp);
        const kRegion = hmac(kDate, region);
        const kService = hmac(kRegion, service);
        const kSigning = hmac(kService, "aws4_request");
        const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
        const res = await fetch(`https://${host}/`, {
          method: "POST",
          headers: {
            Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
            "Content-Type": contentType,
            "x-amz-date": amzDate,
            "x-amz-content-sha256": payloadHash,
          },
          body,
        });
        const bodyText = await res.text().catch(() => "");
        if (!res.ok) throw httpFailure(res.status, bodyText);
        const messageId = /<MessageId>([^<]+)<\/MessageId>/.exec(bodyText)?.[1] || null;
        out.push({
          json: {
            ...item.json,
            published: true,
            status: res.status,
            messageId,
            target: topicArn || phoneNumber,
            [c.storeIn || "snsResult"]: messageId,
          },
        });
      }
      return { byHandle: { out } };
    }

    case "randomData": {
      const out = [];
      const count = Math.max(0, Math.min(Number(c.count || 1), 100));
      const field = String(c.fieldName || "value");
      const type = String(c.type || "string");
      for (let i = 0; i < count; i++) {
        out.push({ json: { [field]: randomValue(type) } });
      }
      return { byHandle: { out } };
    }

    case "youtubeSearch": {
      const out = [];
      for (const item of items) {
        const query = renderTemplate(c.query ?? "", item);
        const maxResults = Math.min(Number(c.maxResults || 10), 50);
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${encodeURIComponent(c.apiKey || "")}`
        );
        const data = await res.json().catch(() => ({}));
        const videos = (data.items || []).map((v) => ({
          title: v.snippet?.title,
          description: v.snippet?.description,
          channel: v.snippet?.channelTitle,
          publishedAt: v.snippet?.publishedAt,
          videoId: v.id?.videoId,
          url: v.id?.videoId ? `https://www.youtube.com/watch?v=${v.id.videoId}` : "",
        }));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        if (data.error) throw serviceFailure(data.error.message || "YouTube returned an error");
        out.push({
          json: {
            ...item.json,
            fetched: true,
            status: res.status,
            [c.storeIn || "videos"]: videos,
            count: videos.length,
          },
        });
      }
      return { byHandle: { out } };
    }

    case "whatsappSend": {
      const out = [];
      for (const item of items) {
        const to = renderTemplate(c.to, item);
        const text = renderTemplate(c.text, item);
        try {
          const res = await fetch(`https://graph.facebook.com/v20.0/${renderTemplate(c.phoneNumberId, item)}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${renderTemplate(c.accessToken, item)}` },
            body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
          out.push({
            json: {
              sent: true,
              status: res.status,
              to,
              messageId: data.messages?.[0]?.id || null,
            },
          });
        } catch (err) {
          if (err?._bfCode) throw err;
          throw attachCode(new Error(`WhatsApp send failed: ${String(err.message || err)}`), "HTTP_REQUEST_FAILED");
        }
      }
      return { byHandle: { out } };
    }

    case "todoistTask": {
      const out = [];
      for (const item of items) {
        const body = {
          content: renderTemplate(c.content, item),
          priority: Math.min(Math.max(Number(c.priority || 1), 1), 4),
        };
        const projectId = renderTemplate(c.projectId || "", item);
        const dueString = renderTemplate(c.dueString || "", item);
        if (projectId) body.project_id = projectId;
        if (dueString) body.due_string = dueString;
        try {
          const res = await fetch("https://api.todoist.com/rest/v2/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${renderTemplate(c.token, item)}` },
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw httpFailure(res.status, data.error || "");
          out.push({
            json: {
              created: true,
              status: res.status,
              taskId: data.id || null,
              url: data.url || "",
            },
          });
        } catch (err) {
          if (err?._bfCode) throw err;
          throw attachCode(new Error(`Todoist task could not be created: ${String(err.message || err)}`), "HTTP_REQUEST_FAILED");
        }
      }
      return { byHandle: { out } };
    }

    case "clickupTask": {
      const out = [];
      for (const item of items) {
        const listId = renderTemplate(c.listId, item);
        const body = { name: renderTemplate(c.name, item) };
        const description = renderTemplate(c.description || "", item);
        const priority = Number(c.priority || 0);
        if (description) body.description = description;
        if (priority) body.priority = priority;
        try {
          const res = await fetch(`https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}/task`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: renderTemplate(c.token, item) },
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw httpFailure(res.status, data.err || data.error || "");
          out.push({
            json: {
              created: true,
              status: res.status,
              taskId: data.id || null,
              url: data.url || "",
            },
          });
        } catch (err) {
          if (err?._bfCode) throw err;
          throw attachCode(new Error(`ClickUp task could not be created: ${String(err.message || err)}`), "HTTP_REQUEST_FAILED");
        }
      }
      return { byHandle: { out } };
    }

    case "qrcode": {
      const out = [];
      for (const item of items) {
        const text = renderTemplate(c.text ?? "", item);
        const size = Math.max(64, Number(c.size || 256));
        try {
          const png = await QRCode.toBuffer(text, { width: size, margin: 1, errorCorrectionLevel: "M" });
          const b64 = png.toString("base64");
          const json = { qrText: text, qrBase64: b64, qrDataUrl: `data:image/png;base64,${b64}`, mimeType: "image/png", size: png.length };
          const name = renderTemplate(String(c.outputFile || "qrcode.png"), item).trim();
          if (name) {
            ctx.files.set(name, { name, data: png, mimeType: "image/png", sourceNodeId: node.id, size: png.length });
            json.fileName = name;
          }
          out.push({ json });
        } catch (err) {
          throw attachCode(new Error(`QR Code could not be generated: ${String(err.message || err)}`), "UNKNOWN");
        }
      }
      return { byHandle: { out } };
    }

    // --- External databases ------------------------------------------------
    case "sqlPostgres":
    case "sqlTimescaledb":
    case "sqlCratedb":
    case "sqlQuestdb": {
      const out = [];
      for (const item of items) {
        const rawSql = renderTemplate(c.query ?? "", item);
        const rawParams = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.params, {})), item), {});
        // Two supported parameter styles:
        //   * params as an ARRAY  → positional $1, $2, … (the field help says so)
        //   * params as an OBJECT → :name placeholders are rewritten to $1, $2, …
        //     (the (?<!:) guard keeps PostgreSQL casts like ::text intact)
        let values;
        let sql = rawSql;
        if (Array.isArray(rawParams)) {
          values = rawParams;
        } else {
          values = [];
          sql = rawSql.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
            if (name in rawParams) {
              values.push(rawParams[name]);
              return `$${values.length}`;
            }
            return m;
          });
        }
        const client = new pg.Client({
          host: c.host || "localhost",
          port: Number(c.port || 5432),
          database: c.database,
          user: c.user,
          password: c.password,
          ssl: c.ssl === true,
          connectionTimeoutMillis: Number(c.connectTimeoutMs || 10000),
        });
        try {
          await client.connect();
          const res = await client.query(sql, values);
          const rows = res.rows || [];
          out.push({ json: { ...item.json, fetched: true, [c.storeIn || "rows"]: rows, rowCount: rows.length, columns: (res.fields || []).map((f) => f.name) } });
        } catch (err) {
          throw attachCode(new Error(String(err.message || err)), "QUERY_FAILED");
        } finally {
          await client.end().catch(() => {});
        }
      }
      return { byHandle: { out } };
    }

    case "sqlMysql":
    case "sqlMariadb": {
      const mysql = await import("mysql2/promise");
      const out = [];
      for (const item of items) {
        const rawSql = renderTemplate(c.query ?? "", item);
        const rawParams = parseJsonField(renderTemplate(JSON.stringify(parseJsonField(c.params, {})), item), {});
        let conn;
        try {
          conn = await mysql.createConnection({
            host: c.host || "localhost",
            port: Number(c.port || 3306),
            database: c.database || undefined,
            user: c.user,
            password: c.password,
            connectTimeout: Number(c.connectTimeoutMs || 10000),
            // execute() rejects an object bind-parameter set unless named
            // placeholders are enabled ("Bind parameters must be array …"),
            // and the node always passes an object when params is JSON like
            // {"id": 1}. With this on, both :name objects and ? arrays work.
            namedPlaceholders: true,
          });
          const [rows] = await conn.execute(rawSql, rawParams);
          out.push({ json: { ...item.json, fetched: true, [c.storeIn || "rows"]: rows, rowCount: Array.isArray(rows) ? rows.length : 0 } });
        } catch (err) {
          throw attachCode(new Error(String(err.message || err)), "QUERY_FAILED");
        } finally {
          if (conn) await conn.end().catch(() => {});
        }
      }
      return { byHandle: { out } };
    }

    // --- Shopify / Google Search -------------------------------------------
    case "shopifyProduct": {
      const out = [];
      for (const item of items) {
        const shop = String(c.shop || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
        const product = {
          title: renderTemplate(c.title, item),
          status: c.status || "draft",
        };
        if (c.bodyHtml) product.body_html = renderTemplate(c.bodyHtml, item);
        if (c.vendor) product.vendor = renderTemplate(c.vendor, item);
        if (c.productType) product.product_type = renderTemplate(c.productType, item);
        if (c.price) product.variants = [{ price: String(Number(c.price)) }];
        const res = await fetch(`https://${shop}/admin/api/2024-01/products.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": c.accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ product }),
        });
        const data = await res.json().catch(() => ({}));
        const p = data.product;
        const shopifyIssue = data.errors ? JSON.stringify(data.errors).slice(0, 300) : "";
        if (!res.ok) throw httpFailure(res.status, shopifyIssue);
        if (!p?.id) throw serviceFailure(shopifyIssue || "Shopify did not return the new product id");
        out.push({
          json: {
            created: true,
            status: res.status,
            id: p.id,
            title: p.title,
            handle: p.handle,
            url: `https://${shop}/admin/products/${p.id}`,
          },
        });
      }
      return { byHandle: { out } };
    }

    case "googleSearch": {
      const out = [];
      for (const item of items) {
        const q = renderTemplate(c.query ?? "", item);
        const num = Math.min(Number(c.num || 10), 10);
        const res = await fetch(
          `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(c.apiKey || "")}&cx=${encodeURIComponent(c.searchEngineId || "")}&q=${encodeURIComponent(q)}&num=${num}`
        );
        const data = await res.json().catch(() => ({}));
        const results = (data.items || []).map((r) => ({ title: r.title, link: r.link, snippet: r.snippet, displayedLink: r.displayLink }));
        if (!res.ok) throw httpFailure(res.status, apiErrorDetail(data));
        if (data.error) throw serviceFailure(data.error.message || "Google Search returned an error");
        out.push({ json: { ...item.json, fetched: true, status: res.status, [c.storeIn || "results"]: results, count: results.length } });
      }
      return { byHandle: { out } };
    }

    // --- Files & Data -------------------------------------------------------
    // One handler for the Extract File node: resolve the payload field / URL
    // into bytes, then let the extraction engine (server/fileextract.js) do the
    // rest. extractText / extractTable / extractStructured / extractPdf /
    // extractArchive / fileMetadata are legacy aliases kept so workflows saved
    // before the consolidation still execute — they are not in the catalog.
    case "extractFile":
    case "extractText":
    case "extractTable":
    case "extractStructured":
    case "extractPdf":
    case "extractArchive":
    case "fileMetadata": {
      const modeByType = {
        extractFile: c.outputMode || "auto",
        extractText: "text",
        extractTable: "rows",
        extractStructured: "structured",
        extractPdf: "pdf",
        extractArchive: "entries",
        fileMetadata: "metadata",
      };
      const mode = modeByType[node.type];
      const out = [];
      for (const item of items) {
        let source;
        if (c.fileSource === "named") {
          // Request a file produced by an upstream node's "Save output as file".
          const requested = renderTemplate(String(c.sourceFile || ""), item);
          const file = ctx.files?.get(requested);
          if (!file) {
            out.push({ json: { ...item.json, extractionError: `No file named '${requested}' was produced by an upstream node` } });
            continue;
          }
          source = { buffer: file.data, fileName: file.name, mimeType: file.mimeType };
        } else {
          source = await resolveFileInput(fileInputConfig(c, item), item);
        }
        out.push(await extractFileFromSource(c, item, source, mode));
      }
      return { byHandle: { out } };
    }

    case "readFile": {
      const out = [];
      for (const item of items) {
        const rel = renderTemplate(String(c.path || ""), item).replace(/\\/g, "/");
        const res = readFileBytes(rel, currentRunContext().filesOwner);
        if (!res.ok) {
          out.push({ json: { ...item.json, extractionError: res.error } });
          continue;
        }
        out.push(await extractFileFromSource(c, item, { buffer: res.buffer, fileName: rel.split("/").pop(), mimeType: mimeTypeFor(rel) }, c.outputMode || "auto"));
      }
      return { byHandle: { out } };
    }

    case "writeFile": {
      // A file that was not written fails the node: a green node whose output
      // only says `written: false` reads as success and hides the problem.
      const out = [];
      for (const item of items) {
        const base = { ...item.json };
        let data;
        let fallbackName = "";
        if (c.fileSource === "named") {
          const requested = renderTemplate(String(c.sourceFile || ""), item);
          const file = ctx.files?.get(requested);
          if (!file) {
            const known = [...(ctx.files?.keys() || [])];
            const hint = known.length
              ? ` Files available: ${known.join(", ")}.`
              : " Turn on “Save output as file” on an earlier node, or switch Source to a payload field.";
            throw attachCode(
              new Error(requested ? `No upstream node produced a file named '${requested}'.${hint}` : `Pick which upstream file to save (Source file).${hint}`),
              "FILE_CONTENT_MISSING"
            );
          }
          data = file.data;
          fallbackName = file.name;
        } else {
          const fc = fileInputConfig({ contentMode: c.contentMode || "auto", sourceField: c.sourceField }, item);
          const src = await resolveFileInput(fc, item);
          if (src.error) throw missingFileFieldError(src.error, fc, item);
          data = src.buffer;
          fallbackName = src.fileName;
        }
        // "Save as" is already relative to the account's file folder; a typed
        // "data/files/…" prefix would nest a second data/files folder inside it.
        const target = renderTemplate(String(c.fileName || fallbackName), item)
          .replace(/\\/g, "/")
          .replace(/^(\.\/)?(data\/files\/)+/i, "");
        // Same per-plan storage limit as uploads on the My files page — a
        // workflow must not be a way around it. Runs without an owner (tests,
        // tooling) have no account to charge.
        const owner = currentRunContext().filesOwner;
        if (owner) {
          const limit = await filesQuotaBytes(owner);
          const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data ?? ""));
          if (!fitsInFolder(target, bytes, owner, limit)) {
            throw attachCode(
              new Error(`Your file storage is full (${Math.round(limit / (1024 * 1024))} MB on your plan). Delete files on the My files page, or go Pro for more space.`),
              "FILE_WRITE_FAILED"
            );
          }
        }
        const res = writeFileBytes(target, data, owner);
        if (!res.ok) throw attachCode(new Error(res.error), /invalid path|no file path/i.test(res.error) ? "FILE_PATH_INVALID" : "FILE_WRITE_FAILED");
        out.push({ json: { ...base, written: true, path: res.path, size: res.size, mimeType: mimeTypeFor(res.path) } });
      }
      return { byHandle: { out } };
    }

    case "listFiles": {
      const out = [];
      for (const item of items) {
        const rel = renderTemplate(String(c.path || ""), item).replace(/\\/g, "/");
        const res = listFilesOnDisk(rel, c.pattern, c.recursive === true, currentRunContext().filesOwner);
        if (!res.ok) {
          out.push({ json: { ...item.json, error: res.error, count: 0, files: [] } });
          continue;
        }
        const files = res.files || [];
        if (!files.length) {
          out.push({ json: { ...item.json, files: [], count: 0 } });
          continue;
        }
        // one item per file so downstream nodes can iterate / filter them
        for (const f of files) out.push({ json: { ...item.json, ...f } });
      }
      return { byHandle: { out } };
    }

    case "convertToFile": {
      const out = [];
      for (const item of items) {
        const base = { ...item.json };
        let source;
        if (c.fileSource === "named") {
          const requested = renderTemplate(String(c.sourceFile || ""), item);
          const file = ctx.files?.get(requested);
          if (!file) {
            out.push({ json: { ...base, converted: false, error: `No file named '${requested}' was produced by an upstream node` } });
            continue;
          }
          source = { buffer: file.data, fileName: file.name, mimeType: file.mimeType };
        } else {
          source = await resolveFileInput(fileInputConfig({ contentMode: c.contentMode || "auto", sourceField: c.sourceField }, item), item);
          if (source.error) {
            out.push({ json: { ...base, converted: false, error: source.error } });
            continue;
          }
        }
        const detected = detectFileType({ fileName: source.fileName, mimeType: source.mimeType, data: source.buffer });
        const ext = detected?.ext || String(source.fileName || "").split(".").pop()?.toLowerCase() || "";
        const result = convertToFormat(source.buffer, c.format || "auto", ext, { encoding: c.encoding, delimiter: c.delimiter });
        out.push({ json: { ...base, converted: true, sourceFormat: detected?.name || null, ...result } });
      }
      return { byHandle: { out } };
    }

    case "compress": {
      const out = [];
      for (const item of items) {
        const base = { ...item.json };
        const spec = renderTemplate(String(c.sources || "*"), item).trim();
        let files;
        if (spec === "*") files = [...(ctx.files?.values() || [])];
        else files = spec.split(",").map((s) => s.trim()).filter(Boolean).map((n) => ctx.files?.get(n)).filter(Boolean);
        if (!files.length) {
          throw attachCode(
            new Error("No files to compress — produce files with 'Save output as file' upstream, or list their names"),
            "FILE_CONTENT_MISSING"
          );
        }
        try {
          const info = files.map((f) => ({ name: f.name, size: f.size }));
          const format = c.format === "gz" ? "gz" : "zip";
          let buffer;
          if (format === "gz") {
            buffer = files.length === 1 ? gzipSync(files[0].data) : gzipSync(createZipBuffer(files.map((f) => ({ name: f.name, data: f.data }))));
          } else {
            buffer = createZipBuffer(files.map((f) => ({ name: f.name, data: f.data })));
          }
          out.push({ json: { ...base, compressed: true, format, entryCount: files.length, entries: info, archiveSize: buffer.length, fileBase64: buffer.toString("base64") } });
        } catch (err) {
          if (err?._bfCode) throw err;
          throw attachCode(new Error(`Could not build the archive: ${String(err.message || err)}`), "UNKNOWN");
        }
      }
      return { byHandle: { out } };
    }

    case "dataStore": {
      const out = [];
      for (const item of items) {
        const base = { ...item.json };
        const ns = renderTemplate(String(c.namespace || "default"), item);
        const key = renderTemplate(String(c.key || ""), item);
        const op = c.operation || "get";
        try {
          if (op === "set") {
            const rendered = renderTemplate(c.value ?? "", item);
            datastore.set(ns, key, parseJsonField(rendered, rendered));
            out.push({ json: { ...base, saved: true, key, namespace: ns } });
          } else if (op === "get") {
            const value = datastore.get(ns, key);
            out.push({ json: { ...base, [c.storeIn || "value"]: value, key, namespace: ns, found: value !== null } });
          } else if (op === "delete") {
            datastore.remove(ns, key);
            out.push({ json: { ...base, deleted: true, key, namespace: ns } });
          } else {
            const records = datastore.list(ns);
            out.push({ json: { ...base, records, count: records.length, namespace: ns } });
          }
        } catch (err) {
          throw attachCode(new Error(String(err.message || err)), "UNKNOWN");
        }
      }
      return { byHandle: { out } };
    }

    case "sqlQuery": {
      const out = [];
      for (const item of items) {
        const sql = renderTemplate(String(c.sql || ""), item);
        let params = {};
        try {
          params = parseJsonField(renderTemplate(c.params ?? "{}", item), {});
        } catch {
          params = {};
        }
        try {
          // The workflow SQL node is read-only: the database also holds user
          // accounts, sessions and encrypted secrets, and webhooks can trigger
          // workflows without a login — so INSERT / UPDATE / DELETE / DDL /
          // write pragmas are rejected here. (Admin SQL console unaffected.)
          if (!isReadOnlySql(sql)) {
            throw new Error(
              "Workflow SQL is read-only: only SELECT / WITH / VALUES / EXPLAIN queries are allowed. Writes are blocked for safety — use the admin panel's SQL console for that."
            );
          }
          const result = await runSql(sql, params);
          out.push({
            json: {
              ...item.json,
              [c.storeIn || "rows"]: result.rows || [],
              columns: result.columns || [],
              rowCount: result.rowCount ?? 0,
              changes: result.changes ?? 0,
              sql: sql.slice(0, 500),
            },
          });
        } catch (err) {
          throw attachCode(new Error(`${String(err.message || err)} (query: ${sql.slice(0, 200)})`), "QUERY_FAILED");
        }
      }
      return { byHandle: { out } };
    }

    case "textAggregate": {
      const field = String(c.field || "");
      const parts = items
        .map((it) => {
          const v = getPath(it.json, field);
          return v === undefined || v === null ? "" : String(v);
        })
        .filter((s) => s !== "");
      const sep = renderTemplate(String(c.separator ?? "\n"), items[0] || {});
      const out = [{ json: { [c.storeIn || "aggregated"]: String(c.prefix || "") + parts.join(sep) + String(c.suffix || ""), count: parts.length } }];
      return { byHandle: { out } };
    }

    // Chat output — posts a reply into the chat panel. The editor reads the
    // last chatOutput node's output and appends it to the conversation.
    case "chatOutput": {
      const out = [];
      for (const item of items) {
        let text;
        try {
          text = renderTemplate(c.text ?? "", item);
        } catch {
          text = String(c.text ?? "");
        }
        const msg = { role: c.role || "assistant", message: text, text, chat: true, at: new Date().toISOString() };
        out.push({ json: c.storeIn ? { [c.storeIn]: text, ...msg } : msg });
      }
      return { byHandle: { out } };
    }

    // --- extra core / logic / utility nodes (shared/services.js) -----------
    case "router": {
      const rules = Array.isArray(c.rules) ? c.rules : parseJsonField(c.rules, []);
      const out = { fallback: [] };
      rules.forEach((_row, i) => {
        out[`case-${i}`] = [];
      });
      const cs = !!c.caseSensitive;
      const norm = (v) => {
        const s = v === undefined || v === null ? "" : String(v);
        return cs ? s : s.toLowerCase();
      };
      for (const item of items) {
        let matched = false;
        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i] || {};
          // `field` is a payload path — the same convention the Filter and Sort
          // nodes use ("status", "customer.plan"). A rule that wraps it in a
          // template ("{{status}}") is still honoured, so rules written against
          // the old behaviour keep matching.
          const fieldExpr = String(rule.field ?? "");
          const rawA = fieldExpr.includes("{{") ? renderTemplate(fieldExpr, item) : getPath(item.json, fieldExpr);
          const a = norm(rawA);
          const b = norm(rule.value ?? "");
          const op = rule.operator || "equals";
          let ok = false;
          switch (op) {
            case "equals": ok = a === b; break;
            case "notEquals": ok = a !== b; break;
            case "contains": ok = a.includes(b); break;
            case "notContains": ok = !a.includes(b); break;
            case "startsWith": ok = a.startsWith(b); break;
            case "regex": {
              try {
                ok = new RegExp(String(rule.value ?? ""), cs ? "" : "i").test(String(rawA));
              } catch {
                throw attachCode(new Error(`Router rule ${i + 1} uses an invalid regular expression.`), "INVALID_REGEX");
              }
              break;
            }
            case "gt": ok = Number(a) > Number(b); break;
            case "lt": ok = Number(a) < Number(b); break;
            case "exists": ok = a !== ""; break;
            case "notExists": ok = a === ""; break;
            default: ok = false;
          }
          if (ok) {
            out[`case-${i}`].push(item);
            matched = true;
            break;
          }
        }
        if (!matched) out.fallback.push(item);
      }
      return { byHandle: out };
    }

    case "aggregate": {
      const storeIn = String(c.storeIn || "items");
      const collected = (c.mode || "items") === "field" ? items.map((it) => getPath(it.json, c.field)) : items.map((it) => it.json);
      return { byHandle: { out: [{ json: { [storeIn]: collected } }] } };
    }

    case "compareDatasets": {
      const base = items[0]?.json || {};
      const listA = Array.isArray(getPath(base, c.listA)) ? getPath(base, c.listA) : [];
      const listB = Array.isArray(getPath(base, c.listB)) ? getPath(base, c.listB) : [];
      const keyField = String(c.keyField || "id");
      const cmpField = String(c.compareField || "");
      const byKey = (list) => {
        const m = new Map();
        for (const row of list) m.set(String(getPath(row, keyField)), row);
        return m;
      };
      const mapA = byKey(listA);
      const mapB = byKey(listB);
      const same = [];
      const different = [];
      const onlyA = [];
      const onlyB = [];
      for (const [k, a] of mapA) {
        if (!mapB.has(k)) {
          onlyA.push({ json: { key: k, a } });
          continue;
        }
        const b = mapB.get(k);
        const av = cmpField ? getPath(a, cmpField) : a;
        const bv = cmpField ? getPath(b, cmpField) : b;
        if (JSON.stringify(av) === JSON.stringify(bv)) same.push({ json: { key: k, a, b } });
        else different.push({ json: { key: k, a, b } });
      }
      for (const [k, b] of mapB) if (!mapA.has(k)) onlyB.push({ json: { key: k, b } });
      return { byHandle: { same, different, onlyA, onlyB } };
    }

    case "xml": {
      const storeIn = String(c.storeIn || "xmlData");
      const out = items.map((item) => {
        const src = getPath(item.json, c.field);
        if (c.mode === "build") {
          const obj = typeof src === "string" ? parseJsonField(src, {}) : src;
          return { json: { ...item.json, [storeIn]: buildXml(obj || {}, c.rootName || "root") } };
        }
        const xmlText = typeof src === "string" ? src : String(src ?? "");
        if (!xmlText.trim()) throw attachCode(new Error(`No XML found in field '${c.field}'.`), "FIELD_MISSING");
        return { json: { ...item.json, [storeIn]: parseXml(xmlText, c) } };
      });
      return { byHandle: { out } };
    }

    case "htmlExtract": {
      const storeIn = String(c.outputField || "htmlText");
      const out = items.map((item) => {
        const html = String(getPath(item.json, c.field) ?? "");
        let result;
        switch (c.mode || "text") {
          case "title": {
            const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            result = m ? m[1].trim() : "";
            break;
          }
          case "links":
            result = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
            break;
          case "images":
            result = [...html.matchAll(/<img\b[^>]*src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
            break;
          case "attributes": {
            const tag = String(c.tag || "a").replace(/[^\w-]/g, "");
            const attr = String(c.attribute || "href").replace(/[^\w-]/g, "");
            result = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*${attr}\\s*=\\s*["']([^"']+)["']`, "gi"))].map((m) => m[1]);
            break;
          }
          case "tables":
            result = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1])));
            break;
          default:
            result = stripTags(html);
        }
        return { json: { ...item.json, [storeIn]: result } };
      });
      return { byHandle: { out } };
    }

    case "markdown": {
      const storeIn = String(c.storeIn || "html");
      const out = items.map((item) => {
        const src = String(getPath(item.json, c.field) ?? "");
        const mode = c.mode || "toHtml";
        const result = mode === "toMarkdown" ? htmlToMarkdown(src) : mode === "toText" ? stripTags(markdownToHtml(src)) : markdownToHtml(src);
        return { json: { ...item.json, [storeIn]: result } };
      });
      return { byHandle: { out } };
    }

    case "textParser": {
      const storeIn = String(c.storeIn || "match");
      const pattern = String(c.pattern ?? "");
      const mode = c.mode || "extract";
      if (mode !== "split" && !pattern) throw attachCode(new Error("Text Parser / Regex needs a regular expression."), "MISSING_CONFIG");
      let flags = String(c.flags ?? "g").replace(/[^gimsuy]/g, "");
      const out = items.map((item) => {
        const src = String(getPath(item.json, c.field) ?? "");
        let result;
        try {
          const group = Number(c.group) || 0;
          switch (mode) {
            case "all":
              result = [...src.matchAll(new RegExp(pattern, flags.includes("g") ? flags : flags + "g"))].map((m) => (group ? m[group] : m[0]));
              break;
            case "replace":
              result = src.replace(new RegExp(pattern, flags), String(c.replacement ?? ""));
              break;
            case "split":
              result = src.split(pattern ? new RegExp(pattern, flags) : ",");
              break;
            case "test":
              result = new RegExp(pattern, flags).test(src);
              break;
            default: {
              const m = src.match(new RegExp(pattern, flags));
              result = m ? (group ? m[group] : m[0]) : null;
            }
          }
        } catch {
          throw attachCode(new Error(`Invalid regular expression: ${pattern}`), "INVALID_REGEX");
        }
        return { json: { ...item.json, [storeIn]: result } };
      });
      return { byHandle: { out } };
    }

    case "executeCommand": {
      assertCommandsAllowed("Execute Command");
      const storeIn = String(c.storeIn || "command");
      const timeout = Number(c.timeout) > 0 ? Number(c.timeout) : 60000;
      const out = [];
      for (const item of items) {
        const command = renderTemplate(c.command, item);
        if (!String(command).trim()) throw attachCode(new Error("Execute Command needs a command."), "MISSING_CONFIG");
        let stdout = "";
        let stderr = "";
        let exitCode = 0;
        try {
          const r = await execAsync(command, { cwd: c.cwd || undefined, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
          stdout = r.stdout;
          stderr = r.stderr;
        } catch (err) {
          stdout = err.stdout || "";
          stderr = err.stderr || "";
          exitCode = err.code ?? 1;
          if (err.killed) throw attachCode(new Error(`Command timed out after ${timeout} ms.`), "HTTP_TIMEOUT");
        }
        out.push({ json: { ...item.json, [storeIn]: { stdout, stderr, exitCode } } });
      }
      return { byHandle: { out } };
    }

    case "ssh": {
      assertCommandsAllowed("SSH");
      if (!c.host || !c.user || !c.command) throw attachCode(new Error("SSH needs a host, a user and a command."), "MISSING_CONFIG");
      // A host/user starting with "-" would be read as an ssh option (e.g.
      // -oProxyCommand=…, which runs a local command), so reject those.
      const sshUser = rejectOptionLike(c.user, "The SSH user");
      const sshHost = rejectOptionLike(c.host, "The SSH host");
      const storeIn = String(c.storeIn || "ssh");
      const timeout = Number(c.timeout) > 0 ? Number(c.timeout) : 30000;
      const out = [];
      for (const item of items) {
        const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-p", String(Number(c.port) || 22)];
        if (c.privateKeyPath) {
          // The key must be a file inside the account's own folder — never an
          // arbitrary path on the server (e.g. another account's key, /etc/…).
          const key = safeFilePath(String(c.privateKeyPath), ctx.filesOwner || ctx.userId || "");
          if (!key.ok) throw attachCode(new Error(`SSH key path: ${key.error}`), "MISSING_CONFIG");
          args.push("-i", key.fullPath);
        }
        args.push(`${sshUser}@${sshHost}`, renderTemplate(c.command, item));
        let stdout = "";
        let stderr = "";
        try {
          const r = await execFileAsync("ssh", args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
          stdout = r.stdout;
          stderr = r.stderr;
        } catch (err) {
          stderr = err.stdout || err.stderr || err.message || "";
          throw attachCode(new Error(`SSH failed: ${String(stderr).slice(0, 400)}`), "SERVICE_ERROR");
        }
        out.push({ json: { ...item.json, [storeIn]: { stdout, stderr } } });
      }
      return { byHandle: { out } };
    }

    case "ftp": {
      assertCommandsAllowed("FTP / SFTP");
      if (!c.host) throw attachCode(new Error("FTP / SFTP needs a host."), "MISSING_CONFIG");
      const proto = c.protocol === "ftp" ? "ftp" : "sftp";
      const ftpHost = rejectOptionLike(c.host, "The FTP host");
      // Block a host that resolves to the server itself / a private address
      // (same guard the HTTP node uses), so FTP can't be used for SSRF.
      await assertPublicHttpUrl(`http://${ftpHost}`);
      const storeIn = String(c.storeIn || "ftp");
      const owner = ctx.filesOwner || ctx.userId || "";
      // The local file curl reads (upload) or writes (download) must stay inside
      // the account's own folder — never an arbitrary path on the server.
      const localFile = (rel, fallback) => {
        const p = safeFilePath(String(rel || "").trim() || fallback, owner);
        if (!p.ok) throw attachCode(new Error(`FTP local path: ${p.error}`), "MISSING_CONFIG");
        return p.fullPath;
      };
      const out = [];
      for (const item of items) {
        const port = Number(c.port) || (proto === "ftp" ? 21 : 22);
        const url = `${proto}://${ftpHost}:${port}${c.remotePath || "/"}`;
        const args = ["-sS", "--max-time", "60"];
        if (c.user) args.push("--user", `${rejectOptionLike(c.user, "The FTP user")}:${c.password || ""}`);
        if ((c.action || "list") === "download") args.push("-o", localFile(c.localPath, "ftp-download"), url);
        else if (c.action === "upload") args.push("-T", localFile(renderTemplate(c.localPath, item), "ftp-upload"), url);
        else args.push(url);
        let stdout = "";
        let stderr = "";
        try {
          const r = await execFileAsync("curl", args, { timeout: 65000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
          stdout = r.stdout;
          stderr = r.stderr;
        } catch (err) {
          throw attachCode(new Error(`FTP failed: ${String(err.stderr || err.message).slice(0, 400)}`), "SERVICE_ERROR");
        }
        out.push({ json: { ...item.json, [storeIn]: { output: stdout, stderr } } });
      }
      return { byHandle: { out } };
    }

    case "git": {
      assertCommandsAllowed("Git");
      const storeIn = String(c.storeIn || "git");
      const repo = String(c.repoPath || "").trim();
      const action = c.action || "status";
      const timeout = Number(c.timeout) > 0 ? Number(c.timeout) : 60000;
      const extra = String(c.args || "").match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      // Even behind the command gate, block the git flags that run arbitrary
      // programs (`-c core.sshCommand=…`, `--upload-pack`, `--exec`, …) so a
      // custom-args field cannot become a general shell.
      const DANGEROUS_GIT = /^(-c|--config|-u|--upload-pack|--receive-pack|--exec|--output|-o)(=|$)/i;
      for (const a of extra) {
        if (DANGEROUS_GIT.test(a.replace(/^"|"$/g, ""))) {
          throw attachCode(new Error(`The git argument "${a}" is not allowed (it can run other programs).`), "MISSING_CONFIG");
        }
      }
      const out = [];
      for (const item of items) {
        let args;
        if (action === "clone") {
          // The clone destination must stay inside the account's own folder.
          const dest = safeFilePath(String(extra[0] || "repo").replace(/^"|"$/g, ""), ctx.filesOwner || ctx.userId || "");
          if (!dest.ok) throw attachCode(new Error(`Git clone path: ${dest.error}`), "MISSING_CONFIG");
          args = ["clone", "--", rejectOptionLike(repo, "The repository URL"), dest.fullPath];
        } else if (action === "status") args = ["-C", repo, "status", "--short"];
        else if (action === "pull") args = ["-C", repo, "pull"];
        else if (action === "log") args = ["-C", repo, "log", "--oneline", "-n", "20"];
        else args = ["-C", repo, ...extra];
        if (repo === "" && action !== "clone") throw attachCode(new Error("Git needs a repository path."), "MISSING_CONFIG");
        let stdout = "";
        let stderr = "";
        try {
          const r = await execFileAsync("git", args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
          stdout = r.stdout;
          stderr = r.stderr;
        } catch (err) {
          throw attachCode(new Error(`git ${action} failed: ${String(err.stderr || err.message).slice(0, 400)}`), "SERVICE_ERROR");
        }
        out.push({ json: { ...item.json, [storeIn]: { stdout, stderr } } });
      }
      return { byHandle: { out } };
    }

    case "docker": {
      assertCommandsAllowed("Docker");
      const storeIn = String(c.storeIn || "docker");
      const timeout = Number(c.timeout) > 0 ? Number(c.timeout) : 60000;
      const extra = (String(c.args || "").match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a) => a.replace(/^"|"$/g, ""));
      const out = [];
      for (const item of items) {
        let args;
        switch (c.action || "ps") {
          case "start": args = ["start", c.container]; break;
          case "stop": args = ["stop", c.container]; break;
          case "restart": args = ["restart", c.container]; break;
          case "pull": args = ["pull", c.image]; break;
          case "custom": args = extra; break;
          default: args = ["ps"];
        }
        if ((c.action === "start" || c.action === "stop" || c.action === "restart") && !c.container) {
          throw attachCode(new Error("Docker needs a container for this action."), "MISSING_CONFIG");
        }
        let stdout = "";
        let stderr = "";
        try {
          const r = await execFileAsync("docker", args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
          stdout = r.stdout;
          stderr = r.stderr;
        } catch (err) {
          throw attachCode(new Error(`docker failed: ${String(err.stderr || err.message).slice(0, 400)}`), "SERVICE_ERROR");
        }
        out.push({ json: { ...item.json, [storeIn]: { stdout, stderr } } });
      }
      return { byHandle: { out } };
    }

    case "redis": {
      if (!c.command || !c.key) throw attachCode(new Error("Redis needs a command and a key."), "MISSING_CONFIG");
      const storeIn = String(c.storeIn || "redis");
      const out = [];
      for (const item of items) {
        const args = [String(renderTemplate(c.command, item)), String(renderTemplate(c.key, item))];
        if (c.value) args.push(String(renderTemplate(c.value, item)));
        const result = await redisCommand({ host: c.host || "127.0.0.1", port: Number(c.port) || 6379, password: c.password, db: Number(c.db) || 0, args });
        out.push({ json: { ...item.json, [storeIn]: result } });
      }
      return { byHandle: { out } };
    }

    case "mqtt": {
      let mqtt;
      try {
        mqtt = await import("mqtt");
      } catch {
        throw attachCode(new Error("The MQTT node needs the optional 'mqtt' package installed on the server."), "MISSING_CONFIG");
      }
      if (!c.url || !c.topic) throw attachCode(new Error("MQTT needs a broker URL and a topic."), "MISSING_CONFIG");
      const storeIn = String(c.storeIn || "mqtt");
      const out = [];
      for (const item of items) {
        const message = renderTemplate(c.message, item);
        await new Promise((resolve, reject) => {
          const client = mqtt.connect(c.url, { username: c.username || undefined, password: c.password || undefined, connectTimeout: 8000, reconnectPeriod: 0 });
          client.on("error", (e) => {
            client.end(true);
            reject(attachCode(new Error(`MQTT connection failed: ${e.message}`), "SERVICE_ERROR"));
          });
          client.on("connect", () =>
            client.publish(c.topic, String(message), {}, (err) => {
              client.end();
              if (err) reject(attachCode(new Error(`MQTT publish failed: ${err.message}`), "SERVICE_ERROR"));
              else resolve();
            })
          );
        });
        out.push({ json: { ...item.json, [storeIn]: { topic: c.topic, published: true } } });
      }
      return { byHandle: { out } };
    }

    case "kafka": {
      let Kafka;
      try {
        ({ Kafka } = await import("kafkajs"));
      } catch {
        throw attachCode(new Error("The Kafka node needs the optional 'kafkajs' package installed on the server."), "MISSING_CONFIG");
      }
      if (!c.brokers || !c.topic) throw attachCode(new Error("Kafka needs brokers and a topic."), "MISSING_CONFIG");
      const storeIn = String(c.storeIn || "kafka");
      const out = [];
      const producer = new Kafka({ clientId: c.clientId || "wflow", brokers: String(c.brokers).split(",").map((s) => s.trim()) }).producer();
      try {
        await producer.connect();
        for (const item of items) {
          const message = String(renderTemplate(c.message, item));
          await producer.send({ topic: c.topic, messages: [{ value: message }] });
          out.push({ json: { ...item.json, [storeIn]: { topic: c.topic, sent: true } } });
        }
      } catch (err) {
        throw attachCode(new Error(`Kafka publish failed: ${err.message}`), "SERVICE_ERROR");
      } finally {
        await producer.disconnect().catch(() => {});
      }
      return { byHandle: { out } };
    }

    case "sqlSqlserver": {
      let sql;
      try {
        sql = (await import("mssql")).default;
      } catch {
        throw attachCode(new Error("The SQL Server node needs the optional 'mssql' package installed on the server."), "MISSING_CONFIG");
      }
      const storeIn = String(c.storeIn || "rows");
      const out = [];
      for (const item of items) {
        const rawSql = renderTemplate(c.query ?? "", item);
        const params = parseJsonField(c.params, []);
        let pool;
        try {
          pool = await sql.connect({
            server: c.host || "localhost",
            port: Number(c.port) || 1433,
            database: c.database,
            user: c.user,
            password: c.password,
            options: { encrypt: c.encrypt !== false, trustServerCertificate: true },
            connectionTimeout: Number(c.connectTimeoutMs || 10000),
          });
          const req = pool.request();
          const list = Array.isArray(params) ? params : Object.values(params || {});
          list.forEach((v, i) => req.input(`p${i}`, v));
          let n = 0;
          const sqlText = rawSql.replace(/\$\d+/g, (m) => `@p${Number(m.slice(1)) - 1}`).replace(/\?/g, () => `@p${n++}`);
          const res = await req.query(sqlText);
          out.push({ json: { ...item.json, fetched: true, [storeIn]: res.recordset || [], rowCount: (res.recordset || []).length } });
        } catch (err) {
          throw attachCode(new Error(String(err.message || err)), "QUERY_FAILED");
        } finally {
          await pool?.close().catch(() => {});
        }
      }
      return { byHandle: { out } };
    }

    case "aiClassify": {
      const field = String(c.field || "text");
      const storeIn = String(c.storeIn || "classification");
      if (!c.model) throw attachCode(new Error("Text Classifier needs a model."), "AI_CONFIG_MISSING");
      const out = [];
      const usages = [];
      for (const item of items) {
        const text = String(getPath(item.json, field) ?? "");
        const categories = c.mode === "sentiment" ? ["positive", "negative", "neutral"] : String(c.categories || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!categories.length) throw attachCode(new Error("Text Classifier needs at least one category."), "MISSING_CONFIG");
        const prompt = `Classify the following text into exactly one of these categories: ${categories.join(", ")}.\nReply with ONLY the category name.\n\nText:\n${text}`;
        const reply = await chatCompletion({ provider: c.provider, baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, temperature: Number(c.temperature) || 0, maxTokens: Number(c.maxTokens) || 64 }, [{ role: "user", content: prompt }]);
        usages.push({ ...(reply?.usage || {}), model: reply?.usage?.model || c.model });
        const raw = String(reply?.text ?? reply ?? "").trim();
        const matched = categories.find((cat) => cat.toLowerCase() === raw.toLowerCase()) || categories.find((cat) => raw.toLowerCase().includes(cat.toLowerCase())) || raw;
        out.push({ json: { ...item.json, [storeIn]: matched, _classification: { raw, categories } } });
      }
      return { byHandle: { out }, usage: mergeUsage(usages) };
    }

    case "executeWorkflowTrigger": {
      // Called by another workflow, the caller's items arrive directly (the
      // engine seeds this node as an input port and never runs the handler).
      // Run on its own, emit the real inbound event or, like every other
      // trigger, a representative sample instead of an empty object.
      if (items.length) return { byHandle: { out: items } };
      if (realTrigger) return { byHandle: { out: [{ json: realTrigger }] } };
      return { byHandle: { out: [{ json: samplePayloadFor(node, ctx) }] } };
    }

    // Gmail send / draft: the plain To / Subject / Message fields become the
    // encoded message Gmail wants; a `raw` already on the item wins when the
    // node's To is left empty.
    case "gmailSend":
    case "gmailCreateDraft": {
      const prepared = items.map((item) => {
        const to = renderTemplate(c.to ?? "", item).trim();
        if (!to) {
          if (!item.json?.raw) throw attachCode(new Error("Fill in To (or pass a ready-made `raw` message in the item)."), "MISSING_CONFIG");
          return item;
        }
        const raw = gmailRawMessage({
          to,
          cc: renderTemplate(c.cc ?? "", item).trim(),
          subject: renderTemplate(c.subject ?? "", item),
          message: renderTemplate(c.message ?? "", item),
          html: !!c.html,
        });
        return { ...item, json: { ...(item.json || {}), raw } };
      });
      return runServiceNode(node, getNodeDef(node.type), prepared, ctx, assertPublicHttpUrl);
    }

    default: {
      // Any catalog trigger that isn't handled above emits the real inbound
      // event when one was supplied (a non-manual Run waits for input, and the
      // background watchers pass their event), otherwise its representative
      // sample payload so downstream logic can still be designed.
      if (isTriggerType(node.type)) {
        if (realTrigger) return { byHandle: { out: [{ json: realTrigger }] } };
        return { byHandle: { out: [{ json: samplePayloadFor(node, ctx) }] } };
      }
      // Aliases for trigger types that were merged into a sibling trigger in
      // the catalog (notionDbTrigger → notionTrigger, …). They no longer
      // appear in the palette, but workflows saved before the merge keep
      // running with the merged trigger's sample payload.
      const TRIGGER_ALIASES = {
        notionDbTrigger: "notionTrigger",
        sheetsAppendTrigger: "sheetsTrigger",
        jiraIssueUpdateTrigger: "jiraTrigger",
      };
      const alias = TRIGGER_ALIASES[node.type];
      if (alias) {
        return { byHandle: { out: [{ json: samplePayloadFor({ ...node, type: alias }, ctx) }] } };
      }
      // External service nodes (shared/services.js) run through the shared
      // authenticated request engine instead of a hand-written case.
      const serviceDef = getNodeDef(node.type);
      // Feeds & Sources presets (shared/services.js buildFeed) are the RSS Read
      // node with a service-specific URL built from the preset's own fields.
      if (serviceDef && serviceDef.feed) {
        const out = [];
        for (const item of items) {
          out.push(await readFeed(feedUrlFor(serviceDef.feed.url, c, item, serviceDef.name), c.limit, c.storeIn, item));
        }
        return { byHandle: { out } };
      }
      if (serviceDef && serviceDef.service) {
        return runServiceNode(node, serviceDef, items, ctx, assertPublicHttpUrl);
      }
      throw new Error(`Unsupported node type: ${node.type}`);
    }
  }
}

// ----------------------------------------------------------------------------
// Single-node execution (manual stepping / "Run next node")
// Runs exactly one node with the supplied input items and returns its result
// without executing the rest of the graph. Used to step past a halted node:
// feed it the manually-set output of an upstream node.
// ----------------------------------------------------------------------------
/** Variables + environment for a run (server/run-context.js), loaded once. */
async function runContextFor(workflow, ctx) {
  const environment = normalizeEnvironment(ctx.environment ?? workflow?.environment);
  const vars = ctx.vars && typeof ctx.vars === "object" ? ctx.vars : await loadRunVars(ctx.userId, environment);
  // Budgets belong to the workflow's owner, whoever started the run.
  const ownerId = workflow?.ownerId || ctx.userId || "";
  const ai = ownerId ? { ownerId, workflow: { id: workflow?.id, name: workflow?.name, aiBudget: workflow?.aiBudget }, node: null, logLines: null } : null;
  // The file nodes work in the owner's own folder (server/disk.js), like budgets.
  return { vars, environment, ai, filesOwner: ownerId };
}

export async function executeNode(workflow, nodeId, inputItems, ctx = {}) {
  const context = await runContextFor(workflow, ctx);
  return withRunContext(context, () => executeNodeHere(workflow, nodeId, inputItems, ctx));
}

async function executeNodeHere(workflow, nodeId, inputItems, ctx = {}) {
  const node = (workflow.nodes || []).find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node "${nodeId}" not found in workflow`);
  const runCtx = { ...ctx, workflowId: ctx.workflowId || workflow.id, files: ctx.files || new Map(), logLines: ctx.logLines || [] };
  const aiScope = currentRunContext().ai;
  if (aiScope) {
    if (!aiScope.logLines) aiScope.logLines = runCtx.logLines;
    aiScope.node = { id: node.id, label: node.data?.label || getNodeDef(node.type)?.name || node.type, config: node.data?.config || {} };
  }
  const startedAt = new Date().toISOString();
  const perfStart = performance.now();
  let status = "success";
  let error;
  let out = { byHandle: {} };
  try {
    out = await runNode(node, inputItems || [], runCtx);
  } catch (err) {
    status = "error";
    error = err;
  }
  const durationMs = Math.round(performance.now() - perfStart);
  const outputItems = Object.values(out.byHandle).flat();
  let entry = {
    nodeId: node.id,
    nodeName: node.data?.label || getNodeDef(node.type)?.name || node.type,
    nodeType: node.type,
    status,
    durationMs,
    inputItems: (inputItems || []).map((i) => i.json),
    outputItems: outputItems.map((i) => i.json),
  };
  if (error) {
    const codeDef = codeForError(error);
    entry.error = String(error.message || error);
    entry.errorCode = codeDef.code;
    entry.errorShort = codeDef.short;
  }
  return { ...entry, log: [entry], success: status === "success", webhookResponse: runCtx.webhookResponse };
}

// ----------------------------------------------------------------------------
// Graph execution
// ----------------------------------------------------------------------------
export async function executeWorkflow(workflow, ctx = {}) {
  const context = await runContextFor(workflow, ctx);
  const result = await withRunContext(context, () => executeWorkflowHere(workflow, ctx));
  result.environment = context.environment;
  return result;
}

async function executeWorkflowHere(workflow, ctx = {}) {
  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  const outEdges = new Map();
  const inEdges = new Map();
  for (const e of workflow.edges || []) {
    if (!outEdges.has(e.source)) outEdges.set(e.source, []);
    if (!inEdges.has(e.target)) inEdges.set(e.target, []);
    outEdges.get(e.source).push(e);
    inEdges.get(e.target).push(e);
  }

  const log = [];
  const startedAt = new Date().toISOString();
  const perfStart = performance.now();
  const ctxLog = { logLines: [] };
  const runCtx = { ...ctx, workflowId: workflow.id, logLines: ctxLog.logLines, files: new Map() };
  const aiScope = currentRunContext().ai;
  if (aiScope && !aiScope.logLines) aiScope.logLines = ctxLog.logLines;
  const itemsByNode = new Map();
  const queue = [];
  const visited = new Set();
  const maxItemsInLog = Math.max(1, Math.min(50, Number(ctx.maxItemsPerNode || DEFAULT_MAX_ITEMS) || DEFAULT_MAX_ITEMS));

  const snapshot = (items) =>
    (items || []).slice(0, maxItemsInLog).map((i) => i.json);

  const record = (node, status, inputItems, outputItems, error, durationMs, extra) => {
    let errorCode;
    let errorShort;
    if (error) {
      const codeDef = codeForError(error);
      errorCode = codeDef.code;
      errorShort = codeDef.short;
    }
    log.push({
      nodeId: node.id,
      nodeName: node.data?.label || getNodeDef(node.type)?.name || node.type,
      nodeType: node.type,
      status,
      durationMs: Math.round(durationMs),
      inputItems: snapshot(inputItems),
      outputItems: snapshot(outputItems),
      // Full counts: the snapshots above are capped, so a resume can tell
      // whether it holds every input item, and the canvas can label edges.
      inputCount: (inputItems || []).length,
      error: error ? String(error.message || error) : undefined,
      errorCode,
      errorShort,
      ...extra,
    });
  };

  // Sub-workflow invocation (the Execute Sub-Workflow node): the caller's
  // items ARE this workflow's input. Every entry point — trigger nodes and any
  // node without incoming edges — becomes an input port that receives the items
  // directly. Ports are recorded but no handler runs, so a called workflow never
  // invents trigger sample data.
  const portIds = new Set();
  // Where a run starts. With a trigger on the canvas only the triggers start it,
  // so a node left lying around (not wired to a trigger) never executes. Without
  // any trigger (older workflows that start "anywhere") every node without an
  // input starts it — except a completely unconnected node, unless the canvas
  // holds nothing else (a one-node workflow still runs).
  const triggerIds = workflow.nodes.filter((n) => isTriggerType(n.type)).map((n) => n.id);
  const isolated = (id) => !inEdges.has(id) && !outEdges.has(id);
  const allIsolated = workflow.nodes.every((n) => isolated(n.id));
  const startIds = triggerIds.length
    ? triggerIds
    : workflow.nodes.filter((n) => !inEdges.has(n.id) && (allIsolated || !isolated(n.id))).map((n) => n.id);
  if (ctx.resumeFrom?.nodeId) {
    // Retry from a failed node: only that node is seeded, with the input it
    // had in the failed run — nothing upstream runs again (no duplicate
    // orders, e-mails or charges from the steps that already succeeded).
    const { nodeId, items } = ctx.resumeFrom;
    if (!nodes.has(nodeId)) throw attachCode(new Error(`Node "${nodeId}" no longer exists in this workflow.`), "MISSING_CONFIG");
    itemsByNode.set(nodeId, { out: (items || []).map((json) => ({ json })) });
    visited.add(nodeId);
    queue.push(nodeId);
  } else if (Array.isArray(ctx.subworkflowItems)) {
    for (const id of startIds) {
      portIds.add(id);
      itemsByNode.set(id, { out: ctx.subworkflowItems.map((json) => ({ json })) });
      visited.add(id);
      queue.push(id);
    }
  } else {
    // Trigger nodes run their own handler; a start node that is not a trigger
    // gets a single "started now" item.
    for (const id of startIds) {
      if (!isTriggerType(nodes.get(id).type)) {
        itemsByNode.set(id, { out: [{ json: { triggeredAt: new Date().toISOString() } }] });
      }
      visited.add(id);
      queue.push(id);
    }
  }

  while (queue.length) {
    // The editor's Stop button aborts the run's signal — halt at the next node
    // boundary so no further downstream nodes start (the node currently in
    // flight finishes first and is still recorded in the log).
    if (runCtx.signal?.aborted) break;
    const id = queue.shift();
    const node = nodes.get(id);
    if (!node) continue;
    const inputItems = (itemsByNode.get(id) || {}).out || [];
    let out;
    if (portIds.has(id)) {
      // Input port of a sub-workflow call — the caller's items were pre-seeded
      // above, so no handler runs: they flow straight downstream.
      out = { byHandle: { out: inputItems } };
      itemsByNode.set(id, out.byHandle);
      record(node, "success", [], inputItems, null, 0);
    } else {
      // Debug mode: park before every node until the editor presses Next or
      // Continue (server/run-control.js). Stop aborts the wait too.
      if (runCtx.beforeNode) {
        await runCtx.beforeNode(node.id, snapshot(inputItems));
        if (runCtx.signal?.aborted) break;
      }
      const t0 = performance.now();
      // Tell the live-run registry which node is executing so the editor can
      // draw a loading ring over it (see server/run-control.js).
      runCtx.onNodeStart?.(node.id);

      // --- per-node error handling ---------------------------------------
      // The node's "If this node fails" setting decides what happens when its
      // handler throws: "stop" (halt the run — the default for logic, AI and
      // trigger nodes), "continue" (hand the items to the next node with an
      // `_error` field — the default for action nodes, so a flaky third-party
      // API cannot kill a long automation) or "retry" (try again, then stop).
      const nodeCfg = node.data?.config || {};
      const errorMode = String(nodeCfg.onError || defaultOnErrorFor(node.type));
      const maxAttempts = errorMode === "retry" ? Math.max(1, Math.min(10, Math.round(Number(nodeCfg.retryCount) || 3))) : 1;
      const retryDelayMs = Math.max(0, Math.min(120, Number(nodeCfg.retryDelay ?? 2))) * 1000;
      let failure = null;
      let attempt = 0;
      while (attempt < maxAttempts) {
        attempt += 1;
        try {
          // The spending guard needs to know whose model call it is checking.
          if (aiScope) aiScope.node = { id: node.id, label: node.data?.label || getNodeDef(node.type)?.name || node.type, config: nodeCfg };
          out = await runNode(node, inputItems, runCtx);
          failure = null;
          break;
        } catch (err) {
          failure = err;
          if (attempt < maxAttempts && !runCtx.signal?.aborted) await sleep(retryDelayMs, runCtx.signal);
        }
      }

      if (failure) {
        const codeDef = codeForError(failure);
        const nodeName = node.data?.label || getNodeDef(node.type)?.name || node.type;
        if (errorMode === "continue") {
          // Make-style "resume": every incoming item carries on with the error
          // attached, so a downstream IF / Filter / error workflow can react.
          const continueItems = inputItems.map((it) => ({
            json: {
              ...it.json,
              _error: {
                message: String(failure.message || failure),
                code: codeDef.code,
                marker: `BF-${codeDef.code}`,
                nodeId: node.id,
                nodeName,
                nodeType: node.type,
                attempts: attempt,
              },
            },
          }));
          out = { byHandle: { out: continueItems } };
          itemsByNode.set(id, out.byHandle);
          record(node, "error", inputItems, continueItems, failure, performance.now() - t0, { handled: true, attempts: attempt });
        } else {
          record(node, "error", inputItems, [], failure, performance.now() - t0, attempt > 1 ? { attempts: attempt } : undefined);
          continue; // unhandled — the chain stops here (as before)
        }
      } else {
      itemsByNode.set(id, out.byHandle);
      const allOutItems = Object.values(out.byHandle).flat();
      // "Save output as file": register the node's output as a named file that
      // downstream Extract File nodes can request by name. The summary is shown
      // in the run log without polluting the items that flow on to other nodes.
      const filesWritten = [];
      // A node skipped via Manual output was not really executed — it must not
      // register output files either (its typed JSON flows on untouched).
      if (!node.data?.config?.manualOutput) {
        filesWritten.push(...registerOutputFiles(node, allOutItems, runCtx));
        // Write File nodes save into the sandbox (./data/files) — surface those
        // names in the log too, so the console shows exactly what was produced.
        for (const it of allOutItems) {
          if (it.json?.written === true && it.json?.path) {
            filesWritten.push({ name: String(it.json.path).split("/").pop(), path: it.json.path, size: it.json.size, mimeType: it.json.mimeType });
          }
        }
      }
      const logItems = filesWritten.length ? allOutItems.map((it) => ({ ...it, json: { ...it.json, filesWritten } })) : allOutItems;
      // Token usage reported by the AI nodes for THIS node (see addRunUsage).
      // The model rides along so the run's cost can be priced.
      let usage;
      if (out.usage) {
        usage = addRunUsage(runCtx, { ...out.usage, model: out.usage.model || nodeCfg.model || "" });
      }
      record(node, "success", inputItems, logItems, null, performance.now() - t0, {
        handleCounts: Object.fromEntries(Object.entries(out.byHandle).map(([h, list]) => [h, (list || []).length])),
        ...(filesWritten.length ? { filesWritten } : {}),
        ...(usage ? { usage } : {}),
      });
      }
    }

    // Stopped mid-run: record the current node but do not fan out to anything
    // downstream of it (an aborted run never schedules new nodes).
    if (runCtx.signal?.aborted) continue;

    for (const edge of outEdges.get(id) || []) {
      const handle = edge.sourceHandle || "out";
      const branchItems = out.byHandle[handle] || [];
      // A downstream node only runs when its upstream actually produced items
      // for it. This keeps the next node from executing before (or without)
      // its input — an untaken branch (e.g. IF false when the condition is
      // true) has no items, so its downstream never runs.
      if (!branchItems.length) continue;
      const targetId = edge.target;
      const prev = itemsByNode.get(targetId);
      // Tag each item with the node that produced it so a downstream node can
      // restrict its input to a specific upstream node ("inputFromNode").
      const tagged = branchItems.map((it) => ({ ...it, _src: id }));
      itemsByNode.set(targetId, { out: [...(prev?.out || []), ...tagged] });
      if (!visited.has(targetId)) {
        visited.add(targetId);
        queue.push(targetId);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  return {
    workflowId: workflow.id,
    startedAt,
    finishedAt,
    durationMs: Math.round(performance.now() - perfStart),
    log,
    consoleLog: ctxLog.logLines,
    // A run counts as successful when only *handled* errors happened (a node
    // with "Continue" on error) — those are visible in the log and in
    // errorCount, but they did not stop the automation.
    success: log.every((l) => l.status === "success" || l.handled === true),
    nodeCount: workflow.nodes.length,
    errorCount: log.filter((l) => l.status === "error").length,
    handledErrors: log.filter((l) => l.status === "error" && l.handled === true).length,
    // The payload this run was started with — stored with the execution so a
    // past run can be replayed with exactly the same input.
    input: runCtx.runInput ?? null,
    // Token usage across every AI call in this run (null when none ran).
    usage: runCtx.aiUsage ? { ...runCtx.aiUsage } : null,
    // Set when a Webhook Respond node ran — used by the /webhook handler to
    // return that node's message as the HTTP response.
    webhookResponse: runCtx.webhookResponse || undefined,
    // The IDs of nodes that errored; chains are halted so downstream nodes do
    // not run after an upstream failure.
    haltedAt: (() => {
      const e = log.find((l) => l.status === "error");
      return e ? e.nodeId : undefined;
    })(),
    // True when the editor asked this run to stop (Stop button) — the run was
    // halted deliberately after the node that was in flight, not by an error.
    aborted: !!runCtx.signal?.aborted,
  };
}
