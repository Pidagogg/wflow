// ============================================================================
// MCP server (server/mcp.js): named tokens with access levels, scopes and run
// limits; typed inputs and structured answers; the wflow_* builder tools; runs
// that answer with a run id when they take long; and the call record in
// Executions.
//
// Run: node --test tests/mcp.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-mcp-"));
process.env.BF_DB_PATH = path.join(tempDir, "mcp.db");
process.env.BF_DATA_DIR = tempDir;

const { db } = await import("../server/dbx.js");
const { workflows, collectSecrets, blankSecretsInWorkflow } = await import("../server/store.js");
const mcp = await import("../server/mcp.js");
const { handleRpc, toolFor, normalizeMcpSettings, createMcpToken, updateMcpToken, mcpTokens, revokeMcpToken, configureMcp } = mcp;

const node = (id, type, config = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, config: { onError: "stop", ...config } } });
const setNode = (id, fields) => node(id, "set", { mode: "set", parseValues: false, fields });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target, sourceHandle: "out", targetHandle: "in" });
const call = (user, name, args, id = 1) => handleRpc(user, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const list = async (user) => (await handleRpc(user, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
const tokenUser = (userId, token) => ({ userId, token: { id: `t-${userId}`, name: "test", access: "run", workflows: "all", dailyRuns: 0, ...token } });

// Saves go through the editor's logic in server/index.js; here a minimal stand-in.
configureMcp({
  createWorkflow: async (userId, body) => {
    const wf = { ...body, id: `wf-${Math.random().toString(36).slice(2, 10)}`, ownerId: userId };
    await db.replaceWorkflowSecrets(wf.id, userId, collectSecrets(wf));
    await workflows.save(blankSecretsInWorkflow(wf));
    return { status: 200, json: wf };
  },
  updateWorkflow: async (userId, id, body) => {
    const existing = await workflows.get(id);
    const wf = { ...existing, ...body };
    await db.replaceWorkflowSecrets(id, userId, collectSecrets(wf));
    await workflows.save(blankSecretsInWorkflow(wf));
    return { status: 200, json: wf };
  },
  workflowUrl: async (id) => `https://w.test/cloud/workflow/${id}`,
});

// ---- tokens ----
test("tokens are named, scoped and editable, and several can exist", async () => {
  const a = await createMcpToken("u-tokens", { name: "Laptop", access: "build" });
  const b = await createMcpToken("u-tokens", { name: "CI", access: "read", workflows: ["wf-1"], dailyRuns: 5 });
  assert.notEqual(a.token, b.token);
  const all = await mcpTokens("u-tokens");
  assert.deepEqual(all.map((t) => [t.name, t.access, t.workflows, t.dailyRuns]), [["Laptop", "build", "all", 0], ["CI", "read", ["wf-1"], 5]]);
  assert.ok(!JSON.stringify(all).includes(a.token) && !JSON.stringify(all).includes("digest"), "no secret or digest in the public view");
  const changed = await updateMcpToken("u-tokens", b.info.id, { access: "nonsense", workflows: [], dailyRuns: -3 });
  assert.deepEqual([changed.access, changed.workflows, changed.dailyRuns], ["run", "all", 0], "bad values fall back to the safe defaults");
  await revokeMcpToken("u-tokens", a.info.id);
  assert.deepEqual((await mcpTokens("u-tokens")).map((t) => t.name), ["CI"]);
});

test("a token resolves to its account and record, and stops working once revoked", async () => {
  const account = await db.createUser({ email: "resolve@example.test", name: "R", passwordHash: "x" });
  const userId = String(account.id);
  const { token, info } = await createMcpToken(userId, { name: "Phone", access: "read" });
  const who = await mcp.userForToken(token);
  assert.equal(who.userId, userId);
  assert.deepEqual([who.token.id, who.token.access], [info.id, "read"]);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok((await mcpTokens(userId))[0].lastUsedAt, "the last use is remembered");
  assert.equal(await mcp.userForToken("wfmcp_wrong"), null);
  await revokeMcpToken(userId, info.id);
  assert.equal(await mcp.userForToken(token), null);
});

test("a token from before named tokens keeps working with run access", async () => {
  await db.storeSet("mcp.user.u-legacy", JSON.stringify({ digest: "abc", createdAt: "2026-01-01T00:00:00Z", hint: "wxyz" }));
  const [t] = await mcpTokens("u-legacy");
  assert.deepEqual([t.id, t.name, t.access, t.hint], ["default", "Default", "run", "wxyz"]);
});

test("the access level decides which builder tools a token sees and may call", async () => {
  const names = async (access) => (await list(tokenUser(`u-lvl-${access}`, { access }))).map((t) => t.name).filter((n) => n.startsWith("wflow_"));
  assert.deepEqual(await names("run"), ["wflow_get_run"]);
  assert.ok((await names("read")).includes("wflow_get_workflow") && !(await names("read")).includes("wflow_create_workflow"));
  assert.ok((await names("build")).includes("wflow_create_workflow"));
  const denied = await call(tokenUser("u-lvl-run", { access: "run" }), "wflow_list_workflows", {});
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /not allowed/);
});

// ---- typed inputs + structured answers ----
test("typed inputs become the tool's schema, are coerced and can be required", async () => {
  const settings = normalizeMcpSettings({
    enabled: true,
    params: [
      { name: "amount", type: "number", required: true, example: "3" },
      { name: "urgent", type: "boolean" },
      { name: "tier", type: "enum", options: "free, pro" },
      { name: "note", description: "plain text stays minimal" },
    ],
    outputs: [{ name: "total", type: "number", description: "the sum" }],
  });
  assert.deepEqual(settings.params[3], { name: "note", description: "plain text stays minimal" });
  const tool = toolFor({ id: "wf-typed", name: "Typed", mcp: settings, nodes: [] });
  assert.deepEqual(tool.inputSchema.properties.amount, { description: "amount", type: "number", examples: [3] });
  assert.deepEqual(tool.inputSchema.properties.tier.enum, ["free", "pro"]);
  assert.deepEqual(tool.inputSchema.required, ["amount"]);
  assert.equal(tool.outputSchema.properties.total.type, "number");

  const wf = {
    id: "wf-typed-run",
    ownerId: "u-typed",
    name: "Typed run",
    mcp: settings,
    nodes: [node("t", "manual"), setNode("s", [{ key: "total", value: "{{amount}}" }, { key: "isUrgent", value: "{{urgent}}" }])],
    edges: [edge("t", "s")],
  };
  await workflows.save(wf);
  const user = tokenUser("u-typed");
  const name = toolFor(wf).name;
  const missing = await call(user, name, { urgent: true });
  assert.match(missing.result.content[0].text, /Missing required input: amount/);
  const ok = await call(user, name, { amount: "7", urgent: "yes" });
  assert.equal(ok.result.isError, undefined, ok.result.content[0].text);
  assert.equal(ok.result.structuredContent.total, "7");
  assert.equal(ok.result.structuredContent.isUrgent, "true", "the coerced boolean reaches the workflow");
  assert.equal(JSON.parse(ok.result.content[0].text).total, "7", "the text answer is still there for older clients");
});

// ---- scope + limits ----
test("a token only sees and runs the workflows in its scope, within its daily runs", async () => {
  const mk = (id) => ({ id, ownerId: "u-scope", name: id, mcp: { enabled: true, description: "", params: [] }, nodes: [node("t", "manual")], edges: [] });
  await workflows.save(mk("wf-in"));
  await workflows.save(mk("wf-out"));
  const user = tokenUser("u-scope", { workflows: ["wf-in"], dailyRuns: 1 });
  const tools = (await list(user)).map((t) => t.title);
  assert.ok(tools.includes("wf-in") && !tools.includes("wf-out"));
  const out = await call(user, toolFor(mk("wf-out")).name, {});
  assert.match(out.result.content[0].text, /outside this token's scope/);
  assert.equal((await call(user, toolFor(mk("wf-in")).name, {})).result.isError, undefined);
  const second = await call(user, toolFor(mk("wf-in")).name, {});
  assert.match(second.result.content[0].text, /used all 1 runs/);
});

// ---- builder tools ----
test("builder tools read the catalog, validate, create, read back and update a workflow", async () => {
  const user = tokenUser("u-build", { access: "build" });
  const ref = await call(user, "wflow_reference", {});
  assert.match(ref.result.content[0].text, /ITEMS AND OUTPUTS/);
  const found = await call(user, "wflow_list_node_types", { query: "slack message" });
  assert.ok(found.result.structuredContent.node_types.some((n) => n.type === "slackSend"));
  const det = await call(user, "wflow_get_node_type", { type: "if" });
  assert.deepEqual(det.result.structuredContent.handles, ["true", "false"]);
  assert.match((await call(user, "wflow_get_node_type", { type: "slak" })).result.content[0].text, /Unknown node type/);

  const draft = {
    name: "From Claude",
    nodes: [node("t", "manual"), node("h", "http", { method: "GET", url: "https://example.test", authType: "bearer", authToken: "sekret" }), node("x", "noop")],
    edges: [edge("t", "h"), { source: "h", target: "x", sourceHandle: "nope" }],
  };
  const check = await call(user, "wflow_validate_workflow", { workflow: draft });
  assert.equal(check.result.structuredContent.ok, false);
  assert.match(JSON.stringify(check.result.structuredContent.errors), /nope/);

  const created = await call(user, "wflow_create_workflow", { workflow: draft });
  const id = created.result.structuredContent.workflow_id;
  assert.ok(id);
  assert.equal(created.result.structuredContent.url, `https://w.test/cloud/workflow/${id}`);

  const read = await call(user, "wflow_get_workflow", { workflow_id: id });
  const httpNode = read.result.structuredContent.workflow.nodes.find((n) => n.id === "h");
  assert.equal(httpNode.data.config.authToken, "", "credentials are never handed to the assistant");
  assert.equal(read.result.structuredContent.workflow.edges.find((e) => e.target === "x").sourceHandle, "out", "the bad handle was repaired on save");

  const changed = read.result.structuredContent.workflow;
  changed.nodes.find((n) => n.id === "h").data.config.url = "https://example.test/v2";
  const updated = await call(user, "wflow_update_workflow", { workflow_id: id, workflow: changed });
  assert.equal(updated.result.isError, undefined, updated.result.content[0].text);
  const secrets = await db.getWorkflowSecrets(id);
  assert.ok(secrets.some((s) => s.nodeId === "h" && s.value === "sekret"), "the saved credential survived the update");
  assert.equal((await workflows.get(id)).nodes.find((n) => n.id === "h").data.config.url, "https://example.test/v2");

  const listed = await call(user, "wflow_list_workflows", {});
  assert.ok(listed.result.structuredContent.workflows.some((w) => w.id === id));
  const scoped = tokenUser("u-build", { access: "build", workflows: ["other"] });
  assert.match((await call(scoped, "wflow_create_workflow", { workflow: draft })).result.content[0].text, /cannot create/);
  assert.match((await call(scoped, "wflow_get_workflow", { workflow_id: id })).result.content[0].text, /No workflow/);
});

// ---- long runs ----
test("a long run answers with a run id and its result can be fetched later, and it lands in Executions", async () => {
  const wf = {
    id: "wf-slow",
    ownerId: "u-slow",
    name: "Slow",
    nodes: [node("t", "manual"), node("w", "wait", { duration: 1, unit: "seconds" }), setNode("s", [{ key: "done", value: "yes {{who}}" }])],
    edges: [edge("t", "w"), edge("w", "s")],
  };
  await workflows.save(wf);
  const user = tokenUser("u-slow", { access: "build", name: "Robot" });
  const started = await call(user, "wflow_run_workflow", { workflow_id: "wf-slow", input: { who: "ada" }, wait_seconds: 0 });
  assert.equal(started.result.structuredContent.status, "running");
  const runId = started.result.structuredContent.run_id;
  const done = await call(user, "wflow_get_run", { run_id: runId, wait_seconds: 10 });
  assert.equal(done.result.structuredContent.done, "yes ada");
  assert.match((await call(tokenUser("u-other"), "wflow_get_run", { run_id: runId })).result.content[0].text, /No run/, "another account cannot read the run");

  const [summary] = await db.executionsListByWorkflow("wf-slow", 5);
  assert.equal(summary.source, "mcp");
  const full = await db.executionGet(summary.id);
  const aiTool = (full.result || full).aiTool;
  assert.deepEqual([aiTool.tool, aiTool.token, aiTool.arguments.who], ["wflow_run_workflow", "Robot", "ada"]);
  assert.match(aiTool.answer, /yes ada/);
});

// Directories such as Smithery shake hands and list the tools before the user
// has a token; that must work, while running anything still needs one.
test("without a token: handshake and tool list work, everything else needs a token", async () => {
  assert.equal(mcp.isPublicRpc({ method: "initialize" }), true);
  assert.equal(mcp.isPublicRpc({ method: "tools/list" }), true);
  assert.equal(mcp.isPublicRpc({ method: "notifications/initialized" }), true);
  assert.equal(mcp.isPublicRpc({ method: "tools/call" }), false);
  const init = await mcp.handleAnonymousRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "w-flow");
  const list = await mcp.handleAnonymousRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes("wflow_get_reference"));
  assert.ok(names.every((n) => n.startsWith("wflow_")), "no user's workflow tools without a token");
});

// ---- tool metadata ----
// Directories (Smithery's quality score) and strict clients read these: every
// argument described, behaviour annotations, and an outputSchema that the
// real structuredContent must match.
function schemaErrors(schema, value, at = "$") {
  if (!schema || typeof schema !== "object") return [];
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types && !types.some((t) => t === kind || (t === "number" && kind === "integer"))) return [`${at}: ${kind} is not ${types.join("|")}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} not in enum`];
  const errs = [];
  if (kind === "object") {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${at}.${r}: missing`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) errs.push(...schemaErrors(sub, value[k], `${at}.${k}`));
  }
  if (kind === "array" && schema.items) value.forEach((v, i) => errs.push(...schemaErrors(schema.items, v, `${at}[${i}]`)));
  return errs;
}

test("every builder tool documents its arguments, behaviour and output — and answers in that shape", async () => {
  const user = tokenUser("u-meta", { access: "build" });
  const listed = (await handleRpc(user, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.filter((t) => t.name.startsWith("wflow_"));
  assert.equal(listed.length, 10);
  const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
  for (const t of listed) {
    assert.match(t.name, /^wflow_(get|list|validate|create|update|run)_/, `${t.name} is verb-first`);
    for (const [k, p] of Object.entries(t.inputSchema.properties)) assert.ok(p.description, `${t.name}.${k} has a description`);
    assert.equal(typeof t.annotations?.readOnlyHint, "boolean", `${t.name} says whether it is read-only`);
    assert.equal(t.outputSchema?.type, "object", `${t.name} has an outputSchema`);
  }
  const check = async (name, args) => {
    const r = (await call(user, name, args)).result;
    assert.equal(r.isError, undefined, `${name}: ${r.content?.[0]?.text}`);
    assert.deepEqual(schemaErrors(byName[name].outputSchema, r.structuredContent), [], name);
    return r.structuredContent;
  };
  await check("wflow_get_reference", {});
  await check("wflow_list_node_types", { query: "slack" });
  await check("wflow_get_node_type", { type: "if" });
  const draft = { name: "Meta", nodes: [node("t", "manual"), node("x", "noop")], edges: [edge("t", "x")] };
  await check("wflow_validate_workflow", { workflow: { nodes: [{ id: "a", type: "nope" }] } });
  const { workflow_id: id } = await check("wflow_create_workflow", { workflow: draft });
  await check("wflow_get_workflow", { workflow_id: id });
  await check("wflow_list_workflows", {});
  await check("wflow_update_workflow", { workflow_id: id, workflow: draft });
  const run = await check("wflow_run_workflow", { workflow_id: id, wait_seconds: 0 });
  if (run.run_id) await check("wflow_get_run", { run_id: run.run_id, wait_seconds: 5 });
  // the old name still works for assistants set up with it
  assert.equal((await call(user, "wflow_reference", {})).result.isError, undefined);
});
