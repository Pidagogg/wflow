import { useEffect, useState } from "react";
import { AlertTriangle, Globe, KeyRound, Loader2, Lock, ShieldCheck, Users } from "lucide-react";
import { api } from "../api";
import type { TeamOverview } from "../types";

function when(ms: number) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "—";
}

/**
 * Team — the admin page of a self-hosted copy (server/team-admin.js). The
 * account that set the copy up sees every account on it, where each one's
 * runs fetch data from and send data to, and decides:
 *   - who is limited to the shared credentials ("restricted"),
 *   - which of their own credentials and variables are shared with the team,
 *   - which outside addresses restricted members may reach at all.
 * The server, database and runner for everyone are chosen on the Setup page.
 */
export default function TeamPage() {
  const [data, setData] = useState<TeamOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hosts, setHosts] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (d: TeamOverview) => {
    setData(d);
    setHosts(d.allowedHosts.join("\n"));
  };

  useEffect(() => {
    api.team
      .get()
      .then(apply)
      .catch((err) => setError((err as Error).message));
  }, []);

  const update = async (patch: Parameters<typeof api.team.update>[0], okText: string) => {
    setSaving(true);
    setMsg(null);
    try {
      apply(await api.team.update(patch));
      setMsg({ ok: true, text: okText });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="setup-body">
        <div className="setup-card">
          <h3>
            <AlertTriangle size={14} /> TEAM UNAVAILABLE
          </h3>
          <p className="setup-note">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="setup-body">
        <div className="setup-card">
          <p className="setup-note">Loading the team…</p>
        </div>
      </div>
    );
  }

  const pooledCreds = data.credentials.filter((c) => c.pooled).map((c) => c.id);
  const pooledVars = data.variables.filter((v) => v.pooled).map((v) => v.id);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const hostList = hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
  const hostsDirty = hostList.join("\n") !== data.allowedHosts.join("\n");

  return (
    <>
      <div className="hub-top">
        <div className="hub-kicker">
          <Users size={14} /> TEAM
        </div>
        <h1>Who uses this copy, and where their data goes</h1>
      </div>

      <div className="setup-body">
        <article className="setup-card">
          <h3>
            <Users size={14} /> ACCOUNTS · {data.used} OF {data.seats}
          </h3>
          <p className="setup-note">
            Your {data.plan === "team" ? "Team" : "Pro"} plan covers {data.seats} account{data.seats === 1 ? "" : "s"} on this copy; every
            one of them is Pro here. Sign-ups stop when the copy is full — buy more seats on w-flow.tech (Pro → Team plan).
            The server, database and runner for everybody are set on the Setup page.
          </p>
          <table className="team-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Last login</th>
                <th>Restricted</th>
                <th>Where its runs send and fetch data</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.name || m.email}</b>
                    {m.name && <div className="dim">{m.email}</div>}
                    {m.owner && <div className="dim">admin (you)</div>}
                  </td>
                  <td>{m.lastLogin ? new Date(m.lastLogin).toLocaleDateString() : "—"}</td>
                  <td>
                    {m.owner ? (
                      "—"
                    ) : (
                      <label className="chk" title="Limit this account to the shared credentials and the allowed addresses">
                        <input
                          type="checkbox"
                          checked={m.restricted}
                          disabled={saving}
                          onChange={(e) =>
                            update({ restrict: { [m.id]: e.target.checked } }, e.target.checked ? `${m.email} is now restricted.` : `${m.email} is no longer restricted.`)
                          }
                        />{" "}
                        {m.restricted ? <Lock size={11} /> : null}
                      </label>
                    )}
                  </td>
                  <td>
                    {m.flows.length ? (
                      <div className="team-flows">
                        {m.flows.slice(0, 12).map((f) => (
                          <div key={f.host} className={`team-flow ${f.allowed || !m.restricted ? "" : "blocked"}`}>
                            <code>{f.host}</code>
                            <span className="dim">
                              {f.send ? `sent ${f.send}×` : ""}
                              {f.send && f.get ? " · " : ""}
                              {f.get ? `fetched ${f.get}×` : ""} · {when(f.lastAt)}
                              {f.workflows.length ? ` · ${f.workflows.map((w) => w.name).join(", ")}` : ""}
                            </span>
                          </div>
                        ))}
                        {m.flows.length > 12 && <span className="dim">…and {m.flows.length - 12} more</span>}
                      </div>
                    ) : (
                      <span className="dim">no outside calls yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="setup-card">
          <h3>
            <KeyRound size={14} /> SHARED CREDENTIALS
          </h3>
          <p className="setup-note">
            Pick which of <b>your</b> credentials, connected accounts and variables the team may use. Members pick them on their
            nodes but never see the secret itself. Restricted members can use only these — they cannot add their own.
          </p>
          <div className="field-label">Credentials &amp; connected accounts</div>
          {data.credentials.length ? (
            <div className="team-pick">
              {data.credentials.map((c) => (
                <label key={c.id} className={c.pooled ? "on" : ""}>
                  <input
                    type="checkbox"
                    checked={c.pooled}
                    disabled={saving}
                    onChange={() => update({ poolCredentials: toggle(pooledCreds, c.id) }, "Shared credentials updated.")}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          ) : (
            <p className="setup-note">You have no credentials yet — add them on the Credentials page.</p>
          )}
          <div className="field-label" style={{ marginTop: 12 }}>
            Variables
          </div>
          {data.variables.length ? (
            <div className="team-pick">
              {data.variables.map((v) => (
                <label key={v.id} className={v.pooled ? "on" : ""}>
                  <input
                    type="checkbox"
                    checked={v.pooled}
                    disabled={saving}
                    onChange={() => update({ poolVariables: toggle(pooledVars, v.id) }, "Shared variables updated.")}
                  />
                  {v.name}
                  {v.secret ? " 🔒" : ""}
                </label>
              ))}
            </div>
          ) : (
            <p className="setup-note">You have no variables yet.</p>
          )}
        </article>

        <article className="setup-card">
          <h3>
            <Globe size={14} /> ALLOWED ADDRESSES
          </h3>
          <p className="setup-note">
            With a list here, the runs of <b>restricted</b> members can only fetch from or send to these hosts — one per line,{" "}
            <code>*.example.com</code> covers its subdomains. Leave it empty to only watch where data goes. Calls outside the list
            fail with BF-3006.
          </p>
          <textarea value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder={"api.openai.com\n*.googleapis.com"} rows={6} />
          <div className="setup-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={saving || !hostsDirty}
              onClick={() => update({ allowedHosts: hostList }, hostList.length ? "Allowed addresses saved." : "No address limit — data flows are only recorded.")}
            >
              {saving ? <Loader2 size={12} className="spin" /> : <ShieldCheck size={12} />} Save addresses
            </button>
          </div>
        </article>
      </div>

      <div className="setup-foot">{msg && <span className={`setup-test ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>}</div>
    </>
  );
}
