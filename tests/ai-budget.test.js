// ============================================================================
// AI spending control (server/ai-budget.js, server/ai-usage.js): budgets with
// a hard stop (BF-5006), warnings in the run log and on Telegram, the
// cheaper-model fallback, the per-node token cap, reusing identical answers,
// the usage dashboard and the per-workflow estimate.
//
// The model provider is a stub; nothing leaves the machine.
// Run: node --test tests/ai-budget.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-aibudget-"));
process.env.BF_DB_PATH = path.join(tempDir, "aibudget.db");
process.env.BF_DATA_DIR = tempDir;

const { db } = await import("../server/dbx.js");
const { executeWorkflow } = await import("../server/executor.js");
const { ERROR_CODES } = await import("../shared/errors.js");
const { saveAccountSettings, normalizeBudget, requestHash } = await import("../server/ai-budget.js");
const { usageDashboard, workflowEstimate } = await import("../server/ai-usage.js");
const { savePriceSettings } = await import("../server/ai-cost.js");
const { connectBot } = await import("../server/telegram-bots.js");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

// ---- a stub provider: every call uses 100 tokens ----
let calls = [];
let telegram = [];
beforeEach(() => {
  calls = [];
  telegram = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop();
      telegram.push({ method, body: init.body ? JSON.parse(init.body) : {} });
      const result = method === "getMe" ? { id: 42, is_bot: true, username: "budget_bot", first_name: "Budget" } : { message_id: 1 };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(init.body || "{}");
    calls.push(body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `answer from ${body.model}` }, finish_reason: "stop" }], usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
});

const chatNode = (config = {}) => ({
  id: "ai",
  type: "aiChat",
  position: { x: 0, y: 0 },
  data: { label: "Ask", config: { provider: "openai", baseUrl: "https://model.test/v1", apiKey: "k", model: "big-model", maxTokens: 500, prompt: "{{q}}", onError: "stop", ...config } },
});
const manual = { id: "t", type: "manual", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } };
const split = (n) => ({ id: "sp", type: "code", position: { x: 0, y: 0 }, data: { label: "Items", config: { code: `return ${JSON.stringify(Array.from({ length: n }, (_, i) => ({ json: { q: `q${i}` } })))};`, onError: "stop" } } });
const wf = (id, ownerId, nodes, extra = {}) => ({
  id,
  ownerId,
  name: id,
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id, sourceHandle: "out", targetHandle: "in" })),
  ...extra,
});

async function seedUsage(ownerId, workflowId, tokens, costUsd = 0, startedAt = new Date().toISOString()) {
  await db.executionsSave({
    workflowId,
    ownerId,
    source: "editor",
    startedAt,
    finishedAt: startedAt,
    durationMs: 1,
    success: true,
    nodeCount: 1,
    errorCount: 0,
    promptTokens: tokens,
    completionTokens: 0,
    aiCostUsd: costUsd,
    result: { log: [{ nodeId: "ai", nodeName: "Ask", nodeType: "aiChat", status: "success", usage: { prompt: tokens, completion: 0, total: tokens, model: "big-model" } }] },
  });
}

const aiLog = (res) => res.log.find((l) => l.nodeId === "ai");

// ---- budgets ----
test("a used-up daily token budget stops the call with BF-5006 and says so in the log", async () => {
  await saveAccountSettings("u-stop", { daily: { tokens: 1000 } });
  await seedUsage("u-stop", "other", 1000);
  const res = await executeWorkflow(wf("wf-stop", "u-stop", [manual, chatNode()]), { userId: "u-stop" });
  assert.equal(calls.length, 0, "the model was not called");
  assert.equal(aiLog(res).errorCode, ERROR_CODES.AI_BUDGET_EXCEEDED.code);
  assert.match(aiLog(res).error, /account daily budget is used up/);
  assert.ok(res.consoleLog.some((l) => /⛔ AI budget reached/.test(l)), res.consoleLog.join("\n"));
});

test("output is capped to what the budget has left, and 80 % warns once", async () => {
  await saveAccountSettings("u-cap", { monthly: { tokens: 1000 } });
  await seedUsage("u-cap", "other", 850);
  const res = await executeWorkflow(wf("wf-cap", "u-cap", [manual, chatNode()]), { userId: "u-cap" });
  assert.equal(calls[0].max_tokens, 150, "never more output than the budget has left");
  assert.equal(aiLog(res).status, "success");
  assert.equal(res.consoleLog.filter((l) => /AI budget warning/.test(l)).length, 1, res.consoleLog.join("\n"));
});

test("a workflow's own budget applies to that workflow only", async () => {
  await seedUsage("u-wf", "wf-limited", 600);
  const limited = wf("wf-limited", "u-wf", [manual, chatNode()], { aiBudget: normalizeBudget({ daily: { tokens: 500 } }) });
  const blocked = await executeWorkflow(limited, { userId: "u-wf" });
  assert.equal(aiLog(blocked).errorCode, ERROR_CODES.AI_BUDGET_EXCEEDED.code);
  assert.match(aiLog(blocked).error, /workflow “wf-limited” daily budget/);
  const free = await executeWorkflow(wf("wf-free", "u-wf", [manual, chatNode()]), { userId: "u-wf" });
  assert.equal(aiLog(free).status, "success");
});

test("a USD budget counts the priced cost of the calls", async () => {
  await savePriceSettings("u-usd", { prices: { "big-model": { input: 10000, output: 10000 } }, fallback: { input: 0, output: 0 } });
  await saveAccountSettings("u-usd", { daily: { usd: 1 } });
  // 100 tokens at $10,000 / 1M = $1 — the first call fits, the second is refused.
  const res = await executeWorkflow(wf("wf-usd", "u-usd", [manual, split(2), chatNode()]), { userId: "u-usd" });
  assert.equal(calls.length, 1);
  assert.equal(aiLog(res).errorCode, ERROR_CODES.AI_BUDGET_EXCEEDED.code);
});

test("the cheaper-model fallback takes over from its threshold", async () => {
  await saveAccountSettings("u-fb", { daily: { tokens: 1000 }, fallback: { enabled: true, model: "small-model", at: 50 } });
  await seedUsage("u-fb", "other", 600);
  const res = await executeWorkflow(wf("wf-fb", "u-fb", [manual, chatNode()]), { userId: "u-fb" });
  assert.equal(calls[0].model, "small-model");
  assert.equal(aiLog(res).usage.model, "small-model", "the call is priced with the model that answered");
  assert.ok(res.consoleLog.some((l) => /cheaper model small-model/.test(l)));
});

// ---- per node ----
test("a node's token cap limits it across its items in one run", async () => {
  const res = await executeWorkflow(wf("wf-nodecap", "u-nodecap", [manual, split(3), chatNode({ maxRunTokens: 150 })]), { userId: "u-nodecap" });
  assert.deepEqual(calls.map((c) => c.max_tokens), [150, 50], "the second call only gets what is left");
  assert.equal(aiLog(res).errorCode, ERROR_CODES.AI_BUDGET_EXCEEDED.code);
  assert.match(aiLog(res).error, /reached its cap of 150 tokens/);
});

test("identical requests reuse the saved answer when the node allows it", async () => {
  const flow = wf("wf-reuse", "u-reuse", [manual, split(1), chatNode({ reuseAnswers: true, reuseHours: 1 })]);
  const first = await executeWorkflow(flow, { userId: "u-reuse" });
  const second = await executeWorkflow(flow, { userId: "u-reuse" });
  assert.equal(calls.length, 1, "the second run did not call the model");
  assert.equal(aiLog(second).outputItems[0].reply, aiLog(first).outputItems[0].reply);
  assert.ok(second.consoleLog.some((l) => /Reused a saved answer/.test(l)));
  const off = await executeWorkflow(wf("wf-noreuse", "u-reuse", [manual, split(1), chatNode()]), { userId: "u-reuse" });
  assert.equal(calls.length, 2, "without the switch every run calls the model");
  assert.ok(off);
  assert.notEqual(requestHash("a", { model: "m" }, [{ role: "user", content: "x" }]), requestHash("b", { model: "m" }, [{ role: "user", content: "x" }]), "answers are never shared between accounts");
});

// ---- alerts ----
test("budget alerts go to the connected Telegram bot once per threshold", async () => {
  const bot = await connectBot("u-tg", "123456789:AAbbccddeeffgghhiijjkkllmmnnooppqqrr");
  await saveAccountSettings("u-tg", { daily: { tokens: 1000 }, alerts: { telegram: true, botId: bot.id, chatId: "777" } });
  await seedUsage("u-tg", "other", 850);
  telegram = [];
  await executeWorkflow(wf("wf-tg", "u-tg", [manual, chatNode()]), { userId: "u-tg" });
  await executeWorkflow(wf("wf-tg", "u-tg", [manual, chatNode()]), { userId: "u-tg" });
  const sent = telegram.filter((t) => t.method === "sendMessage");
  assert.equal(sent.length, 1, "the 80 % warning is sent once, not per run");
  assert.equal(sent[0].body.chat_id, "777");
  assert.match(sent[0].body.text, /AI budget warning/);
});

// ---- dashboard + estimate ----
test("the usage dashboard groups tokens and cost by day, workflow, model and node", async () => {
  await savePriceSettings("u-dash", { prices: { "big-model": { input: 1, output: 1 } }, fallback: { input: 0, output: 0 } });
  await seedUsage("u-dash", "wf-a", 1000, 0.01);
  await seedUsage("u-dash", "wf-b", 3000, 0.03);
  await seedUsage("u-dash", "wf-b", 50, 0, "2000-01-01T00:00:00.000Z");
  const d = await usageDashboard("u-dash", { days: 7, workflowNames: { "wf-b": "Big one" } });
  assert.equal(d.byDay.length, 7);
  assert.equal(d.totals.tokens, 4000, "runs outside the window are left out");
  assert.deepEqual(d.byWorkflow.map((w) => w.name), ["Big one", "wf-a"]);
  assert.equal(d.byModel[0].model, "big-model");
  assert.equal(d.topNodes[0].workflowId, "wf-b");
});

test("the workflow estimate averages recent runs per node and shows the budgets", async () => {
  await saveAccountSettings("u-est", { daily: { tokens: 10000 } });
  await seedUsage("u-est", "wf-est", 200);
  await seedUsage("u-est", "wf-est", 400);
  const est = await workflowEstimate("u-est", wf("wf-est", "u-est", [manual, chatNode({ maxRunTokens: 900 })]));
  assert.equal(est.basedOnRuns, 2);
  assert.equal(est.perRun.tokens, 300);
  assert.deepEqual([est.nodes[0].nodeId, est.nodes[0].avgTokens, est.nodes[0].tokenCap], ["ai", 300, 900]);
  assert.equal(est.budgets[0].used, 600);
});

test("deleting an account erases its budgets and saved answers", async () => {
  const { forgetAccount, getAccountSettings } = await import("../server/ai-budget.js");
  await saveAccountSettings("u-forget", { daily: { tokens: 5 } });
  await executeWorkflow(wf("wf-forget", "u-forget", [manual, split(1), chatNode({ reuseAnswers: true })]), { userId: "u-forget" });
  assert.ok(JSON.parse((await db.storeGet("ai.cache.index.u-forget")) || "[]").length, "an answer was saved");
  await forgetAccount("u-forget");
  assert.equal((await getAccountSettings("u-forget")).daily.tokens, 0);
  assert.equal((await db.storeGet("ai.cache.index.u-forget")) || "", "");
});
