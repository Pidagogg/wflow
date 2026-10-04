// ============================================================================
// AI workflow builder + the formatter/flow nodes it most often emits.
//
// Two things are covered here:
//   1. server/workflow-agent.js — the reply validation that stands between a
//      model's answer and the user's canvas: unknown node types are dropped,
//      dangling edges removed, positions filled in, a trigger missing is
//      reported, and the reference document really lists the catalog. Also the
//      documents the model is prompted with (workflow JSON + nodes + tools) and
//      the change list the chat shows the user.
//   2. The new nodes those workflows depend on (JSON parse, Base64, encrypt /
//      decrypt, URL parse / build, chunking, Do Nothing, Stop and Error).
//
// Run: node --test tests/workflow-agent.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// BF_DB_PATH must be set before the executor / store modules are evaluated.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-wfagent-"));
process.env.BF_DB_PATH = path.join(tempDir, "wfagent.db");

const { NODES } = await import("../shared/catalog.js");
// `buildWorkflow` is aliased: this file already has a local helper of that name
// for the node-level tests further down.
const { buildCatalogDoc, buildWorkflowFormatDoc, buildToolsDoc, diffWorkflows, normalizeWorkflow, buildSystemPrompt, buildWorkflow: runBuilder } =
  await import("../server/workflow-agent.js");
const { executeWorkflow } = await import("../server/executor.js");

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ----------------------------------------------------------------------------
// The reference document handed to the model
// ----------------------------------------------------------------------------
test("the node reference document covers every node type in the catalog", () => {
  const doc = buildCatalogDoc();
  for (const type of Object.keys(NODES)) {
    assert.ok(doc.includes(`- ${type}`), `reference document mentions "${type}"`);
  }
  // The system prompt carries the document plus the output contract.
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes('"workflow"'), "system prompt describes the reply shape");
  assert.ok(prompt.includes('"summary"'), "system prompt asks for a summary");
  assert.ok(prompt.length > 5000, "system prompt includes the node reference");
});

test("the workflow-JSON reference explains how a graph is written", () => {
  const doc = buildWorkflowFormatDoc();
  // The envelope, a node and an edge — the parts the model has to get exactly right.
  for (const needle of ['"nodes"', '"edges"', '"workflow"', 'sourceHandle', 'targetHandle', 'position', 'data', 'config', '"id"']) {
    assert.ok(doc.includes(needle), `the JSON reference mentions ${needle}`);
  }
  // Handles, placeholders, sticky notes and the plugin contract.
  assert.match(doc, /\{\{/, "placeholder syntax is documented");
  assert.match(doc, /true.*false/s, "the IF node's handles are documented");
  assert.match(doc, /stickyNote/, "sticky notes are documented");
  assert.match(doc, /secret/, "secret fields are documented");
  assert.match(doc, /FULL workflow/, "the reference says to return the whole graph, not a patch");
});

// ----------------------------------------------------------------------------
// The prompt the model actually receives
// ----------------------------------------------------------------------------
test("the system prompt carries the JSON reference, the node catalog and the tools", () => {
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes(buildWorkflowFormatDoc()), "the workflow JSON reference is included");
  assert.ok(prompt.includes(buildCatalogDoc()), "the node catalog is included");
  assert.ok(prompt.includes(buildToolsDoc()), "the tools reference is included");
  assert.match(prompt, /http_request/, "the HTTP tool is described");
  assert.match(prompt, /current_time/, "the time tool is described");
  assert.match(prompt, /one JSON object, nothing else/i, "the reply format is stated once, up front");
});

test("per-node boilerplate is documented once instead of repeated on every node", () => {
  const doc = buildCatalogDoc();
  // The on-error fields are appended to all ~160 node definitions — repeating
  // them per node would waste thousands of tokens of prompt.
  assert.equal(/\bonError\b/.test(doc), false, "onError is not repeated per node");
  assert.ok(buildWorkflowFormatDoc().includes("onError"), "…but the JSON reference explains it");
  // A real, node-specific setting is still there (the Date & Time node's field).
  assert.ok(doc.includes("inputField"), "node-specific fields survive the cleanup");
});

// ----------------------------------------------------------------------------
// The change list shown to the user — computed from the two graphs
// ----------------------------------------------------------------------------
const BEFORE_DIFF = {
  name: "Old name",
  description: "kept",
  nodes: [
    { id: "a", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } },
    { id: "b", type: "log", position: { x: 300, y: 0 }, data: { label: "Log", config: { message: "hi" } } },
  ],
  edges: [{ id: "e1", source: "a", target: "b", sourceHandle: "out", targetHandle: "in" }],
};

const AFTER_DIFF = {
  name: "New name",
  description: "kept",
  nodes: [
    { id: "a", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } },
    { id: "b", type: "log", position: { x: 300, y: 0 }, data: { label: "Logger", config: { message: "bye" } } },
    { id: "c", type: "slackSend", position: { x: 640, y: 0 }, data: { label: "Slack", config: { channel: "#ops" } } },
  ],
  edges: [
    { id: "e1", source: "a", target: "b", sourceHandle: "out", targetHandle: "in" },
    { id: "e2", source: "b", target: "c", sourceHandle: "out", targetHandle: "in" },
  ],
};

test("diffWorkflows spells out the added, updated, renamed and connected parts", () => {
  const changes = diffWorkflows(BEFORE_DIFF, AFTER_DIFF);
  assert.ok(changes.some((c) => c.startsWith("+ Added") && c.includes("Slack")), "the new node is reported");
  assert.ok(changes.some((c) => c.startsWith("~ Updated") && c.includes("message")), "the changed setting is named");
  assert.ok(changes.some((c) => c.includes('Renamed node "Log"')), "a renamed node is reported");
  assert.ok(changes.some((c) => c.startsWith("+ Connected") && c.includes("Slack")), "the new connection is reported");
  assert.ok(changes.some((c) => c.includes("Renamed the workflow")), "a workflow rename is reported");
});

test("diffWorkflows reports removals and disconnections too", () => {
  const changes = diffWorkflows(AFTER_DIFF, BEFORE_DIFF);
  assert.ok(changes.some((c) => c.startsWith("- Removed") && c.includes("Slack")), "the removed node is reported");
  assert.ok(changes.some((c) => c.startsWith("- Disconnected")), "the dropped connection is reported");
});

test("diffWorkflows stays silent when the workflow did not change", () => {
  assert.deepEqual(diffWorkflows(BEFORE_DIFF, BEFORE_DIFF), []);
});

test("diffWorkflows does not mistake editor defaults for user changes", () => {
  // The canvas state may predate inputMode/onError: normalizeWorkflow re-adds the
  // defaults, and that must not read as "the agent changed every node".
  const before = { name: "N", nodes: [{ id: "a", type: "slackSend", position: { x: 0, y: 0 }, data: { label: "Slack", config: {} } }], edges: [] };
  const { workflow } = normalizeWorkflow(before);
  assert.ok(Object.keys(workflow.nodes[0].data.config).length > 0, "normalizeWorkflow merged defaults in");
  assert.deepEqual(diffWorkflows(before, workflow), []);
  // A real change next to those defaults is still reported.
  const edited = { ...workflow, nodes: [{ ...workflow.nodes[0], data: { label: "Slack", config: { ...workflow.nodes[0].data.config, channel: "#ops" } } }] };
  const changes = diffWorkflows(before, edited);
  assert.equal(changes.length, 1, `only the real change is reported (got ${changes.join(" | ")})`);
  assert.ok(changes[0].includes("channel"), `the real change is reported (got ${changes.join(" | ")})`);
});

// ----------------------------------------------------------------------------
// One full turn, against a stubbed provider
// ----------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});

const SETTINGS = { provider: "openai", baseUrl: "https://provider.test/v1", apiKey: "test-key", model: "test-model" };

const PROVIDER_REPLY = {
  summary: "Added a Slack step",
  workflow: {
    name: "Built",
    nodes: [
      { id: "a", type: "manual", position: { x: 80, y: 160 }, data: { label: "Start", config: {} } },
      { id: "b", type: "slackSend", position: { x: 400, y: 160 }, data: { label: "Slack", config: { channel: "#ops" } } },
    ],
    edges: [{ id: "e1", source: "a", target: "b", sourceHandle: "out", targetHandle: "in" }],
  },
};

// Replace the provider with a script; returns the recorded requests.
function stubProvider(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    calls.push({ url: String(url), body });
    return handler(body);
  };
  return calls;
}

function chatResponse(content, finishReason = "stop") {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const OPEN_WORKFLOW = {
  name: "Mine",
  nodes: [{ id: "a", type: "manual", position: { x: 80, y: 160 }, data: { label: "Start", config: {} } }],
  edges: [],
};

test("a builder turn sends the reference documents and answers with the workflow plus its diff", async () => {
  let request;
  stubProvider((body) => {
    request = body;
    return chatResponse(JSON.stringify(PROVIDER_REPLY));
  });

  const res = await runBuilder({ settings: SETTINGS, prompt: "add a slack step", workflow: OPEN_WORKFLOW });

  // The request carries the two reference documents, the current graph and the prompt.
  assert.equal(request.response_format.type, "json_object", "JSON mode is requested for OpenAI-compatible providers");
  const system = request.messages[0].content;
  assert.ok(system.includes(buildWorkflowFormatDoc()), "the workflow JSON reference is sent");
  assert.ok(system.includes(buildCatalogDoc()), "the node catalog is sent");
  assert.ok(system.includes(buildToolsDoc()), "the tools reference is sent");
  assert.match(request.messages.at(-1).content, /add a slack step/);
  assert.match(request.messages.at(-1).content, /"nodes"/, "the current workflow is sent as JSON");

  // The answer is the validated workflow plus the committed change list.
  assert.equal(res.workflow.name, "Built");
  assert.equal(res.workflow.nodes.length, 2);
  assert.equal(res.summary, "Added a Slack step");
  assert.ok(res.changes.some((c) => c.startsWith("+ Added") && c.includes("Slack")), `the diff names the new node (${res.changes.join(" | ")})`);
  assert.ok(res.changes.some((c) => c.startsWith("+ Connected")), "the diff names the new connection");
});

test("the builder retries without JSON mode when the provider rejects response_format", async () => {
  const calls = stubProvider((body) =>
    body.response_format
      ? new Response(JSON.stringify({ error: { message: "response_format is not supported" } }), { status: 400 })
      : chatResponse(JSON.stringify(PROVIDER_REPLY))
  );

  const res = await runBuilder({ settings: SETTINGS, prompt: "add a slack step", workflow: OPEN_WORKFLOW });

  assert.equal(calls.length, 2, "the turn is retried exactly once");
  assert.ok(calls[0].body.response_format, "the first request asked for JSON mode");
  assert.equal(calls[1].body.response_format, undefined, "the retry drops the flag");
  assert.equal(res.workflow.nodes.length, 2, "the retry's answer is used");
});

test("a cut-off answer is reported instead of silently dropping the tail", async () => {
  stubProvider(() =>
    chatResponse(JSON.stringify({ summary: "partial", workflow: { nodes: [{ id: "a", type: "manual" }], edges: [] } }), "length")
  );
  const res = await runBuilder({ settings: SETTINGS, prompt: "build something big", workflow: OPEN_WORKFLOW });
  assert.ok(res.warnings.some((w) => /output limit/i.test(w)), `the truncation is reported (${res.warnings.join(" | ")})`);
});

test("a non-JSON answer fails with a message the user can act on", async () => {
  stubProvider(() => chatResponse("I am sorry, I cannot build that."));
  await assert.rejects(
    () => runBuilder({ settings: SETTINGS, prompt: "x", workflow: OPEN_WORKFLOW }),
    /not usable JSON/
  );
});

test("an answer with problems gets one self-check turn with the validator's list", async () => {
  const broken = {
    summary: "Mail the user",
    workflow: {
      name: "Built",
      nodes: [
        { id: "a", type: "formTrigger", position: { x: 80, y: 160 }, data: { label: "Form", config: { fields: "name, email" } } },
        { id: "b", type: "slackSend", position: { x: 400, y: 160 }, data: { label: "Slack", config: { channel: "#ops" } } },
        { id: "c", type: "emailSend", position: { x: 720, y: 160 }, data: { label: "Mail", config: { to: "{{email}}" } } },
      ],
      edges: [
        { id: "e1", source: "a", target: "b", sourceHandle: "out" },
        { id: "e2", source: "b", target: "c", sourceHandle: "out" },
      ],
    },
  };
  const good = structuredClone(broken);
  good.workflow.edges[1] = { id: "e2", source: "a", target: "c", sourceHandle: "out" };
  const calls = stubProvider(() => chatResponse(JSON.stringify(calls.length === 1 ? broken : good)));

  const res = await runBuilder({ settings: SETTINGS, prompt: "mail the user", workflow: OPEN_WORKFLOW });

  assert.equal(calls.length, 2, "exactly one extra turn");
  const feedback = calls[1].body.messages.at(-1).content;
  assert.match(feedback, /\{\{email\}\}/, "the model is told which placeholder renders empty");
  assert.equal(res.workflow.edges.find((e) => e.target === "c").source, "a", "the fixed answer is used");
  assert.ok(res.warnings.some((w) => /fixed 1 problem/.test(w)), res.warnings.join(" | "));
});

test("a clean answer is not sent back for a second turn", async () => {
  const calls = stubProvider(() => chatResponse(JSON.stringify(PROVIDER_REPLY)));
  await runBuilder({ settings: SETTINGS, prompt: "add a slack step", workflow: OPEN_WORKFLOW });
  assert.equal(calls.length, 1);
});

test("Switch and Router branches keep their case handles through normalisation", () => {
  const { workflow } = normalizeWorkflow({
    nodes: [
      { id: "t", type: "manual", data: { config: {} } },
      { id: "s", type: "switch", data: { config: { value: "{{x}}", cases: [{ key: "a" }, { key: "b" }] } } },
      { id: "n1", type: "noop", data: { config: {} } },
      { id: "n2", type: "noop", data: { config: {} } },
    ],
    edges: [
      { source: "t", target: "s" },
      { source: "s", target: "n1", sourceHandle: "case-1" },
      { source: "s", target: "n2", sourceHandle: "default" },
    ],
  });
  assert.deepEqual(workflow.edges.filter((e) => e.source === "s").map((e) => e.sourceHandle), ["case-1", "default"]);
});

// ----------------------------------------------------------------------------
// Reply validation — the model's answer is untrusted input
// ----------------------------------------------------------------------------
test("normalizeWorkflow keeps known nodes and lays out missing positions", () => {
  const { workflow, warnings } = normalizeWorkflow({
    name: "My flow",
    nodes: [
      { id: "a", type: "webhook", data: { label: "In", config: { method: "POST" } } },
      { id: "b", type: "noop" },
    ],
    edges: [{ source: "a", target: "b" }],
  });
  assert.equal(workflow.nodes.length, 2);
  assert.equal(workflow.name, "My flow");
  // Defaults are merged in, plus the editor's input-mode keys.
  assert.equal(workflow.nodes[0].data.config.method, "POST");
  assert.equal(workflow.nodes[0].data.config.inputMode, "auto");
  // Both nodes got a position (grid layout) and a readable label.
  for (const node of workflow.nodes) {
    assert.equal(typeof node.position.x, "number");
    assert.equal(typeof node.position.y, "number");
    assert.ok(node.data.label);
  }
  assert.equal(workflow.edges.length, 1);
  assert.equal(workflow.edges[0].sourceHandle, "out");
  assert.equal(workflow.edges[0].targetHandle, "in");
  assert.deepEqual(warnings, []);
});

test("normalizeWorkflow drops invented node types and reports them", () => {
  const { workflow, warnings } = normalizeWorkflow({
    nodes: [
      { id: "a", type: "manual" },
      { id: "b", type: "teleportMoney", data: { label: "Nope" } },
    ],
    edges: [
      { source: "a", target: "b" },
      { source: "a", target: "ghost" },
    ],
  });
  assert.equal(workflow.nodes.length, 1);
  assert.equal(workflow.nodes[0].type, "manual");
  assert.equal(workflow.edges.length, 0, "edges to dropped/unknown nodes are removed");
  assert.ok(warnings.some((w) => w.includes("teleportMoney")), "the dropped type is reported");
});

test("normalizeWorkflow warns when the result has no trigger", () => {
  const { workflow, warnings } = normalizeWorkflow({ nodes: [{ id: "a", type: "noop" }, { id: "b", type: "log" }] });
  assert.equal(workflow.nodes.length, 2);
  assert.ok(warnings.some((w) => /trigger/i.test(w)));
});

test("normalizeWorkflow makes duplicate ids unique and fixes impossible source handles", () => {
  const { workflow } = normalizeWorkflow({
    nodes: [
      { id: "same", type: "manual" },
      { id: "same", type: "if" },
      { id: "c", type: "log" },
    ],
    // the IF node has "true"/"false" — never this
    edges: [{ source: "same", sourceHandle: "definitely-not-a-handle", target: "c" }],
  });
  const ids = workflow.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique");
  const ifNode = workflow.nodes.find((n) => n.type === "if");
  assert.ok(ifNode, "the IF node survived the duplicate id");
  assert.ok(ifNode.data.config.operator, "IF defaults are merged in");

  const { workflow: branched } = normalizeWorkflow({
    nodes: [
      { id: "t", type: "manual" },
      { id: "check", type: "if" },
      { id: "yes", type: "noop" },
    ],
    edges: [{ source: "check", sourceHandle: "nope", target: "yes" }],
  });
  assert.equal(branched.edges.length, 1, "the branch stays connected");
  assert.ok(["true", "false"].includes(branched.edges[0].sourceHandle), `handle replaced by a real output (got ${branched.edges[0].sourceHandle})`);
});

test("normalizeWorkflow rejects a reply without usable nodes", () => {
  assert.throws(() => normalizeWorkflow({ nodes: [] }), /without any nodes/);
  assert.throws(() => normalizeWorkflow({ nodes: [{ type: "notAThing" }] }), /does not have/);
});

// ----------------------------------------------------------------------------
// The nodes the builder reaches for most: formatters and flow control
// ----------------------------------------------------------------------------
const PAYLOAD = { url: "https://api.example.com/items?a=1&b=two", body: '{"a":1,"b":[1,2]}', text: "x".repeat(3000), message: "hello" };

function buildWorkflow(nodes) {
  return {
    id: "wf-format",
    name: "formatters",
    nodes: [
      { id: "feed", type: "manual", position: { x: 0, y: 0 }, data: { label: "Feed", config: { manualOutput: true, manualOutputJson: JSON.stringify(PAYLOAD) } } },
      ...nodes.map((n, i) => ({ id: n.id || `n${i + 1}`, type: n.type, position: { x: 0, y: 0 }, data: { label: n.type, config: n.config || {} } })),
    ],
    edges: nodes.map((n, i) => ({
      id: `e${i}`,
      source: i === 0 ? "feed" : nodes[i - 1].id || `n${i}`,
      target: n.id || `n${i + 1}`,
      sourceHandle: "out",
      targetHandle: "in",
    })),
  };
}

// Run the chain and return the log entry of the LAST node (the one under test).
async function run(nodes) {
  const res = await executeWorkflow(buildWorkflow(nodes), { payload: PAYLOAD, maxItemsPerNode: 20 });
  const lastId = nodes[nodes.length - 1].id || `n${nodes.length}`;
  const entry = res.log.find((l) => l.nodeId === lastId);
  assert.ok(entry, `the last node (${lastId}) produced a log entry`);
  return entry;
}

// Each item in the log is the node's output value itself (the executor flattens
// `{ json }` before logging), so read fields off the item directly.
function out(entry, index = 0) {
  return entry.outputItems[index] || {};
}

test("Do Nothing passes its input straight through", async () => {
  const last = await run([{ type: "noop" }]);
  assert.equal(last.status, "success");
  assert.equal(out(last).body, PAYLOAD.body);
});

test("JSON parse turns a string field into real data", async () => {
  const last = await run([{ type: "jsonParse", config: { mode: "parse", field: "body", storeIn: "parsed" } }]);
  assert.equal(last.status, "success");
  assert.deepEqual(out(last).parsed, { a: 1, b: [1, 2] });
});

test("JSON parse flags invalid JSON with the parse error code", async () => {
  const last = await run([{ type: "jsonParse", config: { mode: "parse", field: "message", storeIn: "parsed" } }]);
  assert.equal(last.status, "error");
  assert.equal(last.errorCode, 6001); // BF-6001 PARSE_FAILED
});

test("Base64 encode and decode round-trip", async () => {
  const last = await run([
    { id: "n1", type: "base64", config: { mode: "encode", value: "{{message}}", storeIn: "b64" } },
    { id: "n2", type: "base64", config: { mode: "decode", value: "{{b64}}", storeIn: "back" } },
  ]);
  assert.equal(last.status, "success");
  assert.equal(out(last).back, "hello");
});

test("Encrypt and decrypt round-trip with the same passphrase", async () => {
  const last = await run([
    { id: "n1", type: "encrypt", config: { mode: "encrypt", value: "{{body}}", passphrase: "correct horse", storeIn: "cipher" } },
    { id: "n2", type: "encrypt", config: { mode: "decrypt", value: "{{cipher}}", passphrase: "correct horse", storeIn: "plain" } },
  ]);
  assert.equal(last.status, "success");
  assert.equal(out(last).plain, PAYLOAD.body);
});

test("Decrypting with the wrong passphrase fails with BF-7002", async () => {
  const last = await run([
    { id: "n1", type: "encrypt", config: { mode: "encrypt", value: "{{body}}", passphrase: "one", storeIn: "cipher" } },
    { id: "n2", type: "encrypt", config: { mode: "decrypt", value: "{{cipher}}", passphrase: "two", storeIn: "plain" } },
  ]);
  assert.equal(last.status, "error");
  assert.equal(last.errorCode, 7002);
});

test("URL parse splits a URL into its parts", async () => {
  const last = await run([{ type: "urlParse", config: { mode: "parse", url: "{{url}}", storeIn: "u" } }]);
  assert.equal(last.status, "success");
  assert.equal(out(last).u.protocol, "https");
  assert.equal(out(last).u.host, "api.example.com");
  assert.equal(out(last).u.query.a, "1");
});

test("URL build assembles a URL from parts and placeholders", async () => {
  const last = await run([
    {
      type: "urlParse",
      config: { mode: "build", base: "https://api.example.com/", path: "/v1/items", query: [{ key: "q", value: "{{message}}" }], storeIn: "u" },
    },
  ]);
  assert.equal(last.status, "success");
  assert.equal(out(last).u, "https://api.example.com/v1/items?q=hello");
});

test("Split Text into Chunks emits one item per chunk (and can emit an array)", async () => {
  const items = await run([{ type: "chunkText", config: { field: "text", chunkSize: 1000, overlap: 0, mode: "items", storeIn: "chunk" } }]);
  assert.equal(items.status, "success");
  assert.equal(items.outputItems.length, 3);
  assert.equal(out(items).chunkCount, 3);
  assert.equal(out(items).chunk.length, 1000);

  const array = await run([{ type: "chunkText", config: { field: "text", chunkSize: 1500, overlap: 500, mode: "array", storeIn: "chunks" } }]);
  assert.equal(array.outputItems.length, 1);
  assert.ok(Array.isArray(out(array).chunks));
  assert.ok(out(array).chunks.length >= 2, "overlap produces the extra window");
});

test("Stop and Error halts the run with BF-1004 and the rendered message", async () => {
  const last = await run([{ type: "stopError", config: { message: "rejected: {{message}}" } }]);
  assert.equal(last.status, "error");
  assert.equal(last.errorCode, 1004);
  assert.match(last.error, /rejected: hello/);
});
