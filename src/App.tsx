import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard, House, LogOut, Settings as SettingsIcon, ShieldCheck, UserRound, Users, Wrench } from "lucide-react";
import { api } from "./api";
import type { Catalog, LicenseState } from "./types";
import WorkflowEditor from "./pages/WorkflowEditor";
import CommunityPage from "./pages/CommunityPage";
import CommunityPostPage from "./pages/CommunityPostPage";
import ProfilePage from "./pages/ProfilePage";
import SubscriptionPage from "./pages/SubscriptionPage";
import HomePage, { type HubPage } from "./pages/HomePage";
import MainHubPage from "./pages/MainHubPage";
import SetupPage from "./pages/SetupPage";
import TeamPage from "./pages/TeamPage";
import LicensePage from "./pages/LicensePage";
import { UpdateBanner } from "./components/UpdatePanel";
import PublicHome from "./components/PublicHome";
import DeactivatedPage from "./components/DeactivatedPage";
import CookieConsent, { clearCookieConsent } from "./components/CookieConsent";
import SettingsModal, { type SettingsTab } from "./components/SettingsModal";
import ContactPage from "./pages/ContactPage";
import WelcomeWizard from "./components/WelcomeWizard";
import { hasSeenWelcome, markWelcomeSeen } from "./settings";
// The local state setter below is also called setCloudPath, so the module-level
// one that routes.ts exposes is aliased here.
import { setCloudPath as setRouteCloudPath } from "./routes";
import { setProSalesOpen } from "./proStatus";
import { useIsMobile } from "./useIsMobile";

// Once dismissed, the mobile warning stays away for the rest of the visit.
const MOBILE_WARN_KEY = "wflow.mobileWarnDismissed";
function mobileWarnDismissed() {
  try {
    return sessionStorage.getItem(MOBILE_WARN_KEY) === "1";
  } catch {
    return false;
  }
}

type Page = HubPage | "home" | "community" | "community-post" | "profile" | "subscription" | "contact" | "setup" | "team";

interface Route {
  page: Page;
  id?: string;
  folderId?: string;
  /** true when the URL is the public landing page — i.e. outside the workspace prefix */
  landing?: boolean;
}

const HUB_PAGES: HubPage[] = ["workflows", "agents", "credentials", "executions", "variables", "datatables", "files"];

// The workspace lives under a path prefix (`/cloud` by default). The operator
// can move it (admin panel → Page setup → Workspace path) so the real domain
// can use /cloud, /app, /studio, …; the welcome page always stays at /.
const DEFAULT_CLOUD_PATH = "cloud";

// The workspace hub — the main page with the tool switcher (credentials,
// workflows, agents, executions, variables, data tables) and the workspace
// statistics. It has a fixed path of its own so the welcome page can own `/`.
const HUB_PATH = "/home";

function normalizeCloudPath(raw?: string) {
  return String(raw || "").trim().replace(/^\/+|\/+$/g, "") || DEFAULT_CLOUD_PATH;
}

// Every workspace tool lives INSIDE the workspace hub: the tool buttons sit at
// the top and the selected tool's workspace renders below. "home" defaults to
// the workflows tool so the hub is never empty.
function hubPage(page: Page): HubPage | null {
  if (page === "home") return "workflows";
  return (HUB_PAGES as string[]).includes(page) ? (page as HubPage) : null;
}

// Parse the browser path into a route. `/home` is the workspace hub (the old
// main page), everything else under the workspace prefix (/cloud/…, or whatever
// the operator configured) is a workspace page, and every remaining path is the
// welcome page.
function parsePath(pathname: string, cloud: string): Route {
  const prefix = `/${cloud}`;
  const clean = pathname.replace(/\/+$/, "") || "/";
  const underPrefix = clean === prefix || clean.startsWith(`${prefix}/`);
  // /home is the workspace hub. The prefix wins if an operator ever sets the
  // workspace path to "home" itself, so the tool routes keep working.
  if (!underPrefix && (clean === HUB_PATH || clean.startsWith(`${HUB_PATH}/`))) return { page: "home" };
  // /setup configures the instance itself (storage, execution target) and is
  // only rendered for its owner — the server enforces the same rule.
  if (!underPrefix && (clean === "/setup" || clean.startsWith("/setup/"))) return { page: "setup" };
  // /team: the admin page of a self-hosted copy (accounts, shared credentials, data flows)
  if (!underPrefix && (clean === "/team" || clean.startsWith("/team/"))) return { page: "team" };
  if (!underPrefix) return { page: "home", landing: true };
  const rest = clean.slice(prefix.length).replace(/^\/+/, "");
  if (!rest) return { page: "home" };
  if (rest.startsWith("workflow/")) return { page: "workflows", id: rest.slice("workflow/".length) };
  // /cloud/workflows/folder/<id> opens the dashboard focused on one folder
  if (rest.startsWith("workflows/folder/")) {
    return { page: "workflows", folderId: decodeURIComponent(rest.slice("workflows/folder/".length)) };
  }
  if (rest.startsWith("workflows")) return { page: "workflows" };
  if (rest.startsWith("agent/")) return { page: "agents", id: rest.slice("agent/".length) };
  if (rest.startsWith("agents")) return { page: "agents" };
  if (rest.startsWith("subscription")) return { page: "subscription" };
  if (rest.startsWith("contact")) return { page: "contact" };
  // /cloud/community/<postId> is a single template's page; plain /cloud/community the feed
  if (rest.startsWith("community/") || rest.startsWith("user-templates/")) {
    return { page: "community-post", id: rest.replace(/^(community|user-templates)\//, "") };
  }
  if (rest.startsWith("community") || rest.startsWith("user-templates")) return { page: "community" };
  // /cloud/profile is your own profile, /cloud/profile/<userId> someone else's
  if (rest.startsWith("profile/")) return { page: "profile", id: decodeURIComponent(rest.slice("profile/".length)) };
  if (rest.startsWith("profile")) return { page: "profile" };
  if (rest.startsWith("credentials")) return { page: "credentials" };
  if (rest.startsWith("executions")) return { page: "executions" };
  if (rest.startsWith("variables")) return { page: "variables" };
  if (rest.startsWith("data-tables") || rest.startsWith("datatables")) return { page: "datatables" };
  if (rest.startsWith("files")) return { page: "files" };
  // anything unknown under the prefix lands on the workspace hub
  return { page: "home" };
}

interface AuthUser {
  authed: boolean;
  email?: string;
  name?: string;
  role?: string;
  emailVerified?: boolean;
  /** owner of this instance (admin, or the first account of a self-hosted copy) */
  canSetup?: boolean;
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [cloudPath, setCloudPath] = useState(DEFAULT_CLOUD_PATH);
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname, DEFAULT_CLOUD_PATH));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [welcomeShownSession, setWelcomeShownSession] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const isMobile = useIsMobile();
  const [mobileWarnHidden, setMobileWarnHidden] = useState(mobileWarnDismissed);
  const dismissMobileWarn = useCallback(() => {
    setMobileWarnHidden(true);
    try {
      sessionStorage.setItem(MOBILE_WARN_KEY, "1");
    } catch {
      /* storage blocked — hidden for this page view only */
    }
  }, []);
  // Bumped to show the cookie banner again after “change choice” in Settings.
  const [cookieReopen, setCookieReopen] = useState(0);
  // Set when a visitor clicks “Open the cloud workspace” on the welcome page:
  // after logging in they continue into the workspace hub instead of returning
  // to the welcome page.
  const [authIntent, setAuthIntent] = useState<"cloud" | null>(null);
  // One-time tokens arriving from an e-mailed link: ?reset=<token> opens the
  // “choose a new password” form, ?verify=<token> confirms the e-mail address.
  const [resetToken, setResetToken] = useState<string | null>(() => new URLSearchParams(window.location.search).get("reset"));
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null);
  const [publicConfig, setPublicConfig] = useState<{ siteName?: string; siteTagline?: string; authBanner?: string; hideLegalAndPro?: boolean; betaBanner?: boolean; cloudPath?: string }>({});
  // Admin switch: removes the Pro page and every legal page/link from the site.
  const hideLegalAndPro = !!publicConfig.hideLegalAndPro;
  // remembers the workflow you were working on, so switching tabs returns to it
  const [lastWorkflowId, setLastWorkflowId] = useState<string | null>(null);
  // null = checking the session; { authed:false } = not logged in → login screen
  const [user, setUser] = useState<AuthUser | null>(null);
  const [deactivatedReason, setDeactivatedReason] = useState<string | null>(null);
  // A self-hosted copy's licence (server/license.js): when it is not active the
  // whole workspace is replaced by the lock screen. Always active in the cloud.
  const [license, setLicense] = useState<LicenseState | null>(null);
  useEffect(() => {
    if (!user?.authed) return;
    api.license
      .status()
      .then(setLicense)
      .catch(() => setLicense(null));
  }, [user?.authed, user?.email]);

  useEffect(() => {
    api
      .nodes()
      .then(setCatalog)
      .catch((err) => setCatalogError(String((err as Error).message || err)));
  }, []);
  useEffect(() => {
    api.auth
      .config()
      .then((config) => {
        setPublicConfig(config);
        setProSalesOpen(config.salesOpen !== false);
        // The workspace path is operator-configurable, so once it is known the
        // current URL is re-parsed against it.
        const cloud = normalizeCloudPath(config.cloudPath);
        setCloudPath(cloud);
        setRouteCloudPath(cloud);
        setRoute(parsePath(window.location.pathname, cloud));
      })
      .catch(() => {});
  }, []);

  // Confirm an e-mail from the link, then clean the token out of the URL. The
  // link also signs the account in, so the session is only read afterwards —
  // asking first could race the confirmation and report "logged out".
  useEffect(() => {
    const loadSession = () =>
      api.auth
        .me()
        .then(setUser)
        .catch(() => setUser({ authed: false }));
    const token = new URLSearchParams(window.location.search).get("verify");
    if (!token) {
      loadSession();
      return;
    }
    api.auth
      .verifyEmail(token)
      .then((res) =>
        setVerifyNotice(
          res.authed
            ? `✓ E-mail ${res.email || "address"} confirmed — welcome to W flow!`
            : `✓ E-mail ${res.email || "address"} verified — you can log in now.`
        )
      )
      .catch((err) => setVerifyNotice(`✗ ${String((err as Error).message || err)}`))
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("verify");
        window.history.replaceState({}, "", url.toString());
        loadSession();
      });
  }, []);

  // A reset link opens the login card straight in “choose a new password” mode.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("reset")) setAuthOpen(true);
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname, cloudPath));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [cloudPath]);

  // remember the workflow currently being edited
  useEffect(() => {
    if (route.page === "workflows" && route.id) setLastWorkflowId(route.id);
  }, [route]);

  // open the Settings modal on a specific tab (used by the editor's Guide
  // button and by components that link into the tutorial)
  const openSettings = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  // “Change choice” in Settings → General: forget the saved decision and show
  // the cookie banner again so a new one can be made.
  const openCookieSettings = useCallback(() => {
    clearCookieConsent();
    setCookieReopen((n) => n + 1);
  }, []);

  // First-run wizard: show the short Getting Started tutorial the first time an
  // account is used on this browser (once per session, then marked as seen).
  useEffect(() => {
    if (user?.authed && !welcomeShownSession) {
      if (!hasSeenWelcome()) {
        setWelcomeOpen(true);
      }
      setWelcomeShownSession(true);
    }
  }, [user, welcomeShownSession]);

  // pushState (not replaceState) so the Back button works; a same-path click is
  // a no-op instead of piling up history entries.
  const pushPath = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  }, []);

  // The main page (`/home`): the workspace hub with the tool switcher. Used by
  // the logo, the Home tab and every “Open the cloud workspace” button.
  // NOTE: nothing links to the welcome page (`/`) inside the app — it is the
  // pre-login page and signed-in accounts only reach it by opening / directly.
  const goHome = useCallback(() => {
    setRoute({ page: "home" });
    pushPath(HUB_PATH);
  }, [pushPath]);

  const nav = useCallback(
    (page: Page, id?: string, forceList = false) => {
      // a bare "workflows" nav reopens the workflow you were last editing
      if (page === "workflows" && !id && !forceList && lastWorkflowId) id = lastWorkflowId;
      // update state directly (instant) AND sync the URL (shareable/bookmarkable)
      setRoute({ page, id });
      const base = `/${cloudPath}`;
      let path: string;
      if (page === "home") path = HUB_PATH;
      else if (page === "setup") path = "/setup";
      else if (page === "team") path = "/team";
      else if (page === "workflows") path = id ? `${base}/workflow/${id}` : `${base}/workflows`;
      else if (page === "community") path = `${base}/user-templates`;
      else if (page === "community-post") path = `${base}/user-templates/${id}`;
      else if (page === "profile") path = id ? `${base}/profile/${encodeURIComponent(id)}` : `${base}/profile`;
      else if (page === "subscription") path = `${base}/subscription`;
      else if (page === "contact") path = `${base}/contact`;
      else if (page === "credentials") path = `${base}/credentials`;
      else if (page === "executions") path = `${base}/executions`;
      else if (page === "variables") path = `${base}/variables`;
      else if (page === "datatables") path = `${base}/data-tables`;
      else if (page === "files") path = `${base}/files`;
      else path = id ? `${base}/agent/${id}` : `${base}/agents`;
      pushPath(path);
    },
    [lastWorkflowId, cloudPath, pushPath]
  );

  // Open the dashboard focused on one folder (used by the editor's clickable
  // breadcrumb path). Passing no id lands on the workflow list root.
  const openFolder = useCallback(
    (folderId?: string) => {
      setRoute({ page: "workflows", folderId: folderId || undefined });
      const path = folderId ? `/${cloudPath}/workflows/folder/${encodeURIComponent(folderId)}` : `/${cloudPath}/workflows`;
      pushPath(path);
    },
    [cloudPath, pushPath]
  );

  // Top navigation is intentionally short: the workspace tools (workflows,
  // agents, credentials, executions, variables, data tables) live on the main
  // page (`/home`), so the bar is Home / User Templates / Pro.
  const navItems = useMemo(
    () => [
      { key: "home", label: "Home", icon: House, active: !route.landing && route.page === "home", go: () => nav("home") },
      { key: "community", label: "User Templates", icon: Users, active: route.page === "community", go: () => nav("community") },
      // Instance settings — only the owner of this copy sees the tab.
      ...(user?.canSetup
        ? [{ key: "setup", label: "Setup", icon: Wrench, active: route.page === "setup", go: () => nav("setup") }]
        : []),
      // The team admin page exists on self-hosted copies only, for their owner.
      ...(license?.required && license.isOwner
        ? [{ key: "team", label: "Team", icon: ShieldCheck, active: route.page === "team", go: () => nav("team") }]
        : []),
      ...(hideLegalAndPro
        ? []
        : [{ key: "subscription", label: "Pro", icon: CreditCard, active: route.page === "subscription", go: () => nav("subscription") }]),
    ],
    [route, hideLegalAndPro, nav, user?.canSetup, license?.required, license?.isOwner]
  );

  const handleAuthed = useCallback(
    (u: { email: string; name: string; role?: string; emailVerified?: boolean }) => {
      setDeactivatedReason(null);
      setUser({ authed: true, email: u.email, name: u.name, role: u.role, emailVerified: u.emailVerified });
      // start fresh: clear the remembered workflow so the dashboard is shown
      setLastWorkflowId(null);
      // The login response does not carry the instance role, so ask the session
      // what it may do — this is what shows the Setup tab for the owner.
      api.auth
        .me()
        .then((me) =>
          setUser((prev) =>
            prev ? { ...prev, canSetup: me.canSetup, role: me.role ?? prev.role, emailVerified: me.emailVerified ?? prev.emailVerified } : prev
          )
        )
        .catch(() => {});
      // A visitor who came in through “Open the cloud workspace” lands in the
      // workspace hub directly instead of on the welcome page.
      if (authIntent === "cloud") {
        setAuthIntent(null);
        setRoute({ page: "home" });
        pushPath(HUB_PATH);
      }
    },
    [authIntent, pushPath]
  );

  // "Back" returns to wherever the user came from (top bar, welcome page, a
  // post …); a page opened directly from a link falls back to `fallback`.
  const goBack = useCallback(
    (fallback: Page) => {
      // pushPath() stores {} as history state, so a non-null state means the
      // previous entry is an in-app page; a fresh page load has state null.
      if (window.history.state !== null && window.history.length > 1) window.history.back();
      else nav(fallback);
    },
    [nav]
  );

  // The Pro page is switched off by the admin → never render a blank page.
  useEffect(() => {
    if (hideLegalAndPro && route.page === "subscription") {
      setRoute({ page: "home" });
      pushPath(HUB_PATH);
    }
  }, [hideLegalAndPro, route.page, pushPath]);

  const handleLogout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* ignore */
    }
    setUser({ authed: false });
    setDeactivatedReason(null);
    setLastWorkflowId(null);
  }, []);

  // waiting for the session check
  if (user === null) {
    return (
      <div className="boot">
        <div className="boot-line">Loading W flow…</div>
        <div className="boot-line dim">checking session…</div>
      </div>
    );
  }

  // Visitors can inspect the public W flow shell. Private workflow data and
  // all execution APIs remain protected server-side; the shell opens auth only
  // when a visitor chooses a protected area.
  if (!user.authed) {
    if (deactivatedReason) {
      return <DeactivatedPage reason={deactivatedReason} onBack={() => setDeactivatedReason(null)} />;
    }
    return (
      <>
        {verifyNotice && (
          <div className="verify-banner" role="status">
            <span>{verifyNotice}</span>
            <button className="verify-banner-x" onClick={() => setVerifyNotice(null)} title="Dismiss">
              ×
            </button>
          </div>
        )}
        <PublicHome
          catalog={catalog}
          {...publicConfig}
          hideLegalAndPro={hideLegalAndPro}
          resetToken={resetToken || undefined}
          onResetDone={() => {
            // the token is spent: close reset mode and drop ?reset= from the URL
            setResetToken(null);
            const url = new URL(window.location.href);
            url.searchParams.delete("reset");
            window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
          }}
          authOpen={authOpen}
          onAuthOpen={() => setAuthOpen(true)}
          onAuthClose={() => setAuthOpen(false)}
          onEnterCloud={() => {
            setAuthIntent("cloud");
            setAuthOpen(true);
          }}
          onAuthed={(u) => {
            setAuthOpen(false);
            handleAuthed(u);
          }}
          onDeactivated={(reason) => {
            setAuthOpen(false);
            setDeactivatedReason(reason);
          }}
        />
        <CookieConsent hideLegal={hideLegalAndPro} reopenToken={cookieReopen} />
      </>
    );
  }

  // A self-hosted copy without an active licence shows only its lock screen.
  if (license?.required && !license.active) {
    return <LicensePage license={license} onChange={setLicense} onLogout={handleLogout} />;
  }

  // The welcome page (`/`) is shown after login too: product overview, account
  // and subscription management, the entries into the cloud workspace and the
  // self-hosted download. Legal links appear here (and in the cookie banner) only.
  if (route.landing) {
    return (
      <>
        {verifyNotice && (
          <div className="verify-banner" role="status">
            <span>{verifyNotice}</span>
            <button className="verify-banner-x" onClick={() => setVerifyNotice(null)} title="Dismiss">
              ×
            </button>
          </div>
        )}
        <MainHubPage
          user={user}
          catalog={catalog}
          {...publicConfig}
          hideLegalAndPro={hideLegalAndPro}
          onOpenCloud={goHome}
          onOpenTemplates={() => nav("community")}
          onOpenSubscription={() => nav("subscription")}
          onOpenProfile={() => nav("profile")}
          onOpenSettings={() => openSettings("general")}
          onOpenContact={() => nav("contact")}
          onLogout={handleLogout}
        />
        {settingsOpen && (
          <SettingsModal
            onClose={() => setSettingsOpen(false)}
            user={user}
            onUserChange={(u) => setUser((prev) => ({ authed: true, ...prev, ...u }))}
            initialTab={settingsTab}
            onOpenContact={() => {
              setSettingsOpen(false);
              nav("contact");
            }}
            onOpenCookieSettings={openCookieSettings}
          />
        )}
        <CookieConsent hideLegal={hideLegalAndPro} reopenToken={cookieReopen} />
      </>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={goHome} title="Home">
          <img className="brand-logo" src="/logo.png" alt="W" />
          <span className="brand-name">
            W <span className="brand-dim">flow</span>
          </span>
        </div>

        <nav className="topnav">
          {navItems.map(({ key, label, icon: Icon, active, go }) => (
            <button key={key} className={`navbtn ${active ? "active" : ""}`} onClick={go}>
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <button className="topbar-settings" onClick={() => setSettingsOpen(true)} title="Settings">
            <SettingsIcon size={14} /> Settings
          </button>
          {/* Profile button (top right): opens your public profile + editor. */}
          <button
            className={`topbar-user topbar-profile ${route.page === "profile" ? "active" : ""}`}
            onClick={() => nav("profile")}
            title={`${user.email || ""} — view and edit your profile`}
          >
            <UserRound size={13} />
            {user.name || user.email?.split("@")[0] || "user"}
          </button>
          <button className="topbar-settings" onClick={handleLogout} title="Log out">
            <LogOut size={14} /> Log out
          </button>
        </div>
      </header>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          user={user}
          onUserChange={(u) => setUser((prev) => ({ authed: true, ...prev, ...u }))}
          initialTab={settingsTab}
          onOpenContact={() => {
            setSettingsOpen(false);
            nav("contact");
          }}
          onOpenCookieSettings={openCookieSettings}
          hideLegal={hideLegalAndPro}
        />
      )}

      {welcomeOpen && (
        <WelcomeWizard
          onOpenTutorial={() => {
            setWelcomeOpen(false);
            markWelcomeSeen();
            openSettings("tutorial");
          }}
          onClose={() => {
            setWelcomeOpen(false);
            markWelcomeSeen();
          }}
        />
      )}

      {verifyNotice && (
        <div className="verify-banner" role="status">
          <span>{verifyNotice}</span>
          <button className="verify-banner-x" onClick={() => setVerifyNotice(null)} title="Dismiss">
            ×
          </button>
        </div>
      )}

      {/* a self-hosted copy tells its owner when a new version is out */}
      {license?.required && license.isOwner && route.page !== "setup" && <UpdateBanner onOpenSetup={() => nav("setup")} />}

      {/* The subscription page is one of the things phones are meant for, so it
          opens without the warning. */}
      {isMobile && !mobileWarnHidden && route.page !== "subscription" && (
        <div className="verify-banner mobile-warn-banner" role="status">
          <span>
            You are using the workspace on a mobile device. It is built for a computer, so some parts may not work
            properly here.
          </span>
          <button className="verify-banner-x" onClick={dismissMobileWarn} title="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="main">
        {catalogError ? (
          <div className="boot">
            <div className="boot-line" style={{ color: "var(--red)" }}>✗ Cannot reach the W flow API</div>
            <div className="boot-line dim">{catalogError}</div>
            <pre
              className="boot-line dim"
              style={{
                border: "1px dashed var(--line-strong)",
                padding: "14px 22px",
                textAlign: "left",
                lineHeight: 1.9,
                fontSize: 12,
                color: "var(--ink)",
              }}
            >
              {`Start the server, then open this page again:\n\n  npm run dev      →  http://localhost:5173\n  npm start        →  http://localhost:3001\n\n(Opening index.html directly as a file:// page will not work —\nthe UI is served by the Node backend and needs the API running.)`}
            </pre>
          </div>
        ) : !catalog ? (
          <div className="boot">
            <div className="boot-line">Loading W flow…</div>
            <div className="boot-line dim">starting…</div>
          </div>
        ) : route.page === "workflows" && route.id ? (
          <WorkflowEditor
            key={route.id}
            workflowId={route.id}
            catalog={catalog}
            onBack={() => nav("workflows", undefined, true)}
            onOpenHelp={() => openSettings("tutorial")}
            onOpenFolder={openFolder}
          />
        ) : route.page === "setup" ? (
          <SetupPage />
        ) : route.page === "team" ? (
          <TeamPage />
        ) : route.page === "contact" ? (
          <ContactPage user={user} onBack={() => goBack("home")} />
        ) : route.page === "community" ? (
          <CommunityPage
            onOpen={(id) => nav("workflows", id)}
            onOpenPost={(postId) => nav("community-post", postId)}
            onOpenProfile={(userId) => nav("profile", userId)}
          />
        ) : route.page === "community-post" && route.id ? (
          <CommunityPostPage
            postId={route.id}
            onOpen={(workflowId) => nav("workflows", workflowId)}
            onOpenProfile={(userId) => nav("profile", userId)}
            onBack={() => nav("community")}
          />
        ) : route.page === "profile" ? (
          <ProfilePage
            userId={route.id}
            onOpenPost={(postId) => nav("community-post", postId)}
            onOpen={(workflowId) => nav("workflows", workflowId)}
            onBack={() => goBack("community")}
          />
        ) : route.page === "subscription" && !hideLegalAndPro ? (
          <SubscriptionPage />
        ) : hubPage(route.page) ? (
          <HomePage
            userName={user.name || user.email?.split("@")[0]}
            catalog={catalog}
            betaBanner={!!publicConfig.betaBanner}
            selected={hubPage(route.page)!}
            agentId={route.page === "agents" ? route.id : undefined}
            initialFolderId={route.page === "workflows" ? route.folderId : undefined}
            // forceList: the workspace hub's Workflows button shows the list,
            // never jumps straight back into the last opened workflow.
            onSelect={(page) => nav(page, undefined, true)}
            onOpenWorkflow={(id) => nav("workflows", id)}
            onOpenGuide={() => openSettings("tutorial")}
            onOpenContact={() => nav("contact")}
          />
        ) : null}
      </main>

      <CookieConsent hideLegal={hideLegalAndPro} reopenToken={cookieReopen} />
    </div>
  );
}
