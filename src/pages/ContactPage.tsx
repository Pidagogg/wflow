import { useEffect, useState } from "react";
import { ArrowLeft, Mail, Send } from "lucide-react";
import { api } from "../api";

interface Props {
  /** the signed-in account (its address pre-fills the form) */
  user?: { email?: string; name?: string };
  onBack: () => void;
}

/**
 * Contact form (Settings → Contact). Signed-in users write a message and leave
 * the address the operator should answer to; the server e-mails it to the
 * address configured in the admin panel (Admin → Auth & e-mail → Contact form
 * e-mail, falling back to the SMTP From address).
 */
export default function ContactPage({ user, onBack }: Props) {
  const [from, setFrom] = useState(user?.email || "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [recipient, setRecipient] = useState<string | null>(null);

  useEffect(() => {
    api.contact
      .info()
      .then((res) => setRecipient(res.to || ""))
      .catch(() => setRecipient(null));
  }, []);

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.contact.send(from.trim(), message.trim());
      setResult({ ok: true, text: res.message });
      setMessage("");
    } catch (err) {
      setResult({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contact-page">
      <div className="dash-head">
        <div className="dash-title">
          Contact
          <small>Send us a message — we reply by e-mail</small>
        </div>
        <div className="dash-actions">
          <button className="btn" onClick={onBack} title="Back">
            <ArrowLeft size={14} /> Back
          </button>
        </div>
      </div>

      <div className="contact-card">
        <div className="contact-intro">
          <Mail size={15} />
          <div>
            <b>Found a problem, or a question?</b>
            <div className="field-help" style={{ marginTop: 4 }}>
              Describe what happened (what you did, what you expected, what you saw instead) or share an idea or
              suggestion, and leave the address we should reply to.
              {recipient ? (
                <>
                  {" "}
                  Messages go to <code>{recipient}</code>.
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <div className="field-label">Your e-mail (for the reply)</div>
          <input
            type="email"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>

        <div className="field">
          <div className="field-label">Your message</div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What went wrong? Which workflow or node was involved?"
            rows={9}
            maxLength={4000}
          />
          <div className="field-help">{message.trim().length} / 4000 characters</div>
        </div>

        {result && (
          <div className={`settings-account-msg ${result.ok ? "ok" : "err"}`} style={{ marginTop: 12 }}>
            {result.ok ? "✓ " : "✗ "}
            {result.text}
          </div>
        )}

        <div className="contact-actions">
          <button
            className="btn btn-primary"
            onClick={send}
            disabled={busy || !message.trim() || !from.trim()}
            title={from.trim() ? "Send the message" : "Enter your e-mail address first"}
          >
            <Send size={13} /> {busy ? "Sending…" : "Send message"}
          </button>
        </div>
      </div>
    </div>
  );
}
