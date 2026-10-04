import { useCallback, useEffect, useState } from "react";
import { Clock, History, Loader2, RotateCcw, X } from "lucide-react";
import { api } from "../api";
import type { Workflow, WorkflowVersion } from "../types";

interface Props {
  workflowId: string;
  /** called with the restored workflow so the editor can put it on the canvas */
  onRestored: (workflow: Workflow) => void;
  onClose: () => void;
  /** the editor's toast helper */
  onMessage: (text: string, kind?: "ok" | "err") => void;
}

/**
 * Version history — every graph-changing save snapshots the state the workflow
 * was leaving (see server/store.js), so an accidental rewrite (by hand, or by
 * the AI builder) can be undone. Restoring is itself undoable: the current
 * state is snapshotted first.
 */
export default function WorkflowVersions({ workflowId, onRestored, onClose, onMessage }: Props) {
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [max, setMax] = useState(20);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.workflows.versions(workflowId);
      setVersions(res.versions || []);
      setMax(res.max || 20);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  const restore = async (version: WorkflowVersion) => {
    setRestoring(version.id);
    try {
      const wf = await api.workflows.restoreVersion(workflowId, version.id);
      onRestored(wf);
      onMessage(`Restored the version from ${new Date(version.savedAt).toLocaleString()}.`, "ok");
      onClose();
    } catch (err) {
      onMessage(`Could not restore: ${(err as Error).message}`, "err");
      setRestoring(null);
    }
  };

  const fmtWhen = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  };

  const reasonLabel = (reason: string) => {
    if (reason === "before-restore") return "before a restore";
    if (reason === "manual") return "manual snapshot";
    return "autosave";
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal wf-versions" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="wf-versions-title">
            <History size={15} /> VERSION HISTORY
          </span>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        <div className="wf-versions-body">
          <p className="wf-versions-intro">
            Every save that changes the graph keeps the state the workflow was leaving, so you can move a workflow back to how it
            looked before. The newest {max} versions are kept, and credentials are never part of a snapshot.
          </p>

          {loading && (
            <div className="wf-versions-empty">
              <Loader2 size={14} className="spin" /> Loading versions…
            </div>
          )}
          {error && <div className="field-json-error">⚠ {error}</div>}
          {!loading && !error && versions.length === 0 && (
            <div className="wf-versions-empty">
              No versions yet — one is recorded the first time you save a change to this workflow's nodes or connections.
            </div>
          )}

          <div className="wf-versions-list">
            {versions.map((v) => (
              <div key={v.id} className="wf-version-row">
                <div className="wf-version-icon">
                  <Clock size={13} />
                </div>
                <div className="wf-version-main">
                  <div className="wf-version-when">{fmtWhen(v.savedAt)}</div>
                  <div className="wf-version-meta">
                    <span>{v.nodeCount} node{v.nodeCount === 1 ? "" : "s"}</span>
                    <span>·</span>
                    <span>{v.edgeCount} connection{v.edgeCount === 1 ? "" : "s"}</span>
                    <span>·</span>
                    <span className="wf-version-reason">{reasonLabel(v.reason)}</span>
                    {v.name && (
                      <>
                        <span>·</span>
                        <span className="wf-version-name">{v.name}</span>
                      </>
                    )}
                  </div>
                </div>
                <button className="btn btn-sm" onClick={() => restore(v)} disabled={restoring !== null}>
                  {restoring === v.id ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} Restore
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <span className="wf-versions-hint">Restoring snapshots the current state first, so it can be undone too.</span>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
