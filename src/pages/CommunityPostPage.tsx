import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Bookmark,
  Download,
  Heart,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { api } from "../api";
import type { CommunityPostDetail } from "../types";
import { Toast, useToast } from "../components/Toast";

interface Props {
  postId: string;
  /** import the post and open the fresh fork in the editor */
  onOpen: (workflowId: string) => void;
  /** open the publisher's profile */
  onOpenProfile: (userId: string) => void;
  onBack: () => void;
}

function timeAgo(iso?: string) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function CommunityPostPage({ postId, onOpen, onOpenProfile, onBack }: Props) {
  const { show, toast } = useToast();
  const [post, setPost] = useState<CommunityPostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // A 404 means removed / private; anything else (network, 500) is a real
  // error and must not be dressed up as "this template is not available".
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    api.community
      .get(postId)
      .then(setPost)
      .catch((err) => {
        const msg = (err as Error).message || "";
        if (!/not found/i.test(msg)) setLoadError(msg || "Unknown error");
      })
      .finally(() => setLoading(false));
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleLike = async () => {
    if (!post) return;
    setBusy(true);
    try {
      const res = await api.community.like(post.id);
      setPost({ ...post, liked: res.liked, likeCount: res.likeCount });
    } catch (err) {
      show(`Could not update the like: ${(err as Error).message}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const toggleSave = async () => {
    if (!post) return;
    setBusy(true);
    try {
      const res = await api.community.save(post.id);
      setPost({ ...post, saved: res.saved, saveCount: res.saveCount });
      show(res.saved ? "Saved to your bookmarks" : "Removed from your bookmarks");
    } catch (err) {
      show(`Could not update the bookmark: ${(err as Error).message}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const importPost = async () => {
    if (!post) return;
    setImporting(true);
    try {
      const wf = await api.community.import(post.id);
      show("Imported — credentials were removed, add your own.");
      onOpen(wf.id);
    } catch (err) {
      show(`Import failed: ${(err as Error).message}`, "err");
    } finally {
      setImporting(false);
    }
  };

  const addComment = async () => {
    if (!post || !text.trim()) return;
    setSending(true);
    try {
      const comment = await api.community.comment(post.id, text.trim());
      setPost({
        ...post,
        comments: [...post.comments, comment],
        commentCount: comment.commentCount,
      });
      setText("");
    } catch (err) {
      show(`Could not post the comment: ${(err as Error).message}`, "err");
    } finally {
      setSending(false);
    }
  };

  const removeComment = async (commentId: string) => {
    if (!post) return;
    try {
      const res = await api.community.removeComment(post.id, commentId);
      setPost({ ...post, comments: post.comments.filter((c) => c.id !== commentId), commentCount: res.commentCount });
    } catch (err) {
      show(`Could not remove the comment: ${(err as Error).message}`, "err");
    }
  };

  if (loading) {
    return (
      <div className="community-post">
        <div className="run-loading" style={{ padding: 60 }}>
          <span className="spinner" /> LOADING POST…
        </div>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="community-post">
        <button className="btn btn-sm" onClick={onBack}>
          <ArrowLeft size={13} /> Back to User Templates
        </button>
        <div className="wf-empty" style={{ marginTop: 20 }}>
          <span className="plus">
            <Users size={22} />
          </span>
          <div className="wf-empty-title">{loadError ? "Could not load this template" : "This template is not available"}</div>
          <div className="wf-empty-sub">{loadError ? loadError : "It was removed, or it is private."}</div>
          {loadError && (
            <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={load}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="community-post">
      <button className="btn btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>
        <ArrowLeft size={13} /> Back to User Templates
      </button>

      <div className="post-head">
        <h1 className="post-title">{post.title}</h1>
        <div className="post-meta">
          {post.visibility === "private" && <span className="tag">🔒 Private</span>}
          {post.visibility === "restricted" && <span className="tag">Restricted</span>}
          <span className="tag">{post.nodeCount} Nodes</span>
          <span className="tag">{post.edgeCount} Links</span>
          {post.importCount > 0 && <span className="tag">{post.importCount} Imports</span>}
          {post.createdAt && <span className="tag dim">published {timeAgo(post.createdAt)}</span>}
        </div>
      </div>

      {/* Publisher — clickable unless the post was published anonymously. */}
      <div className="post-author">
        {post.anonymous || !post.ownerId ? (
          <>
            <span className="post-avatar" aria-hidden>
              <UserRound size={18} />
            </span>
            <div>
              <div className="post-author-name">Anonymous</div>
              <div className="post-author-note">this publisher chose not to reveal their profile</div>
            </div>
          </>
        ) : (
          <button className="post-author-link" onClick={() => onOpenProfile(post.ownerId)} title="Open the publisher's profile">
            <span className="post-avatar" aria-hidden>
              <UserRound size={18} />
            </span>
            <div>
              <div className="post-author-name">{post.ownerName}</div>
              <div className="post-author-note">view profile & public templates</div>
            </div>
          </button>
        )}
      </div>

      <div className="post-description">{post.description || "No description was given for this workflow."}</div>

      <div className="post-actions">
        <button className={`btn ${post.liked ? "btn-primary" : ""}`} onClick={toggleLike} disabled={busy}>
          <Heart size={14} fill={post.liked ? "currentColor" : "none"} /> Like · {post.likeCount}
        </button>
        <button className={`btn ${post.saved ? "btn-primary" : ""}`} onClick={toggleSave} disabled={busy}>
          <Bookmark size={14} fill={post.saved ? "currentColor" : "none"} /> {post.saved ? "Saved" : "Save"} · {post.saveCount}
        </button>
        <button className="btn btn-primary" onClick={importPost} disabled={importing}>
          {importing ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          {importing ? "Importing…" : "Import to my workflows"}
        </button>
      </div>

      <section className="post-comments">
        <div className="post-comments-head">
          <MessageSquare size={14} /> COMMENTS
          <span className="dash-count">{post.comments.length}</span>
        </div>

        <div className="post-comment-form">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Share how you use this workflow, ask a question, or suggest an improvement…"
            rows={3}
            maxLength={2000}
          />
          <button className="btn btn-primary btn-sm" onClick={addComment} disabled={sending || !text.trim()}>
            {sending ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Post comment
          </button>
        </div>

        {post.comments.length === 0 ? (
          <div className="post-comments-empty">No comments yet — be the first.</div>
        ) : (
          <ul className="post-comment-list">
            {post.comments.map((c) => (
              <li key={c.id} className="post-comment">
                <span className="post-comment-avatar" aria-hidden>
                  {c.userName.slice(0, 1).toUpperCase()}
                </span>
                <div className="post-comment-body">
                  <div className="post-comment-head">
                    <b>{c.userName}</b>
                    <span className="dim">{timeAgo(c.createdAt)}</span>
                    {(c.canRemove ?? c.mine) && (
                      <button className="post-comment-del" onClick={() => removeComment(c.id)} title="Delete this comment">
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                  <div className="post-comment-text">{c.text}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Toast toast={toast} />
    </div>
  );
}
