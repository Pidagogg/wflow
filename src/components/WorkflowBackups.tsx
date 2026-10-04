import { useCallback, useEffect, useState } from "react";
import { Clock, History, Loader2, Pin, RotateCcw, User, X } from "lucide-react";
import { api } from "../api";
import type { Workflow, WorkflowBackup, WorkflowBackupList } from "../types";

interface Props {
  workflowId: string;
  /** the editor adopts the workflow the server restored */
  onRestored: (workflow: Workflow) => void;
  onClose: () => void;
  /** toast helper from the editor */
  onMessage?: (text: string, kind?: "ok" | "err") => void;
}

// "2 minutes ago" — short, relative, and honest for anything older than a day.
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleString();
}

function reasonLabel(reason: string): string {
  if (reason === "manual") return "manual save";
  if (reason === "autosave") return "auto-save";
  if (reason === "before-rewind") return "before a rewind";
  if (reason === "rewind") return "rewind";
  if (reason === "created") return "created";
  return reason || "save";
}

/**
 * Backup & rewind — the shared-mode safety net.
 *
 * A shared workflow is ONE record written by two people, so whoever was away
 * when the other saved ten times needs a way back without bothering the other
 * user. The server keeps a rolling buffer of the last saves tagged with who
 * made them; this menu offers the three things that matter:
 *   - the state about a minute ago (undo the last minute),
 *   - the newest save YOU made (jump past everything the other person did),
 *   - any of the last saves, whoever made it.
 *
 * Restoring snapshots the current state first, so a rewind is itself undoable.
 */
export default function WorkflowBackups({ workflowId, onRestored, onClose, onMessage }: Props) {
  const [data, setData] = useState<WorkflowBackupList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.workflows.backups(workflowId, 10);
      setData(res);
      setError(null);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = useCallback(
    async (backup: WorkflowBackup) => {
      if (
        !window.confirm(
          `Roll the workflow back to the state saved ${ago(backup.savedAt)} by ${backup.mine ? "you" : backup.userName || "the other user"}?\n\nThe current state is kept as a backup first, so this can be undone the same way.`
        )
      ) {
        return;
      }
      setRestoringId(backup.id);
      try {
        const wf = await api.workflows.restoreBackup(workflowId, backup.id);
        onRestored(wf);
        onMessage?.(`Rewound to the state from ${ago(backup.savedAt)}.`);
        onClose();
      } catch (err) {
        onMessage?.(`Rewind failed: ${(err as Error).message}`, "err");
      } finally {
        setRestoringId(null);
      }
    },
    [workflowId, onRestored, onMessage, onClose]
  );

  const quick = (backup: WorkflowBackup | null, label: string) => (
    <button
      className="btn btn-sm"
      onClick={() => backup && restore(backup)}
      disabled={!backup || !!restoringId}
      title={backup ? `Saved ${ago(backup.savedAt)} — click to roll back` : "No state old enough is kept yet"}
    >
      {restoringId && backup && restoringId === backup.id ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />}
      {label}
    </button>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal wf-backups" role="dialog" aria-modal="true" aria-label="Backup and rewind" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title wf-backups-title">
              <History size={13} /> BACKUP &amp; REWIND
            </div>
            <div className="modal-sub">Roll this shared workflow back — without asking the other user.</div>
          </div>
          <button className="modal-x" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="wf-backups-body">
          <p className="wf-backups-intro">
            Every save of this workflow is kept in a rolling buffer, tagged with <b>who</b> made it. Because a shared workflow is one
            record, a collaborator's saves replace yours — rewind to the state <b>about a minute ago</b>, to <b>your own last save</b>,
            or to any of the last {data?.max || 50} saves below. Rewinding snapshots the current state first, so it can be undone too.
          </p>

          {loading && (
            <div className="wf-backups-empty">
              <Loader2 size={14} className="spin" /> Loading backups…
            </div>
          )}

          {!loading && error && (
            <div className="wf-backups-empty" style={{ color: "var(--red)" }}>
              ✗ {error}
            </div>
          )}

          {!loading && !error && data && (
            <>
              <div className="wf-backups-quick">
                <div className="wf-backups-quick-label">
                  <Clock size={11} /> QUICK REWIND
                </div>
                <div className="wf-backups-quick-actions">
                  {quick(data.rewind, `1 minute ago${data.rewind ? ` · ${ago(data.rewind.savedAt)}` : ""}`)}
                  {quick(data.myLast, `My last save${data.myLast ? ` · ${ago(data.myLast.savedAt)}` : ""}`)}
                </div>
                {!data.rewind && <div className="wf-backups-hint">Nothing old enough is kept yet — the buffer fills as you both save.</div>}
                {!data.myLast && <div className="wf-backups-hint">You have not saved this workflow yourself yet.</div>}
              </div>

              <div className="wf-backups-list-title">
                Last {Math.min(10, data.backups.length)} SAVE{data.backups.length === 1 ? "" : "S"}
              </div>
              {data.backups.length === 0 ? (
                <div className="wf-backups-empty">No saves recorded yet — one lands here the next time the workflow is saved.</div>
              ) : (
                <div className="wf-backups-list">
                  {data.backups.map((backup) => (
                    <div key={backup.id} className={`wf-backups-row${backup.mine ? " mine" : ""}`}>
                      <div className="wf-backups-row-main">
                        <span className="wf-backups-row-when">
                          <Clock size={11} /> {ago(backup.savedAt)}
                        </span>
                        <span className={`wf-backups-row-who${backup.mine ? " me" : ""}`}>
                          <User size={10} /> {backup.mine ? "You" : backup.userName || "another user"}
                        </span>
                        <span className="wf-backups-row-meta">
                          {backup.nodeCount} nodes · {backup.edgeCount} connections · {reasonLabel(backup.reason)}
                        </span>
                      </div>
                      <button className="btn btn-sm" onClick={() => restore(backup)} disabled={!!restoringId} title="Roll the workflow back to this saved state">
                        {restoringId === backup.id ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="wf-backups-foot">
                <Pin size={11} /> Backups never contain credentials — restoring only replaces this workflow's nodes and connections.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
