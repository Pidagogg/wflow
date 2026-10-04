// ============================================================================
// Select — the app's own dropdown, used instead of the native <select>.
//
// The browser draws a native select's option list itself and ignores the dark
// theme (white text on a white list on some systems), so every dropdown uses
// this instead. It is a drop-in: same `value`, `onChange(e => e.target.value)`,
// `disabled`, `className`, and <option> children.
//
// The list opens in a portal on <body>, so a modal's overflow cannot clip it,
// and flips above the button when there is no room below. Keyboard: arrows /
// Home / End move, Enter or Space picks, Escape closes, typing jumps to the
// first option that starts with the typed letters.
// ============================================================================
import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

interface Opt {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

interface Props {
  value?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  placeholder?: string;
  "aria-label"?: string;
  children?: ReactNode;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

// <option> elements from the children, through fragments and arrays.
function collect(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: unknown; children?: ReactNode; disabled?: boolean }>(child)) return;
    if (child.type === Fragment) {
      collect(child.props.children, out);
      return;
    }
    if (child.type === "option") {
      const label = child.props.children;
      const text = textOf(label);
      out.push({ value: child.props.value === undefined ? text : String(child.props.value), label, text, disabled: !!child.props.disabled });
    }
  });
  return out;
}

export default function Select({ value, onChange, disabled, className, style, title, placeholder, children, ...rest }: Props) {
  const options = useMemo(() => collect(children), [children]);
  const current = value === undefined || value === null ? "" : String(value);
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();

  const place = useCallback(() => {
    const b = buttonRef.current?.getBoundingClientRect();
    if (!b) return;
    const below = window.innerHeight - b.bottom - 8;
    const above = b.top - 8;
    const want = Math.min(300, options.length * 32 + 8);
    const up = below < Math.min(want, 180) && above > below;
    setPos({
      left: b.left,
      width: b.width,
      ...(up ? { bottom: window.innerHeight - b.top + 4 } : { top: b.bottom + 4 }),
      maxHeight: Math.max(120, Math.min(300, up ? above : below)),
    });
  }, [options.length]);

  const openList = () => {
    if (disabled) return;
    place();
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };

  const pick = (o: Opt | undefined) => {
    if (!o || o.disabled) return;
    setOpen(false);
    buttonRef.current?.focus();
    if (o.value !== current) onChange?.({ target: { value: o.value } });
  };

  // close on outside click, and follow the button on scroll / resize
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onMove = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  // keep the highlighted option in view
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const move = (from: number, dir: 1 | -1) => {
    for (let i = 1; i <= options.length; i++) {
      const n = (from + dir * i + options.length) % options.length;
      if (!options[n].disabled) return n;
    }
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => move(a, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => move(a, -1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(move(-1, 1));
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(move(options.length, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const hit = options.findIndex((o) => !o.disabled && o.text.trim().toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ui-select ${open ? "open" : ""} ${className || ""}`}
        style={style}
        title={title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={rest["aria-label"]}
      >
        <span className={`ui-select-value ${selected ? "" : "placeholder"}`}>{selected ? selected.label : placeholder || "—"}</span>
        <ChevronDown size={14} className="ui-select-chevron" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            className="ui-select-list"
            role="listbox"
            style={{ left: pos.left, width: Math.max(pos.width, 160), top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
          >
            {options.map((o, i) => (
              <div
                key={`${o.value}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === current}
                aria-disabled={o.disabled || undefined}
                className={`ui-select-option ${i === active ? "active" : ""} ${o.value === current ? "selected" : ""} ${o.disabled ? "disabled" : ""}`}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
              >
                <span>{o.label}</span>
                {o.value === current && <Check size={13} />}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
