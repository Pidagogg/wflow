import { useEffect, useState } from "react";
import { Globe, Lock, Share2, Trash2, UserPlus, Users, X } from "lucide-react";
import type { CommunityPost, SharedBy, ShareRole, Workflow } from "../types";
import RoleSelect, { ROLE_HELP, ROLE_LABEL } from "./RoleSelect";
import { api } from "../api";

interface Props {
  workflow: { id: string; name: string; description?: string };
  collaborators?: Workflow["collaborators"];
  /** the owner who shared this workflow with the current account (viewer view) */
  sharedBy?: SharedBy;
  onClose: () => void;
  /** called after a collaborator is added/removed so the editor can refresh its meta */
  onCollaboratorsChange?: (collabs: Workflow["collaborators"]) => void;
  /** true when the current user is the owner (only they can manage sharing) */
  isOwner?: boolean;
  /** ends the shared session (owner only): saves the workflow and removes every collaborator */
  onStopSharing?: () => void;
}

type Visibility = "public" | "private" | "restricted";

export default function ShareModal({ workflow, collaborators = [], sharedBy, onClose, onCollaboratorsChange, isOwner = true, onStopSharing }: Props) {
  // community publish state
  const [title, setTitle] = useState(workflow.name || "");
  const [description, setDescription] = useState(workflow.description || "");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishState, setPublishState] = useState<{ kind: "ok" | "err" | "notitle" | "nousers"; msg?: string } | null>(null);
  const [post, setPost] = useState<CommunityPost | null>(null);

  // Seed the anonymous switch from the profile's preference, when set.
  useEffect(() => {
    api.profile
      .me()
      .then((p) => setAnonymous(!!p.anonymousByDefault))
      .catch(() => {});
  }, []);

  // collaboration state
  const [shareEmail, setShareEmail] = useState("");
  const [shareRole, setShareRole] = useState<ShareRole>("editor");
  const [sharing, setSharing] = useState(false);
  const [shareState, setShareState] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const publish = async () => {
    const t = title.trim();
    if (!t) {
      setPublishState({ kind: "notitle" });
      return;
    }
    if (visibility === "restricted") {
      const emails = allowedUsers.split(/[,\n;]/).map((e) => e.trim().toLowerCase()).filter(Boolean);
      if (!emails.length) {
        setPublishState({ kind: "nousers" });
        return;
      }
    }
    setPublishing(true);
    setPublishState(null);
    try {
      const allowed = allowedUsers.split(/[,\n;]/).map((e) => e.trim()).filter(Boolean);
      const created = await api.community.publish({
        workflowId: workflow.id,
        title: t,
        description: description.trim(),
        visibility,
        allowedUsers: visibility === "restricted" ? allowed : undefined,
        anonymous,
      });
      setPost(created);
      setPublishState({ kind: "ok" });
    } catch (err) {
      setPublishState({ kind: "err", msg: (err as Error).message });
    } finally {
      setPublishing(false);
    }
  };

  const unpublish = async () => {
    if (!post) return;
    try {
      await api.community.remove(post.id);
      setPost(null);
      setPublishState({ kind: "ok", msg: "Post removed from the community." });
    } catch (err) {
      setPublishState({ kind: "err", msg: (err as Error).message });
    }
  };

  const addCollaborator = async () => {
    const email = shareEmail.trim().toLowerCase();
    if (!email) return;
    setSharing(true);
    setShareState(null);
    try {
      const res = await api.workflows.share(workflow.id, email, shareRole);
      onCollaboratorsChange?.(res.collaborators);
      setShareEmail("");
      setShareState({ kind: "ok", msg: `Shared with ${email} — ${ROLE_LABEL[shareRole].toLowerCase()}: ${ROLE_HELP[shareRole]}` });
    } catch (err) {
      setShareState({ kind: "err", msg: (err as Error).message });
    } finally {
      setSharing(false);
    }
  };

  const changeRole = async (userId: string, role: ShareRole) => {
    try {
      const res = await api.workflows.setRole(workflow.id, userId, role);
      onCollaboratorsChange?.(res.collaborators);
    } catch (err) {
      setShareState({ kind: "err", msg: (err as Error).message });
    }
  };

  const removeCollaborator = async (userId: string) => {
    try {
      const res = await api.workflows.unshare(workflow.id, userId);
      onCollaboratorsChange?.(res.collaborators);
    } catch (err) {
      setShareState({ kind: "err", msg: (err as Error).message });
    }
  };

  const visOptions: Array<{ value: Visibility; label: string; icon: typeof Globe; help: string }> = [
    { value: "public", label: "Public — everyone can see and import it", icon: Globe, help: "Shown under User Templates for all registered users." },
    { value: "private", label: "Private — only you", icon: Lock, help: "Kept as a draft: only your account sees the template." },
    { value: "restricted", label: "Restricted — only specific users", icon: Users, help: "Only the email addresses you list below can see and import it." },
  ];

  const isShared = (collaborators || []).length > 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal modal-share" role="dialog" aria-modal="true" aria-label="Share workflow" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">SHARE &amp; COLLABORATE</div>
            <div className="modal-sub">Publish this workflow as a template or work on it together with another user.</div>
          </div>
          <button className="modal-x" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="node-modal-body">
          {/* collaboration */}
          <div className="insp-section">
            <div className="field-section">Work together — share with a user</div>
            <div className="field-help" style={{ marginTop: 0 }}>
              You choose what each person may do — <b>view</b>, <b>view &amp; run</b> or <b>edit</b>. Everyone sees the same workflow, and every
              save updates it for all.
              While a workflow is shared, saves are limited to <b>1 auto-save per minute</b>, and each of you additionally
              has <b>1 manual save per minute</b> — the toolbar shows when your manual save is ready or used up.
            </div>
            {isShared && isOwner && (
              <div className="share-collab-list">
                {collaborators!.map((c) => (
                  <div key={c.userId} className="share-collab-row">
                    <span className="share-collab-mail" title={c.name ? `${c.name} · ${c.email}` : c.email}>
                      {c.name ? (
                        <>
                          <b>{c.name}</b> <small>{c.email}</small>
                        </>
                      ) : (
                        c.email
                      )}
                    </span>
                    {isOwner && <RoleSelect value={c.role} onChange={(r) => changeRole(c.userId, r)} />}
                    {isOwner && (
                      <button className="icon-btn btn-danger" onClick={() => removeCollaborator(c.userId)} title={`Stop sharing with ${c.email}`}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isOwner ? (
              <>
                <div className="share-collab-add">
                  <input
                    value={shareEmail}
                    onChange={(e) => setShareEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addCollaborator()}
                    placeholder="friend@example.com"
                    type="email"
                  />
                  <RoleSelect value={shareRole} onChange={setShareRole} disabled={sharing} />
                  <button className="btn btn-sm btn-primary" onClick={addCollaborator} disabled={sharing || !shareEmail.trim()}>
                    <UserPlus size={12} /> {sharing ? "Sharing…" : "Share"}
                  </button>
                </div>
                {isShared && onStopSharing && (
                  <div className="field-help" style={{ marginTop: 10 }}>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={onStopSharing}
                      title="Save the workflow and remove every collaborator — they lose access immediately"
                    >
                      <Trash2 size={12} /> End shared session — remove all collaborators
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="field-help">
                This workflow was shared with you by <b>{sharedBy?.name || sharedBy?.email || "its owner"}</b> — only they can add or remove collaborators or end the session.
              </div>
            )}
            {shareState && (
              <div className={`field-help ${shareState.kind === "ok" ? "ok-text" : "err-text"}`}>
                {shareState.kind === "ok" ? "✓" : "✗"} {shareState.msg}
              </div>
            )}
          </div>

          {/* community publish */}
          <div className="insp-section">
            <div className="field-section">Community</div>
            <div className="field">
              <div className="field-label">Post title</div>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Webhook → AI Summarizer" />
            </div>
            <div className="field">
              <div className="field-label">Description</div>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this workflow do?" />
            </div>
            <div className="field">
              <div className="field-label">Who can see it?</div>
              <div className="share-vis-list">
                {visOptions.map((o) => (
                  <label key={o.value} className={`share-vis-opt ${visibility === o.value ? "active" : ""}`}>
                    <input type="radio" name="share-vis" checked={visibility === o.value} onChange={() => setVisibility(o.value)} />
                    <o.icon size={13} />
                    <span>
                      <b>{o.label.split("—")[0].trim()}</b>
                      <small>{o.help}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {visibility === "restricted" && (
              <div className="field">
                <div className="field-label">Allowed users (emails)</div>
                <textarea
                  value={allowedUsers}
                  onChange={(e) => setAllowedUsers(e.target.value)}
                  placeholder={"ada@example.com\nbob@example.com"}
                  style={{ minHeight: 60 }}
                />
                <div className="field-help">One email per line, or comma-separated. Only these accounts can find and import the post.</div>
              </div>
            )}
            <label className="toggle" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
              <span className="toggle-track" />
              <span className="toggle-label">Publish anonymously (hide my name and profile link)</span>
            </label>
            {post ? (
              <div className="share-published-box">
                <span>✓ Published as “{post.title}” ({post.visibility === "public" ? "public" : post.visibility === "private" ? "private" : "restricted"}).</span>
                <button className="btn btn-sm btn-ghost btn-danger" onClick={unpublish}>
                  Remove template
                </button>
              </div>
            ) : (
              <button className="btn btn-sm btn-primary share-publish-btn" onClick={publish} disabled={publishing}>
                <Share2 size={12} /> {publishing ? "Publishing…" : "Publish as template"}
              </button>
            )}
            {publishState && (
              <div className={`field-help ${publishState.kind === "ok" ? "ok-text" : "err-text"}`}>
                {publishState.kind === "ok" ? "✓" : "✗"}{" "}
                {publishState.kind === "notitle"
                  ? "Give the template a title first."
                  : publishState.kind === "nousers"
                    ? "Add at least one allowed user email for a restricted template."
                    : publishState.msg || "Published — find it under User Templates."}
              </div>
            )}
            <div className="field-help">API keys, passwords and webhook secrets are removed automatically when publishing.</div>
          </div>
        </div>
      </div>
    </div>
  );
}