// ============================================================================
// W FLOW — workflows as tools for AI assistants (Model Context Protocol)
//
// POST /mcp speaks MCP's Streamable HTTP transport (JSON-RPC 2.0, plain JSON
// responses). Two kinds of tools live here:
//
//   workflow tools — every workflow whose owner switched "Offer as an AI tool"
//     on becomes one tool. Its arguments become the run's input, exactly like a
//     webhook body; without hand-typed inputs the tool asks for what the
//     trigger expects (shared/tool-inputs.js). Inputs can be typed (number,
//     yes/no, a fixed list, required) and the answer comes back as text AND as
//     structured JSON.
//
//   builder tools (wflow_*) — read the workflow reference and the node
//     catalog, list / read / validate / create / update / run workflows and
//     fetch a run's result. With them an assistant (Claude Code, Cursor, …)
//     builds W flow workflows directly. Saves go through the same functions as
//     the editor (server/index.js createWorkflowForUser / updateWorkflowForUser).
//
// Access is a named token (Settings → AI tools), sent as "Authorization:
// Bearer …". Only a SHA-256 digest is stored; the token is shown once. Each
// token has an access level — "run" (the offered workflow tools only), "read"
// (+ the read-only builder tools) or "build" (+ create, update and run any
// workflow) — a workflow scope (all, or a chosen list) and an optional number
// of runs per day. Tool runs also count toward the free-plan daily run cap.
//
// A run that takes longer than a few seconds is not waited for: the call
// answers with a run id and the assistant fetches the result with
// wflow_get_run. Every call is recorded in Executions (source "mcp") with the
// tool, the token's name, the arguments and the answer.
// ============================================================================
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { db } from "./dbx.js";
import { workflows, hydrateSecretsInWorkflow, stripSecretsFromWorkflow, collectSecrets } from "./store.js";
import { executeRouted } from "./runner.js";
import { recordExecution } from "./executions.js";
import { runQuota } from "./quota.js";
import { toolInputsFor } from "../shared/tool-inputs.js";
import { CATALOG, NODES } from "../shared/catalog.js";
import { outputDocFor, outputHandlesFor } from "../shared/node-outputs.js";
import { validateWorkflow } from "../shared/workflow-validate.js";
import { buildWorkflowFormatDoc, buildExamplesDoc, buildToolsDoc, buildCatalogDoc } from "./workflow-docs.js";
import { normalizeWorkflow } from "./workflow-agent.js";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_PARAMS = 20;
const MAX_TOKENS_PER_USER = 10;
const PARAM_TYPES = new Set(["string", "number", "boolean", "enum"]);
export const ACCESS_LEVELS = ["run", "read", "build"];
// How long a call waits for its run before answering with a run id.
const DEFAULT_WAIT_MS = Math.max(1, Number(process.env.BF_MCP_WAIT_SECONDS || 25)) * 1000;
const MAX_WAIT_MS = 55_000;
const RUN_TTL_MS = 60 * 60_000;
const MAX_ANSWER_CHARS = 20_000;

const digest = (token) => createHash("sha256").update(String(token)).digest("hex");
const tokenKey = (d) => `mcp.token.${d}`;
const userKey = (userId) => `mcp.user.${userId}`;
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const runsKey = (tokenId, day) => `mcp.runs.${tokenId}.${day}`;

// ---- settings on the workflow ----
/**
 * { enabled, description, params, outputs } — params are the inputs the AI is
 * told about (anything else it sends is passed on too); outputs optionally
 * describe the answer's fields, which then become the tool's outputSchema.
 */
export function normalizeMcpSettings(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = { enabled: !!raw.enabled, description: String(raw.description || "").slice(0, 1000), params: cleanParams(raw.params) };
  const outputs = cleanFields(raw.outputs, false);
  if (outputs.length) out.outputs = outputs;
  return out;
}

// Only non-default keys are stored, so an untyped input stays { name, description }.
function cleanFields(list, isInput) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((p) => {
      const name = String(p?.name || "").trim().replace(/[^\w-]/g, "_").slice(0, 64);
      const field = { name, description: String(p?.description || "").slice(0, 300) };
      const type = PARAM_TYPES.has(p?.type) ? p.type : "string";
      if (!isInput && type === "enum") return field;
      if (type !== "string") field.type = type;
      if (isInput && p?.required) field.required = true;
      if (isInput && type === "enum") {
        field.options = (Array.isArray(p?.options) ? p.options : String(p?.options || "").split(","))
          .map((o) => String(o).trim())
          .filter(Boolean)
          .slice(0, 50);
      }
      const example = String(p?.example ?? "").trim().slice(0, 200);
      if (isInput && example) field.example = example;
      return field;
    })
    .filter((p) => p.name && !seen.has(p.name) && seen.add(p.name))
    .slice(0, MAX_PARAMS);
}
const cleanParams = (list) => cleanFields(list, true);

// ---- tokens ----
function cleanScope(raw = {}) {
  const access = ACCESS_LEVELS.includes(raw.access) ? raw.access : "run";
  const ids = Array.isArray(raw.workflows) ? [...new Set(raw.workflows.map(String).filter(Boolean))].slice(0, 200) : null;
  const dailyRuns = Math.max(0, Math.min(100_000, Math.floor(Number(raw.dailyRuns) || 0)));
  return { access, workflows: ids && ids.length ? ids : "all", dailyRuns };
}

async function readTokens(userId) {
  let raw;
  try {
    raw = await db.storeGet(userKey(userId));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    // One token from before named tokens existed: it could only run the
    // offered tools, so it keeps exactly that.
    if (parsed?.digest) return [{ id: "default", name: "Default", digest: parsed.digest, hint: parsed.hint, createdAt: parsed.createdAt, access: "run", workflows: "all", dailyRuns: 0 }];
  } catch {
    /* unreadable — treat as none */
  }
  return [];
}

const writeTokens = (userId, list) => db.storeSet(userKey(userId), list.length ? JSON.stringify(list) : "");

/** Public view of a token (no digest). */
const tokenView = (t) => ({ id: t.id, name: t.name, hint: t.hint, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null, access: t.access, workflows: t.workflows, dailyRuns: t.dailyRuns || 0 });

/** Create a named token. Returns the secret once plus its public view. */
export async function createMcpToken(userId, opts = {}) {
  const list = await readTokens(userId);
  if (list.length >= MAX_TOKENS_PER_USER) throw new Error(`An account can have up to ${MAX_TOKENS_PER_USER} AI-tools tokens — revoke one first.`);
  const token = `wfmcp_${randomBytes(24).toString("base64url")}`;
  const d = digest(token);
  const record = {
    id: randomUUID().slice(0, 12),
    name: String(opts.name || "").trim().slice(0, 60) || `Token ${list.length + 1}`,
    digest: d,
    hint: token.slice(-4),
    createdAt: new Date().toISOString(),
    ...cleanScope(opts),
  };
  await db.storeSet(tokenKey(d), JSON.stringify({ userId: String(userId), tokenId: record.id }));
  await writeTokens(userId, [...list, record]);
  return { token, info: tokenView(record) };
}

/** Change a token's name, access, scope or run limit (never its secret). */
export async function updateMcpToken(userId, tokenId, patch = {}) {
  const list = await readTokens(userId);
  const t = list.find((x) => x.id === tokenId);
  if (!t) return null;
  if (patch.name !== undefined) t.name = String(patch.name || "").trim().slice(0, 60) || t.name;
  Object.assign(t, cleanScope({ access: patch.access ?? t.access, workflows: patch.workflows ?? t.workflows, dailyRuns: patch.dailyRuns ?? t.dailyRuns }));
  await writeTokens(userId, list);
  return tokenView(t);
}

/** Revoke one token, or every token of the account when `tokenId` is omitted. */
export async function revokeMcpToken(userId, tokenId) {
  const list = await readTokens(userId);
  const gone = tokenId ? list.filter((t) => t.id === tokenId) : list;
  for (const t of gone) await db.storeSet(tokenKey(t.digest), "");
  await writeTokens(userId, tokenId ? list.filter((t) => t.id !== tokenId) : []);
  return gone.length;
}

export async function mcpTokens(userId) {
  return (await readTokens(userId)).map(tokenView);
}

/** The first token (kept for callers from before named tokens). */
export async function mcpTokenInfo(userId) {
  const [first] = await readTokens(userId);
  return first ? { ...tokenView(first), digest: first.digest } : null;
}

export async function userForToken(token) {
  if (!token) return null;
  const raw = await db.storeGet(tokenKey(digest(token)));
  if (!raw) return null;
  let userId = raw;
  let tokenId = "default";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") ({ userId, tokenId } = parsed);
  } catch {
    /* a bare user id — a token from before named tokens */
  }
  const user = await db.getUserById(userId);
  if (!user || (user.status && user.status !== "active")) return null;
  const list = await readTokens(userId);
  const record = list.find((t) => t.id === tokenId);
  if (!record) return null;
  // Remember when it was last used — at most once a minute per token.
  if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > 60_000) {
    record.lastUsedAt = new Date().toISOString();
    // SQLite writes are synchronous and Postgres ones async — wrap both, and
    // never let a bookkeeping write fail the call.
    Promise.resolve()
      .then(() => writeTokens(userId, list))
      .catch(() => {});
  }
  return { userId: String(userId), email: user.email || "", token: record };
}

// ---- what a token may do ----
// Callers without a token record (tests, internal use) get the narrowest level.
const tokenOf = (user) => user?.token || { id: "internal", name: "internal", access: "run", workflows: "all", dailyRuns: 0 };
const canRead = (user) => ["read", "build"].includes(tokenOf(user).access);
const canBuild = (user) => tokenOf(user).access === "build";
const inScope = (user, workflowId) => {
  const scope = tokenOf(user).workflows;
  return scope === "all" || (Array.isArray(scope) && scope.includes(String(workflowId)));
};

/** Count one run against the token's own daily limit. Returns an error text when it is used up. */
async function takeTokenRun(user) {
  const t = tokenOf(user);
  if (!t.dailyRuns) return null;
  const key = runsKey(t.id, today());
  const used = Number(await db.storeGet(key)) || 0;
  if (used >= t.dailyRuns) return `The token "${t.name}" used all ${t.dailyRuns} runs it may start today. It resets at midnight (UTC).`;
  await db.storeSet(key, String(used + 1));
  return null;
}

// ---- workflow tools ----
/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ and stay unique per account. */
export function toolNameFor(wf) {
  const slug = String(wf.name || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "workflow";
  return `${slug}_${String(wf.id).replace(/[^a-zA-Z0-9]/g, "").slice(-8)}`;
}

function paramSchema(p) {
  const s = { description: p.description || p.name };
  if (p.type === "number") s.type = "number";
  else if (p.type === "boolean") s.type = "boolean";
  else if (p.type === "enum" && Array.isArray(p.options) && p.options.length) Object.assign(s, { type: "string", enum: p.options });
  else s.type = "string";
  if (p.example) s.examples = [p.type === "number" && Number.isFinite(Number(p.example)) ? Number(p.example) : p.example];
  return s;
}

export function toolFor(wf) {
  // Hand-typed inputs, else the ones the trigger expects (shared/tool-inputs.js).
  const { params } = toolInputsFor(wf);
  const required = params.filter((p) => p.required).map((p) => p.name);
  const tool = {
    name: toolNameFor(wf),
    title: wf.name || "Workflow",
    description: wf.mcp?.description || wf.description || `Runs the W flow workflow “${wf.name || wf.id}”.`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(params.map((p) => [p.name, paramSchema(p)])),
      ...(required.length ? { required } : {}),
      additionalProperties: true,
    },
  };
  const outputs = wf.mcp?.outputs || [];
  if (outputs.length) {
    tool.outputSchema = {
      type: "object",
      properties: Object.fromEntries(outputs.map((o) => [o.name, { type: o.type === "enum" ? "string" : o.type || "string", description: o.description || o.name }])),
      additionalProperties: true,
    };
  }
  return tool;
}

export async function listToolWorkflows(userId) {
  return (await workflows.listOwned(userId)).filter((wf) => wf.mcp?.enabled);
}

/** The answer's value: the Webhook Respond body, else the last node's item(s). */
function answerValue(result) {
  if (result?.webhookResponse !== undefined && result.webhookResponse !== null) {
    const body = result.webhookResponse.body ?? result.webhookResponse;
    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    return body;
  }
  const done = (result?.log || []).filter((l) => l.status === "success");
  // The log copies carry the editor's file bookkeeping — not part of the answer.
  const items = (done[done.length - 1]?.outputItems || []).map((it) => {
    if (!it || typeof it !== "object" || !("filesWritten" in it)) return it;
    const { filesWritten: _files, ...rest } = it;
    return rest;
  });
  return items.length === 1 ? items[0] : items;
}

/** What a tool call answers with, as text. */
export function toolOutput(result) {
  const value = answerValue(result);
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** MCP's structuredContent must be an object — wrap lists and plain text. */
function structured(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return { items: value };
  return { text: value === undefined || value === null ? "" : String(value) };
}

// Arguments that belong to a declared input are coerced to its type, so a
// "3" sent for a number input arrives as 3 and "yes" for a yes/no input as true.
function coerceArgs(params, args) {
  const out = { ...args };
  for (const p of params) {
    if (!(p.name in out)) continue;
    const v = out[p.name];
    if (p.type === "number" && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) out[p.name] = Number(v);
    if (p.type === "boolean" && typeof v === "string") out[p.name] = /^(true|yes|1|on)$/i.test(v.trim());
  }
  return out;
}

/** Arguments renamed back to the trigger's own field names ("full_name" → "full name"). */
export function triggerArgs(wf, args) {
  const out = { ...args };
  for (const p of toolInputsFor(wf).params) {
    if (p.field && p.field !== p.name && p.name in out) {
      out[p.field] = out[p.name];
      delete out[p.name];
    }
  }
  return out;
}

function missingRequired(params, args) {
  return params.filter((p) => p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === "")).map((p) => p.name);
}

// ---- runs (sync when quick, a run id when not) ----
// runId → { userId, tokenId, workflowId, workflowName, status, startedAt, answer, isError, finishedAt }
const runs = new Map();

function sweepRuns(now = Date.now()) {
  for (const [id, r] of runs) if (r.finishedAt && now - Date.parse(r.finishedAt) > RUN_TTL_MS) runs.delete(id);
}

function runView(id, r) {
  if (r.status === "running") {
    return {
      content: [{ type: "text", text: `Still running (run_id ${id}, started ${r.startedAt}). Call wflow_get_run with this run_id to get the result.` }],
      structuredContent: { status: "running", run_id: id, workflow_id: r.workflowId, started_at: r.startedAt },
    };
  }
  return { ...r.answer, ...(r.isError ? { isError: true } : {}) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `wf` with `input` for a tool call. Answers within `waitMs` when the run
 * is that quick, otherwise with a run id; the run carries on either way and is
 * recorded in Executions with the call's details.
 */
async function startRun(user, wf, input, { tool, waitMs = DEFAULT_WAIT_MS }) {
  sweepRuns();
  const id = randomUUID();
  const record = { userId: user.userId, tokenId: tokenOf(user).id, workflowId: wf.id, workflowName: wf.name, status: "running", startedAt: new Date().toISOString() };
  runs.set(id, record);
  const full = hydrateSecretsInWorkflow(wf, await db.getWorkflowSecrets(wf.id));
  const done = executeRouted(full, { source: "mcp", triggerPayload: input, webhookPayload: input, runInput: input, maxItemsPerNode: 20, userId: user.userId })
    .then(async (result) => {
      const failure = (result.log || []).find((l) => l.status === "error" && !l.handled);
      const value = answerValue(result);
      const text = failure ? `The workflow failed at “${failure.nodeName}”: ${failure.error}` : typeof value === "string" ? value : JSON.stringify(value, null, 2);
      record.answer = failure
        ? { content: [{ type: "text", text }], structuredContent: { status: "error", run_id: id, error: text, node: failure.nodeName } }
        : { content: [{ type: "text", text }], structuredContent: structured(value) };
      record.isError = !!failure;
      // Executions shows who called what with which arguments and what came back.
      result.aiTool = { tool, token: tokenOf(user).name, arguments: input, answer: text.slice(0, MAX_ANSWER_CHARS), isError: !!failure, runId: id };
      await recordExecution(wf, result, "mcp");
    })
    .catch((err) => {
      const text = `The workflow could not run: ${String(err?.message || err)}`;
      record.answer = { content: [{ type: "text", text }], structuredContent: { status: "error", run_id: id, error: text } };
      record.isError = true;
    })
    .finally(() => {
      record.status = "done";
      record.finishedAt = new Date().toISOString();
    });
  await Promise.race([done, sleep(Math.max(0, Math.min(MAX_WAIT_MS, waitMs)))]);
  return runView(id, record);
}

async function guardRun(user) {
  const quota = await runQuota(user.userId);
  if (!quota.allowed) return `The W flow account used all ${quota.limit} runs allowed today on the free plan.`;
  const tokenLimit = await takeTokenRun(user);
  if (tokenLimit) return tokenLimit;
  if (quota.limit !== null) await db.bumpRunUsage(user.userId);
  return null;
}

const toolError = (text) => ({ isError: true, content: [{ type: "text", text }] });

async function callWorkflowTool(user, name, args) {
  const wf = (await listToolWorkflows(user.userId)).find((w) => toolNameFor(w) === name && inScope(user, w.id));
  if (!wf) return toolError(`No workflow tool named "${name}". It may have been renamed, switched off, or be outside this token's scope.`);
  const { params } = toolInputsFor(wf);
  const input = coerceArgs(params, args && typeof args === "object" ? args : {});
  const missing = missingRequired(params, input);
  if (missing.length) return toolError(`Missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
  const blocked = await guardRun(user);
  if (blocked) return toolError(blocked);
  return startRun(user, wf, triggerArgs(wf, input), { tool: name });
}

// ---- builder tools ----
// Injected by server/index.js (mountMcpRoutes) so saves follow the editor's rules.
let deps = {
  createWorkflow: null, // (userId, body) → { status, json }
  updateWorkflow: null, // (userId, id, body, opts) → { status, json }
  workflowUrl: async () => "",
};
export function configureMcp(next) {
  deps = { ...deps, ...next };
}

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value && typeof value === "object" && !Array.isArray(value) ? value : { items: value } });

async function ownedWorkflow(user, id) {
  const wf = await workflows.get(String(id || ""));
  if (!wf || String(wf.ownerId) !== String(user.userId) || !inScope(user, wf.id)) return null;
  return wf;
}

/** Put secret values the assistant never saw (they read as "") back from the saved copy. */
function keepSecrets(incoming, existingHydrated) {
  const byId = new Map((existingHydrated.nodes || []).map((n) => [n.id, n]));
  for (const s of collectSecrets(existingHydrated)) {
    const node = (incoming.nodes || []).find((n) => n.id === s.nodeId);
    if (!node || node.type !== byId.get(s.nodeId)?.type) continue;
    const parts = s.field.split(".");
    let cur = (node.data = node.data || {}).config = node.data.config || {};
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== "object") cur = null;
      else cur = cur[parts[i]];
      if (!cur) break;
    }
    const last = parts[parts.length - 1];
    if (cur && (cur[last] === undefined || cur[last] === "")) cur[last] = s.value;
  }
  return incoming;
}

function catalogLines(query, category) {
  const q = String(query || "").trim().toLowerCase();
  const cat = String(category || "").trim().toLowerCase();
  const out = [];
  for (const group of CATALOG.groups) {
    if (cat && !group.label.toLowerCase().includes(cat) && group.id !== cat) continue;
    for (const type of group.nodes) {
      const def = NODES[type];
      if (!def) continue;
      const hay = `${type} ${def.name} ${def.description}`.toLowerCase();
      if (q && !q.split(/\s+/).every((w) => hay.includes(w))) continue;
      out.push({ type, name: def.name, kind: def.kind, group: group.label, description: def.description });
    }
  }
  return out;
}

const WORKFLOW_ARG = {
  type: "object",
  description: "The workflow: { name, description, nodes: [ { id, type, position: {x,y}, data: { label, config } } ], edges: [ { source, target, sourceHandle, targetHandle: \"in\" } ] }. Call wflow_reference first.",
  properties: { name: { type: "string" }, description: { type: "string" }, nodes: { type: "array", items: { type: "object" } }, edges: { type: "array", items: { type: "object" } } },
  required: ["nodes"],
};

const BUILDER_TOOLS = [
  {
    level: "read",
    name: "wflow_reference",
    title: "W flow workflow reference",
    description: "READ THIS FIRST before writing or changing a workflow. How a workflow JSON is written, how data moves between nodes, the {{placeholder}} rules, complete examples and the AI Agent tools. section: \"guide\" (default: format + rules + examples), \"catalog\" (every node type with fields and outputs — large; prefer wflow_list_node_types / wflow_get_node_type) or \"all\".",
    inputSchema: { type: "object", properties: { section: { type: "string", enum: ["guide", "catalog", "all"] } } },
    run: async (_user, a) => {
      const guide = `# Workflow JSON and engine rules\n\n${buildWorkflowFormatDoc()}\n\n# Worked examples\n\n${buildExamplesDoc()}\n\n# AI Agent tools\n\n${buildToolsDoc()}`;
      const text = a.section === "catalog" ? buildCatalogDoc() : a.section === "all" ? `${guide}\n\n# Node catalog\n\n${buildCatalogDoc()}` : guide;
      return { content: [{ type: "text", text }] };
    },
  },
  {
    level: "read",
    name: "wflow_list_node_types",
    title: "Find node types",
    description: "Search the node catalog (~470 types: triggers, actions, logic, AI, files, feeds, integrations). query: words that must all appear in the type, name or description (e.g. \"google sheets\", \"telegram send\"); category: a group name such as Triggers, Logic, AI. Returns up to 60 matches.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, category: { type: "string" } } },
    run: async (_user, a) => {
      const all = catalogLines(a.query, a.category);
      return json({ total: all.length, shown: Math.min(all.length, 60), node_types: all.slice(0, 60) });
    },
  },
  {
    level: "read",
    name: "wflow_get_node_type",
    title: "Node type details",
    description: "Everything about one node type: its settings (keys, types, allowed values, defaults, help), what it outputs (the fields the next node can use in {{placeholders}}) and its output handles.",
    inputSchema: { type: "object", properties: { type: { type: "string", description: "e.g. \"slackSend\", \"if\", \"aiChat\"" } }, required: ["type"] },
    run: async (_user, a) => {
      const def = NODES[String(a.type || "")];
      if (!def) {
        const close = catalogLines(a.type).slice(0, 8).map((n) => n.type);
        return toolError(`Unknown node type "${a.type}".${close.length ? ` Did you mean: ${close.join(", ")}?` : " Use wflow_list_node_types to search."}`);
      }
      const fields = (def.fields || [])
        .filter((f) => f.type !== "note")
        .map((f) => ({
          key: f.key,
          type: f.type,
          label: f.label,
          ...(Array.isArray(f.options) && f.options.length ? { options: f.options.map((o) => (typeof o === "string" ? o : o.value)) } : {}),
          ...(f.optional ? { optional: true } : {}),
          ...(f.help ? { help: f.help } : {}),
          ...(f.visibleWhen ? { onlyWhen: f.visibleWhen } : {}),
        }));
      return json({
        type: def.type,
        name: def.name,
        kind: def.kind,
        description: def.description,
        fields,
        defaults: def.defaults,
        output: outputDocFor(def.type, def),
        handles: def.type === "switch" || def.type === "router" ? `one per row: "case-0", "case-1", … plus "${def.type === "switch" ? "default" : "fallback"}"` : outputHandlesFor({ type: def.type }, def),
      });
    },
  },
  {
    level: "read",
    name: "wflow_list_workflows",
    title: "List workflows",
    description: "The workflows this token can see: id, name, description, node count, last change, whether it is offered as a tool, and its link in the editor.",
    inputSchema: { type: "object", properties: {} },
    run: async (user) => {
      const list = (await workflows.listOwned(user.userId)).filter((wf) => inScope(user, wf.id));
      const urls = await Promise.all(list.map((wf) => deps.workflowUrl(wf.id)));
      return json({
        workflows: list.map((wf, i) => ({
          id: wf.id,
          name: wf.name,
          description: wf.description || "",
          nodes: (wf.nodes || []).length,
          updated_at: wf.updatedAt || null,
          offered_as_tool: !!wf.mcp?.enabled,
          url: urls[i],
        })),
      });
    },
  },
  {
    level: "read",
    name: "wflow_get_workflow",
    title: "Read a workflow",
    description: "One workflow as JSON (name, description, nodes, edges) plus the validator's findings. Credentials are blanked (\"\"); leave them \"\" when you update — the saved values are kept.",
    inputSchema: { type: "object", properties: { workflow_id: { type: "string" } }, required: ["workflow_id"] },
    run: async (user, a) => {
      const wf = await ownedWorkflow(user, a.workflow_id);
      if (!wf) return toolError(`No workflow "${a.workflow_id}" for this token. Use wflow_list_workflows.`);
      const check = validateWorkflow(wf, { nodes: NODES });
      const clean = stripSecretsFromWorkflow(wf);
      return json({
        workflow: { id: wf.id, name: wf.name, description: wf.description || "", nodes: clean.nodes || [], edges: clean.edges || [] },
        url: await deps.workflowUrl(wf.id),
        errors: check.errors,
        warnings: check.warnings,
      });
    },
  },
  {
    level: "read",
    name: "wflow_validate_workflow",
    title: "Check a workflow",
    description: "Check a workflow JSON without saving it: unknown node types, broken edges, wrong branch handles, unknown settings, invalid values, {{placeholders}} nothing before the node outputs. Fix every error before saving.",
    inputSchema: { type: "object", properties: { workflow: WORKFLOW_ARG }, required: ["workflow"] },
    run: async (_user, a) => {
      const check = validateWorkflow(a.workflow, { nodes: NODES });
      return json({ ok: check.ok, errors: check.errors, warnings: check.warnings });
    },
  },
  {
    level: "build",
    name: "wflow_create_workflow",
    title: "Create a workflow",
    description: "Save a new workflow in the user's account and return its id and editor link. Unknown node types and broken edges are dropped (and reported). Validate first with wflow_validate_workflow.",
    inputSchema: { type: "object", properties: { workflow: WORKFLOW_ARG }, required: ["workflow"] },
    run: async (user, a) => {
      if (tokenOf(user).workflows !== "all") return toolError("This token is limited to chosen workflows, so it cannot create new ones.");
      if (!deps.createWorkflow) return toolError("Creating workflows is not available on this server.");
      const check = validateWorkflow(a.workflow, { nodes: NODES });
      const { workflow: next, warnings } = normalizeWorkflow(a.workflow || {}, { fallbackName: "Workflow from AI assistant" });
      const r = await deps.createWorkflow(user.userId, { name: next.name, description: next.description, nodes: next.nodes, edges: next.edges });
      if (r.status !== 200) return toolError(r.json?.error || `Saving failed (${r.status}).`);
      return json({ workflow_id: r.json.id, url: await deps.workflowUrl(r.json.id), dropped: warnings, errors: check.errors, warnings: check.warnings });
    },
  },
  {
    level: "build",
    name: "wflow_update_workflow",
    title: "Change a workflow",
    description: "Replace a workflow's name, description, nodes and edges with the given JSON (send the COMPLETE workflow, not a patch — read it with wflow_get_workflow first). Credentials left \"\" keep their saved values. The previous state stays in the workflow's version history.",
    inputSchema: { type: "object", properties: { workflow_id: { type: "string" }, workflow: WORKFLOW_ARG }, required: ["workflow_id", "workflow"] },
    run: async (user, a) => {
      const existing = await ownedWorkflow(user, a.workflow_id);
      if (!existing) return toolError(`No workflow "${a.workflow_id}" for this token.`);
      if (!deps.updateWorkflow) return toolError("Changing workflows is not available on this server.");
      const check = validateWorkflow(a.workflow, { nodes: NODES });
      const { workflow: next, warnings } = normalizeWorkflow(a.workflow || {}, { fallbackName: existing.name, fallbackDescription: existing.description });
      const hydrated = hydrateSecretsInWorkflow(existing, await db.getWorkflowSecrets(existing.id));
      const merged = keepSecrets({ nodes: next.nodes, edges: next.edges }, hydrated);
      const r = await deps.updateWorkflow(user.userId, existing.id, { name: next.name, description: next.description, nodes: merged.nodes, edges: merged.edges }, { versionReason: "ai-tool" });
      if (r.status !== 200) return toolError(r.json?.error || `Saving failed (${r.status}).`);
      return json({ workflow_id: existing.id, url: await deps.workflowUrl(existing.id), dropped: warnings, errors: check.errors, warnings: check.warnings });
    },
  },
  {
    level: "build",
    name: "wflow_run_workflow",
    title: "Run a workflow",
    description: "Run any workflow of this token's scope with an input (it arrives as the trigger's payload, like a webhook body). Waits up to wait_seconds (default 25, max 55); a longer run answers with a run_id — fetch the result with wflow_get_run.",
    inputSchema: {
      type: "object",
      properties: { workflow_id: { type: "string" }, input: { type: "object", additionalProperties: true }, wait_seconds: { type: "number" } },
      required: ["workflow_id"],
    },
    run: async (user, a) => {
      const wf = await ownedWorkflow(user, a.workflow_id);
      if (!wf) return toolError(`No workflow "${a.workflow_id}" for this token.`);
      const blocked = await guardRun(user);
      if (blocked) return toolError(blocked);
      const waitMs = a.wait_seconds === undefined ? DEFAULT_WAIT_MS : Number(a.wait_seconds) * 1000;
      return startRun(user, wf, a.input && typeof a.input === "object" ? a.input : {}, { tool: "wflow_run_workflow", waitMs });
    },
  },
  {
    level: "run",
    name: "wflow_get_run",
    title: "Get a run's result",
    description: "The result of a run that answered with a run_id (still running, or its answer). wait_seconds (default 0, max 55) waits for it to finish first.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" }, wait_seconds: { type: "number" } }, required: ["run_id"] },
    run: async (user, a) => {
      sweepRuns();
      const r = runs.get(String(a.run_id || ""));
      if (!r || r.userId !== user.userId) return toolError(`No run "${a.run_id}" — runs are kept for an hour after they finish; older ones are in the Executions page.`);
      const until = Date.now() + Math.max(0, Math.min(MAX_WAIT_MS, Number(a.wait_seconds || 0) * 1000));
      while (r.status === "running" && Date.now() < until) await sleep(250);
      return runView(String(a.run_id), r);
    },
  },
];

const LEVEL_RANK = { run: 0, read: 1, build: 2 };
const builderToolsFor = (user) => BUILDER_TOOLS.filter((t) => LEVEL_RANK[tokenOf(user).access] >= LEVEL_RANK[t.level]);

async function listTools(user) {
  const offered = (await listToolWorkflows(user.userId)).filter((wf) => inScope(user, wf.id)).map(toolFor);
  const builder = builderToolsFor(user).map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
  return [...offered, ...builder];
}

async function callTool(user, name, args) {
  const builder = BUILDER_TOOLS.find((t) => t.name === name);
  if (builder) {
    if (LEVEL_RANK[tokenOf(user).access] < LEVEL_RANK[builder.level]) {
      return toolError(`The token "${tokenOf(user).name}" is not allowed to use ${name} — give it "${builder.level}" access under Settings → AI tools.`);
    }
    return builder.run(user, args && typeof args === "object" ? args : {});
  }
  return callWorkflowTool(user, name, args);
}

// ---- JSON-RPC ----
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const INSTRUCTIONS = `Tools named wflow_* read and build W flow workflows: call wflow_reference first, look up node types with wflow_list_node_types / wflow_get_node_type, check with wflow_validate_workflow, then save with wflow_create_workflow or wflow_update_workflow (always the complete workflow). Every other tool runs one of the user's workflows with its arguments as input. A run that takes long answers with a run_id — fetch it with wflow_get_run.`;

export async function handleRpc(user, msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "w-flow", title: "W flow workflows", version: "2.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: await listTools(user) });
    case "tools/call": {
      if (!msg.params?.name) return rpcError(msg.id, -32602, "Missing tool name");
      try {
        return reply(await callTool(user, String(msg.params.name), msg.params.arguments));
      } catch (err) {
        return reply(toolError(`The tool failed: ${String(err?.message || err)}`));
      }
    }
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return isNotification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---- discovery without a token ----
// MCP directories (Smithery, MCP.so, …) and clients probe a server before the
// user has entered a token: they shake hands and list the tools. Those answers
// hold nothing private — only the builder tools' descriptions, never a user's
// own workflow tools — so they are served without a token. Calling a tool
// still needs one.
const PUBLIC_METHODS = new Set(["initialize", "ping", "tools/list"]);
export const isPublicRpc = (msg) =>
  !!msg && typeof msg.method === "string" && (PUBLIC_METHODS.has(msg.method) || msg.method.startsWith("notifications/"));

export async function handleAnonymousRpc(msg) {
  if (msg?.method === "tools/list") {
    const isNotification = msg.id === undefined || msg.id === null;
    const tools = BUILDER_TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
    return isNotification ? null : { jsonrpc: "2.0", id: msg.id, result: { tools } };
  }
  return handleRpc(null, msg);
}

// ---- routes ----
export function mountMcpRoutes(app, { requireUser, publicUrl = () => "", createWorkflow, updateWorkflow, workflowUrl, rateLimit = () => false }) {
  configureMcp({ createWorkflow, updateWorkflow, ...(workflowUrl ? { workflowUrl } : {}) });

  app.post("/mcp", async (req, res) => {
    if (rateLimit(req)) return res.status(429).json(rpcError(null, -32000, "Too many requests — try again in a minute."));
    const auth = String(req.headers.authorization || "");
    const sent = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const user = await userForToken(sent);
    const body = req.body;
    const messages = Array.isArray(body) ? body : [body];
    // Only a request with NO token is anonymous: a wrong or revoked token is
    // refused outright, so a client set up with it learns so at once.
    if (!user && (sent || !messages.every(isPublicRpc))) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="w-flow"');
      return res.status(401).json(rpcError(null, -32001, "Missing or invalid W flow AI-tools token (Settings → AI tools)."));
    }
    const replies = [];
    for (const msg of messages) {
      const r = user ? await handleRpc(user, msg) : await handleAnonymousRpc(msg);
      if (r) replies.push(r);
    }
    if (!replies.length) return res.status(202).end();
    res.json(Array.isArray(body) ? replies : replies[0]);
  });
  // No server-to-client stream: clients fall back to plain request/response.
  app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Use POST for MCP requests." }));
  // Static server card for directories that read metadata instead of
  // connecting (Smithery: /.well-known/mcp/server-card.json). Same content
  // as the token-less tools/list — builder tools only, never a user's own.
  app.get(["/.well-known/mcp/server-card.json", "/.well-known/mcp.json"], (_req, res) =>
    res.json({
      serverInfo: { name: "w-flow", title: "W flow workflows", version: "2.0.0" },
      description: "Build, validate and run W flow automation workflows (470+ nodes) from an AI assistant.",
      authentication: { required: true, schemes: ["bearer"] },
      tools: BUILDER_TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
      resources: [],
      prompts: [],
    })
  );
  // Sign-in is a token, not OAuth. Clients look for OAuth metadata first and
  // used to get the web app's HTML page here, which they read as a broken
  // OAuth server; a JSON 404 tells them there is none.
  app.get(/^\/\.well-known\/oauth-(protected-resource|authorization-server)(\/.*)?$/, (_req, res) =>
    res.status(404).json({ error: "not_supported", error_description: "W flow's MCP server uses a bearer token from Settings → AI tools, not OAuth." })
  );

  app.get("/api/mcp", requireUser, async (req, res) => {
    const tokens = await mcpTokens(req.user.userId);
    const tools = await listToolWorkflows(req.user.userId);
    res.json({
      endpoint: `${publicUrl(req).replace(/\/+$/, "")}/mcp`,
      // kept for older clients of this endpoint
      token: tokens[0] ? { createdAt: tokens[0].createdAt, hint: tokens[0].hint } : null,
      tokens,
      tools: tools.map((wf) => ({ workflowId: wf.id, workflowName: wf.name, name: toolNameFor(wf) })),
      builderTools: BUILDER_TOOLS.map((t) => ({ name: t.name, title: t.title, level: t.level })),
    });
  });
  app.post("/api/mcp/token", requireUser, async (req, res) => {
    try {
      const { token, info } = await createMcpToken(req.user.userId, req.body || {});
      res.json({ token, info });
    } catch (err) {
      res.status(400).json({ error: String(err?.message || err) });
    }
  });
  app.put("/api/mcp/token/:id", requireUser, async (req, res) => {
    const info = await updateMcpToken(req.user.userId, req.params.id, req.body || {});
    if (!info) return res.status(404).json({ error: "Token not found." });
    res.json({ info });
  });
  app.delete("/api/mcp/token/:id", requireUser, async (req, res) => {
    res.json({ ok: (await revokeMcpToken(req.user.userId, req.params.id)) > 0 });
  });
  // Revoke every token (the old single-token "Revoke" button).
  app.delete("/api/mcp/token", requireUser, async (req, res) => {
    await revokeMcpToken(req.user.userId);
    res.json({ ok: true });
  });
}
