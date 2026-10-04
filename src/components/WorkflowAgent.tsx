import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, Eye, EyeOff, Loader2, Pin, Send, Settings2, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { api } from "../api";
import type { BuilderReference, BuilderSettings, Catalog, Workflow } from "../types";
import Select from "./Select";
import { SecretInput } from "./SecretInput";

interface Props {
  catalog: Catalog;
  /** the workflow as it is on the canvas right now (null while it is loading) */
  getWorkflow: () => Workflow | null;
  /** the editor imports the workflow the agent produced (and saves it) */
  onApply: (workflow: Workflow) => void;
  onClose: () => void;
  /** nodes the user pinned on the canvas as references for this request */
  references?: BuilderReference[];
  /** unpin a reference (the chip's ×) */
  onRemoveReference?: (nodeId: string) => void;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  /**
   * What the agent committed, as the server computed it from the two workflows
   * (added / removed / updated nodes, connections, renames). Shown as a small
   * monospace changelog under the answer.
   */
  changes?: string[];
  /** extra lines under an assistant answer: warnings / result stats */
  detail?: string[];
  error?: boolean;
}

// The marker in front of a change line decides its colour: "+" added,
// "-" removed, "~" updated.
function changeKind(line: string): string {
  if (line.startsWith("+ ")) return "add";
  if (line.startsWith("- ")) return "del";
  if (line.startsWith("~ ")) return "mod";
  return "";
}

const EMPTY_DRAFT = { provider: "openai", baseUrl: "", model: "", apiKey: "" };

/**
 * The AI workflow builder — a chat agent that writes and edits the workflow the
 * user is looking at. It works with the user's OWN model: no model ships with
 * W flow, so the first thing this panel asks for is the provider, base URL,
 * model and API key the agent should use. Those live encrypted in the server
 * database, tied to the account, and never leave it except towards the provider
 * the user configured.
 *
 * One turn = the user's prompt + the workflow on the canvas + the workflow-JSON
 * reference and the node documentation go to the model, and the new workflow
 * JSON comes back and replaces the canvas automatically. The server also
 * reports what actually changed between the two graphs, which this panel shows
 * as the agent's commit.
 */
export default function WorkflowAgent({ catalog, getWorkflow, onApply, onClose, references = [], onRemoveReference }: Props) {
  const providers = useMemo(() => catalog.providers || [], [catalog]);
  const [settings, setSettings] = useState<BuilderSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupNote, setSetupNote] = useState<string | null>(null);
  const [liveModels, setLiveModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [building, setBuilding] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.aiBuilder
      .settings()
      .then((s) => {
        setSettings(s);
        setDraft({ provider: s.provider || "openai", baseUrl: s.baseUrl || "", model: s.model || "", apiKey: "" });
        // A stored key means the user only needs to confirm/replace it — open
        // the setup form when there is nothing configured yet.
        if (!s.configured) setSetupOpen(true);
      })
      .catch(() => setSetupOpen(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, building, setupOpen]);

  // Live model list for the credentials form (same behaviour as the AI agent
  // builder: pasting a key loads the models the provider really exposes).
  useEffect(() => {
    if (!setupOpen) return;
    if (!draft.provider) return;
    if (!draft.apiKey.trim() && !settings?.hasKey) return;
    setModelsLoading(true);
    const t = setTimeout(() => {
      api.aiBuilder
        .models({ provider: draft.provider, baseUrl: draft.baseUrl, apiKey: draft.apiKey })
        .then((res) => setLiveModels(res.ok && res.models.length ? res.models : null))
        .catch(() => setLiveModels(null))
        .finally(() => setModelsLoading(false));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupOpen, draft.provider, draft.baseUrl, draft.apiKey, settings?.hasKey]);

  const providerPreset = useMemo(() => providers.find((p) => p.value === draft.provider), [providers, draft.provider]);

  const changeProvider = useCallback(
    (value: string) => {
      const preset = providers.find((p) => p.value === value);
      setLiveModels(null);
      setDraft((d) => ({ ...d, provider: value, baseUrl: preset?.defaultBaseUrl || "", model: preset?.defaultModel || "" }));
    },
    [providers]
  );

  const saveSetup = useCallback(async () => {
    setSetupError(null);
    setSetupNote(null);
    setSaving(true);
    try {
      const saved = await api.aiBuilder.save({
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        model: draft.model,
        // undefined = keep the stored key (the browser never received it)
        apiKey: draft.apiKey.trim() ? draft.apiKey : undefined,
      });
      setSettings(saved);
      setDraft((d) => ({ ...d, apiKey: "" }));
      if (!saved.configured) {
        setSetupError("Fill in the model (and, for hosted providers, the API key) and save again.");
      } else {
        setSetupNote("Saved — the agent is ready. Credentials are stored encrypted for your account only.");
        setSetupOpen(false);
      }
    } catch (err) {
      setSetupError(String((err as Error).message || err));
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const testSetup = useCallback(async () => {
    setSetupError(null);
    setSetupNote(null);
    setTesting(true);
    try {
      const res = await api.ai.models({ provider: draft.provider, baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      if (!draft.apiKey.trim() && !settings?.hasKey) {
        setSetupError("Enter the API key first (keep it blank to test the saved one).");
        return;
      }
      setSetupNote(res.models.length ? `Connection OK — the provider lists ${res.models.length} models.` : "Connection OK.");
    } catch (err) {
      setSetupError(String((err as Error).message || err));
    } finally {
      setTesting(false);
    }
  }, [draft, settings?.hasKey]);

  const forget = useCallback(async () => {
    if (!window.confirm("Remove the model credentials of the builder agent? The agent will be unavailable until you set them up again.")) return;
    try {
      await api.aiBuilder.clear();
      setSettings({ configured: false, provider: "", baseUrl: "", model: "", hasKey: false });
      setDraft({ ...EMPTY_DRAFT });
      setSetupOpen(true);
      setSetupError(null);
      setSetupNote("Credentials removed.");
    } catch (err) {
      setSetupError(String((err as Error).message || err));
    }
  }, []);

  const build = useCallback(async () => {
    const text = prompt.trim();
    if (!text || building) return;
    const workflow = getWorkflow();
    if (!workflow) {
      setTurns((t) => [...t, { role: "assistant", text: "The workflow is still loading — try again in a moment.", error: true }]);
      return;
    }
    const history = turns
      .filter((t) => t.text)
      .slice(-6)
      .map((t) => ({ role: t.role, content: t.text }));
    setPrompt("");
    setTurns((t) => [...t, { role: "user", text }]);
    setBuilding(true);
    try {
      const res = await api.aiBuilder.build({ prompt: text, workflow, history, references });
      // The result replaces the workflow the user is working on (the editor
      // saves it right away).
      onApply(res.workflow);
      const detail = [
        `✓ ${res.workflow.nodes.length} node(s) · ${res.workflow.edges.length} connection(s) now on the canvas.`,
        ...(res.warnings || []),
      ];
      setTurns((t) => [
        ...t,
        { role: "assistant", text: res.summary || "Workflow updated.", changes: res.changes || [], detail },
      ]);
    } catch (err) {
      setTurns((t) => [...t, { role: "assistant", text: String((err as Error).message || err), error: true }]);
    } finally {
      setBuilding(false);
    }
  }, [prompt, building, getWorkflow, turns, onApply, references]);

  const clearChat = useCallback(() => setTurns([]), []);

  const configured = !!settings?.configured;

  return (
    <div className="wf-agent" role="dialog" aria-label="AI workflow builder">
      <div className="wf-agent-head">
        <div className="wf-agent-title">
          <Sparkles size={13} />
          <span>Build with AI</span>
        </div>
        <div className="wf-agent-head-actions">
          {turns.length > 0 && (
            <button className="wf-agent-icon" onClick={clearChat} title="Clear this conversation">
              <Trash2 size={12} />
            </button>
          )}
          <button
            className={`wf-agent-icon ${setupOpen ? "active" : ""}`}
            onClick={() => setSetupOpen((o) => !o)}
            title="Model credentials for the agent"
          >
            <Settings2 size={12} />
          </button>
          <button className="wf-agent-icon" onClick={onClose} title="Close the agent">
            <X size={13} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="wf-agent-loading">
          <Loader2 size={14} className="spin" /> Checking your model credentials…
        </div>
      ) : setupOpen ? (
        <div className="wf-agent-setup">
          <p className="wf-agent-note">
            The agent has no built-in model — it uses <b>your</b> model. The credentials are stored encrypted for your account and
            are only ever sent to the provider you choose here.
          </p>

          <label className="wf-agent-label">Provider</label>
          <Select value={draft.provider} onChange={(e) => changeProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>

          <label className="wf-agent-label">Base URL</label>
          <input
            value={draft.baseUrl}
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            placeholder={providerPreset?.defaultBaseUrl || "https://api.openai.com/v1"}
          />

          <label className="wf-agent-label">Model</label>
          <div className="wf-agent-model-row">
            <input
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder={providerPreset?.defaultModel || "gpt-4o-mini"}
              list="wf-agent-models"
            />
            {modelsLoading && <Loader2 size={13} className="spin" />}
          </div>
          <datalist id="wf-agent-models">
            {(liveModels || providerPreset?.models || []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {liveModels?.length ? <div className="wf-agent-hint">{liveModels.length} models loaded from your provider.</div> : null}

          <label className="wf-agent-label">API key</label>
          <div className="wf-agent-key-row">
            <SecretInput
              value={draft.apiKey}
              revealed={showKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              placeholder={settings?.hasKey ? "•••••••• saved — leave empty to keep it" : "sk-…"}
            />
            <button className="wf-agent-icon" onClick={() => setShowKey((s) => !s)} title={showKey ? "Hide" : "Show"}>
              {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>

          {setupError && <div className="wf-agent-error">{setupError}</div>}
          {setupNote && <div className="wf-agent-ok"><Check size={12} /> {setupNote}</div>}

          <div className="wf-agent-setup-actions">
            {configured && (
              <button className="btn btn-sm btn-ghost" onClick={forget} title="Remove the stored credentials">
                Forget
              </button>
            )}
            <button className="btn btn-sm" onClick={testSetup} disabled={testing}>
              {testing ? "Testing…" : "Test"}
            </button>
            <button className="btn btn-sm btn-primary" onClick={saveSetup} disabled={saving}>
              {saving ? "Saving…" : "Save credentials"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="wf-agent-log">
            {turns.length === 0 ? (
              <div className="wf-agent-empty">
                <Bot size={18} />
                <div>
                  <b>Describe the workflow you want.</b>
                  <br />
                  The agent reads your current workflow and writes the new one straight onto the canvas.
                </div>
                <div className="wf-agent-examples">
                  {[
                    "Build a workflow that takes a webhook payload and posts it to Slack.",
                    "Add an AI step that summarises the email and store the result in Google Sheets.",
                    "Every weekday at 9:00, fetch the RSS feed and email me the new items.",
                  ].map((ex) => (
                    <button key={ex} className="wf-agent-example" onClick={() => setPrompt(ex)}>
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn, i) => (
                <div key={i} className={`wf-agent-turn ${turn.role}${turn.error ? " error" : ""}`}>
                  <div className="wf-agent-bubble">{turn.text}</div>
                  {turn.changes && (
                    <div className="wf-agent-commit">
                      <div className="wf-agent-commit-head">Committed</div>
                      {turn.changes.length ? (
                        turn.changes.map((line, j) => (
                          <div key={j} className={`wf-agent-commit-line ${changeKind(line)}`}>
                            {line}
                          </div>
                        ))
                      ) : (
                        <div className="wf-agent-commit-line dim">No change to the workflow.</div>
                      )}
                    </div>
                  )}
                  {turn.detail?.map((line, j) => (
                    <div key={j} className="wf-agent-detail">
                      {line}
                    </div>
                  ))}
                </div>
              ))
            )}
            {building && (
              <div className="wf-agent-turn assistant">
                <div className="wf-agent-bubble dim">
                  <Loader2 size={12} className="spin" /> {settings?.model || "your model"} is building the workflow…
                </div>
              </div>
            )}
            <div ref={logEndRef} />
          </div>

          <div className="wf-agent-compose">
            {references.length > 0 && (
              <div className="wf-agent-refs" title="These nodes are pinned as references — the agent keeps their exact settings unless you ask to change them">
                <span className="wf-agent-refs-label">
                  <Pin size={10} /> REFERENCES
                </span>
                {references.map((ref) => (
                  <span key={ref.nodeId} className="wf-agent-ref-chip">
                    {ref.label}
                    <code>{ref.type}</code>
                    {onRemoveReference && (
                      <button onClick={() => onRemoveReference(ref.nodeId)} title={`Remove “${ref.label}” from the references`}>
                        <X size={9} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  build();
                }
              }}
              placeholder={configured ? "Describe the workflow or the change you want…" : "Set up your model credentials first"}
              rows={3}
              disabled={!configured || building}
            />
            <div className="wf-agent-compose-foot">
              <span className="wf-agent-model">
                {settings?.model ? `${settings.provider || "model"} · ${settings.model}` : "no model configured"}
              </span>
              <button className="btn btn-sm btn-primary" onClick={build} disabled={!configured || building || !prompt.trim()}>
                {building ? <Loader2 size={12} className="spin" /> : <Wand2 size={12} />} Build workflow
              </button>
            </div>
            {!configured && (
              <button className="wf-agent-link" onClick={() => setSetupOpen(true)}>
                <Send size={11} /> Add your model credentials
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
