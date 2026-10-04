// ============================================================================
// TelegramBotField — the "Telegram bot" picker on every Telegram node (field
// type "telegramBot", see shared/catalog.js).
//
// Telegram has no OAuth for bots, so "Connect Telegram" asks for the token
// from @BotFather once; the server checks it (getMe) and keeps it encrypted.
// "Find my chat" then links the user's own Telegram account: they message the
// bot, and the chats that wrote to it are offered to fill the node's chat ID.
// The node only ever stores the connection id.
// ============================================================================
import { useCallback, useEffect, useState } from "react";
import { Link2, MessageCircle, Search } from "lucide-react";
import { api, type OAuthConnection } from "../api";
import Select from "./Select";
import { SecretInput } from "./SecretInput";

interface Props {
  value: string;
  onChange: (id: string) => void;
  /** fill another field of the node (the chat ID) */
  onPatch?: (patch: Record<string, unknown>) => void;
  /** whether the node has a chat ID field to fill */
  hasChat: boolean;
}

type Chat = { id: string; type: string; title: string; username: string };

export default function TelegramBotField({ value, onChange, onPatch, hasChat }: Props) {
  const [bots, setBots] = useState<OAuthConnection[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.telegram.bots();
      setBots(res.bots);
      return res.bots;
    } catch {
      setBots([]);
      return [];
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connect = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { bot } = await api.telegram.connect(token.trim());
      await load();
      onChange(bot.id);
      setToken("");
      setAdding(false);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const findChats = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.telegram.chats(value);
      setChats(res.chats);
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  };

  const selected = bots?.find((b) => b.id === value);
  const botName = selected?.email || "your bot";

  return (
    <div className="oauth-field">
      <div className="oauth-field-row">
        <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={bots === null}>
          <option value="">{bots === null ? "Loading…" : "— pick a Telegram bot —"}</option>
          {(bots || []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.email || b.name}
            </option>
          ))}
          {value && bots && !selected && <option value={value}>(disconnected bot)</option>}
        </Select>
        <button type="button" className="btn btn-sm" onClick={() => setAdding((a) => !a)} disabled={busy}>
          <Link2 size={12} /> Connect Telegram
        </button>
      </div>

      {adding && (
        <div className="tg-connect">
          <div className="field-help">
            In Telegram, open <b>@BotFather</b>, send <code>/newbot</code> (or <code>/token</code> for an existing bot) and paste the token here.
          </div>
          <div className="oauth-field-row">
            <SecretInput
              value={token}
              placeholder="123456789:AAH…"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connect()}
            />
            <button type="button" className="btn btn-sm btn-primary" onClick={connect} disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      {selected && hasChat && onPatch && (
        <div className="tg-chat-finder">
          <div className="field-help">
            Link your own account: open <b>{botName}</b> in Telegram, send it any message, then press Find my chat.
          </div>
          <button type="button" className="btn btn-sm" onClick={findChats} disabled={busy}>
            <Search size={12} /> {busy ? "Looking…" : "Find my chat"}
          </button>
          {chats && chats.length === 0 && (
            <div className="field-help">No messages yet — send {botName} a message in Telegram and try again.</div>
          )}
          {chats && chats.length > 0 && (
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

      {value && bots && !selected && (
        <div className="field-help" style={{ color: "var(--red)" }}>
          The bot picked here was disconnected. Pick another one or connect it again.
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
