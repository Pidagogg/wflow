import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Table2, Trash2, Upload, X } from "lucide-react";
import { api } from "../api";
import type { DataTable, DataTableRow } from "../types";
import Select from "../components/Select";

interface Props {
  onBack?: () => void;
  /** rendered inside the Main page hub — hides the “back” link */
  embedded?: boolean;
}

/** How a new table is filled in: by hand, or from a pasted / uploaded CSV. */
type CreateMode = "scratch" | "csv";

interface Draft {
  mode: CreateMode;
  /** "" = create a new table, otherwise append the CSV rows to this table */
  tableId: string;
  name: string;
  columns: string;
  csv: string;
  fileName: string;
  delimiter: string;
  headerRow: boolean;
}

const DELIMITERS = [
  { value: "auto", label: "Auto-detect" },
  { value: ",", label: "Comma ," },
  { value: "\t", label: "Tab" },
  { value: ";", label: "Semicolon ;" },
  { value: "|", label: "Pipe |" },
];

/** Rough row count for the import hint — the server does the real parsing. */
function estimateRows(csv: string, headerRow: boolean): number {
  if (!csv.trim()) return 0;
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  return Math.max(0, lines - (headerRow ? 1 : 0));
}

export default function DataTablesPage({ onBack, embedded }: Props) {
  const [tables, setTables] = useState<DataTable[]>([]);
  const [rows, setRows] = useState<DataTableRow[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadTables = useCallback(async (keep?: string) => {
    setLoading(true);
    try {
      const list = await api.dataTables.list();
      setTables(list);
      const next = keep && list.some((t) => t.id === keep) ? keep : list[0]?.id || "";
      setSelected(next);
      setError(null);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRows = useCallback(async (tableId: string) => {
    if (!tableId) {
      setRows([]);
      return;
    }
    try {
      setRows(await api.dataTables.rows(tableId));
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  }, []);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  useEffect(() => {
    loadRows(selected);
  }, [selected, loadRows]);

  const table = tables.find((t) => t.id === selected) || null;

  // "Edit the table by hand" — name + column list, rows are added afterwards.
  const openScratch = () => {
    setNotice(null);
    setCreating({ mode: "scratch", tableId: "", name: "", columns: "name, value", csv: "", fileName: "", delimiter: "auto", headerRow: true });
  };

  // "Import a CSV" — creates a table, or adds the rows to `tableId` when set.
  const openCsv = (tableId = "") => {
    setNotice(null);
    setCreating({ mode: "csv", tableId, name: "", columns: "", csv: "", fileName: "", delimiter: "auto", headerRow: true });
  };

  const createTable = async () => {
    if (!creating || busy) return;
    const draft = creating;
    setError(null);
    setNotice(null);

    // --- CSV import ------------------------------------------------------
    if (draft.mode === "csv") {
      if (!draft.tableId && !draft.name.trim()) {
        setError("Give the data table a name.");
        return;
      }
      if (!draft.csv.trim()) {
        setError("Paste CSV content or choose a file to import.");
        return;
      }
      setBusy(true);
      try {
        const res = await api.dataTables.importCsv({
          csv: draft.csv,
          name: draft.name.trim() || undefined,
          tableId: draft.tableId || undefined,
          delimiter: draft.delimiter,
          headerRow: draft.headerRow,
        });
        setCreating(null);
        await loadTables(res.table.id);
        setNotice(
          res.imported === 0
            ? `Created “${res.table.name}” with the columns from the file — it has no rows yet.`
            : `Imported ${res.imported} row${res.imported === 1 ? "" : "s"} into “${res.table.name}”.`
        );
      } catch (err) {
        setError(String((err as Error).message || err));
      } finally {
        setBusy(false);
      }
      return;
    }

    // --- from scratch ----------------------------------------------------
    const name = draft.name.trim();
    if (!name) {
      setError("Give the data table a name.");
      return;
    }
    const columns = draft.columns.split(",").map((c) => c.trim()).filter(Boolean);
    setBusy(true);
    try {
      const created = await api.dataTables.create({ name, columns });
      setCreating(null);
      await loadTables(created.id);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const pickCsvFile = async (file?: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      setCreating((prev) =>
        prev
          ? {
              ...prev,
              csv: text,
              fileName: file.name,
              // A file name is a good default table name (unless we append).
              name: prev.tableId || prev.name.trim() ? prev.name : file.name.replace(/\.(csv|tsv|txt)$/i, ""),
            }
          : prev
      );
      setError(null);
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const removeTable = async (t: DataTable) => {
    if (!window.confirm(`Delete the data table “${t.name}” and all of its rows?`)) return;
    try {
      await api.dataTables.remove(t.id);
      await loadTables();
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const addRow = async () => {
    if (!table) return;
    const data: Record<string, unknown> = {};
    for (const c of table.columns) data[c] = "";
    try {
      await api.dataTables.addRow(table.id, data);
      await loadRows(table.id);
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const updateCell = async (row: DataTableRow, column: string, value: string) => {
    if (!table) return;
    const data = { ...row.data, [column]: value };
    // optimistic update
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, data } : r)));
    try {
      await api.dataTables.updateRow(table.id, row.id, data);
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const removeRow = async (row: DataTableRow) => {
    if (!table) return;
    try {
      await api.dataTables.removeRow(table.id, row.id);
      await loadRows(table.id);
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const addColumn = async () => {
    if (!table) return;
    const name = window.prompt("New column name", "column");
    if (!name) return;
    const clean = name.trim();
    if (!clean || table.columns.includes(clean)) return;
    try {
      const updated = await api.dataTables.update(table.id, { columns: [...table.columns, clean] });
      setTables((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const importTarget = creating?.tableId ? tables.find((t) => t.id === creating.tableId) : null;
  const csvRowEstimate = useMemo(
    () => (creating?.mode === "csv" ? estimateRows(creating.csv, creating.headerRow) : 0),
    [creating?.mode, creating?.csv, creating?.headerRow]
  );

  return (
    <div className={`tool-page${embedded ? " embedded" : ""}`}>
      <header className="tool-head">
        <div>
          {!embedded && <button className="tool-back" onClick={onBack}>← Main page</button>}
          <h1><Table2 size={18} /> Data Tables</h1>
          <p>Lightweight spreadsheets stored in the SQL database.</p>
        </div>
        <div className="tool-actions">
          <button className="btn" onClick={() => loadTables(selected)}><RefreshCw size={14} /> Refresh</button>
          <button className="btn" onClick={() => openCsv()} title="Create a new data table from a CSV file or pasted CSV text"><Upload size={14} /> Import CSV</button>
          <button className="btn btn-primary" onClick={openScratch} title="Create an empty table by naming its columns"><Plus size={14} /> New table</button>
        </div>
      </header>

      {error && <div className="tool-error">{error}</div>}
      {notice && <div className="dt-notice">{notice}</div>}

      <div className="dt-layout">
        <aside className="dt-side">
          {loading ? (
            <div className="tool-empty">Loading…</div>
          ) : tables.length === 0 ? (
            <div className="tool-empty">No data tables yet.</div>
          ) : (
            tables.map((t) => (
              <button key={t.id} className={`dt-side-item ${t.id === selected ? "active" : ""}`} onClick={() => setSelected(t.id)}>
                <span>{t.name}</span>
              </button>
            ))
          )}
        </aside>

        <div className="dt-main">
          {!table ? (
            <div className="tool-empty">Create a data table to get started — by hand, or by importing a CSV.</div>
          ) : (
            <>
              <div className="dt-main-head">
                <div>
                  <h2>{table.name}</h2>
                  <span className="dt-meta">{table.columns.length} columns · {rows.length} rows</span>
                </div>
                <div className="tool-actions">
                  <button className="btn mini" onClick={addColumn}><Plus size={12} /> Column</button>
                  <button className="btn mini" onClick={addRow}><Plus size={12} /> Row</button>
                  <button className="btn mini" onClick={() => openCsv(table.id)} title="Append the rows of a CSV file — new columns are added automatically"><Upload size={12} /> CSV rows</button>
                  <button className="btn mini danger" onClick={() => removeTable(table)}><Trash2 size={12} /> Table</button>
                </div>
              </div>
              {table.columns.length === 0 ? (
                <div className="tool-empty">This table has no columns yet.</div>
              ) : (
                <div className="dt-scroll">
                  <table className="tool-table dt-table">
                    <thead>
                      <tr>
                        {table.columns.map((c) => <th key={c}>{c}</th>)}
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          {table.columns.map((c) => (
                            <td key={c}>
                              <input
                                className="dt-cell"
                                value={String(row.data[c] ?? "")}
                                onChange={(e) => updateCell(row, c, e.target.value)}
                              />
                            </td>
                          ))}
                          <td className="tool-row-actions">
                            <button className="btn mini danger" onClick={() => removeRow(row)}><Trash2 size={12} /></button>
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr><td colSpan={table.columns.length + 1} className="dt-empty-row">No rows yet — add one, or import a CSV.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {creating && (
        <div className="tool-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setCreating(null)}>
          <div className="tool-modal" role="dialog" aria-modal="true">
            <div className="tool-modal-head">
              <h2>
                {importTarget ? `Import CSV into “${importTarget.name}”` : "New data table"}
              </h2>
              <button className="modal-x" onClick={() => setCreating(null)}><X size={14} /></button>
            </div>

            {!creating.tableId && (
              <div className="dt-mode-tabs" role="tablist" aria-label="How to fill the table">
                <button
                  role="tab"
                  aria-selected={creating.mode === "scratch"}
                  className={`dt-mode-tab ${creating.mode === "scratch" ? "active" : ""}`}
                  onClick={() => setCreating({ ...creating, mode: "scratch" })}
                >
                  From scratch
                </button>
                <button
                  role="tab"
                  aria-selected={creating.mode === "csv"}
                  className={`dt-mode-tab ${creating.mode === "csv" ? "active" : ""}`}
                  onClick={() => setCreating({ ...creating, mode: "csv" })}
                >
                  Import CSV
                </button>
              </div>
            )}

            <label className="tool-label">{creating.tableId ? "Table name" : "Name"}</label>
            {creating.tableId ? (
              <input value={importTarget?.name || ""} readOnly />
            ) : (
              <input
                value={creating.name}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                placeholder={creating.mode === "csv" ? "customers.csv" : "Customers"}
              />
            )}

            {creating.mode === "scratch" ? (
              <>
                <label className="tool-label">Columns (comma separated)</label>
                <input value={creating.columns} onChange={(e) => setCreating({ ...creating, columns: e.target.value })} placeholder="name, email, plan" />
                <div className="field-help">The table starts empty — add rows from the table view afterwards.</div>
              </>
            ) : (
              <>
                <label className="tool-label">CSV file</label>
                <div className="tool-field-row">
                  <input
                    value={creating.fileName}
                    onChange={(e) => setCreating({ ...creating, fileName: e.target.value })}
                    placeholder="paste the CSV below, or choose a file"
                    readOnly
                  />
                  <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={14} /> Choose…</button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      pickCsvFile(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </div>

                <label className="tool-label">Or paste the CSV</label>
                <textarea
                  className="dt-csv-input"
                  value={creating.csv}
                  onChange={(e) => setCreating({ ...creating, csv: e.target.value, fileName: "" })}
                  placeholder={"id,name,plan\n1,Ada,pro\n2,Lin,free"}
                  spellCheck={false}
                />

                <div className="tool-field-row">
                  <div style={{ flex: 1 }}>
                    <label className="tool-label">Delimiter</label>
                    <Select value={creating.delimiter} onChange={(e) => setCreating({ ...creating, delimiter: e.target.value })}>
                      {DELIMITERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                    </Select>
                  </div>
                </div>

                <label className="tool-check">
                  <input
                    type="checkbox"
                    checked={creating.headerRow}
                    onChange={(e) => setCreating({ ...creating, headerRow: e.target.checked })}
                  />
                  First row holds the column names
                </label>

                <div className="field-help">
                  {creating.csv.trim()
                    ? `≈ ${csvRowEstimate} row${csvRowEstimate === 1 ? "" : "s"} · columns ${creating.headerRow ? "from the first line" : "named A, B, C …"}`
                    : "Comma, tab, semicolon and pipe separated files all work — quoted fields are handled."}
                  {creating.tableId ? " New columns in the file are added to this table." : ""}
                </div>
              </>
            )}

            <div className="tool-modal-actions">
              <button className="btn" onClick={() => setCreating(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={createTable} disabled={busy}>
                {busy
                  ? creating.mode === "csv" ? "Importing…" : "Creating…"
                  : creating.mode === "csv" ? (creating.tableId ? "Import rows" : "Import as table") : "Create table"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
