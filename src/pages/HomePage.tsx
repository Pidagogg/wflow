import { useEffect, useState } from "react";
import { Activity, Bot, Cpu, FolderOpen, GitBranch, KeyRound, PlayCircle, Table2, Timer, TrendingUp, Variable } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../api";
import type { Catalog, WorkspaceStats } from "../types";
import CredentialsPage from "./CredentialsPage";
import ExecutionsPage from "./ExecutionsPage";
import VariablesPage from "./VariablesPage";
import DataTablesPage from "./DataTablesPage";
import FilesPage from "./FilesPage";
import WorkflowsPage from "./WorkflowsPage";
import AgentsPage from "./AgentsPage";
import BetaBanner from "../components/BetaBanner";

export type HubPage = "workflows" | "agents" | "credentials" | "executions" | "variables" | "datatables" | "files";

interface Props {
  userName?: string;
  /** admin switch: show the one-line "beta test" note */
  betaBanner?: boolean;
  catalog: Catalog;
  /** which tool's workspace is open below the buttons */
  selected: HubPage;
  /** deep link from /cloud/agent/<id> — the agent to show first */
  agentId?: string;
  /** deep link from /cloud/workflows/folder/<id> */
  initialFolderId?: string;
  onSelect: (page: HubPage) => void;
  onOpenWorkflow: (id: string) => void;
  onOpenGuide?: () => void;
  /** opens the contact page (the beta note's “Contact us” link) */
  onOpenContact?: () => void;
}

interface Tool {
  key: HubPage;
  label: string;
  desc: string;
  icon: LucideIcon;
}

const TOOLS: Tool[] = [
  { key: "credentials", label: "Credentials", desc: "Store API keys, tokens and passwords for your workflows — encrypted in the SQL database.", icon: KeyRound },
  { key: "workflows", label: "Workflows", desc: "Build and run automations on the node canvas.", icon: GitBranch },
  { key: "agents", label: "AI Agents", desc: "Configure AI agents with your own model credentials and tools.", icon: Bot },
  { key: "executions", label: "Executions", desc: "Every workflow run across your account, newest first.", icon: PlayCircle },
  { key: "variables", label: "Variables", desc: "Named values your workflows can reference by name.", icon: Variable },
  { key: "datatables", label: "Data Tables", desc: "Small spreadsheets stored in SQL, one set per account — build them by hand or import a CSV.", icon: Table2 },
  { key: "files", label: "My files", desc: "Files your workflows saved with Write File — download, delete, or upload one for Read File.", icon: FolderOpen },
];

function fmtDuration(ms: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** AI spend is usually tiny, so small amounts keep more decimals than dollars. */
function fmtUsd(usd: number) {
  if (!usd) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** "Time saved" is an estimate, so it is shown in human units (h / min). */
function fmtSaved(ms: number) {
  if (!ms) return "0 min";
  const mins = ms / 60000;
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const rest = Math.round(mins - h * 60);
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

// The executions list endpoint is capped; beyond this the badge shows "200+".
const EXEC_COUNT_CAP = 200;

export default function HomePage({
  userName,
  betaBanner,
  catalog,
  selected,
  agentId,
  initialFolderId,
  onSelect,
  onOpenWorkflow,
  onOpenGuide,
  onOpenContact,
}: Props) {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  // Workspace statistics — production runs, failures, time saved, average run time.
  const [stats, setStats] = useState<WorkspaceStats | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next: Record<string, number | null> = {};
      const tasks: Array<[string, Promise<unknown[]>]> = [
        ["workflows", api.workflows.list()],
        ["agents", api.agents.list()],
        ["credentials", api.credentials.list()],
        ["executions", api.executions.list(EXEC_COUNT_CAP)],
        ["variables", api.variables.list()],
        ["datatables", api.dataTables.list()],
        ["files", api.files.list().then((r) => r.files)],
      ];
      await Promise.all(
        tasks.map(async ([key, p]) => {
          try {
            const rows = await p;
            next[key] = Array.isArray(rows) ? rows.length : 0;
          } catch {
            next[key] = null;
          }
        })
      );
      if (alive) setCounts(next);
    };
    load();
    api.stats()
      .then((s) => alive && setStats(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // refresh whenever the user switches tools, so counts follow new/deleted items
  }, [selected]);

  return (
    <div className="hub">
      <header className="hub-top">
        <div className="hub-head">
          <h1>Welcome back{userName ? `, ${userName}` : ""}</h1>
          {betaBanner && <BetaBanner compact onContact={onOpenContact} />}
        </div>

        <nav className="hub-tools" aria-label="Workspace tools">
          {TOOLS.map(({ key, label, icon: Icon }) => {
            const count = counts[key];
            return (
              <button
                key={key}
                type="button"
                aria-current={key === selected ? "true" : undefined}
                className={`hub-tool${key === selected ? " active" : ""}`}
                onClick={() => onSelect(key)}
                title={TOOLS.find((t) => t.key === key)?.desc}
              >
                <Icon size={15} />
                <span>{label}</span>
                {typeof count === "number" && (
                  <span className="hub-tool-count">{key === "executions" && count >= EXEC_COUNT_CAP ? `${EXEC_COUNT_CAP}+` : count}</span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Live statistics across every workflow of the account. "Production" runs
          are the ones nobody started by hand — webhooks, schedules, chat and
          Telegram — so they are the runs that actually replace manual work. */}
      <section className="hub-stats" aria-label="Workspace statistics">
        <div className="wf-stat">
          <span className="wf-stat-label">
            <Activity size={11} /> Prod. executions
          </span>
          <span className="wf-stat-value">{stats ? stats.prodExecutions : "…"}</span>
          <span className="wf-stat-sub">
            {stats ? `${stats.totalExecutions} runs in total` : "runs outside the editor"}
          </span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">Failed prod. executions</span>
          <span className={`wf-stat-value ${stats && stats.failedProdExecutions > 0 ? "bad" : "ok"}`}>
            {stats ? stats.failedProdExecutions : "…"}
          </span>
          <span className="wf-stat-sub">failed without a Run click</span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">Failure rate</span>
          <span className={`wf-stat-value ${stats && stats.failureRate > 0 ? "bad" : "ok"}`}>
            {stats ? `${stats.failureRate.toFixed(1)}%` : "…"}
          </span>
          <span className="wf-stat-sub">of {stats ? stats.prodExecutions : 0} production runs</span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">
            <TrendingUp size={11} /> Time saved
          </span>
          <span className="wf-stat-value ok">{stats ? fmtSaved(stats.timeSavedMs) : "…"}</span>
          <span className="wf-stat-sub">
            {stats ? `≈ ${stats.manualMinutesPerRun} min of manual work per run` : "estimated"}
          </span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">
            <Timer size={11} /> Run time (avg.)
          </span>
          <span className="wf-stat-value">{stats ? fmtDuration(stats.avgRunTimeMs) : "…"}</span>
          <span className="wf-stat-sub">average per execution</span>
        </div>
        <div className="wf-stat">
          <span className="wf-stat-label">
            <Cpu size={11} /> AI spend
          </span>
          <span className="wf-stat-value">{stats ? fmtUsd(stats.aiSpendUsd) : "…"}</span>
          <span className="wf-stat-sub">
            {stats
              ? `${fmtTokens((stats.promptTokens || 0) + (stats.completionTokens || 0))} tokens (your price table)`
              : "priced with your own table"}
          </span>
        </div>
      </section>

      <section className="hub-body" aria-live="polite">
        {selected === "workflows" && (
          <WorkflowsPage
            key={initialFolderId || "workflows"}
            catalog={catalog}
            onOpen={onOpenWorkflow}
            onOpenGuide={onOpenGuide}
            initialFolderId={initialFolderId}
          />
        )}
        {selected === "agents" && <AgentsPage key={agentId || "agents"} catalog={catalog} agentId={agentId} />}
        {selected === "credentials" && <CredentialsPage embedded />}
        {selected === "executions" && <ExecutionsPage embedded onOpenWorkflow={onOpenWorkflow} />}
        {selected === "variables" && <VariablesPage embedded />}
        {selected === "datatables" && <DataTablesPage embedded />}
        {selected === "files" && <FilesPage embedded />}
      </section>
    </div>
  );
}
