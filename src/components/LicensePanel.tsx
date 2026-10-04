import { useState } from "react";
import { AlertTriangle, Check, CloudUpload, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { api } from "../api";
import type { LicenseState, MoveResult } from "../types";

function dateLabel(ms: number) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
}

/**
 * The licence of a self-hosted copy (server/license.js): which plan it runs
 * on, when it was last confirmed, and — for the account that set the copy up —
 * a box to paste a new key. Only the key is ever sent to w-flow.tech.
 */
export function LicensePanel({ license, onChange }: { license: LicenseState; onChange: (l: LicenseState) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"key" | "check" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const saveKey = async () => {
    setBusy("key");
    setMsg(null);
    try {
      const r = await api.license.setKey(key.trim());
      onChange({ ...license, ...r.status });
      setMsg({ ok: r.ok, text: r.ok ? "Licence accepted — this copy is unlocked." : r.error });
      if (r.ok) setKey("");
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const checkAgain = async () => {
    setBusy("check");
    setMsg(null);
    try {
      const s = await api.license.refresh();
      onChange({ ...license, ...s });
      setMsg({ ok: s.active, text: s.active ? "Licence confirmed." : s.reason || "The licence is not active." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const planLabel = license.plan === "team" ? `Team · ${license.seats} accounts` : license.plan === "pro" ? "Pro · 1 account" : "—";

  return (
    <article className="setup-card">
      <h3>
        <KeyRound size={14} /> LICENCE
      </h3>
      <dl className="mainhub-facts">
        <div>
          <dt>Status</dt>
          <dd style={{ color: license.active ? "var(--green)" : "var(--red)" }}>{license.active ? "active" : "not active"}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>{planLabel}</dd>
        </div>
        <div>
          <dt>Last confirmed</dt>
          <dd>{dateLabel(license.checkedAt)}</dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd>{license.hasKey ? <code>{license.keyHint}</code> : "none yet"}</dd>
        </div>
      </dl>
      {!license.active && license.reason && (
        <div className="setup-banner warn">
          <AlertTriangle size={14} /> {license.reason}
        </div>
      )}
      <p className="setup-note">
        Self-hosting is part of Pro and Team plans. This copy confirms its licence with <code>{license.server}</code> every few
        hours and keeps working for up to three days without a connection. Only the key is sent — your workflows, credentials
        and runs never leave this machine.
      </p>
      {license.isOwner ? (
        <div className="field">
          <div className="field-label">Licence key (w-flow.tech → Settings → Self-hosted)</div>
          <div className="setup-actions">
            <input value={key} placeholder="wfl_…" onChange={(e) => setKey(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
            <button className="btn btn-primary btn-sm" onClick={saveKey} disabled={!key.trim() || busy !== null}>
              {busy === "key" ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Use this key
            </button>
          </div>
        </div>
      ) : (
        <p className="setup-note">Only the account that set this copy up can change its licence.</p>
      )}
      <div className="setup-actions">
        <button className="btn btn-sm" onClick={checkAgain} disabled={busy !== null}>
          {busy === "check" ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Check again
        </button>
        {msg && <span className={`setup-test ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>}
      </div>
    </article>
  );
}

/**
 * "Move to the cloud" on a self-hosted copy (server/migrate.js): paste the
 * one-time code made on w-flow.tech and this account's workflows, agents,
 * credentials, variables and data tables are copied there. The copy keeps
 * everything it had.
 */
export function MoveToCloud({ defaultCloud }: { defaultCloud: string }) {
  const [code, setCode] = useState("");
  const [cloud, setCloud] = useState(defaultCloud || "https://w-flow.tech");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MoveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.migrate.send(code.trim(), cloud.trim()));
      setCode("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="setup-card">
      <h3>
        <CloudUpload size={14} /> MOVE TO THE CLOUD
      </h3>
      <p className="setup-note">
        Copy your account to the cloud version: on w-flow.tech open <b>Settings → Self-hosted → Move a self-hosted copy here</b>,
        create a code and paste it below. Your workflows, agents, credentials, variables and data tables are sent once, over
        HTTPS, into that cloud account. Run history and files stay here, and nothing on this copy is deleted. Other accounts on
        this copy move with their own code.
      </p>
      <div className="field">
        <div className="field-label">Move code</div>
        <input value={code} placeholder="wfm_…" onChange={(e) => setCode(e.target.value)} />
      </div>
      <div className="field">
        <div className="field-label">Cloud address</div>
        <input value={cloud} onChange={(e) => setCloud(e.target.value)} />
      </div>
      <div className="setup-actions">
        <button className="btn btn-primary btn-sm" onClick={send} disabled={busy || !code.trim()}>
          {busy ? <Loader2 size={12} className="spin" /> : <CloudUpload size={12} />} {busy ? "Moving…" : "Move my account"}
        </button>
        {error && <span className="setup-test err">{error}</span>}
      </div>
      {result && (
        <div className="setup-banner ok">
          <Check size={14} /> Moved {result.workflows} workflows, {result.agents} agents, {result.credentials} credentials,{" "}
          {result.variables} variables and {result.dataTables} data tables.
          {result.skipped.length > 0 && <> Not moved: {result.skipped.join("; ")}.</>}
        </div>
      )}
    </article>
  );
}
