/**
 * AI spending control in the UI (server/ai-budget.js, server/ai-usage.js):
 *
 *   AiUsagePanel        — Settings → AI usage & cost: tokens / cost per day,
 *                         per workflow, per model and the most expensive nodes.
 *   AiBudgetPanel       — the account's budgets, the cheaper-model fallback and
 *                         where alerts go (the run log always; Telegram optional).
 *   WorkflowBudgetSection — one workflow's own budget (Workflow settings).
 *   AiCostButton        — the editor's "AI cost" button: what the next run will
 *                         probably use, today's / this month's usage, budgets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CircleDollarSign, Gauge, Send, X } from "lucide-react";
import { api } from "../api";
import type { AiAccountBudget, AiBudget, AiBudgetStatus, AiUsageDashboard, AiWorkflowEstimate } from "../types";
import Select from "./Select";

// ---- formatting ----
export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en");
export const fmtUsd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmtLimit = (s: AiBudgetStatus, v: number) => (s.unit === "usd" ? fmtUsd(v) : `${fmtTokens(v)} tokens`);

// ---- budget bars ----
/** One row per configured limit: how much is used, coloured (with a word) by state. */
export function BudgetBars({ status, workflowName }: { status: AiBudgetStatus[]; workflowName?: string }) {
  if (!status.length) return <div className="field-help">No budget set — runs can use any number of tokens.</div>;
  return (
    <div className="ai-budget-bars">
      {status.map((s, i) => {
        const pct = Math.min(100, s.pct);
        const state = s.pct >= 100 ? "over" : s.pct >= 80 ? "near" : "ok";
        return (
          <div className="ai-budget-bar" key={i}>
            <div className="ai-budget-bar-head">
              <span>
                {s.scope === "account" ? "Account" : workflowName ? `Workflow “${workflowName}”` : "This workflow"} · {s.window === "daily" ? "today" : "this month"}
              </span>
              <span className={`ai-budget-state ai-budget-${state}`}>
                {state === "over" && <AlertTriangle size={11} />} {fmtLimit(s, s.used)} of {fmtLimit(s, s.limit)} ·{" "}
                {state === "over" ? "used up" : state === "near" ? `${Math.floor(s.pct)} % — nearly used up` : `${Math.floor(s.pct)} %`}
              </span>
            </div>
            <div className="ai-budget-track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
              <div className={`ai-budget-fill ai-budget-${state}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- daily chart ----
// One series (tokens OR cost — never both on two axes), thin bars with a
// rounded top, a recessive grid and a tooltip per bar.
function DailyChart({ data, metric }: { data: AiUsageDashboard["byDay"]; metric: "tokens" | "costUsd" }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 180;
  const pad = { l: 44, r: 8, t: 10, b: 22 };
  const max = Math.max(...data.map((d) => d[metric]), metric === "tokens" ? 10 : 0.01);
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(18, slot - 2));
  const fmt = (v: number) => (metric === "tokens" ? fmtTokens(v) : fmtUsd(v));
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const label = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="ai-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${metric === "tokens" ? "Tokens" : "Cost"} per day`} onMouseLeave={() => setHover(null)}>
        {ticks.map((v, i) => {
          const y = pad.t + innerH - (v / max) * innerH;
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="ai-chart-grid" />
              <text x={pad.l - 6} y={y + 3} textAnchor="end" className="ai-chart-axis">
                {fmt(v)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const v = d[metric];
          const bh = v > 0 ? Math.max(2, (v / max) * innerH) : 0;
          const x = pad.l + i * slot + (slot - barW) / 2;
          const y = pad.t + innerH - bh;
          const r = Math.min(4, barW / 2, bh);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              {/* hit target larger than the bar */}
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={innerH} fill="transparent" />
              {bh > 0 && (
                <path
                  className={`ai-chart-bar${hover === i ? " active" : ""}`}
                  d={`M${x},${y + bh} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + bh} Z`}
                />
              )}
            </g>
          );
        })}
        {[0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
          <text key={i} x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="ai-chart-axis">
            {label(data[i].day)}
          </text>
        ))}
      </svg>
      {h && (
        <div className="ai-chart-tip">
          <b>{label(h.day)}</b> · {fmtTokens(h.tokens)} tokens · {fmtUsd(h.costUsd)} · {h.runs} run{h.runs === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

// ---- usage dashboard ----
export function AiUsagePanel() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"tokens" | "costUsd">("tokens");
  const [data, setData] = useState<AiUsageDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api.aiBudget
      .usage(days)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(String((err as Error).message || err)));
  }, [days]);

  return (
    <div className="ai-usage">
      <div className="ai-usage-filters">
        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
        <div className="seg">
          <button className={metric === "tokens" ? "active" : ""} onClick={() => setMetric("tokens")}>
            Tokens
          </button>
          <button className={metric === "costUsd" ? "active" : ""} onClick={() => setMetric("costUsd")}>
            Cost
          </button>
        </div>
      </div>
      {error && <div className="settings-note err">{error}</div>}
      {!data && !error && <div className="run-loading"><span className="spinner" /> Loading usage…</div>}
      {data && (
        <>
          <div className="ai-tiles">
            <div className="ai-tile">
              <div className="ai-tile-label">Tokens</div>
              <div className="ai-tile-value">{fmtTokens(data.totals.tokens)}</div>
              <div className="ai-tile-sub">
                {fmtTokens(data.totals.prompt)} in · {fmtTokens(data.totals.completion)} out
              </div>
            </div>
            <div className="ai-tile">
              <div className="ai-tile-label">Estimated cost</div>
              <div className="ai-tile-value">{fmtUsd(data.totals.costUsd)}</div>
              <div className="ai-tile-sub">{data.unpriced ? "some models have no price — see the table below" : "at your price table"}</div>
            </div>
            <div className="ai-tile">
              <div className="ai-tile-label">Runs with AI</div>
              <div className="ai-tile-value">{data.totals.runs}</div>
              <div className="ai-tile-sub">in the last {data.days} days</div>
            </div>
          </div>
          {data.totals.tokens === 0 ? (
            <div className="field-help">No model calls in this period yet.</div>
          ) : (
            <>
              <DailyChart data={data.byDay} metric={metric} />
              <div className="ai-tables">
                <UsageTable title="By workflow" rows={data.byWorkflow.slice(0, 8).map((w) => ({ key: w.workflowId, name: w.name, tokens: w.tokens, costUsd: w.costUsd, extra: `${w.runs} runs` }))} />
                <UsageTable title="By model" rows={data.byModel.map((m) => ({ key: m.model, name: m.model, tokens: m.tokens, costUsd: m.costUsd, extra: `${m.calls} calls` }))} />
              </div>
              <UsageTable
                title="Most expensive nodes"
                rows={data.topNodes.map((n) => ({ key: `${n.workflowId}|${n.nodeId}`, name: `${n.nodeName} · ${n.workflowName}`, tokens: n.tokens, costUsd: n.costUsd, extra: `${n.runs} runs` }))}
              />
            </>
          )}
          <div className="field-label" style={{ marginTop: 10 }}>
            Budgets
          </div>
          <BudgetBars status={data.budgets} />
        </>
      )}
    </div>
  );
}

function UsageTable({ title, rows }: { title: string; rows: Array<{ key: string; name: string; tokens: number; costUsd: number; extra: string }> }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <div className="ai-table">
      <div className="ai-table-title">{title}</div>
      {rows.map((r) => (
        <div className="ai-table-row" key={r.key}>
          <span className="ai-table-name" title={r.name}>
            {r.name}
          </span>
          <span className="ai-table-spark" aria-hidden="true">
            <span style={{ width: `${(r.tokens / max) * 100}%` }} />
          </span>
          <span className="ai-table-num">{fmtTokens(r.tokens)}</span>
          <span className="ai-table-num">{fmtUsd(r.costUsd)}</span>
          <span className="ai-table-extra">{r.extra}</span>
        </div>
      ))}
    </div>
  );
}

// ---- account budget + alerts ----
function WindowInputs({ label, value, onChange }: { label: string; value: { tokens: number; usd: number }; onChange: (v: { tokens: number; usd: number }) => void }) {
  return (
    <div className="ai-window">
      <div className="ai-window-label">{label}</div>
      <label>
        <span>Tokens</span>
        <input type="number" min={0} step={1000} value={value.tokens || ""} placeholder="no limit" onChange={(e) => onChange({ ...value, tokens: Math.max(0, Number(e.target.value) || 0) })} />
      </label>
      <label>
        <span>USD</span>
        <input type="number" min={0} step={0.5} value={value.usd || ""} placeholder="no limit" onChange={(e) => onChange({ ...value, usd: Math.max(0, Number(e.target.value) || 0) })} />
      </label>
    </div>
  );
}

export function AiBudgetPanel() {
  const [draft, setDraft] = useState<AiAccountBudget | null>(null);
  const [status, setStatus] = useState<AiBudgetStatus[]>([]);
  const [bots, setBots] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.aiBudget
      .get()
      .then((o) => {
        setDraft(o.settings);
        setStatus(o.status);
        setBots(o.bots || []);
      })
      .catch((err) => setMsg({ ok: false, text: String((err as Error).message || err) }));
  }, []);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const o = await api.aiBudget.save(draft);
      setDraft(o.settings);
      setStatus(o.status);
      setMsg({ ok: true, text: "Budgets saved — they apply from the next model call." });
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await api.aiBudget.testAlert();
      setMsg({ ok: true, text: "Test message sent — check Telegram." });
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  if (!draft) return msg ? <div className="settings-note err">{msg.text}</div> : <div className="run-loading"><span className="spinner" /> Loading budgets…</div>;
  const set = (p: Partial<AiAccountBudget>) => setDraft({ ...draft, ...p });
  return (
    <div className="ai-budget-form">
      <div className="settings-intro">
        Limits for every workflow of this account together. When one is used up, model calls stop with <code>BF-5006</code> until the day or
        month is over; a call never gets more output tokens than a token budget has left. A workflow can have its own, stricter budget in its
        settings.
      </div>
      <div className="ai-windows">
        <WindowInputs label="Per day (UTC)" value={draft.daily} onChange={(daily) => set({ daily })} />
        <WindowInputs label="Per month" value={draft.monthly} onChange={(monthly) => set({ monthly })} />
      </div>

      <label className="exec-loop-toggle">
        <input type="checkbox" checked={draft.fallback.enabled} onChange={(e) => set({ fallback: { ...draft.fallback, enabled: e.target.checked } })} />
        <span className="toggle-label">{draft.fallback.enabled ? "ON" : "OFF"}</span>
        <span className="exec-loop-toggle-text">Switch to a cheaper model when a budget is nearly used up</span>
      </label>
      {draft.fallback.enabled && (
        <div className="ai-fallback">
          <label>
            <span>Cheaper model</span>
            <input value={draft.fallback.model} placeholder="e.g. gpt-4o-mini" onChange={(e) => set({ fallback: { ...draft.fallback, model: e.target.value } })} />
          </label>
          <label>
            <span>From (% of a budget)</span>
            <input type="number" min={1} max={99} value={draft.fallback.at} onChange={(e) => set({ fallback: { ...draft.fallback, at: Number(e.target.value) || 80 } })} />
          </label>
          <div className="field-help">The same provider and key answer with this model instead. At 100 % calls still stop.</div>
        </div>
      )}

      <div className="field-label" style={{ marginTop: 12 }}>
        Alerts at 80 % and 100 %
      </div>
      <div className="field-help">Always written into the run's log (Log console). Optionally also sent to Telegram, once per budget and threshold.</div>
      <label className="exec-loop-toggle">
        <input type="checkbox" checked={draft.alerts.telegram} onChange={(e) => set({ alerts: { ...draft.alerts, telegram: e.target.checked } })} />
        <span className="toggle-label">{draft.alerts.telegram ? "ON" : "OFF"}</span>
        <span className="exec-loop-toggle-text">Also send them to Telegram</span>
      </label>
      {draft.alerts.telegram && (
        <div className="ai-fallback">
          {bots.length === 0 ? (
            <div className="field-help">Connect a Telegram bot under Credentials first — alerts are sent through it.</div>
          ) : (
            <>
              <label>
                <span>Bot</span>
                <Select value={draft.alerts.botId} onChange={(e) => set({ alerts: { ...draft.alerts, botId: e.target.value } })}>
                  <option value="">— pick a connected bot —</option>
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.email || b.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                <span>Chat ID</span>
                <input value={draft.alerts.chatId} placeholder="e.g. 123456789" onChange={(e) => set({ alerts: { ...draft.alerts, chatId: e.target.value } })} />
              </label>
              <button className="btn btn-sm btn-ghost" onClick={test} disabled={busy || !draft.alerts.botId || !draft.alerts.chatId}>
                <Send size={12} /> Send a test
              </button>
              <div className="field-help">Save first, then send a test. The chat ID is your own chat with the bot (send it a message once).</div>
            </>
          )}
        </div>
      )}

      {msg && <div className={`settings-note ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
      <div className="row-actions">
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
          Save budgets
        </button>
      </div>
      <div className="field-label" style={{ marginTop: 10 }}>
        Used so far
      </div>
      <BudgetBars status={status} />
    </div>
  );
}

// ---- a workflow's own budget ----
const EMPTY_BUDGET: AiBudget = { daily: { tokens: 0, usd: 0 }, monthly: { tokens: 0, usd: 0 } };

export function WorkflowBudgetSection({ budget, onChange }: { budget?: AiBudget; onChange: (b: AiBudget) => void }) {
  const b = budget || EMPTY_BUDGET;
  return (
    <div className="insp-section">
      <div className="field-section">
        <CircleDollarSign size={11} /> AI BUDGET
      </div>
      <div className="field-help" style={{ margin: "0 12px 8px" }}>
        Limits for this workflow's model calls, on top of the account's budget (Settings → AI usage &amp; cost). Leave empty for no limit.
      </div>
      <div className="ai-windows" style={{ margin: "0 12px" }}>
        <WindowInputs label="Per day (UTC)" value={b.daily} onChange={(daily) => onChange({ ...b, daily })} />
        <WindowInputs label="Per month" value={b.monthly} onChange={(monthly) => onChange({ ...b, monthly })} />
      </div>
    </div>
  );
}

// ---- the editor's "AI cost" button ----
export function AiCostButton({ workflowId, workflowName, hasAiNodes }: { workflowId: string; workflowName: string; hasAiNodes: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AiWorkflowEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setData(null);
    setError(null);
    api.aiBudget
      .estimate(workflowId)
      .then(setData)
      .catch((err) => setError(String((err as Error).message || err)));
  }, [workflowId]);

  useEffect(() => {
    if (!open) return;
    load();
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, load]);

  const warn = useMemo(() => (data?.budgets || []).some((s) => s.pct >= 80), [data]);

  return (
    <div className="ai-cost" ref={box}>
      <button className={`btn btn-sm btn-ghost${warn ? " ai-cost-warn" : ""}`} onClick={() => setOpen((v) => !v)} title="What the AI in this workflow costs — tokens, cost and budgets">
        <Gauge size={13} /> AI cost
      </button>
      {open && (
        <div className="ai-cost-pop" role="dialog" aria-label="AI cost of this workflow">
          <div className="ai-cost-head">
            <b>AI cost · {workflowName}</b>
            <button className="modal-x" onClick={() => setOpen(false)} title="Close">
              <X size={12} />
            </button>
          </div>
          {error && <div className="settings-note err">{error}</div>}
          {!data && !error && <div className="run-loading"><span className="spinner" /> Loading…</div>}
          {data && (
            <>
              <div className="ai-tiles">
                <div className="ai-tile">
                  <div className="ai-tile-label">Next run (estimate)</div>
                  <div className="ai-tile-value">{data.basedOnRuns ? `~${fmtTokens(data.perRun.tokens)}` : "—"}</div>
                  <div className="ai-tile-sub">
                    {data.basedOnRuns
                      ? `tokens · ~${fmtUsd(data.perRun.costUsd)} · ${fmtTokens(data.perRun.minTokens)}–${fmtTokens(data.perRun.maxTokens)} in the last ${data.basedOnRuns} runs`
                      : hasAiNodes
                        ? "no run with AI yet — run it once for an estimate"
                        : "this workflow calls no model"}
                  </div>
                </div>
                <div className="ai-tile">
                  <div className="ai-tile-label">This workflow today</div>
                  <div className="ai-tile-value">{fmtTokens(data.used.workflow.daily.tokens)}</div>
                  <div className="ai-tile-sub">
                    tokens · {fmtUsd(data.used.workflow.daily.costUsd)} · month: {fmtTokens(data.used.workflow.monthly.tokens)} / {fmtUsd(data.used.workflow.monthly.costUsd)}
                  </div>
                </div>
              </div>
              {data.nodes.length > 0 && (
                <div className="ai-table">
                  <div className="ai-table-title">AI nodes</div>
                  {data.nodes.map((n) => (
                    <div className="ai-table-row" key={n.nodeId}>
                      <span className="ai-table-name" title={`${n.nodeName} (${n.model || "no model"})`}>
                        {n.nodeName} <small>{n.model}</small>
                      </span>
                      <span className="ai-table-num">{n.avgTokens === null ? "not run" : `~${fmtTokens(n.avgTokens)}`}</span>
                      <span className="ai-table-num">{n.avgCostUsd === null ? "" : `~${fmtUsd(n.avgCostUsd)}`}</span>
                      <span className="ai-table-extra">
                        {[n.tokenCap ? `cap ${fmtTokens(n.tokenCap)}` : "", n.reuseAnswers ? "reuses answers" : "", n.maxOutputTokens ? `≤${fmtTokens(n.maxOutputTokens)} out/call` : ""].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="ai-table-title">Budgets</div>
              <BudgetBars status={data.budgets} workflowName={workflowName} />
              {data.fallback.enabled && (
                <div className="field-help">
                  From {data.fallback.at} % of a budget, calls switch to <code>{data.fallback.model}</code>.
                </div>
              )}
              <div className="field-help">Estimates are averages of recent runs at your price table (Settings → AI usage &amp; cost).</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
