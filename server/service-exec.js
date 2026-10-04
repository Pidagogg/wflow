// ----------------------------------------------------------------------------
// W FLOW — external service executor
//
// Runs the service-integration nodes defined in shared/services.js. Each node
// carries a `service` descriptor (auth scheme, base URL, default endpoint and a
// request-body template); this module turns it into a real, authenticated HTTP
// request, classifies failures with the project's BF-… error codes and saves the
// parsed response under the node's `storeIn` field.
// ----------------------------------------------------------------------------
import { attachCode } from "../shared/errors.js";
import { createHash, createHmac } from "node:crypto";
import { resolveRunPath } from "./run-context.js";
import { resolvePath } from "../shared/paths.js";

const DEFAULT_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Template rendering — {{field.path}} is replaced from the incoming item.
// ---------------------------------------------------------------------------
const lookup = resolvePath;

function renderString(text, json) {
  return String(text).replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, path) => {
    const runValue = resolveRunPath(path);
    const val = runValue !== undefined ? runValue : lookup(json, path);
    if (val === undefined || val === null) return "";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });
}

export function renderDeep(value, json) {
  if (typeof value === "string") return renderString(value, json);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, json));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, json)]));
  }
  return value;
}

// What the request templates render against: the incoming item, with every
// filled Parameters field (shared/services.js applyParamFields) laid over its
// placeholder. Empty fields leave the item's own value in place.
function templateVars(spec, c, json) {
  if (!spec.params?.length) return json;
  const vars = { ...json };
  for (const { key, name } of spec.params) {
    const raw = c[key];
    if (raw === undefined || raw === null || raw === "") continue;
    vars[name] = renderString(String(raw), json);
  }
  return vars;
}

// A {{placeholder}} in the host or path that renders empty sends a broken URL
// (".atlassian.net", "/calendars//events") and the service answers a bare
// 400/404 that never says which value was missing. Name the field instead.
// Query-string placeholders may stay empty — many are optional filters.
function assertUrlPlaceholdersFilled(def, spec, base, path, vars) {
  const pathPart = String(path).split("?")[0];
  for (const m of `${base} ${pathPart}`.matchAll(/\{\{\s*([\w.$]+)\s*\}\}/g)) {
    if (renderString(m[0], vars) !== "") continue;
    const param = spec.params?.find((p) => p.name === m[1]);
    const label = def.fields?.find((f) => f.key === (param?.key ?? m[1]))?.label;
    const where = label ? `Fill the "${label}" field` : `Give the incoming item a "${m[1]}" field`;
    throw attachCode(new Error(`${def.name} needs a value for {{${m[1]}}}, which goes into the request URL. ${where}, or map it from an earlier node with {{field}}.`), "MISSING_CONFIG");
  }
}

function parseJsonField(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw attachCode(new Error(`Expected valid JSON but got: ${String(raw).slice(0, 120)}`), "INVALID_JSON");
  }
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  if (/^https?:\/\//i.test(p)) return p;
  return `${b}/${p.replace(/^\/+/, "")}`;
}

function serviceFromHost(host) {
  const first = String(host || "").split(".")[0].toLowerCase();
  if (first === "email") return "ses"; // Amazon SES endpoint
  return first || "service";
}

// ---------------------------------------------------------------------------
// AWS SigV4 signing (used by the AWS service nodes).
// ---------------------------------------------------------------------------
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function sigv4Headers({ method, url, headers, body, region, accessKey, secretKey }) {
  const u = new URL(url);
  const service = serviceFromHost(u.hostname);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? "");
  const signed = {
    ...headers,
    host: u.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const sortedKeys = Object.keys(signed)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(signed[k]).trim()}\n`).join("");
  const signedHeaders = sortedKeys.join(";");
  // Canonical query string (sorted, RFC 3986-encoded).
  const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalRequest = [method, u.pathname || "/", canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    ...signed,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return attachCode(new Error(`The service rejected the credentials (HTTP ${status}).`), "AUTH_FAILED");
  if (status === 429) return attachCode(new Error("The service rate-limited the request (HTTP 429). Try again shortly."), "RATE_LIMITED");
  return attachCode(new Error(`The service returned HTTP ${status}.`), "SERVICE_ERROR");
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") throw attachCode(new Error(`Request timed out after ${timeoutMs} ms.`), "HTTP_TIMEOUT");
    throw attachCode(new Error(String(err?.message || err)), "HTTP_REQUEST_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main entry — called by the executor's default branch for service nodes.
// ---------------------------------------------------------------------------
export async function runServiceNode(node, def, items, ctx, assertPublicHttpUrl) {
  const spec = def.service;
  const c = node.data?.config || {};
  // a connected account (server/executor.js withConnectedAccount) always
  // authenticates with Bearer, whatever header the pasted token would use
  const auth = c.__authBearer ? "bearer" : String(spec.auth || "bearer");
  const credKey = spec.credKey || "token";
  const out = [];

  // Credentials — validated once, before any network I/O.
  let token = String(c[credKey] ?? "").trim();
  if (auth === "aws") {
    const accessKey = String(c.accessKey ?? "").trim();
    const secretKey = String(c.secretKey ?? "").trim();
    if (!accessKey || !secretKey) {
      throw attachCode(new Error(`${def.name} needs an AWS access key id and secret access key.`), "MISSING_CONFIG");
    }
    token = `${accessKey}:${secretKey}`;
  } else if (auth !== "none" && !token) {
    throw attachCode(new Error(`${def.name} needs its credentials filled in (${def.fields?.[0]?.label || credKey}).`), "MISSING_CONFIG");
  }

  const timeoutMs = Number(c.timeout) > 0 ? Number(c.timeout) : DEFAULT_TIMEOUT_MS;

  for (const item of items) {
    const json = item.json || {};
    const vars = templateVars(spec, c, json);
    assertUrlPlaceholdersFilled(def, spec, String(c.baseUrl || spec.base || ""), String(c.path ?? spec.defaultPath ?? ""), vars);
    const base = renderString(String(c.baseUrl || spec.base || ""), vars);
    const path = renderString(String(c.path ?? spec.defaultPath ?? ""), vars);
    const method = String(c.method || spec.defaultMethod || "POST").toUpperCase();
    const url = new URL(joinUrl(base, path));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw attachCode(new Error(`Unsupported URL scheme '${url.protocol}' for ${def.name}.`), "HTTP_REQUEST_FAILED");
    }

    // Query params (from config, and the service's own auth param).
    const query = renderDeep(parseJsonField(c.query, {}), vars) || {};
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v == null ? "" : String(v));

    // Headers.
    const headers = { accept: "application/json", ...(renderDeep(parseJsonField(c.headers, {}), vars) || {}) };

    if (auth === "bearer") headers.authorization = `Bearer ${token}`;
    else if (auth.startsWith("header:")) headers[spec.auth.slice(7)] = token;
    else if (auth.startsWith("query:")) url.searchParams.set(spec.auth.slice(6), token);
    else if (auth === "basic") {
      const [user, pass = ""] = token.split(":");
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    }

    // Body (JSON by default; GET/HEAD carry none).
    const bodyTemplate = c.body !== "" && c.body !== undefined && c.body !== null ? c.body : spec.defaultBody;
    let bodyText;
    if (method !== "GET" && method !== "HEAD" && bodyTemplate) {
      const parsedBody = typeof bodyTemplate === "string" ? parseJsonField(bodyTemplate, {}) : bodyTemplate;
      bodyText = JSON.stringify(renderDeep(parsedBody, vars));
      headers["content-type"] = headers["content-type"] || "application/json";
    }

    if (auth === "aws") {
      const [accessKey, secretKey] = token.split(":");
      const signed = sigv4Headers({
        method,
        url: url.toString(),
        headers,
        body: bodyText,
        region: String(c.region || "us-east-1"),
        accessKey,
        secretKey,
      });
      Object.assign(headers, signed);
    }

    if (assertPublicHttpUrl) await assertPublicHttpUrl(url.toString());

    const res = await fetchWithTimeout(url.toString(), { method, headers, body: bodyText }, timeoutMs);
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep the raw text */
    }
    if (!res.ok) {
      const detail = typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed).slice(0, 300) : String(text).slice(0, 300);
      const err = classifyHttpStatus(res.status);
      err.message = `${err.message} ${detail}`.trim();
      throw err;
    }

    const storeIn = String(c.storeIn || "data");
    out.push({
      json: {
        ...json,
        [storeIn]: parsed,
        _service: { type: node.type, status: res.status, endpoint: `${method} ${url.pathname}`, at: new Date().toISOString() },
      },
    });
  }

  return { byHandle: { out } };
}
