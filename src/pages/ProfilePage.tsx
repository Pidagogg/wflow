import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bookmark, Check, Globe, Heart, Loader2, MapPin, Pencil, Save, Trash2, UserRound, Users } from "lucide-react";
import { api } from "../api";
import type { PublicProfile, UserProfile } from "../types";
import { Toast, useToast } from "../components/Toast";

interface Props {
  /** when omitted, the page shows the logged-in user's own profile + editor */
  userId?: string;
  onOpenPost: (id: string) => void;
  /** open a workflow fork in the editor */
  onOpen: (workflowId: string) => void;
  onBack: () => void;
}

const AVATARS = ["🦊", "🐼", "🐙", "🦉", "🐝", "🚀", "⚡", "🧠", "🛠️", "🎯"];

function joinedLabel(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

export default function ProfilePage({ userId, onOpenPost, onOpen, onBack }: Props) {
  const { show, toast } = useToast();
  const isOwn = !userId;
  const [me, setMe] = useState<UserProfile | null>(null);
  const [other, setOther] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    displayName: "",
    bio: "",
    location: "",
    website: "",
    avatar: "",
    anonymousByDefault: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (isOwn) {
        const own = await api.profile.me();
        setMe(own);
        setForm({
          displayName: own.displayName,
          bio: own.bio,
          location: own.location,
          website: own.website,
          avatar: own.avatar,
          anonymousByDefault: own.anonymousByDefault,
        });
        // also fetch the public side so we can list the user's own public posts
        setOther(await api.profile.get(own.id));
      } else {
        setOther(await api.profile.get(userId!));
      }
    } catch (err) {
      show(`Could not load the profile: ${(err as Error).message}`, "err");
      setOther(null);
    } finally {
      setLoading(false);
    }
  }, [isOwn, userId, show]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.profile.update(form);
      setMe(updated);
      setEditing(false);
      show("Profile saved");
      if (other) setOther({ ...other, ...form });
    } catch (err) {
      show(`Could not save: ${(err as Error).message}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const importPost = async (postId: string) => {
    try {
      const wf = await api.community.import(postId);
      show("Imported — credentials were removed, add your own.");
      onOpen(wf.id);
    } catch (err) {
      show(`Import failed: ${(err as Error).message}`, "err");
    }
  };

  // Take one of your own published templates off the community feed. Only the
  // author sees this button; the server refuses everyone else (403).
  const unpublishPost = async (postId: string, title: string) => {
    if (!window.confirm(`Remove “${title}” from the community? This cannot be undone.`)) return;
    try {
      await api.community.remove(postId);
      show("Template removed from the community.");
      await load();
    } catch (err) {
      show(`Could not remove it: ${(err as Error).message}`, "err");
    }
  };

  if (loading) {
    return (
      <div className="profile-page">
        <div className="run-loading" style={{ padding: 60 }}>
          <span className="spinner" /> LOADING PROFILE…
        </div>
      </div>
    );
  }

  const shown = isOwn ? me : other;
  if (!shown) {
    return (
      <div className="profile-page">
        <button className="btn btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div className="wf-empty">
          <span className="plus">
            <UserRound size={22} />
          </span>
          <div className="wf-empty-title">Profile not found</div>
          <div className="wf-empty-sub">This account no longer exists.</div>
        </div>
      </div>
    );
  }

  const displayName = isOwn ? (editing ? form.displayName : shown.displayName) : shown.displayName;
  const avatar = isOwn ? (editing ? form.avatar : shown.avatar) : shown.avatar;
  const posts = other?.publicWorkflows || [];

  return (
    <div className="profile-page">
      <button className="btn btn-sm" onClick={onBack} style={{ marginBottom: 16 }}>
        <ArrowLeft size={13} /> Back
      </button>

      <div className="profile-head">
        <span className="profile-avatar" aria-hidden>
          {avatar || displayName.slice(0, 1).toUpperCase()}
        </span>
        <div className="profile-head-info">
          <div className="profile-name">
            {displayName || "Unnamed"}
            {isOwn && <span className="tag" style={{ marginLeft: 8 }}>You</span>}
          </div>
          <div className="profile-stats">
            <span>{other?.postCount ?? 0} public workflows</span>
            <span>
              <Heart size={11} /> {other?.likeCount ?? 0} likes received
            </span>
            {other?.joinedAt && <span>joined {joinedLabel(other.joinedAt)}</span>}
          </div>
        </div>
        {isOwn && !editing && (
          <button className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>
            <Pencil size={13} /> Edit profile
          </button>
        )}
        {isOwn && editing && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="profile-edit">
          <div className="field-label">Display name</div>
          <input
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            maxLength={60}
            placeholder="How your name appears on your posts"
          />

          <div className="field-label">Avatar</div>
          <div className="profile-avatars">
            {AVATARS.map((a) => (
              <button
                key={a}
                className={`profile-avatar-pick ${form.avatar === a ? "on" : ""}`}
                onClick={() => setForm({ ...form, avatar: form.avatar === a ? "" : a })}
                title="Use this avatar"
              >
                {a}
              </button>
            ))}
            <input
              value={form.avatar}
              onChange={(e) => setForm({ ...form, avatar: e.target.value })}
              placeholder="…or any emoji / image URL"
              style={{ maxWidth: 220 }}
            />
          </div>

          <div className="field-label">Bio</div>
          <textarea
            value={form.bio}
            onChange={(e) => setForm({ ...form, bio: e.target.value })}
            rows={4}
            maxLength={600}
            placeholder="What do you build? Which tools do you automate?"
          />

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="field-label">Location</div>
              <input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                maxLength={80}
                placeholder="City / country"
              />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="field-label">Website</div>
              <input
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
                maxLength={200}
                placeholder="https://example.com"
              />
            </div>
          </div>

          <label className="toggle" style={{ marginTop: 14 }}>
            <input
              type="checkbox"
              checked={form.anonymousByDefault}
              onChange={(e) => setForm({ ...form, anonymousByDefault: e.target.checked })}
            />
            <span className="toggle-track" />
            <span className="toggle-label">Publish to the community anonymously by default</span>
          </label>

          <div className="profile-email">Signed in as {me?.email}</div>
        </div>
      ) : (
        <div className="profile-about">
          {shown.bio ? <p className="profile-bio">{shown.bio}</p> : <p className="profile-bio dim">No bio yet.</p>}
          <div className="profile-links">
            {shown.location && (
              <span>
                <MapPin size={12} /> {shown.location}
              </span>
            )}
            {shown.website && (
              <a href={shown.website} target="_blank" rel="noopener noreferrer">
                <Globe size={12} /> {shown.website.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
        </div>
      )}

      <section className="profile-posts">
        <div className="profile-posts-head">
          <Users size={14} /> Public templates <span className="dash-count">{posts.length}</span>
        </div>
        {posts.length === 0 ? (
          <div className="wf-empty">
            <span className="plus">
              <Bookmark size={20} />
            </span>
            <div className="wf-empty-title">No templates yet</div>
            <div className="wf-empty-sub">
              {isOwn ? "Publish a workflow as a template to show it here." : "This user has not published a template yet."}
            </div>
          </div>
        ) : (
          <div className="wf-grid">
            {posts.map((p) => (
              <div key={p.id} className="wf-card community-card">
                <div className="wf-card-head">
                  <button
                    className="wf-card-name community-open-name"
                    onClick={() => onOpenPost(p.id)}
                    title="Open the workflow page"
                  >
                    {p.title}
                  </button>
                </div>
                <div className="wf-card-desc">{p.description || "No description"}</div>
                <div className="wf-card-meta">
                  <span className="tag">{p.nodeCount} Nodes</span>
                  <span className="tag">
                    <Heart size={10} /> {p.likeCount}
                  </span>
                  <span className="tag">{p.importCount} Imports</span>
                </div>
                <div className="wf-card-actions">
                  <button className="btn btn-sm" onClick={() => onOpenPost(p.id)}>
                    <Check size={11} /> Details
                  </button>
                  {isOwn ? (
                    <button
                      className="btn btn-sm btn-ghost btn-danger"
                      onClick={() => unpublishPost(p.id, p.title)}
                      title="Remove your template from the community"
                    >
                      <Trash2 size={11} /> Delete
                    </button>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={() => importPost(p.id)}>
                      Import
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Toast toast={toast} />
    </div>
  );
}
