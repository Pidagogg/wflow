import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, Eye, EyeOff, MessageSquare, Plus, Settings2, Trash2 } from "lucide-react";
import { api } from "../api";
import type { Agent, Catalog } from "../types";
import { Toast, useToast } from "../components/Toast";
import { getSettings } from "../settings";
import { syncWorkspaceUrl } from "../routes";
import Select from "../components/Select";
import { SecretInput } from "../components/SecretInput";

interface Props {
  catalog: Catalog;
  agentId?: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  toolRuns?: Array<{ name: string; args: string; output: unknown }>;
}

function blankAgent(): Agent {
  return {
    id: `ag-${crypto.randomUUID().slice(0, 8)}`,
    name: "New Agent",
    description: "AI agent built in W flow",
    model: { provider: "openai", baseUrl: "", apiKey: "", model: "gpt-4o-mini", temperature: 0.7, maxTokens: 1024 },
    systemPrompt:
      "You are a precise, helpful assistant inside a self-hosted automation platform. Answer concisely. Use the http_request tool when you need live data.",
    memory: true,
    tools: { http: true, time: true, httpMethod: "GET", httpUrl: "https://api.example.com/data", httpHeaders: '{\n  "Content-Type": "application/json"\n}', httpBody: "{}" },
  };
}

export default function AgentsPage({ catalog, agentId }: Props) {
  const providers = useMemo(() => catalog.providers || [], [catalog]);
  const { show, toast } = useToast();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [current, setCurrent] = useState<Agent | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"config" | "chat">("config");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Live model list — when a provider + API key are present, ask the provider
  // which models it actually exposes (falls back to the static catalog list).
  const [liveModels, setLiveModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const apiKey = current?.model.apiKey || "";
  const providerValue = current?.model.provider || "";
  const baseUrlValue = current?.model.baseUrl || "";
  useEffect(() => {
    if (!current || !apiKey.trim() || !providerValue) return;
    setModelsLoading(true);
    const t = setTimeout(() => {
      api.ai
        .models({ provider: providerValue, baseUrl: baseUrlValue, apiKey })
        .then((res) => setLiveModels(res.ok && res.models.length ? res.models : null))
        .catch(() => setLiveModels(null))
        .finally(() => setModelsLoading(false));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerValue, apiKey, baseUrlValue]);

  // Auto-save: a few seconds after the last change, persist the agent so pasted
  // credentials are never lost (honours Settings → auto-save, on by default).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty || !current || !getSettings().autoSave) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      save();
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, dirty]);

  // keep a ref to the latest agent so the beforeunload flush always writes the
  // freshest state without re-binding the listener on every keystroke
  const currentRef = useRef<Agent | null>(null);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Final flush when the tab/window is closed so a just-pasted API key is never
  // lost even if the debounce hadn't fired yet.
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (!dirty) return;
      const agent = currentRef.current;
      if (agent) {
        fetch(`/api/agents/${agent.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(agent),
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [dirty]);

  // load agents, pick requested or first
  useEffect(() => {
    api.agents
      .list()
      .then((list) => {
        setAgents(list);
        const pick = list.find((a) => a.id === agentId) || list[0] || null;
        setCurrent(pick ? JSON.parse(JSON.stringify(pick)) : null);
      })
      .catch(() => show("Failed to load agents", "err"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const select = (a: Agent) => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setCurrent(JSON.parse(JSON.stringify(a)));
    setDirty(false);
    setMessages([]);
    setChatError(null);
    setTab("config");
  };

  const create = async () => {
    const a = blankAgent();
    try {
      const saved = await api.agents.create(a);
      setAgents((list) => [saved, ...list]);
      setCurrent(JSON.parse(JSON.stringify(saved)));
      setDirty(false);
      setMessages([]);
      setTab("config");
      syncWorkspaceUrl(`agent/${saved.id}`);
      show("Agent created");
    } catch (err) {
      show(`Failed to create agent: ${(err as Error).message}`, "err");
    }
  };

  const remove = async (e: React.MouseEvent, a: Agent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete agent "${a.name}"?`)) return;
    try {
      await api.agents.remove(a.id);
      const list = agents.filter((x) => x.id !== a.id);
      setAgents(list);
      if (current?.id === a.id) {
        setCurrent(list[0] ? JSON.parse(JSON.stringify(list[0])) : null);
        setMessages([]);
      }
      show("Agent deleted");
    } catch {
      show("Failed to delete agent", "err");
    }
  };

  const patch = useCallback((p: Partial<Agent>) => {
    setCurrent((c) => (c ? { ...c, ...p } : c));
    setDirty(true);
  }, []);

  const patchModel = useCallback((p: Record<string, unknown>) => {
    setCurrent((c) => (c ? { ...c, model: { ...c.model, ...p } } : c));
    setDirty(true);
  }, []);

  const patchTools = useCallback((p: Record<string, unknown>) => {
    setCurrent((c) => (c ? { ...c, tools: { ...(c.tools || {}), ...p } } : c));
    setDirty(true);
  }, []);

  const save = async () => {
    if (!current) return;
    setSaving(true);
    try {
      const saved = await api.agents.update(current);
      setAgents((list) => list.map((a) => (a.id === saved.id ? saved : a)));
      setCurrent(JSON.parse(JSON.stringify(saved)));
      setDirty(false);
      syncWorkspaceUrl(`agent/${saved.id}`);
      show("Agent saved");
    } catch (err) {
      show(`Save failed: ${(err as Error).message}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!current) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.ai.test(current.model as unknown as Record<string, unknown>);
      setTestResult({ ok: !!res.ok, msg: res.ok ? res.reply || "Connected" : res.error || "Connection failed" });
    } catch (err) {
      setTestResult({ ok: false, msg: String((err as Error).message || err) });
    } finally {
      setTesting(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !current || sending) return;
    setInput("");
    setChatError(null);
    const history: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setSending(true);
    try {
      const res = await api.agents.chat(
        current.id,
        history.map((m) => ({ role: m.role, content: m.content }))
      );
      if (res.error) {
        setChatError(res.error);
        setSending(false);
        return;
      }
      setMessages((msgs) => [...msgs, { role: "assistant", content: res.reply, toolRuns: res.toolRuns }]);
    } catch (err) {
      setChatError(String((err as Error).message || err));
    } finally {
      setSending(false);
    }
  };

  const provider = providers.find((p) => p.value === current?.model.provider);
  // models offered by the selected provider: the live list fetched with the
  // user's own API key when available, else the static catalog list
  const providerModels = liveModels ?? (provider?.models?.length ? provider.models : null);

  return (
    <div className="agents">
      {/* sidebar */}
      <aside className="agents-side">
        <div className="agents-side-head">
          <span className="section-label" style={{ margin: 0 }}>
            AI Agents <span className="count">{agents.length}</span>
          </span>
          <button className="btn btn-sm" onClick={create}>
            <Plus size={12} /> New
          </button>
        </div>
        <div className="agents-list">
          {agents.length === 0 && (
            <div className="insp-hint-box" style={{ margin: 6 }}>
              No agents yet. Create one to configure a model, prompt and tools — then use it in workflows via the AI Agent node.
            </div>
          )}
          {agents.map((a) => (
            <div key={a.id} className={`agent-card ${current?.id === a.id ? "active" : ""}`} onClick={() => select(a)}>
              <button className="del" onClick={(e) => remove(e, a)} title="Delete">
                <Trash2 size={11} />
              </button>
              <div className="agent-card-name">
                <span className="bot-mini">
                  <Bot size={13} />
                </span>
                {a.name}
              </div>
              <div className="agent-card-desc">{a.description || "No description"}</div>
              <div className="agent-card-meta">
                <span className="tag">{a.model?.provider || "?"}</span>
                <span className="tag">{a.model?.model || "no model"}</span>
                {(a.tools?.http || a.tools?.time) && <span className="tag">Tools</span>}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* main */}
      <main className="agent-main">
        {!current ? (
          <div className="chat-empty">
            <span className="big">
              <Bot size={44} />
            </span>
            SELECT OR CREATE AN AGENT TO BEGIN
            <button className="btn btn-sm" onClick={create} style={{ marginTop: 8 }}>
              <Plus size={12} /> New agent
            </button>
          </div>
        ) : (
          <>
            <div className="agent-tabs">
              <button className={`agent-tab ${tab === "config" ? "active" : ""}`} onClick={() => setTab("config")}>
                <Settings2 size={12} style={{ marginRight: 5, verticalAlign: -2 }} />
                Config
              </button>
              <button className={`agent-tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>
                <MessageSquare size={12} style={{ marginRight: 5, verticalAlign: -2 }} />
                Chat test
              </button>
              {dirty && <span className="ed-dirty" style={{ alignSelf: "center", marginLeft: 8 }}>● Unsaved</span>}
            </div>

            <div className="agent-body">
              {tab === "config" ? (
                <div className="agent-config">
                  <div className="field-row">
                    <div className="field">
                      <div className="field-label">Agent name</div>
                      <input value={current.name} onChange={(e) => patch({ name: e.target.value })} />
                    </div>
                    <div className="field">
                      <div className="field-label">Description</div>
                      <input value={current.description || ""} onChange={(e) => patch({ description: e.target.value })} />
                    </div>
                  </div>

                  <div className="divider">
                    <span>Model — enter your provider credentials</span>
                  </div>

                  <div className="field-row">
                    <div className="field">
                      <div className="field-label">Provider</div>
                      <Select
                        value={current.model.provider}
                        onChange={(e) => {
                          const next = e.target.value;
                          const nextProvider = providers.find((p) => p.value === next);
                          // keep the current model when the new provider offers it, otherwise
                          // fall back to that provider's default model; auto-fill the base
                          // URL with the provider's default when none is set
                          const keep = nextProvider?.models?.includes(current.model.model || "");
                          patchModel({
                            provider: next,
                            ...(keep ? {} : { model: nextProvider?.defaultModel || "" }),
                            ...(nextProvider?.defaultBaseUrl && !current.model.baseUrl ? { baseUrl: nextProvider.defaultBaseUrl } : {}),
                          });
                        }}
                      >
                        {providers.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="field">
                      <div className="field-label">Model</div>
                      {providerModels ? (
                        <Select value={current.model.model || ""} onChange={(e) => patchModel({ model: e.target.value })}>
                          {/* keep any saved model that is not in the list (e.g. a fine-tune) */}
                          {!providerModels.includes(current.model.model || "") && (
                            <option value={current.model.model || ""}>{current.model.model || "custom…"}</option>
                          )}
                          {providerModels.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <input
                          value={current.model.model || ""}
                          placeholder={provider?.defaultModel || "model name"}
                          onChange={(e) => patchModel({ model: e.target.value })}
                        />
                      )}
                      <div className="field-help">
                        {modelsLoading ? (
                          <span style={{ color: "var(--cyan)" }}>⏳ Loading models from {provider?.label || "provider"}…</span>
                        ) : providerModels ? (
                          `Models available via ${provider?.label || "this provider"}.`
                        ) : apiKey.trim() ? (
                          "No model list returned by the provider — type the exact model name."
                        ) : (
                          "Paste the API key above to load the available models."
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="field">
                    <div className="field-label">Base URL</div>
                    <input
                      value={current.model.baseUrl || ""}
                      placeholder={provider?.defaultBaseUrl || "https://…"}
                      onChange={(e) => patchModel({ baseUrl: e.target.value })}
                    />
                    <div className="field-help">Leave empty to use the provider default ({provider?.defaultBaseUrl || "custom endpoint"}).</div>
                  </div>

                  <div className="field">
                    <div className="field-label">🔒 API key</div>
                    <div className="secret-row">
                      {/* The key is saved on the server (./data), never in the
                          browser's password manager — see SecretInput. */}
                      <SecretInput
                        revealed={showApiKey}
                        value={current.model.apiKey || ""}
                        placeholder="Paste your API key"
                        onChange={(e) => {
                          const key = e.target.value;
                          patchModel({
                            apiKey: key,
                            // pasting a key also fills in the provider's base URL
                            // when none has been entered yet
                            ...(key && !current.model.baseUrl && provider?.defaultBaseUrl ? { baseUrl: provider.defaultBaseUrl } : {}),
                          });
                        }}
                      />
                      <button
                        type="button"
                        className="secret-toggle"
                        onClick={() => setShowApiKey((visible) => !visible)}
                        title={showApiKey ? "Hide API key" : "Show API key"}
                        aria-label={showApiKey ? "Hide API key" : "Show API key"}
                      >
                        {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <div className="field-help">
                      {["ollama", "lmstudio"].includes(current.model.provider)
                        ? "No key needed for local models (Ollama / LM Studio)."
                        : getSettings().autoSave
                          ? "Pasted keys are saved automatically (Settings → auto-save) — stored encrypted in the server database."
                          : "Stored encrypted in the server database, tied to this account. Never shared with other users."}
                    </div>
                  </div>

                  <div className="field-row-3">
                    <div className="field">
                      <div className="field-label">Temperature</div>
                      <input type="number" step="0.1" min="0" max="2" value={current.model.temperature ?? 0.7} onChange={(e) => patchModel({ temperature: Number(e.target.value) })} />
                    </div>
                    <div className="field">
                      <div className="field-label">Max tokens</div>
                      <input type="number" value={current.model.maxTokens ?? 1024} onChange={(e) => patchModel({ maxTokens: Number(e.target.value) })} />
                    </div>
                    <div className="field">
                      <div className="field-label" style={{ opacity: 0 }}>
                        .
                      </div>
                      <button className="btn btn-sm" onClick={test} disabled={testing} style={{ width: "100%", justifyContent: "center" }}>
                        {testing ? "Testing…" : "Test connection"}
                      </button>
                    </div>
                  </div>
                  {testResult && (
                    <div className="field-help" style={{ color: testResult.ok ? "var(--green)" : "var(--red)" }}>
                      {testResult.ok ? "✓ " : "✗ "}
                      {testResult.msg}
                    </div>
                  )}

                  <div className="divider">
                    <span>Behavior</span>
                  </div>

                  <div className="field">
                    <div className="field-label">System prompt</div>
                    <textarea
                      className="big-textarea"
                      value={current.systemPrompt || ""}
                      onChange={(e) => patch({ systemPrompt: e.target.value })}
                    />
                  </div>

                  <div className="field">
                    <label className="toggle">
                      <input type="checkbox" checked={current.memory !== false} onChange={(e) => patch({ memory: e.target.checked })} />
                      <span className="toggle-track" />
                      <span className="toggle-label">Keep conversation memory across messages</span>
                    </label>
                  </div>

                  <div className="divider">
                    <span>Tools</span>
                  </div>

                  <div className="field">
                    <label className="toggle">
                      <input type="checkbox" checked={!!current.tools?.http} onChange={(e) => patchTools({ http: e.target.checked })} />
                      <span className="toggle-track" />
                      <span className="toggle-label">HTTP request tool (model can call external APIs)</span>
                    </label>
                  </div>

                  {current.tools?.http && (
                    <>
                      <div className="field-row-3">
                        <div className="field">
                          <div className="field-label">Method</div>
                          <Select value={current.tools.httpMethod || "GET"} onChange={(e) => patchTools({ httpMethod: e.target.value })}>
                            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                              <option key={m}>{m}</option>
                            ))}
                          </Select>
                        </div>
                        <div className="field" style={{ gridColumn: "span 2" }}>
                          <div className="field-label">Default URL</div>
                          <input value={current.tools.httpUrl || ""} placeholder="https://api.example.com/data" onChange={(e) => patchTools({ httpUrl: e.target.value })} />
                        </div>
                      </div>
                      <div className="field-row">
                        <div className="field">
                          <div className="field-label">Headers (JSON)</div>
                          <textarea value={current.tools.httpHeaders || "{}"} spellCheck={false} onChange={(e) => patchTools({ httpHeaders: e.target.value })} />
                        </div>
                        <div className="field">
                          <div className="field-label">Body (JSON)</div>
                          <textarea value={current.tools.httpBody || "{}"} spellCheck={false} onChange={(e) => patchTools({ httpBody: e.target.value })} />
                        </div>
                      </div>
                    </>
                  )}

                  <div className="field">
                    <label className="toggle">
                      <input type="checkbox" checked={!!current.tools?.time} onChange={(e) => patchTools({ time: e.target.checked })} />
                      <span className="toggle-track" />
                      <span className="toggle-label">Current time tool</span>
                    </label>
                  </div>

                  <div className="agent-savebar">
                    <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
                      <Check size={13} /> {saving ? "Saving…" : "Save agent"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="chat">
                  <div className="chat-head">
                    <Bot size={16} style={{ color: "var(--violet)" }} />
                    <span style={{ fontWeight: 700 }}>{current.name}</span>
                    <span className="info">
                      {provider?.label} · {current.model.model || "no model"}
                    </span>
                  </div>

                  <div className="chat-messages">
                    {messages.length === 0 && (
                      <div className="chat-empty">
                        <span className="big">⌁</span>
                        SEND A MESSAGE TO TEST YOUR AGENT
                      </div>
                    )}
                    {messages.map((m, i) => (
                      <div key={i} className={`msg ${m.role}`}>
                        <div className="msg-label">{m.role === "user" ? "You" : "Agent"}</div>
                        <div className="msg-bubble">{m.content}</div>
                        {m.toolRuns && m.toolRuns.length > 0 && (
                          <div className="msg-tools">
                            {m.toolRuns.map((t, j) => (
                              <div key={j} className="msg-tool">
                                <span className="tool-name">🔧 {t.name}</span>
                                <div className="tool-out">
                                  args: {t.args}
                                  <br />
                                  out: {typeof t.output === "string" ? t.output : JSON.stringify(t.output)}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {sending && (
                      <div className="msg assistant">
                        <div className="msg-label">Agent</div>
                        <div className="typing">
                          <span />
                          <span />
                          <span />
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>

                  {chatError && <div className="chat-error">✗ {chatError}</div>}

                  <div className="chat-input">
                    <textarea
                      value={input}
                      placeholder="Message your agent…"
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                    />
                    <button className="btn btn-primary" onClick={send} disabled={sending || !input.trim()}>
                      Send
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>

      <Toast toast={toast} />
    </div>
  );
}
