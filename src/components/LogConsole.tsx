import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Clock, Copy, Download, History, MessageCircle, MessageSquare, Play, RefreshCw, RotateCcw, Send, Terminal, X } from "lucide-react";
import type { ApprovalRequest, ChatMessage, ExecResult, ExecutionSummary, WaitingRun } from "../types";

interface Props {
  result: ExecResult | null;
  loading: boolean;
  /** true while the user pressed Stop and the run is finishing its last node */
  stopping?: boolean;
  /** set while a run is waiting for its trigger (webhook, input or chat) */
  waiting?: WaitingRun | null;
  onCancelWait?: () => void;
  height: number;
  width: number | null; // null = full width of the canvas area
  onResizeHeight: (h: number) => void;
  onResizeWidth: (w: number) => void;
  onClose: () => void;
  /** true when the workflow uses a Chat Trigger / Chat Output node */
  hasChat?: boolean;
  chatMessages?: ChatMessage[];
  sendingChat?: boolean;
  onSendChat?: (text: string) => void | Promise<void>;
  /** submit the payload a waiting non-inbound trigger asked for */
  onSubmitInput?: (payload: unknown) => boolean | Promise<boolean>;
  /** saved runs of this workflow, newest first (Execution menu history) */
  history?: ExecutionSummary[];
  /** id of the history entry currently shown in the console */
  activeExecutionId?: string | null;
  onLoadHistory?: (id: string) => void;
  onRefreshHistory?: () => void;
  /** the "Wait for Approval" node the current run is parked on, if any */
  approval?: ApprovalRequest | null;
  onAnswerApproval?: (approved: boolean) => void | Promise<void>;
  answeringApproval?: boolean;
  /** re-run the workflow with the same input as the run on screen */
  onReplay?: () => void;
  /** re-run only from the node that failed, with the input it had */
  onRetryFailed?: () => void;
  /** open the Comments / Changes panel next to the console */
  onOpenCollab?: (tab: "comments" | "history") => void;
  /** open comment threads in this workflow */
  openComments?: number;
}

type Tab = "execution" | "chat";

export default function LogConsole({
  result,
  loading,
  stopping,
  waiting,
  onCancelWait,
  height,
  width,
  onResizeHeight,
  onResizeWidth,
  onClose,
  hasChat = false,
  chatMessages = [],
  sendingChat = false,
  onSendChat,
  onSubmitInput,
  history = [],
  activeExecutionId,
  onLoadHistory,
  onRefreshHistory,
  approval = null,
  onAnswerApproval,
  answeringApproval = false,
  onReplay,
  onRetryFailed,
  onOpenCollab,
  openComments = 0,
}: Props) {
  // Average duration of the recorded runs — the same number the Executions view
  // shows, so "how fast is this workflow on average?" is answered in both places.
  const historyAvgMs = useMemo(() => {
    if (!history.length) return 0;
    return history.reduce((sum, h) => sum + (h.durationMs || 0), 0) / history.length;
  }, [history]);
  const fmtDuration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

  const fmtSize = (n?: number) => {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  const filesTotal = result ? result.log.reduce((a, l) => a + (l.filesWritten?.length || 0), 0) : 0;
  // AI usage of the run: tokens across every model call, and (when the run has
  // been priced against the account's table) what that cost.
  const totalTokens = result?.usage ? Number(result.usage.total || (result.usage.prompt || 0) + (result.usage.completion || 0)) : 0;
  const fmtCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(5)}`);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>(() => (waiting?.awaiting === "chat" ? "chat" : "execution"));
  const [chatDraft, setChatDraft] = useState("");
  const [inputDraft, setInputDraft] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);

  const awaiting = waiting?.awaiting || (waiting ? "webhook" : undefined);

  // Land on the Chat tab as soon as a chat run starts waiting for a message.
  useEffect(() => {
    if (waiting?.awaiting === "chat") setTab("chat");
  }, [waiting?.awaiting]);

  // keep the newest log entries in view
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [result, loading]);

  // keep the newest chat messages in view
  useEffect(() => {
    chatBodyRef.current?.scrollTo({ top: chatBodyRef.current.scrollHeight });
  }, [chatMessages, sendingChat, tab]);

  useEffect(() => {
    if (tab === "chat" && awaiting === "chat") chatInputRef.current?.focus();
  }, [tab, awaiting]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startResize = (e: React.PointerEvent, axis: "h" | "w") => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startH = height;
    const startW = rootRef.current?.clientWidth ?? 0;
    const move = (ev: PointerEvent) => {
      if (axis === "h") onResizeHeight(startH + (startY - ev.clientY));
      else onResizeWidth(startW + (ev.clientX - startX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

  const statusLabel = loading
    ? stopping
      ? "STOPPING"
      : "RUNNING"
    : waiting
      ? awaiting === "chat"
        ? "💬 CHAT OPEN"
        : awaiting === "input"
          ? "⌸ WAITING FOR INPUT"
          : "⏳ WAITING FOR WEBHOOK"
      : result
        ? result.aborted
          ? "■ STOPPED"
          : result.success
            ? "✓ SUCCESS"
            : "✗ ERRORS"
        : "IDLE";
  const statusClass = waiting
    ? "waiting"
    : result
      ? result.aborted
        ? "stopped"
        : result.success
          ? "success"
          : "error"
      : "";

  const sendChat = () => {
    const text = chatDraft.trim();
    if (!text || sendingChat || !onSendChat) return;
    setChatDraft("");
    onSendChat(text);
  };

  // Parse the pasted payload; a bare string is accepted as { message } so a
  // quick text test still works.
  const submitInput = async () => {
    if (!onSubmitInput) return;
    const raw = inputDraft.trim();
    let parsed: unknown = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        setInputError("Invalid JSON — fix it before running, or leave the box empty to send an empty event.");
        return;
      }
    }
    setInputError(null);
    await onSubmitInput(parsed);
  };

  // Chat shown in the Execution tab too, so the conversation and the node log
  // live side by side (see the request: "add the chat to the execution tab").
  const executionChat = useMemo(() => (hasChat && chatMessages.length ? chatMessages : []), [hasChat, chatMessages]);

  return (
    <div ref={rootRef} className="log-console" style={{ height, width: width ?? "100%" }}>
      {/* resize handles (large invisible hit areas + visible grips) */}
      <div className="log-console-resize log-console-resize-top" title="Drag to resize height" onPointerDown={(e) => startResize(e, "h")} />
      <div className="log-console-resize log-console-resize-right" title="Drag to resize width" onPointerDown={(e) => startResize(e, "w")} />
      <div className="log-console-grip log-console-grip-h" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="log-console-grip log-console-grip-v" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className="log-console-head">
        <Terminal size={13} style={{ color: "var(--cyan)" }} />
        <div className="log-console-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "execution"}
            className={`log-tab ${tab === "execution" ? "active" : ""}`}
            onClick={() => setTab("execution")}
          >
            EXECUTION
          </button>
          {hasChat && (
            <button
              role="tab"
              aria-selected={tab === "chat"}
              className={`log-tab ${tab === "chat" ? "active" : ""}`}
              onClick={() => setTab("chat")}
            >
              <MessageCircle size={12} /> Chat
              {chatMessages.length > 0 && <span className="log-tab-count">{chatMessages.length}</span>}
            </button>
          )}
        </div>
        {onOpenCollab && (
          <span className="log-collab-btns">
            <button className="log-tab" onClick={() => onOpenCollab("comments")} title="Comments on this workflow's steps">
              <MessageSquare size={12} /> Comments{openComments ? <span className="log-tab-count">{openComments}</span> : null}
            </button>
            <button className="log-tab" onClick={() => onOpenCollab("history")} title="Who changed what — and restore a single node">
              <History size={12} /> Changes
            </button>
          </span>
        )}
        <span className={`run-status ${statusClass}`}>{statusLabel}</span>
        {waiting && (
          <span className="run-meta">
            <span>🔗 {result?.nodeCount ?? 0} nodes</span>
          </span>
        )}
        {result && (
          <span className="run-meta">
            <span>⏱ {result.durationMs} ms</span>
            <span>🔗 {result.nodeCount} nodes</span>
            {filesTotal > 0 && <span>📄 {filesTotal} file{filesTotal === 1 ? "" : "s"}</span>}
            {totalTokens > 0 && (
              <span title="Model tokens used by this run">🧠 {totalTokens.toLocaleString()} tok</span>
            )}
            {typeof result.aiCostUsd === "number" && result.aiCostUsd > 0 && (
              <span className="run-cost" title="Estimated AI cost for this run (Settings → AI usage & cost)">
                {fmtCost(result.aiCostUsd)}
              </span>
            )}
          </span>
        )}
        <span style={{ marginLeft: "auto" }} />
        {onRetryFailed && result && !loading && !waiting && result.executionId && result.log.some((l) => l.status === "error" && !l.handled) && (
          <button
            className="run-replay"
            onClick={onRetryFailed}
            title="Run again from the node that failed, with the input it had — the nodes before it are not repeated"
          >
            <RotateCcw size={12} /> RETRY FROM FAILED NODE
          </button>
        )}
        {onReplay && result && !loading && !waiting && (
          <button className="run-replay" onClick={onReplay} title="Run this workflow again with the same input">
            <RotateCcw size={12} /> REPLAY
          </button>
        )}
        <button className="run-close" onClick={onClose} title="Close log">
          <X size={13} />
        </button>
      </div>

      {tab === "chat" ? (
        <div className="log-console-body log-chat" ref={chatBodyRef}>
          {chatMessages.length === 0 && !sendingChat && (
            <div className="insp-hint-box">
              {awaiting === "chat"
                ? "Chat is ready — send a message to run the workflow."
                : "Press Run to open a chat with this workflow. Each message runs it once; a Chat Output node sends the reply back here."}
            </div>
          )}
          {chatMessages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              <div className="chat-msg-role">{m.role === "user" ? "YOU" : "WORKFLOW"}</div>
              <div className="chat-msg-text">{m.text}</div>
            </div>
          ))}
          {sendingChat && (
            <div className="chat-msg assistant">
              <div className="chat-msg-role">Workflow</div>
              <div className="chat-msg-text">
                <span className="spinner" /> thinking…
              </div>
            </div>
          )}
          <div className="chat-compose">
            <input
              ref={chatInputRef}
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendChat();
                }
              }}
              placeholder="Type a message and press Enter…"
              disabled={sendingChat}
            />
            <button className="btn btn-sm btn-primary" onClick={sendChat} disabled={sendingChat || !chatDraft.trim()}>
              <Send size={12} /> Send
            </button>
          </div>
        </div>
      ) : (
        <div className="log-console-body" ref={bodyRef}>
          {/* Human-in-the-loop: the run is parked on a "Wait for Approval" node
              and only continues once someone answers here. */}
          {approval && (
            <div className="run-approval">
              <div className="run-approval-head">
                <Clock size={13} /> Waiting for approval
                {approval.nodeName && <span className="run-approval-node">· {approval.nodeName}</span>}
              </div>
              <div className="run-approval-msg">{approval.message}</div>
              <div className="run-approval-actions">
                <button className="btn btn-sm btn-primary" disabled={answeringApproval} onClick={() => onAnswerApproval?.(true)}>
                  <Check size={12} /> {approval.approveLabel}
                </button>
                <button className="btn btn-sm btn-danger" disabled={answeringApproval} onClick={() => onAnswerApproval?.(false)}>
                  <X size={12} /> {approval.rejectLabel}
                </button>
                {answeringApproval && <span className="spinner" />}
              </div>
              <div className="run-approval-hint">
                The run is paused at this node. It continues down the <b>Approved</b> or the <b>Rejected</b> output — and if nobody answers in time, the node's
                “when nobody answers” setting applies instead.
              </div>
            </div>
          )}

          {/* Saved runs — click one to reopen its full log below. */}
          {history.length > 0 && (
            <div className="run-history">
              <div className="run-history-head">
                <span className="run-io-label">
                  <History size={11} /> History ({history.length})
                  {historyAvgMs > 0 && <span className="run-history-avg"> · avg {fmtDuration(historyAvgMs)}</span>}
                </span>
                {onRefreshHistory && (
                  <button className="run-history-refresh" onClick={onRefreshHistory} title="Refresh history">
                    <RefreshCw size={11} />
                  </button>
                )}
              </div>
              <div className="run-history-list">
                {history.map((h) => (
                  <button
                    key={h.id}
                    className={`run-history-row ${activeExecutionId === h.id ? "active" : ""} ${h.success ? "ok" : "err"}`}
                    onClick={() => onLoadHistory?.(h.id)}
                    title="Open this run"
                  >
                    <span className={`dot ${h.success ? "ok" : "err"}`} />
                    <span className="run-history-source">{h.source}</span>
                    <span className="run-history-time">
                      {h.startedAt ? new Date(h.startedAt).toLocaleString() : "—"}
                    </span>
                    <span className="run-history-meta">
                      {h.durationMs} ms · {h.nodeCount} nodes
                      {h.errorCount > 0 ? ` · ${h.errorCount} err` : ""}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* chat mirrored into the execution view */}
          {executionChat.length > 0 && (
            <div className="run-chat-section">
              <div className="run-io-label">
                <MessageCircle size={11} /> Chat ({executionChat.length})
              </div>
              {executionChat.map((m, i) => (
                <div key={i} className={`chat-msg ${m.role}`}>
                  <div className="chat-msg-role">{m.role === "user" ? "YOU" : "WORKFLOW"}</div>
                  <div className="chat-msg-text">{m.text}</div>
                </div>
              ))}
            </div>
          )}

          {loading && (
            <div className="run-loading">
              <span className="spinner" /> {stopping ? "Stopping — waiting for the current node to finish…" : "Executing workflow…"}
            </div>
          )}

          {!loading && !waiting && !result && <div className="insp-hint-box">Run the workflow to see the execution log here.</div>}

          {!loading && awaiting === "webhook" && waiting && (
            <div className="run-waiting">
              <div className="run-waiting-title">⏳ Waiting for a webhook call</div>
              <div className="run-waiting-msg">{waiting.message}</div>
              <div className="run-waiting-url">
                <code>
                  {window.location.origin}
                  {waiting.webhookUrl}
                </code>
                <button
                  className="btn btn-sm"
                  title="Copy webhook URL"
                  onClick={() => navigator.clipboard?.writeText(window.location.origin + waiting.webhookUrl)}
                >
                  <Copy size={12} />
                </button>
              </div>
              <div className="run-waiting-hint">
                Send a <b>{waiting.method}</b> request to that URL to complete this run — polling every 2.5 s. The URL accepts exactly one request per Run: it stops listening as soon as it fires, so press Run again to re-arm it.
              </div>
              {onCancelWait && (
                <button className="btn btn-sm btn-ghost" onClick={onCancelWait}>
                  Cancel wait
                </button>
              )}
            </div>
          )}

          {!loading && awaiting === "input" && waiting && (
            <div className="run-waiting">
              <div className="run-waiting-title">⌸ Waiting for input — {waiting.triggerLabel || waiting.triggerType}</div>
              <div className="run-waiting-msg">{waiting.message}</div>
              <textarea
                className="run-input-area"
                value={inputDraft}
                onChange={(e) => {
                  setInputDraft(e.target.value);
                  setInputError(null);
                }}
                placeholder={`{\n  "message": "hello from the trigger"\n}`}
                spellCheck={false}
              />
              {inputError && <div className="field-json-error">⚠ {inputError}</div>}
              <div className="run-waiting-actions">
                <button className="btn btn-sm btn-primary" onClick={submitInput} disabled={loading}>
                  <Play size={12} /> Run with this input
                </button>
                {onCancelWait && (
                  <button className="btn btn-sm btn-ghost" onClick={onCancelWait}>
                    Cancel wait
                  </button>
                )}
              </div>
              <div className="run-waiting-hint">
                The trigger does not invent test data — paste the event it should react to (JSON). Leave the box empty to run with an empty event. Triggers with a live mode (e.g. GitHub, Telegram, RSS) are completed by their real delivery instead.
              </div>
            </div>
          )}

          {!loading && awaiting === "chat" && waiting && (
            <div className="run-waiting">
              <div className="run-waiting-title">💬 Chat is open</div>
              <div className="run-waiting-msg">{waiting.message}</div>
              <button className="btn btn-sm btn-primary" onClick={() => setTab("chat")}>
                <MessageCircle size={12} /> Open the Chat tab
              </button>
              {onCancelWait && (
                <button className="btn btn-sm btn-ghost" onClick={onCancelWait}>
                  Cancel wait
                </button>
              )}
            </div>
          )}

          {!loading && result && result.consoleLog.length > 0 && (
            <div>
              <div className="run-io-label">Console output</div>
              <pre className="run-console">{result.consoleLog.join("\n")}</pre>
            </div>
          )}

          {!loading && result && (result.errorCount ?? 0) > 0 && (
            <div className="run-error-summary">
              <b>{result.errorCount}</b> error{result.errorCount === 1 ? "" : "s"}
              {(result.handledErrors ?? 0) > 0 && (
                <span className="run-error-handled"> · {result.handledErrors} handled — the run continued</span>
              )}
              {" "}— mouse over a code for details, or open Settings → Error codes.
            </div>
          )}

          {!loading &&
            result &&
            result.log.map((entry) => {
              const isOpen = expanded.has(entry.nodeId);
              return (
                <div key={entry.nodeId} className={`run-entry ${entry.status === "error" ? "err" : ""}`}>
                  <div className="run-entry-head" onClick={() => toggle(entry.nodeId)}>
                    {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className={`dot ${entry.status === "success" ? "ok" : "err"}`} />
                    <span>{entry.nodeName}</span>
                    {entry.status === "error" && entry.errorCode && (
                      <code className="err-code" title={`BF-${entry.errorCode} · ${entry.errorShort || ""}`}>
                        BF-{entry.errorCode}
                      </code>
                    )}
                    {entry.status === "error" && entry.handled && (
                      <span className="err-handled" title="This node's on-error setting was Continue, so the run carried on">
                        continued
                      </span>
                    )}
                    {entry.usage && (entry.usage.total || 0) > 0 && (
                      <span className="run-entry-tokens" title={`${entry.usage.prompt || 0} in / ${entry.usage.completion || 0} out${entry.usage.model ? ` · ${entry.usage.model}` : ""}`}>
                        🧠 {Number(entry.usage.total || (entry.usage.prompt || 0) + (entry.usage.completion || 0)).toLocaleString()}
                      </span>
                    )}
                    {(entry.attempts || 1) > 1 && <span className="run-entry-attempts" title="Attempts (retry on error)">×{entry.attempts}</span>}
                    <span className="dur">{entry.durationMs} ms</span>
                  </div>
                  {isOpen && (
                    <div className="run-entry-body">
                      {entry.status === "error" && (
                        <>
                          <div className="err-msg">
                            ⚠ {entry.error}
                            {entry.errorCode && (
                              <span className="err-code-inline">
                                [BF-{entry.errorCode} · {entry.errorShort}]{" "}
                              </span>
                            )}
                          </div>
                          {entry.errorCode && (
                            <div className="err-hint">
                              Full explanation &amp; fix tips: <b>Settings → Error codes</b> (code BF-{entry.errorCode}) … or see the ERRORS.md file on disk.
                            </div>
                          )}
                        </>
                      )}
                      {entry.filesWritten && entry.filesWritten.length > 0 && (
                        <div className="run-files">
                          <div className="run-io-label">File output ({entry.filesWritten.length})</div>
                          {entry.filesWritten.map((f, i) => (
                            <div key={i} className="run-file">
                              📄 <b>{f.name}</b>
                              {f.path ? ` → ${f.path}` : ""}
                              {f.size != null ? ` (${fmtSize(f.size)})` : ""}
                              {/* only Write File saves to the server's disk (it sets `path`);
                                  the other entries are in-memory files of this run */}
                              {f.path && result?.workflowId && (
                                <>
                                  {" "}
                                  <a
                                    className="run-file-download"
                                    href={`/api/workflows/${encodeURIComponent(result.workflowId)}/files?path=${encodeURIComponent(f.path)}`}
                                    download={f.name}
                                  >
                                    <Download size={11} /> Download
                                  </a>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <div>
                        <div className="run-io-label">
                          Input ({entry.inputItems.length} ITEM{entry.inputItems.length === 1 ? "" : "S"})
                        </div>
                        <pre className="run-pre">{fmt(entry.inputItems)}</pre>
                      </div>
                      <div>
                        <div className="run-io-label">
                          Output ({entry.outputItems.length} ITEM{entry.outputItems.length === 1 ? "" : "S"})
                        </div>
                        <pre className="run-pre">{fmt(entry.outputItems)}</pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
