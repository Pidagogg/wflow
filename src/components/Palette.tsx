import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { Catalog } from "../types";
import { NodeIcon } from "./icons";
import { NodeServiceBadge } from "./ServiceBadge";

export const NODE_DRAG_TYPE = "application/wflow-node";

const MIN_W = 180;
const MAX_W = 460;
const DEFAULT_W = 264;

interface Props {
  catalog: Catalog;
  onAdd: (type: string, position?: { x: number; y: number }) => void;
  mobileOpen?: boolean;
  /** hide the whole side menu (toggled by the square button in the toolbar) */
  collapsed?: boolean;
  /** opens the raw workflow-JSON editing window (button at the bottom of the palette) */
  onEditJson?: () => void;
}

export default function Palette({ catalog, onAdd, mobileOpen = false, collapsed = false, onEditJson }: Props) {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("bf-palette-width"));
    return saved >= MIN_W && saved <= MAX_W ? saved : DEFAULT_W;
  });
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), MIN_W), MAX_W);
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("bf-palette-width", String(widthRef.current));
      } catch {
        /* private mode etc. */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const toggle = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.groups
      .map((g) => {
        const types = g.nodes.filter((t) => {
          const def = catalog.nodes[t];
          if (!def) return false;
          if (!q) return true;
          return (
            def.name.toLowerCase().includes(q) ||
            def.description.toLowerCase().includes(q) ||
            t.toLowerCase().includes(q)
          );
        });
        return { ...g, types };
      })
      .filter((g) => g.types.length > 0);
  }, [catalog, query]);

  // While the user is searching, force-open the matching groups so results are visible.
  const searching = query.trim().length > 0;

  // Collapsed by the square side-menu button — the canvas takes the full width.
  if (collapsed) return null;

  return (
    <aside className={`palette ${mobileOpen ? "mobile-open" : ""}`} style={{ width, flexBasis: width }}>
      <div className="palette-resize" title="Drag to resize" onPointerDown={startResize} />

      <div className="palette-search">
        <div style={{ position: "relative" }}>
          <Search size={13} style={{ position: "absolute", left: 8, top: 8, color: "var(--ink-faint)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes…"
            style={{ paddingLeft: 28 }}
          />
        </div>
      </div>

      <div className="palette-groups">
        {groups.length === 0 && <div className="palette-empty">No matching nodes</div>}
        {groups.map((g) => {
          const color = catalog.categories[g.id]?.color || "#7d9cc4";
          const open = searching || openGroups.has(g.id);
          return (
            <div key={g.id} className={`palette-cat ${open ? "open" : ""}`}>
              <button
                className="palette-cat-toggle"
                style={{ ["--g" as string]: color }}
                onClick={() => toggle(g.id)}
                title={open ? `Hide ${g.label}` : `Show ${g.label} nodes`}
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="dot" />
                <span className="cat-name">{g.label}</span>
                <span className="count">{g.types.length}</span>
              </button>

              {open && (
                <div className="palette-cat-body">
                  {g.types.map((t) => {
                    const def = catalog.nodes[t];
                    return (
                      <div
                        key={t}
                        className="palette-node"
                        style={{ ["--g" as string]: color }}
                        onClick={() => onAdd(t)}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(NODE_DRAG_TYPE, t);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                      >
                        <div className="p-icon">
                          <NodeIcon name={def.icon} size={13} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div className="p-name">
                            {def.name}
                            <NodeServiceBadge type={t} name={def.name} description={def.description} size={13} />
                            {def.demo && (
                              <span className="demo-badge" title="Fires a sample when you press Run. It does not start by itself yet.">
                                Demo
                              </span>
                            )}
                          </div>
                          <div className="p-desc">{def.description}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {onEditJson && (
        <button className="palette-json-btn" onClick={onEditJson} title="Edit the raw workflow JSON in a dedicated window">
          <Braces size={13} /> Edit workflow JSON
        </button>
      )}

      {/* The resize hint lives on the handle's own tooltip/cursor now — a
          permanent label in the footer was pure noise. */}
    </aside>
  );
}