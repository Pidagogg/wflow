// ============================================================================
// W FLOW — checking a workflow JSON before it is loaded or saved
//
// One validator for every place a workflow arrives as text: the AI builder's
// answer (server/workflow-agent.js retries once with these issues), the JSON
// editor (underlines them as you type) and the MCP `validate_workflow` tool.
// It never changes the workflow — it only reports.
//
//   errors   — the workflow will not load or a part of it can never run:
//              unknown node type, duplicate id, an edge to nowhere, a branch
//              handle the node does not have, a {{placeholder}} the template
//              engine cannot parse.
//   warnings — it loads, but probably does not do what was meant: a config
//              key the node ignores, a select value it does not know, a JSON
//              setting that is not JSON, a {{field}} nothing before this node
//              outputs, a node the trigger never reaches.
//
// Every issue carries `path` (a JSON path such as nodes[2].data.config.url) so
// an editor can point at the exact line.
//
// The catalog is passed in (`nodes`: type → definition) because the browser
// gets it from /api/nodes instead of bundling shared/catalog.js.
// ============================================================================
import { outputDocFor, outputHandlesFor } from "./node-outputs.js";
import { samplePayloadFor } from "./samples.js";

// Keys every node may carry besides its own fields: the error handling the
// editor adds, the input filter, fixed test output and connected accounts.
const COMMON_KEYS = new Set([
  "onError", "retryCount", "retryDelay",
  "inputMode", "inputField", "inputFromNode", "inputFile", "inputFileField",
  "manualOutput", "manualOutputJson",
  "oauthAccount", "sendAs",
]);

// What the template engine accepts between {{ }} (server/executor.js renderTemplate).
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const VALID_PATH = /^\s*[\w.$]+\s*$/;

// Triggers whose real event looks exactly like their sample; every other
// trigger's real payload can carry more fields than the sample shows.
const EXACT_TRIGGERS = new Set(["schedule", "formTrigger", "chatTrigger"]);

// ---- helpers ----
const issue = (severity, path, message, extra = {}) => ({ severity, path, message, ...extra });

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepKeys(value, out = new Set(), depth = 0) {
  if (depth > 6 || !value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    if (!Array.isArray(value)) out.add(k);
    deepKeys(v, out, depth + 1);
  }
  return out;
}

/**
 * The field names in an output description (shared/node-outputs.js):
 * "+ reply, usage { prompt, … }" → reply, usage, prompt. Prose, quoted
 * defaults, <placeholders> and (asides) are skipped.
 */
function outputFields(doc) {
  const cleaned = String(doc || "")
    .split(" — ")[0]
    .replace(/\([^)]*\)/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/<[^>]*>/g, "");
  const out = new Set();
  for (const m of cleaned.matchAll(/(?:^|[{,+=]\s*)([A-Za-z_$][\w$]*)(?=\s*(?:[,:}[{]|$))/g)) out.add(m[1]);
  return out;
}

/** Every string inside `value`, with its JSON path below `base`. */
function strings(value, base, out = []) {
  if (typeof value === "string") out.push([base, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${base}[${i}]`, out));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) strings(v, `${base}.${k}`, out);
  return out;
}

function optionValues(field) {
  if (!Array.isArray(field.options) || !field.options.length) return null;
  return field.options.map((o) => (typeof o === "string" ? o : o?.value)).filter((v) => v !== undefined);
}

// ---- what a node puts on its items (for the {{field}} check) ----
// { fields: Set of names a placeholder can start with, open: true when the
// item may hold fields nobody can know in advance (an API response, code
// output, a webhook body) — then no placeholder is reported as missing }.
function nodeShape(node, def, input) {
  const type = node.type;
  const c = node.data?.config || {};
  const doc = outputDocFor(type, def);
  const named = new Set(
    [c.storeIn, c.outputField, c.fieldName, c.groupBy, c.field]
      .concat((Array.isArray(c.fields) ? c.fields : []).map((r) => r?.key))
      .concat((Array.isArray(c.operations) ? c.operations : []).map((r) => r?.field))
      .filter((v) => typeof v === "string" && v)
      .map((v) => v.split(".")[0])
  );
  if (def?.kind === "trigger") {
    let sample = null;
    try {
      sample = samplePayloadFor({ type, data: { config: { ...(def.defaults || {}), ...c } } }, {});
    } catch {
      /* no sample */
    }
    return { fields: deepKeys(sample), open: !EXACT_TRIGGERS.has(type) };
  }
  const tokens = outputFields(doc);
  const openDoc = /response|returns|result|content|parsed|rows|records|results|documents|files|items|object|data/i.test(doc);
  if (doc.startsWith("=")) return { fields: new Set([...tokens, ...named]), open: openDoc || type === "code" || type === "jsTransform" };
  if (doc.startsWith("+")) return { fields: new Set([...input.fields, ...tokens, ...named]), open: input.open || openDoc || !!c.storeIn };
  // pass-through nodes (IF, Filter, Merge, …) — plus whatever they add (loop, approval)
  return { fields: new Set([...input.fields, ...tokens, ...named]), open: input.open };
}

// ---- the fields an item carries when it reaches a node ----
function shapeTracker(byId, inEdges, catalog) {
  const isTrigger = (n) => catalog[n?.type]?.kind === "trigger";
  const shapes = new Map();
  const inputShape = (id, stack = new Set([id])) => {
    const list = inEdges.get(id) || [];
    const node = byId.get(id)?.node;
    if (!list.length) return { fields: new Set(isTrigger(node) ? [] : ["triggeredAt"]), open: false };
    const fields = new Set();
    let open = false;
    for (const { from } of list) {
      const s = shapeOf(from, stack);
      s.fields.forEach((f) => fields.add(f));
      open = open || s.open;
    }
    return { fields, open };
  };
  const shapeOf = (id, stack) => {
    if (shapes.has(id)) return shapes.get(id);
    if (stack.has(id)) return { fields: new Set(), open: true }; // a cycle — give up quietly
    stack.add(id);
    const entry = byId.get(id);
    const shape = entry && catalog[entry.node.type] ? nodeShape(entry.node, catalog[entry.node.type], inputShape(id, stack)) : { fields: new Set(), open: true };
    stack.delete(id);
    shapes.set(id, shape);
    return shape;
  };
  return { inputShape };
}

/**
 * The field names a {{placeholder}} in node `nodeId` can start with, from the
 * graph alone (no run needed): { fields: string[], open } — `open` means an
 * upstream node can add fields nobody knows in advance (an API response).
 * Used by the JSON editor's autocomplete.
 */
export function fieldsBefore(wf, nodeId, { nodes: catalog = {} } = {}) {
  const byId = new Map();
  (Array.isArray(wf?.nodes) ? wf.nodes : []).forEach((n, index) => {
    if (isPlainObject(n) && n.id !== undefined && !byId.has(String(n.id))) byId.set(String(n.id), { node: n, index });
  });
  const inEdges = new Map();
  for (const e of Array.isArray(wf?.edges) ? wf.edges : []) {
    if (!isPlainObject(e) || !byId.has(String(e.source)) || !byId.has(String(e.target))) continue;
    const t = String(e.target);
    if (!inEdges.has(t)) inEdges.set(t, []);
    inEdges.get(t).push({ from: String(e.source), handle: e.sourceHandle || "out" });
  }
  if (!byId.has(String(nodeId))) return { fields: [], open: true };
  const { fields, open } = shapeTracker(byId, inEdges, catalog).inputShape(String(nodeId));
  return { fields: [...fields].filter((f) => /^[A-Za-z_$][\w$]*$/.test(f)).sort(), open };
}

// ---- the validator ----
/**
 * validateWorkflow(workflow, { nodes }) → { ok, errors: Issue[], warnings: Issue[] }
 * Issue: { severity, path, message, nodeId?, edgeId? }
 */
export function validateWorkflow(wf, { nodes: catalog = {} } = {}) {
  const errors = [];
  const warnings = [];
  const add = (i) => (i.severity === "error" ? errors : warnings).push(i);

  if (!isPlainObject(wf)) {
    add(issue("error", "", "A workflow must be a JSON object with \"nodes\" and \"edges\"."));
    return { ok: false, errors, warnings };
  }
  if (!Array.isArray(wf.nodes)) add(issue("error", "nodes", "\"nodes\" must be an array."));
  if (wf.edges !== undefined && !Array.isArray(wf.edges)) add(issue("error", "edges", "\"edges\" must be an array."));
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const edges = Array.isArray(wf.edges) ? wf.edges : [];

  // -- nodes --
  const byId = new Map();
  nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!isPlainObject(n)) return add(issue("error", at, "A node must be an object."));
    const id = typeof n.id === "string" || typeof n.id === "number" ? String(n.id) : "";
    if (!id) add(issue("error", `${at}.id`, "The node has no id."));
    else if (byId.has(id)) add(issue("error", `${at}.id`, `Duplicate node id "${id}" — every id must be unique.`, { nodeId: id }));
    else byId.set(id, { node: n, index: i });
    const def = catalog[n.type];
    if (!n.type) add(issue("error", `${at}.type`, "The node has no type.", { nodeId: id }));
    else if (!def) add(issue("error", `${at}.type`, `Unknown node type "${n.type}".`, { nodeId: id }));
    if (!isPlainObject(n.position) || !Number.isFinite(Number(n.position.x)) || !Number.isFinite(Number(n.position.y))) {
      add(issue("warning", `${at}.position`, "position should be { x, y } numbers — the editor places the node itself otherwise.", { nodeId: id }));
    }
    const config = n.data?.config;
    if (config !== undefined && !isPlainObject(config)) add(issue("error", `${at}.data.config`, "data.config must be an object.", { nodeId: id }));
    if (!def || !isPlainObject(config)) return;

    // config keys and values
    const fields = new Map((def.fields || []).map((f) => [f.key, f]));
    for (const [key, value] of Object.entries(config)) {
      const kp = `${at}.data.config.${key}`;
      const field = fields.get(key);
      if (!field && !COMMON_KEYS.has(key) && !(key in (def.defaults || {}))) {
        add(issue("warning", kp, `"${key}" is not a setting of ${def.name} — it is ignored.`, { nodeId: id }));
        continue;
      }
      if (!field) continue;
      const opts = optionValues(field);
      if (opts && typeof value === "string" && value && !value.includes("{{") && !opts.includes(value)) {
        add(issue("warning", kp, `"${value}" is not an option of ${field.label || key} (${opts.slice(0, 8).join(", ")}).`, { nodeId: id }));
      }
      if (field.type === "json" && typeof value === "string" && value.trim()) {
        // Placeholders inside JSON strings are fine; a bare {{x}} is not JSON.
        const probe = value.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\{\{[^{}]*\}\}/g, "0");
        try {
          JSON.parse(probe);
        } catch {
          add(issue("warning", kp, `${field.label || key} is not valid JSON.`, { nodeId: id }));
        }
      }
    }
  });

  // -- edges --
  const inEdges = new Map();
  const seenEdges = new Set();
  edges.forEach((e, i) => {
    const at = `edges[${i}]`;
    if (!isPlainObject(e)) return add(issue("error", at, "An edge must be an object."));
    const edgeId = e.id ? String(e.id) : undefined;
    if (edgeId && seenEdges.has(edgeId)) add(issue("warning", `${at}.id`, `Duplicate edge id "${edgeId}".`, { edgeId }));
    if (edgeId) seenEdges.add(edgeId);
    const src = byId.get(String(e.source ?? ""));
    const tgt = byId.get(String(e.target ?? ""));
    if (!src) add(issue("error", `${at}.source`, `The edge starts at "${e.source}", which is not a node id.`, { edgeId }));
    if (!tgt) add(issue("error", `${at}.target`, `The edge ends at "${e.target}", which is not a node id.`, { edgeId }));
    if (!src || !tgt) return;
    if (src.node.type === "stickyNote" || tgt.node.type === "stickyNote") add(issue("warning", at, "Sticky notes are annotations — do not connect them.", { edgeId }));
    const handles = outputHandlesFor(src.node, catalog[src.node.type]);
    const handle = e.sourceHandle ? String(e.sourceHandle) : "out";
    if (!handles.length) add(issue("error", `${at}.source`, `${catalog[src.node.type]?.name || src.node.type} has no outputs — nothing can be connected out of it.`, { edgeId }));
    else if (!handles.includes(handle)) {
      add(issue("error", `${at}.sourceHandle`, `"${handle}" is not an output of "${src.node.data?.label || src.node.id}" — use ${handles.map((h) => `"${h}"`).join(", ")}.`, { edgeId }));
    }
    if (e.targetHandle !== undefined && e.targetHandle !== "in") add(issue("warning", `${at}.targetHandle`, "targetHandle is always \"in\".", { edgeId }));
    const id = String(e.target);
    if (!inEdges.has(id)) inEdges.set(id, []);
    inEdges.get(id).push({ from: String(e.source), handle });
  });

  // -- graph: triggers and reachability --
  const isTrigger = (n) => catalog[n.type]?.kind === "trigger";
  const steps = nodes.filter((n) => isPlainObject(n) && n.type !== "stickyNote" && catalog[n.type]);
  const triggers = steps.filter(isTrigger);
  if (steps.length && !triggers.length) add(issue("warning", "nodes", "There is no trigger — the workflow only runs when started by hand."));
  if (triggers.length) {
    for (const n of steps) {
      if (isTrigger(n) || inEdges.has(String(n.id))) continue;
      const at = `nodes[${byId.get(String(n.id))?.index}]`;
      add(issue("warning", at, `"${n.data?.label || n.id}" is not connected to anything before it — it starts on its own with an empty item instead of the trigger's data.`, { nodeId: String(n.id) }));
    }
  }

  // -- placeholders --
  const { inputShape } = shapeTracker(byId, inEdges, catalog);

  for (const [id, { node, index }] of byId) {
    const def = catalog[node.type];
    if (!def || !isPlainObject(node.data?.config) || node.type === "stickyNote") continue;
    const input = isTrigger(node) ? { fields: new Set(), open: true } : inputShape(id);
    for (const [path, text] of strings(node.data.config, `nodes[${index}].data.config`)) {
      for (const match of text.matchAll(PLACEHOLDER)) {
        const inner = match[1];
        if (!VALID_PATH.test(inner)) {
          add(issue("error", path, `{{${inner}}} is not a valid placeholder — only letters, digits, _, $ and dots are allowed (no spaces, brackets or expressions), so it stays in the text literally.`, { nodeId: id }));
          continue;
        }
        const first = inner.trim().split(".")[0];
        if (!first || first.startsWith("$") || first === "json" || /^\d+$/.test(first)) continue;
        if (!input.open && !input.fields.has(first)) {
          const known = [...input.fields].filter((f) => /^[a-z_]/i.test(f)).slice(0, 12);
          add(issue("warning", path, `{{${inner.trim()}}}: no step before "${node.data?.label || id}" outputs a field "${first}", so it renders empty.${known.length ? ` Available: ${known.join(", ")}.` : ""}`, { nodeId: id }));
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** The issues as short lines for a model or a log ("ERROR nodes[2].type: …"). */
export function formatIssues({ errors = [], warnings = [] }, limit = 40) {
  return [...errors, ...warnings].slice(0, limit).map((i) => `${i.severity.toUpperCase()} ${i.path || "(workflow)"}: ${i.message}`).join("\n");
}
