// ============================================================================
// W FLOW — Polymarket node (read-only)
//
// Reads Polymarket's public APIs: Gamma for markets and search, the CLOB for
// live prices, order books and price history, and the Data API for a wallet's
// positions. None of them needs a key. Gamma sends outcomes, prices and token
// IDs as JSON-encoded strings, so markets are normalised into one flat shape
// with real arrays and numbers that If / Filter nodes can compare directly.
//
// Trading is not supported: orders need EIP-712 signatures plus derived CLOB
// API credentials, which is a separate, larger piece of work.
// ============================================================================
import { attachCode } from "../shared/errors.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const TIMEOUT_MS = 30000;

const configError = (msg) => attachCode(new Error(msg), "MISSING_CONFIG");
const rowsOf = (v) => (Array.isArray(v) ? v : []);

async function get(base, path, query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ""));
  const res = await fetch(`${base}${path}${qs.toString() ? `?${qs}` : ""}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text().catch(() => "");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = (data && (data.error || data.message)) || text.slice(0, 200);
    if (res.status === 429) throw attachCode(new Error(`Polymarket rate-limited the request (HTTP 429). ${detail}`), "RATE_LIMITED");
    throw attachCode(new Error(`Polymarket returned HTTP ${res.status}. ${detail}`), "SERVICE_ERROR");
  }
  return data;
}

const num = (v) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || Number.isNaN(n) ? null : n;
};

function list(v) {
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---- normalisation ----
export function normalizeMarket(m) {
  const names = list(m.outcomes);
  const prices = list(m.outcomePrices).map(num);
  const tokens = list(m.clobTokenIds);
  return {
    id: m.id,
    question: m.question,
    slug: m.slug,
    url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
    outcomes: names.map((name, i) => ({ name, price: prices[i] ?? null, tokenId: tokens[i] ?? null })),
    // Shortcut for the common Yes/No market: the "Yes" price is the implied probability.
    yesPrice: prices[names.findIndex((n) => String(n).toLowerCase() === "yes")] ?? null,
    bestBid: num(m.bestBid),
    bestAsk: num(m.bestAsk),
    lastTradePrice: num(m.lastTradePrice),
    change24h: num(m.oneDayPriceChange),
    volume: num(m.volumeNum ?? m.volume),
    volume24h: num(m.volume24hr),
    liquidity: num(m.liquidityNum ?? m.liquidity),
    endDate: m.endDate || null,
    active: !!m.active,
    closed: !!m.closed,
    conditionId: m.conditionId || null,
  };
}

async function findMarket(ref) {
  const r = String(ref || "").trim();
  if (!r) throw configError("Market is empty. Enter the market's slug (from its polymarket.com URL) or its ID.");
  // Accept a pasted URL: polymarket.com/event/<event>/<market> or /market/<market>.
  const slug = r.includes("polymarket.com/") ? r.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() : r;
  const rows = /^\d+$/.test(slug) ? [await get(GAMMA, `/markets/${slug}`)].filter((m) => m?.question) : await get(GAMMA, "/markets", { slug });
  const m = rowsOf(rows)[0] || null;
  if (m) return m;
  // An event URL names the event, not a market: fall back to its first market.
  const events = await get(GAMMA, "/events", { slug });
  const eventMarket = rowsOf(events)[0]?.markets?.[0];
  if (eventMarket) return eventMarket;
  throw attachCode(new Error(`No Polymarket market found for "${r}".`), "SERVICE_ERROR");
}

function tokenFor(market, outcome) {
  const m = normalizeMarket(market);
  const wanted = String(outcome || "Yes").trim().toLowerCase();
  const o = m.outcomes.find((x) => String(x.name).toLowerCase() === wanted);
  if (!o?.tokenId) {
    throw configError(`Market "${m.question}" has no outcome "${outcome}". Its outcomes are: ${m.outcomes.map((x) => x.name).join(", ")}.`);
  }
  return { market: m, outcome: o };
}

// ---- entry point ----
export async function runPolymarket(cfg) {
  const op = cfg.operation || "search";
  const limit = Math.max(1, Math.min(Number(cfg.limit) || 10, 100));
  switch (op) {
    case "search": {
      if (!cfg.query) throw configError("Search text is empty.");
      const d = await get(GAMMA, "/public-search", { q: cfg.query, limit_per_type: String(limit), events_status: "active", keep_closed_markets: "0" });
      return rowsOf(d?.events)
        .flatMap((e) => rowsOf(e.markets).map((m) => ({ ...normalizeMarket(m), event: e.title })))
        .filter((m) => !m.closed)
        .slice(0, limit);
    }
    case "topMarkets": {
      const rows = await get(GAMMA, "/markets", { active: "true", closed: "false", order: "volume24hr", ascending: "false", limit: String(limit) });
      return rowsOf(rows).map(normalizeMarket);
    }
    case "getMarket":
      return normalizeMarket(await findMarket(cfg.market));
    case "price": {
      const { market, outcome } = tokenFor(await findMarket(cfg.market), cfg.outcome);
      const [mid, book] = await Promise.all([get(CLOB, "/midpoint", { token_id: outcome.tokenId }), get(CLOB, "/book", { token_id: outcome.tokenId })]);
      const bids = (book?.bids || []).map((b) => num(b.price));
      const asks = (book?.asks || []).map((a) => num(a.price));
      return {
        question: market.question,
        outcome: outcome.name,
        tokenId: outcome.tokenId,
        price: num(mid?.mid),
        bestBid: bids.length ? Math.max(...bids) : null,
        bestAsk: asks.length ? Math.min(...asks) : null,
        url: market.url,
      };
    }
    case "orderBook": {
      const { market, outcome } = tokenFor(await findMarket(cfg.market), cfg.outcome);
      const book = await get(CLOB, "/book", { token_id: outcome.tokenId });
      const side = (rows) => (rows || []).map((r) => ({ price: num(r.price), size: num(r.size) }));
      return {
        question: market.question,
        outcome: outcome.name,
        tokenId: outcome.tokenId,
        // Best prices first, which is not the order the CLOB returns them in.
        bids: side(book?.bids).sort((a, b) => b.price - a.price).slice(0, limit),
        asks: side(book?.asks).sort((a, b) => a.price - b.price).slice(0, limit),
      };
    }
    case "priceHistory": {
      const { market, outcome } = tokenFor(await findMarket(cfg.market), cfg.outcome);
      const d = await get(CLOB, "/prices-history", { market: outcome.tokenId, interval: cfg.interval || "1d", fidelity: "60" });
      return {
        question: market.question,
        outcome: outcome.name,
        history: (d?.history || []).map((p) => ({ time: new Date(p.t * 1000).toISOString(), price: num(p.p) })),
      };
    }
    case "positions": {
      const user = String(cfg.wallet || "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(user)) throw configError(`Wallet "${user}" is not a Polymarket wallet address (0x followed by 40 hex characters).`);
      const rows = await get(DATA, "/positions", { user, limit: String(limit), sizeThreshold: "0.01" });
      return rowsOf(rows).map((p) => ({
        title: p.title,
        outcome: p.outcome,
        size: num(p.size),
        avgPrice: num(p.avgPrice),
        currentPrice: num(p.curPrice),
        currentValue: num(p.currentValue),
        pnl: num(p.cashPnl),
        pnlPercent: num(p.percentPnl),
        endDate: p.endDate || null,
        url: p.slug ? `https://polymarket.com/market/${p.slug}` : null,
      }));
    }
  }
  throw configError(`Unknown operation "${op}".`);
}
