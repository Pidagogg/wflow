import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { DashboardSummary, McpAccess, McpInfo, McpToken } from "../types";
import { api } from "../api";

// Settings tabs for connecting AI assistants (MCP) and managing dashboards.

const copy = (text: string) => {
  navigator.clipboard?.writeText(text).catch(() => {});
};

// ---- AI tools (MCP) ------------------------------------------------------------
const ACCESS: Array<{ value: McpAccess; label: string; help: string }> = [
  { value: "run", label: "Run offered tools", help: "Only the workflows you offer as tools (Workflow settings → AI tool)." },
  { value: "read", label: "Read", help: "Also read your workflows, the node catalog and the reference, and check workflow JSON." },
  { value: "build", label: "Build", help: "Also create and change workflows and run any of them — for Claude Code, Cursor and other coding agents." },
];
const accessLabel = (a: McpAccess) => ACCESS.find((x) => x.value === a)?.label || a;

type TokenDraft = { name: string; access: McpAccess; scope: "all" | "some"; picked: string[]; dailyRuns: number };
const EMPTY_DRAFT: TokenDraft = { name: "", access: "run", scope: "all", picked: [], dailyRuns: 0 };
const draftOf = (t: McpToken): TokenDraft => ({
  name: t.name,
  access: t.access,
  scope: t.workflows === "all" ? "all" : "some",
  picked: t.workflows === "all" ? [] : t.workflows,
  dailyRuns: t.dailyRuns,
});
const scopeOf = (d: TokenDraft): "all" | string[] => (d.scope === "all" || !d.picked.length ? "all" : d.picked);

/** Name, access level, workflow scope and daily run limit of a token. */
function TokenForm({
  draft,
  onChange,
  workflows,
}: {
  draft: TokenDraft;
  onChange: (d: TokenDraft) => void;
  workflows: Array<{ id: string; name: string }>;
}) {
  const set = (p: Partial<TokenDraft>) => onChange({ ...draft, ...p });
  return (
    <div className="mcp-token-form">
      <div className="field">
        <div className="field-label">Name</div>
        <input value={draft.name} placeholder="e.g. Claude Code on my laptop" maxLength={60} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <div className="field-label">Access</div>
        <div className="mcp-access">
          {ACCESS.map((a) => (
            <label key={a.value} className={`mcp-access-option ${draft.access === a.value ? "active" : ""}`}>
              <input type="radio" checked={draft.access === a.value} onChange={() => set({ access: a.value })} />
              <span>
                <b>{a.label}</b>
                <small>{a.help}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <div className="field-label">Workflows</div>
        <div className="row-actions">
          <label className="mcp-inline">
            <input type="radio" checked={draft.scope === "all"} onChange={() => set({ scope: "all" })} /> All workflows
          </label>
          <label className="mcp-inline">
            <input type="radio" checked={draft.scope === "some"} onChange={() => set({ scope: "some" })} /> Only these
          </label>
        </div>
        {draft.scope === "some" && (
          <div className="mcp-scope-list">
            {workflows.length === 0 && <div className="field-help">No workflows yet.</div>}
            {workflows.map((w) => (
              <label key={w.id} className="mcp-inline">
                <input
                  type="checkbox"
                  checked={draft.picked.includes(w.id)}
                  onChange={(e) => set({ picked: e.target.checked ? [...draft.picked, w.id] : draft.picked.filter((x) => x !== w.id) })}
                />{" "}
                {w.name}
              </label>
            ))}
            <div className="field-help">A token limited to chosen workflows cannot create new ones.</div>
          </div>
        )}
      </div>
      <div className="field">
        <div className="field-label">Runs per day</div>
        <input type="number" min={0} max={100000} value={draft.dailyRuns} onChange={(e) => set({ dailyRuns: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
        <div className="field-help">How many runs this token may start per day (UTC). 0 = no limit of its own; your plan's daily runs still apply.</div>
      </div>
    </div>
  );
}

export function McpTab() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [workflowList, setWorkflowList] = useState<Array<{ id: string; name: string }>>([]);
  const [secret, setSecret] = useState<{ token: string; name: string } | null>(null);
  const [creating, setCreating] = useState<TokenDraft | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: TokenDraft } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.mcp
      .info()
      .then(setInfo)
      .catch((err) => setMsg({ ok: false, text: String((err as Error).message || err) }));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api.workflows
      .list()
      .then((list) => setWorkflowList(list.map((w) => ({ id: w.id, name: w.name || w.id }))))
      .catch(() => {});
  }, []);
  const nameOf = (id: string) => workflowList.find((w) => w.id === id)?.name || id;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      if (!creating) return;
      const res = await api.mcp.createToken({ name: creating.name, access: creating.access, workflows: scopeOf(creating), dailyRuns: creating.dailyRuns });
      setSecret({ token: res.token, name: res.info.name });
      setCreating(null);
      setMsg({ ok: true, text: `Token “${res.info.name}” created — copy it now, it is shown only once.` });
      load();
    });

  const saveEdit = () =>
    run(async () => {
      if (!editing) return;
      const d = editing.draft;
      await api.mcp.updateToken(editing.id, { name: d.name, access: d.access, workflows: scopeOf(d), dailyRuns: d.dailyRuns });
      setEditing(null);
      setMsg({ ok: true, text: "Token updated — the change applies to its next call." });
      load();
    });

  const revoke = (t: McpToken) =>
    run(async () => {
      if (!window.confirm(`Revoke “${t.name}”? Every assistant using it loses access immediately.`)) return;
      await api.mcp.revokeToken(t.id);
      if (secret?.name === t.name) setSecret(null);
      setMsg({ ok: true, text: `Token “${t.name}” revoked.` });
      load();
    });

  const endpoint = info?.endpoint || "/mcp";
  const shownToken = secret?.token || "YOUR_TOKEN";
  const clientConfig = JSON.stringify({ mcpServers: { "w-flow": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${shownToken}` } } } }, null, 2);
  const tokens = info?.tokens || [];

  return (
    <>
      <div className="settings-intro">
        Connect AI assistants such as Claude or Cursor over the Model Context Protocol. They can run the workflows you offer as tools
        (<b>Workflow settings → AI tool</b>) — and, with a <b>Read</b> or <b>Build</b> token, read the node catalog and build or change
        workflows for you.
      </div>
      {msg && <div className={`settings-note ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}

      <div className="field">
        <div className="field-label">Server URL</div>
        <div className="kv-row">
          <input readOnly value={endpoint} />
          <button className="btn btn-sm btn-ghost" onClick={() => copy(endpoint)} title="Copy">
            <Copy size={12} />
          </button>
        </div>
      </div>

      <div className="field">
        <div className="field-label">Tokens</div>
        {secret && (
          <div className="mcp-secret">
            <div className="field-help">
              New token <b>{secret.name}</b> — copy it now, it is shown only once:
            </div>
            <div className="kv-row">
              <input readOnly value={secret.token} />
              <button className="btn btn-sm btn-ghost" onClick={() => copy(secret.token)} title="Copy">
                <Copy size={12} />
              </button>
            </div>
          </div>
        )}
        {tokens.length === 0 && !creating && <div className="field-help">No token yet — create one for each assistant or machine.</div>}
        <div className="mcp-token-list">
          {tokens.map((t) =>
            editing?.id === t.id ? (
              <div className="mcp-token-card editing" key={t.id}>
                <TokenForm draft={editing.draft} onChange={(draft) => setEditing({ id: t.id, draft })} workflows={workflowList} />
                <div className="row-actions">
                  <button className="btn btn-sm btn-primary" onClick={saveEdit} disabled={busy}>
                    Save
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="mcp-token-card" key={t.id}>
                <div className="mcp-token-main">
                  <b>{t.name}</b> <span className={`mcp-level mcp-level-${t.access}`}>{accessLabel(t.access)}</span>
                  <div className="field-help">
                    …{t.hint} · {t.workflows === "all" ? "all workflows" : `${t.workflows.length} workflow${t.workflows.length === 1 ? "" : "s"}: ${t.workflows.map(nameOf).join(", ")}`}
                    {t.dailyRuns ? ` · ${t.dailyRuns} runs/day` : ""} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"}
                  </div>
                </div>
                <div className="row-actions">
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ id: t.id, draft: draftOf(t) })} disabled={busy} title="Change access, scope or limit">
                    <Pencil size={12} />
                  </button>
                  <button className="btn btn-sm btn-ghost btn-danger" onClick={() => revoke(t)} disabled={busy} title="Revoke">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            )
          )}
        </div>
        {creating ? (
          <div className="mcp-token-card editing">
            <TokenForm draft={creating} onChange={setCreating} workflows={workflowList} />
            <div className="row-actions">
              <button className="btn btn-sm btn-primary" onClick={create} disabled={busy}>
                <KeyRound size={12} /> Create token
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setCreating(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row-actions">
            <button className="btn btn-sm btn-primary" onClick={() => setCreating({ ...EMPTY_DRAFT })} disabled={busy || tokens.length >= 10}>
              <Plus size={12} /> New token
            </button>
          </div>
        )}
        <div className="field-help">Only a fingerprint of each token is stored. Anyone with a token can do what its access level allows.</div>
      </div>

      <div className="field">
        <div className="field-label">Client configuration (Cursor, Claude Code <code>.mcp.json</code>, other MCP clients)</div>
        <pre className="debug-preview">{clientConfig}</pre>
        <button className="btn btn-sm btn-ghost" onClick={() => copy(clientConfig)}>
          <Copy size={12} /> Copy
        </button>
        <div className="field-help">
          Claude Code: <code>{`claude mcp add --transport http w-flow ${endpoint} --header "Authorization: Bearer ${shownToken}"`}</code>
        </div>
      </div>

      <div className="field">
        <div className="field-label">Workflows offered as tools</div>
        {info && info.tools.length === 0 && <div className="field-help">None yet — turn “Offer this workflow as a tool” on in a workflow's settings.</div>}
        {info?.tools.map((t) => (
          <div className="field-help" key={t.workflowId}>
            <code>{t.name}</code> — {t.workflowName}
          </div>
        ))}
      </div>

      <div className="field">
        <div className="field-label">Builder tools</div>
        {info?.builderTools.map((t) => (
          <div className="field-help" key={t.name}>
            <code>{t.name}</code> — {t.title} <span className={`mcp-level mcp-level-${t.level}`}>{accessLabel(t.level)}</span>
          </div>
        ))}
        <div className="field-help">
          Assistants read{" "}
          <a href="/docs/workflow-reference.md" target="_blank" rel="noopener">
            the workflow reference
          </a>{" "}
          through <code>wflow_reference</code>. A run that takes longer than about 25 seconds answers with a run id, which{" "}
          <code>wflow_get_run</code> picks up later. Every call appears in Executions under “AI tool”.
        </div>
      </div>
    </>
  );
}

// ---- dashboards ---------------------------------------------------------------
export function DashboardsTab() {
  const [items, setItems] = useState<DashboardSummary[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api.dashboards
      .list()
      .then(setItems)
      .catch((err) => setMsg({ ok: false, text: String((err as Error).message || err) }));
  }, []);
  useEffect(load, [load]);

  const remove = async (d: DashboardSummary) => {
    if (!window.confirm(`Delete the dashboard “${d.name}”? Its link stops working. A workflow that writes to it creates a new one with a new link.`)) return;
    try {
      await api.dashboards.remove(d.id);
      load();
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
    }
  };

  return (
    <>
      <div className="settings-intro">
        Chart pages written by <b>Dashboard — Add to Chart</b> nodes. Anyone with a dashboard's link can view it; delete it to disable the link.
      </div>
      {msg && <div className={`settings-note ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
      <button className="btn btn-sm btn-ghost" onClick={load}>
        <RefreshCw size={12} /> Refresh
      </button>
      {items && items.length === 0 && <div className="field-help">No dashboards yet — add a Dashboard node to a workflow and run it.</div>}
      {items?.map((d) => {
        const url = `${window.location.origin}/d/${d.id}`;
        return (
          <div className="insp-section" key={d.id}>
            <div className="field-label">{d.name}</div>
            <div className="field-help">
              {d.series.length} chart{d.series.length === 1 ? "" : "s"}: {d.series.join(", ") || "—"}
              {d.updatedAt ? ` · updated ${new Date(d.updatedAt).toLocaleString()}` : ""}
            </div>
            <div className="row-actions">
              <a className="btn btn-sm btn-ghost" href={url} target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> Open
              </a>
              <button className="btn btn-sm btn-ghost" onClick={() => copy(url)}>
                <Copy size={12} /> Copy link
              </button>
              <button className="btn btn-sm btn-ghost btn-danger" onClick={() => remove(d)}>
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
