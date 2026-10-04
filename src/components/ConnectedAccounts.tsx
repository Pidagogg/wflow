// ============================================================================
// ConnectedAccounts — "Connect Slack / Google / GitHub / …" outside the editor
// (Credentials page).
//
// Before this, an account could only be connected from inside a node that has
// the account picker, so a service the operator had set up could look
// impossible to connect. Here every service the operator configured gets a
// Connect button; the connection asks for every scope the service's nodes use
// (server: /api/connections/:provider/start without ?node=), so one
// connection then works on all of that service's nodes. Telegram bots are
// connected with their @BotFather token instead of a consent screen.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { Link2, Plug, RefreshCw, Trash2 } from "lucide-react";
import { api, type OAuthConnection } from "../api";
import { TelegramAccountLogin } from "./TelegramAccountField";
import { SecretInput } from "./SecretInput";

export default function ConnectedAccounts() {
  const [providers, setProviders] = useState<Record<string, boolean>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<OAuthConnection[] | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgBusy, setTgBusy] = useState(false);
  const [tgLogin, setTgLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.connections.list();
      setProviders(res.providers);
      setLabels(res.labels || {});
      setConnections(res.connections);
    } catch (err) {
      setConnections([]);
      setError(String((err as Error).message || err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The consent popup reports back through postMessage; only our origin counts.
  useEffect(() => {
    if (!waiting) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== "wflow-oauth") return;
      setWaiting(null);
      if (e.data.ok) setError(null);
      else setError(String(e.data.error || "Connecting failed."));
      load();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [waiting, load]);

  const connect = (provider: string) => {
    setError(null);
    const w = 520;
    const h = 680;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(api.connections.startUrl(provider), "wflow-oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      setError("The sign-in window was blocked — allow pop-ups for this site and try again.");
      return;
    }
    setWaiting(provider);
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        setWaiting(null);
        load();
      }
    }, 800);
  };

  const connectTelegram = async () => {
    if (!tgToken.trim() || tgBusy) return;
    setTgBusy(true);
    setError(null);
    try {
      await api.telegram.connect(tgToken.trim());
      setTgToken("");
      await load();
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setTgBusy(false);
    }
  };

  const disconnect = async (c: OAuthConnection) => {
    if (!window.confirm(`Disconnect ${c.email || c.name}? Nodes that use it stop working until you pick another account.`)) return;
    try {
      await api.credentials.remove(c.id);
      await load();
    } catch (err) {
      setError(String((err as Error).message || err));
    }
  };

  const ready = Object.keys(providers).filter((p) => providers[p]);
  const byProvider = (p: string) => (connections || []).filter((c) => c.provider === p);
  const telegram = byProvider("telegram");
  const telegramAccounts = byProvider("telegram-user");

  return (
    <section className="conn-panel">
      <div className="conn-head">
        <h2>
          <Plug size={15} /> Connected accounts
        </h2>
        <p>Sign in to a service once; every node of that service can then use the account. Tokens stay encrypted on the server.</p>
      </div>

      {error && <div className="tool-error">{error}</div>}

      <div className="conn-grid">
        {ready.map((p) => {
          const label = labels[p] || p;
          const list = byProvider(p);
          return (
            <div className="conn-card" key={p}>
              <div className="conn-card-top">
                <span className="conn-name">{label}</span>
                <button type="button" className="btn btn-sm" onClick={() => connect(p)} disabled={!!waiting}>
                  {list.length ? <RefreshCw size={12} /> : <Link2 size={12} />}
                  {waiting === p ? "Waiting…" : list.length ? "Add another" : "Connect"}
                </button>
              </div>
              {list.map((c) => (
                <div className="conn-account" key={c.id}>
                  <span>{c.email || c.name}</span>
                  <button type="button" className="btn mini danger" onClick={() => disconnect(c)} title="Disconnect">
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          );
        })}

        <div className="conn-card">
          <div className="conn-card-top">
            <span className="conn-name">Telegram bot</span>
          </div>
          {telegram.map((c) => (
            <div className="conn-account" key={c.id}>
              <span>{c.email || c.name}</span>
              <button type="button" className="btn mini danger" onClick={() => disconnect(c)} title="Disconnect">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          <div className="conn-tg">
            <SecretInput
              value={tgToken}
              placeholder="Bot token from @BotFather"
              onChange={(e) => setTgToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connectTelegram()}
            />
            <button type="button" className="btn btn-sm" onClick={connectTelegram} disabled={tgBusy || !tgToken.trim()}>
              {tgBusy ? "Checking…" : "Connect"}
            </button>
          </div>
        </div>

        <div className="conn-card">
          <div className="conn-card-top">
            <span className="conn-name">Telegram account</span>
            {!tgLogin && (
              <button type="button" className="btn btn-sm" onClick={() => setTgLogin(true)}>
                <Link2 size={12} /> {telegramAccounts.length ? "Add another" : "Log in"}
              </button>
            )}
          </div>
          {telegramAccounts.map((c) => (
            <div className="conn-account" key={c.id}>
              <span>{c.email || c.name}</span>
              <button type="button" className="btn mini danger" onClick={() => disconnect(c)} title="Disconnect and log out">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
          {tgLogin && (
            <TelegramAccountLogin
              onCancel={() => setTgLogin(false)}
              onConnected={() => {
                setTgLogin(false);
                load();
              }}
            />
          )}
        </div>
      </div>

      {connections !== null && ready.length === 0 && (
        <div className="field-help">
          Sorry, connecting other services isn’t available yet.
        </div>
      )}
    </section>
  );
}
