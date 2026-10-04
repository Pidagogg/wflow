import { useEffect, useState } from "react";
import { Check, Clock, CreditCard, Loader2, Send, Users, X } from "lucide-react";
import { api } from "../api";
import type { TeamPlanInfo } from "../types";

/**
 * The custom Team plan on the Pro page (server/teams.js). The buyer picks how
 * many accounts it covers and sends a request; it can only be bought once the
 * operator approved it with a price. Once active, the buyer lists the e-mails
 * of the other accounts (Pro in the cloud) and is the admin of their
 * self-hosted copy, where the plan's seats are the number of accounts.
 */
export default function TeamPlanCard() {
  const [info, setInfo] = useState<TeamPlanInfo | null>(null);
  const [seats, setSeats] = useState(5);
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [members, setMembers] = useState("");
  const [busy, setBusy] = useState<"request" | "buy" | "members" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    api.billing
      .team()
      .then((i) => {
        setInfo(i);
        setMembers((i.team?.members || []).join("\n"));
      })
      .catch(() => setInfo(null));
  useEffect(() => {
    load();
  }, []);

  const run = async (kind: "request" | "buy" | "members", fn: () => Promise<string | void>) => {
    setBusy(kind);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
      await load();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  if (!info) return null;
  const team = info.team;
  const open = !team || team.status === "rejected" || team.status === "ended";
  const estimate = (seats * info.seatPrice).toFixed(2);

  return (
    <div className="pricing-card team-plan-card">
      <div className="pricing-icon">
        <Users size={22} />
      </div>
      <div className="pricing-name">W flow Team — custom</div>
      <p className="setup-note">
        Choose how many accounts the plan covers. You become the admin of your self-hosted copy: you set its server and database
        for everyone, share a small pool of credentials, and see where each account's workflows send and fetch data. In the cloud
        every account on the plan is simply Pro. Each request is confirmed by hand before it can be bought.
      </p>

      {open ? (
        <>
          {team?.status === "rejected" && (
            <div className="setup-banner warn">
              <X size={14} /> Your last request was declined{team.note ? `: ${team.note}` : "."}
            </div>
          )}
          <div className="field">
            <div className="field-label">Accounts</div>
            <input
              type="number"
              min={info.minSeats}
              max={info.maxSeats}
              value={seats}
              onChange={(e) => setSeats(Math.max(info.minSeats, Math.min(info.maxSeats, Number(e.target.value) || info.minSeats)))}
            />
            <div className="field-help">
              Usually about €{estimate} / month ({seats} × €{info.seatPrice}) — the final price comes with the confirmation.
            </div>
          </div>
          <div className="field">
            <div className="field-label">Company (optional)</div>
            <input value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>
          <div className="field">
            <div className="field-label">Anything we should know (optional)</div>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
          </div>
          <button
            className="btn btn-primary pricing-cta"
            disabled={busy !== null}
            onClick={() =>
              run("request", async () => {
                await api.billing.requestTeam({ seats, company, message });
                return "Request sent — we will confirm it by e-mail.";
              })
            }
          >
            {busy === "request" ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Request a Team plan
          </button>
        </>
      ) : team.status === "pending" ? (
        <div className="setup-banner warn">
          <Clock size={14} /> Your request for {team.seats} accounts is waiting for confirmation — you will get an e-mail.
        </div>
      ) : team.status === "approved" ? (
        <>
          <div className="pricing-price">
            €{team.priceMonthly.toFixed(2)}
            <small>per month · {team.seats} accounts</small>
          </div>
          {team.note && <p className="setup-note">{team.note}</p>}
          <button
            className="btn btn-primary pricing-cta"
            disabled={busy !== null}
            onClick={() =>
              run("buy", async () => {
                const { url } = await api.billing.teamCheckout();
                window.location.href = url;
              })
            }
          >
            {busy === "buy" ? <Loader2 size={14} className="spin" /> : <CreditCard size={14} />} Buy the Team plan
          </button>
        </>
      ) : (
        <>
          <div className="pricing-meta">
            <span className="tag" style={{ color: team.active ? "var(--green)" : "var(--red)" }}>{team.active ? "active" : "payment lapsed"}</span>{" "}
            {team.seats} accounts · €{team.priceMonthly.toFixed(2)} / month
            {team.paidUntil > 0 && <> · paid until {new Date(team.paidUntil).toLocaleDateString()}</>}
          </div>
          <div className="field">
            <div className="field-label">
              The other accounts on the plan — e-mail addresses, one per line ({team.seats - 1} at most)
            </div>
            <textarea value={members} onChange={(e) => setMembers(e.target.value)} rows={4} placeholder="colleague@company.com" />
          </div>
          <button
            className="btn btn-sm"
            disabled={busy !== null}
            onClick={() =>
              run("members", async () => {
                await api.billing.teamMembers(members.split(/[\s,;]+/).filter(Boolean));
                return "Saved — these accounts are Pro now.";
              })
            }
          >
            {busy === "members" ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Save accounts
          </button>
        </>
      )}
      {msg && <div className={`setup-test ${msg.ok ? "ok" : "err"}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}
