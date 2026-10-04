// ============================================================================
// Polymarket node — market normalisation (Gamma's JSON-in-a-string fields),
// outcome → token lookup, order-book sorting and input validation, against a
// scripted fetch.
//
// Run: node --test tests/polymarket.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { runPolymarket, normalizeMarket } from "../server/polymarket.js";
import { ERROR_CODES } from "../shared/errors.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MARKET = {
  id: "4052413",
  question: "Will Bitcoin reach $100,000 in September?",
  slug: "will-bitcoin-reach-100k-in-september-2026",
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.0035", "0.9965"]',
  clobTokenIds: '["111", "222"]',
  bestBid: 0.003,
  bestAsk: 0.004,
  volumeNum: 1447231.5,
  liquidityNum: 176064.2,
  endDate: "2026-10-01T04:00:00Z",
  active: true,
  closed: false,
};

let calls = [];
/** Route by host + path; each handler returns the JSON body. */
function api(routes) {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const handler = routes[`${u.host}${u.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(handler(u)), { headers: { "content-type": "application/json" } });
  };
}

test("markets are flattened into real arrays and numbers", () => {
  const m = normalizeMarket(MARKET);
  assert.deepEqual(m.outcomes, [
    { name: "Yes", price: 0.0035, tokenId: "111" },
    { name: "No", price: 0.9965, tokenId: "222" },
  ]);
  assert.equal(m.yesPrice, 0.0035);
  assert.equal(m.url, "https://polymarket.com/market/will-bitcoin-reach-100k-in-september-2026");
  assert.equal(normalizeMarket({ ...MARKET, outcomes: "not json" }).outcomes.length, 0, "a broken field never crashes");
});

test("search returns only open markets and keeps the event title", async () => {
  api({
    "gamma-api.polymarket.com/public-search": () => ({ events: [{ title: "BTC", markets: [MARKET, { ...MARKET, id: "2", closed: true }] }] }),
  });
  const r = await runPolymarket({ operation: "search", query: "bitcoin", limit: 5 });
  assert.equal(r.length, 1);
  assert.equal(r[0].event, "BTC");
  assert.equal(calls[0].searchParams.get("events_status"), "active");
});

test("price looks up the outcome's token, accepts a pasted link and reads mid and best prices", async () => {
  api({
    "gamma-api.polymarket.com/markets": (u) => (u.searchParams.get("slug") === MARKET.slug ? [MARKET] : []),
    "clob.polymarket.com/midpoint": (u) => ({ mid: u.searchParams.get("token_id") === "222" ? "0.9965" : "0" }),
    "clob.polymarket.com/book": () => ({ bids: [{ price: "0.99", size: "5" }, { price: "0.996", size: "1" }], asks: [{ price: "0.999", size: "3" }, { price: "0.997", size: "2" }] }),
  });
  const r = await runPolymarket({ operation: "price", market: `https://polymarket.com/event/what-price-will-bitcoin-hit/${MARKET.slug}?tid=1`, outcome: "no" });
  assert.equal(r.outcome, "No");
  assert.equal(r.tokenId, "222");
  assert.equal(r.price, 0.9965);
  assert.equal(r.bestBid, 0.996);
  assert.equal(r.bestAsk, 0.997);
});

test("order books come back best price first", async () => {
  api({
    "gamma-api.polymarket.com/markets": () => [MARKET],
    "clob.polymarket.com/book": () => ({ bids: [{ price: "0.001", size: "1" }, { price: "0.003", size: "2" }], asks: [{ price: "0.999", size: "1" }, { price: "0.004", size: "2" }] }),
  });
  const r = await runPolymarket({ operation: "orderBook", market: MARKET.slug, outcome: "Yes", limit: 1 });
  assert.deepEqual(r.bids, [{ price: 0.003, size: 2 }]);
  assert.deepEqual(r.asks, [{ price: 0.004, size: 2 }]);
});

test("an event slug falls back to the event's first market", async () => {
  api({
    "gamma-api.polymarket.com/markets": () => [],
    "gamma-api.polymarket.com/events": () => [{ markets: [MARKET] }],
  });
  assert.equal((await runPolymarket({ operation: "getMarket", market: "what-price-will-bitcoin-hit" })).id, "4052413");
});

test("a wrong outcome name lists the real ones", async () => {
  api({ "gamma-api.polymarket.com/markets": () => [MARKET] });
  await assert.rejects(runPolymarket({ operation: "price", market: MARKET.slug, outcome: "Maybe" }), /outcomes are: Yes, No/);
});

test("price history is converted to ISO times", async () => {
  api({
    "gamma-api.polymarket.com/markets": () => [MARKET],
    "clob.polymarket.com/prices-history": () => ({ history: [{ t: 1790427627, p: 0.003 }] }),
  });
  const r = await runPolymarket({ operation: "priceHistory", market: MARKET.slug, outcome: "Yes", interval: "1w" });
  assert.deepEqual(r.history, [{ time: "2026-09-26T13:00:27.000Z", price: 0.003 }]);
  assert.equal(calls[1].searchParams.get("interval"), "1w");
});

test("positions need a wallet address and are summarised", async () => {
  api({ "data-api.polymarket.com/positions": () => [{ title: "T", outcome: "Yes", size: 10, avgPrice: 0.4, curPrice: 0.5, currentValue: 5, cashPnl: 1, percentPnl: 25, slug: "t" }] });
  await assert.rejects(runPolymarket({ operation: "positions", wallet: "alice" }), (e) => e._bfCode === ERROR_CODES.MISSING_CONFIG.code);
  const [p] = await runPolymarket({ operation: "positions", wallet: `0x${"1".repeat(40)}` });
  assert.equal(p.pnl, 1);
  assert.equal(p.url, "https://polymarket.com/market/t");
});

test("HTTP failures are classified", async () => {
  globalThis.fetch = async () => new Response("slow down", { status: 429 });
  await assert.rejects(runPolymarket({ operation: "topMarkets" }), (e) => e._bfCode === ERROR_CODES.RATE_LIMITED.code);
});
