import { useEffect, useState } from "react";
import { AlertTriangle, Check, Cloud, Copy, Cpu, Database, HardDrive, RefreshCw, Server, Wrench } from "lucide-react";
import { api } from "../api";
import type { LicenseState, SetupState, SetupTestResult } from "../types";
import { LicensePanel, MoveToCloud } from "../components/LicensePanel";
import UpdatePanel from "../components/UpdatePanel";
import { SecretInput } from "../components/SecretInput";

/**
 * Setup — the page a self-hosted copy is configured from (it writes the copy's
 * own .env, so nothing has to be edited by hand). Two questions:
 *
 *   1. Storage   — a database file on this machine, or PostgreSQL on a server
 *                  the user runs (their own VPS).
 *   2. Execution — run workflows on this machine, or on a runner installed
 *                  elsewhere. The runner only executes; the database and the
 *                  editor stay here.
 *
 * Only the instance's owner sees the tab, and the server enforces the same rule.
 */
export default function SetupPage() {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dbTest, setDbTest] = useState<SetupTestResult | null>(null);
  const [runnerTest, setRunnerTest] = useState<SetupTestResult | null>(null);
  const [testing, setTesting] = useState<"db" | "runner" | null>(null);

  // editable copies of the values the page shows
  const [engine, setEngine] = useState<"sqlite" | "postgres">("sqlite");
  const [sqlitePath, setSqlitePath] = useState("");
  const [databaseUrl, setDatabaseUrl] = useState("");
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [acceptRuns, setAcceptRuns] = useState(false);
  const [runnerToken, setRunnerToken] = useState("");
  // a self-hosted copy also shows its licence and the move to the cloud
  const [license, setLicense] = useState<LicenseState | null>(null);
  useEffect(() => {
    api.license
      .status()
      .then(setLicense)
      .catch(() => setLicense(null));
  }, []);

  const apply = (s: SetupState) => {
    setState(s);
    setEngine(s.storage.engine);
    setSqlitePath(s.storage.sqlitePath);
    // the server only ever sends a masked URL back, so a saved PostgreSQL setup
    // leaves the field empty until it is replaced
    setDatabaseUrl("");
    setMode(s.execution.mode);
    setRemoteUrl(s.execution.remoteUrl);
    setRemoteToken("");
    setAcceptRuns(s.execution.acceptsRuns);
    setRunnerToken(s.execution.runnerToken);
  };

  useEffect(() => {
    api.setup
      .get()
      .then(apply)
      .catch((e) => setError(String((e as Error).message || e)));
  }, []);

  const copyToken = () => {
    if (!runnerToken) return;
    navigator.clipboard?.writeText(runnerToken).then(
      () => setMsg({ ok: true, text: "Token copied." }),
      () => setMsg({ ok: false, text: "Copying failed — select the token and copy it by hand." })
    );
  };

  const newToken = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    setRunnerToken(btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    setMsg({ ok: true, text: "New token generated — press Save to use it." });
  };

  const testDb = async () => {
    setTesting("db");
    setDbTest(null);
    setDbTest(await api.setup.testDb(databaseUrl).catch((e) => ({ ok: false, message: String((e as Error).message || e) })));
    setTesting(null);
  };

  const testRunner = async () => {
    setTesting("runner");
    setRunnerTest(null);
    setRunnerTest(await api.setup.testRunner(remoteUrl, remoteToken).catch((e) => ({ ok: false, message: String((e as Error).message || e) })));
    setTesting(null);
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await api.setup.save({
        storage: { engine, sqlitePath, databaseUrl },
        execution: { mode, remoteUrl, remoteToken, acceptRuns, runnerToken },
      });
      apply(res.setup);
      setMsg({
        ok: true,
        text: res.restartRequired
          ? "Saved to .env — restart this copy (stop the window and start it again with the launcher) to apply it."
          : "Saved. Nothing needed restarting.",
      });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message || e) });
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="setup-body">
        <div className="setup-card">
          <h3>
            <AlertTriangle size={14} /> SETUP UNAVAILABLE
          </h3>
          <p className="setup-note">{error}</p>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="setup-body">
        <div className="setup-card">
          <p className="setup-note">Reading this copy's settings…</p>
        </div>
      </div>
    );
  }

  const dirty =
    engine !== state.storage.engine ||
    (engine === "sqlite" && sqlitePath !== state.storage.sqlitePath) ||
    (engine === "postgres" && !!databaseUrl) ||
    mode !== state.execution.mode ||
    remoteUrl !== state.execution.remoteUrl ||
    !!remoteToken ||
    acceptRuns !== state.execution.acceptsRuns ||
    runnerToken !== state.execution.runnerToken;

  return (
    <>
      <div className="hub-top">
        <div className="hub-kicker">
          <Wrench size={14} /> SETUP
        </div>
        <h1>Where this copy stores and runs things</h1>
      </div>

      <div className="setup-body">
        {/* ---------------------------------------------------------------- */}
        <article className="setup-card">
          <h3>
            <Server size={14} /> THIS COPY
          </h3>
          <dl className="mainhub-facts">
            <div>
              <dt>Mode</dt>
              <dd>{state.standalone ? "self-hosted (installed by you)" : "hosted instance"}</dd>
            </div>
            <div>
              <dt>Builder</dt>
              <dd>http://localhost:{state.port}</dd>
            </div>
            <div>
              <dt>Database in use</dt>
              <dd>{state.activeEngine === "postgres" ? "PostgreSQL" : "local file"}</dd>
            </div>
            <div>
              <dt>Runs execute on</dt>
              <dd>{state.execution.mode === "remote" ? state.execution.remoteUrl : "this machine"}</dd>
            </div>
          </dl>
          <p className="setup-note">
            Settings live in <code>{state.envPath}</code>. A copy downloaded from another instance never talks back
            to it: its workflows, credentials and runs stay here.
          </p>
          {state.restartRequired && (
            <div className="setup-banner warn">
              <AlertTriangle size={14} /> .env was changed — restart the app to use the new settings.
            </div>
          )}
        </article>

        {/* ---------------------------------------------------------------- */}
        <article className="setup-card">
          <h3>
            <Database size={14} /> STORAGE
          </h3>
          <label className={`setup-choice ${engine === "sqlite" ? "active" : ""}`}>
            <input type="radio" name="engine" checked={engine === "sqlite"} onChange={() => setEngine("sqlite")} />
            <span className="setup-choice-text">
              <b>
                <HardDrive size={12} /> A database file on this machine
              </b>
              <span className="setup-note">Simplest: everything sits next to the app in ./data.</span>
            </span>
          </label>
          {engine === "sqlite" && (
            <div className="field">
              <div className="field-label">Database file</div>
              <input value={sqlitePath} onChange={(e) => setSqlitePath(e.target.value)} placeholder="C:\\wflow\\data\\admin.db" />
              <div className="field-help">An absolute path is safest. A relative one is resolved from the install folder.</div>
            </div>
          )}

          <label className={`setup-choice ${engine === "postgres" ? "active" : ""}`}>
            <input type="radio" name="engine" checked={engine === "postgres"} onChange={() => setEngine("postgres")} />
            <span className="setup-choice-text">
              <b>
                <Cloud size={12} /> PostgreSQL on a server I run
              </b>
              <span className="setup-note">Your workflows, credentials and run history live in your own database — for instance on your VPS.</span>
            </span>
          </label>
          {engine === "postgres" && (
            <>
              <div className="field">
                <div className="field-label">Connection URL</div>
                <SecretInput
                  value={databaseUrl}
                  onChange={(e) => setDatabaseUrl(e.target.value)}
                  placeholder={state.storage.hasDatabaseUrl ? state.storage.databaseUrl : "postgres://user:password@host:5432/wflow"}
                />
                <div className="field-help">
                  {state.storage.hasDatabaseUrl && !databaseUrl
                    ? "A PostgreSQL URL is saved — leave empty to keep it, or paste a new one."
                    : "The database is created on first start; the user needs rights to create tables."}
                </div>
              </div>
              <div className="setup-actions">
                <button className="btn btn-sm" onClick={testDb} disabled={testing === "db" || !databaseUrl}>
                  {testing === "db" ? <RefreshCw size={12} className="spin" /> : <Check size={12} />} Test connection
                </button>
                {dbTest && <span className={`setup-test ${dbTest.ok ? "ok" : "err"}`}>{dbTest.message}</span>}
              </div>
            </>
          )}
        </article>

        {/* ---------------------------------------------------------------- */}
        <article className="setup-card">
          <h3>
            <Cpu size={14} /> EXECUTION
          </h3>
          <label className={`setup-choice ${mode === "local" ? "active" : ""}`}>
            <input type="radio" name="mode" checked={mode === "local"} onChange={() => setMode("local")} />
            <span className="setup-choice-text">
              <b>On this machine</b>
              <span className="setup-note">Runs use this computer's network, files and CPU.</span>
            </span>
          </label>

          <label className={`setup-choice ${mode === "remote" ? "active" : ""}`}>
            <input type="radio" name="mode" checked={mode === "remote"} onChange={() => setMode("remote")} />
            <span className="setup-choice-text">
              <b>
                <Server size={12} /> On a runner I installed elsewhere
              </b>
              <span className="setup-note">
                Install the same app on your VPS, choose “runner” there and turn on “Accept runs from a remote
                builder”. This copy keeps the editor and the database; the runner executes and stores nothing.
              </span>
            </span>
          </label>

          {mode === "remote" && (
            <>
              <div className="field">
                <div className="field-label">Runner URL</div>
                <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="http://203.0.113.10:3001" />
              </div>
              <div className="field">
                <div className="field-label">Runner token</div>
                <SecretInput
                  value={remoteToken}
                  onChange={(e) => setRemoteToken(e.target.value)}
                  placeholder={state.execution.hasRemoteToken ? "saved — leave empty to keep it" : "paste the token from the runner's Setup page"}
                />
              </div>
              <div className="setup-actions">
                <button className="btn btn-sm" onClick={testRunner} disabled={testing === "runner" || !remoteUrl}>
                  {testing === "runner" ? <RefreshCw size={12} className="spin" /> : <Check size={12} />} Test runner
                </button>
                {runnerTest && <span className={`setup-test ${runnerTest.ok ? "ok" : "err"}`}>{runnerTest.message}</span>}
              </div>
              <div className="setup-banner warn">
                <AlertTriangle size={14} /> Runs that wait for a person — “Wait for Approval” and chat — cannot run on a
                runner. Those workflows report an error until execution is switched back to this machine.
              </div>
            </>
          )}
        </article>

        {/* ---------------------------------------------------------------- */}
        <article className="setup-card">
          <h3>
            <Cloud size={14} /> WORKFLOWS SENT HERE
          </h3>
          <label className="setup-choice">
            <input type="checkbox" checked={acceptRuns} onChange={(e) => setAcceptRuns(e.target.checked)} />
            <span className="setup-choice-text">
              <b>Accept runs from a remote builder</b>
              <span className="setup-note">
                Off by default: without a token this copy refuses every run request, so nobody can use your server as
                their execution host.
              </span>
            </span>
          </label>
          {acceptRuns && (
            <>
              <div className="field">
                <div className="field-label">Runner token</div>
                <div className="setup-token-row">
                  <input readOnly value={runnerToken} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn btn-sm" onClick={copyToken} disabled={!runnerToken} title="Copy the token">
                    <Copy size={12} />
                  </button>
                  <button className="btn btn-sm" onClick={newToken} title="Generate a different token">
                    <RefreshCw size={12} />
                  </button>
                </div>
                <div className="field-help">
                  Paste this into the other copy's Setup → Execution. Rotating it cuts off the old builder.
                </div>
              </div>
              <p className="setup-note">
                A builder sends the workflow, its sub-workflows, the agents it uses and the credentials the run needs.
                Nothing is written to this copy's database.
              </p>
            </>
          )}
        </article>
      </div>

      {license?.required && (
        <div className="setup-body">
          <LicensePanel license={license} onChange={setLicense} />
          <UpdatePanel />
          <MoveToCloud defaultCloud={license.server} />
        </div>
      )}

      <div className="setup-foot">
        <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        {msg && <span className={`setup-test ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>}
      </div>
    </>
  );
}
