// ============================================================================
// W FLOW — team admin of a self-hosted copy
//
// On a copy the licence decides who is in charge (server/license.js). The
// instance owner — the account that set the copy up, the same one Setup
// accepts — is its admin: they choose the server, the database and where runs
// execute for everybody (Setup), and here they run the team:
//
//   seats        a Pro licence covers 1 account, a Team licence as many as
//                were bought; registration stops when the copy is full
//   restricted   members the admin limits to the shared credential pool:
//                they cannot add their own credentials, variables or
//                connected accounts, and their runs only see the pool
//   pool         credentials, connected accounts and variables of the admin
//                that every member may use without ever seeing the secret
//   data flows   every outside address a member's runs fetched from or sent
//                to (recorded per account and workflow), plus an allow-list:
//                with one set, restricted members can only reach those hosts
//
// None of this exists in the cloud — there every team account is plain Pro.
// Everything lives in the settings store of the copy itself; nothing leaves it.
//
// How the allow-list is enforced: the copy wraps the global fetch once at
// start (installOutboundGuard). Every node, AI provider and service call made
// during a run goes through fetch inside that run's AsyncLocalStorage context
// (server/run-context.js), so the wrapper knows whose run it is. Protocols
// that do not use fetch (SMTP, SQL drivers, Telegram MTProto) are recorded by
// neither — the admin limits those by not sharing their credentials.
// ============================================================================
import { db } from "./dbx.js";
import { attachCode } from "../shared/errors.js";
import { licenseRequired, licenseSeats, licenseStatus } from "./license.js";

const SETTINGS_KEY = "teamadmin.settings";
const FLOWS_KEY = "teamadmin.flows";
const FLUSH_MS = 30_000;
const MAX_HOSTS_PER_USER = 200;

// ---- settings ----

const EMPTY = { restricted: {}, pool: { credentials: [], variables: [] }, allowedHosts: [] };
let cache = null;

export async function teamSettings() {
  if (cache) return cache;
  try {
    const raw = JSON.parse((await db.storeGet(SETTINGS_KEY)) || "null") || {};
    cache = {
      restricted: raw.restricted && typeof raw.restricted === "object" ? raw.restricted : {},
      pool: {
        credentials: Array.isArray(raw.pool?.credentials) ? raw.pool.credentials : [],
        variables: Array.isArray(raw.pool?.variables) ? raw.pool.variables : [],
      },
      allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts : [],
    };
  } catch {
    cache = structuredClone(EMPTY);
  }
  return cache;
}

async function saveSettings(next) {
  cache = next;
  await db.storeSet(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** Test hook. */
export function resetTeamAdminCache() {
  cache = null;
}

/** "api.example.com", "*.example.com" — lower-case, no scheme / path / port. */
export function normalizeHost(raw) {
  let h = String(raw || "").trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.+$/, "");
  return /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h) ? h : "";
}

export function hostAllowed(host, allowed) {
  const h = String(host || "").toLowerCase();
  return allowed.some((a) => (a.startsWith("*.") ? h === a.slice(2) || h.endsWith(a.slice(1)) : h === a));
}

// ---- who is who ----

/** The copy's admin: the account that set it up (oldest), as setupAllowed sees it. */
export async function instanceOwnerId() {
  try {
    const users = await db.listUsers();
    const list = Array.isArray(users) ? users : [];
    const admin = list.find((u) => String(u.role || "") === "admin");
    return String((admin || list[list.length - 1])?.id || "");
  } catch {
    return "";
  }
}

export async function isRestricted(userId) {
  if (!licenseRequired() || !userId) return false;
  const s = await teamSettings();
  return !!s.restricted[String(userId)];
}

// ---- seats ----

/** Can one more account register on this copy? → { ok, seats, used } */
export async function seatAvailable() {
  if (!licenseRequired()) return { ok: true, seats: 0, used: 0 };
  const seats = await licenseSeats();
  const used = Number(await db.countUsers()) || 0;
  // The very first account (the owner) can always be created, even before the
  // licence was checked — it is the account that pastes the licence key.
  return { ok: used === 0 || used < seats, seats, used };
}

// ---- the credential pool ----

/**
 * Whose copy of credential `id` a run of `userId` reads. Members use their own
 * credentials (unless restricted) and any the admin pooled; a restricted
 * member gets a clear error for anything outside the pool.
 */
export async function credentialOwner(id, userId) {
  if (!licenseRequired()) return String(userId);
  const s = await teamSettings();
  const pooled = s.pool.credentials.find((p) => String(p.id) === String(id));
  if (await isRestricted(userId)) {
    if (!pooled) {
      throw attachCode(new Error("Your team admin limits you to the shared credentials — pick one of those on this node."), "MISSING_CONFIG");
    }
    return String(pooled.ownerId);
  }
  const own = await db.credentialGet(String(id), String(userId));
  if (own || !pooled) return String(userId);
  return String(pooled.ownerId);
}

/**
 * The connection list a picker shows: the account's own (hidden when
 * restricted) plus the pooled ones of the right kind, tagged `shared`.
 */
export async function withPooledCredentials(userId, own, matches, view) {
  if (!licenseRequired()) return own;
  const s = await teamSettings();
  const restricted = await isRestricted(userId);
  const mine = restricted ? [] : own;
  const seen = new Set(mine.map((c) => String(c.id)));
  const shared = [];
  for (const p of s.pool.credentials) {
    if (seen.has(String(p.id)) || String(p.ownerId) === String(userId)) continue;
    const cred = await db.credentialGet(String(p.id), String(p.ownerId));
    if (cred && matches(cred)) shared.push({ ...view(cred), shared: true });
  }
  return [...mine, ...shared];
}

/** Variables a run sees: the pooled ones under the account's own (only the pool when restricted). */
export async function withPooledVariables(userId, own) {
  if (!licenseRequired()) return own;
  const s = await teamSettings();
  const pooled = {};
  for (const p of s.pool.variables) {
    const v = await db.variableGet(String(p.id), String(p.ownerId));
    if (v) pooled[v.name] = v;
  }
  if (await isRestricted(userId)) return Object.values(pooled);
  const names = new Set(own.map((v) => v.name));
  return [...own, ...Object.values(pooled).filter((v) => !names.has(v.name))];
}

// Requests a restricted member may not make: anything that adds a credential,
// a variable or a connected account of their own.
const OWN_SECRET_ROUTES = [
  { method: "POST", re: /^\/api\/credentials\/?$/ },
  { method: "PUT", re: /^\/api\/credentials\/[^/]+$/ },
  { method: "POST", re: /^\/api\/variables\/?$/ },
  { method: "PUT", re: /^\/api\/variables\/[^/]+$/ },
  { method: "GET", re: /^\/api\/connections\/[^/]+\/start$/ },
  { method: "POST", re: /^\/api\/telegram\/(bots|accounts)(\/|$)/ },
];

/** Express middleware: keep restricted members on the pool. Runs after requireUser-style lookups. */
export function restrictedMemberGuard(currentUser) {
  return async (req, res, next) => {
    if (!licenseRequired()) return next();
    const path = req.originalUrl.split("?")[0];
    if (!OWN_SECRET_ROUTES.some((r) => r.method === req.method && r.re.test(path))) return next();
    const user = await currentUser(req);
    if (!user || !(await isRestricted(user.userId))) return next();
    res.status(403).json({ error: "Your team admin limits you to the shared credentials — ask them to add what you need to the pool." });
  };
}

// ---- data flows ----

// userId → host → { get, send, lastAt, workflows: { id: name } } (unflushed)
let pending = new Map();
let flushTimer = null;
let installed = false;

function record(ownerId, host, method, workflow) {
  if (!ownerId || !host) return;
  const byHost = pending.get(ownerId) || new Map();
  const rec = byHost.get(host) || { get: 0, send: 0, lastAt: 0, workflows: {} };
  if (/^(GET|HEAD|OPTIONS)$/i.test(method || "GET")) rec.get++;
  else rec.send++;
  rec.lastAt = Date.now();
  if (workflow?.id) rec.workflows[workflow.id] = String(workflow.name || workflow.id).slice(0, 120);
  byHost.set(host, rec);
  pending.set(ownerId, byHost);
}

export async function flushFlows() {
  if (!pending.size) return;
  const batch = pending;
  pending = new Map();
  let all = {};
  try {
    all = JSON.parse((await db.storeGet(FLOWS_KEY)) || "{}") || {};
  } catch {
    all = {};
  }
  for (const [owner, byHost] of batch) {
    const mine = all[owner] || {};
    for (const [host, rec] of byHost) {
      const prev = mine[host] || { get: 0, send: 0, lastAt: 0, workflows: {} };
      mine[host] = {
        get: prev.get + rec.get,
        send: prev.send + rec.send,
        lastAt: Math.max(prev.lastAt, rec.lastAt),
        workflows: { ...prev.workflows, ...rec.workflows },
      };
    }
    // keep the most recent hosts only
    const hosts = Object.entries(mine).sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, MAX_HOSTS_PER_USER);
    all[owner] = Object.fromEntries(hosts);
  }
  await db.storeSet(FLOWS_KEY, JSON.stringify(all));
}

export async function readFlows() {
  await flushFlows();
  try {
    return JSON.parse((await db.storeGet(FLOWS_KEY)) || "{}") || {};
  } catch {
    return {};
  }
}

/**
 * Wrap the global fetch once (copies only): record where every run sends or
 * fetches data, and stop restricted members at hosts off the allow-list.
 */
export function installOutboundGuard(currentRunContext) {
  if (installed || !licenseRequired()) return;
  installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    const run = currentRunContext();
    const ownerId = run?.ai?.ownerId || run?.filesOwner || "";
    if (ownerId) {
      let host = "";
      let method = init?.method || (typeof input === "object" && input?.method) || "GET";
      try {
        host = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).hostname.toLowerCase();
      } catch {
        host = "";
      }
      if (host) {
        const s = await teamSettings();
        if (s.allowedHosts.length && s.restricted[String(ownerId)] && !hostAllowed(host, s.allowedHosts)) {
          throw attachCode(new Error(`Your team admin does not allow this workflow to reach ${host}.`), "HOST_NOT_ALLOWED");
        }
        record(String(ownerId), host, String(method).toUpperCase(), run?.ai?.workflow);
      }
    }
    return realFetch(input, init);
  };
  flushTimer = setInterval(() => flushFlows().catch(() => {}), FLUSH_MS);
  flushTimer.unref?.();
}

// ---- the admin page ----

/** Everything the Team page shows the admin. */
export async function teamOverview() {
  const s = await teamSettings();
  const status = await licenseStatus();
  const ownerId = await instanceOwnerId();
  const users = (await db.listUsers()) || [];
  const flows = await readFlows();
  const members = users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name || "",
    createdAt: u.created_at,
    lastLogin: u.last_login || null,
    status: u.status || "active",
    owner: String(u.id) === ownerId,
    restricted: !!s.restricted[String(u.id)],
    flows: Object.entries(flows[u.id] || {})
      .map(([host, r]) => ({ host, get: r.get, send: r.send, lastAt: r.lastAt, workflows: Object.entries(r.workflows || {}).map(([id, name]) => ({ id, name })), allowed: !s.allowedHosts.length || hostAllowed(host, s.allowedHosts) }))
      .sort((a, b) => b.lastAt - a.lastAt),
  }));
  const ownCreds = ownerId ? (await db.credentialsList(ownerId)) || [] : [];
  const ownVars = ownerId ? (await db.variablesList(ownerId)) || [] : [];
  const pooledCred = new Set(s.pool.credentials.map((p) => String(p.id)));
  const pooledVar = new Set(s.pool.variables.map((p) => String(p.id)));
  return {
    plan: status.plan || "pro",
    seats: status.seats || 1,
    used: users.length,
    members,
    allowedHosts: s.allowedHosts,
    // names and kinds only — the admin page never shows a secret
    credentials: ownCreds.map((c) => ({ id: c.id, name: c.name, type: c.type, pooled: pooledCred.has(String(c.id)) })),
    variables: ownVars.map((v) => ({ id: v.id, name: v.name, secret: !!v.secret, pooled: pooledVar.has(String(v.id)) })),
  };
}

/** Apply a change from the Team page. Only the admin's own credentials can be pooled. */
export async function updateTeamSettings(patch = {}) {
  const s = structuredClone(await teamSettings());
  const ownerId = await instanceOwnerId();
  if (patch.restrict && typeof patch.restrict === "object") {
    for (const [userId, on] of Object.entries(patch.restrict)) {
      if (String(userId) === ownerId) continue; // the admin is never restricted
      if (on) s.restricted[String(userId)] = true;
      else delete s.restricted[String(userId)];
    }
  }
  if (Array.isArray(patch.poolCredentials)) {
    const own = new Set(((await db.credentialsList(ownerId)) || []).map((c) => String(c.id)));
    s.pool.credentials = [...new Set(patch.poolCredentials.map(String))].filter((id) => own.has(id)).map((id) => ({ id, ownerId }));
  }
  if (Array.isArray(patch.poolVariables)) {
    const own = new Set(((await db.variablesList(ownerId)) || []).map((v) => String(v.id)));
    s.pool.variables = [...new Set(patch.poolVariables.map(String))].filter((id) => own.has(id)).map((id) => ({ id, ownerId }));
  }
  if (Array.isArray(patch.allowedHosts)) {
    const hosts = patch.allowedHosts.map(normalizeHost);
    const bad = patch.allowedHosts.find((h, i) => String(h || "").trim() && !hosts[i]);
    if (bad) return { ok: false, error: `“${bad}” is not a host name (example: api.openai.com or *.google.com).` };
    s.allowedHosts = [...new Set(hosts.filter(Boolean))].slice(0, 500);
  }
  await saveSettings(s);
  return { ok: true };
}
