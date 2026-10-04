import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PlayCircle, RefreshCw } from "lucide-react";
import { api } from "../api";
import type { ExecutionSummary, Workflow } from "../types";
import ExecStatus, { EXEC_POLL_MS } from "../components/ExecStatus";
import Select from "../components/Select";

interface Props {
  onBack?: () => void;
  /** rendered inside the Main page hub — hides the “back” link */
  embedded?: boolean;
  onOpenWorkflow: (id: string) => void;
}

function fmtDuration(ms: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// Sources as the user knows them; "mcp" is a call from an AI assistant.
const SOURCE_LABEL: Record<string, string> = { mcp: "AI tool" };
const sourceLabel = (s: string) => SOURCE_LABEL[s] || s;

type AiToolCall = { tool: string; token: string; arguments: unknown; answer: string; isError: boolean };

/** The call behind an AI-tool run: tool, token, arguments and the answer. */
function AiToolDetails({ workflowId, executionId }: { workflowId: string; executionId: string }) {
  const [call, setCall] = useState<AiToolCall | null | undefined>(undefined);
  useEffect(() => {
    api.workflows
      .execution(workflowId, executionId)
      .then((run) => setCall(((run.result as unknown as { aiTool?: AiToolCall }).aiTool) || null))
      .catch(() => setCall(null));
  }, [workflowId, executionId]);
  if (call === undefined) return <div className="field-help">Loading the call…</div>;
  if (!call) return <div className="field-help">This run has no recorded call details (it ran before they were recorded).</div>;
  return (
    <div className="ai-call">
      <div>
        <b>Tool</b> <code>{call.tool}</code> · <b>token</b> {call.token}
      </div>
      <div className="ai-call-grid">
        <div>
          <div className="ai-call-label">Arguments</div>
          <pre>{JSON.stringify(call.arguments ?? {}, null, 2)}</pre>
        </div>
        <div>
          <div className="ai-call-label">{call.isError ? "Answer (error)" : "Answer"}</div>
          <pre className={call.isError ? "ai-call-err" : ""}>{call.answer}</pre>
        </div>
      </div>
    </div>
  );
}

function fmtTime(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function ExecutionsPage({ onBack, embedded, onOpenWorkflow }: Props) {
  const [executions, setExecutions] = useState<ExecutionSummary[]>([]);
  const [workflows, setWorkflows] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [source, setSource] = useState("");
  // AI-tool runs whose call details are unfolded.
  const [openCalls, setOpenCalls] = useState<Set<string>>(new Set());
  const toggleCall = (id: string) =>
    setOpenCalls((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [runs, wfs] = await Promise.all([api.executions.list(200), api.workflows.list().catch(() => [] as Workflow[])]);
      setExecutions(runs);
      setWorkflows(Object.fromEntries((wfs as Workflow[]).map((w) => [w.id, w.name || w.id])));
      setError(null);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the list live while it is open, so runs appear as they start (and
  // turn into their result when they finish). Only the runs are refetched.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      api.executions
        .list(200)
        .then(setExecutions)
        .catch(() => {});
    }, EXEC_POLL_MS);
    return () => clearInterval(t);
  }, []);

  const sources = useMemo(() => Array.from(new Set(executions.map((e) => e.source))).sort(), [executions]);

  const shown = executions.filter((e) => (!onlyErrors || (!e.success && !e.running)) && (!source || e.source === source));

  return (
    <div className={`tool-page${embedded ? " embedded" : ""}`}>
      <header className="tool-head">
        <div>
          {!embedded && <button className="tool-back" onClick={onBack}>← Main page</button>}
          <h1><PlayCircle size={18} /> Executions</h1>
          <p>Every run of every workflow your account owns, newest first.</p>
        </div>
        <div className="tool-actions">
          <label className="tool-check">
            <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Only failures
          </label>
          <Select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
          </Select>
          <button className="btn" onClick={load}><RefreshCw size={14} /> Refresh</button>
        </div>
      </header>

      {error && <div className="tool-error">{error}</div>}

      {loading ? (
        <div className="tool-empty">Loading executions…</div>
      ) : shown.length === 0 ? (
        <div className="tool-empty">No executions recorded yet. Run a workflow and it will show up here.</div>
      ) : (
        <table className="tool-table">
          <thead>
            <tr><th>Status</th><th>Workflow</th><th>Source</th><th>Started</th><th>Duration</th><th>Nodes</th><th>Errors</th></tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <Fragment key={e.id}>
              <tr className="tool-clickable" onClick={() => onOpenWorkflow(e.workflowId)}>
                <td>
                  <ExecStatus run={e} />
                </td>
                <td>{workflows[e.workflowId] || e.workflowId}</td>
                <td>
                  {sourceLabel(e.source)}
                  {e.source === "mcp" && !e.running && (
                    <button
                      className="btn mini ai-call-toggle"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        toggleCall(e.id);
                      }}
                      title="Show the call: tool, token, arguments and answer"
                    >
                      {openCalls.has(e.id) ? "hide call" : "call"}
                    </button>
                  )}
                </td>
                <td>{fmtTime(e.startedAt)}</td>
                <td>{fmtDuration(e.durationMs)}</td>
                <td>{e.running ? `${e.nodesStarted || 0} / ${e.nodeCount}` : e.nodeCount}</td>
                <td>{e.running ? "—" : e.errorCount}</td>
              </tr>
              {openCalls.has(e.id) && (
                <tr className="ai-call-row">
                  <td colSpan={7}>
                    <AiToolDetails workflowId={e.workflowId} executionId={e.id} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
