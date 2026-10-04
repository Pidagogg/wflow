// ============================================================================
// W FLOW — dashboards
//
// The Dashboard node turns workflow output into a chart page that can be
// shared: every run adds a data point (or replaces the series), and
// /d/<id> draws the series as line charts, bars or a big number. The id is a
// random 128-bit value, so the link itself is the access control — like an
// unlisted document. Deleting the dashboard kills the link.
//
// Stored in the key-value store: one record per dashboard plus a per-user
// name → id index. Series are capped so a workflow that runs every minute
// cannot grow a record without bound.
// ============================================================================
import { randomBytes } from "node:crypto";
import { db } from "./dbx.js";
import { attachCode } from "../shared/errors.js";

export const MAX_POINTS = 1000;
const MAX_SERIES = 20;

const recordKey = (id) => `dash.${id}`;
const indexKey = (userId) => `dash.idx.${userId}`;

/** The site's public address (Setup → public URL, else BF_PUBLIC_URL), without a trailing slash. */
export async function publicBaseUrl() {
  let configured = "";
  try {
    configured = String((await db.storeGet("auth.publicUrl")) || "").trim();
  } catch {
    /* store hiccup — fall through to env */
  }
  return (configured || String(process.env.BF_PUBLIC_URL || "").trim()).replace(/\/+$/, "");
}

async function readJson(key, fallback) {
  try {
    const raw = await db.storeGet(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export async function getDashboard(id) {
  if (!/^[\w-]{16,40}$/.test(String(id || ""))) return null;
  return readJson(recordKey(id), null);
}

export async function listDashboards(userId) {
  const index = await readJson(indexKey(userId), {});
  const out = [];
  for (const [name, id] of Object.entries(index)) {
    const d = await getDashboard(id);
    if (d) out.push({ id, name, series: Object.keys(d.series || {}), updatedAt: d.updatedAt });
  }
  return out;
}

export async function deleteDashboard(userId, id) {
  const d = await getDashboard(id);
  if (!d || d.ownerId !== userId) return false;
  const index = await readJson(indexKey(userId), {});
  for (const [name, dashId] of Object.entries(index)) if (dashId === id) delete index[name];
  await db.storeSet(indexKey(userId), JSON.stringify(index));
  await db.storeSet(recordKey(id), "");
  return true;
}

/**
 * Add points to a dashboard's series, creating the dashboard on first use.
 * @param {{userId:string, name:string, series:string, chart:string, points:Array<{v:number,label?:string}>, replace?:boolean, keep?:number}} opts
 */
export async function writeSeries({ userId, name, series, chart = "line", points, replace = false, keep = 200, now = Date.now() }) {
  if (!userId) throw attachCode(new Error("Dashboards belong to an account — this run has no owner."), "MISSING_CONFIG");
  const dashName = String(name || "").trim().slice(0, 80);
  const seriesName = String(series || "").trim().slice(0, 80);
  if (!dashName) throw attachCode(new Error("Dashboard name is empty."), "MISSING_CONFIG");
  if (!seriesName) throw attachCode(new Error("Chart name is empty."), "MISSING_CONFIG");

  const index = await readJson(indexKey(userId), {});
  let id = index[dashName];
  let dash = id ? await getDashboard(id) : null;
  if (!dash) {
    id = randomBytes(16).toString("base64url");
    dash = { id, ownerId: userId, name: dashName, createdAt: new Date(now).toISOString(), series: {} };
    index[dashName] = id;
    await db.storeSet(indexKey(userId), JSON.stringify(index));
  }
  const existing = dash.series[seriesName];
  if (!existing && Object.keys(dash.series).length >= MAX_SERIES) {
    throw attachCode(new Error(`Dashboard “${dashName}” already has ${MAX_SERIES} charts — use another dashboard name.`), "MISSING_CONFIG");
  }
  const t = new Date(now).toISOString();
  const fresh = points.map((p) => ({ t, v: p.v, ...(p.label ? { label: String(p.label).slice(0, 60) } : {}) }));
  const limit = Math.max(1, Math.min(MAX_POINTS, Number(keep) || 200));
  const kept = [...(replace ? [] : existing?.points || []), ...fresh].slice(-limit);
  dash.series[seriesName] = { chart: ["line", "bar", "number"].includes(chart) ? chart : "line", points: kept };
  dash.updatedAt = t;
  await db.storeSet(recordKey(id), JSON.stringify(dash));
  return { id, name: dashName, series: seriesName, points: kept.length };
}

// ---- page ----
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 0 : abs >= 1 ? 2 : 6 });
}

function lineChart(points) {
  const W = 640;
  const H = 220;
  const P = { l: 56, r: 12, t: 12, b: 28 };
  const vals = points.map((p) => Number(p.v));
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const x = (i) => P.l + (points.length === 1 ? (W - P.l - P.r) / 2 : (i * (W - P.l - P.r)) / (points.length - 1));
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const path = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(vals.length - 1).toFixed(1)},${H - P.b} L${x(0).toFixed(1)},${H - P.b} Z`;
  const ticks = [max, (max + min) / 2, min];
  const first = new Date(points[0].t);
  const last = new Date(points[points.length - 1].t);
  const dots = points.length <= 60 ? vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5"><title>${esc(points[i].label || new Date(points[i].t).toLocaleString("en-GB"))}: ${fmt(v)}</title></circle>`).join("") : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">
  ${ticks.map((v) => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${P.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmt(v)}</text>`).join("")}
  <path class="area" d="${area}"/><path class="line" d="${path}"/>${dots}
  <text class="axis" x="${P.l}" y="${H - 8}">${esc(first.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }))}</text>
  <text class="axis" x="${W - P.r}" y="${H - 8}" text-anchor="end">${esc(last.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }))}</text>
</svg>`;
}

function barChart(points) {
  const W = 640;
  const P = { l: 140, r: 70 };
  const rows = points.slice(-30);
  const H = rows.length * 26 + 8;
  const max = Math.max(...rows.map((p) => Math.abs(Number(p.v))), 1e-9);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">${rows
    .map((p, i) => {
      const w = (Math.abs(Number(p.v)) / max) * (W - P.l - P.r);
      const yy = 4 + i * 26;
      const label = p.label || new Date(p.t).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
      return `<text class="axis" x="${P.l - 8}" y="${yy + 15}" text-anchor="end">${esc(String(label).slice(0, 22))}</text><rect class="bar" x="${P.l}" y="${yy}" width="${Math.max(1, w).toFixed(1)}" height="20" rx="3"/><text class="value" x="${(P.l + w + 6).toFixed(1)}" y="${yy + 15}">${fmt(p.v)}</text>`;
    })
    .join("")}</svg>`;
}

function numberTile(points) {
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const delta = prev ? Number(last.v) - Number(prev.v) : null;
  const pct = prev && Number(prev.v) ? (delta / Math.abs(Number(prev.v))) * 100 : null;
  const cls = delta === null || delta === 0 ? "" : delta > 0 ? "up" : "down";
  return `<div class="big">${fmt(last.v)}</div>${
    delta === null ? "" : `<div class="delta ${cls}">${delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} ${fmt(Math.abs(delta))}${pct === null ? "" : ` (${pct.toFixed(2)} %)`} since the previous value</div>`
  }`;
}

export function renderDashboardPage(dash) {
  const cards = Object.entries(dash.series || {})
    .map(([name, s]) => {
      const pts = (s.points || []).filter((p) => Number.isFinite(Number(p.v)));
      const body = !pts.length ? `<p class="muted">No data yet.</p>` : s.chart === "bar" ? barChart(pts) : s.chart === "number" ? numberTile(pts) : lineChart(pts);
      const latest = pts.length ? `<span class="latest">${fmt(pts[pts.length - 1].v)}</span>` : "";
      return `<section class="card"><header><h2>${esc(name)}</h2>${s.chart === "number" ? "" : latest}</header>${body}</section>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="60">
<title>${esc(dash.name)} · W flow dashboard</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#141821;--muted:#667085;--line:#e4e7ec;--accent:#2563eb;--up:#16a34a;--down:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0a0f1d;--card:#121a2c;--ink:#e6ebf5;--muted:#8a96ad;--line:#1f2a40;--accent:#4fd1ff;--up:#4ade80;--down:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.grid-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,480px),1fr));gap:16px;margin-top:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.card h2{font-size:15px;margin:0 0 8px}
.latest{font-weight:600;font-variant-numeric:tabular-nums}svg{width:100%;height:auto;display:block}
.grid{stroke:var(--line)}.axis{fill:var(--muted);font-size:11px}.value{fill:var(--ink);font-size:12px}
.line{fill:none;stroke:var(--accent);stroke-width:2}.area{fill:var(--accent);opacity:.08}circle{fill:var(--accent)}.bar{fill:var(--accent)}
.big{font-size:44px;font-weight:700;font-variant-numeric:tabular-nums;margin:8px 0}.delta{color:var(--muted)}.delta.up{color:var(--up)}.delta.down{color:var(--down)}
footer{margin-top:28px;font-size:12px}a{color:var(--accent)}
</style></head><body><main>
<h1>${esc(dash.name)}</h1><div class="muted">Updated ${esc(dash.updatedAt ? new Date(dash.updatedAt).toUTCString() : "never")} · refreshes every minute</div>
<div class="grid-cards">${cards || `<section class="card"><p class="muted">This dashboard has no charts yet.</p></section>`}</div>
<footer class="muted">Built with <a href="https://w-flow.tech">W flow</a></footer>
</main></body></html>`;
}

export function mountDashboardRoutes(app, { requireUser }) {
  app.get("/d/:id", async (req, res) => {
    const dash = await getDashboard(req.params.id);
    if (!dash) return res.status(404).type("text/plain").send("This dashboard does not exist or was deleted.");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    // Static page: no scripts at all, only its own inline styles.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.type("html").send(renderDashboardPage(dash));
  });
  app.get("/d/:id/data.json", async (req, res) => {
    const dash = await getDashboard(req.params.id);
    if (!dash) return res.status(404).json({ error: "Not found." });
    const { ownerId, ...pub } = dash;
    res.json(pub);
  });
  app.get("/api/dashboards", requireUser, async (req, res) => {
    res.json(await listDashboards(req.user.userId));
  });
  app.delete("/api/dashboards/:id", requireUser, async (req, res) => {
    const ok = await deleteDashboard(req.user.userId, req.params.id);
    if (!ok) return res.status(404).json({ error: "Dashboard not found." });
    res.json({ ok: true });
  });
}
