import { useEffect, useState } from "react";
import { FolderOpen, FolderTree, Share2, Trash2, UserPlus, X } from "lucide-react";
import type { FolderShare, ShareRole } from "../types";
import RoleSelect, { ROLE_HELP, ROLE_LABEL } from "./RoleSelect";
import { api } from "../api";

interface Props {
  /** the folder being shared */
  folder: { id: string; name: string };
  onClose: () => void;
  /** called after the share was created, toggled or ended */
  onChanged?: (share: FolderShare | null) => void;
  onMessage?: (text: string, kind?: "ok" | "err") => void;
}

/**
 * Share ONE folder (including the workflows inside it) with another account.
 * An account may only have one shared folder at a time — if a different folder
 * is shared already, the server refuses and this modal says which one to end
 * first. `includeSubfolders` decides whether subfolders and their workflows are
 * shared too.
 */
export default function FolderShareModal({ folder, onClose, onChanged, onMessage }: Props) {
  const [share, setShare] = useState<FolderShare | null>(null);
  const [blockedBy, setBlockedBy] = useState<{ folderId: string; folderName: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [includeSubfolders, setIncludeSubfolders] = useState(false);
  const [role, setRole] = useState<ShareRole>("editor");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.workflows
      .folderShare(folder.id)
      .then((res) => {
        if (cancelled) return;
        setShare(res.share);
        setBlockedBy(res.blockedBy);
        setIncludeSubfolders(!!res.share?.includeSubfolders);
        setRole(res.share?.role || "editor");
      })
      .catch((err) => !cancelled && setMsg({ ok: false, text: String((err as Error).message || err) }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [folder.id]);

  const shareFolder = async () => {
    const target = email.trim().toLowerCase();
    if (!target) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.workflows.shareFolder(folder.id, target, includeSubfolders, role);
      setShare(res.share);
      setBlockedBy(null);
      setEmail("");
      setMsg({
        ok: true,
        text: `“${folder.name}” is shared with ${target} — ${ROLE_HELP[role].toLowerCase()} It covers every workflow inside it${includeSubfolders ? ", including its subfolders" : ""}.`,
      });
      onChanged?.(res.share);
      onMessage?.(`Folder “${folder.name}” shared with ${target}`);
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  const toggleSubfolders = async (next: boolean) => {
    setIncludeSubfolders(next);
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.workflows.updateFolderShare(folder.id, { includeSubfolders: next });
      setShare(res.share);
      setMsg({
        ok: true,
        text: next
          ? "Subfolders are now shared as well — every workflow inside them is included."
          : "Only the workflows directly inside this folder are shared now.",
      });
      onChanged?.(res.share);
    } catch (err) {
      setIncludeSubfolders(!next);
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (next: ShareRole) => {
    const prev = role;
    setRole(next);
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.workflows.updateFolderShare(folder.id, { role: next });
      setShare(res.share);
      setMsg({ ok: true, text: `${share?.email || "They"}: ${ROLE_LABEL[next].toLowerCase()} — ${ROLE_HELP[next]}` });
      onChanged?.(res.share);
    } catch (err) {
      setRole(prev);
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  const stopSharing = async () => {
    if (!window.confirm(`End the share of “${folder.name}”? The user immediately loses access to its workflows.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.workflows.unshareFolder(folder.id);
      setShare(null);
      setIncludeSubfolders(false);
      setMsg({ ok: true, text: "The folder is no longer shared." });
      onChanged?.(null);
      onMessage?.(`“${folder.name}” is no longer shared`);
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal panel panel-corner modal-folder-share" role="dialog" aria-modal="true" aria-label={`Share folder ${folder.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">
              <Share2 size={13} /> SHARE FOLDER
            </div>
            <div className="modal-sub">
              <FolderOpen size={12} /> {folder.name}
            </div>
          </div>
          <button className="modal-x" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="node-modal-body">
          <div className="field-help" style={{ marginTop: 0 }}>
            You choose what the user may do with every workflow inside this folder — <b>view</b>, <b>view &amp; run</b> or{" "}
            <b>edit</b> — same collaboration as sharing a single workflow, just for the whole folder. You can only have <b>one folder shared at a time</b>. While a folder is
            shared, saves use the shared-workflow limits: 1 auto-save per minute and 1 manual save per minute and user.
          </div>

          {loading ? (
            <div className="run-loading" style={{ padding: 18 }}>
              <span className="spinner" /> LOADING SHARE…
            </div>
          ) : (
            <>
              {blockedBy && (
                <div className="settings-account-msg err" style={{ marginTop: 12 }}>
                  ✗ “{blockedBy.folderName}” is shared already — only one folder can be shared per account. End that share first, then share this one.
                </div>
              )}

              {share ? (
                <>
                  <div className="field-section" style={{ marginTop: 14 }}>
                    SHARED WITH
                  </div>
                  <div className="share-collab-list">
                    <div className="share-collab-row">
                      <span className="share-collab-mail" title={share.name ? `${share.name} · ${share.email}` : share.email}>
                        {share.name ? (
                          <>
                            <b>{share.name}</b> <small>{share.email}</small>
                          </>
                        ) : (
                          share.email
                        )}
                      </span>
                      <RoleSelect value={role} onChange={changeRole} disabled={busy} />
                      <button className="icon-btn btn-danger" onClick={stopSharing} disabled={busy} title={`Stop sharing ${folder.name} with ${share.email}`}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  <label className="toggle" style={{ marginTop: 12 }}>
                    <input
                      type="checkbox"
                      checked={includeSubfolders}
                      disabled={busy}
                      onChange={(e) => toggleSubfolders(e.target.checked)}
                    />
                    <span className="toggle-track" />
                    <span className="toggle-label">{includeSubfolders ? "ON" : "OFF"}</span>
                  </label>
                  <div className="field-help">
                    <FolderTree size={11} /> <b>Include subfolders</b> — {includeSubfolders
                      ? "on: subfolders and the workflows inside them are shared too."
                      : "off: only the workflows directly inside this folder are shared."}
                  </div>
                </>
              ) : (
                <>
                  <div className="field-section" style={{ marginTop: 14 }}>
                    SHARE WITH A USER
                  </div>
                  <div className="share-collab-add">
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && shareFolder()}
                      placeholder="friend@example.com"
                      type="email"
                      autoFocus
                    />
                    <RoleSelect value={role} onChange={setRole} disabled={busy} />
                    <button className="btn btn-sm btn-primary" onClick={shareFolder} disabled={busy || !email.trim()}>
                      <UserPlus size={12} /> {busy ? "Sharing…" : "Share folder"}
                    </button>
                  </div>
                  <label className="toggle" style={{ marginTop: 12 }}>
                    <input type="checkbox" checked={includeSubfolders} disabled={busy} onChange={(e) => setIncludeSubfolders(e.target.checked)} />
                    <span className="toggle-track" />
                    <span className="toggle-label">{includeSubfolders ? "ON" : "OFF"}</span>
                  </label>
                  <div className="field-help">
                    <FolderTree size={11} /> {includeSubfolders
                      ? "Subfolders and their workflows will be shared as well."
                      : "Only this folder — subfolders stay private. You can turn this on afterwards."}
                  </div>
                </>
              )}

              {msg && <div className={`field-help ${msg.ok ? "ok-text" : "err-text"}`}>{msg.ok ? "✓" : "✗"} {msg.text}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
