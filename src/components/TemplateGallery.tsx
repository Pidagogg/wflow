import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutTemplate, Loader2, Plus, Sparkles, X } from "lucide-react";
import { api } from "../api";
import type { TemplateSummary, Workflow } from "../types";

interface Props {
  /** folder the new workflow is created in (empty = the account's main folder) */
  folderId?: string;
  onCreated: (workflow: Workflow) => void;
  onClose: () => void;
  onMessage: (text: string, kind?: "ok" | "err") => void;
}

const LEVEL_LABEL: Record<string, string> = {
  starter: "starter",
  intermediate: "intermediate",
  advanced: "advanced",
};

/**
 * Starter templates — curated, ready-to-run skeletons (see shared/templates.js).
 * Creating one is a normal POST /api/workflows with the template's nodes and
 * edges, so the account gets its own editable copy and no credentials travel
 * with it (the required keys are listed on the card instead).
 */
export default function TemplateGallery({ folderId, onCreated, onClose, onMessage }: Props) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.templates.list();
      setTemplates(res.templates || []);
      setCategories(res.categories || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () => (category ? templates.filter((t) => t.category === category) : templates),
    [templates, category]
  );

  const use = async (summary: TemplateSummary) => {
    setCreating(summary.id);
    try {
      const template = await api.templates.get(summary.id);
      const wf = await api.workflows.create({
        name: template.name,
        description: template.description,
        folderId: folderId || undefined,
        nodes: template.nodes,
        edges: template.edges,
      });
      onMessage(`Created “${wf.name}” from a template — fill in the credentials it marks.`, "ok");
      onCreated(wf);
      onClose();
    } catch (err) {
      onMessage(`Could not create the workflow: ${(err as Error).message}`, "err");
      setCreating(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal tmpl-gallery" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="tmpl-title">
            <LayoutTemplate size={15} /> START FROM A TEMPLATE
          </span>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>

        <div className="tmpl-body">
          <p className="tmpl-intro">
            A template is a normal workflow you can edit: it already has the trigger, the nodes and the connections in place, and the
            credentials it needs are marked on the card. Everything else is yours to change.
          </p>

          <div className="tmpl-filters">
            <button className={`tmpl-chip ${category === "" ? "active" : ""}`} onClick={() => setCategory("")}>
              All
            </button>
            {categories.map((c) => (
              <button key={c} className={`tmpl-chip ${category === c ? "active" : ""}`} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>

          {loading && (
            <div className="tmpl-empty">
              <Loader2 size={14} className="spin" /> Loading templates…
            </div>
          )}
          {error && <div className="field-json-error">⚠ {error}</div>}

          <div className="tmpl-grid">
            {visible.map((t) => (
              <div key={t.id} className="tmpl-card">
                <div className="tmpl-card-head">
                  <span className="tmpl-card-name">{t.name}</span>
                  <span className={`tmpl-level ${t.level}`}>{LEVEL_LABEL[t.level] || t.level}</span>
                </div>
                <div className="tmpl-card-desc">{t.description}</div>
                <div className="tmpl-card-meta">
                  <span>{t.category}</span>
                  <span>·</span>
                  <span>{t.nodeCount} nodes</span>
                  <span>·</span>
                  <span>{t.edgeCount} connections</span>
                </div>
                {t.requires.length > 0 && (
                  <div className="tmpl-card-needs">
                    <Sparkles size={11} /> Needs: {t.requires.join(" · ")}
                  </div>
                )}
                <button className="btn btn-sm btn-primary tmpl-use" onClick={() => use(t)} disabled={creating !== null}>
                  {creating === t.id ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} Use template
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <span className="tmpl-hint">Templates run on your instance — no code and no data leave it.</span>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
