// ============================================================================
// W FLOW — crypto exchange nodes (Coinbase, Binance, Kraken, Bybit, OKX, KuCoin)
//
// Exchanges don't fit the descriptor-driven service engine: every private
// request is signed per call (a short-lived ES256/EdDSA JWT for Coinbase, an
// HMAC over a different string for each of the others), and
// each API spells prices, balances and errors differently. This module does
// the signing with node:crypto and plain fetch, and normalises prices and
// balances so a workflow can swap one exchange for another.
//
// Placing an order moves real money, so the order operations default to each
// exchange's own dry-run endpoint (Coinbase order preview, Binance
// /order/test, Kraken validate=true, KuCoin /hf/orders/test) until the user
// turns test mode off. Bybit and OKX have none, so there test mode proves the
// key with a signed balance read and returns the order without sending it.
// ============================================================================
import { createHash, createHmac, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { attachCode } from "../shared/errors.js";

const TIMEOUT_MS = 30000;

const ORDER_OPS = new Set(["marketOrder", "limitOrder"]);
const PRIVATE_OPS = new Set(["balances", "openOrders", "marketOrder", "limitOrder", "getOrder", "cancelOrder"]);

// ---- errors ----
function exchangeHttpError(status, detail) {
  const suffix = String(detail || "").trim() ? ` ${String(detail).slice(0, 300)}` : "";
  if (status === 401 || status === 403) return attachCode(new Error(`The exchange rejected the API key (HTTP ${status}).${suffix}`), "AUTH_FAILED");
  if (status === 429 || status === 418) return attachCode(new Error(`The exchange rate-limited the request (HTTP ${status}).${suffix}`), "RATE_LIMITED");
  return attachCode(new Error(`The exchange returned HTTP ${status}.${suffix}`), "SERVICE_ERROR");
}

function missing(what) {
  return attachCode(new Error(`${what} is empty. Fill it in on the node.`), "MISSING_CONFIG");
}

async function send(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text().catch(() => "");
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { res, data };
}

const num = (v) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || Number.isNaN(n) ? null : n;
};

// ---- Coinbase Advanced Trade ----
// CDP API keys: the key name ("organizations/…/apiKeys/…") plus either an EC
// private key (PEM, ES256) or a base64 Ed25519 key (EdDSA). The PEM usually
// arrives flattened by a single-line password input, so it is rebuilt from
// its base64 body.
const COINBASE = "https://api.coinbase.com";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function coinbaseKey(secret) {
  const s = String(secret).replace(/\\n/g, "\n").trim();
  const pem = s.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (pem) {
    const body = pem[2].replace(/\s+/g, "").replace(/(.{64})/g, "$1\n");
    return { alg: "ES256", key: createPrivateKey(`-----BEGIN ${pem[1]}-----\n${body}\n-----END ${pem[1]}-----\n`) };
  }
  const raw = Buffer.from(s, "base64");
  if (raw.length !== 64 && raw.length !== 32) {
    throw attachCode(new Error("The Coinbase API secret is neither an EC private key (-----BEGIN EC PRIVATE KEY-----) nor a base64 Ed25519 key."), "AUTH_FAILED");
  }
  const seed = raw.subarray(0, 32);
  return { alg: "EdDSA", key: createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" }) };
}

function coinbaseJwt(keyName, secret, method, path) {
  const { alg, key } = coinbaseKey(secret);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg, kid: keyName, nonce: randomBytes(16).toString("hex"), typ: "JWT" });
  const payload = b64({ sub: keyName, iss: "cdp", nbf: now, exp: now + 120, uri: `${method} api.coinbase.com${path}` });
  const input = `${header}.${payload}`;
  const sig = alg === "ES256" ? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }) : sign(null, Buffer.from(input), key);
  return `${input}.${sig.toString("base64url")}`;
}

async function coinbaseCall(cfg, method, path, { query, body } = {}) {
  const headers = { Accept: "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${coinbaseJwt(cfg.apiKey, cfg.secret, method, path)}`;
  if (body) headers["Content-Type"] = "application/json";
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const { res, data } = await send(`${COINBASE}${path}${qs}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw exchangeHttpError(res.status, data.message || data.error_details || data.error || data.raw);
  return data;
}

async function coinbase(op, cfg) {
  const B = "/api/v3/brokerage";
  switch (op) {
    case "price": {
      const d = await coinbaseCall({}, "GET", `${B}/market/products/${encodeURIComponent(cfg.symbol)}`);
      return {
        symbol: d.product_id || cfg.symbol,
        price: num(d.price),
        change24h: num(d.price_percentage_change_24h),
        volume24h: num(d.volume_24h),
        raw: d,
      };
    }
    case "balances": {
      const d = await coinbaseCall(cfg, "GET", `${B}/accounts`, { query: { limit: "250" } });
      return (d.accounts || [])
        .map((a) => ({ asset: a.currency, available: num(a.available_balance?.value) ?? 0, locked: num(a.hold?.value) ?? 0 }))
        .filter((b) => b.available || b.locked);
    }
    case "openOrders": {
      const query = new URLSearchParams({ order_status: "OPEN" });
      if (cfg.symbol) query.append("product_ids", cfg.symbol);
      const d = await coinbaseCall(cfg, "GET", `${B}/orders/historical/batch`, { query });
      return d.orders || [];
    }
    case "marketOrder":
    case "limitOrder": {
      const size = cfg.amountIn === "quote" && op === "marketOrder" ? { quote_size: cfg.amount } : { base_size: cfg.amount };
      const order_configuration =
        op === "marketOrder" ? { market_market_ioc: size } : { limit_limit_gtc: { base_size: cfg.amount, limit_price: cfg.limitPrice, post_only: false } };
      const order = { product_id: cfg.symbol, side: cfg.side.toUpperCase(), order_configuration };
      if (cfg.testMode) return { test: true, preview: await coinbaseCall(cfg, "POST", `${B}/orders/preview`, { body: order }) };
      const d = await coinbaseCall(cfg, "POST", `${B}/orders`, { body: { client_order_id: randomUUID(), ...order } });
      if (d.success === false) throw attachCode(new Error(`Coinbase refused the order: ${d.error_response?.message || d.failure_reason || "unknown reason"}`), "SERVICE_ERROR");
      return { test: false, orderId: d.success_response?.order_id || d.order_id || null, raw: d };
    }
    case "getOrder": {
      const d = await coinbaseCall(cfg, "GET", `${B}/orders/historical/${encodeURIComponent(cfg.orderId)}`);
      return d.order || d;
    }
    case "cancelOrder": {
      const d = await coinbaseCall(cfg, "POST", `${B}/orders/batch_cancel`, { body: { order_ids: [cfg.orderId] } });
      const r = (d.results || [])[0] || {};
      if (r.success === false) throw attachCode(new Error(`Coinbase could not cancel the order: ${r.failure_reason || "unknown reason"}`), "SERVICE_ERROR");
      return { orderId: cfg.orderId, cancelled: true, raw: d };
    }
  }
}

// ---- Binance ----
// Signed endpoints take every parameter in the query string plus a timestamp,
// and an HMAC-SHA256 of that string keyed with the API secret.
async function binanceCall(cfg, method, path, params = {}, signed = false) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  const headers = { Accept: "application/json" };
  if (signed) {
    query.set("recvWindow", "5000");
    query.set("timestamp", String(Date.now()));
    query.set("signature", createHmac("sha256", cfg.secret).update(query.toString()).digest("hex"));
    headers["X-MBX-APIKEY"] = cfg.apiKey;
  }
  const qs = query.toString();
  const { res, data } = await send(`${cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`, { method, headers });
  if (!res.ok) {
    // -2014/-2015 are Binance's "bad key / no permission" codes, sent as 400 or 401.
    const status = data.code === -2014 || data.code === -2015 ? 401 : res.status;
    throw exchangeHttpError(status, data.msg ? `${data.msg} (code ${data.code})` : data.raw);
  }
  return data;
}

async function binance(op, cfg) {
  const symbol = cfg.symbol.toUpperCase().replace(/[-/_\s]/g, "");
  switch (op) {
    case "price": {
      const d = await binanceCall(cfg, "GET", "/api/v3/ticker/24hr", { symbol });
      return {
        symbol: d.symbol || symbol,
        price: num(d.lastPrice),
        change24h: num(d.priceChangePercent),
        high24h: num(d.highPrice),
        low24h: num(d.lowPrice),
        volume24h: num(d.volume),
        raw: d,
      };
    }
    case "balances": {
      const d = await binanceCall(cfg, "GET", "/api/v3/account", { omitZeroBalances: "true" }, true);
      return (d.balances || [])
        .map((b) => ({ asset: b.asset, available: num(b.free) ?? 0, locked: num(b.locked) ?? 0 }))
        .filter((b) => b.available || b.locked);
    }
    case "openOrders":
      return binanceCall(cfg, "GET", "/api/v3/openOrders", { symbol: cfg.symbol ? symbol : undefined }, true);
    case "marketOrder":
    case "limitOrder": {
      const params = { symbol, side: cfg.side.toUpperCase(), type: op === "marketOrder" ? "MARKET" : "LIMIT" };
      if (op === "limitOrder") Object.assign(params, { quantity: cfg.amount, price: cfg.limitPrice, timeInForce: "GTC" });
      else if (cfg.amountIn === "quote") params.quoteOrderQty = cfg.amount;
      else params.quantity = cfg.amount;
      if (cfg.testMode) {
        const d = await binanceCall(cfg, "POST", "/api/v3/order/test", params, true);
        return { test: true, accepted: true, raw: d };
      }
      const d = await binanceCall(cfg, "POST", "/api/v3/order", { ...params, newOrderRespType: "FULL" }, true);
      return { test: false, orderId: d.orderId ?? null, status: d.status, raw: d };
    }
    case "getOrder":
      return binanceCall(cfg, "GET", "/api/v3/order", { symbol, orderId: cfg.orderId }, true);
    case "cancelOrder": {
      const d = await binanceCall(cfg, "DELETE", "/api/v3/order", { symbol, orderId: cfg.orderId }, true);
      return { orderId: cfg.orderId, cancelled: true, raw: d };
    }
  }
}

// ---- Kraken ----
// Private calls are form POSTs; API-Sign is HMAC-SHA512 (base64-decoded
// secret) over path + SHA256(nonce + body). Kraken reports most failures as
// HTTP 200 with an `error` array, so that array decides success.
const KRAKEN = "https://api.kraken.com";
let krakenNonce = 0;

function krakenError(errors) {
  const msg = errors.join("; ");
  if (/EAPI:Invalid (key|signature)|EGeneral:Permission denied/i.test(msg)) return exchangeHttpError(401, msg);
  if (/Rate limit|Too many requests/i.test(msg)) return exchangeHttpError(429, msg);
  return attachCode(new Error(`Kraken reported an error: ${msg}`), "SERVICE_ERROR");
}

async function krakenCall(cfg, path, params = {}, isPrivate = false) {
  let url = `${KRAKEN}${path}`;
  const init = { method: "GET", headers: { Accept: "application/json" } };
  const form = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  if (isPrivate) {
    krakenNonce = Math.max(Date.now() * 1000, krakenNonce + 1);
    form.set("nonce", String(krakenNonce));
    const body = form.toString();
    const digest = createHash("sha256").update(String(krakenNonce) + body).digest();
    const signature = createHmac("sha512", Buffer.from(cfg.secret, "base64")).update(Buffer.concat([Buffer.from(path), digest])).digest("base64");
    Object.assign(init, { method: "POST", body });
    Object.assign(init.headers, { "API-Key": cfg.apiKey, "API-Sign": signature, "Content-Type": "application/x-www-form-urlencoded" });
  } else if (form.toString()) {
    url += `?${form}`;
  }
  const { res, data } = await send(url, init);
  if (Array.isArray(data.error) && data.error.length) throw krakenError(data.error);
  if (!res.ok) throw exchangeHttpError(res.status, data.raw);
  return data.result ?? {};
}

async function kraken(op, cfg) {
  const pair = cfg.symbol.toUpperCase().replace(/[-/_\s]/g, "");
  switch (op) {
    case "price": {
      const result = await krakenCall(cfg, "/0/public/Ticker", { pair });
      const [key, t] = Object.entries(result)[0] || [];
      if (!t) throw attachCode(new Error(`Kraken has no ticker for '${pair}'.`), "SERVICE_ERROR");
      const price = num(t.c?.[0]);
      const open = num(t.o);
      return {
        symbol: key,
        price,
        // Kraken has no rolling 24h change; this is the change since today's open (UTC).
        change24h: price !== null && open ? Number((((price - open) / open) * 100).toFixed(4)) : null,
        high24h: num(t.h?.[1]),
        low24h: num(t.l?.[1]),
        volume24h: num(t.v?.[1]),
        raw: t,
      };
    }
    case "balances": {
      const result = await krakenCall(cfg, "/0/private/BalanceEx", {}, true);
      return Object.entries(result)
        .map(([asset, b]) => {
          const total = num(typeof b === "object" ? b.balance : b) ?? 0;
          const locked = num(b?.hold_trade) ?? 0;
          return { asset, available: Number((total - locked).toFixed(10)), locked };
        })
        .filter((b) => b.available || b.locked);
    }
    case "openOrders": {
      const result = await krakenCall(cfg, "/0/private/OpenOrders", {}, true);
      const orders = Object.entries(result.open || {}).map(([orderId, o]) => ({ orderId, ...o }));
      return cfg.symbol ? orders.filter((o) => String(o.descr?.pair || "").toUpperCase() === pair || !o.descr?.pair) : orders;
    }
    case "marketOrder":
    case "limitOrder": {
      if (op === "marketOrder" && cfg.amountIn === "quote") {
        throw attachCode(new Error("Kraken market orders take the amount in the base coin. Set “Amount is in” to the base coin."), "MISSING_CONFIG");
      }
      const params = { pair, type: cfg.side, ordertype: op === "marketOrder" ? "market" : "limit", volume: cfg.amount };
      if (op === "limitOrder") params.price = cfg.limitPrice;
      if (cfg.testMode) params.validate = "true";
      const result = await krakenCall(cfg, "/0/private/AddOrder", params, true);
      return { test: !!cfg.testMode, orderId: result.txid?.[0] ?? null, description: result.descr?.order ?? null, raw: result };
    }
    case "getOrder": {
      const result = await krakenCall(cfg, "/0/private/QueryOrders", { txid: cfg.orderId }, true);
      return { orderId: cfg.orderId, ...(result[cfg.orderId] || {}) };
    }
    case "cancelOrder": {
      const result = await krakenCall(cfg, "/0/private/CancelOrder", { txid: cfg.orderId }, true);
      return { orderId: cfg.orderId, cancelled: (result.count ?? 0) > 0, raw: result };
    }
  }
}

// ---- Bybit (v5, spot) ----
// X-BAPI-SIGN is a hex HMAC-SHA256 over timestamp + key + recvWindow + the
// query string (GET) or the JSON body (POST). Failures arrive as HTTP 200
// with a non-zero retCode. Bybit has no dry-run order endpoint, so test mode
// proves the key with a signed balance read and returns the order unsent.
async function bybitCall(cfg, method, path, params = {}, signed = false) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  const query = method === "GET" ? new URLSearchParams(clean).toString() : "";
  const body = method === "GET" ? "" : JSON.stringify(clean);
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (signed) {
    const ts = String(Date.now());
    Object.assign(headers, {
      "X-BAPI-API-KEY": cfg.apiKey,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": "5000",
      "X-BAPI-SIGN": createHmac("sha256", cfg.secret).update(ts + cfg.apiKey + "5000" + (query || body)).digest("hex"),
    });
  }
  const { res, data } = await send(`${cfg.baseUrl}${path}${query ? `?${query}` : ""}`, { method, headers, body: body || undefined });
  if (!res.ok) throw exchangeHttpError(res.status, data.retMsg || data.raw);
  if (data.retCode !== 0) {
    const msg = `${data.retMsg} (retCode ${data.retCode})`;
    if ([10003, 10004, 10005, 10007, 10010, 33004].includes(data.retCode)) throw exchangeHttpError(401, msg);
    if (data.retCode === 10006 || data.retCode === 10018) throw exchangeHttpError(429, msg);
    throw attachCode(new Error(`Bybit reported an error: ${msg}`), "SERVICE_ERROR");
  }
  return data.result || {};
}

async function bybitBalances(cfg) {
  const r = await bybitCall(cfg, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }, true);
  return (r.list?.[0]?.coin || [])
    .map((c) => {
      const total = num(c.walletBalance) ?? 0;
      const locked = num(c.locked) ?? 0;
      return { asset: c.coin, available: Number((total - locked).toFixed(10)), locked };
    })
    .filter((b) => b.available || b.locked);
}

async function bybit(op, cfg) {
  const symbol = cfg.symbol.toUpperCase().replace(/[-/_\s]/g, "");
  switch (op) {
    case "price": {
      const r = await bybitCall(cfg, "GET", "/v5/market/tickers", { category: "spot", symbol });
      const t = r.list?.[0];
      if (!t) throw attachCode(new Error(`Bybit has no spot ticker for '${symbol}'.`), "SERVICE_ERROR");
      return {
        symbol: t.symbol,
        price: num(t.lastPrice),
        // Bybit sends the change as a fraction (0.0099 = 0.99 %).
        change24h: num(t.price24hPcnt) === null ? null : Number((num(t.price24hPcnt) * 100).toFixed(4)),
        high24h: num(t.highPrice24h),
        low24h: num(t.lowPrice24h),
        volume24h: num(t.volume24h),
        raw: t,
      };
    }
    case "balances":
      return bybitBalances(cfg);
    case "openOrders": {
      const r = await bybitCall(cfg, "GET", "/v5/order/realtime", { category: "spot", symbol: cfg.symbol ? symbol : undefined }, true);
      return r.list || [];
    }
    case "marketOrder":
    case "limitOrder": {
      const order = { category: "spot", symbol, side: cfg.side === "buy" ? "Buy" : "Sell", orderType: op === "marketOrder" ? "Market" : "Limit", qty: cfg.amount };
      if (op === "limitOrder") Object.assign(order, { price: cfg.limitPrice, timeInForce: "GTC" });
      else order.marketUnit = cfg.amountIn === "quote" ? "quoteCoin" : "baseCoin";
      if (cfg.testMode) return { test: true, keyWorks: true, balances: await bybitBalances(cfg), wouldSend: order };
      const r = await bybitCall(cfg, "POST", "/v5/order/create", order, true);
      return { test: false, orderId: r.orderId ?? null, raw: r };
    }
    case "getOrder": {
      const q = { category: "spot", symbol, orderId: cfg.orderId };
      const open = await bybitCall(cfg, "GET", "/v5/order/realtime", q, true);
      if (open.list?.length) return open.list[0];
      const done = await bybitCall(cfg, "GET", "/v5/order/history", q, true);
      if (done.list?.length) return done.list[0];
      throw attachCode(new Error(`Bybit has no order ${cfg.orderId} for ${symbol}.`), "SERVICE_ERROR");
    }
    case "cancelOrder": {
      const r = await bybitCall(cfg, "POST", "/v5/order/cancel", { category: "spot", symbol, orderId: cfg.orderId }, true);
      return { orderId: r.orderId || cfg.orderId, cancelled: true, raw: r };
    }
  }
}

// ---- OKX (v5, spot) ----
// OK-ACCESS-SIGN is a base64 HMAC-SHA256 over ISO timestamp + method + path
// (with query) + body, and every key has a passphrase. Failures arrive with a
// non-"0" code; like Bybit there is no dry-run order endpoint.
async function okxCall(cfg, method, path, params = {}, signed = false) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  const query = method === "GET" ? new URLSearchParams(clean).toString() : "";
  const requestPath = `${path}${query ? `?${query}` : ""}`;
  const body = method === "GET" ? "" : JSON.stringify(clean);
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (signed) {
    const ts = new Date().toISOString();
    Object.assign(headers, {
      "OK-ACCESS-KEY": cfg.apiKey,
      "OK-ACCESS-SIGN": createHmac("sha256", cfg.secret).update(ts + method + requestPath + body).digest("base64"),
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": cfg.passphrase,
    });
  }
  const { res, data } = await send(`https://www.okx.com${requestPath}`, { method, headers, body: body || undefined });
  const code = String(data.code ?? "");
  if (code && code !== "0") {
    const msg = `${data.msg || data.data?.[0]?.sMsg || "error"} (code ${code})`;
    if (/^501(0[0-9]|1[0-9])$/.test(code)) throw exchangeHttpError(401, msg);
    if (code === "50011" || code === "50061") throw exchangeHttpError(429, msg);
    throw attachCode(new Error(`OKX reported an error: ${msg}`), "SERVICE_ERROR");
  }
  if (!res.ok) throw exchangeHttpError(res.status, data.msg || data.raw);
  return data.data || [];
}

async function okxBalances(cfg) {
  const d = await okxCall(cfg, "GET", "/api/v5/account/balance", {}, true);
  return (d[0]?.details || [])
    .map((b) => ({ asset: b.ccy, available: num(b.availBal) ?? 0, locked: num(b.frozenBal) ?? 0 }))
    .filter((b) => b.available || b.locked);
}

async function okx(op, cfg) {
  const instId = cfg.symbol.toUpperCase().replace(/[/_\s]/g, "-");
  switch (op) {
    case "price": {
      const t = (await okxCall(cfg, "GET", "/api/v5/market/ticker", { instId }))[0];
      if (!t) throw attachCode(new Error(`OKX has no ticker for '${instId}'.`), "SERVICE_ERROR");
      const price = num(t.last);
      const open = num(t.open24h);
      return {
        symbol: t.instId,
        price,
        change24h: price !== null && open ? Number((((price - open) / open) * 100).toFixed(4)) : null,
        high24h: num(t.high24h),
        low24h: num(t.low24h),
        volume24h: num(t.vol24h),
        raw: t,
      };
    }
    case "balances":
      return okxBalances(cfg);
    case "openOrders":
      return okxCall(cfg, "GET", "/api/v5/trade/orders-pending", { instType: "SPOT", instId: cfg.symbol ? instId : undefined }, true);
    case "marketOrder":
    case "limitOrder": {
      const order = { instId, tdMode: "cash", side: cfg.side, ordType: op === "marketOrder" ? "market" : "limit", sz: cfg.amount };
      if (op === "limitOrder") order.px = cfg.limitPrice;
      // OKX reads a spot market BUY size as quote currency unless told otherwise.
      else order.tgtCcy = cfg.amountIn === "quote" ? "quote_ccy" : "base_ccy";
      if (cfg.testMode) return { test: true, keyWorks: true, balances: await okxBalances(cfg), wouldSend: order };
      const d = (await okxCall(cfg, "POST", "/api/v5/trade/order", order, true))[0] || {};
      if (d.sCode && d.sCode !== "0") throw attachCode(new Error(`OKX refused the order: ${d.sMsg} (sCode ${d.sCode})`), "SERVICE_ERROR");
      return { test: false, orderId: d.ordId ?? null, raw: d };
    }
    case "getOrder":
      return (await okxCall(cfg, "GET", "/api/v5/trade/order", { instId, ordId: cfg.orderId }, true))[0] || {};
    case "cancelOrder": {
      const d = (await okxCall(cfg, "POST", "/api/v5/trade/cancel-order", { instId, ordId: cfg.orderId }, true))[0] || {};
      if (d.sCode && d.sCode !== "0") throw attachCode(new Error(`OKX could not cancel the order: ${d.sMsg} (sCode ${d.sCode})`), "SERVICE_ERROR");
      return { orderId: cfg.orderId, cancelled: true, raw: d };
    }
  }
}

// ---- KuCoin (spot, HF endpoints) ----
// KC-API-SIGN is a base64 HMAC-SHA256 over ms timestamp + method + path (with
// query) + body; key version 2 also signs the passphrase with the secret.
// Failures carry a code other than "200000". KuCoin has a real dry-run
// endpoint (/hf/orders/test).
async function kucoinCall(cfg, method, path, params = {}, signed = false) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ""));
  const inQuery = method === "GET" || method === "DELETE";
  const query = inQuery ? new URLSearchParams(clean).toString() : "";
  const endpoint = `${path}${query ? `?${query}` : ""}`;
  const body = inQuery ? "" : JSON.stringify(clean);
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (signed) {
    const ts = String(Date.now());
    const hmac = (text) => createHmac("sha256", cfg.secret).update(text).digest("base64");
    Object.assign(headers, {
      "KC-API-KEY": cfg.apiKey,
      "KC-API-SIGN": hmac(ts + method + endpoint + body),
      "KC-API-TIMESTAMP": ts,
      "KC-API-PASSPHRASE": hmac(cfg.passphrase),
      "KC-API-KEY-VERSION": "2",
    });
  }
  const { res, data } = await send(`https://api.kucoin.com${endpoint}`, { method, headers, body: body || undefined });
  const code = String(data.code ?? "");
  if (code && code !== "200000") {
    const msg = `${data.msg || "error"} (code ${code})`;
    if (/^40000[1-7]$/.test(code) || code === "411100") throw exchangeHttpError(401, msg);
    if (code === "429000") throw exchangeHttpError(429, msg);
    throw attachCode(new Error(`KuCoin reported an error: ${msg}`), "SERVICE_ERROR");
  }
  if (!res.ok) throw exchangeHttpError(res.status, data.msg || data.raw);
  return data.data;
}

async function kucoin(op, cfg) {
  const symbol = cfg.symbol.toUpperCase().replace(/[/_\s]/g, "-");
  switch (op) {
    case "price": {
      const t = await kucoinCall(cfg, "GET", "/api/v1/market/stats", { symbol });
      if (!t || t.last == null) throw attachCode(new Error(`KuCoin has no ticker for '${symbol}'.`), "SERVICE_ERROR");
      return {
        symbol: t.symbol,
        price: num(t.last),
        change24h: num(t.changeRate) === null ? null : Number((num(t.changeRate) * 100).toFixed(4)),
        high24h: num(t.high),
        low24h: num(t.low),
        volume24h: num(t.vol),
        raw: t,
      };
    }
    case "balances": {
      const d = await kucoinCall(cfg, "GET", "/api/v1/accounts", { type: "trade" }, true);
      return (d || [])
        .map((a) => ({ asset: a.currency, available: num(a.available) ?? 0, locked: num(a.holds) ?? 0 }))
        .filter((b) => b.available || b.locked);
    }
    case "openOrders":
      return (await kucoinCall(cfg, "GET", "/api/v1/hf/orders/active", { symbol }, true)) || [];
    case "marketOrder":
    case "limitOrder": {
      const order = { clientOid: randomUUID(), symbol, side: cfg.side, type: op === "marketOrder" ? "market" : "limit" };
      if (op === "limitOrder") Object.assign(order, { size: cfg.amount, price: cfg.limitPrice, timeInForce: "GTC" });
      else if (cfg.amountIn === "quote") order.funds = cfg.amount;
      else order.size = cfg.amount;
      if (cfg.testMode) return { test: true, accepted: true, raw: await kucoinCall(cfg, "POST", "/api/v1/hf/orders/test", order, true) };
      const d = await kucoinCall(cfg, "POST", "/api/v1/hf/orders", order, true);
      return { test: false, orderId: d?.orderId ?? null, raw: d };
    }
    case "getOrder":
      return kucoinCall(cfg, "GET", `/api/v1/hf/orders/${encodeURIComponent(cfg.orderId)}`, { symbol }, true);
    case "cancelOrder": {
      const d = await kucoinCall(cfg, "DELETE", `/api/v1/hf/orders/${encodeURIComponent(cfg.orderId)}`, { symbol }, true);
      return { orderId: d?.orderId || cfg.orderId, cancelled: true, raw: d };
    }
  }
}

// ---- entry point ----
const RUNNERS = { coinbaseExchange: coinbase, binanceExchange: binance, krakenExchange: kraken, bybitExchange: bybit, okxExchange: okx, kucoinExchange: kucoin };
// Exchanges that need the pair to look up or cancel an order.
const SYMBOL_FOR_ORDERS = new Set(["binanceExchange", "bybitExchange", "okxExchange", "kucoinExchange"]);
const NEEDS_PASSPHRASE = new Set(["okxExchange", "kucoinExchange"]);

/**
 * Run one exchange operation for one item. `cfg` is the node config with its
 * {{vars}} already rendered; the result is the value saved under `storeIn`.
 */
export async function runExchange(type, cfg) {
  const op = cfg.operation || "price";
  if (!RUNNERS[type]) throw attachCode(new Error(`Unknown exchange node '${type}'.`), "UNSUPPORTED_NODE");
  if (!["price", ...PRIVATE_OPS].includes(op)) throw attachCode(new Error(`Unknown operation '${op}'.`), "MISSING_CONFIG");
  if (PRIVATE_OPS.has(op)) {
    if (!cfg.apiKey) throw missing("API key");
    if (!cfg.secret) throw missing("API secret");
    if (NEEDS_PASSPHRASE.has(type) && !cfg.passphrase) throw missing("API passphrase");
  }
  const orderLookup = op === "getOrder" || op === "cancelOrder";
  const needsSymbol = op === "price" || ORDER_OPS.has(op) || (orderLookup && SYMBOL_FOR_ORDERS.has(type)) || (op === "openOrders" && type === "kucoinExchange");
  if (!cfg.symbol && needsSymbol) {
    throw missing("Trading pair");
  }
  if (ORDER_OPS.has(op)) {
    if (!(Number(cfg.amount) > 0)) throw attachCode(new Error("Amount must be a number above 0."), "MISSING_CONFIG");
    if (op === "limitOrder" && !(Number(cfg.limitPrice) > 0)) throw attachCode(new Error("Limit price must be a number above 0."), "MISSING_CONFIG");
    if (cfg.side !== "buy" && cfg.side !== "sell") throw attachCode(new Error("Side must be buy or sell."), "MISSING_CONFIG");
  }
  if ((op === "getOrder" || op === "cancelOrder") && !cfg.orderId) throw missing("Order ID");
  return RUNNERS[type](op, cfg);
}
