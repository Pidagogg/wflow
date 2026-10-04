/**
 * CollabPanel — the side panel next to the Log console for working on a
 * workflow together (server/workflow-collab.js):
 *
 *   Comments — threads pinned to nodes (or the whole workflow), replies,
 *              resolve / reopen, delete, and @mentions picked from the people
 *              who can open the workflow (they get an e-mail when the
 *              instance can send mail).
 *   Changes  — who changed what: each save with its author and, per node, what
 *              changed; "Restore this node" puts that one node back the way it
 *              was before the change, leaving the rest of the workflow alone.
 *
 * It stays closed until opened — from the Log console's header or a node's
 * Comments button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Check, History, MessageSquare, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "../api";
import type { FlowNode, WorkflowComment, WorkflowHistoryEntry, WorkflowPerson, WorkflowRole } from "../types";

export type CollabTab = "comments" | "history";

interface Props {
  workflowId: string;
  tab: CollabTab;
  onTab: (t: CollabTab) => void;
  /** show only this node's threads (null = all) */
  nodeId: string | null;
  onNodeFilter: (id: string | null) => void;
  /** labels for node ids */
  nodeLabels: Record<string, string>;
  onClose: () => void;
  /** open-thread counts per node, whenever the list changes */
  onCounts: (counts: Record<string, number>) => void;
  /** put one node back ("before" of a change); null removes a node that was added */
  onRestoreNode: (nodeId: string, node: FlowNode | null) => void;
  /** select / center a node on the canvas */
  onFocusNode: (nodeId: string) => void;
}

const RANK: Record<WorkflowRole, number> = { viewer: 1, runner: 2, editor: 3, owner: 4 };

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

const personName = (p: WorkflowPerson) => p.name || p.email.split("@")[0];

// Mentions are stored as ids; in the text they read "@Name". Highlight those.
function MentionText({ text, names }: { text: string; names: string[] }) {
  if (!names.length) return <>{text}</>;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  const parts = text.split(new RegExp(`(@(?:${escaped.join("|")}))`, "g"));
  return (
    <>
      {parts.map((p, i) => (p.startsWith("@") && names.includes(p.slice(1)) ? <b key={i} className="mention">{p}</b> : <span key={i}>{p}</span>))}
    </>
  );
}

/** Text area with an @ picker: typing "@" lists the people with access. */
function Composer({
  people,
  placeholder,
  onSubmit,
  busy,
  autoFocus,
}: {
  people: WorkflowPerson[];
  placeholder: string;
  onSubmit: (text: string, mentions: string[]) => Promise<void>;
  busy: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<WorkflowPerson[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const matches = query === null ? [] : people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6);

  const onChange = (value: string) => {
    setText(value);
    const caret = area.current?.selectionStart ?? value.length;
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,30})$/);
    setQuery(m ? m[1] : null);
  };

  const pick = (p: WorkflowPerson) => {
    const caret = area.current?.selectionStart ?? text.length;
    const head = text.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${personName(p)} `);
    setText(head + text.slice(caret));
    setMentions((list) => (list.some((x) => x.userId === p.userId) ? list : [...list, p]));
    setQuery(null);
    area.current?.focus();
  };

  const submit = async () => {
    const body = text.trim();
    if (!body) return;
    // Only mentions whose "@Name" is still in the text count.
    const ids = mentions.filter((p) => body.includes(`@${personName(p)}`)).map((p) => p.userId);
    await onSubmit(body, ids);
    setText("");
    setMentions([]);
  };

  return (
    <div className="collab-composer">
      <textarea
        ref={area}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (query !== null && matches.length && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            pick(matches[0]);
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && query !== null) {
            e.stopPropagation();
            setQuery(null);
          }
        }}
      />
      {query !== null && matches.length > 0 && (
        <div className="collab-mentions" role="listbox">
          {matches.map((p) => (
            <button key={p.userId} role="option" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
              <AtSign size={11} /> {personName(p)} <small>{p.email}</small>
            </button>
          ))}
        </div>
      )}
      <div className="collab-composer-actions">
        <span className="field-help">@ to mention · Ctrl+Enter to send</span>
        <button className="btn btn-sm btn-primary" onClick={submit} disabled={busy || !text.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

export default function CollabPanel({ workflowId, tab, onTab, nodeId, onNodeFilter, nodeLabels, onClose, onCounts, onRestoreNode, onFocusNode }: Props) {
  const [comments, setComments] = useState<WorkflowComment[]>([]);
  const [people, setPeople] = useState<WorkflowPerson[]>([]);
  const [role, setRole] = useState<WorkflowRole>("viewer");
  const [me, setMe] = useState("");
  const [history, setHistory] = useState<WorkflowHistoryEntry[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadComments = useCallback(async () => {
    try {
      const res = await api.workflows.comments(workflowId);
      setComments(res.comments);
      setPeople(res.people);
      setRole(res.role);
      setMe(res.me);
      const counts: Record<string, number> = {};
      for (const c of res.comments) if (!c.parentId && !c.resolved && c.nodeId) counts[c.nodeId] = (counts[c.nodeId] || 0) + 1;
      onCounts(counts);
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  }, [workflowId, onCounts]);

  useEffect(() => {
    loadComments();
    const t = setInterval(() => !document.hidden && loadComments(), 20_000);
    return () => clearInterval(t);
  }, [loadComments]);

  useEffect(() => {
    if (tab !== "history") return;
    setHistory(null);
    api.workflows
      .history(workflowId)
      .then((r) => setHistory(r.entries))
      .catch((err) => setError(String((err as Error).message || err)));
  }, [tab, workflowId]);

  const names = useMemo(() => people.map(personName), [people]);
  const roots = comments
    .filter((c) => !c.parentId && (nodeId === null || c.nodeId === nodeId) && (showResolved || !c.resolved))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const repliesOf = (id: string) => comments.filter((c) => c.parentId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const canModerate = RANK[role] >= RANK.editor;
  const canRestore = RANK[role] >= RANK.editor;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await loadComments();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const post = (text: string, mentions: string[], parentId?: string) =>
    run(() => api.workflows.addComment(workflowId, { nodeId, parentId, text, mentions })).then(() => setReplyTo(null));

  return (
    <aside className="collab-panel" aria-label="Comments and changes">
      <div className="collab-head">
        <div className="seg">
          <button className={tab === "comments" ? "active" : ""} onClick={() => onTab("comments")}>
            <MessageSquare size={12} /> Comments
          </button>
          <button className={tab === "history" ? "active" : ""} onClick={() => onTab("history")}>
            <History size={12} /> Changes
          </button>
        </div>
        <button className="modal-x" onClick={onClose} title="Close">
          <X size={13} />
        </button>
      </div>
      {error && <div className="settings-note err">{error}</div>}

      {tab === "comments" && (
        <div className="collab-body">
          <div className="collab-filter">
            {nodeId ? (
              <span>
                On <b>{nodeLabels[nodeId] || nodeId}</b> ·{" "}
                <button className="link-btn" onClick={() => onNodeFilter(null)}>
                  all comments
                </button>
              </span>
            ) : (
              <span>All comments</span>
            )}
            <label className="mcp-inline">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> resolved
            </label>
          </div>
          <Composer people={people} busy={busy} placeholder={nodeId ? `Comment on “${nodeLabels[nodeId] || nodeId}”…` : "Comment on this workflow…"} onSubmit={(t, m) => post(t, m)} />
          {roots.length === 0 && <div className="field-help">No {showResolved ? "" : "open "}comments here yet.</div>}
          {roots.map((c) => (
            <div className={`collab-thread${c.resolved ? " resolved" : ""}`} key={c.id}>
              {[c, ...repliesOf(c.id)].map((x) => (
                <div className={`collab-comment${x.mentions.includes(me) ? " mentions-me" : ""}`} key={x.id}>
                  <div className="collab-comment-head">
                    <b>{x.author}</b>
                    <span>{ago(x.createdAt)}</span>
                    {!x.parentId && x.nodeId && nodeId === null && (
                      <button className="link-btn" onClick={() => onFocusNode(x.nodeId!)} title="Show the node">
                        {nodeLabels[x.nodeId] || x.nodeId}
                      </button>
                    )}
                    {(x.userId === me || role === "owner") && (
                      <button className="icon-btn" onClick={() => window.confirm("Delete this comment?") && run(() => api.workflows.deleteComment(workflowId, x.id))} title="Delete">
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                  <div className="collab-comment-text">
                    <MentionText text={x.text} names={names} />
                  </div>
                </div>
              ))}
              <div className="collab-thread-actions">
                <button className="link-btn" onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>
                  Reply
                </button>
                {(canModerate || c.userId === me) && (
                  <button className="link-btn" onClick={() => run(() => api.workflows.updateComment(workflowId, c.id, { resolved: !c.resolved }))}>
                    <Check size={11} /> {c.resolved ? "Reopen" : "Resolve"}
                  </button>
                )}
              </div>
              {replyTo === c.id && <Composer people={people} busy={busy} autoFocus placeholder="Reply…" onSubmit={(t, m) => post(t, m, c.id)} />}
            </div>
          ))}
        </div>
      )}

      {tab === "history" && (
        <div className="collab-body">
          <div className="field-help">
            Every save that changed the workflow, newest first. Saves by the same person within a few minutes are one entry.
            {canRestore ? " “Restore” puts one node back the way it was before that change — nothing else moves; save to keep it." : ""}
          </div>
          {history === null && <div className="run-loading"><span className="spinner" /> Loading…</div>}
          {history?.length === 0 && <div className="field-help">No changes recorded yet.</div>}
          {history?.map((e) => (
            <div className="collab-change" key={e.id}>
              <div className="collab-comment-head">
                <b>{e.author}</b>
                <span>{ago(e.at)}</span>
              </div>
              {e.renamed && (
                <div className="collab-change-row">
                  renamed “{e.renamed.from}” → “{e.renamed.to}”
                </div>
              )}
              {e.nodes.map((n) => (
                <div className="collab-change-row" key={n.nodeId}>
                  <span className={`collab-kind collab-kind-${n.kind}`}>{n.kind}</span>{" "}
                  <button className="link-btn" onClick={() => onFocusNode(n.nodeId)} title="Show the node">
                    {n.label}
                  </button>
                  {n.fields && n.fields.length > 0 && <small> · {n.fields.slice(0, 6).join(", ")}{n.fields.length > 6 ? "…" : ""}</small>}
                  {canRestore && (
                    <button
                      className="btn mini"
                      onClick={() => onRestoreNode(n.nodeId, n.before)}
                      title={n.kind === "added" ? "Remove this node again" : n.kind === "removed" ? "Put this node back" : "Put this node back the way it was before this change"}
                    >
                      <RotateCcw size={11} /> {n.kind === "added" ? "Undo add" : "Restore"}
                    </button>
                  )}
                </div>
              ))}
              {(e.edges.added > 0 || e.edges.removed > 0) && (
                <div className="collab-change-row">
                  <small>
                    connections: {e.edges.added ? `+${e.edges.added}` : ""} {e.edges.removed ? `−${e.edges.removed}` : ""}
                  </small>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
