import { useEffect, useState } from "react";
import { Bot, Clock3, Cloud, CreditCard, GitBranch, House, LockKeyhole, LogIn, Monitor, Play, Sparkles, UserPlus, Users, Webhook } from "lucide-react";
import type { Catalog } from "../types";
import LoginPage from "../pages/LoginPage";
import SelfHostedCard from "./SelfHostedCard";
import LegalLinks from "./LegalLinks";
import { LogoStage } from "./ParticleLogo";
import { useIsMobile } from "../useIsMobile";
import BetaBanner from "./BetaBanner";

interface Props {
  catalog: Catalog | null;
  siteName?: string;
  siteTagline?: string;
  authBanner?: string;
  /** admin switch: the Pro page and all legal pages are removed from the site */
  hideLegalAndPro?: boolean;
  /** admin switch: the big "beta test" banner */
  betaBanner?: boolean;
  /** reset token from an e-mailed link (opens the reset form) */
  resetToken?: string;
  /** the password was reset — the token is spent */
  onResetDone?: () => void;
  authOpen: boolean;
  onAuthOpen: () => void;
  onAuthClose: () => void;
  /** the visitor chose the cloud workspace: log in, then continue there */
  onEnterCloud: () => void;
  onAuthed: (user: { email: string; name: string; role?: string }) => void;
  onDeactivated: (reason: string) => void;
}

// Mirror the signed-in top navigation: the workspace tools live on the main
// page (`/home`) after login, so the public bar is Home / User Templates / Pro.
const protectedItems = [
  { label: "Home", icon: House },
  { label: "User Templates", icon: Users },
  { label: "Pro", icon: CreditCard, proOnly: true },
];

export default function PublicHome({ catalog, siteName, siteTagline, authBanner, hideLegalAndPro, betaBanner, resetToken, onResetDone, authOpen, onAuthOpen, onAuthClose, onEnterCloud, onAuthed, onDeactivated }: Props) {
  const nodeCount = catalog ? Object.keys(catalog.nodes).length : 0;
  const brand = siteName?.trim() || "W flow";
  const tagline = siteTagline?.trim() || "Build workflows and AI agents on your own server.";
  const isMobile = useIsMobile();
  // Only the mobile screen asks for a tab up front; the desktop header button
  // always opens on "log in" as before.
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  // back to "log in" once the card closes, whichever button opened it
  useEffect(() => {
    if (!authOpen) setAuthMode("login");
  }, [authOpen]);
  const openAuth = (mode: "login" | "register") => {
    setAuthMode(mode);
    onAuthOpen();
  };

  const auth = (authOpen || !!resetToken) && (
    <LoginPage
      key={authMode}
      initialMode={authMode}
      onAuthed={onAuthed}
      onDeactivated={onDeactivated}
      onClose={resetToken ? undefined : onAuthClose}
      resetToken={resetToken}
      onResetDone={onResetDone}
    />
  );

  // Phones get only what works there: signing in and creating an account.
  // Building happens on the canvas, which needs a real screen and a mouse.
  if (isMobile) {
    return (
      <div className="public-app mobile-gate">
        <header className="mobile-gate-head">
          <div className="brand" title={brand}>
            <img className="brand-logo" src="/logo.png" alt="W" />
            <span className="brand-name">{brand}</span>
          </div>
        </header>
        <main className="mobile-gate-main">
          {betaBanner && <BetaBanner />}
          <div className="public-kicker"><span className="led led-green" /> Self-hosted automation</div>
          <h1>{tagline}</h1>
          <p className="public-lede">
            W flow is a visual builder for workflow automations and AI agents: connect apps like Gmail, Google Sheets, Slack or
            Notion with AI models, and let the server run the work for you — in the cloud or on your own server. We care about your
            data and privacy: you decide what is stored, shared and connected.
          </p>
          {authBanner?.trim() && <p className="public-lede">{authBanner.trim()}</p>}
          <div className="mobile-gate-actions">
            <button className="btn btn-primary" onClick={() => openAuth("login")}>
              <LogIn size={15} /> Log in
            </button>
            <button className="btn" onClick={() => openAuth("register")}>
              <UserPlus size={15} /> Create account
            </button>
          </div>
          <div className="mobile-gate-note">
            <Monitor size={14} />
            <span>Building workflows and agents works best on a computer.</span>
          </div>
          <a className="public-guides-link" href="/landing.html">What W flow can do →</a>
          <a className="public-guides-link" href="/guides">Read the step-by-step guides →</a>
        </main>
        {!hideLegalAndPro && <LegalLinks variant="footer" />}
        {auth}
      </div>
    );
  }

  return (
    <div className="public-app">
      <header className="topbar public-topbar">
        <div className="brand" title="W flow">
          <img className="brand-logo" src="/logo.png" alt="W" />
          <span className="brand-name">{brand}</span>
          {brand.toLowerCase() !== "w flow" && <span className="brand-tag">W flow</span>}
        </div>
        <nav className="topnav public-nav" aria-label="Protected areas">
          {protectedItems.filter((it) => !it.proOnly || !hideLegalAndPro).map(({ label, icon: Icon }) => (
            <button key={label} className="navbtn public-locked-nav" onClick={() => openAuth("login")} title={`Log in to open ${label}`}>
              <Icon size={14} />
              {label}
              <LockKeyhole size={11} />
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <a className="public-guides-link" href="/guides">Guides</a>
          {!hideLegalAndPro && <LegalLinks variant="header" />}
          <button className="btn btn-primary public-auth-button" onClick={() => openAuth("login")}>
            <LockKeyhole size={14} /> Log in / Create account
          </button>
          <span className="led led-green" />
          <span className="selfhosted">Public preview</span>
        </div>
      </header>

      <main className="public-main">
        <LogoStage nextId="main-content" />
        {betaBanner && <BetaBanner />}
        <section className="public-hero public-hero-centered" id="main-content">
          <div className="public-kicker"><span className="led led-green" /> Self-hosted automation</div>
          <h1>{tagline}</h1>
          <p className="public-lede">
            {authBanner?.trim() || "Explore W flow before you create an account. Connect triggers, actions, logic and AI nodes into automations that stay under your control — we care about your data and privacy, and you decide what is stored and shared."}
          </p>
          <div className="public-actions">
            <button className="btn btn-primary" onClick={onEnterCloud}><Play size={14} /> Start building — free</button>
            <span className="public-action-note">Create a free account to build, run and share workflows.</span>
          </div>
          <div className="public-hero-meta">
            {nodeCount > 0 && <span><Sparkles size={13} /> {nodeCount} node types</span>}
            <span><LockKeyhole size={13} /> Your data, your rules</span>
            <span><Webhook size={13} /> Webhooks and schedules</span>
          </div>
        </section>

        {/* One-click entry into either way of running W flow. The self-hosted
            download itself is gated: guests see the login/upgrade prompt. */}
        <section className="mainhub-entries" aria-label="Choose how to run W flow">
          <article className="entry-card entry-card-primary">
            <div className="entry-card-icon">
              <Cloud size={18} />
            </div>
            <h3>Cloud version</h3>
            <p>
              Work in the workspace on this instance — workflows, agents, credentials and run logs, always up to date
              and reachable from any device.
            </p>
            <div className="entry-card-meta">
              <span><Sparkles size={12} /> Nothing to install</span>
              <span>Isolated per account</span>
            </div>
            <button className="btn btn-primary entry-card-btn" onClick={onEnterCloud}>
              <Cloud size={13} /> Open the cloud workspace
            </button>
          </article>
          <SelfHostedCard authed={false} onUpgrade={onAuthOpen} onLogin={onAuthOpen} />
        </section>

        <section className="public-preview-section">
          <div className="public-section-head">
            <div>
              <div className="section-label">What is inside</div>
              <h2>One canvas, many ways to automate</h2>
            </div>
            <div className="public-section-code">W flow // rev a</div>
          </div>
          <div className="public-feature-grid">
            <article className="public-feature">
              <div className="public-feature-icon"><GitBranch size={18} /></div>
              <h3>Visual workflows</h3>
              <p>Start with a manual trigger, webhook or schedule, then connect actions and logic with inspectable run logs.</p>
              <button className="public-feature-link" onClick={onAuthOpen}>Sign in to build <LockKeyhole size={12} /></button>
            </article>
            <article className="public-feature">
              <div className="public-feature-icon"><Bot size={18} /></div>
              <h3>Flexible AI agents</h3>
              <p>Bring an OpenAI-compatible, Anthropic, Gemini, local or custom model endpoint and configure tools in one place.</p>
              <button className="public-feature-link" onClick={onAuthOpen}>Sign in to configure <LockKeyhole size={12} /></button>
            </article>
            <article className="public-feature">
              <div className="public-feature-icon"><Clock3 size={18} /></div>
              <h3>Runs you can inspect</h3>
              <p>See inputs, outputs, durations and classified errors per node, then test a chain with manual output data.</p>
              <button className="public-feature-link" onClick={onAuthOpen}>Sign in to run workflows <LockKeyhole size={12} /></button>
            </article>
          </div>
        </section>

        <section className="public-boundary">
          <LockKeyhole size={16} />
          <div>
            <strong>Your workspace stays private.</strong>
            <span>
              Accounts, workflows, agents and credentials are isolated per user. When you connect a Google, Microsoft or other
              account on a node, you sign in on that service's own page; W flow stores the access encrypted and uses it only to
              run the actions in your own workflows — never for advertising or AI training.{" "}
              <a href="/landing.html#connected-accounts">How your data is used</a>
              {!hideLegalAndPro && (
                <>
                  {" "}
                  · <a href="/datenschutz?lang=en">Privacy Policy</a>
                </>
              )}
            </span>
          </div>
        </section>
      </main>

      {!hideLegalAndPro && <LegalLinks variant="footer" />}

      {auth}
    </div>
  );
}
