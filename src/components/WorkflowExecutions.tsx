import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Gauge, RefreshCw } from "lucide-react";
import { api } from "../api";
import type { ExecutionSummary } from "../types";
import ExecStatus, { EXEC_POLL_MS } from "./ExecStatus";
import Select from "./Select";

interface Props {
  workflowId: string;
  /** bumped by the editor whenever a run finishes, so the list reloads */
  refreshKey?: number;
  /** open one saved run in the Log console (the editor switches to the workspace and loads it) */
  onOpenRun: (execId: string) => void;
}

function fmtDuration(ms: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

function fmtTime(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * The Executions side of the editor: every recorded run of THIS workflow, with
 * its average run time, failure rate and the production runs (everything that
 * did not start with a Run click in the editor). Clicking a row reopens that
 * run's full log in the Log console. Runs still in progress are listed on top
 * as Running, and the list reloads itself while it is open, so a run shows up
 * the moment it starts — webhooks and schedules included.
 */
export default function WorkflowExecutions({ workflowId, refreshKey, onOpenRun }: Props) {
  const [runs, setRuns] = useState<ExecutionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyFailures, setOnlyFailures] = useState(false);
  const [source, setSource] = useState("");

  // quiet: the background refresh keeps the table on screen instead of
  // flashing the loading placeholder every few seconds
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setRuns(await api.workflows.executions(workflowId, 100));
        setError(null);
      } catch (err) {
        if (!quiet) setError(String((err as Error).message || err));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [workflowId]
  );

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) load(true);
    }, EXEC_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const stats = useMemo(() => {
    const running = runs.filter((r) => r.running).length;
    // a run in progress has no outcome yet — the numbers cover finished runs
    const done = runs.filter((r) => !r.running);
    const total = done.length;
    const failed = done.filter((r) => !r.success).length;
    const prod = done.filter((r) => r.source !== "editor");
    const prodFailed = prod.filter((r) => !r.success).length;
    const avg = total ? done.reduce((sum, r) => sum + (r.durationMs || 0), 0) / total : 0;
    return {
      running,
      total,
      failed,
      failureRate: total ? (failed / total) * 100 : 0,
      prod: prod.length,
      prodFailed,
      prodFailureRate: prod.length ? (prodFailed / prod.length) * 100 : 0,
      avg,
      lastRun: runs[0] || null,
    };
  }, [runs]);

  const sources = useMemo(() => Array.from(new Set(runs.map((r) => r.source))).sort(), [runs]);
  const shown = runs.filter((r) => (!onlyFailures || (!r.success && !r.running)) && (!source || r.source === source));

  return (
    <div className="wf-exec">
      <div className="wf-exec-head">
        <div>
          <h2>
            <Gauge size={15} /> Execution history
          </h2>
          <p>
            Every run of this workflow — editor clicks, webhooks, schedules, chat and Telegram. Click a row to reopen its full log in
            the workspace.
          </p>
        </div>
        <div className="wf-exec-actions">
          <label className="tool-check">
            <input type="checkbox" checked={onlyFailures} onChange={(e) => setOnlyFailures(e.target.checked)} /> Only failures
          </label>
          <Select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <button className="btn btn-sm" onClick={() => load()} title="Reload">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      <div className="wf-exec-stats">
        <div className="wf-stat">
          <span className="wf-stat-label">Runs recorded</span>
          <span className="wf-stat-value">{stats.total}</span>
          <span className="wf-stat-sub">
            {stats.prod} production{stats.running ? ` · ${stats.running} running now` : ""}
          </span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">Run time (avg.)</span>
          <span className="wf-stat-value">{fmtDuration(stats.avg)}</span>
          <span className="wf-stat-sub">{stats.lastRun ? `last ${fmtTime(stats.lastRun.startedAt)}` : "no runs yet"}</span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">Failure rate</span>
          <span className={`wf-stat-value ${stats.failureRate > 0 ? "bad" : "ok"}`}>{stats.failureRate.toFixed(1)}%</span>
          <span className="wf-stat-sub">
            {stats.failed} of {stats.total} runs failed
          </span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">Production failures</span>
          <span className={`wf-stat-value ${stats.prodFailed > 0 ? "bad" : "ok"}`}>
            {stats.prodFailed}
            {stats.prod ? ` (${stats.prodFailureRate.toFixed(1)}%)` : ""}
          </span>
          <span className="wf-stat-sub">failed runs outside the editor</span>
        </div>
      </div>

      {error && <div className="tool-error">{error}</div>}

      {loading ? (
        <div className="tool-empty">Loading executions…</div>
      ) : shown.length === 0 ? (
        <div className="tool-empty">
          {runs.length ? "No runs match the current filter." : "No executions recorded yet. Run this workflow and it shows up here."}
        </div>
      ) : (
        <table className="tool-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Source</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Nodes</th>
              <th>Errors</th>
              <th>AI usage</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => (
              <tr
                key={run.id}
                className={run.running ? undefined : "tool-clickable"}
                onClick={run.running ? undefined : () => onOpenRun(run.id)}
                title={run.running ? "Still running — its log opens here once it finishes" : "Open this run in the Log console"}
              >
                <td>
                  <ExecStatus run={run} />
                </td>
                <td>{run.source}</td>
                <td>
                  <Clock size={11} /> {fmtTime(run.startedAt)}
                </td>
                <td>{fmtDuration(run.durationMs)}</td>
                <td>{run.running ? `${run.nodesStarted || 0} / ${run.nodeCount}` : run.nodeCount}</td>
                <td>{run.running ? "—" : run.errorCount}</td>
                <td>
                  {(() => {
                    const tokens = (run.promptTokens || 0) + (run.completionTokens || 0);
                    if (!tokens) return <span className="wf-exec-dim">—</span>;
                    const cost = run.aiCostUsd || 0;
                    return (
                      <span className="wf-exec-usage" title={`${run.promptTokens || 0} in / ${run.completionTokens || 0} out`}>
                        🧠 {tokens.toLocaleString()}
                        {cost > 0 ? <span className="run-cost"> · {cost >= 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(5)}`}</span> : null}
                      </span>
                    );
                  })()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
