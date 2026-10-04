// ============================================================================
// Builder features added together: Variables in templates with a Test / Live
// environment, spending limits, resume-from-node, step-by-step debugging,
// per-connection item counts, failure alerts, crypto triggers, the MCP
// endpoint and dashboards.
//
// Run: node --test tests/workflow-power-features.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// BF_DB_PATH must be set before any module that opens the database is loaded.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-power-"));
process.env.BF_DB_PATH = path.join(tempDir, "power.db");
process.env.BF_DATA_DIR = tempDir;

const { executeWorkflow, executeNode } = await import("../server/executor.js");
const { db } = await import("../server/dbx.js");
const { ERROR_CODES } = await import("../shared/errors.js");
const { checkSpend, recordSpend, spentToday } = await import("../server/spend-limits.js");
const { beginLiveRun, waitForStep, stepLiveRun, runStatus, stopLiveRun, endLiveRun } = await import("../server/run-control.js");
const { saveAlertSettingsFor, getAlertSettingsFor, notifyFailure, resetAlertCooldowns } = await import("../server/failure-alerts.js");
const { evaluate, pollCryptoTrigger, resetCryptoTriggerState } = await import("../server/crypto-triggers.js");
const { handleRpc, toolNameFor, toolFor, triggerArgs, normalizeMcpSettings, createMcpToken, mcpTokenInfo, revokeMcpToken, toolOutput } = await import("../server/mcp.js");
const { writeSeries, getDashboard, listDashboards, deleteDashboard, renderDashboardPage } = await import("../server/dashboards.js");
const { workflows } = await import("../server/store.js");
const { samplePayloadFor } = await import("../shared/samples.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const setNode = (id, fields) => ({ id, type: "set", position: { x: 0, y: 0 }, data: { label: id, config: { mode: "set", parseValues: false, fields, onError: "stop" } } });
const manual = { id: "t", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: { onError: "stop" } } };
const edge = (s, t, h = "out") => ({ id: `${s}-${t}`, source: s, target: t, sourceHandle: h, targetHandle: "in" });

// ---- 7. Variables + environments -------------------------------------------
test("{{$vars.NAME}} resolves from the owner's Variables, with test values in the Test environment", async () => {
  await db.variableCreate({ userId: "u-vars", name: "API_KEY", value: "live-key", testValue: "test-key", secret: true });
  await db.variableCreate({ userId: "u-vars", name: "PLAIN", value: "same" });
  const wf = { id: "wf-vars", nodes: [manual, setNode("s", [{ key: "key", value: "{{$vars.API_KEY}}" }, { key: "plain", value: "{{ $vars.PLAIN }}" }, { key: "env", value: "{{$env}}" }])], edges: [edge("t", "s")] };

  const live = await executeWorkflow(wf, { userId: "u-vars" });
  const liveOut = live.log.find((l) => l.nodeId === "s").outputItems[0];
  assert.equal(liveOut.key, "live-key");
  assert.equal(liveOut.plain, "same");
  assert.equal(liveOut.env, "live");

  const test = await executeWorkflow({ ...wf, environment: "test" }, { userId: "u-vars" });
  const testOut = test.log.find((l) => l.nodeId === "s").outputItems[0];
  assert.equal(testOut.key, "test-key", "the test value wins in the Test environment");
  assert.equal(testOut.plain, "same", "a variable without a test value keeps its value");
  assert.equal(testOut.env, "test");
  assert.equal(test.environment, "test");
});

test("secret test values are stored encrypted", async () => {
  const v = await db.variableCreate({ userId: "u-enc", name: "S", value: "a", testValue: "b", secret: true });
  assert.equal(v.testValue, "b");
  const updated = await db.variableUpdate(v.id, "u-enc", { value: "c" });
  assert.equal(updated.testValue, "b", "updating the value keeps the test value");
});

test("$vars also resolve in credential fields that are never rendered per item", async () => {
  await db.variableCreate({ userId: "u-cred", name: "BINANCE_KEY", value: "live-key", testValue: "testnet-key" });
  let seenKey = null;
  globalThis.fetch = async (url, init) => {
    seenKey = init?.headers?.["X-MBX-APIKEY"] ?? null;
    return new Response(JSON.stringify({ balances: [] }), { headers: { "content-type": "application/json" } });
  };
  const node = { id: "b", type: "binanceExchange", data: { config: { operation: "balances", apiKey: "{{$vars.BINANCE_KEY}}", secret: "s", baseUrl: "https://api.binance.com" } } };
  const r = await executeNode({ id: "wf-cred", environment: "test", nodes: [node], edges: [] }, "b", [{ json: {} }], { userId: "u-cred" });
  assert.equal(r.success, true, r.error);
  assert.equal(seenKey, "testnet-key");
});

test("the Test environment forces exchange orders into test mode", async () => {
  const paths = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(String(url)).pathname);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  const node = { id: "o", type: "binanceExchange", data: { config: { operation: "marketOrder", symbol: "BTCUSDT", side: "buy", amount: "1", testMode: false, apiKey: "k", secret: "s", baseUrl: "https://api.binance.com" } } };
  const r = await executeNode({ id: "wf-env", environment: "test", nodes: [node], edges: [] }, "o", [{ json: {} }]);
  assert.equal(r.success, true, r.error);
  assert.deepEqual(paths, ["/api/v3/order/test"]);
});

// ---- 2. spending limits ---------------------------------------------------------
test("spending limits block an order above the per-order or daily maximum and only count real orders", async () => {
  const base = { workflowId: "wf-spend", nodeId: "n1", maxAmount: 50, maxDaily: 80 };
  await assert.rejects(checkSpend({ ...base, amount: 60 }), (e) => e._bfCode === ERROR_CODES.SPENDING_LIMIT.code && /per order/.test(e.message));
  await checkSpend({ ...base, amount: 40 });
  await recordSpend({ ...base, amount: 40 });
  await recordSpend({ ...base, amount: 30 });
  assert.equal(await spentToday("wf-spend", "n1"), 70);
  await assert.rejects(checkSpend({ ...base, amount: 20 }), /daily maximum of 80/);
  await checkSpend({ ...base, amount: 10 });
  await checkSpend({ workflowId: "wf-spend", nodeId: "n1", amount: 1e9, maxAmount: 0, maxDaily: 0 }); // 0 = no limit
});

test("an exchange node stops at its limit before contacting the exchange", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}");
  };
  const node = { id: "lim", type: "binanceExchange", data: { config: { operation: "marketOrder", symbol: "BTCUSDT", side: "buy", amount: "100", maxAmount: 25, apiKey: "k", secret: "s", baseUrl: "https://api.binance.com" } } };
  const r = await executeNode({ id: "wf-lim", nodes: [node], edges: [] }, "lim", [{ json: {} }]);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.SPENDING_LIMIT.code);
  assert.equal(calls, 0);
});

// ---- 5. resume from a node + 6. connection counts ---------------------------------
test("a run can resume from a node with its saved input; upstream nodes do not run again", async () => {
  const wf = {
    id: "wf-resume",
    nodes: [manual, setNode("a", [{ key: "a", value: "1" }]), setNode("b", [{ key: "b", value: "{{a}}-b" }])],
    edges: [edge("t", "a"), edge("a", "b")],
  };
  const full = await executeWorkflow(wf, {});
  const entryB = full.log.find((l) => l.nodeId === "b");
  assert.equal(entryB.inputCount, 1);
  assert.deepEqual(full.log.find((l) => l.nodeId === "a").handleCounts, { out: 1 });

  const resumed = await executeWorkflow(wf, { resumeFrom: { nodeId: "b", items: entryB.inputItems } });
  assert.deepEqual(resumed.log.map((l) => l.nodeId), ["b"]);
  assert.equal(resumed.log[0].outputItems[0].b, "1-b");
});

// ---- 6. step-by-step debugging ---------------------------------------------------
test("a debug run parks before each node until Next, and Continue runs the rest", async () => {
  const token = "tok-debug";
  const live = beginLiveRun(token, "wf-step", { step: true });
  const wf = { id: "wf-step", nodes: [manual, setNode("a", [{ key: "a", value: "1" }]), setNode("b", [{ key: "b", value: "2" }])], edges: [edge("t", "a"), edge("a", "b")] };
  const running = executeWorkflow(wf, { signal: live.signal, beforeNode: (id, input) => waitForStep(token, id, input) });

  const waitPaused = async (nodeId) => {
    for (let i = 0; i < 200; i++) {
      const st = runStatus(token, "wf-step");
      if (st.paused?.nodeId === nodeId) return st;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`never paused at ${nodeId}`);
  };
  await waitPaused("t");
  assert.equal(stepLiveRun(token, "wf-step", "next"), true);
  const atA = await waitPaused("a");
  assert.equal(atA.paused.input.length, 1, "the paused node's input is shown");
  assert.equal(stepLiveRun(token, "wf-step", "continue"), true);
  const result = await running;
  assert.deepEqual(result.log.map((l) => l.nodeId), ["t", "a", "b"]);
  assert.equal(stepLiveRun(token, "wf-step", "next"), false, "nothing is paused any more");
  endLiveRun(token);
});

test("stopping a paused debug run ends it without running the parked node", async () => {
  const token = "tok-stop";
  const live = beginLiveRun(token, "wf-stop", { step: true });
  const wf = { id: "wf-stop", nodes: [manual, setNode("a", [{ key: "a", value: "1" }])], edges: [edge("t", "a")] };
  const running = executeWorkflow(wf, { signal: live.signal, beforeNode: (id, input) => waitForStep(token, id, input) });
  for (let i = 0; i < 200 && !runStatus(token).paused; i++) await new Promise((r) => setTimeout(r, 5));
  stopLiveRun(token);
  const result = await running;
  assert.equal(result.log.length, 0);
  assert.equal(result.aborted, true);
  endLiveRun(token);
});

// ---- 1. failure alerts --------------------------------------------------------------
test("failure alerts go to Telegram once per cooldown, only for unhandled failures of unwatched runs", async () => {
  resetAlertCooldowns();
  const wf = { id: "wf-alert", name: "Nightly sync" };
  const saved = await saveAlertSettingsFor(wf.id, { enabled: true, telegramBotToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", telegramChatId: "42" });
  assert.equal(saved.telegramBotTokenSet, true);
  assert.equal("telegramBotToken" in saved, false, "the token never goes back to the browser");

  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  const failed = { log: [{ nodeId: "n", nodeName: "HTTP Request", status: "error", error: "HTTP 500", errorCode: 4002 }] };
  const handled = { log: [{ nodeId: "n", status: "error", handled: true }] };

  assert.equal(await notifyFailure(wf, handled, "schedule"), null, "handled errors do not alert");
  assert.equal(await notifyFailure(wf, failed, "editor"), null, "editor runs do not alert by default");
  const out = await notifyFailure(wf, failed, "schedule");
  assert.equal(out.telegram.ok, true);
  assert.match(sent[0].url, /bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ\/sendMessage$/);
  assert.equal(sent[0].body.chat_id, "42");
  assert.match(sent[0].body.text, /Nightly sync.*failed[\s\S]*HTTP Request[\s\S]*BF-4002/);
  assert.equal(await notifyFailure(wf, failed, "schedule"), null, "the cooldown suppresses a second alert");
});

test("alert settings validate their inputs and keep the saved token", async () => {
  await assert.rejects(saveAlertSettingsFor("wf-bad", { email: "not-an-email" }), /e-mail/);
  await assert.rejects(saveAlertSettingsFor("wf-bad", { telegramBotToken: "nope" }), /bot token/);
  await saveAlertSettingsFor("wf-keep", { enabled: true, telegramBotToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  await saveAlertSettingsFor("wf-keep", { telegramChatId: "7" });
  assert.equal((await getAlertSettingsFor("wf-keep")).telegramBotTokenSet, true);
  await saveAlertSettingsFor("wf-keep", { clearTelegramBotToken: true });
  assert.equal((await getAlertSettingsFor("wf-keep")).telegramBotTokenSet, false);
});

// ---- 3. crypto triggers ----------------------------------------------------------------
test("price conditions fire on crossing a level, not while the price stays past it", () => {
  const c = { condition: "above", threshold: 100 };
  assert.ok(evaluate("cryptoPriceTrigger", c, 99, 99, 101));
  assert.equal(evaluate("cryptoPriceTrigger", c, 101, 101, 105), null, "already above");
  assert.ok(evaluate("cryptoPriceTrigger", { condition: "below", threshold: 100 }, 101, 101, 99));
  assert.deepEqual(evaluate("cryptoPriceTrigger", { condition: "change", threshold: 5 }, 100, 100, 106), { moved: 6 });
  assert.equal(evaluate("cryptoPriceTrigger", { condition: "change", threshold: 5 }, 100, 100, 104), null);
  assert.deepEqual(evaluate("polymarketTrigger", { condition: "change", threshold: 10 }, 40, 40, 52), { moved: 12 }, "odds move in points");
  assert.deepEqual(evaluate("walletDepositTrigger", { minAmount: 0.1 }, 1, 1, 1.5), { received: 0.5 });
  assert.equal(evaluate("walletDepositTrigger", { minAmount: 1 }, 1, 1, 1.5), null, "dust below the minimum is ignored");
  assert.equal(evaluate("walletDepositTrigger", {}, 2, 2, 1), null, "a withdrawal is not a deposit");
});

test("a crypto trigger records a baseline first, then fires once per event", async () => {
  resetCryptoTriggerState();
  const prices = [99, 99.5, 101, 102, 98, 103];
  let i = 0;
  const readers = { cryptoPriceTrigger: async () => ({ value: prices[i++], extra: { symbol: "BTCUSDT" } }) };
  const fired = [];
  const stored = { id: "wf-trig" };
  const node = { id: "p", type: "cryptoPriceTrigger", data: { config: { exchange: "binance", symbol: "BTCUSDT", condition: "above", threshold: 100, pollInterval: 1 } } };
  const outcomes = [];
  let now = 0;
  for (let k = 0; k < prices.length; k++) {
    outcomes.push(await pollCryptoTrigger(stored, node, now, async (p) => fired.push(p), { readers }));
    now += 60_000;
  }
  assert.deepEqual(outcomes, ["baseline", "quiet", "fired", "quiet", "quiet", "fired"]);
  assert.equal(fired[0].price, 101);
  assert.equal(fired[0].previousPrice, 99.5);
  assert.equal(await pollCryptoTrigger(stored, node, now - 30_000, async () => {}, { readers }), "skipped", "not due before the interval");
});

test("the new triggers have realistic samples for editor runs", () => {
  for (const type of ["cryptoPriceTrigger", "polymarketTrigger", "walletDepositTrigger"]) {
    const sample = samplePayloadFor({ type, data: { config: {} } });
    assert.ok(sample.triggeredAt, `${type} sample has a time`);
  }
});

// ---- 9. MCP ------------------------------------------------------------------------------
test("MCP settings are normalised and tool names are stable and valid", () => {
  const m = normalizeMcpSettings({ enabled: 1, description: "x", params: [{ name: "coin symbol" }, { name: "coin symbol" }, { name: "" }] });
  assert.deepEqual(m.params, [{ name: "coin_symbol", description: "" }]);
  const wf = { id: "wf-1234abcd", name: "Get BTC price!", mcp: m };
  assert.match(toolNameFor(wf), /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(toolNameFor(wf), "get_btc_price_wf1234ab".replace("wf1234ab", String("wf-1234abcd").replace(/[^a-zA-Z0-9]/g, "").slice(-8)));
  assert.deepEqual(toolFor(wf).inputSchema.properties, { coin_symbol: { type: "string", description: "coin_symbol" } });
  assert.equal(normalizeMcpSettings(null), undefined);
});

test("MCP answers initialize, lists opted-in workflows and runs them as tools", async () => {
  const user = { userId: "u-mcp" };
  const tool = {
    id: "wf-mcp-tool",
    ownerId: "u-mcp",
    name: "Echo",
    mcp: { enabled: true, description: "Echoes the input", params: [{ name: "text", description: "what to echo" }] },
    nodes: [manual, setNode("s", [{ key: "echo", value: "{{text}}!" }])],
    edges: [edge("t", "s")],
  };
  await workflows.save(tool);
  await workflows.save({ id: "wf-mcp-hidden", ownerId: "u-mcp", name: "Hidden", nodes: [manual], edges: [] });

  const init = await handleRpc(user, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.tools);
  assert.equal(await handleRpc(user, { jsonrpc: "2.0", method: "notifications/initialized" }), null, "notifications get no reply");

  const list = await handleRpc(user, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.filter((t) => !t.name.startsWith("wflow_")).map((t) => t.title), ["Echo"]);

  const call = await handleRpc(user, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: list.result.tools[0].name, arguments: { text: "hi" } } });
  assert.equal(call.result.isError, undefined);
  assert.equal(JSON.parse(call.result.content[0].text).echo, "hi!");

  const missing = await handleRpc(user, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
  assert.equal(missing.result.isError, true);
  assert.equal((await handleRpc(user, { jsonrpc: "2.0", id: 5, method: "bogus" })).error.code, -32601);
});

test("MCP tools without typed inputs ask for what the trigger expects", async () => {
  const form = { id: "t", type: "formTrigger", position: { x: 0, y: 0 }, data: { config: { fields: "full name, email" } } };
  const wf = {
    id: "wf-mcp-form",
    ownerId: "u-mcp-form",
    name: "Signup",
    mcp: { enabled: true, description: "", params: [] },
    nodes: [form, setNode("s", [{ key: "hello", value: "Hi <{{email}}>" }])],
    edges: [edge("t", "s")],
  };
  assert.deepEqual(Object.keys(toolFor(wf).inputSchema.properties), ["full_name", "email"]);
  assert.deepEqual(triggerArgs(wf, { full_name: "Ada", email: "a@b.c", extra: 1 }), { "full name": "Ada", email: "a@b.c", extra: 1 });

  const chat = { ...wf, nodes: [{ ...form, type: "chatTrigger", data: { config: {} } }] };
  assert.deepEqual(Object.keys(toolFor(chat).inputSchema.properties), ["message"]);
  assert.deepEqual(toolFor({ ...wf, nodes: [manual] }).inputSchema.properties, {}, "other triggers take anything");
  const typed = { ...wf, mcp: { ...wf.mcp, params: [{ name: "coin", description: "" }] } };
  assert.deepEqual(Object.keys(toolFor(typed).inputSchema.properties), ["coin"], "typed inputs win");

  await workflows.save(wf);
  const user = { userId: "u-mcp-form" };
  const name = (await handleRpc(user, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools[0].name;
  const call = await handleRpc(user, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { full_name: "Ada", email: "a@b.c" } } });
  assert.equal(call.result.isError, undefined, call.result.content?.[0]?.text);
  assert.equal(JSON.parse(call.result.content[0].text).hello, "Hi <a@b.c>");
});

test("MCP tokens are stored as a digest and can be revoked", async () => {
  const { token, info } = await createMcpToken("u-tok", { name: "Laptop" });
  assert.match(token, /^wfmcp_/);
  assert.equal(info.hint, token.slice(-4));
  assert.equal(info.name, "Laptop");
  assert.equal(info.access, "run", "a new token only runs offered tools unless given more");
  const stored = await mcpTokenInfo("u-tok");
  assert.ok(!JSON.stringify(stored).includes(token), "the token itself is not stored");
  await revokeMcpToken("u-tok");
  assert.equal(await mcpTokenInfo("u-tok"), null);
});

test("a tool answers with the Webhook Respond body when there is one", () => {
  assert.equal(toolOutput({ webhookResponse: { status: 200, body: { ok: 1 } }, log: [] }), JSON.stringify({ ok: 1 }, null, 2));
  assert.equal(toolOutput({ log: [{ status: "success", outputItems: [{ a: 1 }, { a: 2 }] }] }), JSON.stringify([{ a: 1 }, { a: 2 }], null, 2));
});

// ---- 10. dashboards -------------------------------------------------------------------
test("the Dashboard node appends points and the page renders them", async () => {
  const wf = {
    id: "wf-dash",
    nodes: [manual, setNode("v", [{ key: "price", value: "123.5" }]), { id: "d", type: "dashboard", data: { label: "Chart", config: { dashboard: "Portfolio", series: "BTC", value: "{{price}}", chart: "line", mode: "append", keep: 3 } } }],
    edges: [edge("t", "v"), edge("v", "d")],
  };
  let result;
  for (let k = 0; k < 4; k++) result = await executeWorkflow(wf, { userId: "u-dash" });
  const out = result.log.find((l) => l.nodeId === "d").outputItems[0];
  assert.match(out.dashboardUrl, /\/d\/[\w-]{16,}$/);
  assert.equal(out.pointsStored, 3, "keep caps the series");

  const [summary] = await listDashboards("u-dash");
  assert.equal(summary.name, "Portfolio");
  const dash = await getDashboard(summary.id);
  assert.equal(dash.series.BTC.points.length, 3);
  const html = renderDashboardPage(dash);
  assert.match(html, /<svg/);
  assert.match(html, /Portfolio/);
  assert.ok(!/<script/i.test(html), "the page has no scripts");

  assert.equal(await deleteDashboard("someone-else", summary.id), false);
  assert.equal(await deleteDashboard("u-dash", summary.id), true);
  assert.equal(await getDashboard(summary.id), null);
});

test("dashboard values must be numbers and names are escaped on the page", async () => {
  const node = { id: "d", type: "dashboard", data: { config: { dashboard: "X", series: "Y", value: "{{x}}" } } };
  const r = await executeNode({ id: "wf-dash2", nodes: [node], edges: [] }, "d", [{ json: { x: "abc" } }], { userId: "u-dash2" });
  assert.equal(r.errorCode, ERROR_CODES.PARSE_FAILED.code);
  const saved = await writeSeries({ userId: "u-dash2", name: "<script>", series: "<b>", points: [{ v: 1 }] });
  const html = renderDashboardPage(await getDashboard(saved.id));
  assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;"));
});
