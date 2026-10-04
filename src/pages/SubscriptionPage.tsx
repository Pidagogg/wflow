import { useEffect, useState } from "react";
import { Bitcoin, CalendarClock, Check, CreditCard, Loader2, ShieldCheck, Sparkles, X } from "lucide-react";
import { api } from "../api";
import type { BillingStatus } from "../types";
import { Toast, useToast } from "../components/Toast";
import TeamPlanCard from "../components/TeamPlanCard";

function periodEndLabel(ms?: number) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const PERKS = [
  "Unlimited workflow builds & runs",
  "Every node unlocked (AI, HTTP, integrations)",
  "Priority community import without limits",
  "Download the self-hosted installer (Settings → Defaults) and run W flow on your own machine",
  "Support this self-hosted project",
];

export default function SubscriptionPage() {
  const { show, toast } = useToast();
  const [info, setInfo] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cryptoStarting, setCryptoStarting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = () =>
    api.billing
      .status()
      .then(setInfo)
      .catch((e) => show(`Failed to load subscription: ${(e as Error).message}`, "err"))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    // surface the Stripe redirect result in the URL (?checkout=success|canceled)
    const q = new URLSearchParams(window.location.search);
    if (q.get("checkout") === "success") {
      setBanner({ kind: "ok", text: "Checkout complete — your subscription is being activated." });
    } else if (q.get("checkout") === "canceled") {
      setBanner({ kind: "err", text: "Checkout was canceled. No charge was made." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCheckout = async () => {
    setStarting(true);
    try {
      const { url } = await api.billing.checkout();
      window.location.href = url; // Stripe's hosted Checkout page
    } catch (err) {
      show(`Could not start checkout: ${(err as Error).message}`, "err");
      setStarting(false);
    }
  };

  // Pay with crypto — NOWPayments hosts the invoice page (BTC, ETH, USDT, …);
  // the IPN webhook switches the account to Pro once the payment is confirmed.
  const startCryptoCheckout = async () => {
    setCryptoStarting(true);
    try {
      const { url } = await api.billing.cryptoCheckout();
      window.location.href = url; // NOWPayments' hosted invoice page
    } catch (err) {
      show(`Could not start the crypto payment: ${(err as Error).message}`, "err");
      setCryptoStarting(false);
    }
  };

  // Open Stripe's Billing Portal (card, invoices, cancellation).
  const openPortal = async () => {
    setManaging(true);
    try {
      const { url } = await api.billing.portal();
      window.location.href = url;
    } catch (err) {
      show(`Could not open billing: ${(err as Error).message}`, "err");
      setManaging(false);
    }
  };

  const cancelSubscription = async () => {
    if (!window.confirm("Cancel your Pro subscription at the end of the current period?")) return;
    setCancelling(true);
    try {
      const res = await api.billing.cancel();
      show(
        res.cancelAtPeriodEnd
          ? `Pro stays active until ${periodEndLabel(res.periodEnd) || "the end of the period"}.`
          : "Cancellation scheduled."
      );
      load();
    } catch (err) {
      show(`Could not cancel: ${(err as Error).message}`, "err");
    } finally {
      setCancelling(false);
    }
  };

  const resumeSubscription = async () => {
    setCancelling(true);
    try {
      await api.billing.resume();
      show("Subscription resumed — thanks for staying!");
      load();
    } catch (err) {
      show(`Could not resume: ${(err as Error).message}`, "err");
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <div className="dashboard">
        <div className="run-loading" style={{ padding: 60 }}>
          <span className="spinner" /> CHECKING SUBSCRIPTION…
        </div>
      </div>
    );
  }

  const priceLabel = info?.priceLabel || "€9.99 / month";
  // Stripe is "configured" when a secret key + price are on file. Crypto is a
  // second, independent checkout: an instance that only wired up NOWPayments
  // still sells Pro, so neither alone may hide the pricing card.
  const stripeReady = info?.configured !== false;
  const cryptoReady = !!info?.cryptoPayments?.enabled && !!info?.cryptoPayments?.configured;
  const notConfigured = !stripeReady && !cryptoReady;
  // Sales gate: on a fresh install subscriptions are closed (admin toggle).
  // Users are automatically on the free plan and Pro is advertised as
  // opening next month — the Subscribe button only appears once the operator
  // flips the toggle in the admin panel (Billing tab).
  const salesClosed = !!info && info.salesOpen === false && !info.active;
  const cryptoTradeNote =
    info?.crypto && info.status === "active"
      ? "Bought with crypto — renews manually each period."
      : "";

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div className="dash-title">
          PRO<span style={{ color: "var(--cyan-dim)" }}>//</span>SUBSCRIPTION
          <small>One flat price · unlocks everything</small>
        </div>
      </div>

      {banner && (
        <div className={`banner banner-${banner.kind}`}>
          <span>{banner.text}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setBanner(null)} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      {/* An account with Pro access sees its state even when Stripe is not
          configured — Pro can also be granted by the operator (pro_user role). */}
      {(!notConfigured || info.active) && info && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            border: "1px solid",
            borderColor: info.active ? "color-mix(in srgb, var(--green) 40%, transparent)" : "var(--line)",
            background: info.active ? "rgba(80,220,150,0.06)" : "var(--bg-panel)",
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 12.5,
            color: "var(--ink-dim)",
            marginBottom: 18,
          }}
        >
          <span className="tag" style={{ color: info.active ? "var(--green)" : "var(--ink)", borderColor: "currentColor", textTransform: "uppercase" }}>
            {info.active ? "PRO" : "Free plan"}
          </span>
          {info.active ? (
            <span>
              <b style={{ color: "var(--ink)" }}>Unlimited</b> workflows and runs — the free-plan caps are lifted.
              {info.source === "role" && <> Pro access was <b style={{ color: "var(--ink)" }}>given to this account</b>.</>}
            </span>
          ) : (
            <span>
              <b style={{ color: "var(--ink)" }}>{info.workflowCount}</b>/{info.workflowLimit} workflows built ·{" "}
              <b style={{ color: "var(--ink)" }}>{info.runsToday}</b>/{info.runsPerDayLimit} runs today (reset at midnight UTC) —{" "}
              <b style={{ color: "var(--ink)" }}>Pro removes both limits.</b>
            </span>
          )}
        </div>
      )}

      {/* Self-service billing — only meaningful while a Stripe subscription is on
          file. Portal = card, invoices, cancellation; the two buttons let the
          account stop or keep the renewal without contacting the operator. */}
      {info?.hasSubscription && (
        <div className="billing-manage">
          <div className="billing-manage-info">
            <CreditCard size={14} />
            <span>
              {info.cancelAtPeriodEnd ? (
                <>
                  Your subscription ends <b>{periodEndLabel(info.periodEnd) || "at the end of the period"}</b> and will
                  not renew.
                </>
              ) : (
                <>
                  Your plan renews <b>{periodEndLabel(info.periodEnd) || "automatically"}</b>. Cancel any time — you keep
                  Pro until then.
                </>
              )}
            </span>
          </div>
          <div className="billing-manage-actions">
            <button className="btn btn-sm" onClick={openPortal} disabled={managing}>
              {managing ? <Loader2 size={13} className="spin" /> : <CreditCard size={13} />} Manage billing
            </button>
            {cryptoTradeNote && <span className="billing-manage-note">{cryptoTradeNote}</span>}
            {info.cancelAtPeriodEnd ? (
              <button className="btn btn-sm btn-primary" onClick={resumeSubscription} disabled={cancelling}>
                <Check size={13} /> Keep subscription
              </button>
            ) : (
              <button className="btn btn-sm btn-ghost btn-danger" onClick={cancelSubscription} disabled={cancelling}>
                <X size={13} /> Cancel subscription
              </button>
            )}
          </div>
        </div>
      )}

      {notConfigured && !info?.active ? (
        <div className="wf-empty" style={{ padding: 40 }}>
          <span className="plus">
            <CreditCard size={22} />
          </span>
          <div className="wf-empty-title">Subscriptions will be available in a month</div>
          <div className="wf-empty-sub">
            Paid plans are on their way. Until then, keep building on the free plan — nothing you create will be lost.
          </div>
        </div>
      ) : salesClosed ? (
        <div className="pricing-grid">
          <div className="pricing-card pricing-soon">
            <div
              className="pricing-badge"
              style={{ color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 50%, transparent)" }}
            >
              OPENS NEXT MONTH
            </div>
            <div className="pricing-icon">
              <Sparkles size={22} />
            </div>
            <div className="pricing-name">W flow Pro</div>
            <div className="pricing-price">
              {priceLabel.replace(" / ", "/")}
              <small>per month · cancel anytime</small>
            </div>
            <ul className="pricing-perks">
              {PERKS.map((p) => (
                <li key={p}>
                  <Check size={13} style={{ color: "var(--green)" }} /> {p}
                </li>
              ))}
            </ul>
            <button className="btn pricing-cta pricing-soon-btn" disabled title="Subscriptions open next month">
              <CalendarClock size={14} /> Subscriptions open next month
            </button>
            <div className="pricing-soon-note">
              You're on the <b>free plan</b> right now — everything above stays unlocked for free. Pro purchases open
              <b> next month</b>; you'll be able to upgrade right here once they do.
            </div>
          </div>
        </div>
      ) : info?.active ? (
        <div className="pricing-grid">
          <div className="pricing-card pricing-active">
            <div className="pricing-badge">Active</div>
            <div className="pricing-icon">
              <Sparkles size={22} />
            </div>
            <div className="pricing-name">W flow Pro</div>
            <div className="pricing-price">{priceLabel}</div>
            <div className="pricing-meta">
              Plan <span className="tag" style={{ color: "var(--green)", borderColor: "color-mix(in srgb, var(--green) 40%, transparent)" }}>{info.plan}</span>
              Status
              <span className="tag" style={{ color: "var(--green)", borderColor: "color-mix(in srgb, var(--green) 40%, transparent)" }}>
                {info.source === "role" ? "given to you" : info.status}
              </span>
              {info.periodEnd > 0 && (
                <span style={{ display: "block", marginTop: 4, color: "var(--ink-faint)", fontSize: 11.5 }}>
                  {info.crypto
                    ? `Active until ${periodEndLabel(info.periodEnd)} — pay again with crypto to extend.`
                    : `Renews ${periodEndLabel(info.periodEnd)}`}
                </span>
              )}
            </div>
            <ul className="pricing-perks">
              {PERKS.map((p) => (
                <li key={p}>
                  <Check size={13} style={{ color: "var(--green)" }} /> {p}
                </li>
              ))}
            </ul>
            <span className="btn-primary pricing-current">
              {info.source === "role" ? "Pro access is active on this account." : "You're subscribed — thanks!"}
            </span>
          </div>
        </div>
      ) : (
        <div className="pricing-grid">
          <div className="pricing-card">
            <div className="pricing-icon">
              <Sparkles size={22} />
            </div>
            <div className="pricing-name">W flow Pro</div>
            <div className="pricing-price">
              {priceLabel.replace(" / ", "/")}
              <small>per month · cancel anytime</small>
            </div>
            <ul className="pricing-perks">
              {PERKS.map((p) => (
                <li key={p}>
                  <Check size={13} style={{ color: "var(--green)" }} /> {p}
                </li>
              ))}
            </ul>
            {stripeReady && (
              <button className="btn btn-primary pricing-cta" onClick={startCheckout} disabled={starting || cryptoStarting}>
                {starting ? <Loader2 size={14} className="spin" /> : <CreditCard size={14} />}
                {starting ? "Taking you to Stripe…" : `Subscribe · ${priceLabel}`}
              </button>
            )}
            {cryptoReady && (
              <button className="btn pricing-cta pricing-cta-crypto" onClick={startCryptoCheckout} disabled={starting || cryptoStarting}>
                {cryptoStarting ? <Loader2 size={14} className="spin" /> : <Bitcoin size={14} />}
                {cryptoStarting ? "Opening the crypto invoice…" : `Pay with crypto · ${info?.cryptoPayments?.priceLabel || "in BTC / ETH / USDT"}`}
              </button>
            )}
            <div className="pricing-secure">
              <ShieldCheck size={11} />
              {stripeReady && " Secured by Stripe — card details never touch this server."}
              {stripeReady && cryptoReady && " "}
              {cryptoReady && "Crypto payments are handled by NOWPayments."}
            </div>
          </div>
        </div>
      )}

      {/* the custom plan: pick the number of accounts, confirmed by hand */}
      <TeamPlanCard />

      <Toast toast={toast} />
    </div>
  );
}