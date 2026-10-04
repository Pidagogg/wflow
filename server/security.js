// ============================================================================
// Security & crypto core (server-side)
// - Password hashing via scrypt (Node's crypto — no native deps)
// - AES-256-GCM encryption for storing sensitive values at rest
// - HMAC-signed random session tokens for the admin server
// - Encrypted-database key management (from env or a generated keyfile)
// ============================================================================
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const HASH_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

// ----------------------------------------------------------------------------
// Encryption key management
// ----------------------------------------------------------------------------
// The key comes from BF_ENCRYPTION_KEY. If unset, we generate one and store it
// in ./data/.secret (chmod restricted) so the encrypted DB survives restarts on
// the same machine. For a real deployment set BF_ENCRYPTION_KEY in the env and
// back it up — losing it makes the encrypted data unreadable.
export function getEncryptionKey() {
  const env = process.env.BF_ENCRYPTION_KEY;
  if (env) {
    // A 64-char hex string is a real 32-byte key — use it exactly (unchanged,
    // so existing deployments keep decrypting their data). Any other non-empty
    // value used to be fed to Buffer.from(…, "hex") blindly, which produced a
    // wrong-length key and made EVERY secret write throw "Invalid key length"
    // and hang the request. Derive a proper 32-byte key from it instead, so any
    // passphrase works. (Such instances had no decryptable data before — every
    // encrypt was failing — so nothing is broken by deriving now.)
    if (/^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, "hex");
    return crypto.createHash("sha256").update(env).digest();
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const keyFile = path.join(DATA_DIR, ".secret");
  if (fs.existsSync(keyFile)) {
    const buf = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
    if (buf.length === 32) return buf;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString("hex"), { mode: 0o600 });
  return key;
}

// ----------------------------------------------------------------------------
// Passwords — scrypt
// ----------------------------------------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = HASH_PARAMS;
  const derived = crypto.scryptSync(String(password), salt, keylen, { N, r, p });
  return `scrypt$1$${salt.toString("hex")}$${derived.toString("hex")}$N=${N},r=${r},p=${p}`;
}

export function verifyPassword(password, stored) {
  try {
    if (!stored || !stored.startsWith("scrypt$")) return false;
    const parts = stored.split("$");
    const salt = Buffer.from(parts[2], "hex");
    const expected = Buffer.from(parts[3], "hex");
    const params = parts[4] || "";
    let N = HASH_PARAMS.N, r = HASH_PARAMS.r, p = HASH_PARAMS.p;
    for (const kv of params.split(",")) {
      const [k, v] = kv.split("=");
      if (k === "N") N = Number(v);
      else if (k === "r") r = Number(v);
      else if (k === "p") p = Number(v);
    }
    const derived = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ----------------------------------------------------------------------------
// AES-256-GCM encryption for sensitive strings
// Returns "<ivHex>.<authTagHex>.<cipherHex>" or null on failure.
// ----------------------------------------------------------------------------
export function encryptText(plain, key = getEncryptionKey()) {
  if (plain === undefined || plain === null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${enc.toString("hex")}`;
}

export function decryptText(payload, key = getEncryptionKey()) {
  if (!payload) return null;
  const parts = String(payload).split(".");
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], "hex");
    const tag = Buffer.from(parts[1], "hex");
    const enc = Buffer.from(parts[2], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Session tokens
// ----------------------------------------------------------------------------
// A random token is stored (hashed) in the sessions table; the raw value is
// what the browser holds. We also HMAC-sign it so a forged cookie is rejected
// before it ever hits the DB.
export function newSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}
export function digestToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
export function signToken(token, secret) {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}
export function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}