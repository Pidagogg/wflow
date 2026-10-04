// ============================================================================
// OAuthAccountField — the "Google account" / "GitHub account" / … picker on
// a node (field type "oauth", see shared/oauth.js).
//
// Lists the accounts this user already connected and offers "Connect" /
// "Reconnect", which opens the provider's consent screen in a popup. The
// popup's last page posts the result back here, so the new account is picked
// without leaving the editor. The node only ever stores the connection id —
// tokens stay on the server.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { Link2, RefreshCw } from "lucide-react";
import { api, type OAuthConnection } from "../api";
import Select from "./Select";

interface Props {
  nodeType: string;
  provider: string;
  /** display name, e.g. "Google" or "X (Twitter)" */
  label: string;
  scopes: string[];
  value: string;
  onChange: (id: string) => void;
}

// Microsoft echoes some scopes lower-cased, so compare case-insensitively.
function lacksScopes(conn: OAuthConnection | undefined, needed: string[]) {
  if (!conn) return false;
  const have = new Set(conn.scopes.map((s) => s.toLowerCase()));
  return needed.some((s) => !have.has(s.toLowerCase()));
}

// Labels for the service-specific details a connection carries.
const EXTRA_LABEL: Record<string, string> = {
  realmId: "Company ID (realmId)",
  instanceUrl: "Instance URL",
  memberUrn: "Author (member URN)",
};

export default function OAuthAccountField({ nodeType, provider, label, scopes, value, onChange }: Props) {
  const [connections, setConnections] = useState<OAuthConnection[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.connections.list(provider);
      setConnections(res.connections);
      setConfigured(!!res.providers[provider]);
      return res.connections;
    } catch {
      setConnections([]);
      return [];
    }
  }, [provider]);

  useEffect(() => {
    load();
  }, [load]);

  // The popup reports back through postMessage; only our own origin counts.
  useEffect(() => {
    if (!waiting) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== "wflow-oauth") return;
      setWaiting(false);
      if (e.data.ok && e.data.connection?.id) {
        setError(null);
        load().then(() => onChange(String(e.data.connection.id)));
      } else {
        setError(String(e.data.error || "Connecting failed."));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [waiting, load, onChange]);

  const connect = () => {
    setError(null);
    const w = 520;
    const h = 680;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(api.connections.startUrl(provider, nodeType), "wflow-oauth", `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      setError("The sign-in window was blocked — allow pop-ups for this site and try again.");
      return;
    }
    setWaiting(true);
    // A closed popup without a message means the user gave up.
    const timer = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(timer);
        setWaiting(false);
        load();
      }
    }, 800);
  };

  const selected = connections?.find((c) => c.id === value);
  const needsMore = lacksScopes(selected, scopes);

  return (
    <div className="oauth-field">
      <div className="oauth-field-row">
        <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={connections === null}>
          <option value="">{connections === null ? "Loading…" : `— pick a ${label} account —`}</option>
          {(connections || []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.email || c.name}
            </option>
          ))}
          {value && connections && !selected && <option value={value}>(disconnected account)</option>}
        </Select>
        <button type="button" className="btn btn-sm" onClick={connect} disabled={waiting || !configured}>
          {selected && needsMore ? <RefreshCw size={12} /> : <Link2 size={12} />}
          {waiting ? "Waiting…" : selected && needsMore ? "Reconnect" : `Connect ${label}`}
        </button>
      </div>
      {!configured && (
        <div className="field-help">
          Sorry, connecting {label} isn’t available yet.
        </div>
      )}
      {selected?.extra && Object.keys(selected.extra).length > 0 && (
        <div className="field-help">
          {Object.entries(selected.extra).map(([k, v]) => (
            <div key={k}>
              {EXTRA_LABEL[k] || k}: <code>{v}</code>
            </div>
          ))}
        </div>
      )}
      {selected && needsMore && (
        <div className="field-help">This node needs one more permission from {selected.email || "this account"} — click Reconnect and allow it.</div>
      )}
      {value && connections && !selected && (
        <div className="field-help" style={{ color: "var(--red)" }}>
          The account picked here was disconnected. Pick another one or connect it again.
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
