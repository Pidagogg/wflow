// ============================================================================
// TelegramAccountField — the "Telegram account" picker on Telegram nodes set
// to "Connect as: My Telegram account" (field type "telegramAccount").
//
// A personal account logs in like the Telegram app does: the phone number, the
// code Telegram sends, and the 2-step password when the account has one. The
// login goes through the site's own Telegram app; only when the operator has
// not set one up does the form also ask for the user's API ID and hash.
// Telegram decides how the code travels (app, SMS, call, e-mail, Fragment) and
// sometimes wants a login e-mail set up first — the form says which, and can
// ask for the code another way. The session stays on the server (encrypted);
// the node only stores the connection id.
// TelegramAccountLogin is the login form on its own, reused by the
// Credentials page (Connected accounts).
// ============================================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn, MessageCircle, QrCode, Search } from "lucide-react";
import { api, type OAuthConnection, type TelegramCodeDelivery } from "../api";
import Select from "./Select";
import { SecretInput } from "./SecretInput";

type Chat = { id: string; type: string; title: string; username: string };

export function TelegramAccountLogin({ onConnected, onCancel }: { onConnected: (a: OAuthConnection) => void; onCancel?: () => void }) {
  const [step, setStep] = useState<"details" | "email" | "emailCode" | "code" | "password" | "qr">("details");
  const [qr, setQr] = useState<{ image: string; url: string } | null>(null);
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loginId, setLoginId] = useState("");
  const [delivery, setDelivery] = useState<TelegramCodeDelivery | null>(null);
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailPattern, setEmailPattern] = useState("");
  // seconds until Telegram allows sending the code another way
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null while loading; true only when the site has no Telegram app of its own
  const [needsApiKeys, setNeedsApiKeys] = useState<boolean | null>(null);

  useEffect(() => {
    api.telegramAccounts
      .list()
      .then((r) => setNeedsApiKeys(!!r.needsApiKeys))
      .catch(() => setNeedsApiKeys(false));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  // Telegram may ask for a login e-mail before it sends any code to an app.
  const applyDelivery = (d: TelegramCodeDelivery) => {
    setDelivery(d);
    setCode("");
    setWait(d.timeout || 0);
    setStep(d.kind === "setupEmail" ? "email" : "code");
  };

  const sendCode = () =>
    run(async () => {
      const res = await api.telegramAccounts.login(needsApiKeys ? { apiId, apiHash, phone } : { phone });
      setLoginId(res.loginId);
      applyDelivery(res.delivery);
    });

  // QR login: no code to deliver — the user scans the code in the Telegram app.
  const startQr = () =>
    run(async () => {
      const res = await api.telegramAccounts.qrStart(needsApiKeys ? { apiId, apiHash } : {});
      setLoginId(res.loginId);
      setQr({ image: res.qr, url: res.url });
      setStep("qr");
    });

  // Poll until the scan; an expired code comes back replaced. onConnected is
  // read through a ref so a parent's inline callback does not restart the timer.
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;
  useEffect(() => {
    if (step !== "qr" || !loginId) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await api.telegramAccounts.qrStatus(loginId);
        if (!alive) return;
        if (res.account) connectedRef.current(res.account);
        else if (res.needPassword) setStep("password");
        else if (res.qr && res.url) setQr({ image: res.qr, url: res.url });
      } catch (err) {
        if (alive) {
          setError(String((err as Error).message || err));
          setStep("details");
        }
      }
    };
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [step, loginId]);

  const resend = () =>
    run(async () => {
      applyDelivery((await api.telegramAccounts.resend(loginId)).delivery);
    });

  const sendEmailCode = () =>
    run(async () => {
      const res = await api.telegramAccounts.setupEmail(loginId, email);
      setEmailPattern(res.emailPattern);
      setStep("emailCode");
    });

  const confirmEmail = () =>
    run(async () => {
      applyDelivery((await api.telegramAccounts.verifyEmail(loginId, emailCode)).delivery);
    });

  const verify = () =>
    run(async () => {
      const res = await api.telegramAccounts.verify(step === "password" ? { loginId, password } : { loginId, code });
      if (res.needPassword) {
        setStep("password");
        return;
      }
      if (res.account) onConnected(res.account);
    });

  return (
    <div className="tg-connect">
      {step === "details" && (
        <>
          {needsApiKeys ? (
            <>
              <div className="field-help">
                This server has no Telegram app set up, so log in with your own API ID. Open{" "}
                <a href="https://my.telegram.org/apps" target="_blank" rel="noopener">
                  my.telegram.org <ExternalLink size={10} />
                </a>
                , log in, choose <b>API development tools</b>, create an app (any name) and copy <b>App api_id</b> and <b>App api_hash</b>.
              </div>
              <div className="oauth-field-row">
                <input value={apiId} placeholder="API ID (e.g. 1234567)" onChange={(e) => setApiId(e.target.value)} inputMode="numeric" autoComplete="off" />
                <SecretInput value={apiHash} placeholder="API hash" onChange={(e) => setApiHash(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="field-help">Enter the phone number of your Telegram account — Telegram sends you a login code.</div>
          )}
          <div className="oauth-field-row">
            <input value={phone} placeholder="Phone number, e.g. +491701234567" onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendCode()} inputMode="tel" autoComplete="tel" />
            <button type="button" className="btn btn-sm btn-primary" onClick={sendCode} disabled={busy || needsApiKeys === null || (needsApiKeys && (!apiId.trim() || !apiHash.trim())) || !phone.trim()}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </div>
          <div className="tg-qr-alt">
            <span className="field-help">No code arriving?</span>
            <button type="button" className="btn btn-sm" onClick={startQr} disabled={busy || needsApiKeys === null || (needsApiKeys && (!apiId.trim() || !apiHash.trim()))}>
              <QrCode size={12} /> Log in with QR code
            </button>
          </div>
        </>
      )}
      {step === "qr" && qr && (
        <>
          <div className="field-help">
            On your phone open Telegram → <b>Settings → Devices → Link Desktop Device</b> and scan this code. This page continues by itself once it is
            scanned.
          </div>
          <div className="tg-qr">
            <img src={qr.image} alt="Telegram login QR code" width={200} height={200} />
          </div>
          <div className="tg-qr-alt">
            <span className="field-help">On the phone you are using right now?</span>
            <a className="btn btn-sm" href={qr.url}>Open in Telegram</a>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStep("details")}>Use phone number instead</button>
          </div>
        </>
      )}
      {step === "email" && delivery && (
        <>
          <div className="field-help">{delivery.message}</div>
          <div className="oauth-field-row">
            <input value={email} type="email" placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendEmailCode()} autoComplete="email" autoFocus />
            <button type="button" className="btn btn-sm btn-primary" onClick={sendEmailCode} disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send e-mail code"}
            </button>
          </div>
        </>
      )}
      {step === "emailCode" && (
        <>
          <div className="field-help">Telegram mailed a code to {emailPattern || email} to confirm the address (check spam too). Enter it here.</div>
          <div className="oauth-field-row">
            <input value={emailCode} placeholder="E-mail code" onChange={(e) => setEmailCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirmEmail()} inputMode="numeric" autoComplete="one-time-code" autoFocus />
            <button type="button" className="btn btn-sm btn-primary" onClick={confirmEmail} disabled={busy || !emailCode.trim()}>
              {busy ? "Checking…" : "Confirm e-mail"}
            </button>
          </div>
        </>
      )}
      {step === "code" && delivery && (
        <>
          <div className="field-help">
            {delivery.message}
            {delivery.url && (
              <>
                {" "}
                <a href={delivery.url} target="_blank" rel="noopener">
                  Open Fragment <ExternalLink size={10} />
                </a>
              </>
            )}{" "}
            Enter it here.
          </div>
          <div className="oauth-field-row">
            <input value={code} placeholder="Login code" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} inputMode="numeric" autoComplete="one-time-code" autoFocus />
            <button type="button" className="btn btn-sm btn-primary" onClick={verify} disabled={busy || !code.trim()}>
              {busy ? "Checking…" : "Log in"}
            </button>
          </div>
          {delivery.canResend && (
            <div className="tg-resend">
              <span className="field-help">No code?</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={resend} disabled={busy || wait > 0}>
                {wait > 0 ? `Send it ${delivery.nextWay} in ${wait} s` : `Send it ${delivery.nextWay}`}
              </button>
            </div>
          )}
        </>
      )}
      {step === "password" && (
        <>
          <div className="field-help">Your account has 2-step verification. Enter your Telegram password (it is only sent to Telegram, never stored).</div>
          <div className="oauth-field-row">
            <SecretInput value={password} placeholder="2-step password" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && verify()} autoFocus />
            <button type="button" className="btn btn-sm btn-primary" onClick={verify} disabled={busy || !password}>
              {busy ? "Checking…" : "Log in"}
            </button>
          </div>
        </>
      )}
      <div className="tg-login-foot">
        <span className="field-help">Use it for your own chats — Telegram bans personal accounts that send bulk messages.</span>
        {onCancel && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <div className="field-help" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  onPatch?: (patch: Record<string, unknown>) => void;
  hasChat: boolean;
}

export default function TelegramAccountField({ value, onChange, onPatch, hasChat }: Props) {
  const [accounts, setAccounts] = useState<OAuthConnection[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts((await api.telegramAccounts.list()).accounts);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const findChats = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      setChats((await api.telegramAccounts.chats(value)).chats);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const selected = accounts?.find((a) => a.id === value);

  return (
    <div className="oauth-field">
      <div className="oauth-field-row">
        <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={accounts === null}>
          <option value="">{accounts === null ? "Loading…" : "— pick your Telegram account —"}</option>
          {(accounts || []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.email || a.name}
            </option>
          ))}
          {value && accounts && !selected && <option value={value}>(disconnected account)</option>}
        </Select>
        <button type="button" className="btn btn-sm" onClick={() => setAdding((a) => !a)}>
          <LogIn size={12} /> Log in to Telegram
        </button>
      </div>

      {adding && (
        <TelegramAccountLogin
          onCancel={() => setAdding(false)}
          onConnected={async (account) => {
            await load();
            onChange(account.id);
            setAdding(false);
          }}
        />
      )}

      {selected && hasChat && onPatch && (
        <div className="tg-chat-finder">
          <div className="field-help">Pick one of your recent chats to fill in the chat ID — or type “me” for your Saved Messages, or an @username.</div>
          <button type="button" className="btn btn-sm" onClick={findChats} disabled={busy}>
            <Search size={12} /> {busy ? "Looking…" : "Find my chat"}
          </button>
          {chats && (
            <div className="tg-chat-list">
              {chats.map((chat) => (
                <button
                  type="button"
                  key={chat.id}
                  className="tg-chat"
                  onClick={() => {
                    onPatch({ chatId: chat.id });
                    setChats(null);
                  }}
                  title={`Use chat ${chat.id}`}
                >
                  <MessageCircle size={12} />
                  <span>{chat.title}</span>
                  <small>
                    {chat.username || chat.type} · {chat.id}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {value && accounts && !selected && (
        <div className="field-help" style={{ color: "var(--red)" }}>
          The account picked here was disconnected. Pick another one or log in again.
        </div>
      )}
      {error && (
        <div className="field-help" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
