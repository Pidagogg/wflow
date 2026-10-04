// ============================================================================
// W FLOW — the workflow reference for AI agents
//
// One source for everything a model needs to read, write and fix a W flow
// workflow as JSON: how the graph is written, how data moves between nodes,
// what every node accepts AND outputs, and complete worked examples. Three
// readers use it, so they can never disagree:
//
//   - the in-app builder agent (server/workflow-agent.js) — system prompt,
//   - outside agents (Claude Code, Cursor, …) — GET /docs/workflow-reference.md
//     (linked from /llms.txt, server/seo.js),
//   - the MCP builder tools (server/mcp.js) — the `workflow_reference` tool.
//
// Everything below is generated from shared/catalog.js, shared/node-outputs.js
// and shared/templates.js, and the statements about the engine were checked
// against server/executor.js (graph walker, renderTemplate, shared/paths.js).
// When the engine changes, change the text here too.
// ============================================================================
import { CATALOG, NODES } from "../shared/catalog.js";
import { outputDocFor } from "../shared/node-outputs.js";
import { getTemplate } from "../shared/templates.js";

// The on-error fields are appended to every node definition by shared/catalog.js,
// so without this they would be repeated in all ~470 catalog entries and bloat
// the prompt for no benefit. They are documented once, in the format reference.
// NOTE: only the error-handling trio lives here — "inputField" is a real setting
// of the Date & Time node, so it must stay in its field list.
const GLOBAL_CONFIG_KEYS = new Set(["onError", "retryCount", "retryDelay"]);

/** Where the JSON Schema of a workflow file is served (see server/index.js). */
export const WORKFLOW_SCHEMA_PATH = "/schema/workflow.schema.json";

// ---- node catalog ----
function shortDefaults(def) {
  const parts = [];
  for (const [key, value] of Object.entries(def.defaults || {})) {
    if (value === null || value === undefined) continue;
    if (GLOBAL_CONFIG_KEYS.has(key)) continue;
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") continue;
    const text = JSON.stringify(value);
    if (text.length > 70) continue; // skip long sample bodies — the model infers them
    parts.push(`${key}=${text}`);
  }
  return parts.length ? ` defaults{${parts.join(", ")}}` : "";
}

function fieldSummary(def) {
  const fields = (def.fields || []).filter((f) => f.type !== "note" && !GLOBAL_CONFIG_KEYS.has(f.key));
  if (!fields.length) return "";
  return ` fields: ${fields
    .map((f) => {
      const opts = Array.isArray(f.options) && f.options.length
        ? `(${f.options.map((o) => (typeof o === "string" ? o : o?.value)).filter(Boolean).slice(0, 8).join("|")})`
        : "";
      return `${f.key}:${f.type}${opts}${f.optional ? "?" : ""}`;
    })
    .join(", ")}`;
}

// The ~240 REST service nodes and ~70 other nodes share one output rule (the
// incoming item plus the result under `storeIn`). Writing that sentence out
// 300 times would cost thousands of prompt tokens, so the catalog line only
// says "+<key>" and the rule is explained once in the format reference.
function outputSummary(type, def) {
  const hasStoreIn = (def.fields || []).some((f) => f.key === "storeIn");
  const doc = outputDocFor(type, def);
  if (hasStoreIn && doc.includes("(the storeIn field)")) return ` out: +${def.defaults?.storeIn || "data"}${def.service ? " (API response)" : ""}`;
  return doc ? ` out: ${doc}` : "";
}

export function buildCatalogDoc() {
  const lines = [
    "Every node the editor knows. `type` is what you put in the node's `type` field.",
    "Fields are listed as key:type (values in brackets are the allowed options, `?` marks optional).",
    "Outputs: a node routes its items to `sourceHandle`; \"out\" is the default, other handles are listed in [outputs: …].",
    "`out:` says what the node's items look like afterwards (see ITEMS AND OUTPUTS in the JSON reference for the notation).",
  ];
  for (const group of CATALOG.groups) {
    lines.push(`\n### ${group.label}`);
    for (const type of group.nodes) {
      const def = NODES[type];
      if (!def) continue;
      const kind = def.kind === "trigger" ? " [trigger]" : "";
      const outputs = (def.sources || []).length > 1 ? ` [outputs: ${def.sources.join("|")}]` : "";
      lines.push(`- ${type}${kind} — ${def.name}${outputs}: ${def.description}${fieldSummary(def)}${shortDefaults(def)}${outputSummary(type, def)}`);
    }
  }
  return lines.join("\n");
}

// ---- the JSON format and the engine rules ----
export function buildWorkflowFormatDoc() {
  return `A workflow is ONE JSON object holding the steps and the connections between them.
The four keys below (name, description, nodes, edges) are what you put in the "workflow" object of your reply.
A JSON Schema of this format is served at ${WORKFLOW_SCHEMA_PATH}.

{
  "name": "Invoice triage",          // keep the current name unless the user asks for a new one
  "description": "optional, one line",
  "nodes": [ ... ],                  // the steps — see NODE
  "edges": [ ... ]                   // the connections — see EDGE
}

NODE — one step on the canvas
{
  "id": "n-7f3a91c2",                // unique inside the workflow; KEEP an existing id when you edit that node
  "type": "webhook",                 // must be a type from the NODE CATALOG — never invent one
  "position": { "x": 80, "y": 160 }, // canvas coordinates: left to right, ~320 more x per step, ~160 more y per branch
  "data": {
    "label": "Webhook",              // the name shown on the node; keep it unless asked
    "config": { "method": "POST" }   // the step's settings — only keys from that type's field list
  }
}

EDGE — one connection
{
  "id": "e-1",                       // any string, unique inside the workflow
  "source": "n-7f3a91c2",            // id of the node the data leaves
  "target": "n-21b0",                // id of the node the data enters
  "sourceHandle": "out",             // which output of the source it leaves from — see HANDLES
  "targetHandle": "in"               // always "in"
}

HANDLES — a node's outputs
- "out" is the single default output of nearly every node.
- Nodes with several outputs list them in the catalog as [outputs: …]: IF → "true" / "false"; Wait for Approval → "approved" / "rejected"; Compare Datasets → "same" / "different" / "onlyA" / "onlyB".
- Switch and Router have one output PER ROW, named by position: "case-0" for the first row of Switch's config.cases (Router: config.rules), "case-1" for the second, … plus "default" (Switch) or "fallback" (Router) for items no row matched. The row's key / value is NOT the handle name.
- A node with no outputs is a dead end (Stop and Error, Loop End): never connect out of a handle a node does not have.
- Every edge must point at a node id that exists. An edge to a missing node is removed.

HOW A RUN MOVES DATA
- Data travels as a list of ITEMS. Every item is one JSON object. A trigger usually emits one item; a node that reads rows or feeds may emit many.
- Every node handles EVERY item it receives (an e-mail node with 5 items sends 5 e-mails). There is no need for a loop to process a list — Loop only adds loop: { index, total } to each item.
- A node runs ONCE per run, on all items that reached it before its turn. Items from several incoming edges are concatenated in arrival order. When two branches of different length join again, the longer branch's items arrive after the node already ran and are lost — keep rejoining branches the same number of steps long.
- Nodes without an incoming edge start the run too (with one item { triggeredAt }). A runnable workflow has exactly one trigger unless the user asks otherwise.
- A branch handle with no items (e.g. IF "false" when everything was true) simply does not run what is connected to it.
- Errors: config.onError decides what happens when a node fails. "stop" (default for triggers, logic and AI) ends that path; "continue" (default for actions) passes the INCOMING items on with an added _error: { message, code, marker, nodeId, nodeName, nodeType, attempts }; "retry" tries retryCount times (default 3), retryDelay seconds apart, then stops. Leave these keys out unless the user asks — the editor fills them in.

ITEMS AND OUTPUTS — what the next node receives (the catalog's "out:")
- "+ a, b" — the node KEEPS every incoming field and adds a and b. Most transform, AI and file nodes work like this.
- "= { a, b }" — the node REPLACES the item. Earlier fields are gone: after a Slack or HTTP node the next node only sees that node's own fields. If a later step needs earlier fields, use them BEFORE the replacing node, or run the replacing node on a side branch (connect the earlier node to both) so the main path keeps its data.
- "+key" / "+key (API response)" — the node keeps the incoming item and stores its result under config.storeIn (default: key). Change storeIn to name the field yourself. Service nodes (API response) also add _service: { type, status, endpoint, at }.
- Triggers say "= { … }" with the fields of a representative event; a real event has the same shape with real values. A webhook's JSON body is under body ({{body.message}}), its query string under query.
- Handle notes (IF, Switch, Filter, Limit, Sort, …) pass items through unchanged unless the entry says otherwise.

PLACEHOLDERS — "{{path}}" inside any string setting
- Syntax: {{name}} or {{a.b.c}}. Only letters, digits, _, $ and dots are allowed between the braces — no spaces, no brackets, no expressions, no functions, no quotes. Anything else is left in the text literally.
- The path is read from the CURRENT item only (the item this node is processing). There is no way to reach another node's output by name — make sure the field is on the item (see ITEMS AND OUTPUTS).
- List elements use their index as a segment: {{rows.0.email}} is the email of the first row.
- Lookup: the exact path wins. If it does not exist, the FIRST segment is searched anywhere in the item (shallowest first) and the rest continues from there — so {{message}} finds body.message and {{price}} finds result.price. Prefer the exact path; it is never ambiguous.
- {{json}} is the whole item as JSON text; {{json.a.b}} is the same as {{a.b}}.
- {{$vars.NAME}} is the user's Variable NAME (set on the Variables page; in the test environment its test value). {{$env}} is "live" or "test".
- A missing value renders as an empty string. Objects and arrays render as JSON text.
- Placeholders work inside JSON-typed settings too: {"comment": "Got {{body.name}}"}. In a Webhook Respond body a lone "{{field}}" in quotes is inserted as a properly escaped JSON string.

CONFIG — a node's settings
- Use ONLY the keys that node type lists in the catalog. Unknown keys are ignored, so a typo silently loses the setting.
- Give every required field a real value (a sample JSON body, a sheet name, a URL …); fields marked ? may be omitted.
- Fields of type "secret" (API keys, tokens, passwords) must be "" — never invent credentials. Where a real value is needed, point the user to a Variable ({{$vars.OPENAI_KEY}}) only if they asked for it.
- Leave the editor's own input filter (inputMode / inputFromNode) untouched unless the request is about how a node receives its data.
- Leave the trigger's own settings (method, cron, timezone …) as they are unless the request is about the trigger.
- Sticky notes are ordinary nodes of type "stickyNote" (text in config.content, size in config.width / config.height). They are annotations, not steps — keep the ones the user made and never connect them.
- Leave the secret-ish fields of imported nodes empty rather than copying values around.

WHAT AN EDIT MUST LOOK LIKE
- Return the FULL workflow every time — the app replaces the canvas with your answer, it is not a patch.
- Change ONLY what the user asked for. Keep every untouched node exactly as it was: same id, same type, same label, same position, same config.
- The app diffs your answer against the canvas and shows the user what changed ("added node X", "removed node Y", "connected A → B"). Silent deletions, renamed ids or re-created nodes read as damage, so never tidy up on your own.
- New nodes go to the right of the ones that already exist, and you wire them into the graph with new edges.`;
}

// ---- AI Agent tools ----
// Kept in sync by hand with the tool definitions in server/ai.js
// (buildToolDefs) — they are part of what the model needs to know to
// configure an agent step correctly.
const AGENT_TOOLS = [
  { field: "useHttpTool", name: "http_request", does: "call an external HTTP API (method, url, headers, body) and read the response" },
  { field: "useTimeTool", name: "current_time", does: "read the current date and time and the server's time zone" },
];

export function buildToolsDoc() {
  const lines = [
    "An AI Agent node can let its model call tools before answering. Each tool is switched on with a boolean field on that node:",
  ];
  for (const tool of AGENT_TOOLS) {
    lines.push(`- ${tool.name} — ${tool.does}. Enable with \`${tool.field}: true\` (plus that tool's own fields, e.g. httpMethod/httpUrl/… for http_request).`);
  }
  lines.push(
    "- A saved AI agent (built in the AI Agent Builder) brings its own tools and system prompt; the node only needs `agentSource: \"saved\"` and `agentId`.",
    "- With no tool enabled the agent node behaves like a plain model call."
  );
  return lines.join("\n");
}

// ---- worked examples ----
// Real templates from the gallery, so they are known to load and run. The
// on-error keys and empty strings are stripped: they are noise to a reader and
// the rules above already say the editor fills them in.
const EXAMPLES = [
  { id: "api-health-check", why: "schedule → HTTP (replaces the item) → IF on the HTTP fields → two branches on the \"true\" / \"false\" handles" },
  { id: "ai-triage-inbox", why: "AI extraction stores its result under storeIn (parsed) → the IF and the messages read {{parsed.…}} while {{from}} still comes from the trigger" },
  { id: "chat-assistant", why: "chat trigger → model reply ({{message}} in, {{reply}} out) → answer in the chat panel" },
];

function compactConfig(config) {
  return Object.fromEntries(Object.entries(config || {}).filter(([k, v]) => !GLOBAL_CONFIG_KEYS.has(k) && v !== "" && !(Array.isArray(v) && !v.length)));
}

export function buildExamplesDoc() {
  const parts = ["Complete workflows that load and run as they are (on-error keys and empty settings left out)."];
  for (const ex of EXAMPLES) {
    const t = getTemplate(ex.id);
    if (!t) continue;
    const wf = {
      name: t.name,
      nodes: t.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: { label: n.data?.label, config: compactConfig(n.data?.config) } })),
      edges: t.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || "out", targetHandle: "in" })),
    };
    parts.push(`\n#### ${t.name}\nShows: ${ex.why}\n${JSON.stringify(wf, null, 1)}`);
  }
  return parts.join("\n");
}

// ---- the public reference ----
/** The whole reference as one Markdown document (GET /docs/workflow-reference.md, MCP). */
export function buildReferenceMarkdown(baseUrl = "") {
  return `# W flow workflow reference for AI agents

W flow is a self-hosted, node-based workflow automation tool (similar to n8n). This document is everything an AI agent needs to read, write, fix and run W flow workflows as JSON.
${baseUrl ? `\nMCP server: ${baseUrl}/mcp (token from Settings → AI tools). JSON Schema: ${baseUrl}${WORKFLOW_SCHEMA_PATH}\n` : ""}
## 1. Workflow JSON and engine rules

${buildWorkflowFormatDoc()}

## 2. Worked examples

${buildExamplesDoc()}

## 3. AI Agent tools

${buildToolsDoc()}

## 4. Node catalog

${buildCatalogDoc()}
`;
}
