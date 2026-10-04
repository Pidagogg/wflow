import { useEffect, useMemo, useState } from "react";
import { AiBudgetPanel, AiUsagePanel } from "./AiSpending";
import { BookOpen, Bot, ChartLine, Cpu, Download, GraduationCap, KeyRound, Lock, Mail, Plus, Scale, Search, ShieldCheck, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { AiPriceSettings, ErrorCodeEntry, SelfhostStatus } from "../types";
import SelfHostLicense from "./SelfHostLicense";
import { api, INSTALLER_OSES } from "../api";
import { getSettings, setSettings, type AppSettings, SETTINGS_KEY } from "../settings";
import { navigateWorkspace } from "../routes";
import { getCookieConsent } from "./CookieConsent";
import { proCtaLabel } from "../proStatus";
import { DashboardsTab, McpTab } from "./SettingsExtras";

export type SettingsTab = "general" | "account" | "tutorial" | "errors" | "ai" | "mcp" | "dashboards";

interface Props {
  onClose: () => void;
  /** the logged-in account (email / display name / verification state) */
  user?: { email?: string; name?: string; emailVerified?: boolean };
  /** called after the account credentials change so the topbar updates */
  onUserChange?: (u: { email: string; name: string }) => void;
  /** which tab to open with (e.g. "tutorial") */
  initialTab?: SettingsTab;
  /** opens the contact form page (button at the bottom of the settings menu) */
  onOpenContact?: () => void;
  /** reopen the cookie consent banner so the visitor can change their choice */
  onOpenCookieSettings?: () => void;
  /** the operator hid the legal pages (admin switch) */
  hideLegal?: boolean;
}

export default function SettingsModal({ onClose, user, onUserChange, initialTab, onOpenContact, onOpenCookieSettings, hideLegal }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab || "general");
  // AI usage & cost is three views: the dashboard, the budgets and the price table.
  const [aiSection, setAiSection] = useState<"usage" | "budgets" | "prices">("usage");
  // account form state
  const [acctName, setAcctName] = useState(user?.name || "");
  const [acctEmail, setAcctEmail] = useState(user?.email || "");
  const [acctCurrent, setAcctCurrent] = useState("");
  const [acctNext, setAcctNext] = useState("");
  const [acctBusy, setAcctBusy] = useState(false);
  const [acctMsg, setAcctMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // e-mail verification / data export / account deletion
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [delPassword, setDelPassword] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delMsg, setDelMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [settings, setSettingsState] = useState<AppSettings>(getSettings());
  // the visitor's saved cookie decision (shown on the general tab)
  const [cookieChoice, setCookieChoice] = useState(getCookieConsent());
  const [errors, setErrors] = useState<ErrorCodeEntry[] | null>(null);
  const [errLoading, setErrLoading] = useState(false);
  const [errFail, setErrFail] = useState<string | null>(null);
  const [openCode, setOpenCode] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // AI usage & cost — the account's editable USD-per-1M-token price table.
  const [aiPrices, setAiPrices] = useState<AiPriceSettings | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newModel, setNewModel] = useState("");
  // “Run it self-hosted” — Pro accounts download a one-file installer that
  // brings the whole builder onto their own machine.
  const [selfhost, setSelfhost] = useState<SelfhostStatus | null>(null);
  const [selfhostMsg, setSelfhostMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // filter error codes by BF-<number>, short description, full description, or tips
  const filteredErrors = useMemo(() => {
    if (!errors) return null;
    const q = query.trim().toLowerCase();
    if (!q) return errors;
    return errors.filter((e) =>
      String(e.code).toLowerCase().includes(q) ||
      `bf-${e.code}`.includes(q) ||
      e.short.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      (e.tips || []).some((t) => t.toLowerCase().includes(q))
    );
  }, [errors, query]);

  useEffect(() => {
    if (tab !== "errors" || errors || errLoading) return;
    setErrLoading(true);
    setErrFail(null);
    api
      .errors()
      .then(setErrors)
      .catch((e) => setErrFail(String((e as Error).message || e)))
      .finally(() => setErrLoading(false));
  }, [tab, errors, errLoading]);

  useEffect(() => {
    if (tab !== "ai" || aiPrices || aiLoading) return;
    setAiLoading(true);
    setAiMsg(null);
    api.aiPrices
      .get()
      .then(setAiPrices)
      .catch((e) => setAiMsg({ ok: false, text: String((e as Error).message || e) }))
      .finally(() => setAiLoading(false));
  }, [tab, aiPrices, aiLoading]);

  useEffect(() => {
    if (tab !== "general" || selfhost) return;
    api.selfhosted
      .info()
      .then(setSelfhost)
      .catch((e) =>
        setSelfhost({ pro: false, ready: false, reason: String((e as Error).message || e), port: 3001 })
      );
  }, [tab, selfhost]);

  // Which of the three installers this visitor needs: a Windows .bat, a macOS
  // .command (double-clickable in Finder) or a Linux .sh. The button names the
  // platform so it is obvious which file just landed in Downloads.
  const installerOs: "windows" | "mac" | "linux" = /Windows/i.test(navigator.userAgent)
    ? "windows"
    : /Mac OS X|Macintosh/i.test(navigator.userAgent)
    ? "mac"
    : "linux";
  const installerPlatform = installerOs === "windows" ? "Windows" : installerOs === "mac" ? "macOS" : "Linux";

  // Start the installer download and open the address the local copy will serve.
  // Both happen in the click handler (no await in between) so the browser treats
  // the new tab as user-initiated and does not block it. `os` defaults to the
  // visitor's own platform; the other two are one click away as well.
  const downloadSelfhost = (os: "windows" | "mac" | "linux" = installerOs) => {
    if (!selfhost?.ready) return;
    const link = document.createElement("a");
    link.href = api.selfhosted.installerUrl(os);
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
    const local = `http://localhost:${selfhost.port}`;
    window.open(local, "_blank");
    setSelfhostMsg({
      ok: true,
      text: `Installer downloading — run it, then the tab that just opened (${local}) shows your own copy.`,
    });
  };

  const setAiPrice = (model: string, key: "input" | "output", value: number) => {
    const safe = Number.isFinite(value) && value >= 0 ? value : 0;
    setAiPrices((p) =>
      p ? { ...p, prices: { ...p.prices, [model]: { ...(p.prices[model] || { input: 0, output: 0 }), [key]: safe } } } : p
    );
  };

  const removeAiModel = (model: string) => {
    setAiPrices((p) => {
      if (!p) return p;
      const next = { ...p.prices };
      delete next[model];
      return { ...p, prices: next };
    });
  };

  const addAiModel = () => {
    const name = newModel.trim().toLowerCase();
    if (!name) return;
    setAiPrices((p) =>
      p ? { ...p, prices: { ...p.prices, [name]: p.prices[name] || (p.presets[name] ? { ...p.presets[name] } : { input: 0, output: 0 }) } } : p
    );
    setNewModel("");
  };

  // Bring in every preset the table does not have yet (handy on a fresh account).
  const addMissingPresets = () => {
    setAiPrices((p) => {
      if (!p) return p;
      const prices = { ...p.prices };
      let added = 0;
      for (const [model, price] of Object.entries(p.presets || {})) {
        if (!prices[model]) {
          prices[model] = { ...price };
          added += 1;
        }
      }
      if (!added) setAiMsg({ ok: true, text: "Every preset model is already in the table." });
      return { ...p, prices };
    });
  };

  const saveAiPrices = () => {
    if (!aiPrices) return;
    setAiSaving(true);
    setAiMsg(null);
    api.aiPrices
      .save({ prices: aiPrices.prices, fallback: aiPrices.fallback })
      .then((saved) => {
        setAiPrices((p) => (p ? { ...p, prices: saved.prices, fallback: saved.fallback } : p));
        setAiMsg({ ok: true, text: "Price table saved — runs recorded from now on are priced with it." });
      })
      .catch((e) => setAiMsg({ ok: false, text: String((e as Error).message || e) }))
      .finally(() => setAiSaving(false));
  };

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettingsState(next);
    setSettings({ [key]: value });
  };

  const downloadPdf = () => {
    // The server renders docs/guide.md to a PDF (GET /api/docs/pdf) and sends
    // it as an attachment; the download attribute just names the file.
    const a = document.createElement("a");
    a.href = "/api/docs/pdf";
    a.download = "wflow-user-guide.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadErrors = () => {
    /* ERRORS.md is served from the project root by the Express static handler
       only after `npm run build`; in production the built UI + app also expose
       it via /ERRORS.md. Fall back to rendering from the loaded catalog. */
    const entries = errors || [];
    const md = [
      "# W flow — Error Code Reference",
      "",
      ...entries.map(
        (e) =>
          `## BF-${e.code} — ${e.short}\n\n${e.description}\n\n**Troubleshooting**\n${(e.tips || [])
            .map((t, i) => `${i + 1}. ${t}`)
            .join("\n")}`
      ),
    ].join("\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ERRORS.md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="modal modal-settings" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">Settings</div>
            <div className="modal-sub">Default behaviour and the error-code reference.</div>
          </div>
          <button className="modal-x" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === "general" ? "active" : ""}`} onClick={() => setTab("general")}>
            <SlidersHorizontal size={12} /> Defaults
          </button>
          <button className={`settings-tab ${tab === "tutorial" ? "active" : ""}`} onClick={() => setTab("tutorial")}>
            <GraduationCap size={12} /> Tutorial
          </button>
          <button className={`settings-tab ${tab === "account" ? "active" : ""}`} onClick={() => setTab("account")}>
            <KeyRound size={12} /> Account
          </button>
          <button className={`settings-tab ${tab === "ai" ? "active" : ""}`} onClick={() => setTab("ai")}>
            <Cpu size={12} /> AI usage &amp; cost
          </button>
          <button className={`settings-tab ${tab === "mcp" ? "active" : ""}`} onClick={() => setTab("mcp")}>
            <Bot size={12} /> AI tools
          </button>
          <button className={`settings-tab ${tab === "dashboards" ? "active" : ""}`} onClick={() => setTab("dashboards")}>
            <ChartLine size={12} /> Dashboards
          </button>
          <button className={`settings-tab ${tab === "errors" ? "active" : ""}`} onClick={() => setTab("errors")}>
            <BookOpen size={12} /> Error codes <span className="count">{errors ? errors.length : "…"}</span>
          </button>
        </div>

        <div className="settings-body">
          {tab === "general" && (
            <>
              <div className="settings-intro">
                These defaults apply to every workflow editor session.
              </div>

              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Open node config on click</div>
                  <div className="settings-row-sub">Single click opens a node's editor. Turn off to require a double click — handy if you drag nodes a lot and it opens by accident.</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={settings.openNodeOnClick} onChange={(e) => set("openNodeOnClick", e.target.checked)} />
                  <span className="toggle-track" />
                  <span className="toggle-label">{settings.openNodeOnClick ? "ON" : "OFF"}</span>
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Auto-save</div>
                  <div className="settings-row-sub">Save the workflow automatically shortly after every change. Off replaces this with the manual Save button (Ctrl/Cmd+S still works).</div>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={settings.autoSave} onChange={(e) => set("autoSave", e.target.checked)} />
                  <span className="toggle-track" />
                  <span className="toggle-label">{settings.autoSave ? "ON" : "OFF"}</span>
                </label>
              </div>

              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Maximum log items per node</div>
                  <div className="settings-row-sub">How many input/output items the Log console shows for each node after a run.</div>
                </div>
                <div className="settings-number">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={settings.maxLogItems}
                    onChange={(e) => set("maxLogItems", Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  />
                </div>
              </div>

              <div className="settings-section-head">Run it self-hosted</div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">
                    Self-hosted copy of W flow
                    {selfhost && !selfhost.pro && (
                      <span className="tag" style={{ marginLeft: 8, color: "var(--amber)", borderColor: "color-mix(in srgb, var(--amber) 45%, transparent)" }}>
                        PRO
                      </span>
                    )}
                  </div>
                  <div className="settings-row-sub">
                    Download the one-file installer for <b>{installerPlatform}</b> (also available for Windows, macOS and
                    Linux), run it on your own machine or server and the builder serves itself at{" "}
                    <code>http://localhost:{selfhost?.port ?? 3001}</code> — workflows, agents, credentials and the database stay
                    on that machine. The download link inside the installer is valid for 24 hours.
                  </div>
                  {selfhost && !selfhost.ready && <div className="field-help">{selfhost.reason}</div>}
                  {selfhostMsg && (
                    <div className={`settings-account-msg ${selfhostMsg.ok ? "ok" : "err"}`}>
                      {selfhostMsg.ok ? "✓ " : "✗ "}
                      {selfhostMsg.text}
                    </div>
                  )}
                  {selfhost?.pro && <SelfHostLicense notify={(text, kind) => setSelfhostMsg({ ok: kind !== "err", text })} />}
                </div>
                {selfhost === null ? (
                  <span className="settings-row-sub">Checking…</span>
                ) : selfhost.pro ? (
                  <div className="settings-row-actions">
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => downloadSelfhost(installerOs)}
                      disabled={!selfhost.ready}
                      title={selfhost.ready ? `Download the ${installerPlatform} installer and open your local copy` : selfhost.reason}
                    >
                      <Download size={12} /> Download for {installerPlatform}
                    </button>
                    {INSTALLER_OSES.filter((o) => o.key !== installerOs).map((o) => (
                      <button
                        key={o.key}
                        className="btn btn-sm"
                        onClick={() => downloadSelfhost(o.key)}
                        disabled={!selfhost.ready}
                        title={`Download the ${o.label} installer (.${o.ext})`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="settings-row-actions">
                    <button className="btn btn-sm" disabled title="Downloading the self-hosted installer is a Pro feature">
                      <Lock size={12} /> Pro only
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        navigateWorkspace("subscription");
                        onClose();
                      }}
                    >
                      {proCtaLabel("See Pro")}
                    </button>
                  </div>
                )}
              </div>

              <div className="settings-section-head">Cookies &amp; local storage</div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Cookie choice</div>
                  <div className="settings-row-sub">
                    {cookieChoice
                      ? cookieChoice.choice === "all"
                        ? "You accepted all cookies and local-storage preferences."
                        : "You accepted the technically necessary cookies only."
                      : "You have not decided yet — the banner is shown on your first visit."}
                  </div>
                </div>
                <div className="settings-row-actions">
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      onOpenCookieSettings?.();
                      setCookieChoice(getCookieConsent());
                    }}
                  >
                    Change choice
                  </button>
                </div>
              </div>

              <div className="settings-section-head">Where are settings stored?</div>
              <div className="settings-storage">
                These preferences are stored in this browser under <code>localStorage</code> (key <code>{SETTINGS_KEY}</code>).
                Saving workflows, nodes and agents happens on the server in <code>./data/</code>.
              </div>
            </>
          )}

          {tab === "account" && (
            <>
              <div className="settings-intro">
                Change the credentials for this account — the data lives in the SQL database (table <code>users</code>).
              </div>

              <div className="settings-section-head">Profile</div>
              <div className="settings-account-form">
                <div className="field">
                  <div className="field-label">Name</div>
                  <input value={acctName} onChange={(e) => setAcctName(e.target.value)} placeholder="Your name" autoComplete="name" />
                </div>
                <div className="field">
                  <div className="field-label">Email</div>
                  <input value={acctEmail} onChange={(e) => setAcctEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
                </div>
              </div>

              <div className="settings-section-head">Change password</div>
              <div className="settings-account-form">
                <div className="field">
                  <div className="field-label">Current password</div>
                  <input value={acctCurrent} type="password" onChange={(e) => setAcctCurrent(e.target.value)} autoComplete="current-password" placeholder="needed to set a new password" />
                </div>
                <div className="field">
                  <div className="field-label">New password (min 8 characters)</div>
                  <input value={acctNext} type="password" onChange={(e) => setAcctNext(e.target.value)} autoComplete="new-password" placeholder="leave empty to keep" />
                </div>
              </div>

              {acctMsg && (
                <div className={`settings-account-msg ${acctMsg.ok ? "ok" : "err"}`}>
                  {acctMsg.ok ? "✓ " : "✗ "}
                  {acctMsg.text}
                </div>
              )}

              <button
                className="btn btn-primary"
                disabled={acctBusy}
                onClick={async () => {
                  setAcctBusy(true);
                  setAcctMsg(null);
                  try {
                    const res = await api.auth.account({
                      name: acctName,
                      email: acctEmail,
                      current: acctCurrent,
                      next: acctNext,
                    });
                    onUserChange?.({ email: res.email, name: res.name });
                    setAcctCurrent("");
                    setAcctNext("");
                    setAcctMsg({ ok: true, text: res.message || "Account updated." });
                  } catch (err) {
                    setAcctMsg({ ok: false, text: String((err as Error).message || err) });
                  } finally {
                    setAcctBusy(false);
                  }
                }}
              >
                {acctBusy ? "Saving…" : "Save account"}
              </button>

              <div className="settings-section-head">E-mail verification</div>
              <div className="settings-account-form">
                <div className={`settings-account-msg ${user?.emailVerified ? "ok" : "err"}`}>
                  {user?.emailVerified
                    ? "✓ Your e-mail address is verified."
                    : "Your e-mail address is not verified yet — check your inbox for the confirmation link."}
                </div>
                {!user?.emailVerified && (
                  <button
                    className="btn"
                    disabled={verifyBusy}
                    onClick={async () => {
                      setVerifyBusy(true);
                      setVerifyMsg(null);
                      try {
                        const res = await api.auth.resendVerification();
                        setVerifyMsg(res.verifyLink ? `${res.message} (dev link: ${res.verifyLink})` : res.message);
                      } catch (err) {
                        setVerifyMsg(String((err as Error).message || err));
                      } finally {
                        setVerifyBusy(false);
                      }
                    }}
                  >
                    {verifyBusy ? "Sending…" : "Resend verification e-mail"}
                  </button>
                )}
                {verifyMsg && <div className="settings-hint">{verifyMsg}</div>}
              </div>

              <div className="settings-section-head">Your data</div>
              <div className="settings-account-form">
                <div className="settings-hint">
                  Download everything this account owns (profile, workflows without credentials, agents, run history) as a JSON file.
                </div>
                <a className="btn" href={api.auth.exportUrl()} download="wflow-export.json">
                  <Download size={12} /> DOWNLOAD MY DATA
                </a>
              </div>

              <div className="settings-section-head settings-danger-head">Delete account</div>
              <div className="settings-account-form">
                <div className="settings-hint">
                  Permanently deletes your account, workflows, agents and run history. This cannot be undone. Enter your password to confirm.
                </div>
                <div className="field">
                  <div className="field-label">Password</div>
                  <input
                    type="password"
                    value={delPassword}
                    onChange={(e) => setDelPassword(e.target.value)}
                    placeholder="your current password"
                    autoComplete="current-password"
                  />
                </div>
                {delMsg && (
                  <div className={`settings-account-msg ${delMsg.ok ? "ok" : "err"}`}>
                    {delMsg.ok ? "✓ " : "✗ "}
                    {delMsg.text}
                  </div>
                )}
                <button
                  className="btn btn-danger"
                  disabled={delBusy || !delPassword}
                  onClick={async () => {
                    if (!window.confirm("Delete your account and all of its data? This cannot be undone.")) return;
                    setDelBusy(true);
                    setDelMsg(null);
                    try {
                      const res = await api.auth.deleteAccount(delPassword);
                      setDelMsg({ ok: true, text: res.message });
                      setTimeout(() => window.location.reload(), 1500);
                    } catch (err) {
                      setDelMsg({ ok: false, text: String((err as Error).message || err) });
                    } finally {
                      setDelBusy(false);
                    }
                  }}
                >
                  {delBusy ? "Deleting…" : "Delete my account"}
                </button>
              </div>
            </>
          )}

          {tab === "mcp" && <McpTab />}
          {tab === "dashboards" && <DashboardsTab />}
          {tab === "ai" && (
            <>
              <div className="seg ai-section-tabs">
                <button className={aiSection === "usage" ? "active" : ""} onClick={() => setAiSection("usage")}>Usage</button>
                <button className={aiSection === "budgets" ? "active" : ""} onClick={() => setAiSection("budgets")}>Budgets &amp; alerts</button>
                <button className={aiSection === "prices" ? "active" : ""} onClick={() => setAiSection("prices")}>Prices</button>
              </div>
              {aiSection === "usage" && <AiUsagePanel />}
              {aiSection === "budgets" && <AiBudgetPanel />}
              {aiSection === "prices" && (
              <>
              <div className="settings-intro">
                What a run's model calls cost is estimated from <b>your</b> table — USD per 1M tokens per model. Nothing here is
                billed by W flow; edit the numbers to match your own provider contract.
              </div>

              {aiLoading && <div className="run-loading"><span className="spinner" /> Loading price table…</div>}
              {aiMsg && <div className={`settings-note ${aiMsg.ok ? "ok" : "err"}`}>{aiMsg.text}</div>}

              {aiPrices && (
                <>
                  <div className="ai-price-head">
                    <span>Model</span>
                    <span>Input $/1M</span>
                    <span>Output $/1M</span>
                    <span />
                  </div>
                  <div className="ai-price-list">
                    {Object.keys(aiPrices.prices)
                      .sort()
                      .map((model) => (
                        <div className="ai-price-row" key={model}>
                          <code title={model}>{model}</code>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            aria-label={`Input price for ${model}`}
                            value={aiPrices.prices[model].input}
                            onChange={(e) => setAiPrice(model, "input", Number(e.target.value))}
                          />
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            aria-label={`Output price for ${model}`}
                            value={aiPrices.prices[model].output}
                            onChange={(e) => setAiPrice(model, "output", Number(e.target.value))}
                          />
                          <button className="icon-btn btn-danger" onClick={() => removeAiModel(model)} title={`Remove ${model}`}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    {Object.keys(aiPrices.prices).length === 0 && (
                      <div className="ai-price-empty">No models priced — add one below, or load the presets.</div>
                    )}
                  </div>

                  <div className="ai-price-fallback">
                    <div className="settings-row-info">
                      <div className="settings-row-title">Fallback price</div>
                      <div className="settings-row-sub">
                        Used for a model that is not listed above. Leave both at 0 and an unknown model is reported as
                        “not priced” instead of a wrong number.
                      </div>
                    </div>
                    <div className="ai-price-fallback-inputs">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        aria-label="Fallback input price"
                        value={aiPrices.fallback.input}
                        onChange={(e) => setAiPrices((p) => (p ? { ...p, fallback: { ...p.fallback, input: Number(e.target.value) || 0 } } : p))}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        aria-label="Fallback output price"
                        value={aiPrices.fallback.output}
                        onChange={(e) => setAiPrices((p) => (p ? { ...p, fallback: { ...p.fallback, output: Number(e.target.value) || 0 } } : p))}
                      />
                    </div>
                  </div>

                  <div className="ai-price-add">
                    <input
                      value={newModel}
                      onChange={(e) => setNewModel(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addAiModel()}
                      placeholder="Add a model, e.g. gpt-4o-mini"
                    />
                    <button className="btn btn-sm" onClick={addAiModel} disabled={!newModel.trim()}>
                      <Plus size={12} /> Add model
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={addMissingPresets} title="Add every preset model that is not in the table yet">
                      Load presets
                    </button>
                  </div>

                  <div className="settings-actions">
                    <button className="btn btn-sm btn-primary" onClick={saveAiPrices} disabled={aiSaving}>
                      {aiSaving ? "Saving…" : "Save price table"}
                    </button>
                  </div>
                </>
              )}
              </>
              )}
            </>
          )}

          {tab === "tutorial" && (
            <div className="settings-docs">
              <div className="settings-intro">
                A short tour — build your first workflow in about a minute, then run it for real.
              </div>

              <div className="steps">
                <div className="step">
                  <div className="step-num">1</div>
                  <div className="step-body">
                    <div className="step-title">Open the builder</div>
                    <div className="step-text">Go to the <strong>Workflows</strong> tab and click <strong>New workflow</strong> (or open an existing one). You land in the editor with an empty canvas.</div>
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">2</div>
                  <div className="step-body">
                    <div className="step-title">Add a trigger</div>
                    <div className="step-text">Click <strong>Add node</strong> (toolbar or the <code>+</code> on the canvas), then pick a <em>Manual Trigger</em>. It appears in the middle of the canvas.</div>
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">3</div>
                  <div className="step-body">
                    <div className="step-title">Add a Set node</div>
                    <div className="step-text">Add a <strong>Set / Transform</strong> node. Connect the Manual Trigger to it by dragging from the trigger's right handle to the Set node's left handle.</div>
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">4</div>
                  <div className="step-body">
                    <div className="step-title">Add a Log node &amp; wire it up</div>
                    <div className="step-text">Add a <strong>Console Log</strong> node and connect the Set node to it. This prints a message to the Log console when the workflow runs.</div>
                  </div>
                </div>
                <div className="step">
                  <div className="step-num">5</div>
                  <div className="step-body">
                    <div className="step-title">Run it</div>
                    <div className="step-text">Click <strong>Run</strong> in the toolbar. The Log console at the bottom shows each node's input and output — your chain executed end to end.</div>
                  </div>
                </div>
              </div>

              <div className="settings-section-head">Try manual output</div>
              <div className="doc-section">
                <p>Open any node's settings and toggle on <strong>Manual output</strong> in the <strong>Output</strong> section with a fixed JSON like <code>{"{ \"name\": \"Ada\" }"}</code>. Run again — the node is skipped and downstream nodes receive your fixed data, which is a great way to test a chain without real dependencies.</p>
              </div>
            </div>
          )}

          {tab === "errors" && (
            <>
              <div className="settings-err-toolbar">
                <div className="settings-intro" style={{ margin: 0 }}>
                  Every execution error carries a <code>BF-…</code> code. Pick one to read the full explanation and fix tips.
                </div>
                <button className="btn btn-sm" onClick={downloadErrors} disabled={!errors}>
                  <Download size={12} /> Save ERRORS.md
                </button>
              </div>

              {filteredErrors && (
                <div className="settings-err-search">
                  <Search size={13} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by number or keyword… e.g. 4001, auth, JSON"
                    spellCheck={false}
                  />
                </div>
              )}

              {errLoading && <div className="settings-hint">Loading error codes…</div>}
              {errFail && <div className="settings-hint err">Could not load error codes: {errFail}</div>}

              {filteredErrors && filteredErrors.length === 0 && (
                <div className="settings-hint">No error codes match “{query.trim()}”.</div>
              )}

              {filteredErrors && filteredErrors.length > 0 && (
                <div className="err-list">
                  {query.trim() && filteredErrors.length !== (errors || []).length && (
                    <div className="settings-hint">{filteredErrors.length} of {(errors || []).length} codes match.</div>
                  )}
                  {filteredErrors.map((e) => {
                    const open = openCode === e.code;
                    return (
                      <div key={e.code} className={`err-item ${open ? "open" : ""}`}>
                        <button className="err-item-head" onClick={() => setOpenCode(open ? null : e.code)}>
                          <span className="err-item-code">BF-{e.code}</span>
                          <span className="err-item-short">{e.short}</span>
                          <span className="err-chev">{open ? "−" : "+"}</span>
                        </button>
                        {open && (
                          <div className="err-item-body">
                            <div className="err-item-desc">{e.description}</div>
                            <div className="err-item-tips">
                              <div className="err-item-tips-title">Troubleshooting</div>
                              <ol>
                                {(e.tips || []).map((t, i) => (
                                  <li key={i}>{t}</li>
                                ))}
                              </ol>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Footer of the settings menu: reach the operator directly. */}
          <div className="settings-contact">
            <div className="settings-row-info">
              <div className="settings-row-title">
                <Mail size={12} /> Found a problem? Contact us
              </div>
              <div className="settings-row-sub">
                Fill in the contact form with your e-mail address and a message — it is sent straight to us, and we
                reply to the address you enter.
              </div>
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                onClose();
                onOpenContact?.();
              }}
              disabled={!onOpenContact}
              title="Open the contact form (e-mail + message)"
            >
              <Mail size={12} /> Contact form
            </button>
          </div>
        </div>

        {/* Footer bar, outside the scrolling body so it stays put: the user
            guide PDF, and the legal notice / privacy policy (two clicks away
            from anywhere in the workspace: Settings → Impressum / Privacy). */}
        <nav className="settings-links" aria-label="Documentation and legal">
          <button type="button" onClick={downloadPdf} title="Download the user guide as a PDF file">
            <Download size={12} /> Documentation (PDF)
          </button>
          {!hideLegal && (
            <>
              <a href="/impressum" target="_blank" rel="noopener">
                <Scale size={12} /> Impressum
              </a>
              <a href="/datenschutz" target="_blank" rel="noopener">
                <ShieldCheck size={12} /> Privacy
              </a>
            </>
          )}
        </nav>
      </div>
    </div>
  );
}