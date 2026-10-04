import { useEffect, useState } from "react";
import { Copy, Lock, Repeat, Share2, X, Zap } from "lucide-react";
import type { AiBudget, Workflow, WorkflowEnvironment, WorkflowExecutionMode, WorkflowLoop, WorkflowMcpSettings } from "../types";
import { AlertsSection, EnvironmentSection, McpSection } from "./WorkflowSettingsExtras";
import { WorkflowBudgetSection } from "./AiSpending";
import { api } from "../api";
import { navigateWorkspace } from "../routes";
import { proCtaLabel } from "../proStatus";
import { FAST_LOOP_MAX_RUNS, MIN_LOOP_INTERVAL_SECONDS, loopIntervalFloor } from "../../shared/loop.js";

interface Props {
  workflow: Workflow;
  triggers: string[];
  webhookUrl: string | null;
  agentsCount: number;
  /** repeat setting of the workflow (null/undefined = runs once per trigger) */
  loop?: WorkflowLoop | null;
  /** where the workflow executes: in the editor, or in the background (Pro) */
  executionMode: WorkflowExecutionMode;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onLoop: (loop: WorkflowLoop | undefined) => void;
  onExecutionMode: (mode: WorkflowExecutionMode) => void;
  /** Test / Live environment */
  environment: WorkflowEnvironment;
  onEnvironment: (env: WorkflowEnvironment) => void;
  /** AI-tool (MCP) listing */
  mcp?: WorkflowMcpSettings;
  onMcp: (m: WorkflowMcpSettings) => void;
  aiBudget?: AiBudget;
  onAiBudget: (b: AiBudget) => void;
  /** false for collaborators — alerts are the owner's to configure */
  isOwner?: boolean;
  onExport: () => void;
  onImport: (text: string) => void;
  onClose: () => void;
}

// What the repeat toggle starts from before the user tunes it.
const DEFAULT_LOOP: WorkflowLoop = { enabled: true, times: 3, intervalSeconds: 5 };

export default function WorkflowModal(props: Props) {
  const { workflow, triggers, webhookUrl, agentsCount } = props;
  const [importState, setImportState] = useState<string | null>(null);
  // The account's plan gates background execution: the setting is visible to
  // everyone (so the feature is discoverable) but only Pro can switch it on.
  const [plan, setPlan] = useState<"free" | "pro" | null>(null);
  const [loopDraft, setLoopDraft] = useState<WorkflowLoop>(props.loop?.enabled ? props.loop : { ...DEFAULT_LOOP, enabled: false });

  useEffect(() => {
    api.billing
      .status()
      .then((s) => setPlan(s.plan))
      .catch(() => setPlan("free"));
  }, []);

  const loopOn = !!(props.loop?.enabled);
  const background = props.executionMode === "background";
  const proLocked = plan !== "pro";
  // times = 0 means "keep repeating until switched off".
  const continuous = loopDraft.times === 0;
  // Ten or more runs, or a continuous loop, wait at least 10 s (shared/loop.js).
  const intervalFloor = loopIntervalFloor(loopDraft.times);
  const withFloor = (patch: Partial<WorkflowLoop>): Partial<WorkflowLoop> => {
    const times = patch.times ?? loopDraft.times;
    const interval = patch.intervalSeconds ?? loopDraft.intervalSeconds;
    return { ...patch, intervalSeconds: Math.max(loopIntervalFloor(times), interval) };
  };

  const chooseExecutionMode = (mode: WorkflowExecutionMode) => {
    if (mode === "background" && proLocked) return; // locked for free accounts
    props.onExecutionMode(mode);
  };

  // The locked Pro controls are visible on every plan; the upsell button is
  // what actually takes the user to the subscription page.
  const openPro = () => {
    props.onClose();
    navigateWorkspace("subscription");
  };

  const patchLoop = (patch: Partial<WorkflowLoop>) => {
    const next = { ...loopDraft, ...patch, enabled: patch.enabled ?? loopDraft.enabled };
    setLoopDraft(next);
    props.onLoop(next.enabled ? next : undefined);
  };
  // publish-to-community state
  const [shareTitle, setShareTitle] = useState(workflow.name || "");
  const [shareDesc, setShareDesc] = useState(workflow.description || "");
  const [makeAnonymous, setMakeAnonymous] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [shareState, setShareState] = useState<string | null>(null);

  // Respect the profile's "publish anonymously by default" preference, when set.
  useEffect(() => {
    api.profile
      .me()
      .then((p) => setMakeAnonymous(!!p.anonymousByDefault))
      .catch(() => {});
  }, []);

  const copy = () => {
    if (webhookUrl) navigator.clipboard?.writeText(webhookUrl).then(() => setImportState("copied"));
    setTimeout(() => setImportState(null), 1500);
  };

  const publish = async () => {
    const title = shareTitle.trim();
    if (!title) {
      setShareState("notitle");
      return;
    }
    setPublishing(true);
    setShareState(null);
    try {
      await api.community.publish({ workflowId: workflow.id, title, description: shareDesc.trim(), anonymous: makeAnonymous });
      setShareState("ok");
    } catch (err) {
      setShareState("err");
      console.error(err);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
      <div className="modal modal-workflow" role="dialog" aria-modal="true" aria-label="Workflow settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="modal-title">Workflow settings</div>
            <div className="modal-sub">Name, description, webhook and import / export.</div>
          </div>
          <button className="modal-x" onClick={props.onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="node-modal-body">
          <div className="insp-section">
            <div className="field">
              <div className="field-label">Name</div>
              <input value={workflow.name} onChange={(e) => props.onName(e.target.value)} />
            </div>
            <div className="field">
              <div className="field-label">Description</div>
              <textarea value={workflow.description || ""} onChange={(e) => props.onDescription(e.target.value)} />
            </div>
          </div>

          <div className="insp-section">
            <div className="field-section">Execution mode</div>
            <div className="exec-mode-row">
              <button
                className={`exec-mode-option ${!background ? "active" : ""}`}
                onClick={() => chooseExecutionMode("editor")}
                title="Runs when you press Run, or when one of its triggers fires while the server is up"
              >
                <Zap size={13} />
                <span>
                  <b>Editor</b>
                  <small>Runs while you work — on demand and from its triggers.</small>
                </span>
              </button>
              <button
                className={`exec-mode-option ${background ? "active" : ""} ${proLocked ? "locked" : ""}`}
                onClick={() => chooseExecutionMode("background")}
                disabled={proLocked}
                title={
                  proLocked
                    ? "Running a workflow while you are offline is a Pro feature"
                    : "The server keeps this workflow running even when you are signed out"
                }
              >
                <Repeat size={13} />
                <span>
                  <b>
                    Always on {proLocked && <em className="exec-mode-pro"><Lock size={9} /> PRO</em>}
                  </b>
                  <small>Keeps running while you are offline — the server does the work.</small>
                </span>
              </button>
            </div>
            {proLocked && (
              <div className="field-help exec-pro-note">
                <span>
                  “Always on” execution runs this workflow on the server even when you are not signed in. It is part of <b>Pro</b> — the switch
                  stays locked on the free plan.
                </span>
                <button className="btn btn-sm btn-ghost" onClick={openPro} title="Open the Pro page">
                  {proCtaLabel("See Pro")}
                </button>
              </div>
            )}
          </div>

          <div className="insp-section">
            <div className="field-section">
              Repeat (loop){" "}
              {proLocked && (
                <em className="exec-mode-pro">
                  <Lock size={9} /> PRO
                </em>
              )}
            </div>
            {/* The whole loop is Pro: visible on every plan so it can be found,
                switchable only on Pro (a loop that is already on can always be
                switched off). */}
            <label
              className={`exec-loop-toggle ${proLocked && !loopOn ? "locked" : ""}`}
              title={proLocked && !loopOn ? "Repeating a workflow is a Pro feature" : "Run this workflow again after each run"}
            >
              <input type="checkbox" checked={loopOn} disabled={proLocked && !loopOn} onChange={(e) => patchLoop({ enabled: e.target.checked })} />
              <span className="toggle-label">{loopOn ? "ON" : "OFF"}</span>
              <span className="exec-loop-toggle-text">Run this workflow again after each run</span>
            </label>
            {proLocked && !loopOn && (
              <div className="field-help exec-pro-note">
                <span>
                  A loop repeats the whole workflow on the server — it keeps going after you close the page. It is part of <b>Pro</b>.
                </span>
                <button className="btn btn-sm btn-ghost" onClick={openPro} title="Open the Pro page">
                  {proCtaLabel("See Pro")}
                </button>
              </div>
            )}
            {loopOn && (
              <div className="exec-loop-fields">
                <div className="field">
                  <div className="field-label">Number of runs</div>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={continuous ? "" : Math.max(1, loopDraft.times)}
                    disabled={continuous}
                    onChange={(e) => patchLoop(withFloor({ times: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))}
                  />
                  <div className="field-help">How many times this workflow runs in total (including the first run).</div>
                </div>
                <div className="field">
                  <div className="field-label">Wait between runs (seconds)</div>
                  <input
                    type="number"
                    min={intervalFloor}
                    max={86400}
                    value={loopDraft.intervalSeconds}
                    onChange={(e) => setLoopDraft({ ...loopDraft, intervalSeconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                    // Typing "1" on the way to "15" must not snap to 10 — the
                    // minimum is applied when the field is left.
                    onBlur={() => patchLoop(withFloor({ intervalSeconds: loopDraft.intervalSeconds }))}
                  />
                  <div className="field-help">
                    {intervalFloor
                      ? `At least ${MIN_LOOP_INTERVAL_SECONDS} s: loops of ${FAST_LOOP_MAX_RUNS + 1} or more runs (or continuous ones) must wait between runs.`
                      : `Pause after a run finishes. Up to ${FAST_LOOP_MAX_RUNS} runs may follow each other directly.`}
                  </div>
                </div>

                <label className="exec-continuous" title="Repeat until the loop is switched off, instead of a fixed number of runs">
                  <input type="checkbox" checked={continuous} onChange={(e) => patchLoop(withFloor({ times: e.target.checked ? 0 : DEFAULT_LOOP.times }))} />
                  <span className="toggle-label">{continuous ? "ON" : "OFF"}</span>
                  <span className="exec-loop-toggle-text">Keep running until I stop it</span>
                </label>

                <div className="field-help">
                  Press Run once: you see the first run here, the server does the rest — even with this page closed.
                  {background ? " In “Always on” mode the loop also starts by itself." : ""} Switch the loop off to stop it.
                </div>
                {!continuous && loopDraft.times > 1 && !loopDraft.intervalSeconds && (
                  <div className="field-help">No pause between runs — the workflow runs back to back.</div>
                )}
              </div>
            )}
          </div>

          <EnvironmentSection environment={props.environment} onChange={props.onEnvironment} />
          {props.isOwner !== false && <AlertsSection workflowId={workflow.id} />}
          <McpSection mcp={props.mcp} nodes={workflow.nodes} onChange={props.onMcp} />
          <WorkflowBudgetSection budget={props.aiBudget} onChange={props.onAiBudget} />

          <div className="insp-section">
            <div className="field-section">Stats</div>
            <div className="insp-hint-box">
              <b style={{ color: "var(--ink)" }}>{workflow.nodes.length}</b> nodes ·{" "}
              <b style={{ color: "var(--ink)" }}>{workflow.edges?.length || 0}</b> connections
              {triggers.length > 0 && (
                <>
                  <br />
                  Triggers: {triggers.join(", ")}
                </>
              )}
            </div>
          </div>

          {webhookUrl && (
            <div className="insp-section">
              <div className="field-section">Webhook URL</div>
              <div className="insp-hint-box">
                <code style={{ color: "var(--cyan)", wordBreak: "break-all" }}>{webhookUrl}</code>
                <br />
                This URL is <b>inactive until you press Run</b>: a webhook-only workflow then waits for exactly one request to this URL and turns it off again afterwards.
                <br />
                <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={copy}>
                  <Copy size={12} /> {importState === "copied" ? "COPIED ✓" : "COPY"}
                </button>
              </div>
            </div>
          )}

          <div className="insp-section">
            <div className="field-section">Import / export</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-sm" onClick={props.onExport} style={{ flex: 1, justifyContent: "center" }}>
                Export JSON
              </button>
              <label className="btn btn-sm" style={{ flex: 1, justifyContent: "center", cursor: "pointer" }}>
                Import JSON
                <input
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const text = await file.text();
                    try {
                      JSON.parse(text);
                      props.onImport(text);
                      setImportState("ok");
                    } catch {
                      setImportState("err");
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {importState === "err" && <div className="field-help" style={{ color: "var(--red)" }}>✗ Invalid JSON</div>}
            {importState === "ok" && <div className="field-help" style={{ color: "var(--green)" }}>✓ Imported — saved automatically</div>}
          </div>

          {agentsCount > 0 && (
            <div className="insp-section">
              <div className="field-section">Agents</div>
              <div className="insp-hint-box">
                {agentsCount} saved agent{agentsCount === 1 ? "" : "s"} — use the AI Agent node and pick one.
              </div>
            </div>
          )}

          <div className="insp-section">
            <div className="field-section">Share with the community</div>
            <div className="field">
              <div className="field-label">Post title</div>
              <input value={shareTitle} onChange={(e) => setShareTitle(e.target.value)} placeholder="e.g. Webhook → AI Summarizer" />
            </div>
            <div className="field">
              <div className="field-label">Description</div>
              <textarea
                value={shareDesc}
                onChange={(e) => setShareDesc(e.target.value)}
                placeholder="What does this workflow do?"
              />
            </div>
            <label className="toggle" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={makeAnonymous} onChange={(e) => setMakeAnonymous(e.target.checked)} />
              <span className="toggle-track" />
              <span className="toggle-label">Publish anonymously (hide my name and profile link)</span>
            </label>
            <button className="btn btn-sm btn-primary" onClick={publish} disabled={publishing} style={{ width: "100%", justifyContent: "center" }}>
              <Share2 size={12} /> {publishing ? "Publishing…" : "Publish as template"}
            </button>
            {shareState === "ok" && (
              <div className="field-help" style={{ color: "var(--green)" }}>
                ✓ PUBLISHED AS A TEMPLATE — find it under <b>User Templates</b>.
              </div>
            )}
            {shareState === "err" && (
              <div className="field-help" style={{ color: "var(--red)" }}>✗ Publish failed — try again</div>
            )}
            {shareState === "notitle" && (
              <div className="field-help" style={{ color: "var(--red)" }}>✗ Give the post a title first</div>
            )}
            <div className="field-help">
              Anyone on this instance can search for and import your workflow. API keys, passwords and webhook URLs are removed automatically.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
