import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, HelpCircle } from "lucide-react";

interface Props {
  /** what the parameter does / how to fill it */
  text: string;
  /** where the value comes from (settings page, part of a URL, …) */
  where?: string;
  /** page that issues the value */
  link?: string;
  /** a small concrete valid value or format */
  example?: string;
  /** parameter name — used for the accessible label */
  label?: string;
}

// gap between the "?" and the bubble, and the minimum distance to the window edge
const GAP = 7;
const EDGE = 8;

/**
 * Inline parameter help: the small "?" shown next to a node parameter.
 *
 * Hover (pointer) or click / keyboard focus (touch and keyboard users) opens a
 * short explanation, where to find the value (with a link to the page that
 * issues it) and a concrete example. Reusable and node-agnostic — the
 * caller only passes text, so every current and future parameter gets the same
 * affordance from one place.
 *
 * The bubble is portalled to <body> with fixed positioning: the field cards it
 * sits in clip their overflow, which cut long help text off mid-sentence. It
 * is clamped to the window and flips above the "?" when there is no room below.
 */
export default function ParamHelp({ text, where, link, example, label }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean; maxHeight?: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const id = useId();

  const inside = (n: Node | null) => !!n && (!!wrapRef.current?.contains(n) || !!popRef.current?.contains(n));

  // The pointer crosses a small gap between the "?" and the bubble, so closing
  // waits a moment and is cancelled when the pointer lands on either.
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Close on Escape or on a click anywhere outside the help icon and bubble.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Place the bubble next to the "?" and keep it on screen; follow the icon
  // while the panel scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const btn = btnRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!btn || !pop) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = pop.offsetWidth;
      const h = pop.scrollHeight;
      const left = Math.max(EDGE, Math.min(btn.left - 6, vw - w - EDGE));
      const below = vh - btn.bottom - GAP - EDGE;
      const aboveRoom = btn.top - GAP - EDGE;
      const above = h > below && aboveRoom > below;
      const room = above ? aboveRoom : below;
      const shown = Math.min(h, room);
      setPos({
        left,
        top: above ? btn.top - GAP - shown : btn.bottom + GAP,
        above,
        maxHeight: h > room ? room : undefined,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <span className="param-help" ref={wrapRef} onMouseEnter={show} onMouseLeave={hideSoon}>
      <button
        ref={btnRef}
        type="button"
        className={`param-help-btn${open ? " open" : ""}`}
        aria-label={label ? `What is ${label}?` : "What is this parameter?"}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        onFocus={show}
        onBlur={(e) => {
          // keep it open while focus moves into the bubble (its link)
          if (!inside(e.relatedTarget as Node)) setOpen(false);
        }}
      >
        <HelpCircle size={11} />
      </button>
      {open &&
        createPortal(
          <span
            ref={popRef}
            className={`param-help-pop${pos?.above ? " above" : ""}`}
            role="tooltip"
            id={id}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
            style={
              pos
                ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
                : { left: 0, top: 0, visibility: "hidden" }
            }
          >
            {text && <span className="param-help-text">{text}</span>}
            {where && (
              <span className={`param-help-where${text ? "" : " first"}`}>
                <span className="param-help-example-label">Where to find it</span>
                <span>{where}</span>
                {link && (
                  <a href={link} target="_blank" rel="noopener noreferrer" className="param-help-link">
                    Open {new URL(link).hostname.replace(/^www\./, "")} <ExternalLink size={10} />
                  </a>
                )}
              </span>
            )}
            {example && (
              <span className="param-help-example">
                <span className="param-help-example-label">Example</span>
                <code>{example}</code>
              </span>
            )}
          </span>,
          document.body
        )}
    </span>
  );
}
