// ============================================================================
// My files — the account's own folder on the server (data/files/users/<id>).
// Write File nodes save here and Read File / List Files read from here, so
// this page is where a user gets at what their workflows produced: download
// it, delete it, or upload a file for a Read File node to use.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderOpen, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { api, type StoredFile } from "../api";

interface Props {
  onBack?: () => void;
  /** rendered inside the Main page hub — hides the “back” link */
  embedded?: boolean;
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export default function FilesPage({ onBack, embedded }: Props) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number; maxUpload: number; pro: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.files.list();
      setFiles(res.files);
      setUsage({ used: res.usedBytes, limit: res.limitBytes, maxUpload: res.maxUploadBytes, pro: !!res.pro });
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

  const upload = async (list: FileList | null) => {
    if (!list?.length || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const done: string[] = [];
    try {
      for (const file of Array.from(list)) {
        if (usage && file.size > usage.maxUpload) {
          throw new Error(`“${file.name}” is larger than the ${fmtSize(usage.maxUpload)} upload limit.`);
        }
        // the server checks this too; asking first saves uploading bytes that get refused
        const replacing = files.find((f) => f.path === file.name)?.size || 0;
        if (usage && usage.used - replacing + file.size > usage.limit) {
          throw new Error(`“${file.name}” does not fit — ${fmtSize(usage.limit - usage.used)} left of ${fmtSize(usage.limit)}.${usage.pro ? "" : " Pro has 500 MB."}`);
        }
        if (files.some((f) => f.path === file.name) && !window.confirm(`Replace the existing “${file.name}”?`)) continue;
        await api.files.upload(file.name, file);
        done.push(file.name);
      }
      if (done.length) setNotice(`Uploaded ${done.join(", ")} — use ${done.length === 1 ? "it" : "them"} in a Read File node by name.`);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      load();
    }
  };

  const remove = async (f: StoredFile) => {
    if (!window.confirm(`Delete “${f.path}”? Workflows that read it will fail until it is written again.`)) return;
    try {
      await api.files.remove(f.path);
      await load();
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const q = query.trim().toLowerCase();
  const shown = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;

  return (
    <div className={`tool-page${embedded ? " embedded" : ""}`}>
      <header className="tool-head">
        <div>
          {!embedded && <button className="tool-back" onClick={onBack}>← Main page</button>}
          <h1><FolderOpen size={18} /> My files</h1>
          <p>
            Your own folder on the server — only your account can see it. <b>Write File to Disk</b> nodes save here, <b>Read File</b> and{" "}
            <b>List Files</b> read from here (paths are relative to this folder, e.g. <code>reports/today.csv</code>). Upload a file to use it in a
            workflow.
          </p>
        </div>
        <div className="tool-actions">
          <button className="btn" onClick={load}><RefreshCw size={14} /> Refresh</button>
          <button className="btn btn-primary" onClick={() => input.current?.click()} disabled={busy}>
            <Upload size={14} /> {busy ? "Uploading…" : "Upload"}
          </button>
          <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        </div>
      </header>

      {usage && (
        <div className="files-usage" title={`${fmtSize(usage.used)} of ${fmtSize(usage.limit)} used`}>
          <div className="files-usage-bar"><span style={{ width: `${Math.min(100, (usage.used / usage.limit) * 100)}%` }} /></div>
          <small>
            {fmtSize(usage.used)} of {fmtSize(usage.limit)} used ({usage.pro ? "Pro" : "Free plan — Pro has 500 MB"}) · uploads up to{" "}
            {fmtSize(usage.maxUpload)} each
          </small>
        </div>
      )}

      {error && <div className="tool-error">{error}</div>}
      {notice && <div className="tool-sub files-notice">{notice}</div>}

      {files.length > 5 && (
        <div className="files-search">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or folder" />
        </div>
      )}

      {loading ? (
        <div className="tool-empty">Loading files…</div>
      ) : files.length === 0 ? (
        <div className="tool-empty">
          No files yet. Add a <b>Write File to Disk</b> node to a workflow, or upload one.
        </div>
      ) : shown.length === 0 ? (
        <div className="tool-empty">No file matches “{query}”.</div>
      ) : (
        <table className="tool-table">
          <thead>
            <tr><th>File</th><th>Size</th><th>Changed</th><th /></tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.path}>
                <td>
                  <b>{f.name}</b>
                  {f.path !== f.name && <div className="tool-sub"><code>{f.path}</code></div>}
                </td>
                <td>{fmtSize(f.size)}</td>
                <td>{fmtDate(f.modified)}</td>
                <td className="tool-row-actions">
                  <a className="btn mini" href={api.files.downloadUrl(f.path)} download={f.name} title="Download">
                    <Download size={12} />
                  </a>
                  <button className="btn mini danger" onClick={() => remove(f)} title="Delete"><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
