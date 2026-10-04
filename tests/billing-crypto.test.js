// ============================================================================
// Crypto billing (NOWPayments) — unit tests for the card-free Pro checkout.
//
// No HTTP call is made: the invoice creation reaches out to NOWPayments, so it
// is exercised through the API only. What is verified here is everything that
// decides whether a payment counts:
//   - the IPN signature check (HMAC-SHA512 over the key-sorted JSON body)
//   - the account state a final IPN writes (Pro for one period)
//   - non-final / duplicate IPNs never extend the period
//   - the admin-side config: publicCryptoConfig never leaks the API key
//
// Run: node --test tests/billing-crypto.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, after } from "node:test";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Point the database at an isolated file BEFORE the server modules load it.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-crypto-"));
process.env.BF_DB_PATH = path.join(tempDir, "crypto.db");
process.env.BF_ENCRYPTION_KEY = "b".repeat(64);

const {
  verifyNowPaymentsSignature,
  isCryptoSubscriptionId,
  handleCryptoIpn,
  cryptoEnabled,
  publicCryptoConfig,
  saveCryptoConfig,
  CRYPTO_PERIOD_MS,
} = await import("../server/billing.js");
const { getSubscription } = await import("../server/db.js");

const sign = (secret, payload) => crypto.createHmac("sha512", secret).update(payload, "utf8").digest("hex");

after(() => {
  // best-effort cleanup; the isolated DB may be held briefly on Windows
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("the IPN signature is verified over the sorted-keys body", () => {
  const secret = "ipn-secret";
  const raw = JSON.stringify({ b: 2, payment_status: "finished", a: 1 });
  const sorted = JSON.stringify({ a: 1, b: 2, payment_status: "finished" });
  const signature = sign(secret, sorted);

  assert.equal(verifyNowPaymentsSignature(signature, raw, secret), true, "a genuine signature is accepted");
  assert.equal(verifyNowPaymentsSignature(signature, raw, "wrong-secret"), false, "the wrong secret is rejected");
  assert.equal(verifyNowPaymentsSignature("", raw, secret), false, "a missing signature is rejected");
  assert.equal(verifyNowPaymentsSignature("deadbeef", raw, secret), false, "a wrong signature is rejected");
});

test("a crypto subscription id is tagged so the app can tell it apart", () => {
  assert.equal(isCryptoSubscriptionId("crypto:pay_123"), true);
  assert.equal(isCryptoSubscriptionId("sub_stripe123"), false);
  assert.equal(isCryptoSubscriptionId(""), false);
  assert.equal(isCryptoSubscriptionId(null), false);
});

test("only a final IPN switches the account to Pro", async () => {
  const pending = await handleCryptoIpn({ payment_status: "waiting", order_id: "user-pending", payment_id: "pay-wait" });
  assert.equal(pending.ok, true);
  assert.match(String(pending.note || ""), /not final/i);
  assert.equal(getSubscription("user-pending").status, "");

  const noOrder = await handleCryptoIpn({ payment_status: "finished", payment_id: "pay-noorder" });
  assert.match(String(noOrder.note || ""), /order reference/i);
});

test("a finished IPN grants Pro for one period and is idempotent", async () => {
  const userId = "user-crypto-1";
  const first = await handleCryptoIpn({ payment_status: "finished", order_id: userId, payment_id: "pay-once" });
  assert.equal(first.ok, true);

  const sub = getSubscription(userId);
  assert.equal(sub.status, "active");
  assert.equal(sub.subscription_id, "crypto:pay-once");
  assert.equal(sub.price_id, "crypto");
  const periodEnd = Number(sub.current_period_end);
  assert.ok(periodEnd > Date.now(), "the period end lies in the future");
  assert.ok(periodEnd <= Date.now() + CRYPTO_PERIOD_MS + 5000, "the period end is one month out");

  // A redelivered IPN must not move the period end again.
  const again = await handleCryptoIpn({ payment_status: "confirmed", order_id: userId, payment_id: "pay-once" });
  assert.match(String(again.note || ""), /already applied/i);
  assert.equal(Number(getSubscription(userId).current_period_end), periodEnd, "the period was not extended twice");
});

test("crypto config is off by default and never echoes the API key", async () => {
  assert.equal(await cryptoEnabled(), false, "a fresh install accepts no crypto payments");

  await saveCryptoConfig({ enabled: true, apiKey: "nowpayments-live-key", priceAmount: "19.00", priceCurrency: "usd" });
  assert.equal(await cryptoEnabled(), true);

  const pub = await publicCryptoConfig();
  assert.equal(pub.enabled, true);
  assert.equal(pub.configured, true);
  assert.equal(pub.priceAmount, "19.00");
  assert.equal(pub.priceCurrency, "usd");
  assert.ok(!JSON.stringify(pub).includes("nowpayments-live-key"), "the raw API key is never sent to a browser");
  assert.match(pub.apiKeyMasked, /•/, "the key is masked");
  assert.match(pub.priceLabel, /19\.00 USD/);
});
