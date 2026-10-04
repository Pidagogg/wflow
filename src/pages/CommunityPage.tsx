import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  Download,
  Heart,
  MessageSquare,
  RefreshCw,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import { api } from "../api";
import type { CommunityPost, CommunitySort } from "../types";
import { Toast, useToast } from "../components/Toast";
import Select from "../components/Select";

interface Props {
  /** opens a workflow (the freshly imported fork) in the editor */
  onOpen: (id: string) => void;
  /** opens a community post's detail page */
  onOpenPost: (id: string) => void;
  /** opens a publisher's public profile */
  onOpenProfile: (userId: string) => void;
}

// 50 posts is the feed page size — the server caps it at 100.
const PAGE_SIZE = 50;

const SORTS: { value: CommunitySort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "popular", label: "Most popular" },
  { value: "likes", label: "Most liked" },
  { value: "comments", label: "Most discussed" },
  { value: "saves", label: "Most saved" },
  { value: "imports", label: "Most imported" },
  { value: "oldest", label: "Oldest" },
];

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

export default function CommunityPage({ onOpen, onOpenPost, onOpenProfile }: Props) {
  const { show, toast } = useToast();
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CommunitySort>("newest");
  const [mineOnly, setMineOnly] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every request gets a number; only the newest one may write the list, so a
  // slow older response can never overwrite fresher search / filter results.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (opts: { q?: string; sort?: CommunitySort; mine?: boolean; saved?: boolean; offset?: number } = {}) => {
      const q = opts.q ?? query;
      const s = opts.sort ?? sort;
      const mine = opts.mine ?? mineOnly;
      const saved = opts.saved ?? savedOnly;
      const offset = opts.offset ?? 0;
      const seq = ++requestSeq.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      try {
        const res = await api.community.list({ q, sort: s, mine, saved, limit: PAGE_SIZE, offset });
        if (seq !== requestSeq.current) return;
        setPosts((prev) => (offset === 0 ? res.posts : [...prev, ...res.posts]));
        setTotal(res.total);
      } catch {
        if (seq === requestSeq.current) show("Failed to load user templates", "err");
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query, sort, mineOnly, savedOnly, show]
  );

  // One effect: load immediately on mount and when the ranking changes,
  // debounce typing in the search box; filters apply right away.
  const firstLoad = useRef(true);
  const lastQuery = useRef(query);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const typed = !firstLoad.current && lastQuery.current !== query;
    firstLoad.current = false;
    lastQuery.current = query;
    if (typed) searchTimer.current = setTimeout(() => load(), 350);
    else load();
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, sort, mineOnly, savedOnly]);

  const patch = (id: string, changes: Partial<CommunityPost>) =>
    setPosts((ps) => ps.map((p) => (p.id === id ? { ...p, ...changes } : p)));

  const toggleLike = async (post: CommunityPost) => {
    setBusyId(post.id);
    try {
      const res = await api.community.like(post.id);
      patch(post.id, { liked: res.liked, likeCount: res.likeCount });
    } catch (err) {
      show(`Could not update the like: ${(err as Error).message}`, "err");
    } finally {
      setBusyId(null);
    }
  };

  const toggleSave = async (post: CommunityPost) => {
    setBusyId(post.id);
    try {
      const res = await api.community.save(post.id);
      patch(post.id, { saved: res.saved, saveCount: res.saveCount });
      show(res.saved ? "Saved to your bookmarks" : "Removed from your bookmarks");
    } catch (err) {
      show(`Could not update the bookmark: ${(err as Error).message}`, "err");
    } finally {
      setBusyId(null);
    }
  };

  const importPost = async (post: CommunityPost) => {
    setImportingId(post.id);
    try {
      const wf = await api.community.import(post.id);
      show(`Imported "${post.title}" — credentials were removed, add your own.`);
      onOpen(wf.id);
    } catch (err) {
      show(`Import failed: ${(err as Error).message}`, "err");
    } finally {
      setImportingId(null);
    }
  };

  const removePost = async (post: CommunityPost) => {
    if (!window.confirm(`Remove "${post.title}" from the community?`)) return;
    setRemovingId(post.id);
    try {
      await api.community.remove(post.id);
      setPosts((ps) => ps.filter((p) => p.id !== post.id));
      setTotal((t) => Math.max(0, t - 1));
      show("Post removed");
    } catch (err) {
      show(`Failed to remove post: ${(err as Error).message}`, "err");
    } finally {
      setRemovingId(null);
    }
  };

  const filtering = !!query || mineOnly || savedOnly;

  return (
    <div className="community">
      <div className="dash-head">
        <div className="dash-title">
          USER<span style={{ color: "var(--cyan-dim)" }}>//</span>TEMPLATES
          <small>Templates published by other accounts</small>
          {!loading && (
            <span className="dash-count" aria-label={`${posts.length} of ${total} user templates`}>
              {filtering ? `${posts.length} of ${total}` : total} {total === 1 ? "post" : "posts"}
            </span>
          )}
        </div>
        <div className="dash-actions">
          <button className="btn" onClick={() => load()} title="Refresh">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="community-toolbar">
        <div className="community-search">
          <Search size={13} style={{ position: "absolute", left: 10, top: 9, color: "var(--ink-faint)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="SEARCH BY TITLE, DESCRIPTION OR AUTHOR…"
            style={{ paddingLeft: 30 }}
          />
        </div>

        {/* Ranking + the two quick filters. Everything rarely used lives in the
            sort menu instead of adding more buttons to the toolbar. */}
        <div className="community-sort" title="How the feed is ranked">
          <Select value={sort} onChange={(e) => setSort(e.target.value as CommunitySort)} aria-label="Sort the feed">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>

        <label className="toggle" style={{ whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={savedOnly} onChange={(e) => setSavedOnly(e.target.checked)} />
          <span className="toggle-track" />
          <span className="toggle-label">Saved</span>
        </label>

        <label className="toggle" style={{ whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          <span className="toggle-track" />
          <span className="toggle-label">Only my templates</span>
        </label>
      </div>

      {loading ? (
        <div className="run-loading" style={{ padding: 40 }}>
          <span className="spinner" /> LOADING COMMUNITY…
        </div>
      ) : posts.length === 0 ? (
        <div className="wf-empty">
          <span className="plus">
            <Users size={22} />
          </span>
          <div className="wf-empty-title">{filtering ? "No matching posts" : "Nothing shared yet"}</div>
          <div className="wf-empty-sub">
            {filtering
              ? "Try a different search, or clear the filters."
              : "Open a workflow and use the Share button in the editor toolbar to publish the first one."}
          </div>
        </div>
      ) : (
        <>
          <div className="wf-grid">
            {posts.map((post) => (
              <div key={post.id} className="wf-card community-card">
                <div className="wf-card-head">
                  <button
                    className="wf-card-icon community-open"
                    style={{ background: "color-mix(in srgb, var(--violet) 22%, transparent)" }}
                    onClick={() => onOpenPost(post.id)}
                    title="Open this workflow's page"
                  >
                    <Users size={16} style={{ color: "var(--violet)" }} />
                  </button>
                  <button className="wf-card-name community-open-name" onClick={() => onOpenPost(post.id)}>
                    {post.title}
                  </button>
                  {post.mine && (
                    <span
                      className="tag"
                      style={{ color: "var(--cyan)", borderColor: "color-mix(in srgb, var(--cyan) 40%, transparent)" }}
                    >
                      MINE
                    </span>
                  )}
                </div>

                <div className="wf-card-desc">{post.description || "No description"}</div>

                <div className="wf-card-meta">
                  {post.visibility === "private" && (
                    <span className="tag" style={{ color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 40%, transparent)" }}>
                      🔒 PRIVATE
                    </span>
                  )}
                  {post.visibility === "restricted" && (
                    <span className="tag" style={{ color: "var(--violet)", borderColor: "color-mix(in srgb, var(--violet) 40%, transparent)" }}>
                      RESTRICTED
                    </span>
                  )}
                  <span className="tag">{post.nodeCount} Nodes</span>
                  <span className="tag">{post.edgeCount} Links</span>
                  {post.anonymous || !post.ownerId ? (
                    <span className="tag dim">by Anonymous</span>
                  ) : (
                    <button
                      className="tag community-author"
                      style={{ color: "var(--violet)", borderColor: "color-mix(in srgb, var(--violet) 40%, transparent)" }}
                      onClick={() => onOpenProfile(post.ownerId)}
                      title={`Open ${post.ownerName}'s profile`}
                    >
                      by {post.ownerName}
                    </button>
                  )}
                  {post.createdAt && <span className="tag dim">{timeAgo(post.createdAt)}</span>}
                </div>

                <div className="wf-card-actions community-actions">
                  <button
                    className={`btn btn-sm community-engage ${post.liked ? "on" : ""}`}
                    onClick={() => toggleLike(post)}
                    disabled={busyId === post.id}
                    title={post.liked ? "Unlike" : "Like this workflow"}
                  >
                    <Heart size={11} fill={post.liked ? "currentColor" : "none"} /> {post.likeCount}
                  </button>
                  <button
                    className="btn btn-sm community-engage"
                    onClick={() => onOpenPost(post.id)}
                    title="Open the discussion"
                  >
                    <MessageSquare size={11} /> {post.commentCount}
                  </button>
                  <button
                    className={`btn btn-sm community-engage ${post.saved ? "on" : ""}`}
                    onClick={() => toggleSave(post)}
                    disabled={busyId === post.id}
                    title={post.saved ? "Remove bookmark" : "Save for later"}
                  >
                    <Bookmark size={11} fill={post.saved ? "currentColor" : "none"} /> {post.saveCount}
                  </button>
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-sm btn-primary" onClick={() => importPost(post)} disabled={importingId === post.id}>
                    <Download size={11} /> {importingId === post.id ? "Importing…" : "Import"}
                  </button>
                  {post.mine && (
                    <button
                      className="btn btn-sm btn-ghost btn-danger"
                      onClick={() => removePost(post)}
                      disabled={removingId === post.id}
                      title="Remove my post"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {posts.length < total && (
            <div className="community-more">
              <button className="btn" onClick={() => load({ offset: posts.length })} disabled={loadingMore}>
                {loadingMore ? <span className="spinner" /> : <ChevronDown size={14} />}
                {loadingMore ? "Loading…" : `Load ${Math.min(PAGE_SIZE, total - posts.length)} more`}
              </button>
              <span className="community-more-note">
                Showing {posts.length} of {total}
              </span>
            </div>
          )}
        </>
      )}

      <Toast toast={toast} />
    </div>
  );
}
