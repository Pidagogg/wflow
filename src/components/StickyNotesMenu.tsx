import { useEffect, useRef } from "react";
import { Maximize2, Plus, StickyNote, Trash2, X } from "lucide-react";

export interface StickyNoteEntry {
  id: string;
  text: string;
  color: string;
  /** note size on the canvas, in flow coordinates (px) */
  width: number;
  height: number;
}

interface Props {
  notes: StickyNoteEntry[];
  /** id of the note that is currently selected on the canvas */
  activeId?: string | null;
  onAdd: () => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, text: string) => void;
  onColor: (id: string, color: string) => void;
  onSize: (id: string, size: { width: number; height: number }) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

// A small palette of paper colours for canvas notes.
export const STICKY_COLORS = ["#3a3320", "#1f3346", "#332038", "#1f3a2c", "#3a2a20"];

// Notes are resizable. The size lives on the note's own config, so it is saved,
// exported and restored with the workflow like every other setting — the grip
// on the canvas and these presets are just two ways to set the same two numbers.
export const STICKY_DEFAULT_WIDTH = 250;
export const STICKY_DEFAULT_HEIGHT = 140;
export const STICKY_MIN_WIDTH = 140;
export const STICKY_MIN_HEIGHT = 90;
export const STICKY_MAX_SIZE = 1600;

export const STICKY_SIZES: Array<{ label: string; width: number; height: number; hint: string }> = [
  { label: "S", width: 190, height: 110, hint: "Small — a section label" },
  { label: "M", width: 250, height: 140, hint: "Medium — a short note" },
  { label: "L", width: 340, height: 220, hint: "Large — instructions" },
  { label: "XL", width: 470, height: 330, hint: "Extra large — a full column heading" },
];

/** Clamp one dimension into the range a note may have. */
export function clampStickySize(value: number, min: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(STICKY_MAX_SIZE, n));
}

/**
 * The sticky-notes side menu. Sticky notes are non-executing canvas nodes that
 * sit BEHIND the workflow, so a big workflow can be organised with headings,
 * section labels and instructions. This menu lists every note, lets you jump to
 * one, edit its text / colour / size inline, add a new one, and remove notes.
 */
export default function StickyNotesMenu({ notes, activeId, onAdd, onSelect, onUpdate, onColor, onSize, onDelete, onClose }: Props) {
  const activeRef = useRef<HTMLTextAreaElement>(null);

  // Focus the active note's editor when it is selected from this menu.
  useEffect(() => {
    if (activeId) activeRef.current?.focus();
  }, [activeId]);

  return (
    <div className="sticky-menu" role="dialog" aria-label="Sticky notes">
      <div className="sticky-menu-head">
        <StickyNote size={13} />
        <span>Sticky notes</span>
        <button className="sticky-menu-close" onClick={onClose} title="Close sticky notes menu">
          <X size={13} />
        </button>
      </div>

      <div className="sticky-menu-body">
        {notes.length === 0 && (
          <div className="sticky-menu-empty">
            No notes yet. Add one and write a heading or instructions — it stays behind the nodes.
          </div>
        )}

        {notes.map((note) => {
          const active = note.id === activeId;
          return (
            <div key={note.id} className={`sticky-item ${active ? "active" : ""}`}>
              <div className="sticky-item-head">
                <button className="sticky-item-jump" onClick={() => onSelect(note.id)} title="Show this note on the canvas">
                  {active ? "● " : ""}
                  {note.text.trim() ? note.text.trim().split("\n")[0].slice(0, 34) : "Empty note"}
                </button>
                <button className="sticky-item-del" onClick={() => onDelete(note.id)} title="Delete this note">
                  <Trash2 size={12} />
                </button>
              </div>
              {active && (
                <>
                  <textarea
                    ref={activeRef}
                    className="sticky-item-text"
                    value={note.text}
                    onChange={(e) => onUpdate(note.id, e.target.value)}
                    placeholder="Write a heading, section label or instructions…"
                    spellCheck={false}
                  />
                  <div className="sticky-item-colors">
                    {STICKY_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`sticky-swatch ${note.color === color ? "active" : ""}`}
                        style={{ background: color }}
                        onClick={() => onColor(note.id, color)}
                        title="Note colour"
                        aria-label={`Note colour ${color}`}
                      />
                    ))}
                  </div>
                  <div className="sticky-item-sizes">
                    <span className="sticky-size-label">
                      <Maximize2 size={10} /> SIZE
                    </span>
                    {STICKY_SIZES.map((size) => {
                      const current = note.width === size.width && note.height === size.height;
                      return (
                        <button
                          key={size.label}
                          className={`sticky-size ${current ? "active" : ""}`}
                          onClick={() => onSize(note.id, size)}
                          title={`${size.hint} — ${size.width} × ${size.height} px`}
                          aria-pressed={current}
                        >
                          {size.label}
                        </button>
                      );
                    })}
                    <span className="sticky-size-current">{note.width} × {note.height}</span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <button className="sticky-add" onClick={onAdd}>
        <Plus size={13} /> ADD STICKY NOTE
      </button>
    </div>
  );
}
