// ============================================================================
// ParticleLogo — the W flow logo as glowing particles you can play with (main
// page), in the style of the classic "interactive particle text" effect.
//
// The logo PNG is traced into a few thousand soft, glowing dots that sit on
// its OUTLINES (the edges of the shapes and of the red stripe), drawn with
// additive blending so overlapping glows brighten. The whole logo sways in a
// slow wave at rest.
//
//   hover  — dots near the pointer are pushed away (inverse-square, so close
//            dots fly and far ones barely move) and grow; every fifth dot
//            drifts and turns accent blue. Displaced dots glow blue, and the
//            blue lingers for a moment after they settle.
//   press  — dots are pulled INTO the pointer while their colours cycle
//            between blue and red; release and they ease back home.
//
// Plain canvas 2D (pre-rendered glow sprites, "lighter" compositing) — no
// WebGL library for one hero picture. It animates only while the logo is on
// screen and the tab is visible; with "reduce motion" it is drawn once, still.
// ============================================================================
import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

/**
 * The main page's opening screen: the logo, large, filling the window below
 * the top bar, with a "Scroll" hint that glides to the element `nextId`.
 */
export function LogoStage({ nextId }: { nextId: string }) {
  return (
    <section className="logo-stage" aria-label="W flow">
      <ParticleLogo />
      <button type="button" className="logo-stage-next" onClick={() => document.getElementById(nextId)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
        <span>Scroll</span>
        <ChevronDown size={16} />
      </button>
    </section>
  );
}

interface Props {
  /** image to trace (transparent PNG) */
  src?: string;
  /** CSS width limit in px; the height follows the image's aspect ratio */
  maxWidth?: number;
  /** the logo is never taller than this share of the window height */
  maxHeightRatio?: number;
  /** sway in a slow wave while nobody touches it */
  wave?: boolean;
  className?: string;
}

interface Dot {
  hx: number; // home position (on the logo outline)
  hy: number;
  x: number;
  y: number;
  base: number; // index into BASE colours
  size: number; // current size factor (1 = normal)
  heat: number; // 0..1 — accent-blue glow left by being displaced; fades slowly
  pressHue: number; // 0..1 — share of the press colour cycle while held
}

// ---- tuning ----------------------------------------------------------------
const TRACE_WIDTH = 640; // the logo is traced at this width (more = more dots)
const MAX_DOTS = 9000;
const EASE = 0.05; // how fast dots return home
const PRESS_EASE = 0.012; // …while the pointer is held (they hang in the pull)
const AREA = 250; // push / pull strength, in logo units² (1 unit = 1% of width)
const HEAT_FADE = 0.975; // per frame: the blue trace fades over ~2 s
const WAVE_SPEED = 0.0011; // radians per millisecond
const PAD = 0.07; // room around the logo for waving / pushed dots (share of width)

// glow colours: the logo's own two, the accent blue, and the press cycle
const BASE: Array<[number, number, number]> = [
  [240, 244, 255], // white
  [239, 51, 64], // logo red
];
const ACCENT: [number, number, number] = [91, 124, 246]; // --cyan
const HEAT_STEPS = 5; // base colour → accent blue, in steps
const PRESS_STEPS = 12; // blue → red → blue

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// A soft round glow, like a point sprite: bright core, fading edge.
function glowSprite(rgb: [number, number, number], px: number) {
  const size = Math.max(4, Math.ceil(px * 2));
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const [r, gg, b] = rgb.map((v) => Math.round(v));
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  grad.addColorStop(0.35, `rgba(${r},${gg},${b},0.75)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export default function ParticleLogo({ src = "/logo.png", maxWidth = 1200, maxHeightRatio = 0.82, wave = true, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let dots: Dot[] = [];
    let points: Array<{ u: number; v: number; base: number }> = [];
    let width = 0; // canvas size in CSS px (logo + margin)
    let height = 0;
    let unit = 1; // 1% of the logo width, in px
    let dotPx = 3;
    let aspect = 0.6;
    let frame = 0;
    let running = false;
    let onScreen = true;
    let cancelled = false;
    const pointer = { x: -9999, y: -9999, inside: false, down: false };
    // sprites[base][heatStep] and pressSprites[step]
    let sprites: HTMLCanvasElement[][] = [];
    let pressSprites: HTMLCanvasElement[] = [];

    // --- tracing the outlines --------------------------------------------------
    // An outline pixel is opaque and either borders transparency or borders a
    // clearly different colour (the red stripe inside the W).
    function trace(image: HTMLImageElement) {
      const sw = TRACE_WIDTH;
      const sh = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * sw));
      aspect = sh / sw;
      const off = document.createElement("canvas");
      off.width = sw;
      off.height = sh;
      const octx = off.getContext("2d", { willReadFrequently: true });
      if (!octx) return [];
      octx.drawImage(image, 0, 0, sw, sh);
      const data = octx.getImageData(0, 0, sw, sh).data;
      const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < sw && y < sh && data[(y * sw + x) * 4 + 3] > 100;
      const isRed = (x: number, y: number) => {
        const i = (y * sw + x) * 4;
        return data[i] > 150 && data[i + 1] < 120;
      };
      const out: Array<{ u: number; v: number; base: number }> = [];
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (!opaque(x, y)) continue;
          const red = isRed(x, y);
          let edge = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (!opaque(nx, ny) || isRed(nx, ny) !== red) {
              edge = true;
              break;
            }
          }
          if (!edge) continue;
          out.push({ u: (x + 0.5 + (Math.random() - 0.5) * 0.8) / sw, v: (y + 0.5 + (Math.random() - 0.5) * 0.8) / sh, base: red ? 1 : 0 });
        }
      }
      // even thinning if the outline is longer than the dot budget
      if (out.length > MAX_DOTS) {
        const keep = MAX_DOTS / out.length;
        return out.filter((_, i) => Math.floor(i * keep) !== Math.floor((i - 1) * keep));
      }
      return out;
    }

    // --- layout --------------------------------------------------------------
    function layout() {
      const avail = Math.min(wrap!.clientWidth || maxWidth, maxWidth);
      const byHeight = (window.innerHeight * maxHeightRatio) / (aspect + 2 * PAD);
      const w = Math.round(Math.min(avail / (1 + 2 * PAD), byHeight));
      const h = Math.round(w * aspect);
      const pad = Math.round(w * PAD);
      const cw = w + 2 * pad;
      const ch = h + 2 * pad;
      if (cw === width && ch === height && dots.length) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(cw * dpr);
      canvas!.height = Math.round(ch * dpr);
      canvas!.style.width = `${cw}px`;
      canvas!.style.height = `${ch}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      unit = w / 100;
      dotPx = Math.max(2.4, w / 330);
      const spritePx = dotPx * 2.4 * dpr;
      sprites = BASE.map((b) => Array.from({ length: HEAT_STEPS + 1 }, (_, s) => glowSprite(mix(b, ACCENT, s / HEAT_STEPS), spritePx)));
      pressSprites = Array.from({ length: PRESS_STEPS }, (_, s) => {
        const t = (1 - Math.cos((s / PRESS_STEPS) * Math.PI * 2)) / 2; // 0 → 1 → 0
        return glowSprite(mix(ACCENT, BASE[1], t), spritePx);
      });

      const first = dots.length === 0;
      dots = points.map((p, i) => {
        const hx = pad + p.u * w;
        const hy = pad + p.v * h;
        const prev = dots[i];
        const start =
          first && !reduceMotion
            ? { x: Math.random() * cw, y: Math.random() * ch }
            : { x: prev ? prev.x * (cw / (width || cw)) : hx, y: prev ? prev.y * (ch / (height || ch)) : hy };
        return { hx, hy, x: start.x, y: start.y, base: p.base, size: 1, heat: 0, pressHue: 0 };
      });
      width = cw;
      height = ch;
      draw(0);
    }

    // --- drawing -------------------------------------------------------------
    function draw(now: number) {
      ctx!.globalCompositeOperation = "source-over";
      ctx!.clearRect(0, 0, width, height);
      ctx!.globalCompositeOperation = "lighter"; // overlapping glows add up
      const cycle = ((now * 0.0006) % 1) * PRESS_STEPS;
      for (const d of dots) {
        const sprite =
          d.pressHue > 0.5
            ? pressSprites[Math.floor(cycle + d.hx * 0.01) % PRESS_STEPS]
            : sprites[d.base][Math.min(HEAT_STEPS, Math.round(d.heat * HEAT_STEPS))];
        const s = dotPx * 2.4 * d.size;
        ctx!.drawImage(sprite, d.x - s / 2, d.y - s / 2, s, s);
      }
      ctx!.globalCompositeOperation = "source-over";
    }

    // --- physics -------------------------------------------------------------
    function step(now: number) {
      const t = now * WAVE_SPEED;
      const amp = wave && !reduceMotion ? 1.2 * unit : 0;
      const k = (Math.PI * 2) / Math.max(1, width * 0.7);
      const active = pointer.inside || pointer.down;
      const areaPx = AREA * unit * unit;
      const reach = (pointer.down ? 60 : 32) * unit; // beyond this the push is negligible
      const ease = pointer.down ? PRESS_EASE : EASE;
      let moving = false;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const tx = amp ? d.hx + Math.cos(t * 0.8 + d.hy * k) * amp * 0.35 : d.hx;
        const ty = amp ? d.hy + Math.sin(t + d.hx * k) * amp : d.hy;
        let targetSize = 1;
        if (active) {
          const dx = pointer.x - d.x;
          const dy = pointer.y - d.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < reach * reach && d2 > 0.25) {
            const dist = Math.sqrt(d2);
            const f = Math.min(areaPx / Math.max(d2, unit * unit * 4), 3 * unit); // capped so no dot teleports
            if (pointer.down) {
              // pulled into the pointer, colours cycling
              d.x += (dx / dist) * f;
              d.y += (dy / dist) * f;
              d.pressHue = 1;
            } else if (i % 5 === 0) {
              // every fifth dot only drifts a little, blue and smaller
              d.x -= (dx / dist) * 0.03 * unit;
              d.y -= (dy / dist) * 0.03 * unit;
              d.heat = 1;
              targetSize = 1 / 1.2;
            } else {
              // pushed away and grown
              d.x -= (dx / dist) * f;
              d.y -= (dy / dist) * f;
              targetSize = 1.3;
            }
          }
        }
        // displaced dots glow blue (the trace); far-flung ones get smaller
        const off = Math.max(Math.abs(d.x - tx), Math.abs(d.y - ty));
        if (off > (pointer.down ? 7 : 1) * unit) {
          d.heat = 1;
          if (!pointer.down) targetSize = 1 / 1.8 + (targetSize - 1) * 0.3;
        }
        if (!pointer.down) d.pressHue *= 0.9;
        d.x += (tx - d.x) * ease;
        d.y += (ty - d.y) * ease;
        d.size += (targetSize - d.size) * 0.2;
        d.heat *= HEAT_FADE;
        if (off > 0.3 || d.heat > 0.05 || d.pressHue > 0.05 || Math.abs(d.size - 1) > 0.02) moving = true;
      }
      return moving || amp > 0;
    }

    function loop(now: number) {
      frame = 0;
      if (!onScreen || document.hidden) {
        running = false;
        return;
      }
      const moving = step(now);
      draw(now);
      if (moving || pointer.inside || pointer.down) {
        frame = requestAnimationFrame(loop);
      } else {
        running = false;
      }
    }

    function wake() {
      if (reduceMotion || running || !dots.length) return;
      running = true;
      frame = requestAnimationFrame(loop);
    }

    // --- input ---------------------------------------------------------------
    function toLocal(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    }
    const onMove = (e: PointerEvent) => {
      toLocal(e);
      pointer.inside = true;
      wake();
    };
    const onLeave = () => {
      pointer.inside = false;
      pointer.down = false;
    };
    const onDown = (e: PointerEvent) => {
      toLocal(e);
      pointer.down = true;
      pointer.inside = true;
      wake();
    };
    const onUp = () => {
      pointer.down = false;
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerup", onUp);

    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((en) => en.isIntersecting);
      if (onScreen) wake();
    });
    io.observe(canvas);
    const onVisibility = () => !document.hidden && wake();
    document.addEventListener("visibilitychange", onVisibility);
    // the size follows both the page width and the window height
    const relayout = () => {
      if (points.length) layout();
    };
    const ro = new ResizeObserver(relayout);
    ro.observe(wrap);
    window.addEventListener("resize", relayout);

    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (cancelled) return;
      points = trace(img);
      layout();
      wake();
    };
    img.src = src;

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      io.disconnect();
      ro.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", relayout);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [src, maxWidth, maxHeightRatio, wave]);

  return (
    <div ref={wrapRef} className={`particle-logo ${className || ""}`} style={{ maxWidth }}>
      <canvas ref={canvasRef} role="img" aria-label="W flow logo — move the mouse over it, or press and hold to pull the particles in" />
    </div>
  );
}
