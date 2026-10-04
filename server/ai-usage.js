// ============================================================================
// W FLOW — AI usage dashboard and per-workflow cost preview
//
// Both are read from the runs already in the executions table (every run keeps
// its token counts, its estimated cost and each node's usage with the model),
// so nothing extra is recorded while a workflow runs.
//
//   usageDashboard  — Settings → AI usage & cost: tokens and cost per day, per
//                     workflow, per model, the most expensive nodes, and how
//                     far each budget is used.
//   workflowEstimate — the editor's "AI cost" button: what the next run will
//                     probably use (average of recent runs, per node), what
//                     today / this month used, and the budgets that apply.
// ============================================================================
import { db } from "./dbx.js";
import { getPriceSettings, costOfUsage } from "./ai-cost.js";
import { getAccountSettings, normalizeBudget, usedSoFar, budgetStatus } from "./ai-budget.js";
import { NODES } from "../shared/catalog.js";

const DAY_MS = 86_400_000;
const tokensOf = (u) => Number(u?.total || 0) || Number(u?.prompt || 0) + Number(u?.completion || 0);

/** Budget status for the account and (optionally) one workflow, as the UI shows it. */
export async function budgetOverview(ownerId, workflow = null) {
  const [settings, used] = await Promise.all([getAccountSettings(ownerId), usedSoFar(ownerId, workflow?.id)]);
  const status = budgetStatus({ settings, workflowBudget: normalizeBudget(workflow?.aiBudget), used, run: { tokens: 0, costUsd: 0 }, workflowName: workflow?.name || "" });
  return { settings, used, status };
}

export async function usageDashboard(ownerId, { days = 30, workflowNames = {} } = {}) {
  const span = Math.max(1, Math.min(90, Math.floor(Number(days) || 30)));
  const since = new Date(Date.now() - (span - 1) * DAY_MS);
  since.setUTCHours(0, 0, 0, 0);
  const [runs, prices, overview] = await Promise.all([db.executionsAiRuns(ownerId, since.toISOString()), getPriceSettings(ownerId), budgetOverview(ownerId)]);

  const byDay = new Map();
  for (let i = 0; i < span; i++) byDay.set(new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10), { tokens: 0, costUsd: 0, runs: 0 });
  const byWorkflow = new Map();
  const byModel = new Map();
  const byNode = new Map();
  const totals = { tokens: 0, prompt: 0, completion: 0, costUsd: 0, runs: runs.length };

  for (const r of runs) {
    const tokens = r.promptTokens + r.completionTokens;
    totals.tokens += tokens;
    totals.prompt += r.promptTokens;
    totals.completion += r.completionTokens;
    totals.costUsd += r.aiCostUsd;
    const day = byDay.get(String(r.startedAt).slice(0, 10));
    if (day) {
      day.tokens += tokens;
      day.costUsd += r.aiCostUsd;
      day.runs += 1;
    }
    const wf = byWorkflow.get(r.workflowId) || { workflowId: r.workflowId, name: workflowNames[r.workflowId] || r.workflowId, tokens: 0, costUsd: 0, runs: 0 };
    wf.tokens += tokens;
    wf.costUsd += r.aiCostUsd;
    wf.runs += 1;
    byWorkflow.set(r.workflowId, wf);
    for (const c of r.calls) {
      const t = tokensOf(c.usage);
      const cost = costOfUsage(c.usage, prices) || 0;
      const model = String(c.usage?.model || "unknown");
      const m = byModel.get(model) || { model, tokens: 0, costUsd: 0, calls: 0 };
      m.tokens += t;
      m.costUsd += cost;
      m.calls += 1;
      byModel.set(model, m);
      const key = `${r.workflowId}|${c.nodeId}`;
      const n = byNode.get(key) || { workflowId: r.workflowId, workflowName: wf.name, nodeId: c.nodeId, nodeName: c.nodeName, nodeType: c.nodeType, tokens: 0, costUsd: 0, runs: 0 };
      n.tokens += t;
      n.costUsd += cost;
      n.runs += 1;
      byNode.set(key, n);
    }
  }
  const expensiveFirst = (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens;
  return {
    days: span,
    totals,
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })),
    byWorkflow: [...byWorkflow.values()].sort(expensiveFirst),
    byModel: [...byModel.values()].sort(expensiveFirst),
    topNodes: [...byNode.values()].sort(expensiveFirst).slice(0, 10),
    budgets: overview.status,
    // runs that called a model but whose model has no price show tokens only
    unpriced: [...byModel.values()].some((m) => m.tokens && !m.costUsd),
  };
}

export async function workflowEstimate(ownerId, workflow) {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const [runs, prices, overview] = await Promise.all([db.executionsAiRuns(ownerId, since, 400), getPriceSettings(ownerId), budgetOverview(ownerId, workflow)]);
  const recent = runs.filter((r) => r.workflowId === workflow.id).slice(0, 10);
  const perNode = new Map();
  for (const r of recent) {
    for (const c of r.calls) {
      const n = perNode.get(c.nodeId) || { nodeId: c.nodeId, nodeName: c.nodeName, nodeType: c.nodeType, tokens: 0, costUsd: 0, runs: 0, model: "" };
      n.tokens += tokensOf(c.usage);
      n.costUsd += costOfUsage(c.usage, prices) || 0;
      n.runs += 1;
      n.model = c.usage?.model || n.model;
      perNode.set(c.nodeId, n);
    }
  }
  const count = recent.length;
  const avg = (sum) => (count ? sum / count : 0);
  const runTokens = recent.map((r) => r.promptTokens + r.completionTokens);
  // AI nodes in the workflow that have not run yet — shown with their settings.
  const aiNodes = (workflow.nodes || []).filter((n) => NODES[n.type]?.kind === "ai" || (NODES[n.type]?.defaults && "model" in NODES[n.type].defaults && "provider" in NODES[n.type].defaults));
  const nodes = aiNodes.map((n) => {
    const seen = perNode.get(n.id);
    const cfg = n.data?.config || {};
    return {
      nodeId: n.id,
      nodeName: n.data?.label || NODES[n.type]?.name || n.type,
      nodeType: n.type,
      model: seen?.model || cfg.model || "",
      avgTokens: seen ? Math.round(seen.tokens / count) : null,
      avgCostUsd: seen ? seen.costUsd / count : null,
      maxOutputTokens: Number(cfg.maxTokens) || null,
      tokenCap: Number(cfg.maxRunTokens) || 0,
      reuseAnswers: !!cfg.reuseAnswers,
    };
  });
  return {
    basedOnRuns: count,
    perRun: {
      tokens: Math.round(avg(runTokens.reduce((a, b) => a + b, 0))),
      minTokens: count ? Math.min(...runTokens) : 0,
      maxTokens: count ? Math.max(...runTokens) : 0,
      costUsd: avg(recent.reduce((a, r) => a + r.aiCostUsd, 0)),
    },
    nodes,
    used: {
      workflow: overview.used.workflow,
      account: overview.used.account,
    },
    budgets: overview.status,
    fallback: overview.settings.fallback,
  };
}
