import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpCircle, Check, Loader2, RefreshCw } from "lucide-react";
import { api } from "../api";
import type { UpdateStatus } from "../types";

const BUSY = new Set(["downloading", "installing", "restarting"]);

/**
 * Wait for the copy to come back after the restart, then reload the page so
 * the new interface is loaded. Gives up quietly after a few minutes — the
 * Setup page then shows what happened (done, or rolled back).
 */
async function waitForRestart(target: string) {
  const deadline = Date.now() + 5 * 60_000;
  await new Promise((r) => setTimeout(r, 4000));
  while (Date.now() < deadline) {
    try {
      const s = await api.update.status();
      if (s.current === target || s.state.phase === "failed" || s.state.phase === "done") {
        window.location.reload();
        return;
      }
    } catch {
      /* the server is restarting */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  window.location.reload();
}

/** Keeps the update status fresh while one runs (shared by the panel and the banner). */
function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const waiting = useRef(false);
  const load = useCallback(() => api.update.status().then(setStatus).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!status || !BUSY.has(status.state.phase)) return;
    if (status.state.phase === "restarting" && status.state.target && !waiting.current) {
      waiting.current = true;
      waitForRestart(status.state.target);
      return;
    }
    const t = setTimeout(load, 1500);
    return () => clearTimeout(t);
  }, [status, load]);
  return { status, setStatus, load };
}

/**
 * Setup page card: which version this copy runs, whether a newer one is out
 * and — for the owner — the "Update now" button. Updating keeps .env and all
 * data; a failed update puts the previous version back on its own.
 */
export default function UpdatePanel() {
  const { status, setStatus, load } = useUpdateStatus();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  if (!status) return null;
  const busy = BUSY.has(status.state.phase);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await api.update.check());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const update = async () => {
    if (!window.confirm("Update this copy now? It restarts for a minute; your workflows, credentials and settings stay as they are.")) return;
    setError(null);
    try {
      await api.update.apply();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <article className="setup-card">
      <h3>
        <ArrowUpCircle size={14} /> UPDATES
      </h3>
      <dl className="mainhub-facts">
        <div>
          <dt>This copy runs</dt>
          <dd>
            <code>{status.current}</code>
          </dd>
        </div>
        <div>
          <dt>Newest version</dt>
          <dd>{status.latest ? <code>{status.latest}</code> : "not known yet"}</dd>
        </div>
      </dl>
      {busy ? (
        <div className="setup-banner warn">
          <Loader2 size={14} className="spin" /> {status.state.message || "Updating…"}
        </div>
      ) : status.state.phase === "failed" && status.state.error ? (
        <div className="setup-banner warn">
          <AlertTriangle size={14} /> The last update failed: {status.state.error}
        </div>
      ) : status.state.phase === "done" ? (
        <div className="setup-banner ok">
          <Check size={14} /> {status.state.message || "Updated."}
        </div>
      ) : null}
      <p className="setup-note">
        {status.canUpdate
          ? "Updating downloads the new version from w-flow.tech with this copy's licence key, keeps .env and ./data as they are, and restarts. If the new version does not start, the previous one is put back automatically."
          : status.reason}
      </p>
      <div className="setup-actions">
        {status.available && status.canUpdate && status.isOwner && (
          <button className="btn btn-primary btn-sm" onClick={update} disabled={busy}>
            <ArrowUpCircle size={12} /> Update now
          </button>
        )}
        <button className="btn btn-sm" onClick={check} disabled={busy || checking}>
          {checking ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Check for updates
        </button>
        {!status.available && status.latest && <span className="setup-test ok">Up to date.</span>}
        {status.available && !status.isOwner && <span className="setup-note">The owner of this copy can update it.</span>}
        {error && <span className="setup-test err">{error}</span>}
      </div>
    </article>
  );
}

/** A slim banner over the workspace telling the owner a new version is out. */
export function UpdateBanner({ onOpenSetup }: { onOpenSetup: () => void }) {
  const { status } = useUpdateStatus();
  const [hidden, setHidden] = useState(false);
  if (!status || hidden || !status.isOwner || !status.canUpdate) return null;
  if (!status.available && !BUSY.has(status.state.phase)) return null;
  return (
    <div className="verify-banner" role="status">
      <span>
        {BUSY.has(status.state.phase)
          ? status.state.message || "Updating this copy…"
          : "A new version of W flow is available for this copy."}{" "}
        {!BUSY.has(status.state.phase) && (
          <button className="btn btn-sm btn-primary" onClick={onOpenSetup}>
            See the update
          </button>
        )}
      </span>
      <button className="verify-banner-x" onClick={() => setHidden(true)} title="Dismiss">
        ×
      </button>
    </div>
  );
}
