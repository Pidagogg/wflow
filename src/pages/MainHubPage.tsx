import { useEffect, useState } from "react";
import {
  BadgeCheck,
  Cloud,
  CreditCard,
  Cpu,
  GitBranch,
  LogOut,
  Monitor,
  PlayCircle,
  Settings as SettingsIcon,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";
import { api } from "../api";
import type { BillingStatus, Catalog } from "../types";
import SelfHostedCard from "../components/SelfHostedCard";
import LegalLinks from "../components/LegalLinks";
import { LogoStage } from "../components/ParticleLogo";
import { useIsMobile } from "../useIsMobile";
import BetaBanner from "../components/BetaBanner";

interface Props {
  user: { name?: string; email?: string; role?: string; emailVerified?: boolean };
  catalog?: Catalog | null;
  siteName?: string;
  siteTagline?: string;
  /** admin switch: removes the Pro page and every legal page/link from the site */
  hideLegalAndPro?: boolean;
  /** admin switch: the big "beta test" banner */
  betaBanner?: boolean;
  /** open the workspace hub at /home */
  onOpenCloud: () => void;
  /** open the user-template feed inside the workspace */
  onOpenTemplates: () => void;
  onOpenSubscription: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenContact: () => void;
  onLogout: () => void;
}

function periodEndLabel(ms?: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The welcome page (`/`) for a signed-in account: the entry point that holds
 * account and subscription management, the product overview and the one-click
 * entries into the cloud workspace hub (`/home`) and the self-hosted download.
 * Legal pages are linked from here (header + footer) and from the cookie banner.
 */
export default function MainHubPage({
  user,
  catalog,
  siteName,
  siteTagline,
  hideLegalAndPro,
  betaBanner,
  onOpenCloud,
  onOpenTemplates,
  onOpenSubscription,
  onOpenProfile,
  onOpenSettings,
  onOpenContact,
  onLogout,
}: Props) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const brand = siteName?.trim() || "W flow";
  const nodeCount = catalog ? Object.keys(catalog.nodes).length : 0;
  const displayName = user.name || user.email?.split("@")[0] || "there";
  const isMobile = useIsMobile();

  // Refetched whenever the page comes back into view, not only on mount: runs
  // started from another tab, a cron fire or a webhook change "Runs today"
  // while this page sits open, and a mount-only fetch would keep showing 0.
  useEffect(() => {
    const load = () =>
      api.billing
        .status()
        .then(setBilling)
        .catch(() => {});
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const planLabel = billing ? (billing.plan === "pro" ? "Pro" : "Free") : "…";
  const pro = billing?.plan === "pro";

  const accountCard = (
    <article className="mainhub-card">
      <div className="mainhub-card-head">
        <UserRound size={14} /> ACCOUNT
      </div>
      <dl className="mainhub-facts">
        <div>
          <dt>Name</dt>
          <dd>{user.name || "—"}</dd>
        </div>
        <div>
          <dt>E-mail</dt>
          <dd>
            {user.email || "—"}
            {user.emailVerified && (
              <span className="mainhub-verified" title="E-mail address confirmed">
                <BadgeCheck size={12} /> verified
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{user.role || "user"}</dd>
        </div>
      </dl>
      <div className="mainhub-actions">
        <button className="btn btn-sm" onClick={onOpenProfile}>
          <UserRound size={12} /> Profile &amp; templates
        </button>
        <button className="btn btn-sm" onClick={onOpenSettings}>
          <SettingsIcon size={12} /> Settings
        </button>
        <button className="btn btn-sm" onClick={onOpenContact}>
          Contact
        </button>
      </div>
    </article>
  );

  const subscriptionCard = (
    <article className="mainhub-card">
      <div className="mainhub-card-head">
        <CreditCard size={14} /> SUBSCRIPTION
      </div>
      <div className="mainhub-plan">
        <span className={`mainhub-plan-name ${pro ? "pro" : ""}`}>{planLabel}</span>
        {billing && (
          <span className="mainhub-plan-status">
            {billing.source === "role"
              ? "given to you"
              : billing.status && billing.status !== "none"
              ? billing.status
              : "no subscription"}
          </span>
        )}
      </div>
      {billing && (
        <dl className="mainhub-facts">
          <div>
            <dt>Price</dt>
            <dd>{billing.priceLabel || (pro ? "included" : "free")}</dd>
          </div>
          <div>
            <dt>Workflows</dt>
            <dd>
              {billing.workflowCount}
              {billing.workflowLimit === null ? " / unlimited" : ` / ${billing.workflowLimit}`}
            </dd>
          </div>
          <div>
            <dt>Runs today</dt>
            <dd>
              {billing.runsToday}
              {billing.runsPerDayLimit === null ? " / unlimited" : ` / ${billing.runsPerDayLimit}`}
            </dd>
          </div>
          {billing.periodEnd > 0 && (
            <div>
              <dt>{billing.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
              <dd>{periodEndLabel(billing.periodEnd)}</dd>
            </div>
          )}
        </dl>
      )}
      {billing?.cancelAtPeriodEnd && (
        <div className="mainhub-note">
          Cancellation scheduled — Pro stays active until {periodEndLabel(billing.periodEnd)}.
        </div>
      )}
      {!hideLegalAndPro && (
        <div className="mainhub-actions">
          <button className="btn btn-sm btn-primary" onClick={onOpenSubscription}>
            <CreditCard size={12} /> {pro ? "Manage billing" : billing?.salesOpen === false ? "Pro opens next month" : "Upgrade to Pro"}
          </button>
          <button className="btn btn-sm" onClick={onOpenSubscription}>
            Invoices &amp; cancellation
          </button>
        </div>
      )}
    </article>
  );

  // Phones get the account and the subscription only. The workspace stays
  // reachable, but it opens with a warning (App.tsx) — it is built for a
  // desktop screen and a mouse.
  if (isMobile) {
    return (
      <div className="mainhub mobile-gate">
        <header className="mobile-gate-head">
          <div className="brand" title={brand}>
            <img className="brand-logo" src="/logo.png" alt="W" />
            <span className="brand-name">{brand}</span>
          </div>
          <button className="btn btn-sm" onClick={onLogout} title="Log out">
            <LogOut size={13} /> Log out
          </button>
        </header>
        <main className="mobile-gate-main mobile-gate-hub">
          {betaBanner && <BetaBanner onContact={onOpenContact} />}
          <div className="public-kicker">
            <span className="led led-green" /> WELCOME BACK, {displayName.toUpperCase()}
          </div>
          {accountCard}
          {subscriptionCard}
          <div className="mobile-gate-note">
            <Monitor size={14} />
            <span>The workspace is built for a computer. On a phone it opens, but some parts may not work properly.</span>
          </div>
          <button className="btn mobile-gate-cloud" onClick={onOpenCloud}>
            <Cloud size={13} /> Open the workspace anyway
          </button>
        </main>
        {!hideLegalAndPro && <LegalLinks variant="footer" />}
      </div>
    );
  }

  return (
    <div className="mainhub">
      <header className="mainhub-head">
        <div className="brand" title={brand}>
          <img className="brand-logo" src="/logo.png" alt="W" />
          <span className="brand-name">{brand}</span>
          {brand.toLowerCase() !== "w flow" && <span className="brand-tag">W flow</span>}
        </div>
        <div className="mainhub-head-right">
          <a className="public-guides-link" href="/guides">Guides</a>
          {!hideLegalAndPro && <LegalLinks variant="header" />}
          <button className="btn btn-sm" onClick={onOpenSettings} title="Account settings">
            <SettingsIcon size={13} /> Settings
          </button>
          <button className="btn btn-sm" onClick={onOpenProfile} title="Your public profile">
            <UserRound size={13} /> Profile
          </button>
          <span className="led led-green" />
          <span className="selfhosted">{user.email}</span>
          <button className="btn btn-sm" onClick={onLogout} title="Log out">
            <LogOut size={13} /> Log out
          </button>
        </div>
      </header>

      <main className="mainhub-main">
        <LogoStage nextId="main-content" />
        {betaBanner && <BetaBanner onContact={onOpenContact} />}
        <section className="mainhub-hero public-hero-centered" id="main-content">
          <div className="public-kicker">
            <span className="led led-green" /> Welcome back, {displayName}
          </div>
          <h1>{siteTagline?.trim() || "Build workflows and AI agents on your own server."}</h1>
          <p className="public-lede">
            Connect triggers, actions, logic and AI nodes into automations you can inspect end to end. Pick where W flow
            runs: the cloud workspace here, or a self-hosted copy on your own machine. Your data, your rules — you decide
            what is stored, shared and connected.
          </p>
          <div className="public-hero-meta">
            {nodeCount > 0 && (
              <span>
                <Cpu size={13} /> {nodeCount} node types
              </span>
            )}
            <span>
              <GitBranch size={13} /> Visual canvas
            </span>
            <span>
              <PlayCircle size={13} /> Inspectable run logs
            </span>
          </div>
        </section>

        {/* One-click entry into either way of running W flow. */}
        <section className="mainhub-entries" aria-label="Choose how to run W flow">
          <article className="entry-card entry-card-primary">
            <div className="entry-card-icon">
              <Cloud size={18} />
            </div>
            <h3>Cloud version</h3>
            <p>
              Your workspace on this instance. Workflows, agents, credentials and executions are ready where you left
              them — nothing to install.
            </p>
            <div className="entry-card-meta">
              <span><Sparkles size={12} /> Always up to date</span>
              <span>Access from any device</span>
            </div>
            <button className="btn btn-primary entry-card-btn" onClick={onOpenCloud}>
              <Cloud size={13} /> Open the cloud workspace
            </button>
          </article>

          <SelfHostedCard authed onUpgrade={onOpenSubscription} onLogin={onOpenCloud} />
        </section>

        <section className="mainhub-grid">
          {accountCard}
          {subscriptionCard}

          <article className="mainhub-card">
            <div className="mainhub-card-head">
              <Users size={14} /> USER TEMPLATES
            </div>
            <p className="mainhub-card-text">
              Templates published by other accounts on this instance. Import one as a starting point — a template
              carries no credentials, so you enter your own.
            </p>
            <div className="mainhub-actions">
              <button className="btn btn-sm" onClick={onOpenTemplates}>
                Open User Templates
              </button>
            </div>
          </article>
        </section>
      </main>

      {!hideLegalAndPro && <LegalLinks variant="footer" />}
    </div>
  );
}
