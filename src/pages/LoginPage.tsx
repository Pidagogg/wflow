import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { api } from "../api";
import { ServiceBadge } from "../components/ServiceBadge";

interface Props {
  onAuthed: (user: { email: string; name: string; role?: string }) => void;
  onDeactivated?: (reason: string) => void;
  onClose?: () => void;
  /** a reset token from the e-mailed link — opens the “choose a new password” form */
  resetToken?: string;
  /** called once a password reset succeeded (the token is used up) */
  onResetDone?: () => void;
  /** which tab opens first — the mobile welcome screen has separate buttons */
  initialMode?: "login" | "register";
}

type Mode = "login" | "register" | "forgot" | "reset";

// The login is a fetch, not a page navigation, so browsers only guess that it
// succeeded and often skip the "save password?" prompt. Chromium's Credential
// Management API asks for it explicitly; elsewhere the named fields below are
// what Firefox/Safari key on. Never throws — saving is a courtesy.
async function offerToSavePassword(email: string, password: string, name?: string) {
  const Ctor = (window as unknown as { PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential }).PasswordCredential;
  if (!Ctor || !navigator.credentials?.store || !email || !password) return;
  try {
    await navigator.credentials.store(new Ctor({ id: email, password, name: name || undefined }));
  } catch {
    /* user dismissed it or the browser refused — nothing to do */
  }
}

export default function LoginPage({ onAuthed, onDeactivated, onClose, resetToken, onResetDone, initialMode }: Props) {
  const [mode, setMode] = useState<Mode>(resetToken ? "reset" : initialMode || "login");
  // The operator can disable new sign-ups (BF_ALLOW_REGISTER=0) — the server
  // tells us on load, and the register tab / prompt disappears.
  const [allowRegister, setAllowRegister] = useState<boolean | null>(null);
  const [oauth, setOauth] = useState<{ google?: boolean; github?: boolean }>({});
  // Optional Supabase login (server/supabase-auth.js): the social buttons the
  // operator enabled in Supabase, plus the passwordless e-mail option.
  const [supabaseProviders, setSupabaseProviders] = useState<{ id: string; label: string }[]>([]);
  const [supabaseMagicLink, setSupabaseMagicLink] = useState(false);
  useEffect(() => {
    api.auth
      .config()
      .then((c) => {
        setAllowRegister(c.allowRegister);
        setOauth(c.oauth || {});
        setSupabaseProviders(c.supabase?.providers || []);
        setSupabaseMagicLink(!!c.supabase?.magicLink);
      })
      .catch(() => setAllowRegister(true));
  }, []);
  const registerVisible = allowRegister !== false;
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set when a password account still has to open its confirmation link — the
  // card then offers to send that link again.
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  // The server allows one confirmation mail per address per minute; the button
  // counts down instead of inviting clicks that would only be refused.
  const [resendWait, setResendWait] = useState(0);
  useEffect(() => {
    if (resendWait <= 0) return;
    const t = setTimeout(() => setResendWait((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendWait]);
  const [magicEmail, setMagicEmail] = useState("");
  const [magicBusy, setMagicBusy] = useState(false);
  const [magicMsg, setMagicMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Passwordless login: no password, no local account needed — Supabase mails
  // the link and the callback below turns it into a W flow session.
  const requestMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (magicBusy) return;
    setMagicBusy(true);
    setMagicMsg(null);
    try {
      const res = await api.auth.magicLink(magicEmail.trim());
      setMagicMsg({ ok: true, text: res.message });
    } catch (err) {
      setMagicMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setMagicBusy(false);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setNotice(null);
    setUnconfirmedEmail(null);
  };

  const resendConfirmation = async () => {
    if (!unconfirmedEmail || resendBusy || resendWait > 0) return;
    setResendBusy(true);
    setError(null);
    try {
      const res = await api.auth.resendVerificationPublic(unconfirmedEmail);
      setNotice(res.verifyLink ? `${res.message} (dev link: ${res.verifyLink})` : res.message);
      setResendWait(60);
    } catch (err) {
      const details = err as Error & { retryAfter?: number };
      if (details.retryAfter) setResendWait(details.retryAfter);
      setError(String(details.message || err));
    } finally {
      setResendBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setUnconfirmedEmail(null);
    try {
      if (mode === "forgot") {
        const res = await api.auth.forgot(email);
        setNotice(res.resetLink ? `${res.message} (dev link: ${res.resetLink})` : res.message);
        return;
      }
      if (mode === "reset") {
        const res = await api.auth.reset(resetToken || "", password);
        setNotice(res.message);
        setMode("login");
        setPassword("");
        onResetDone?.();
        return;
      }
      if (mode === "register") {
        const res = await api.auth.register(email, password, name);
        // Offer the save now: after confirming via the mailed link the user comes
        // back to an empty login form and would have to retype the new password.
        await offerToSavePassword(email.trim(), password, name.trim());
        if (res.verifyRequired) {
          // No account yet: it is created when the e-mailed link is opened.
          setMode("login");
          setPassword("");
          setUnconfirmedEmail(res.email || email);
          setResendWait(60);
          setNotice(res.verifyLink ? `${res.message} (dev link: ${res.verifyLink})` : res.message || "Check your inbox to confirm your e-mail address.");
          return;
        }
        onAuthed(res);
        return;
      }
      const user = await api.auth.login(email, password);
      await offerToSavePassword(email.trim(), password, user.name);
      onAuthed(user);
    } catch (err) {
      const details = err as Error & { deactivated?: boolean; reason?: string; needsVerification?: boolean };
      if (details.needsVerification) {
        setUnconfirmedEmail(email.trim());
        setError(String(details.message));
      } else if (details.deactivated && onDeactivated) {
        onDeactivated(details.reason || "The account is currently unavailable.");
      } else {
        setError(String(details.message || details));
      }
    } finally {
      setBusy(false);
    }
  };

  const showLoginTabs = mode === "login" || mode === "register";

  return (
    <div className="login-screen" onKeyDown={(e) => e.key === "Escape" && onClose?.()}>
      <div className="login-card" role="dialog" aria-modal="true" aria-label="Log in to W flow">
        {onClose && (
          <button className="modal-x login-close" onClick={onClose} type="button" title="Close authentication">
            ×
          </button>
        )}
        <div className="login-brand">
          <div className="login-brand-row">
            <img className="login-logo" src="/logo.png" alt="W" />
            <span className="login-brand-name">
              W <span style={{ color: "var(--cyan)" }}>flow</span>
            </span>
          </div>
          <div className="login-brand-tag">W flow · self-hosted workflow builder</div>
        </div>

        {showLoginTabs && (
          <div className="login-toggle">
            <button className={`login-tab ${mode === "login" ? "active" : ""}`} onClick={() => switchMode("login")} type="button">
              LOG IN
            </button>
            {registerVisible && (
              <button className={`login-tab ${mode === "register" ? "active" : ""}`} onClick={() => switchMode("register")} type="button">
                CREATE ACCOUNT
              </button>
            )}
          </div>
        )}

        {allowRegister === false && mode === "register" && (
          <div className="login-notice" style={{ marginBottom: 12 }}>
            Sorry, new sign-ups aren’t open yet.
          </div>
        )}

        {(mode === "forgot" || mode === "reset") && (
          <div className="login-titleblock" style={{ marginBottom: 10 }}>
            {mode === "forgot" ? "Reset your password" : "Choose a new password"}
          </div>
        )}

        <form className="login-form" onSubmit={submit}>
          {mode === "register" && (
            <div className="field">
              <div className="field-label">Name (optional)</div>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" />
            </div>
          )}
          {mode !== "reset" && (
            <div className="field">
              <div className="field-label">Email</div>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                id="login-email"
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="username"
                required
              />
            </div>
          )}
          {mode !== "forgot" && (
            <div className="field">
              <div className="field-label">
                {mode === "reset" ? "New password (min 8 characters)" : `Password${mode === "register" ? " (min 8 characters)" : ""}`}
              </div>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                id="login-password"
                name="password"
                type="password"
                placeholder="••••••••"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
              />
            </div>
          )}

          {error && <div className="login-error">✗ {error}</div>}
          {notice && <div className="login-notice">{notice}</div>}
          {unconfirmedEmail && (
            <button className="login-switch" onClick={resendConfirmation} type="button" disabled={resendBusy || resendWait > 0}>
              {resendBusy ? (
                "Sending…"
              ) : resendWait > 0 ? (
                <>Didn't get it? You can resend in {resendWait}s</>
              ) : (
                <>Didn't get it? <b>Resend confirmation e-mail</b></>
              )}
            </button>
          )}

          <button className="btn btn-primary login-submit" type="submit" disabled={busy}>
            {busy
              ? "Wait…"
              : mode === "login"
                ? "Log in"
                : mode === "register"
                  ? "Create account"
                  : mode === "forgot"
                    ? "Send reset link"
                    : "Set new password"}
          </button>
        </form>

        {mode === "login" && (
          <button className="login-switch" onClick={() => switchMode("forgot")} type="button">
            Forgot your password? <b>Reset it</b>
          </button>
        )}
        {(mode === "forgot" || mode === "reset") && (
          <button className="login-switch" onClick={() => switchMode("login")} type="button">
            ← Back to <b>log in</b>
          </button>
        )}
        {mode === "login" && registerVisible && (
          <button className="login-switch" onClick={() => switchMode("register")} type="button">
            No account yet? <b>Create one</b> — it is stored in the SQL database.
          </button>
        )}

        {showLoginTabs && (oauth.google || oauth.github || supabaseProviders.length > 0) && (
          <>
            <div className="login-or">Or continue with</div>
            <div className="login-oauth">
              {oauth.google && (
                <button type="button" className="login-oauth-btn" onClick={() => (window.location.href = api.auth.oauthUrl("google"))}>
                  <ServiceBadge service="google" size={16} />
                  Google
                </button>
              )}
              {oauth.github && (
                <button type="button" className="login-oauth-btn" onClick={() => (window.location.href = api.auth.oauthUrl("github"))}>
                  <ServiceBadge service="github" size={16} />
                  GitHub
                </button>
              )}
              {supabaseProviders.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="login-oauth-btn"
                  onClick={() => (window.location.href = api.auth.supabaseUrl(p.id))}
                >
                  <ServiceBadge service={p.id} size={16} />
                  {p.label}
                </button>
              ))}
            </div>
          </>
        )}

        {showLoginTabs && supabaseMagicLink && (
          <form className="login-form" onSubmit={requestMagicLink} style={{ marginTop: 4 }}>
            <div className="login-or" style={{ marginTop: 0 }}>Or get a sign-in link by e-mail</div>
            <div className="field">
              <input
                value={magicEmail}
                onChange={(e) => setMagicEmail(e.target.value)}
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            {magicMsg && (
              <div className={magicMsg.ok ? "login-notice" : "login-error"}>
                {magicMsg.ok ? "" : "✗ "}
                {magicMsg.text}
              </div>
            )}
            <button className="btn login-submit" type="submit" disabled={magicBusy || !magicEmail.trim()}>
              {magicBusy ? "Sending…" : "E-mail me a sign-in link"}
            </button>
          </form>
        )}

        <div className="login-titleblock">
          <span>W flow</span>
          <span>Private workspace</span>
        </div>

        <div className="login-foot">
          <span className="led led-green" />
          <span className="chip">
            <Cpu size={12} /> SELF-HOSTED · SQL USER DATABASE
          </span>
        </div>

      </div>
    </div>
  );
}
