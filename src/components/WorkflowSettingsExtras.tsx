import { useEffect, useState } from "react";
import { BellRing, Bot, FlaskConical, Plus, Rocket, Send, Trash2 } from "lucide-react";
import type { McpParam, WorkflowAlertSettings, WorkflowEnvironment, WorkflowMcpSettings } from "../types";
import Select from "./Select";
import { api } from "../api";
import { SecretInput } from "./SecretInput";
import { toolInputsFor } from "../../shared/tool-inputs.js";

// Sections of the Workflow settings dialog added with the environment, failure
// alert and AI-tool features. Kept apart from WorkflowModal so that file stays
// about name, execution mode and import / export.

// ---- Test / Live environment ---------------------------------------------
export function EnvironmentSection({ environment, onChange }: { environment: WorkflowEnvironment; onChange: (env: WorkflowEnvironment) => void }) {
  return (
    <div className="insp-section">
      <div className="field-section">Environment</div>
      <div className="exec-mode-row">
        <button className={`exec-mode-option ${environment === "live" ? "active" : ""}`} onClick={() => onChange("live")}>
          <Rocket size={13} />
          <span>
            <b>Live</b>
            <small>Uses your Variables' normal values. Orders and transfers follow each node's own test-mode switch.</small>
          </span>
        </button>
        <button className={`exec-mode-option ${environment === "test" ? "active" : ""}`} onClick={() => onChange("test")}>
          <FlaskConical size={13} />
          <span>
            <b>Test</b>
            <small>Uses each Variable's test value (e.g. testnet keys). Exchange orders and wallet transfers never execute.</small>
          </span>
        </button>
      </div>
      <div className="field-help">
        Put credentials in <b>Variables</b> with a live and a test value, and write <code>{"{{$vars.NAME}}"}</code> in a node's key field — this
        switch then flips the whole workflow between them.
      </div>
    </div>
  );
}

// ---- failure alerts --------------------------------------------------------
export function AlertsSection({ workflowId }: { workflowId: string }) {
  const [settings, setSettings] = useState<WorkflowAlertSettings | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.workflows
      .alerts(workflowId)
      .then(setSettings)
      .catch((err) => setMsg({ ok: false, text: String((err as Error).message || err) }));
  }, [workflowId]);

  if (!settings) {
    return (
      <div className="insp-section">
        <div className="field-section">Failure alerts</div>
        {msg ? <div className="settings-note err">{msg.text}</div> : <div className="field-help">Loading…</div>}
      </div>
    );
  }

  const patch = (p: Partial<WorkflowAlertSettings>) => setSettings({ ...settings, ...p });

  const save = async (extra: { clearTelegramBotToken?: boolean } = {}) => {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await api.workflows.saveAlerts(workflowId, { ...settings, telegramBotToken: token || undefined, ...extra });
      setSettings(saved);
      setToken("");
      setMsg({ ok: true, text: "Alert settings saved." });
      return true;
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!(await save())) return;
    setBusy(true);
    try {
      const res = await api.workflows.testAlert(workflowId);
      setMsg({ ok: res.ok, text: res.message });
    } catch (err) {
      setMsg({ ok: false, text: String((err as Error).message || err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="insp-section">
      <div className="field-section">
        <BellRing size={11} /> FAILURE ALERTS
      </div>
      <label className="exec-loop-toggle">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span className="toggle-label">{settings.enabled ? "ON" : "OFF"}</span>
        <span className="exec-loop-toggle-text">Tell me when this workflow fails</span>
      </label>
      {settings.enabled && (
        <>
          <div className="field">
            <div className="field-label">E-mail address</div>
            <input type="email" value={settings.email} placeholder="you@example.com" onChange={(e) => patch({ email: e.target.value })} />
          </div>
          <div className="field">
            <div className="field-label">Telegram bot token {settings.telegramBotTokenSet && <small>(saved — leave empty to keep it)</small>}</div>
            <SecretInput value={token} placeholder={settings.telegramBotTokenSet ? "••••••••" : "123456:ABC-…"} onChange={(e) => setToken(e.target.value)} />
            <div className="field-help">Create a bot with @BotFather, send it any message, then enter your chat ID below (@userinfobot shows it).</div>
          </div>
          <div className="field">
            <div className="field-label">Telegram chat ID</div>
            <input value={settings.telegramChatId} placeholder="123456789" onChange={(e) => patch({ telegramChatId: e.target.value })} />
          </div>
          <label className="exec-loop-toggle">
            <input type="checkbox" checked={settings.includeEditorRuns} onChange={(e) => patch({ includeEditorRuns: e.target.checked })} />
            <span className="toggle-label">{settings.includeEditorRuns ? "ON" : "OFF"}</span>
            <span className="exec-loop-toggle-text">Also alert for runs started in the editor</span>
          </label>
          <div className="field-help">
            Alerts cover runs nobody was watching — schedules, triggers, webhooks, background loops, AI tools. At most one alert per 15
            minutes per workflow.
          </div>
        </>
      )}
      {msg && <div className={`settings-note ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
      <div className="row-actions">
        <button className="btn btn-sm btn-primary" onClick={() => save()} disabled={busy}>
          Save alerts
        </button>
        {settings.enabled && (
          <button className="btn btn-sm btn-ghost" onClick={test} disabled={busy} title="Save, then send a test alert">
            <Send size={12} /> Send test alert
          </button>
        )}
        {settings.telegramBotTokenSet && (
          <button className="btn btn-sm btn-ghost btn-danger" onClick={() => save({ clearTelegramBotToken: true })} disabled={busy}>
            Remove bot token
          </button>
        )}
      </div>
    </div>
  );
}

// ---- AI tool (MCP) -----------------------------------------------------------
const EMPTY_MCP: WorkflowMcpSettings = { enabled: false, description: "", params: [] };

const TRIGGER_NAMES: Record<string, string> = { formTrigger: "Form trigger", chatTrigger: "Chat trigger" };

export function McpSection({
  mcp,
  nodes,
  onChange,
  onOpenAiTools,
}: {
  mcp?: WorkflowMcpSettings;
  /** the workflow's nodes — without typed inputs the trigger decides them */
  nodes?: Array<{ type?: string; data?: { config?: Record<string, unknown> } }>;
  onChange: (m: WorkflowMcpSettings) => void;
  onOpenAiTools?: () => void;
}) {
  const m = mcp || EMPTY_MCP;
  const fromTrigger = m.params.length ? null : toolInputsFor({ nodes });
  const set = (p: Partial<WorkflowMcpSettings>) => onChange({ ...m, ...p });
  const setParam = (i: number, p: Partial<McpParam>) => set({ params: m.params.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const outputs = m.outputs || [];
  const setOutput = (i: number, p: Partial<NonNullable<WorkflowMcpSettings["outputs"]>[number]>) => set({ outputs: outputs.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div className="insp-section">
      <div className="field-section">
        <Bot size={11} /> AI TOOL (MCP)
      </div>
      <label className="exec-loop-toggle">
        <input type="checkbox" checked={m.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span className="toggle-label">{m.enabled ? "ON" : "OFF"}</span>
        <span className="exec-loop-toggle-text">Offer this workflow as a tool to AI assistants</span>
      </label>
      {m.enabled && (
        <>
          <div className="field">
            <div className="field-label">What the tool does</div>
            <textarea value={m.description} placeholder="Looks up the current price of a coin and returns it." onChange={(e) => set({ description: e.target.value })} />
            <div className="field-help">The assistant reads this to decide when to call the tool — say what it does and returns.</div>
          </div>
          <div className="field">
            <div className="field-label">Inputs</div>
            {m.params.map((p, i) => (
              <div className="mcp-param" key={i}>
                <div className="kv-row">
                  <input value={p.name} placeholder="symbol" onChange={(e) => setParam(i, { name: e.target.value })} />
                  <Select value={p.type || "string"} onChange={(e) => setParam(i, { type: e.target.value as McpParam["type"] })}>
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Yes / no</option>
                    <option value="enum">One of a list</option>
                  </Select>
                  <label className="mcp-required" title="The assistant must send this input">
                    <input type="checkbox" checked={!!p.required} onChange={(e) => setParam(i, { required: e.target.checked })} /> required
                  </label>
                  <button className="btn btn-sm btn-ghost" onClick={() => set({ params: m.params.filter((_, j) => j !== i) })} title="Remove input">
                    <Trash2 size={12} />
                  </button>
                </div>
                <input value={p.description} placeholder="What it is, e.g. Trading pair such as BTCUSDT" onChange={(e) => setParam(i, { description: e.target.value })} />
                <div className="kv-row">
                  {p.type === "enum" && (
                    <input
                      value={(p.options || []).join(", ")}
                      placeholder="Allowed values, comma separated"
                      onChange={(e) => setParam(i, { options: e.target.value.split(",").map((o) => o.trimStart()) })}
                    />
                  )}
                  <input value={p.example || ""} placeholder="Example value (optional)" onChange={(e) => setParam(i, { example: e.target.value })} />
                </div>
              </div>
            ))}
            {fromTrigger && (
              <div className="field-help">
                {fromTrigger.params.length ? (
                  <>
                    Taken from the {TRIGGER_NAMES[fromTrigger.source] || "trigger"}:{" "}
                    {fromTrigger.params.map((p, i) => (
                      <span key={p.name}>
                        {i > 0 && ", "}
                        <code>{p.field || p.name}</code>
                      </span>
                    ))}
                    . Add inputs below only to ask for something else.
                  </>
                ) : (
                  <>No inputs needed — whatever the assistant sends goes straight to the trigger as its input. Add inputs to tell it what to send.</>
                )}
              </div>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => set({ params: [...m.params, { name: "", description: "" }] })}>
              <Plus size={12} /> Add input
            </button>
            <div className="field-help">
              The inputs arrive as the trigger's input, like a webhook body — use <code>{"{{symbol}}"}</code> in the nodes. Numbers and yes/no
              values are converted, and a missing required input is refused before the workflow runs.
            </div>
          </div>
          <div className="field">
            <div className="field-label">Answer fields (optional)</div>
            {outputs.map((o, i) => (
              <div className="kv-row" key={i}>
                <input value={o.name} placeholder="price" onChange={(e) => setOutput(i, { name: e.target.value })} />
                <Select value={o.type || "string"} onChange={(e) => setOutput(i, { type: e.target.value as "string" | "number" | "boolean" })}>
                  <option value="string">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Yes / no</option>
                </Select>
                <input value={o.description} placeholder="What it means" onChange={(e) => setOutput(i, { description: e.target.value })} />
                <button className="btn btn-sm btn-ghost" onClick={() => set({ outputs: outputs.filter((_, j) => j !== i) })} title="Remove field">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button className="btn btn-sm btn-ghost" onClick={() => set({ outputs: [...outputs, { name: "", description: "" }] })}>
              <Plus size={12} /> Add answer field
            </button>
            <div className="field-help">
              The tool answers with a Webhook Respond node's body, or the last node's output — as text and as JSON. Describing its fields tells
              the assistant what to expect back.
            </div>
          </div>
          {onOpenAiTools && (
            <button className="btn btn-sm btn-ghost" onClick={onOpenAiTools}>
              Connect an assistant (Settings → AI tools)
            </button>
          )}
        </>
      )}
    </div>
  );
}
