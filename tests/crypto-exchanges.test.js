// ============================================================================
// Crypto exchange nodes (Coinbase, Binance, Kraken, Bybit, OKX, KuCoin) — request signing, test
// mode, response normalisation and error classification, against a scripted
// fetch so no exchange is contacted.
//
// Run: node --test tests/crypto-exchanges.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createHash, createHmac, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { runExchange } from "../server/crypto-exchanges.js";
import { ERROR_CODES } from "../shared/errors.js";
import { NODES } from "../shared/catalog.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let calls = [];
function script(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: new URL(String(url)), init };
    calls.push(call);
    const [status, body] = handler(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

const base = { symbol: "", side: "buy", amount: "", amountIn: "base", limitPrice: "", testMode: true, orderId: "", apiKey: "", secret: "", passphrase: "", baseUrl: "https://api.binance.com" };
const EXCHANGES = ["coinbaseExchange", "binanceExchange", "krakenExchange", "bybitExchange", "okxExchange", "kucoinExchange"];
const cfg = (extra) => ({ ...base, ...extra });

// ---- catalog ----
test("every exchange node shares one layout and defaults to a keyless price lookup", () => {
  for (const type of EXCHANGES) {
    const def = NODES[type];
    assert.equal(def.defaults.operation, "price");
    assert.equal(def.defaults.testMode, true, `${type} must default to test mode`);
    assert.ok(def.fields.some((f) => f.key === "apiKey" && f.type === "secret"));
    assert.ok(def.fields.some((f) => f.key === "secret" && f.type === "secret"));
  }
});

// ---- validation ----
test("private operations refuse to run without a key, before any request", async () => {
  script(() => [200, {}]);
  for (const type of EXCHANGES) {
    await assert.rejects(runExchange(type, cfg({ operation: "balances" })), (e) => e._bfCode === ERROR_CODES.MISSING_CONFIG.code && /API key is empty/.test(e.message));
  }
  assert.equal(calls.length, 0);
});

test("orders need a positive amount, a limit price and a valid side", async () => {
  script(() => [200, {}]);
  const keys = { apiKey: "k", secret: Buffer.from("s").toString("base64"), symbol: "BTCUSDT" };
  await assert.rejects(runExchange("binanceExchange", cfg({ ...keys, operation: "marketOrder", amount: "0" })), /Amount/);
  await assert.rejects(runExchange("binanceExchange", cfg({ ...keys, operation: "limitOrder", amount: "1" })), /Limit price/);
  await assert.rejects(runExchange("binanceExchange", cfg({ ...keys, operation: "marketOrder", amount: "1", side: "hold" })), /Side/);
  assert.equal(calls.length, 0);
});

// ---- Binance ----
test("Binance price is normalised from the 24h ticker", async () => {
  script(() => [200, { symbol: "BTCUSDT", lastPrice: "65000.5", priceChangePercent: "-1.2", highPrice: "66000", lowPrice: "64000", volume: "10" }]);
  const r = await runExchange("binanceExchange", cfg({ operation: "price", symbol: "btc-usdt" }));
  assert.equal(calls[0].url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(r.price, 65000.5);
  assert.equal(r.change24h, -1.2);
});

test("Binance signs the query with HMAC-SHA256 and uses /order/test in test mode", async () => {
  script(() => [200, {}]);
  const r = await runExchange("binanceExchange", cfg({ operation: "marketOrder", symbol: "BTCUSDT", amount: "25", amountIn: "quote", apiKey: "key-1", secret: "shh" }));
  const { url, init } = calls[0];
  assert.equal(url.pathname, "/api/v3/order/test");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-MBX-APIKEY"], "key-1");
  assert.equal(url.searchParams.get("quoteOrderQty"), "25");
  const signature = url.searchParams.get("signature");
  const unsigned = url.search.slice(1).replace(/&signature=[0-9a-f]+$/, "");
  assert.equal(signature, createHmac("sha256", "shh").update(unsigned).digest("hex"));
  assert.equal(r.test, true);
});

test("Binance places a real limit order only with test mode off", async () => {
  script(() => [200, { orderId: 42, status: "NEW" }]);
  const r = await runExchange("binanceExchange", cfg({ operation: "limitOrder", symbol: "BTCUSDT", amount: "0.01", limitPrice: "50000", side: "sell", testMode: false, apiKey: "k", secret: "s" }));
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.pathname, "/api/v3/order");
  assert.equal(q.get("type"), "LIMIT");
  assert.equal(q.get("side"), "SELL");
  assert.equal(q.get("price"), "50000");
  assert.equal(q.get("timeInForce"), "GTC");
  assert.equal(r.orderId, 42);
});

test("Binance key errors are classified as authentication failures", async () => {
  script(() => [400, { code: -2014, msg: "API-key format invalid." }]);
  await assert.rejects(runExchange("binanceExchange", cfg({ operation: "balances", apiKey: "k", secret: "s" })), (e) => e._bfCode === ERROR_CODES.AUTH_FAILED.code);
});

test("Binance balances drop empty assets", async () => {
  script(() => [200, { balances: [{ asset: "BTC", free: "0.5", locked: "0" }, { asset: "ETH", free: "0", locked: "0" }] }]);
  const r = await runExchange("binanceExchange", cfg({ operation: "balances", apiKey: "k", secret: "s" }));
  assert.deepEqual(r, [{ asset: "BTC", available: 0.5, locked: 0 }]);
});

// ---- Kraken ----
test("Kraken signs path + SHA256(nonce + body) with HMAC-SHA512 and validates in test mode", async () => {
  script(() => [200, { error: [], result: { descr: { order: "buy 0.01 XBTUSD @ market" } } }]);
  const secret = Buffer.from("kraken-secret-bytes").toString("base64");
  const r = await runExchange("krakenExchange", cfg({ operation: "marketOrder", symbol: "XBT/USD", amount: "0.01", apiKey: "kk", secret }));
  const { url, init } = calls[0];
  assert.equal(url.pathname, "/0/private/AddOrder");
  const form = new URLSearchParams(init.body);
  assert.equal(form.get("validate"), "true");
  assert.equal(form.get("pair"), "XBTUSD");
  const digest = createHash("sha256").update(form.get("nonce") + init.body).digest();
  const expected = createHmac("sha512", Buffer.from(secret, "base64")).update(Buffer.concat([Buffer.from("/0/private/AddOrder"), digest])).digest("base64");
  assert.equal(init.headers["API-Sign"], expected);
  assert.equal(init.headers["API-Key"], "kk");
  assert.equal(r.test, true);
  assert.equal(r.description, "buy 0.01 XBTUSD @ market");
});

test("Kraken nonces always increase", async () => {
  script(() => [200, { error: [], result: {} }]);
  const c = cfg({ operation: "balances", apiKey: "k", secret: "c2VjcmV0" });
  await runExchange("krakenExchange", c);
  await runExchange("krakenExchange", c);
  const [a, b] = calls.map((x) => Number(new URLSearchParams(x.init.body).get("nonce")));
  assert.ok(b > a);
});

test("Kraken errors inside a 200 response are raised and classified", async () => {
  script(() => [200, { error: ["EAPI:Invalid key"] }]);
  await assert.rejects(runExchange("krakenExchange", cfg({ operation: "balances", apiKey: "k", secret: "c2VjcmV0" })), /rejected the API key/);
  script(() => [200, { error: ["EOrder:Insufficient funds"] }]);
  await assert.rejects(runExchange("krakenExchange", cfg({ operation: "marketOrder", symbol: "XBTUSD", amount: "1", testMode: false, apiKey: "k", secret: "c2VjcmV0" })), /Insufficient funds/);
});

test("Kraken price reports the change since today's open", async () => {
  script(() => [200, { error: [], result: { XXBTZUSD: { c: ["110", "1"], o: "100", h: ["0", "120"], l: ["0", "90"], v: ["0", "5"] } } }]);
  const r = await runExchange("krakenExchange", cfg({ operation: "price", symbol: "XBTUSD" }));
  assert.equal(r.price, 110);
  assert.equal(r.change24h, 10);
  assert.equal(r.high24h, 120);
});

test("Kraken balances subtract what is held in open orders", async () => {
  script(() => [200, { error: [], result: { XXBT: { balance: "1.5", hold_trade: "0.5" }, ZUSD: { balance: "0", hold_trade: "0" } } }]);
  const r = await runExchange("krakenExchange", cfg({ operation: "balances", apiKey: "k", secret: "c2VjcmV0" }));
  assert.deepEqual(r, [{ asset: "XXBT", available: 1, locked: 0.5 }]);
});

// ---- Coinbase ----
function decodeJwt(auth) {
  const [h, p, s] = auth.replace(/^Bearer /, "").split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url")), payload: JSON.parse(Buffer.from(p, "base64url")), input: `${h}.${p}`, sig: Buffer.from(s, "base64url") };
}

test("Coinbase signs an ES256 JWT for the exact method and path, even from a flattened PEM", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "sec1", format: "pem" });
  const flattened = pem.replace(/\n/g, " ");
  script(() => [200, { accounts: [{ currency: "BTC", available_balance: { value: "0.2" }, hold: { value: "0" } }, { currency: "ETH", available_balance: { value: "0" }, hold: { value: "0" } }] }]);
  const r = await runExchange("coinbaseExchange", cfg({ operation: "balances", apiKey: "organizations/o/apiKeys/k", secret: flattened }));
  const jwt = decodeJwt(calls[0].init.headers.Authorization);
  assert.equal(jwt.header.alg, "ES256");
  assert.equal(jwt.header.kid, "organizations/o/apiKeys/k");
  assert.equal(jwt.payload.iss, "cdp");
  assert.equal(jwt.payload.uri, "GET api.coinbase.com/api/v3/brokerage/accounts");
  assert.ok(verify("sha256", Buffer.from(jwt.input), { key: publicKey, dsaEncoding: "ieee-p1363" }, jwt.sig));
  assert.deepEqual(r, [{ asset: "BTC", available: 0.2, locked: 0 }]);
});

test("Coinbase accepts a base64 Ed25519 key and previews orders in test mode", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  script(() => [200, { order_total: "25" }]);
  const r = await runExchange("coinbaseExchange", cfg({ operation: "marketOrder", symbol: "BTC-USD", amount: "25", amountIn: "quote", apiKey: "key", secret: Buffer.concat([seed, pub]).toString("base64") }));
  const { url, init } = calls[0];
  assert.equal(url.pathname, "/api/v3/brokerage/orders/preview");
  const body = JSON.parse(init.body);
  assert.deepEqual(body.order_configuration, { market_market_ioc: { quote_size: "25" } });
  assert.equal(body.client_order_id, undefined);
  const jwt = decodeJwt(init.headers.Authorization);
  assert.equal(jwt.header.alg, "EdDSA");
  assert.ok(verify(null, Buffer.from(jwt.input), createPublicKey(privateKey), jwt.sig));
  assert.equal(r.test, true);
});

test("Coinbase price needs no key and sends no Authorization header", async () => {
  script(() => [200, { product_id: "ETH-EUR", price: "3000", price_percentage_change_24h: "2" }]);
  const r = await runExchange("coinbaseExchange", cfg({ operation: "price", symbol: "ETH-EUR" }));
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(r.price, 3000);
  assert.equal(r.change24h, 2);
});

test("Coinbase reports a refused order as an error", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  script(() => [200, { success: false, error_response: { message: "Insufficient balance" } }]);
  await assert.rejects(
    runExchange("coinbaseExchange", cfg({ operation: "limitOrder", symbol: "BTC-USD", amount: "1", limitPrice: "10", testMode: false, apiKey: "k", secret: privateKey.export({ type: "sec1", format: "pem" }) })),
    /Insufficient balance/
  );
  assert.ok(JSON.parse(calls[0].init.body).client_order_id, "real orders carry a client_order_id");
});

// ---- Bybit ----
test("Bybit signs timestamp + key + recvWindow + query and turns the fractional change into percent", async () => {
  script(() => [200, { retCode: 0, result: { list: [{ symbol: "BTCUSDT", lastPrice: "100", price24hPcnt: "0.0125" }] } }]);
  const price = await runExchange("bybitExchange", cfg({ operation: "price", symbol: "BTC/USDT", baseUrl: "https://api.bybit.com" }));
  assert.equal(price.change24h, 1.25);
  assert.equal(calls[0].init.headers["X-BAPI-SIGN"], undefined, "public calls are not signed");

  script(() => [200, { retCode: 0, result: { list: [{ coin: [{ coin: "USDT", walletBalance: "10", locked: "4" }, { coin: "BTC", walletBalance: "0", locked: "0" }] }] } }]);
  const r = await runExchange("bybitExchange", cfg({ operation: "balances", apiKey: "bk", secret: "bs", baseUrl: "https://api.bybit.com" }));
  const h = calls[0].init.headers;
  const query = calls[0].url.search.slice(1);
  assert.equal(h["X-BAPI-SIGN"], createHmac("sha256", "bs").update(h["X-BAPI-TIMESTAMP"] + "bk" + "5000" + query).digest("hex"));
  assert.deepEqual(r, [{ asset: "USDT", available: 6, locked: 4 }]);
});

test("Bybit test mode checks the key and returns the order without creating it", async () => {
  script(() => [200, { retCode: 0, result: { list: [{ coin: [] }] } }]);
  const r = await runExchange("bybitExchange", cfg({ operation: "marketOrder", symbol: "BTCUSDT", amount: "20", amountIn: "quote", apiKey: "k", secret: "s", baseUrl: "https://api.bybit.com" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v5/account/wallet-balance");
  assert.equal(r.test, true);
  assert.deepEqual(r.wouldSend, { category: "spot", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty: "20", marketUnit: "quoteCoin" });
});

test("Bybit signs the JSON body of a real order and maps retCode errors", async () => {
  script(() => [200, { retCode: 0, result: { orderId: "b-1" } }]);
  const r = await runExchange("bybitExchange", cfg({ operation: "limitOrder", symbol: "BTCUSDT", amount: "0.1", limitPrice: "50000", testMode: false, apiKey: "k", secret: "s", baseUrl: "https://api.bybit.com" }));
  const { init } = calls[0];
  assert.equal(init.headers["X-BAPI-SIGN"], createHmac("sha256", "s").update(init.headers["X-BAPI-TIMESTAMP"] + "k" + "5000" + init.body).digest("hex"));
  assert.equal(JSON.parse(init.body).price, "50000");
  assert.equal(r.orderId, "b-1");

  script(() => [200, { retCode: 10003, retMsg: "API key is invalid." }]);
  await assert.rejects(runExchange("bybitExchange", cfg({ operation: "balances", apiKey: "k", secret: "s", baseUrl: "https://api.bybit.com" })), (e) => e._bfCode === ERROR_CODES.AUTH_FAILED.code);
  script(() => [200, { retCode: 170131, retMsg: "Insufficient balance." }]);
  await assert.rejects(runExchange("bybitExchange", cfg({ operation: "marketOrder", symbol: "BTCUSDT", amount: "1", testMode: false, apiKey: "k", secret: "s", baseUrl: "https://api.bybit.com" })), /Insufficient balance/);
});

// ---- OKX ----
test("OKX needs a passphrase and signs timestamp + method + path + body in base64", async () => {
  script(() => [200, { code: "0", data: [] }]);
  await assert.rejects(runExchange("okxExchange", cfg({ operation: "balances", apiKey: "k", secret: "s" })), /passphrase/);
  assert.equal(calls.length, 0);

  script(() => [200, { code: "0", data: [{ ordId: "o-1", sCode: "0" }] }]);
  const r = await runExchange("okxExchange", cfg({ operation: "marketOrder", symbol: "btc/usdt", amount: "0.01", testMode: false, apiKey: "k", secret: "s", passphrase: "pp" }));
  const { url, init } = calls[0];
  const h = init.headers;
  assert.equal(h["OK-ACCESS-PASSPHRASE"], "pp");
  assert.equal(h["OK-ACCESS-SIGN"], createHmac("sha256", "s").update(h["OK-ACCESS-TIMESTAMP"] + "POST" + url.pathname + init.body).digest("base64"));
  const body = JSON.parse(init.body);
  assert.equal(body.instId, "BTC-USDT");
  assert.equal(body.tgtCcy, "base_ccy", "a market buy must say its size is in the base coin");
  assert.equal(r.orderId, "o-1");
});

test("OKX reports per-order failures and key errors", async () => {
  script(() => [200, { code: "1", msg: "", data: [{ sCode: "51008", sMsg: "Insufficient balance" }] }]);
  await assert.rejects(runExchange("okxExchange", cfg({ operation: "marketOrder", symbol: "BTC-USDT", amount: "1", testMode: false, apiKey: "k", secret: "s", passphrase: "p" })), /Insufficient balance/);
  script(() => [401, { code: "50111", msg: "Invalid OK-ACCESS-KEY" }]);
  await assert.rejects(runExchange("okxExchange", cfg({ operation: "balances", apiKey: "k", secret: "s", passphrase: "p" })), (e) => e._bfCode === ERROR_CODES.AUTH_FAILED.code);
});

// ---- KuCoin ----
test("KuCoin signs the request and the passphrase, and uses the test endpoint in test mode", async () => {
  script(() => [200, { code: "200000", data: { orderId: "k-1" } }]);
  const r = await runExchange("kucoinExchange", cfg({ operation: "marketOrder", symbol: "BTC-USDT", amount: "15", amountIn: "quote", apiKey: "k", secret: "s", passphrase: "pp" }));
  const { url, init } = calls[0];
  const h = init.headers;
  const sig = (text) => createHmac("sha256", "s").update(text).digest("base64");
  assert.equal(url.pathname, "/api/v1/hf/orders/test");
  assert.equal(h["KC-API-SIGN"], sig(h["KC-API-TIMESTAMP"] + "POST" + url.pathname + init.body));
  assert.equal(h["KC-API-PASSPHRASE"], sig("pp"));
  assert.equal(h["KC-API-KEY-VERSION"], "2");
  assert.equal(JSON.parse(init.body).funds, "15");
  assert.equal(r.test, true);
});

test("KuCoin needs the pair to list open orders and signs query strings", async () => {
  script(() => [200, { code: "200000", data: [] }]);
  await assert.rejects(runExchange("kucoinExchange", cfg({ operation: "openOrders", apiKey: "k", secret: "s", passphrase: "p" })), /Trading pair/);
  await runExchange("kucoinExchange", cfg({ operation: "cancelOrder", symbol: "BTC-USDT", orderId: "abc", apiKey: "k", secret: "s", passphrase: "p" }));
  const { url, init } = calls[0];
  assert.equal(init.method, "DELETE");
  assert.equal(init.headers["KC-API-SIGN"], createHmac("sha256", "s").update(init.headers["KC-API-TIMESTAMP"] + "DELETE" + url.pathname + url.search).digest("base64"));
  script(() => [200, { code: "400005", msg: "Invalid KC-API-SIGN" }]);
  await assert.rejects(runExchange("kucoinExchange", cfg({ operation: "balances", apiKey: "k", secret: "s", passphrase: "p" })), (e) => e._bfCode === ERROR_CODES.AUTH_FAILED.code);
});
