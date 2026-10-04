// ============================================================================
// Wallet nodes (EVM + Solana) — transaction signing against the published
// EIP-155 test vector, exact unit maths, and the send flow (test mode, balance
// checks, broadcast) against a scripted JSON-RPC node.
//
// Run: node --test tests/crypto-wallets.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3";
import { runEvmWallet, runSolanaWallet, signLegacyTx, addressFromKey, parseUnits, formatUnits } from "../server/crypto-wallets.js";
import { ERROR_CODES } from "../shared/errors.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The key and transaction from the EIP-155 specification.
const EIP155_KEY = `0x${"46".repeat(32)}`;
const EIP155_ADDRESS = "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F";
const RECIPIENT = "0x3535353535353535353535353535353535353535";

let calls = [];
/** Answer JSON-RPC calls from a { method: result | (params) => result } table. */
function rpcNode(table) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url: String(url), method, params });
    const entry = table[method];
    if (entry === undefined) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `no stub for ${method}` } }));
    const result = typeof entry === "function" ? entry(params) : entry;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  };
}

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const ONE_ETH = 10n ** 18n;

// ---- signing ----
test("legacy transactions match the EIP-155 test vector byte for byte", () => {
  const { raw } = signLegacyTx({ nonce: 9n, gasPrice: 20000000000n, gasLimit: 21000n, to: RECIPIENT, value: ONE_ETH, data: "0x", chainId: 1n }, EIP155_KEY);
  assert.equal(
    raw,
    "0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83"
  );
});

test("addresses come out EIP-55 checksummed", () => {
  assert.equal(addressFromKey(EIP155_KEY), EIP155_ADDRESS);
  assert.equal(addressFromKey(EIP155_KEY.slice(2)), EIP155_ADDRESS, "the 0x prefix is optional");
});

test("amounts convert exactly, without floating point", () => {
  assert.equal(parseUnits("0.1", 18), 100000000000000000n);
  assert.equal(parseUnits("25", 6), 25000000n);
  assert.equal(formatUnits(123456789n, 6), "123.456789");
  assert.equal(formatUnits(10n ** 18n, 18), "1");
  assert.throws(() => parseUnits("1.0000001", 6), /more than 6 decimals/);
  assert.throws(() => parseUnits("1e5", 18), /plain number/);
});

// ---- reads ----
test("balance reads any address without a key", async () => {
  rpcNode({ eth_getBalance: hex(15n * 10n ** 17n) });
  const r = await runEvmWallet({ operation: "balance", network: "base", address: RECIPIENT.toLowerCase() });
  assert.equal(r.balance, "1.5");
  assert.equal(r.asset, "ETH");
  assert.equal(r.address, RECIPIENT, "the address is checksummed in the result");
  assert.match(calls[0].url, /base-rpc/);
});

test("token balance uses the token's own decimals and symbol", async () => {
  const symbol = "0x" + "20".padStart(64, "0") + "4".padStart(64, "0") + Buffer.from("USDC").toString("hex").padEnd(64, "0");
  rpcNode({
    eth_call: ([call]) => (call.data === "0x313ce567" ? hex(6) : call.data === "0x95d89b41" ? symbol : hex(42500000)),
  });
  const r = await runEvmWallet({ operation: "tokenBalance", network: "ethereum", address: RECIPIENT, tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" });
  assert.equal(r.balance, "42.5");
  assert.equal(r.asset, "USDC");
});

test("a missing address or key is a configuration error before any request", async () => {
  rpcNode({});
  await assert.rejects(runEvmWallet({ operation: "balance", network: "ethereum" }), (e) => e._bfCode === ERROR_CODES.MISSING_CONFIG.code);
  await assert.rejects(runEvmWallet({ operation: "send", network: "ethereum", to: RECIPIENT, amount: "1" }), /private key is empty/);
  await assert.rejects(runEvmWallet({ operation: "balance", network: "ethereum", address: "0x123" }), /not an EVM address/);
  assert.equal(calls.length, 0);
});

// ---- sending ----
const funded = (balance) => ({
  eth_getBalance: hex(balance),
  eth_getTransactionCount: hex(7),
  eth_gasPrice: hex(10n ** 9n),
  eth_estimateGas: hex(21000),
  eth_sendRawTransaction: (params) => `0x${Buffer.from(keccak_256(Buffer.from(params[0].slice(2), "hex"))).toString("hex")}`,
});

test("test mode checks the transfer and its fee but never broadcasts", async () => {
  rpcNode(funded(ONE_ETH));
  const r = await runEvmWallet({ operation: "send", network: "ethereum", to: RECIPIENT, amount: "0.25", privateKey: EIP155_KEY, testMode: true });
  assert.equal(r.test, true);
  assert.equal(r.from, EIP155_ADDRESS);
  assert.equal(r.maxFee, "0.0000252", "21000 gas at 1.2 gwei");
  assert.ok(!calls.some((c) => c.method === "eth_sendRawTransaction"));
});

test("sending refuses when the wallet can't cover the amount plus the fee", async () => {
  rpcNode(funded(ONE_ETH / 4n));
  await assert.rejects(
    runEvmWallet({ operation: "send", network: "ethereum", to: RECIPIENT, amount: "0.25", privateKey: EIP155_KEY, testMode: false }),
    /Not enough ETH .* including the fee/
  );
  assert.ok(!calls.some((c) => c.method === "eth_sendRawTransaction"));
});

test("a real send broadcasts a transaction signed by the wallet, for the right chain", async () => {
  rpcNode(funded(ONE_ETH));
  const r = await runEvmWallet({ operation: "send", network: "polygon", to: RECIPIENT, amount: "0.5", privateKey: EIP155_KEY, testMode: false });
  const raw = calls.find((c) => c.method === "eth_sendRawTransaction").params[0];
  assert.equal(r.test, false);
  assert.equal(r.status, "pending");
  assert.match(r.explorerUrl, /^https:\/\/polygonscan\.com\/tx\/0x/);
  // Signing is deterministic (RFC 6979), so the broadcast bytes must equal the
  // expected transaction: pending nonce 7, gas price 1 gwei + 20 %, Polygon's
  // chain id 137. The signer itself is covered by the EIP-155 vector above.
  const expected = signLegacyTx({ nonce: 7n, gasPrice: 1200000000n, gasLimit: 21000n, to: RECIPIENT, value: ONE_ETH / 2n, data: "0x", chainId: 137n }, EIP155_KEY);
  assert.equal(raw, expected.raw);
  assert.equal(r.hash, expected.hash);
  assert.equal(calls.find((c) => c.method === "eth_getTransactionCount").params[1], "pending");
});

test("token transfers encode transfer(to, amount) and check the token balance first", async () => {
  const table = {
    ...funded(ONE_ETH),
    eth_estimateGas: hex(50000),
    eth_call: ([call]) => (call.data === "0x313ce567" ? hex(6) : call.data === "0x95d89b41" ? "0x" : hex(5_000_000)),
  };
  rpcNode(table);
  await assert.rejects(
    runEvmWallet({ operation: "sendToken", network: "base", tokenAddress: RECIPIENT, to: EIP155_ADDRESS, amount: "10", privateKey: EIP155_KEY, testMode: true }),
    /Not enough TOKEN: the wallet holds 5, the transfer needs 10/
  );
  rpcNode(table);
  const r = await runEvmWallet({ operation: "sendToken", network: "base", tokenAddress: RECIPIENT, to: EIP155_ADDRESS, amount: "2.5", privateKey: EIP155_KEY, testMode: true });
  const estimate = calls.find((c) => c.method === "eth_estimateGas").params[0];
  assert.equal(estimate.to, RECIPIENT, "the transaction goes to the token contract");
  assert.equal(estimate.data, `0xa9059cbb${EIP155_ADDRESS.slice(2).toLowerCase().padStart(64, "0")}${(2_500_000).toString(16).padStart(64, "0")}`);
  assert.equal(r.test, true);
});

test("transaction status reads the receipt", async () => {
  const hash = `0x${"ab".repeat(32)}`;
  rpcNode({ eth_getTransactionReceipt: { status: "0x0", blockNumber: "0x10", gasUsed: "0x5208" } });
  assert.equal((await runEvmWallet({ operation: "txStatus", network: "ethereum", txHash: hash })).status, "failed");
  rpcNode({ eth_getTransactionReceipt: null, eth_getTransactionByHash: { hash } });
  assert.equal((await runEvmWallet({ operation: "txStatus", network: "ethereum", txHash: hash })).status, "pending");
});

test("a custom network reads its chain id from the RPC node and passes the URL guard", async () => {
  const guarded = [];
  rpcNode({ eth_chainId: "0x2a", eth_getBalance: hex(0) });
  await runEvmWallet({ operation: "balance", network: "custom", rpcUrl: "https://rpc.example.org", coinSymbol: "XYZ", address: RECIPIENT }, { assertUrl: async (u) => guarded.push(u) });
  assert.deepEqual(guarded, ["https://rpc.example.org"]);
  assert.equal(calls[0].method, "eth_chainId");
});

// ---- Solana ----
test("Solana balances are read in SOL and token accounts are merged across both token programs", async () => {
  rpcNode({
    getBalance: { value: 2_500_000_000 },
    getTokenAccountsByOwner: ([, { programId }]) => ({
      value: [
        { account: { data: { parsed: { info: { mint: `mint-${programId.slice(0, 5)}`, tokenAmount: { amount: "1000", uiAmountString: "1", decimals: 3 } } } } } },
        { account: { data: { parsed: { info: { mint: "empty", tokenAmount: { amount: "0", uiAmountString: "0", decimals: 3 } } } } } },
      ],
    }),
  });
  const address = "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg";
  assert.equal((await runSolanaWallet({ operation: "balance", address })).balance, "2.5");
  const tokens = await runSolanaWallet({ operation: "tokenBalances", address });
  assert.deepEqual(tokens.map((t) => t.mint).sort(), ["mint-Token", "mint-Token"].sort());
  await assert.rejects(runSolanaWallet({ operation: "balance", address: "0xnot-solana" }), /not a Solana address/);
});
