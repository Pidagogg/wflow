// ============================================================================
// W FLOW — on-chain wallet nodes (EVM chains and Solana)
//
// The EVM wallet reads balances and, when the user pastes a private key, sends
// native coins or ERC-20 tokens. Transactions are built, signed and broadcast
// here over plain JSON-RPC: RLP + keccak + secp256k1 from the audited
// @noble libraries, no web3 SDK. They use the legacy EIP-155 format because
// every EVM chain accepts it and it has a published test vector
// (tests/crypto-wallets.test.js checks against it).
//
// Sending moves real money, so it defaults to test mode: the transaction is
// built, gas is estimated and the balance checked, but nothing is broadcast.
// The Solana wallet is read-only.
// ============================================================================
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { attachCode } from "../shared/errors.js";

const TIMEOUT_MS = 30000;

// ---- networks ----
export const EVM_NETWORKS = {
  ethereum: { chainId: 1n, rpc: "https://ethereum-rpc.publicnode.com", coin: "ETH", explorer: "https://etherscan.io" },
  base: { chainId: 8453n, rpc: "https://base-rpc.publicnode.com", coin: "ETH", explorer: "https://basescan.org" },
  arbitrum: { chainId: 42161n, rpc: "https://arbitrum-one-rpc.publicnode.com", coin: "ETH", explorer: "https://arbiscan.io" },
  optimism: { chainId: 10n, rpc: "https://optimism-rpc.publicnode.com", coin: "ETH", explorer: "https://optimistic.etherscan.io" },
  polygon: { chainId: 137n, rpc: "https://polygon-bor-rpc.publicnode.com", coin: "POL", explorer: "https://polygonscan.com" },
  bsc: { chainId: 56n, rpc: "https://bsc-rpc.publicnode.com", coin: "BNB", explorer: "https://bscscan.com" },
};
// The official endpoint: free nodes like publicnode block getTokenAccountsByOwner.
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

// ---- errors ----
const configError = (msg) => attachCode(new Error(msg), "MISSING_CONFIG");
const chainError = (msg) => attachCode(new Error(msg), "SERVICE_ERROR");

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (res.status === 429) throw attachCode(new Error(`The RPC node rate-limited the request (HTTP 429).`), "RATE_LIMITED");
  if (res.status === 401 || res.status === 403) throw attachCode(new Error(`The RPC node refused the request (HTTP ${res.status}).`), "AUTH_FAILED");
  if (!res.ok && !data.error) throw chainError(`The RPC node returned HTTP ${res.status}. ${text.slice(0, 200)}`);
  if (data.error) throw chainError(`${method} failed: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

// ---- hex, units, RLP ----
const hexToBytes = (hex) => Uint8Array.from(Buffer.from(String(hex).replace(/^0x/, ""), "hex"));
const bytesToHex = (b) => `0x${Buffer.from(b).toString("hex")}`;
const toBig = (hex) => (hex === "0x" || !hex ? 0n : BigInt(hex));
const toQuantity = (n) => `0x${BigInt(n).toString(16)}`;

function bigToBytes(n) {
  if (n === 0n) return new Uint8Array();
  const hex = n.toString(16);
  return hexToBytes(hex.length % 2 ? `0${hex}` : hex);
}

/** "1.5" with 18 decimals → 1500000000000000000n, exactly (no floats). */
export function parseUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw configError(`Amount "${s}" is not a plain number like 0.05.`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw configError(`Amount "${s}" has more than ${decimals} decimals.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(value, decimals) {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = value / base;
  const frac = (value % base).toString().padStart(Number(d), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function rlp(item) {
  const len = (n, offset) => {
    if (n < 56) return Uint8Array.of(offset + n);
    const b = bigToBytes(BigInt(n));
    return Uint8Array.of(offset + 55 + b.length, ...b);
  };
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlp));
    return Buffer.concat([len(body.length, 0xc0), body]);
  }
  const bytes = typeof item === "bigint" ? bigToBytes(item) : item;
  if (bytes.length === 1 && bytes[0] < 0x80) return Buffer.from(bytes);
  return Buffer.concat([len(bytes.length, 0x80), bytes]);
}

// ---- keys and addresses ----
function checksum(addressHex) {
  const lower = addressHex.toLowerCase().replace(/^0x/, "");
  const hash = Buffer.from(keccak_256(lower)).toString("hex");
  return `0x${[...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

function normalizeAddress(value, label) {
  const v = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw configError(`${label} "${v}" is not an EVM address (0x followed by 40 hex characters).`);
  return checksum(v);
}

function privateKeyBytes(pk) {
  const hex = String(pk || "").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw configError("The wallet private key must be 64 hex characters (optionally starting with 0x).");
  return hexToBytes(hex);
}

export function addressFromKey(pk) {
  const pub = secp256k1.getPublicKey(privateKeyBytes(pk), false);
  return checksum(bytesToHex(keccak_256(pub.subarray(1)).subarray(-20)));
}

/** Sign a legacy EIP-155 transaction; returns the raw hex and its hash. */
export function signLegacyTx({ nonce, gasPrice, gasLimit, to, value, data = "0x", chainId }, pk) {
  const fields = [BigInt(nonce), BigInt(gasPrice), BigInt(gasLimit), hexToBytes(to), BigInt(value), hexToBytes(data)];
  const digest = keccak_256(rlp([...fields, BigInt(chainId), 0n, 0n]));
  const sig = secp256k1.sign(digest, privateKeyBytes(pk));
  const v = BigInt(chainId) * 2n + 35n + BigInt(sig.recovery);
  const raw = rlp([...fields, v, sig.r, sig.s]);
  return { raw: bytesToHex(raw), hash: bytesToHex(keccak_256(raw)) };
}

// ---- ERC-20 calls ----
const pad32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const erc20 = {
  balanceOf: (addr) => `0x70a08231${pad32(addr)}`,
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  transfer: (to, amount) => `0xa9059cbb${pad32(to)}${pad32(amount.toString(16))}`,
};

function decodeString(hex) {
  const b = Buffer.from(String(hex || "").replace(/^0x/, ""), "hex");
  if (b.length >= 64) {
    const len = Number(BigInt(`0x${b.subarray(32, 64).toString("hex")}`));
    return b.subarray(64, 64 + len).toString("utf8");
  }
  return b.toString("utf8").replace(/\0+$/, ""); // bytes32 symbols (old tokens like MKR)
}

async function tokenInfo(url, token) {
  const [dec, sym] = await Promise.all([
    rpc(url, "eth_call", [{ to: token, data: erc20.decimals }, "latest"]),
    rpc(url, "eth_call", [{ to: token, data: erc20.symbol }, "latest"]).catch(() => "0x"),
  ]);
  if (!dec || dec === "0x") throw chainError(`${token} does not look like an ERC-20 token on this network (no decimals()).`);
  return { decimals: Number(toBig(dec)), symbol: decodeString(sym) || "TOKEN" };
}

// ---- EVM wallet ----
async function resolveNetwork(cfg, assertUrl) {
  if (cfg.network === "custom") {
    if (!cfg.rpcUrl) throw configError("RPC URL is empty. Fill it in for a custom network.");
    await assertUrl(cfg.rpcUrl);
    const chainId = toBig(await rpc(cfg.rpcUrl, "eth_chainId"));
    return { chainId, rpc: cfg.rpcUrl, coin: cfg.coinSymbol || "ETH", explorer: "" };
  }
  const net = EVM_NETWORKS[cfg.network];
  if (!net) throw configError(`Unknown network "${cfg.network}".`);
  if (cfg.rpcUrl) {
    await assertUrl(cfg.rpcUrl);
    return { ...net, rpc: cfg.rpcUrl };
  }
  return net;
}

export async function runEvmWallet(cfg, { assertUrl = async () => {} } = {}) {
  const op = cfg.operation || "balance";
  const net = await resolveNetwork(cfg, assertUrl);
  const url = net.rpc;
  const txLink = (hash) => (net.explorer ? `${net.explorer}/tx/${hash}` : null);

  if (op === "txStatus") {
    const hash = String(cfg.txHash || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw configError("Transaction hash must be 0x followed by 64 hex characters.");
    const receipt = await rpc(url, "eth_getTransactionReceipt", [hash]);
    if (!receipt) {
      const tx = await rpc(url, "eth_getTransactionByHash", [hash]);
      return { hash, status: tx ? "pending" : "not found", explorerUrl: txLink(hash) };
    }
    return {
      hash,
      // Receipts from before the 2017 Byzantium fork carry no status; being mined meant success.
      status: receipt.status === "0x0" ? "failed" : "success",
      blockNumber: Number(toBig(receipt.blockNumber)),
      gasUsed: toBig(receipt.gasUsed).toString(),
      explorerUrl: txLink(hash),
    };
  }

  const from = cfg.privateKey ? addressFromKey(cfg.privateKey) : null;
  const token = cfg.tokenAddress ? normalizeAddress(cfg.tokenAddress, "Token contract") : null;

  if (op === "balance" || op === "tokenBalance") {
    const address = cfg.address ? normalizeAddress(cfg.address, "Wallet address") : from;
    if (!address) throw configError("Wallet address is empty. Enter an address, or a private key to read your own wallet.");
    if (op === "balance") {
      const wei = toBig(await rpc(url, "eth_getBalance", [address, "latest"]));
      return { address, network: cfg.network, asset: net.coin, balance: formatUnits(wei, 18), raw: wei.toString() };
    }
    if (!token) throw configError("Token contract is empty. Enter the ERC-20 contract address, e.g. USDC.");
    const [{ decimals, symbol }, bal] = await Promise.all([tokenInfo(url, token), rpc(url, "eth_call", [{ to: token, data: erc20.balanceOf(address) }, "latest"])]);
    const raw = toBig(bal);
    return { address, network: cfg.network, token, asset: symbol, balance: formatUnits(raw, decimals), raw: raw.toString() };
  }

  if (op !== "send" && op !== "sendToken") throw configError(`Unknown operation "${op}".`);
  if (!cfg.privateKey) throw configError("Wallet private key is empty. Sending needs the key of the wallet that pays.");
  const to = normalizeAddress(cfg.to, "Recipient");
  if (!String(cfg.amount || "").trim()) throw configError("Amount is empty.");

  let tx;
  let asset;
  let amount;
  if (op === "send") {
    amount = parseUnits(cfg.amount, 18);
    asset = net.coin;
    tx = { from, to, value: toQuantity(amount), data: "0x" };
  } else {
    if (!token) throw configError("Token contract is empty. Enter the ERC-20 contract address, e.g. USDC.");
    const info = await tokenInfo(url, token);
    amount = parseUnits(cfg.amount, info.decimals);
    asset = info.symbol;
    const bal = toBig(await rpc(url, "eth_call", [{ to: token, data: erc20.balanceOf(from) }, "latest"]));
    if (bal < amount) throw chainError(`Not enough ${asset}: the wallet holds ${formatUnits(bal, info.decimals)}, the transfer needs ${cfg.amount}.`);
    tx = { from, to: token, value: "0x0", data: erc20.transfer(to, amount) };
  }
  if (!(amount > 0n)) throw configError("Amount must be above 0.");

  // Balance first: estimating gas for a transfer the wallet can't cover fails
  // with a cryptic RPC error instead of a useful one.
  const balance = toBig(await rpc(url, "eth_getBalance", [from, "latest"]));
  if (balance < toBig(tx.value)) {
    throw chainError(`Not enough ${net.coin}: the wallet holds ${formatUnits(balance, 18)}, the transfer needs ${cfg.amount} plus the fee.`);
  }
  const [nonceHex, gasPriceHex, gasHex] = await Promise.all([
    rpc(url, "eth_getTransactionCount", [from, "pending"]),
    rpc(url, "eth_gasPrice"),
    rpc(url, "eth_estimateGas", [tx]),
  ]);
  // A little headroom so a slightly busier next block doesn't strand the transaction.
  const gasPrice = (toBig(gasPriceHex) * 12n) / 10n;
  const gasLimit = op === "send" ? toBig(gasHex) : (toBig(gasHex) * 12n) / 10n;
  const maxFee = gasPrice * gasLimit;
  const needed = maxFee + toBig(tx.value);
  const summary = {
    network: cfg.network,
    from,
    to,
    asset,
    amount: String(cfg.amount).trim(),
    maxFee: formatUnits(maxFee, 18),
    feeAsset: net.coin,
  };
  if (balance < needed) {
    throw chainError(`Not enough ${net.coin} for this transaction: the wallet holds ${formatUnits(balance, 18)}, it needs up to ${formatUnits(needed, 18)} including the fee.`);
  }
  if (cfg.testMode) return { test: true, ...summary, note: "Test mode: the transaction was checked but not sent." };

  const signed = signLegacyTx({ nonce: toBig(nonceHex), gasPrice, gasLimit, to: tx.to, value: toBig(tx.value), data: tx.data, chainId: net.chainId }, cfg.privateKey);
  const hash = await rpc(url, "eth_sendRawTransaction", [signed.raw]);
  return { test: false, ...summary, hash: hash || signed.hash, status: "pending", explorerUrl: txLink(hash || signed.hash) };
}

// ---- Solana wallet (read-only) ----
const SPL_TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

export async function runSolanaWallet(cfg, { assertUrl = async () => {} } = {}) {
  const op = cfg.operation || "balance";
  const url = cfg.rpcUrl || SOLANA_RPC;
  if (cfg.rpcUrl) await assertUrl(cfg.rpcUrl);
  if (op === "txStatus") {
    const sig = String(cfg.txHash || "").trim();
    if (!sig) throw configError("Transaction signature is empty.");
    const r = await rpc(url, "getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
    const s = r?.value?.[0];
    return { signature: sig, status: !s ? "not found" : s.err ? "failed" : s.confirmationStatus || "processed", slot: s?.slot ?? null, explorerUrl: `https://solscan.io/tx/${sig}` };
  }
  const address = String(cfg.address || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw configError(`Wallet address "${address}" is not a Solana address.`);
  if (op === "balance") {
    const r = await rpc(url, "getBalance", [address]);
    const lamports = BigInt(r?.value ?? 0);
    return { address, asset: "SOL", balance: formatUnits(lamports, 9), raw: lamports.toString() };
  }
  if (op === "tokenBalances") {
    const lists = await Promise.all(
      SPL_TOKEN_PROGRAMS.map((programId) => rpc(url, "getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed" }]))
    );
    return lists
      .flatMap((r) => r?.value || [])
      .map((a) => a.account?.data?.parsed?.info)
      .filter((info) => info && Number(info.tokenAmount?.amount) > 0)
      .map((info) => ({ mint: info.mint, balance: info.tokenAmount.uiAmountString, decimals: info.tokenAmount.decimals }));
  }
  throw configError(`Unknown operation "${op}".`);
}
