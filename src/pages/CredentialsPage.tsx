import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "../api";
import type { Credential } from "../types";
import ConnectedAccounts from "../components/ConnectedAccounts";
import Select from "../components/Select";
import { SecretInput } from "../components/SecretInput";

interface Props {
  onBack?: () => void;
  /** rendered inside the Main page hub — hides the “back” link */
  embedded?: boolean;
}

type FieldRow = { k: string; v: string };

const TYPES: Array<{ value: string; label: string; fields: FieldRow[] }> = [
  { value: "apiKey", label: "API key", fields: [{ k: "apiKey", v: "" }] },
  { value: "bearer", label: "Bearer token", fields: [{ k: "token", v: "" }] },
  { value: "basic", label: "Basic auth (user + password)", fields: [{ k: "username", v: "" }, { k: "password", v: "" }] },
  { value: "header", label: "Custom header", fields: [{ k: "name", v: "" }, { k: "value", v: "" }] },
  { value: "oauth2", label: "OAuth2 client", fields: [{ k: "clientId", v: "" }, { k: "clientSecret", v: "" }] },
  { value: "smtp", label: "SMTP / e-mail", fields: [{ k: "host", v: "" }, { k: "user", v: "" }, { k: "password", v: "" }] },
  { value: "database", label: "Database", fields: [{ k: "connectionString", v: "" }] },
  { value: "custom", label: "Custom", fields: [{ k: "key", v: "" }] },
];

const FIELDS_TO_PRESET: Record<string, FieldRow[]> = Object.fromEntries(TYPES.map((t) => [t.value, t.fields]));

const looksSecret = (key: string) => /secret|password|token|key|pass/i.test(key);

export default function CredentialsPage({ onBack, embedded }: Props) {
  const [items, setItems] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | { id?: string; name: string; type: string; fields: FieldRow[] }>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // connected accounts ("oauth:*") are listed by ConnectedAccounts above
      setItems((await api.credentials.list()).filter((c) => !String(c.type || "").startsWith("oauth:")));
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

  const startNew = () => {
    const preset = FIELDS_TO_PRESET.apiKey;
    setEditing({ name: "", type: "apiKey", fields: preset.map((f) => ({ ...f })) });
  };

  const startEdit = (cred: Credential) => {
    const fields = Object.entries(cred.fields || {}).map(([k, v]) => ({ k, v: String(v ?? "") }));
    setEditing({ id: cred.id, name: cred.name, type: cred.type, fields: fields.length ? fields : [{ k: "value", v: "" }] });
  };

  const changeType = (type: string) => {
    if (!editing) return;
    const preset = FIELDS_TO_PRESET[type] || [{ k: "value", v: "" }];
    setEditing({ ...editing, type, fields: preset.map((f) => ({ ...f })) });
  };

  const save = async () => {
    if (!editing || busy) return;
    const name = editing.name.trim();
    if (!name) {
      setError("Give the credential a name.");
      return;
    }
    const fields: Record<string, string> = {};
    for (const row of editing.fields) {
      if (row.k.trim()) fields[row.k.trim()] = row.v;
    }
    setBusy(true);
    try {
      if (editing.id) await api.credentials.update(editing.id, { name, type: editing.type, fields });
      else await api.credentials.create({ name, type: editing.type, fields });
      setEditing(null);
      setError(null);
      await load();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (cred: Credential) => {
    if (!window.confirm(`Delete the credential “${cred.name}”? Workflows using it will stop working.`)) return;
    try {
      await api.credentials.remove(cred.id);
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
          <h1><KeyRound size={18} /> Credentials</h1>
          <p>Secrets your workflows can use. Stored in the SQL database, encrypted at rest — never inside the workflow JSON.</p>
        </div>
        <div className="tool-actions">
          <button className="btn" onClick={load} title="Reload"><RefreshCw size={14} /> Refresh</button>
          <button className="btn btn-primary" onClick={startNew}><Plus size={14} /> New credential</button>
        </div>
      </header>

      <ConnectedAccounts />

      {error && <div className="tool-error">{error}</div>}

      {loading ? (
        <div className="tool-empty">Loading credentials…</div>
      ) : items.length === 0 ? (
        <div className="tool-empty">
          No credentials yet. Add one to keep API keys out of your workflows.
        </div>
      ) : (
        <div className="cred-list">
          {items.map((cred) => (
            <div className="cred-card" key={cred.id}>
              <div className="cred-card-main">
                <div className="cred-card-name">{cred.name}</div>
                <div className="cred-card-type">{cred.type}</div>
                <div className="cred-card-fields">
                  {Object.entries(cred.fields || {}).map(([k, v]) => {
                    const shown = reveal[cred.id];
                    return (
                      <span className="cred-field" key={k}>
                        <b>{k}</b>
                        <code>{shown || !looksSecret(k) ? String(v) : "••••••••"}</code>
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="cred-card-actions">
                <button className="btn mini" onClick={() => setReveal((r) => ({ ...r, [cred.id]: !r[cred.id] }))} title="Show / hide values">
                  {reveal[cred.id] ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button className="btn mini" onClick={() => startEdit(cred)} title="Edit"><Pencil size={12} /></button>
                <button className="btn mini danger" onClick={() => remove(cred)} title="Delete"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="tool-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="tool-modal" role="dialog" aria-modal="true">
            <div className="tool-modal-head">
              <h2>{editing.id ? "Edit credential" : "New credential"}</h2>
              <button className="modal-x" onClick={() => setEditing(null)}><X size={14} /></button>
            </div>
            <label className="tool-label">Name</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="OpenAI production key" />
            <label className="tool-label">Type</label>
            <Select value={editing.type} onChange={(e) => changeType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
            <label className="tool-label">Fields</label>
            <div className="tool-field-rows">
              {editing.fields.map((row, i) => (
                <div className="tool-field-row" key={i}>
                  <input
                    className="tool-field-key"
                    value={row.k}
                    placeholder="field"
                    onChange={(e) => {
                      const fields = editing.fields.slice();
                      fields[i] = { ...fields[i], k: e.target.value };
                      setEditing({ ...editing, fields });
                    }}
                  />
                  <SecretInput
                    value={row.v}
                    revealed={!looksSecret(row.k)}
                    placeholder="value"
                    onChange={(e) => {
                      const fields = editing.fields.slice();
                      fields[i] = { ...fields[i], v: e.target.value };
                      setEditing({ ...editing, fields });
                    }}
                  />
                  <button className="btn mini danger" onClick={() => setEditing({ ...editing, fields: editing.fields.filter((_, j) => j !== i) })}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button className="btn mini" onClick={() => setEditing({ ...editing, fields: [...editing.fields, { k: "", v: "" }] })}>
                <Plus size={12} /> Add field
              </button>
            </div>
            <div className="tool-modal-actions">
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save credential"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
