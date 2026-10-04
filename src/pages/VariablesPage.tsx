import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Trash2, Variable as VariableIcon, X } from "lucide-react";
import { api } from "../api";
import { SecretInput } from "../components/SecretInput";
import type { Variable } from "../types";

interface Props {
  onBack?: () => void;
  /** rendered inside the Main page hub — hides the “back” link */
  embedded?: boolean;
}

export default function VariablesPage({ onBack, embedded }: Props) {
  const [items, setItems] = useState<Variable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | { id?: string; name: string; value: string; testValue: string; secret: boolean }>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.variables.list());
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

  const save = async () => {
    if (!editing || busy) return;
    const name = editing.name.trim();
    if (!name) {
      setError("Give the variable a name.");
      return;
    }
    setBusy(true);
    try {
      const body = { name, value: editing.value, testValue: editing.testValue, secret: editing.secret };
      if (editing.id) await api.variables.update(editing.id, body);
      else await api.variables.create(body);
      setEditing(null);
      setError(null);
      await load();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (v: Variable) => {
    if (!window.confirm(`Delete the variable “${v.name}”?`)) return;
    try {
      await api.variables.remove(v.id);
      await load();
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  return (
    <div className={`tool-page${embedded ? " embedded" : ""}`}>
      <header className="tool-head">
        <div>
          {!embedded && <button className="tool-back" onClick={onBack}>← Main page</button>}
          <h1><VariableIcon size={18} /> Variables</h1>
          <p>
            Named values stored in the SQL database — use them in any node as <code>{"{{$vars.NAME}}"}</code>, credentials included. Mark one as
            secret to keep it encrypted at rest. A test value is used instead by workflows set to the Test environment.
          </p>
        </div>
        <div className="tool-actions">
          <button className="btn" onClick={load}><RefreshCw size={14} /> Refresh</button>
          <button className="btn btn-primary" onClick={() => setEditing({ name: "", value: "", testValue: "", secret: false })}><Plus size={14} /> New variable</button>
        </div>
      </header>

      {error && <div className="tool-error">{error}</div>}

      {loading ? (
        <div className="tool-empty">Loading variables…</div>
      ) : items.length === 0 ? (
        <div className="tool-empty">No variables yet.</div>
      ) : (
        <table className="tool-table">
          <thead>
            <tr><th>Name</th><th>Value</th><th>Secret</th><th /></tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id}>
                <td><b>{v.name}</b></td>
                <td>
                  <code>{v.secret && !reveal[v.id] ? "••••••••" : v.value}</code>
                  {v.testValue ? (
                    <div className="tool-sub">
                      test: <code>{v.secret && !reveal[v.id] ? "••••••••" : v.testValue}</code>
                    </div>
                  ) : null}
                </td>
                <td>{v.secret ? "encrypted" : "plain"}</td>
                <td className="tool-row-actions">
                  {v.secret && (
                    <button className="btn mini" onClick={() => setReveal((r) => ({ ...r, [v.id]: !r[v.id] }))}>
                      {reveal[v.id] ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  )}
                  <button className="btn mini" onClick={() => setEditing({ id: v.id, name: v.name, value: v.value, testValue: v.testValue || "", secret: v.secret })}>Edit</button>
                  <button className="btn mini danger" onClick={() => remove(v)}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="tool-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="tool-modal" role="dialog" aria-modal="true">
            <div className="tool-modal-head">
              <h2>{editing.id ? "Edit variable" : "New variable"}</h2>
              <button className="modal-x" onClick={() => setEditing(null)}><X size={14} /></button>
            </div>
            <label className="tool-label">Name</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="API_BASE_URL" />
            <label className="tool-label">Value</label>
            <SecretInput
              value={editing.value}
              revealed={!editing.secret}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              placeholder="https://api.example.com"
            />
            <label className="tool-label">Test value (optional)</label>
            <SecretInput
              value={editing.testValue}
              revealed={!editing.secret}
              onChange={(e) => setEditing({ ...editing, testValue: e.target.value })}
              placeholder="Used by workflows in the Test environment, e.g. a testnet key"
            />
            <label className="tool-check">
              <input type="checkbox" checked={editing.secret} onChange={(e) => setEditing({ ...editing, secret: e.target.checked })} />
              Store encrypted (secret)
            </label>
            <div className="tool-modal-actions">
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save variable"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
