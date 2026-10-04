// ============================================================================
// W FLOW — Stripe billing.
//
// A paid subscription (flat €9.99 / month) is bought on the main site through
// Stripe Checkout. This module is intentionally dependency-free for the Stripe
// API (we POST to api.stripe.com with fetch, exactly like the executor does for
// its Stripe / other network nodes — no `stripe` npm package needed) and only
// uses Node's built-in crypto for webhook signature verification.
//
// Configuration lives in the shared SQL database (settings table) so the admin
// panel can wire it up without touching .env or the code — see the admin
// "Billing (Stripe)" tab. Secret keys are stored encrypted at rest; each value
// also falls back to its environment variable when not set in the DB:
//   STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET,
//   STRIPE_PRICE_ID, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL
// ============================================================================
import crypto from "node:crypto";
import { db } from "./dbx.js"; // facade: SQLite by default, Postgres when DATABASE_URL is set

const STRIPE_API = "https://api.stripe.com/v1";

// Stripe config keys namespaced in the settings table (secret values encrypted).
const KEYS = {
  secretKey: "stripe.secretKey",
  publishableKey: "stripe.publishableKey",
  webhookSecret: "stripe.webhookSecret",
  priceId: "stripe.priceId",
  successUrl: "stripe.successUrl",
  cancelUrl: "stripe.cancelUrl",
};

// Whether the operator accepts Pro subscriptions right now. A fresh install
// starts with sales CLOSED: every account is on the free plan automatically
// and the subscription page tells users Pro opens next month. The admin panel
// (Billing tab) flips this on with one toggle when the launch month is over.
const SALES_OPEN_KEY = "billing.salesOpen";

export async function salesOpen() {
  try {
    const v = await db.storeGet(SALES_OPEN_KEY);
    return v === "1" || v === "true";
  } catch {
    return false; // DB hiccup must never open sales by accident
  }
}

export function defaultPriceLabel() {
  return "€9.99 / month";
}

// Whether an active subscription is set to end at the current period end
// (Stripe's cancel_at_period_end). Kept in the settings store keyed by account
// so the subscription page can say “cancels on <date>” without a schema
// migration; Stripe remains the source of truth and overwrites it via webhook.
const CANCEL_AT_PERIOD_END_KEY = (userId) => `billing.cancelAtPeriodEnd.${String(userId || "")}`;

export async function getCancelAtPeriodEnd(userId) {
  try {
    return (await db.storeGet(CANCEL_AT_PERIOD_END_KEY(userId))) === "1";
  } catch {
    return false;
  }
}

export async function setCancelAtPeriodEnd(userId, value) {
  try {
    await db.storeSet(CANCEL_AT_PERIOD_END_KEY(userId), value ? "1" : "0");
  } catch {
    /* a failed flag write must never break billing */
  }
}

// Read the current Stripe configuration (DB settings, with env fallbacks).
// Secrets are read from their (encrypted) DB row; never logs or echoes values.
export async function stripeConfig() {
  const [secretKey, publishableKey, webhookSecret, priceId, successUrl, cancelUrl] = await Promise.all([
    db.storeGet(KEYS.secretKey),
    db.storeGet(KEYS.publishableKey),
    db.storeGet(KEYS.webhookSecret),
    db.storeGet(KEYS.priceId),
    db.storeGet(KEYS.successUrl),
    db.storeGet(KEYS.cancelUrl),
  ]);
  return {
    secretKey: secretKey || process.env.STRIPE_SECRET_KEY || "",
    publishableKey: publishableKey || process.env.STRIPE_PUBLISHABLE_KEY || "",
    webhookSecret: webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || "",
    priceId: priceId || process.env.STRIPE_PRICE_ID || "",
    successUrl: successUrl || process.env.STRIPE_SUCCESS_URL || "",
    cancelUrl: cancelUrl || process.env.STRIPE_CANCEL_URL || "",
  };
}

// Save Stripe settings from the admin panel. Only fields with a non-empty value
// are written, and the secret key / webhook secret are encrypted at rest.
// `salesOpen` (the accept-subscriptions toggle) is persisted as a plain boolean.
export async function saveStripeConfig({ secretKey, publishableKey, webhookSecret, priceId, successUrl, cancelUrl, salesOpen } = {}) {
  const current = await stripeConfig();
  const pick = async (v, key, encrypted) => {
    if (v === undefined || v === null || String(v).trim() === "") return;
    await db.storeSet(key, String(v).trim(), { encrypted });
  };
  // Secrets are only written when a brand-new value is supplied (never the
  // masked "••••" placeholder the admin panel echoes back).
  const isNewSecret = (v, cur) => v && String(v) !== mask(cur);
  if (isNewSecret(secretKey, current.secretKey)) await pick(secretKey, KEYS.secretKey, true);
  if (isNewSecret(webhookSecret, current.webhookSecret)) await pick(webhookSecret, KEYS.webhookSecret, true);
  await pick(publishableKey, KEYS.publishableKey, false);
  await pick(priceId, KEYS.priceId, false);
  await pick(successUrl, KEYS.successUrl, false);
  await pick(cancelUrl, KEYS.cancelUrl, false);
  if (salesOpen !== undefined && salesOpen !== null) {
    await db.storeSet(SALES_OPEN_KEY, salesOpen ? "1" : "0");
  }
  return stripeConfig();
}

// Public (non-secret) config the frontend / admin panel may display.
export async function publicStripeConfig() {
  const c = await stripeConfig();
  return {
    publishableKey: c.publishableKey || "",
    priceLabel: defaultPriceLabel(),
    configured: !!(c.secretKey && c.priceId),
    // whether the operator accepts Pro purchases right now (admin toggle)
    salesOpen: await salesOpen(),
    secretKeyMasked: mask(c.secretKey),
    webhookSecretMasked: mask(c.webhookSecret),
    priceId: c.priceId || "",
    successUrl: c.successUrl || "",
    cancelUrl: c.cancelUrl || "",
  };
}

// ----------------------------------------------------------------------------
// Checkout
// ----------------------------------------------------------------------------
// Create a Stripe Checkout Session for the recurring €9.99 subscription and
// return its hosted checkout URL. The account id travels as client_reference_id
// and in metadata, so the webhook can attribute the subscription to the user.
export async function createCheckoutSession({ userId, email, name } = {}) {
  // Sales gate: on a fresh install subscriptions are closed — the subscription
  // page advertises "opens next month" and checkout is refused until the admin
  // toggles sales open (admin panel → Billing tab).
  if (!(await salesOpen())) {
    throw new Error("Pro subscriptions are not open yet — check back next month.");
  }
  const config = await stripeConfig();
  if (!config.secretKey) throw new Error("Sorry, paying by card isn’t available yet.");
  if (!config.priceId) throw new Error("Sorry, paying by card isn’t available yet.");

  const successUrl = config.successUrl || `${getBaseUrl()}/subscription?checkout=success`;
  const cancelUrl = config.cancelUrl || `${getBaseUrl()}/subscription?checkout=canceled`;

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("client_reference_id", userId);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price]", config.priceId);
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("metadata[user_id]", userId);
  if (email) params.set("customer_email", email);
  if (name) params.set("metadata[name]", name);

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe error: ${body.error?.message || body.error?.code || res.status}`);
  }
  return { url: body.url, sessionId: body.id, priceId: config.priceId };
}

// A subscription at a price the operator set by hand (the custom Team plan,
// server/teams.js). There is no Stripe price object for it: the amount travels
// inline as price_data, and metadata.team_id lets the webhook activate the team.
// Not gated by salesOpen — the operator already approved this exact purchase.
export async function createCustomCheckoutSession({ userId, email, amountCents, currency = "eur", productName, metadata = {}, baseUrl = "" } = {}) {
  const config = await stripeConfig();
  if (!config.secretKey) throw new Error("Paying by card isn’t available yet — we will send you an invoice instead.");
  const cents = Math.round(Number(amountCents) || 0);
  if (cents < 100) throw new Error("This plan has no price yet.");
  const base = String(baseUrl || getBaseUrl()).replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("client_reference_id", userId);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", String(currency || "eur").toLowerCase());
  params.set("line_items[0][price_data][unit_amount]", String(cents));
  params.set("line_items[0][price_data][recurring][interval]", "month");
  params.set("line_items[0][price_data][product_data][name]", productName || "W flow Team");
  params.set("success_url", `${base}/subscription?checkout=success`);
  params.set("cancel_url", `${base}/subscription?checkout=canceled`);
  params.set("metadata[user_id]", userId);
  params.set("subscription_data[metadata][user_id]", userId);
  for (const [k, v] of Object.entries(metadata)) {
    params.set(`metadata[${k}]`, String(v));
    params.set(`subscription_data[metadata][${k}]`, String(v));
  }
  if (email) params.set("customer_email", email);
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe error: ${body.error?.message || body.error?.code || res.status}`);
  return { url: body.url, sessionId: body.id };
}

// ----------------------------------------------------------------------------
// Self-service management
// ----------------------------------------------------------------------------
// Create a Stripe Billing Portal session so the account can update its card,
// download invoices and cancel — instead of having to contact the operator.
// Stripe's portal must be configured once in the Stripe dashboard; when it is
// not, Stripe answers with an actionable error which we pass through.
export async function createBillingPortalSession({ customerId, returnUrl } = {}) {
  const config = await stripeConfig();
  if (!config.secretKey) throw new Error("Sorry, paying by card isn’t available yet.");
  if (!customerId) throw new Error("This account has no Stripe customer yet — subscribe first.");
  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("return_url", returnUrl || `${getBaseUrl()}/subscription`);
  const res = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe error: ${body.error?.message || body.error?.code || res.status}`);
  }
  return { url: body.url };
}

// Cancel at the end of the paid period (or undo that cancellation). The plan
// stays active until `current_period_end`; Stripe then emits
// customer.subscription.deleted and the webhook switches the account to free.
export async function updateSubscriptionCancel({ subscriptionId, cancelAtPeriodEnd } = {}) {
  const config = await stripeConfig();
  if (!config.secretKey) throw new Error("Sorry, paying by card isn’t available yet.");
  if (!subscriptionId) throw new Error("This account has no Stripe subscription to manage.");
  const params = new URLSearchParams();
  params.set("cancel_at_period_end", cancelAtPeriodEnd ? "true" : "false");
  const res = await fetch(`${STRIPE_API}/subscriptions/${subscriptionId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe error: ${body.error?.message || body.error?.code || res.status}`);
  }
  return {
    cancelAtPeriodEnd: !!body.cancel_at_period_end,
    status: body.status || "",
    currentPeriodEnd: Math.round(Number(body.current_period_end || 0) * 1000),
  };
}

// ----------------------------------------------------------------------------
// Webhook — Stripe posts subscription lifecycle events here.
// ----------------------------------------------------------------------------
// Verify the `stripe-signature` header (the documented scheme):
//   header := "t=<epoch>,v1=<hex-signature>[,v0=<legacy>]"
//   payload := "<t>.<raw-body>"; signature := HMAC_SHA256(payload, whsec)
// A constant-time comparison prevents timing attacks against the signature.
export function verifyStripeSignature(signatureHeader, rawBody, secret) {
  if (!signatureHeader || !secret) return false;
  if (!Buffer.isBuffer(rawBody)) {
    rawBody = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  }
  const parts = String(signatureHeader)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  let timestamp = "";
  let signature = "";
  for (const p of parts) {
    if (p === "v0=") continue;
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === "t") timestamp = v;
    else if (k === "v1") signature = v;
  }
  if (!timestamp || !signature) return false;
  // reject timestamps more than 5 minutes old (prevents replay)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature).toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getStr(o, path) {
  const keys = path.split(".");
  let v = o;
  for (const k of keys) {
    if (v && typeof v === "object") v = v[k];
    else return "";
  }
  return v == null ? "" : String(v);
}

// Handle a verified Stripe event and persist the subscription state.
export async function handleStripeEvent(event) {
  const type = event?.type || "";
  const data = event?.data?.object || {};
  if (type === "checkout.session.completed") {
    // subscription paid / trial started — attribute to the user by reference id
    const userId = data.client_reference_id || data.metadata?.user_id || "";
    const subId = data.subscription || "";
    const customerId = data.customer || "";
    const email = data.customer_email || data.customer_details?.email || "";
    if (!userId) return { ok: true, note: "checkout without a user reference — skipping" };
    let status = data.mode === "subscription" ? "trialing" : "active";
    let periodEnd = 0;
    let priceId = "";
    if (data.mode === "subscription") {
      const sub = await getAndApplySubscription(subId, customerId, userId, email);
      if (sub) {
        status = sub.status;
        periodEnd = sub.currentPeriodEnd;
        priceId = sub.priceId;
      }
    }
    await db.setSubscription(userId, {
      customerId,
      subscriptionId: subId,
      status,
      priceId,
      email,
      currentPeriodEnd: periodEnd,
    });
    return { ok: true, status };
  }

  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const subId = data.id || "";
    const customerId = data.customer || "";
    const status = data.status || (type.endsWith("deleted") ? "canceled" : "");
    const periodEnd = Math.round(Number(data.current_period_end || 0) * 1000);
    const priceId = data.items?.data?.[0]?.price?.id || "";
    const email = "";
    let userId = await db.resolveSubscriptionOwner(subId, customerId);
    if (!userId) {
      userId = data.metadata?.user_id || "";
    }
    if (!userId) return { ok: true, note: "subscription event without a known user — skipping" };
    await db.setSubscription(userId, {
      customerId,
      subscriptionId: subId,
      status,
      priceId,
      email,
      currentPeriodEnd: periodEnd,
    });
    // Stripe is the source of truth for a scheduled cancellation — keep our
    // flag in sync so the subscription page shows “cancels on …” correctly.
    await setCancelAtPeriodEnd(userId, !!data.cancel_at_period_end);
    return { ok: true, status };
  }

  if (type === "invoice.payment_succeeded") {
    const subId = getStr(data, "subscription");
    const periodEnd = Math.round(Number(getStr(data, "lines.data.0.period.end") || 0) * 1000);
    const userId = await db.resolveSubscriptionOwner(subId, getStr(data, "customer"));
    if (userId && subId) {
      await db.setSubscription(userId, { subscriptionId: subId, status: "active", currentPeriodEnd: periodEnd || undefined });
    }
    return { ok: true };
  }

  return { ok: true, note: `unhandled event type "${type}"` };
}

// Fetch a Stripe subscription so we can persist its live status/period.
async function getAndApplySubscription(subId, customerId, userId, email) {
  if (!subId) return null;
  const config = await stripeConfig();
  if (!config.secretKey) return null;
  try {
    const res = await fetch(`${STRIPE_API}/subscriptions/${subId}`, {
      headers: { Authorization: `Bearer ${config.secretKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const sub = await res.json().catch(() => null);
    if (!sub) return null;
    const periodEnd = Math.round(Number(sub.current_period_end || 0) * 1000);
    const priceId = sub.items?.data?.[0]?.price?.id || "";
    return { status: sub.status, currentPeriodEnd: periodEnd, priceId };
  } catch {
    return null;
  }
}

function getBaseUrl() {
  // Best effort: the exposed URL if known, otherwise whatever host we see.
  return process.env.PUBLIC_URL || process.env.BASE_URL || "";
}

function mask(v) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= 4) return "••••";
  return "•••• •••• " + s.slice(-4);
}

// ============================================================================
// Crypto billing — NOWPayments
//
// A second, card-free way to buy the same Pro subscription: the user picks
// "Pay with crypto" on the subscription page and NOWPayments hosts the payment
// (BTC, ETH, USDT, … — the payer chooses the coin). We create an *invoice* over
// REST (plain fetch, no npm package, exactly like the Stripe code above) and
// switch the account to Pro when NOWPayments posts back its IPN webhook.
//
// Config lives in the settings table so the admin panel (Billing tab → Crypto
// section) wires it up without a restart. Secrets are encrypted at rest; each
// value also falls back to its environment variable:
//   NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET
//
// A crypto subscription is deliberately NOT treated like a Stripe one: it has
// no customer, no billing portal and no automatic renewal, so the account has
// to pay again each period. The subscription id is tagged `crypto:<payment>`
// so the rest of the app can tell the two apart (see isCryptoSubscriptionId).
// ============================================================================

const NOWPAYMENTS_API = "https://api.nowpayments.io/v1";
/** How long one crypto payment keeps Pro switched on. */
export const CRYPTO_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const CRYPTO_KEYS = {
  enabled: "crypto.enabled",
  apiKey: "crypto.apiKey",
  ipnSecret: "crypto.ipnSecret",
  priceAmount: "crypto.priceAmount",
  priceCurrency: "crypto.priceCurrency",
  payCurrency: "crypto.payCurrency",
};

const CRYPTO_DEFAULT_AMOUNT = "9.99";
const CRYPTO_DEFAULT_CURRENCY = "eur";

/** True when NOWPayments is switched on AND has an API key. */
export async function cryptoEnabled() {
  try {
    const on = (await db.storeGet(CRYPTO_KEYS.enabled)) === "1";
    if (!on) return false;
    const key = (await db.storeGet(CRYPTO_KEYS.apiKey)) || process.env.NOWPAYMENTS_API_KEY || "";
    return !!key;
  } catch {
    return false;
  }
}

/** Read the current crypto configuration (DB settings, with env fallbacks). */
export async function cryptoConfig() {
  const [enabled, apiKey, ipnSecret, priceAmount, priceCurrency, payCurrency] = await Promise.all([
    db.storeGet(CRYPTO_KEYS.enabled),
    db.storeGet(CRYPTO_KEYS.apiKey),
    db.storeGet(CRYPTO_KEYS.ipnSecret),
    db.storeGet(CRYPTO_KEYS.priceAmount),
    db.storeGet(CRYPTO_KEYS.priceCurrency),
    db.storeGet(CRYPTO_KEYS.payCurrency),
  ]);
  return {
    enabled: enabled === "1",
    apiKey: apiKey || process.env.NOWPAYMENTS_API_KEY || "",
    ipnSecret: ipnSecret || process.env.NOWPAYMENTS_IPN_SECRET || "",
    priceAmount: priceAmount || CRYPTO_DEFAULT_AMOUNT,
    priceCurrency: (priceCurrency || CRYPTO_DEFAULT_CURRENCY).toLowerCase(),
    // empty = the payer picks the coin on the hosted page
    payCurrency: payCurrency || "",
  };
}

/** Save the crypto settings from the admin panel (secrets encrypted at rest). */
export async function saveCryptoConfig({ enabled, apiKey, ipnSecret, priceAmount, priceCurrency, payCurrency } = {}) {
  const current = await cryptoConfig();
  const pick = async (v, key, encrypted) => {
    if (v === undefined || v === null || String(v).trim() === "") return;
    await db.storeSet(key, String(v).trim(), { encrypted });
  };
  if (apiKey && String(apiKey) !== mask(current.apiKey)) await pick(apiKey, CRYPTO_KEYS.apiKey, true);
  if (ipnSecret && String(ipnSecret) !== mask(current.ipnSecret)) await pick(ipnSecret, CRYPTO_KEYS.ipnSecret, true);
  await pick(priceAmount, CRYPTO_KEYS.priceAmount, false);
  await pick(priceCurrency, CRYPTO_KEYS.priceCurrency, false);
  // payCurrency may legitimately be cleared (back to "payer chooses") — only
  // write it when a value is supplied, an empty one means "leave as is".
  if (payCurrency !== undefined && payCurrency !== null && String(payCurrency).trim() !== "") {
    await pick(payCurrency, CRYPTO_KEYS.payCurrency, false);
  }
  if (enabled !== undefined && enabled !== null) {
    await db.storeSet(CRYPTO_KEYS.enabled, enabled ? "1" : "0");
  }
  return cryptoConfig();
}

/** Public (non-secret) crypto state the subscription page may display. */
export async function publicCryptoConfig() {
  const c = await cryptoConfig();
  return {
    enabled: c.enabled,
    configured: !!(c.apiKey && c.enabled),
    apiKeyMasked: mask(c.apiKey),
    ipnSecretMasked: mask(c.ipnSecret),
    priceAmount: c.priceAmount,
    priceCurrency: c.priceCurrency,
    payCurrency: c.payCurrency,
    priceLabel: `${c.priceAmount} ${c.priceCurrency.toUpperCase()} / month (in crypto)`,
  };
}

/** A subscription bought with crypto carries this prefix on its id. */
export function isCryptoSubscriptionId(id) {
  return String(id || "").startsWith("crypto:");
}

/**
 * Create a NOWPayments invoice for the Pro subscription and return its hosted
 * payment URL. The account id travels as `order_id` (we prefix it so a manual
 * payment id can never collide) and in the description, so the IPN webhook can
 * attribute the payment to the right account.
 */
export async function createCryptoInvoice({ userId, email } = {}) {
  if (!(await salesOpen())) {
    throw new Error("Pro subscriptions are not open yet — check back next month.");
  }
  const c = await cryptoConfig();
  if (!c.enabled) throw new Error("Sorry, paying with crypto isn’t available yet.");
  if (!c.apiKey) throw new Error("Sorry, paying with crypto isn’t available yet.");

  const base = getBaseUrl();
  const body = {
    price_amount: Number(c.priceAmount) || Number(CRYPTO_DEFAULT_AMOUNT),
    price_currency: c.priceCurrency,
    order_id: userId,
    order_description: "W flow Pro — 1 month",
    ipn_callback_url: `${base}/api/billing/crypto/webhook`,
    success_url: `${base}/subscription?checkout=success`,
    cancel_url: `${base}/subscription?checkout=canceled`,
    is_fixed_rate: false,
    is_fee_paid_by_user: false,
  };
  if (c.payCurrency) body.pay_currency = c.payCurrency;
  if (email) body.customer_email = email;

  const res = await fetch(`${NOWPAYMENTS_API}/invoice`, {
    method: "POST",
    headers: { "x-api-key": c.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NOWPayments error: ${data.message || data.error || res.status}`);
  }
  const url = data.invoice_url || data.payment_url || "";
  if (!url) throw new Error("NOWPayments did not return a payment URL.");
  return { url, invoiceId: String(data.id || ""), priceAmount: body.price_amount, priceCurrency: body.price_currency };
}

// NOWPayments signs its IPN callbacks with HMAC-SHA512 over the JSON body with
// the object keys sorted alphabetically (recursively). We accept either that or
// the raw body, so a subtle serialisation difference on their side never locks
// out a genuine payment. Constant-time compare, as with the Stripe verifier.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function constantTimeEqualHex(a, b) {
  const ba = Buffer.from(String(a || "").toLowerCase(), "utf8");
  const bb = Buffer.from(String(b || "").toLowerCase(), "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** True when the `x-nowpayments-sig` header matches the body under `secret`. */
export function verifyNowPaymentsSignature(signature, rawBody, secret) {
  if (!signature || !secret) return false;
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  let sorted = raw;
  try {
    sorted = JSON.stringify(sortKeysDeep(JSON.parse(raw)));
  } catch {
    /* unparseable body — fall back to the raw bytes below */
  }
  const sign = (payload) => crypto.createHmac("sha512", secret).update(payload, "utf8").digest("hex");
  return constantTimeEqualHex(sign(sorted), signature) || constantTimeEqualHex(sign(raw), signature);
}

/**
 * Handle a verified NOWPayments IPN callback. A finished/confirmed payment
 * switches the account to Pro for one period; IPN retries are de-duplicated by
 * payment id so a redelivery never extends the period twice.
 */
export async function handleCryptoIpn(payload = {}) {
  const status = String(payload.payment_status || "").toLowerCase();
  const userId = String(payload.order_id || "");
  const paymentId = String(payload.payment_id || payload.invoice_id || "");
  if (!userId) return { ok: true, note: "IPN without an order reference — skipping" };
  if (!["finished", "confirmed"].includes(status)) {
    return { ok: true, status, note: `payment not final (${status || "unknown"}) — nothing changed` };
  }
  if (!paymentId) return { ok: true, note: "IPN without a payment id — skipping" };
  const appliedKey = `crypto.applied.${paymentId}`;
  try {
    if ((await db.storeGet(appliedKey)) === "1") {
      return { ok: true, status, note: "payment already applied — ignoring redelivery" };
    }
  } catch {
    /* a failed read must not block a real payment */
  }
  const periodEnd = Date.now() + CRYPTO_PERIOD_MS;
  await db.setSubscription(userId, {
    customerId: "",
    subscriptionId: `crypto:${paymentId}`,
    status: "active",
    priceId: "crypto",
    email: String(payload.customer_email || payload.order_description || ""),
    currentPeriodEnd: periodEnd,
  });
  try {
    await db.storeSet(appliedKey, "1");
  } catch {
    /* best effort */
  }
  return { ok: true, status, userId, periodEnd };
}