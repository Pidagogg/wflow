// ----------------------------------------------------------------------------
// W FLOW — AI workflow builder (the "build it for me" agent)
//
// A user brings their OWN model credentials (provider + base URL + API key +
// model, stored encrypted per account — see /api/ai-builder in server/index.js).
// The agent then receives four inputs:
//
//   1. the user's prompt ("build a workflow that …"),
//   2. the workflow the user is currently editing, as JSON,
//   3. a reference document for the workflow JSON itself (buildWorkflowFormatDoc
//      — how a node, an edge, a handle and a {{placeholder}} are written), and
//   4. a generated reference document for every node type and every tool the
//      editor has (buildCatalogDoc / buildToolsDoc),
//
// and answers with the COMPLETE new workflow as JSON. The editor applies that
// JSON to the canvas automatically, so the result is a real, runnable workflow
// the user can keep editing by hand.
//
// Everything the model is allowed to emit is validated here before it reaches
// the canvas: unknown node types are dropped (and reported), ids are made
// unique, edges pointing nowhere are removed, and positions are filled in.
//
// The answer is then diffed against the workflow the user had (diffWorkflows)
// so the builder chat can show exactly what the agent committed — that list is
// computed from the two graphs instead of trusting the model to describe its
// own work.
// ----------------------------------------------------------------------------
import { NODES } from "../shared/catalog.js";
import { outputHandlesFor } from "../shared/node-outputs.js";
import { validateWorkflow, formatIssues } from "../shared/workflow-validate.js";
import { buildCatalogDoc, buildWorkflowFormatDoc, buildToolsDoc, buildExamplesDoc } from "./workflow-docs.js";
import { chatCompletion } from "./ai.js";

// The builder needs room to emit a whole workflow — the generic 1024-token
// default would truncate it. Users on very small models can still lower this.
const BUILDER_MAX_TOKENS = Number(process.env.BF_BUILDER_MAX_TOKENS || 8000);
const MAX_PROMPT_CHARS = 8000;
// Keep the current workflow inside the request even for very large graphs.
const MAX_WORKFLOW_CHARS = 240_000;

// The reference documents live in server/workflow-docs.js so the builder, the
// public /llms.txt and the MCP builder tools all read the same text.
export { buildCatalogDoc, buildWorkflowFormatDoc, buildToolsDoc, buildExamplesDoc };

// Build the catalog once — it is static, so providers can cache the prompt.
let cachedDoc = null;
function catalogDoc() {
  if (cachedDoc === null) cachedDoc = buildCatalogDoc();
  return cachedDoc;
}

export function buildSystemPrompt() {
  return `You are the W flow builder agent — an automation engineer who edits the workflow the user has open in a node-based (n8n-style) editor. The user describes in plain language what the workflow should do or what should change; you answer with the COMPLETE new workflow as JSON. The editor imports your JSON onto the canvas and saves it, and it diffs your answer against the workflow the user had a second ago — that diff is what the user is shown as your commit.

HOW YOUR ANSWER IS USED
- Your JSON REPLACES the workflow on the canvas, so it must always contain the whole graph, not a snippet or a patch.
- Anything you silently drop, rename, move or re-create shows up in the diff as a change the user did not ask for. Preserve what they did not mention.
- If the request is unclear, impossible with the available nodes, or you need a decision, return the workflow UNCHANGED and ask your question in "summary".

REPLY FORMAT — one JSON object, nothing else. No markdown fences, no text before or after.
{
  "summary": "1–2 sentences in the user's own language: what you changed and why (your commit message)",
  "workflow": {
    "name": "workflow name",
    "description": "optional short description",
    "nodes": [ /* NODE objects — see the JSON reference */ ],
    "edges": [ /* EDGE objects — see the JSON reference */ ]
  }
}
Every node needs id, type, position and data.label/data.config. Every edge needs source, target and sourceHandle, and both ends must exist.

WHAT TO DO EACH TURN
1. Read the workflow the user has now. If it is empty, build a new one from scratch; otherwise EDIT it.
2. Apply the user's request with the smallest change that really does it.
3. Keep ids, labels, positions and config of everything the user did not ask to change — byte for byte.
4. Re-check the graph before answering: exactly one trigger for a runnable workflow (unless they asked for more), every edge ends on a real id, every branch handle is one that node has, every required field has a value, no secrets invented.
5. Output valid JSON only — check every quote, comma and bracket.

RULES
1. Use ONLY node types from the NODE CATALOG. Never invent a node, a tool or a config key to satisfy a request.
2. Prefer the built-in logic nodes (IF, Filter, Switch, Set, Split Out, Merge, Summarize, Date & Time, Math …) over the Code node. Use Code only when nothing else fits.
3. Lay the graph out left to right: start near (80, 160) and add ~320 to x per step; for parallel branches increase y by ~160. Never stack two nodes on the same position, and leave the positions of existing nodes alone.
4. Reference data coming from an earlier node with {{field}} placeholders inside strings, using field paths the upstream node actually produces.
5. Never fill in credentials, API keys, tokens or passwords — secret fields stay "".
6. Keep the workflow runnable: a trigger to start it, a path from that trigger to every node that should run, and at least one node per branch that consumes a node's output.

WORKFLOW JSON REFERENCE
${buildWorkflowFormatDoc()}

WORKED EXAMPLES
${buildExamplesDoc()}

NODE CATALOG
${catalogDoc()}

TOOLS
${buildToolsDoc()}`;
}

// Did the provider reject `response_format`? Then the request itself was fine
// and retrying without it is worth a shot.
function jsonModeRejected(err) {
  const message = String(err?.message || "");
  return /response_format|json_object|json mode/i.test(message) || /\b(400|422)\b/.test(message);
}

// ----------------------------------------------------------------------------
// Reply → workflow JSON. Models sometimes wrap the object in prose or fences,
// so extract the outermost JSON object instead of trusting JSON.parse.
// ----------------------------------------------------------------------------
function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("The model returned an empty reply.");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch {
    /* fall through to brace scanning */
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model did not return a JSON object.");
  return JSON.parse(body.slice(start, end + 1));
}

// ----------------------------------------------------------------------------
// Validation / normalisation — the model's answer is untrusted input.
// ----------------------------------------------------------------------------
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Turn whatever the model produced into a workflow the canvas can load.
 * Unknown node types and dangling edges are dropped and reported back to the
 * user instead of silently corrupting the graph.
 */
export function normalizeWorkflow(candidate, { fallbackName, fallbackDescription } = {}) {
  const warnings = [];
  const rawNodes = Array.isArray(candidate?.nodes) ? candidate.nodes : [];
  if (!rawNodes.length) throw new Error("The model returned a workflow without any nodes.");

  const nodes = [];
  const knownIds = new Set();
  const unknownTypes = new Set();
  let autoX = 80;
  let autoY = 160;

  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") continue;
    const type = String(raw.type || "").trim();
    if (!type) continue;
    const def = NODES[type];
    if (!def) {
      unknownTypes.add(type);
      continue;
    }
    let id = String(raw.id || "").trim() || `n-${nodes.length + 1}`;
    while (knownIds.has(id)) id = `${id}-${nodes.length + 1}`;
    knownIds.add(id);

    const position =
      raw.position && Number.isFinite(Number(raw.position.x)) && Number.isFinite(Number(raw.position.y))
        ? { x: num(raw.position.x, autoX), y: num(raw.position.y, autoY) }
        : (() => {
            // No position supplied — lay the node out on a simple grid.
            const pos = { x: autoX, y: autoY };
            autoX += 300;
            if (autoX > 2000) {
              autoX = 80;
              autoY += 200;
            }
            return pos;
          })();

    const rawConfig = raw.data && typeof raw.data.config === "object" && raw.data.config !== null ? raw.data.config : {};
    const config = { inputMode: "auto", inputField: "", ...def.defaults, ...rawConfig };
    nodes.push({
      id,
      type,
      position,
      data: { label: String(raw.data?.label || def.name).slice(0, 120), config },
    });
  }

  if (unknownTypes.size) {
    warnings.push(`Dropped node type(s) this builder does not have: ${[...unknownTypes].join(", ")}.`);
  }
  if (!nodes.length) throw new Error("The model only returned node types this builder does not have.");

  const ids = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  const edgeKeys = new Set();
  for (const raw of Array.isArray(candidate?.edges) ? candidate.edges : []) {
    if (!raw || typeof raw !== "object") continue;
    const source = String(raw.source || "").trim();
    const target = String(raw.target || "").trim();
    if (!ids.has(source) || !ids.has(target) || source === target) continue;
    // A handle the source does not have would leave the branch unreachable —
    // fall back to the node's first output instead of dropping the connection.
    const src = byId.get(source);
    const outs = outputHandlesFor(src, NODES[src?.type]);
    if (!outs.length) continue; // a dead end (Stop and Error, Loop End) has nothing to connect
    let sourceHandle = raw.sourceHandle ? String(raw.sourceHandle) : outs[0];
    if (!outs.includes(sourceHandle)) sourceHandle = outs[0];
    const key = `${source}|${sourceHandle}|${target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      id: String(raw.id || `e-${edges.length + 1}`),
      source,
      target,
      sourceHandle,
      targetHandle: raw.targetHandle ? String(raw.targetHandle) : "in",
    });
  }

  const hasTrigger = nodes.some((n) => NODES[n.type]?.kind === "trigger");
  if (!hasTrigger) warnings.push("The result has no trigger node — add one so the workflow can be started.");

  const name = String(candidate?.name || fallbackName || "AI workflow").trim().slice(0, 120);
  const description = String(candidate?.description ?? fallbackDescription ?? "").slice(0, 400);
  return { workflow: { name, description, nodes, edges }, warnings };
}

// ----------------------------------------------------------------------------
// What the agent actually changed.
//
// The builder chat shows the user what the agent "committed". That list is
// computed here from the workflow the user had and the one the model returned,
// instead of being taken from the model's own description: it is exact, it can
// never claim a change the canvas does not show, and it is the same diff the
// editor applies.
// ----------------------------------------------------------------------------
const DIFF_LIMIT = 40;

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function nodeName(node) {
  return String(node?.data?.label || node?.type || node?.id || "node");
}

// Values the editor itself always fills in. A workflow saved before they existed
// must not look "changed" merely because normalizeWorkflow added the default back.
const EDITOR_CONFIG_DEFAULTS = { inputMode: "auto", inputField: "", inputFromNode: "" };

// Which config keys moved, ignoring the defaults normalizeWorkflow merges in:
// a key the user never set and the model never set is not a change.
function configKeysChanged(type, before, after) {
  const defaults = { ...EDITOR_CONFIG_DEFAULTS, ...(NODES[type]?.defaults || {}) };
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const key of keys) {
    const from = before?.[key];
    const to = after?.[key];
    if (same(from, to)) continue;
    if (from === undefined && same(to, defaults[key])) continue;
    changed.push(key);
  }
  return changed;
}

function edgeKey(edge) {
  return `${edge?.source}|${edge?.sourceHandle || "out"}|${edge?.target}`;
}

/**
 * Human-readable list of the differences between two workflow graphs.
 * Returns an empty array when nothing changed structurally.
 */
export function diffWorkflows(before, after) {
  const changes = [];
  const beforeNodes = new Map((Array.isArray(before?.nodes) ? before.nodes : []).map((n) => [String(n?.id), n]));
  const afterNodes = new Map((Array.isArray(after?.nodes) ? after.nodes : []).map((n) => [String(n?.id), n]));

  for (const [id, node] of afterNodes) {
    const old = beforeNodes.get(id);
    if (!old) {
      changes.push(`+ Added node "${nodeName(node)}" (${node.type})`);
      continue;
    }
    if (old.type !== node.type) {
      changes.push(`~ Replaced node "${nodeName(old)}" (${old.type}) with "${nodeName(node)}" (${node.type})`);
      continue;
    }
    const keys = configKeysChanged(node.type, old.data?.config, node.data?.config);
    const renamed = nodeName(old) !== nodeName(node);
    if (keys.length) {
      const shown = keys.slice(0, 3).join(", ");
      changes.push(`~ Updated node "${nodeName(node)}" — ${shown}${keys.length > 3 ? ` (+${keys.length - 3} more)` : ""}`);
    }
    if (renamed) changes.push(`~ Renamed node "${nodeName(old)}" → "${nodeName(node)}"`);
    const moved =
      Math.abs(num(old.position?.x, 0) - num(node.position?.x, 0)) > 1 || Math.abs(num(old.position?.y, 0) - num(node.position?.y, 0)) > 1;
    if (!keys.length && !renamed && moved) changes.push(`~ Moved node "${nodeName(node)}"`);
  }

  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) changes.push(`- Removed node "${nodeName(node)}" (${node.type})`);
  }

  const label = (map, nodeId, typeId) => {
    const node = map.get(String(nodeId)) || (typeId === "after" ? afterNodes.get(String(nodeId)) : beforeNodes.get(String(nodeId)));
    return node ? nodeName(node) : String(nodeId);
  };
  const beforeEdges = new Set((Array.isArray(before?.edges) ? before.edges : []).map(edgeKey));
  const afterEdges = new Set((Array.isArray(after?.edges) ? after.edges : []).map(edgeKey));
  for (const edge of Array.isArray(after?.edges) ? after.edges : []) {
    if (beforeEdges.has(edgeKey(edge))) continue;
    const handle = edge?.sourceHandle && edge.sourceHandle !== "out" ? ` (${edge.sourceHandle})` : "";
    changes.push(`+ Connected "${label(afterNodes, edge.source)}"${handle} → "${label(afterNodes, edge.target)}"`);
  }
  for (const edge of Array.isArray(before?.edges) ? before.edges : []) {
    if (afterEdges.has(edgeKey(edge))) continue;
    const handle = edge?.sourceHandle && edge.sourceHandle !== "out" ? ` (${edge.sourceHandle})` : "";
    changes.push(`- Disconnected "${label(beforeNodes, edge.source)}"${handle} → "${label(beforeNodes, edge.target)}"`);
  }

  if (String(before?.name || "") && String(before?.name) !== String(after?.name)) {
    changes.push(`~ Renamed the workflow "${before.name}" → "${after.name}"`);
  }
  if (String(before?.name || "") && String(before?.description || "") !== String(after?.description || "")) {
    changes.push("~ Updated the workflow description");
  }

  if (changes.length > DIFF_LIMIT) {
    const extra = changes.length - DIFF_LIMIT;
    return [...changes.slice(0, DIFF_LIMIT), `… and ${extra} more change(s)`];
  }
  return changes;
}

/**
 * Ask the user's own model for a new version of the workflow.
 *
 * @param {object} opts
 * @param {object} opts.settings  the account's model config (provider, baseUrl, apiKey, model)
 * @param {string} opts.prompt    the user's request
 * @param {object} opts.workflow  the workflow currently on the canvas (secrets already stripped)
 * @param {Array<{role:string,content:string}>} [opts.history] previous turns of this chat
 * @param {Array<{nodeId:string,label:string,type:string,config:object}>} [opts.references]
 *        nodes the user pinned in the editor as references for this request
 */
// Warnings the model can act on — not "there is no trigger" (which may be what
// the user wants) or a missing position (the editor lays nodes out itself).
const isFixable = (i) => /renders empty|not a setting|not an option|not valid JSON|not connected to anything/.test(i.message);
const issueWeight = (check) => check.errors.length * 3 + check.warnings.filter(isFixable).length;
const worthFixing = (check) => issueWeight(check) > 0;

function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (typeof v === "number") out[k] = (Number(out[k]) || 0) + v;
  return out;
}

export async function buildWorkflow({ settings, prompt, workflow, history = [], references = [] }) {
  const request = String(prompt || "").trim().slice(0, MAX_PROMPT_CHARS);
  if (!request) throw new Error("Describe the workflow you want the agent to build.");

  // Nodes the user pinned in the editor ("use this node as a reference"). They
  // are the steps the request is really about, so they are shown with their
  // exact current config and must be preserved unless the user asks otherwise.
  const refs = (Array.isArray(references) ? references : []).slice(0, 12);
  const refBlock = refs.length
    ? `\n\nNODES I PINNED AS A REFERENCE FOR THIS REQUEST (these are the steps I mean — keep each one's id, type, label and config exactly as shown unless my request explicitly changes it):\n${JSON.stringify(
        refs.map((r) => ({ id: r.nodeId, label: r.label, type: r.type, config: r.config || {} })),
        null,
        1
      )}`
    : "";

  const current = JSON.stringify(workflow || { nodes: [], edges: [] }, null, 1).slice(0, MAX_WORKFLOW_CHARS);
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    // Earlier turns of the builder chat, so follow-ups like "add an email step"
    // have context. They only ever carry the user's own words.
    ...history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
    {
      role: "user",
      content: `THE WORKFLOW I HAVE OPEN RIGHT NOW (JSON — this is the current state of my canvas):\n${current}\n\nMY REQUEST:\n${request}${refBlock}\n\nAnswer with the complete, updated workflow as JSON (and nothing else).`,
    },
  ];

  const request1 = { ...settings, temperature: 0.2, maxTokens: BUILDER_MAX_TOKENS };
  const wantsJsonMode = settings?.provider !== "anthropic";
  const ask = async (msgs) => {
    try {
      return await chatCompletion({ ...request1, jsonMode: wantsJsonMode }, msgs);
    } catch (err) {
      // Not every OpenAI-compatible server/proxy accepts `response_format`
      // (Ollama, some gateways and older endpoints answer 400). The prompt already
      // insists on JSON only, so one retry without the flag beats failing the turn.
      if (!wantsJsonMode || !jsonModeRejected(err)) throw err;
      return chatCompletion({ ...request1, jsonMode: false }, msgs);
    }
  };
  let res = await ask(messages);
  if (!res.text || !res.text.trim()) throw new Error("The model returned an empty reply.");

  let parsed;
  try {
    parsed = extractJsonObject(res.text);
  } catch (err) {
    // A half-written workflow (the model ran out of output tokens) lands here.
    throw new Error(
      `The model's answer was not usable JSON (${String(err.message || err)}). Try again, describe a smaller change, or raise BF_BUILDER_MAX_TOKENS if the answer looks cut off.`
    );
  }
  // Accept both { summary, workflow } and a bare workflow object.
  const unwrap = (obj) => (obj.workflow && typeof obj.workflow === "object" ? obj.workflow : obj);
  let candidate = unwrap(parsed);
  let usage = res.usage || null;

  // Self-check: the same validator the JSON editor uses. When the answer has
  // real problems (a broken edge, an unknown setting, a {{field}} nothing
  // produces) the model gets ONE more turn with the exact list — cheaper for
  // the user than finding the empty e-mail after the first run.
  let check = validateWorkflow(candidate, { nodes: NODES });
  let fixed = 0;
  if (worthFixing(check)) {
    const retry = [
      ...messages,
      { role: "assistant", content: res.text.slice(0, MAX_WORKFLOW_CHARS) },
      {
        role: "user",
        content: `The workflow you returned has these problems (found by the W flow validator):
${formatIssues(check)}

Fix every one of them and answer again with the complete workflow as JSON (same reply format). Do not change anything else.`,
      },
    ];
    try {
      const res2 = await ask(retry);
      const parsed2 = extractJsonObject(res2.text);
      const candidate2 = unwrap(parsed2);
      const check2 = validateWorkflow(candidate2, { nodes: NODES });
      usage = addUsage(usage, res2.usage);
      // Keep the second answer only when it really is better.
      if (issueWeight(check2) < issueWeight(check)) {
        fixed = issueWeight(check) - issueWeight(check2);
        res = res2;
        parsed = parsed2;
        candidate = candidate2;
        check = check2;
      }
    } catch {
      /* the first answer still stands — its issues are reported below */
    }
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const { workflow: next, warnings } = normalizeWorkflow(candidate, {
    fallbackName: workflow?.name,
    fallbackDescription: workflow?.description,
  });
  if (fixed) warnings.push(`The agent checked its answer and fixed ${fixed} problem${fixed === 1 ? "" : "s"} before applying it.`);
  for (const i of [...check.errors, ...check.warnings.filter(isFixable)].slice(0, 8)) warnings.push(i.message);

  const result = { ...next, id: workflow?.id, folderId: workflow?.folderId, webhookSlug: workflow?.webhookSlug };
  // The answer fit into the output limit? If not, the tail of the workflow may
  // be missing — say so instead of letting the user wonder about lost nodes.
  if (res.finishReason === "length" || res.finishReason === "max_tokens") {
    warnings.push("The model hit its output limit — the end of its answer may be missing. Raise BF_BUILDER_MAX_TOKENS for bigger workflows.");
  }
  return {
    workflow: result,
    summary: summary || "Workflow updated.",
    // What the agent really committed, computed from the two graphs. Empty when
    // the answer is identical to what the user already had.
    changes: diffWorkflows(workflow, result),
    warnings,
    usage,
  };
}
