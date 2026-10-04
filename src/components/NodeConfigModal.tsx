import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, Check, ChevronDown, MessageSquare, ChevronRight, Copy, FileJson, Pin, Plus, Trash2, X } from "lucide-react";
import type { Agent, Catalog, ExecLogEntry, FieldDef, NodeDef } from "../types";
import { errorCatalog } from "../../shared/errors.js";
import { NodeIcon } from "./icons";
import { NodeServiceBadge } from "./ServiceBadge";
import { api } from "../api";
import ParamHelp from "./ParamHelp";
import { PRIVATE_FIELD_NAMES } from "../../shared/privacy.js";
import OAuthAccountField from "./OAuthAccountField";
import { useConnectionProviders } from "../connectionProviders";
import TelegramBotField from "./TelegramBotField";
import TelegramAccountField from "./TelegramAccountField";
import { describeParam, type ParamNode } from "../paramHelp";
import Select from "./Select";

// custom drag type used to drag a JSON field (property) of an upstream file into
// a node's input settings ("Field path" / "Field inside the file" inputs)
export const JSON_FIELD_DRAG_TYPE = "application/x-w-flow-json-field";

/**
 * Start dragging an input field. The path box of "A specific field" reads the
 * custom type; every other text setting receives the text/plain `{{path}}` —
 * the browser drops it right where the pointer is and React's onChange sees
 * the edit, so any text field in NODE SETUP accepts a dragged field.
 */
function startFieldDrag(e: React.DragEvent, path: string) {
  e.dataTransfer.setData(JSON_FIELD_DRAG_TYPE, path);
  e.dataTransfer.setData("text/plain", `{{${path}}}`);
  e.dataTransfer.effectAllowed = "copy";
}

// The upstream data drawn as JSON in which every property can be dragged: its
// key (or value) carries the full path, so dropping it into a setting inserts
// {{result.price}}. Looks like the plain JSON dump it replaces.
const MAX_JSON_LINES = 1500;

/**
 * Safety net for dropping a field onto a text setting. Browsers insert the
 * dragged "{{path}}" themselves, right at the pointer; if one does not (the
 * value is unchanged a moment later), append it and fire the input event
 * React listens to, so the setting updates either way.
 */
function ensureFieldDropped(e: React.DragEvent) {
  const path = e.dataTransfer.getData(JSON_FIELD_DRAG_TYPE);
  const el = e.target as HTMLElement;
  if (!path || e.defaultPrevented) return;
  if (!(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|url|email|)$/.test(el.type)))) return;
  const before = el.value;
  setTimeout(() => {
    if (el.value !== before) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, `${before}{{${path}}}`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, 0);
}

function DraggableJson({ value }: { value: unknown }) {
  let lines = 0;
  const scalar = (v: unknown) => {
    const text = v === undefined ? "undefined" : JSON.stringify(v);
    const kind = v === null ? "null" : typeof v;
    return <span className={`json-${kind}`}>{text}</span>;
  };

  const render = (v: unknown, path: string, indent: number, key: string | null, last: boolean): React.ReactNode => {
    if (++lines > MAX_JSON_LINES) return null;
    const pad = "  ".repeat(indent);
    const comma = last ? "" : ",";
    const label =
      key === null ? null : (
        <span
          className="json-key"
          draggable
          onDragStart={(e) => startFieldDrag(e, path)}
          title={`Drag into a setting to insert {{${path}}}`}
        >
          "{key}"
        </span>
      );
    const isObj = v !== null && typeof v === "object";
    if (!isObj) {
      return (
        <div className="json-line" key={path || "root"}>
          {pad}
          {label}
          {label && ": "}
          {path ? (
            <span className="json-drag-value" draggable onDragStart={(e) => startFieldDrag(e, path)} title={`Drag into a setting to insert {{${path}}}`}>
              {scalar(v)}
            </span>
          ) : (
            scalar(v)
          )}
          {comma}
        </div>
      );
    }
    const isArr = Array.isArray(v);
    const entries: Array<[string, unknown]> = isArr ? (v as unknown[]).map((x, i) => [String(i), x]) : Object.entries(v as object);
    const [open, close] = isArr ? ["[", "]"] : ["{", "}"];
    if (!entries.length) {
      return (
        <div className="json-line" key={path || "root"}>
          {pad}
          {label}
          {label && ": "}
          {open}
          {close}
          {comma}
        </div>
      );
    }
    return (
      <div key={path || "root"}>
        <div className="json-line">
          {pad}
          {label}
          {label && ": "}
          {open}
        </div>
        {entries.map(([k, child], i) => render(child, path ? `${path}.${k}` : k, indent + 1, isArr ? null : k, i === entries.length - 1))}
        <div className="json-line">
          {pad}
          {close}
          {comma}
        </div>
      </div>
    );
  };

  const tree = render(value, "", 0, null, true);
  return (
    <div className="json-drag">
      {tree}
      {lines > MAX_JSON_LINES && <div className="json-line muted">… (shortened — run with fewer items to see the rest)</div>}
    </div>
  );
}

export interface OutputFileInfo {
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
}

export interface UpstreamOutput {
  nodeId: string;
  label: string;
  type: string;
  /** actual output of the node from the last workflow run (null if never run) */
  items: unknown[] | null;
  /** sample payload for trigger nodes (used when there is no run data yet) */
  sample: Record<string, unknown> | null;
  /** files created by this node during the last run */
  files?: OutputFileInfo[];
}

export interface InputOverview {
  sources: string[];
  fields: string[];
  hasUpstream: boolean;
  /** immediate upstream nodes and their captured/sample input data */
  upstream: UpstreamOutput[];
  /** the immediate one-hop upstream nodes this node reads from */
  producers: UpstreamOutput[];
  /** captured output of the node currently being configured */
  output: UpstreamOutput | null;
  /** named files the upstream nodes produce — for "A file produced by an upstream node" */
  upstreamFiles: UpstreamFile[];
}

export interface UpstreamFile {
  name: string;
  nodeId: string;
  nodeLabel: string;
  size?: number;
  /** the name the node's file will get — it has not run yet */
  expected: boolean;
}

interface Props {
  def: NodeDef;
  color: string;
  label: string;
  config: Record<string, unknown>;
  agents: Agent[];
  input: InputOverview;
  onLabel: (v: string) => void;
  onConfig: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
  /** "Run next node" stepping — when a node's manual output is set, this
   *  advances the workflow to the downstream node without executing this one. */
  onRunNext?: () => void;
  nextNodeLabel?: string;
  /** provider registry (OpenAI/Groq/…) used to suggest model / base-URL options */
  providers?: Catalog["providers"];
  /** id of the workflow being edited — used by workflow-picker fields (Execute
   *  Sub-Workflow) to flag the current workflow as an invalid self-call target */
  currentWorkflowId?: string;
  /** live webhook URL of this workflow (only set for Webhook trigger nodes) */
  webhookUrl?: string | null;
  /** current custom webhook URL part (slug) */
  webhookSlug?: string;
  /** user changed the custom webhook URL part */
  onWebhookSlug?: (slug: string) => void;
  /** open this node in the JSON editor */
  onEditJson?: () => void;
  /** the workflow is shared with this account as view / view & run: nothing can be changed */
  readOnly?: boolean;
  /** open the comment thread of this node */
  onComments?: () => void;
  /** comments on this node (open threads) — shown on the Comments button */
  commentCount?: number;
  /** pin this node as a reference for the AI builder chat ("Build with AI") */
  onAddReference?: () => void;
  /** true when this node is already pinned as a reference */
  isReferenced?: boolean;
  /** this node's failure in the last run, if it failed — shown as a banner */
  lastError?: ExecLogEntry | null;
}

// nodes that define their own input handling (or don't consume input)
export function hasGenericInput(def: NodeDef): boolean {
  return (
    def.kind !== "trigger" &&
    !["excelCreate", "wordCreate", "loopEnd"].includes(def.type)
  );
}

// A field is optional (hidden behind the "+" toggle) when it is explicitly
// marked optional, or its label / section says so.
function isOptionalField(f: FieldDef): boolean {
  if (f.optional === true) return true;
  const label = (f.label || "").toLowerCase();
  const section = (f.section || "").toLowerCase();
  return label.includes("(optional)") || section.includes("optional");
}

export default function NodeConfigModal(props: Props) {
  const { def, color } = props;
  const showInput = hasGenericInput(def);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()} onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
      <div
        className="modal modal-node-config"
        role="dialog"
        aria-modal="true"
        aria-label={`${def.name} configuration`}
        onMouseDown={(e) => e.stopPropagation()}
        onDrop={ensureFieldDropped}
      >
        <div className="node-modal-head" style={{ ["--c" as string]: color }}>
          <div className="insp-icon">
            <NodeIcon name={def.icon} size={15} />
          </div>
          <div className="node-modal-title-wrap">
            <div className="node-modal-title">
              {def.name}
              <NodeServiceBadge type={def.type} name={def.name} description={def.description} size={15} />
            </div>
            <div className="insp-sub">
              {def.kind.toUpperCase()} · {def.category.toUpperCase()}
            </div>
          </div>
          {props.onEditJson && (
            <button className="btn btn-sm btn-ghost node-modal-json" onClick={props.onEditJson} title="Edit this node as JSON">
              <Braces size={12} /> JSON
            </button>
          )}
          <button className="modal-x" onClick={props.onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        {props.lastError && <NodeErrorBanner entry={props.lastError} />}

        <div className="node-modal-body">
          {/* A disabled fieldset turns every field inside read-only at once. */}
          <fieldset className="node-modal-fieldset" disabled={!!props.readOnly}>
          <div className="node-modal-columns">
            <div className="node-modal-input">
              <div className="node-modal-column-title">INPUT &amp; INPUT SETTINGS</div>
              {showInput ? (
                <InputSection {...props} />
              ) : (
                <div className="insp-section">
                  <div className="node-modal-side-empty">This trigger starts the workflow and does not consume upstream input.</div>
                </div>
              )}
              {def.type === "webhook" && <WebhookSection {...props} />}
            </div>
            <div className="node-modal-setup">
              <div className="node-modal-column-title">Node setup</div>
              <div className="insp-section">
                <div className="field">
                  <div className="field-label">Node name</div>
                  <input value={props.label} onChange={(e) => props.onLabel(e.target.value)} />
                </div>
              </div>
              <ConfigSections {...props} />
              {(def.type === "aiChat" || def.type === "aiAgent" || def.type === "aiImage" || def.type === "aiExtract") && <AITest config={props.config} />}
            </div>
            <div className="node-modal-output">
              <div className="node-modal-column-title">OUTPUT &amp; OUTPUT SETTINGS</div>
              <OutputSection input={props.input} />
              <ConfigSections {...props} outputOnly />
            </div>
          </div>
          </fieldset>
        </div>

        <div className="node-modal-footer">
          {props.readOnly && <span className="field-help node-modal-readonly">You can view this step, not change it.</span>}
          {props.onComments && (
            <button className="btn btn-sm" onClick={props.onComments} title="Comments on this step">
              <MessageSquare size={12} /> Comments{props.commentCount ? ` (${props.commentCount})` : ""}
            </button>
          )}
          {props.onAddReference && !props.readOnly && (
            <button
              className={`btn btn-sm ${props.isReferenced ? "btn-active" : ""}`}
              onClick={props.onAddReference}
              title={
                props.isReferenced
                  ? "This node is pinned as a reference for the AI helper — press again to open the chat"
                  : "Pin this node as a reference for the AI helper, so “Build with AI” knows exactly which step you mean"
              }
            >
              <Pin size={12} /> {props.isReferenced ? "Referenced in AI helper" : "Use as AI reference"}
            </button>
          )}
          {!props.readOnly && (
            <button className="btn btn-sm btn-danger" onClick={props.onDelete}>
              <Trash2 size={12} /> Delete node
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function OutputSection({ input }: { input: InputOverview }) {
  const output = input.output;
  const items = output?.items;
  const files = output?.files || [];
  const hasData = Array.isArray(items) || !!output?.sample;
  const payload = Array.isArray(items) ? items : output?.sample ? [output.sample] : null;
  const itemLabel = Array.isArray(items) ? `${items.length} item${items.length === 1 ? "" : "s"}` : output?.sample ? "sample payload" : "not run yet";

  return (
    <div className="node-output-panel">
      <div className="node-output-summary">
        <span className={`node-output-status ${hasData ? "ready" : "empty"}`}>
          {hasData ? "● OUTPUT READY" : "○ NO OUTPUT YET"}
        </span>
        <span className="node-output-count">{itemLabel}</span>
      </div>
      {output ? (
        <>
          <div className="node-output-origin">
            <span className="field-label">Produced by node</span>
            <b>{output.label}</b>
            <code>{output.type}</code>
          </div>
          {payload ? (
            <pre className="node-output-json">{JSON.stringify(payload, null, 2)}</pre>
          ) : (
            <div className="node-output-empty">Run the workflow to capture this node's real output.</div>
          )}
          {files.length > 0 && (
            <div className="node-output-files">
              <div className="node-output-files-title">Files created by this node</div>
              {files.map((file, index) => (
                <div className="node-output-file" key={`${file.name}-${index}`}>
                  <div className="node-output-file-name">{file.name}</div>
                  <div className="node-output-file-meta">
                    {file.path && <span>Path: <code>{file.path}</code></span>}
                    {file.mimeType && <span>Type: {file.mimeType}</span>}
                    {typeof file.size === "number" && <span>Size: {file.size} B</span>}
                  </div>
                  <div className="node-output-file-source">Source node: {output.label}</div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="node-output-empty">This node has not produced output yet.</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ webhook url --- */
// Shown inside the Webhook trigger's node editor: the workflow's live webhook
// URL plus an editable custom URL part (slug). Changing the slug immediately
// changes the URL — /webhook/<slug> resolves to this workflow.
function WebhookSection({ webhookUrl, webhookSlug = "", onWebhookSlug }: Props) {
  const [copied, setCopied] = useState(false);
  if (!webhookUrl) return null;
  const copy = () => {
    navigator.clipboard?.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="insp-section webhook-section">
      <div className="field-section">Webhook URL</div>
      <div className="webhook-url-row">
        <code className="webhook-url-code">{webhookUrl}</code>
        <button className="icon-btn" onClick={copy} title="Copy webhook URL">
          <Copy size={12} />
        </button>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <div className="field-label">Custom URL part (optional)</div>
        <div className="webhook-slug-row">
          <span className="webhook-slug-prefix">…/webhook/</span>
          <input
            value={webhookSlug}
            onChange={(e) => onWebhookSlug?.(e.target.value)}
            placeholder={webhookUrl.split("/").pop() || ""}
            spellCheck={false}
          />
        </div>
        <div className="field-help">
          Change the readable part of the URL — e.g. <code>my-scraper</code> makes it{" "}
          <code>/webhook/my-scraper</code>. Letters, digits and dashes only; unique across workflows.
          {copied && <span className="ok-text"> ✓ Copied</span>}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- config sections --- */
function ConfigSections({ def, config, agents, input, onConfig, onRunNext, nextNodeLabel, providers, currentWorkflowId, outputOnly = false }: Props & { outputOnly?: boolean }) {
  const lastItems = input?.output?.items || null;
  const setUp = useConnectionProviders(def.type);
  const allGroups = groupFields(def.fields, config, setUp);
  const groups = allGroups.filter((group) => (outputOnly ? group.name === "Output" : group.name !== "Output"));
  // service nodes' Parameters (shared/services.js) are what the user fills in, so they start open too
  const [open, setOpen] = useState<Set<string>>(() => new Set([groups[0]?.name, "Parameters"].filter((n): n is string => !!n)));
  const [showOptional, setShowOptional] = useState(false);
  const manualOutputOn = !!config.manualOutput;

  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const hasOutputGroup = allGroups.some((g) => g.name === "Output");
  const fallbackOutputEl = outputOnly && !hasOutputGroup && (
    <div className="insp-section">
      <div className="field-section">Output settings</div>
      <ManualOutput onConfig={onConfig} config={config} onRunNext={onRunNext} nextNodeLabel={nextNodeLabel} lastItems={lastItems} />
    </div>
  );

  if (def.fields.length === 0) {
    return outputOnly ? (
      <>
        <div className="insp-section">
          <div className="field-section">Output settings</div>
          <ManualOutput onConfig={onConfig} config={config} onRunNext={onRunNext} nextNodeLabel={nextNodeLabel} lastItems={lastItems} />
        </div>
      </>
    ) : (
      <div className="insp-section">
        <div className="node-modal-side-empty">This node has no additional setup fields.</div>
      </div>
    );
  }

  return (
    <>
      <div className="insp-section">
      {groups.map((group) => {
        const isOutputSection = group.name === "Output";
        // While manual output is on, the only output parameter that matters is
        // the fixed JSON — hide the rest of the Output section fields.
        const shownFields = isOutputSection && manualOutputOn ? [] : group.fields;
        const required = shownFields.filter((f) => !isOptionalField(f));
        const optional = shownFields.filter(isOptionalField);
        const isOpen = open.has(group.name) || groups.length === 1;
        return (
          <div key={group.name || "__"}>
            {(required.length > 0 || optional.length === 0 || isOutputSection) && (
              (required.length > 0 || isOutputSection) && (
                <div className="cfg-group">
                  <button className="cfg-group-head" onClick={() => toggle(group.name)} type="button">
                    {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>{group.name || "Configuration"}</span>
                    {!isOutputSection && <span className="cfg-count">{required.length}</span>}
                  </button>
                  {isOpen && (
                    <div className="cfg-group-body">
                      {isOutputSection && (
                        <ManualOutput onConfig={onConfig} config={config} onRunNext={onRunNext} nextNodeLabel={nextNodeLabel} lastItems={lastItems} />
                      )}
                      {required.map((f) => (
                        <Field
                          key={f.key}
                          field={f}
                          value={config[f.key]}
                          config={config}
                          agents={agents}
                          providers={providers}
                          currentWorkflowId={currentWorkflowId}
                          nodeType={def.type}
                          node={def}
                          onChange={(v) => onConfig({ [f.key]: v })}
                          onPatch={onConfig}
                          upstreamFiles={input.upstreamFiles}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            )}

            {optional.length > 0 && (
              <div className="cfg-group cfg-optional">
                <button className="cfg-group-head" onClick={() => setShowOptional((s) => !s)} type="button">
                  {showOptional ? <ChevronDown size={13} /> : <Plus size={13} />}
                  <span>{showOptional ? "Hide optional parameters" : "Add optional parameters"}</span>
                  <span className="cfg-count">{optional.length}</span>
                </button>
                {showOptional && (
                  <div className="cfg-group-body">
                    {optional.map((f) => (
                      <Field
                        key={f.key}
                        field={f}
                        value={config[f.key]}
                        config={config}
                        agents={agents}
                        providers={providers}
                        currentWorkflowId={currentWorkflowId}
                        nodeType={def.type}
                        node={def}
                        onChange={(v) => onConfig({ [f.key]: v })}
                        onPatch={onConfig}
                        upstreamFiles={input.upstreamFiles}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>
      {fallbackOutputEl}
    </>
  );
}

/* --------------------------------------------------------- manual output --- */
// When enabled, the workflow uses the JSON below as this node's output and
// skips executing the node — handy for testing with fixed data. It lives in the
// node's Output section (or a dedicated OUTPUT section for nodes without one),
// with a "Run next node" button to step the workflow forward using this fixed
// data (skipping this node).
function ManualOutput({
  config,
  onConfig,
  onRunNext,
  nextNodeLabel,
  lastItems,
}: {
  config: Record<string, unknown>;
  onConfig: (patch: Record<string, unknown>) => void;
  onRunNext?: () => void;
  nextNodeLabel?: string;
  /** this node's output from the last run — "Pin" copies it into the manual output */
  lastItems?: unknown[] | null;
}) {
  const enabled = !!config.manualOutput;
  const value = String(config.manualOutputJson ?? "");
  // Every keystroke is stored, valid or not: the textarea is controlled by the
  // config, so dropping the half-typed text (e.g. a lone "{") would snap the box
  // back to empty and make it impossible to type JSON at all. The error is
  // derived from the stored text so it is also right after reopening the node.
  const jsonError = useMemo(() => {
    if (value.trim() === "") return null;
    try {
      JSON.parse(value);
      return null;
    } catch {
      return "INVALID JSON — the workflow run will fail until this is fixed";
    }
  }, [value]);

  const onJson = (v: string) => onConfig({ manualOutputJson: v });

  // Pin: freeze the last real output so later nodes can be built and re-run
  // without calling the service (or spending money) again.
  const canPin = Array.isArray(lastItems) && lastItems.length > 0;
  const pin = () => {
    if (!canPin) return;
    onConfig({ manualOutput: true, manualOutputJson: JSON.stringify(lastItems.length === 1 ? lastItems[0] : lastItems, null, 2) });
  };

  return (
    <div className="manual-output">
      {canPin && (
        <button
          type="button"
          className="btn btn-sm btn-ghost pin-output-btn"
          onClick={pin}
          title="Use this node's output from the last run as fixed data — the node is skipped until you turn Manual output off"
        >
          📌 {enabled ? "Re-pin the last run's output" : "Pin the last run's output"}
        </button>
      )}
      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => onConfig({ manualOutput: e.target.checked })} />
        <span className="toggle-track" />
        <span className="toggle-label">
          Manual output
          <small>
            {enabled ? "ON — use fixed data below instead of running the node" : "OFF — run the node as configured"}
          </small>
        </span>
      </label>
      {enabled && (
        <div className="manual-output-json">
          <div className="field-label">Output data (JSON)</div>
          <textarea
            value={value}
            placeholder={'{"message": "hello"}'}
            onChange={(e) => onJson(e.target.value)}
            spellCheck={false}
            style={{ minHeight: 120 }}
          />
          {jsonError && <div className="field-json-error">⚠ {jsonError}</div>}
          <div className="field-help">
            A JSON object becomes one output item; a JSON array becomes one item per element.
          </div>
          {onRunNext && (
            <button
              type="button"
              className="btn btn-sm btn-primary run-next-btn"
              onClick={onRunNext}
              disabled={!value.trim() || jsonError !== null}
              title={
                "Run the next node using this manual output, skipping this node. " +
                (nextNodeLabel ? `Next: ${nextNodeLabel}` : "") +
                "."
              }
            >
              ▶ Run next node {nextNodeLabel ? `→ ${nextNodeLabel}` : ""}
            </button>
          )}
          {onRunNext && (
            <div className="field-help">
              Because manual output is on, running restarts from the next node with this data (this node is skipped).
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- input overview --- */
// flatten a value into dotted field paths (shallowly) for the click-to-use chips
function listFields(obj: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 2) return out;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === "object" && obj[0] !== null) {
      for (const k of Object.keys(obj[0])) out.push(prefix ? `${prefix}.${k}` : k);
    }
    return out;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "filesWritten") continue; // run-log display annotation, not real data
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      listFields(v, path, depth + 1, out);
    }
  }
  return out;
}

// resolve a dotted path against a producer's captured/sample data
function resolvePath(obj: unknown, path: string): unknown {
  return String(path || "")
    .split(".")
    .reduce<any>((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function InputSection({ config, input, onConfig }: Props) {
  const mode = (config.inputMode as string) || "auto";
  const fromNode = (config.inputFromNode as string) || "";
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // producers in scope for field selection: the chosen node, or all when none chosen
  const scope = input.producers.length
    ? fromNode
      ? input.producers.filter((p) => p.nodeId === fromNode)
      : input.producers
    : [];
  const chosen = input.producers.find((p) => p.nodeId === fromNode) || null;

  // live preview of the field the node will use (when mode is field)
  let preview: { available: boolean; ok: boolean; value: string } | null = null;
  if (mode === "field" && (config.inputField as string)) {
    const probe = dataPayloadOf(chosen ?? scope[0] ?? null);
    if (probe !== undefined) {
      const val = resolvePath(probe, config.inputField as string);
      const ok = val !== undefined && val !== null && val !== "";
      preview = { available: true, ok, value: ok ? (typeof val === "object" ? JSON.stringify(val) : String(val)) : "" };
    } else {
      preview = { available: false, ok: false, value: "Run the workflow to preview this field." };
    }
  }

  const useFieldFrom = (producer: UpstreamOutput, field: string) =>
    mode === "file"
      ? onConfig({ inputMode: "file", inputFromNode: producer.nodeId, inputFileField: field })
      : onConfig({ inputMode: "field", inputFromNode: producer.nodeId, inputField: field });

  return (
    <div className="insp-section">
      <div className="field-section">INPUT</div>

      {input.producers.length > 0 ? (
        <div className="field">
          <div className="field-label">From which node</div>
          <Select value={fromNode} onChange={(e) => onConfig({ inputFromNode: e.target.value })}>
            <option value="">All upstream nodes together</option>
            {input.producers.map((p) => (
              <option key={p.nodeId} value={p.nodeId}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="field-help" style={{ marginTop: 0 }}>
          Not connected yet — add a trigger or another node upstream to feed this node.
        </div>
      )}

      <div className="field">
        <div className="field-label">What does this node use as input?</div>
        <Select value={mode} onChange={(e) => onConfig({ inputMode: e.target.value })}>
          <option value="auto">Everything — the whole payload</option>
          <option value="field">A specific field from the data</option>
          <option value="file">A real file produced by an upstream node</option>
          <option value="json">Parse the input as JSON first</option>
          <option value="csv">Parse the input as a CSV table first</option>
          <option value="text">Raw text</option>
        </Select>
      </div>

      {fromNode && chosen && (
        <div className="input-scope-note">
          Input is restricted to <b>{chosen.label}</b> only.
        </div>
      )}

      {mode === "field" && (
        <div className="field">
          <div className="field-label">Field path</div>
          <input
            value={(config.inputField as string) || ""}
            placeholder="e.g. body.message or reply"
            onChange={(e) => onConfig({ inputField: e.target.value })}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types || []).includes(JSON_FIELD_DRAG_TYPE)) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const field = e.dataTransfer.getData(JSON_FIELD_DRAG_TYPE);
              if (field) onConfig({ inputField: field });
            }}
          />
          <div className="field-help drop-target-hint">Drag a JSON property chip below into this box to fill the path.</div>
        </div>
      )}

      {mode === "file" && (
        <FileInputSection {...{ config, onConfig, producers: input.producers, chosen, fromNode }} />
      )}

      {(mode === "field" || mode === "file") && scope.length > 0 && (
        <div className="field">
          <div className="field-label">{mode === "file" ? "Fields inside the file (drag into the box above)" : "Pick a field to use"}</div>
          <div className="input-producers">
            {scope.map((producer) => {
              const data = producer.items ? producer.items[0] : producer.sample ?? null;
              const fields = data ? listFields(data) : [];
              const hasRun = !!producer.items;
              return (
                <div key={producer.nodeId} className="input-producer">
                  <div className="input-producer-head">
                    <span className="name">{producer.label}</span>
                    {!hasRun && <span className="tag">Sample</span>}
                  </div>
                  {fields.length > 0 ? (
                    <div className="input-chips">
                      {fields.map((f) => (
                        <button
                          key={f}
                          draggable
                          onDragStart={(e) => startFieldDrag(e, f)}
                          className={`input-chip ${fromNode === producer.nodeId && (mode === "file" ? config.inputFileField === f : config.inputField === f) ? "active" : ""}`}
                          onClick={() => useFieldFrom(producer, f)}
                          title="Drag into the field box above, or click to use it"
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="input-field-empty">Run the workflow to see this node's fields.</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {preview && (
        <div className={`field-preview ${preview.ok ? "ok" : ""}`}>
          <span className="label">Preview</span>
          {preview.available ? (
            preview.ok ? (
              <code>{preview.value.slice(0, 160)}{preview.value.length > 160 ? "…" : ""}</code>
            ) : (
              <span className="muted">No value at this path — check the field name.</span>
            )
          ) : (
            <span className="muted">{preview.value}</span>
          )}
        </div>
      )}

      {mode === "json" && (
        <div className="field-help">Incoming text is parsed to JSON before reaching the node.</div>
      )}
      {mode === "csv" && (
        <div className="field-help">Incoming text becomes rows: each has <code>row</code>, <code>index</code> and <code>record</code>.</div>
      )}
      {mode === "text" && (
        <div className="field-help">The whole payload is flattened into a single <code>text</code> field.</div>
      )}

      {input.upstream.length > 0 && (
        <div className="in-upstream">
          <div className="in-upstream-label">
            <span>Upstream output</span>
            <span className="dim">{input.sources.join(" → ")}</span>
          </div>
          <div className="field-help drop-target-hint">Open a node below and drag any field onto a text setting in NODE SETUP — it becomes {"{{field}}"}.</div>
          {input.upstream.map((u) => {
            const isOpen = expanded.has(u.nodeId);
            const data = u.items ? (u.sample ? [u.items[0], u.sample] : u.items) : u.sample ? [u.sample] : null;
            const tag = u.items
              ? `${u.items.length} ITEM${u.items.length === 1 ? "" : "S"}`
              : u.sample
                ? "SAMPLE"
                : "Run to capture";
            return (
              <div key={u.nodeId} className={`in-upstream-entry ${isOpen ? "open" : ""}`}>
                <button className="in-upstream-head" onClick={() => toggle(u.nodeId)}>
                  <span className="chev">{isOpen ? "▾" : "▸"}</span>
                  <span className="name">{u.label}</span>
                  <span className="tag">{tag}</span>
                </button>
                {isOpen && (
                  <div className="in-upstream-body">
                    {data ? (
                      // Each item is its own tree so paths start at the item
                      // ({{result.price}}), not at the list around them.
                      data.map((item, i) => (
                        <div key={i} className="json-item">
                          {data.length > 1 && <div className="json-item-label">{u.items && i < u.items.length ? `item ${i + 1}` : "sample"}</div>}
                          <DraggableJson value={item} />
                        </div>
                      ))
                    ) : (
                      "Run the workflow to capture this node's real output."
                    )}
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

// first representable payload object for a producer (captured run output first)
function dataPayloadOf(p: UpstreamOutput | null | undefined): unknown {
  if (!p) return undefined;
  if (p.items && p.items.length) return p.items[0];
  if (p.sample) return p.sample;
  return undefined;
}

/* ------------------------------------------------------ file input mode --- */
// "A real file produced by an upstream node": every node's output is registered
// as a named file during a run (see executor registerOutputFiles). Here the user
// picks which file to consume, and optionally one JSON field out of it — the
// field can be dragged from the chips into the box below.
function FileInputSection({
  config,
  onConfig,
  producers,
}: {
  config: Record<string, unknown>;
  onConfig: (patch: Record<string, unknown>) => void;
  producers: UpstreamOutput[];
  chosen: UpstreamOutput | null;
  fromNode: string;
}) {
  // every file produced by any immediate upstream node during the last run
  const files = producers.flatMap((p) =>
    (p.files || []).map((f) => ({ ...f, nodeId: p.nodeId, nodeLabel: p.label }))
  );
  const picked = String(config.inputFile || "");
  const field = String(config.inputFileField || "");
  return (
    <>
      <div className="field">
        <div className="field-label">Which file?</div>
        {files.length > 0 ? (
          <Select
            value={picked}
            onChange={(e) => onConfig({ inputFile: e.target.value })}
          >
            <option value="">— choose a file from the last run —</option>
            {files.map((f) => (
              <option key={f.nodeId + f.name} value={f.name}>
                {f.nodeLabel} / {f.name}
              </option>
            ))}
          </Select>
        ) : (
          <div className="field-help" style={{ marginTop: 0 }}>
            No files captured yet — run the workflow once so the upstream nodes register their output files.
          </div>
        )}
        <div className="field-help">
          Every node registers its output as a uniquely named file. Pick one to feed this node the whole file.
        </div>
      </div>
      <div className="field">
        <div className="field-label">Field inside the file (optional)</div>
        <input
          value={field}
          placeholder="e.g. body.message"
          onChange={(e) => onConfig({ inputFileField: e.target.value })}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types || []).includes(JSON_FIELD_DRAG_TYPE)) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.getData(JSON_FIELD_DRAG_TYPE);
            if (f) onConfig({ inputFileField: f });
          }}
        />
        <div className="field-help drop-target-hint">
          <FileJson size={11} /> Leave empty to use the whole file; or drag a JSON property chip (below) into this box to use just that field.
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------- error banner --- */
// The last run failed on this node: what went wrong and how to fix it, at the
// top of its settings — the same tips the Error codes reference lists.
function NodeErrorBanner({ entry }: { entry: ExecLogEntry }) {
  const tips = useMemo(() => errorCatalog().find((e) => e.code === entry.errorCode)?.tips || [], [entry.errorCode]);
  return (
    <div className="node-error-banner" role="alert">
      <div className="node-error-title">
        {entry.handled ? "This node failed in the last run (the run continued)" : "The last run stopped here"}
        {entry.errorCode ? <code>BF-{entry.errorCode}</code> : null}
        {entry.errorShort ? <span>{entry.errorShort}</span> : null}
      </div>
      {entry.error && <div className="node-error-msg">{entry.error}</div>}
      {tips.length > 0 && (
        <ul className="node-error-tips">
          {tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------- upstream file pick --- */
// custom drag type for a file chip — dropping it on the name box fills it in
const UPSTREAM_FILE_DRAG_TYPE = "application/x-w-flow-upstream-file";

// "A file produced by an upstream node": the names of the files the nodes
// before this one write, as a dropdown and as chips you can click or drag into
// the box. The box stays editable for templated names like report-{{id}}.pdf.
function UpstreamFilePicker({
  value,
  files,
  placeholder,
  onChange,
}: {
  value: string;
  files: UpstreamFile[];
  placeholder?: string;
  onChange: (v: unknown) => void;
}) {
  const known = files.some((f) => f.name === value);
  const anyExpected = files.some((f) => f.expected);
  return (
    <div className="upstream-file-picker">
      {files.length > 0 && (
        <Select value={known ? value : ""} onChange={(e) => e.target.value && onChange(e.target.value)}>
          <option value="">{value && !known ? "— custom name (below) —" : "— choose a file —"}</option>
          {files.map((f) => (
            <option key={f.nodeId + f.name} value={f.name}>
              {f.nodeLabel} → {f.name}
              {f.expected ? " (expected)" : f.size != null ? ` (${formatBytes(f.size)})` : ""}
            </option>
          ))}
        </Select>
      )}
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types || []).includes(UPSTREAM_FILE_DRAG_TYPE)) e.preventDefault();
        }}
        onDrop={(e) => {
          const name = e.dataTransfer.getData(UPSTREAM_FILE_DRAG_TYPE);
          if (!name) return;
          e.preventDefault();
          onChange(name);
        }}
      />
      {files.length > 0 ? (
        <div className="input-chips upstream-file-chips">
          {files.map((f) => (
            <button
              key={f.nodeId + f.name}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(UPSTREAM_FILE_DRAG_TYPE, f.name);
                e.dataTransfer.setData("text/plain", f.name);
                e.dataTransfer.effectAllowed = "copy";
              }}
              className={`input-chip ${value === f.name ? "active" : ""} ${f.expected ? "expected" : ""}`}
              onClick={() => onChange(f.name)}
              title={`From ${f.nodeLabel} — click to use it, or drag it into the box`}
            >
              <FileJson size={11} /> {f.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="field-help">Connect a node before this one — its output becomes a file you can pick here.</div>
      )}
      {anyExpected && (
        <div className="field-help">
          “Expected” names are what a node's file will be called once it runs. Run the workflow once to see the exact names.
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ----------------------------------------------------------------- field --- */
function Field({
  field,
  value,
  config,
  agents,
  onChange,
  providers,
  currentWorkflowId,
  nodeType,
  node,
  onPatch,
  upstreamFiles = [],
}: {
  field: FieldDef;
  value: unknown;
  config: Record<string, unknown>;
  agents: Agent[];
  onChange: (v: unknown) => void;
  /** set several config keys at once (a picker filling a sibling field) */
  onPatch?: (patch: Record<string, unknown>) => void;
  providers?: Catalog["providers"];
  currentWorkflowId?: string;
  nodeType?: string;
  /** the node this field belongs to — its service drives the "?" help */
  node?: ParamNode;
  /** files the upstream nodes produce ("upstreamFile" fields list them) */
  upstreamFiles?: UpstreamFile[];
}) {
  const [showSecret, setShowSecret] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Execute Sub-Workflow nodes pick from the account's own saved workflows.
  // The list is fetched here (like agents) so any workflow can call any other.
  const isWorkflowPick = field.type === "workflowSelect";
  const [workflowOptions, setWorkflowOptions] = useState<Array<{ id: string; name?: string }> | null>(null);
  useEffect(() => {
    if (!isWorkflowPick) return;
    let live = true;
    api.workflows
      .list()
      .then((wfs) => live && setWorkflowOptions(wfs.map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => live && setWorkflowOptions([]));
    return () => {
      live = false;
    };
  }, [isWorkflowPick]);

  const opts = (field.options || []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const str = (value ?? "") as string;
  const num = (value ?? 0) as number;

  const onJson = (v: string) => {
    if (v.trim() === "") {
      setJsonError(null);
      onChange(v);
      return;
    }
    try {
      JSON.parse(v);
      setJsonError(null);
      onChange(v);
    } catch {
      setJsonError("INVALID JSON");
    }
  };

  // --- provider-aware choices (model / base URL) -----------------------------
  // For AI nodes the Model and Base URL fields get a dropdown of the currently
  // selected provider's offers. The model list is fetched live from the
  // provider's own /models endpoint using the API key the user pasted (falling
  // back to the static catalog list when the provider is unreachable). A
  // "Custom…" option reveals a free-text input so any value can still be
  // entered.
  const isProviderChoice = field.key === "model";
  const isProviderBaseUrl = field.key === "baseUrl";
  const providerValue = (config.provider as string) || "";
  const providerDef = isProviderChoice || isProviderBaseUrl ? (providers || []).find((p) => p.value === providerValue) : undefined;
  const apiKeyValue = String(config.apiKey || "");

  // Live model list — ask the provider which models it exposes with the
  // entered key (debounced so typing the key doesn't spam the API).
  const [liveModels, setLiveModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  useEffect(() => {
    if (!isProviderChoice || !providerValue) return;
    const key = apiKeyValue.trim();
    if (!key) {
      setLiveModels(null);
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    const t = setTimeout(() => {
      api.ai
        .models({ provider: providerValue, baseUrl: config.baseUrl, apiKey: key })
        .then((res) => setLiveModels(res.ok && res.models.length ? res.models : null))
        .catch(() => setLiveModels(null))
        .finally(() => setModelsLoading(false));
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProviderChoice, providerValue, apiKeyValue, config.baseUrl]);

  // Auto-fill the base URL with the selected provider's default whenever the
  // provider changes and no custom base URL has been entered yet.
  const prevProvider = useRef(providerValue);
  useEffect(() => {
    if (isProviderBaseUrl && prevProvider.current !== providerValue && providerDef?.defaultBaseUrl && !str) {
      onChange(providerDef.defaultBaseUrl);
    }
    prevProvider.current = providerValue;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProviderBaseUrl, providerValue]);

  const suggestions: string[] = isProviderChoice
    ? (liveModels ?? providerDef?.models) || []
    : isProviderBaseUrl
    ? [providerDef?.defaultBaseUrl || "https://api.example.com/v1"].filter(Boolean)
    : [];
  const inSuggestions = suggestions.includes(str);
  const showCustomInput = !inSuggestions && str !== "";
  const [customFocus, setCustomFocus] = useState<boolean>(false);

  // The inline "?" says where the value comes from and how to fill it; fields
  // with nothing to add beyond their label get none (see paramHelp.ts).
  const paramHelp = describeParam(field, node);

  return (
    <div className="field">
      <div className="field-label">
        {field.label}
        {(field.type === "secret" || field.key === "apiKey" || field.key === "appPassword" || field.key === "token") && (
          <span className="req">🔒</span>
        )}
        {PRIVATE_FIELD_NAMES.has(field.key) && (
          <span
            className="private-badge"
            title="Private: a typed-in value here is removed when you publish this workflow to User Templates or export it — only {{placeholders}} are kept."
          >
            PRIVATE
          </span>
        )}
        {paramHelp && (
          <ParamHelp text={paramHelp.text} where={paramHelp.where} link={paramHelp.link} example={paramHelp.example} label={field.label} />
        )}
      </div>

      {(isProviderChoice || isProviderBaseUrl) && (
        <div className="provider-picker">
          <Select
            value={str && inSuggestions ? str : "__custom__"}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom__") {
                setCustomFocus(true);
                if (!str) return;
              } else {
                onChange(v);
              }
            }}
          >
            {suggestions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value="__custom__">Custom…</option>
          </Select>
          {(!inSuggestions || customFocus) && (
            <input
              autoFocus={customFocus}
              value={str}
              placeholder={field.placeholder || "https://… or model name"}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
          {isProviderChoice && modelsLoading && (
            <div className="field-help" style={{ color: "var(--cyan)" }}>
              ⏳ Loading models from {providerDef?.label || "provider"}…
            </div>
          )}
          {isProviderChoice && !modelsLoading && suggestions.length === 0 && !str && apiKeyValue.trim() && (
            <div className="field-help">
              No model list returned by the provider — type the model name manually below.
            </div>
          )}
          {suggestions.length === 0 && !str && (
            <div className="field-help">
              {field.key === "model"
                ? apiKeyValue.trim()
                  ? "Enter a model name or pick one from the provider."
                  : "Paste the API key above to load the available models."
                : "Choose a provider above to see suggested base URLs."}
            </div>
          )}
        </div>
      )}

      {field.type === "text" && !isProviderChoice && !isProviderBaseUrl && (
        <input
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onDrop={
            field.fieldPath
              ? (e) => {
                  // This box takes a field NAME: a dragged field fills in its
                  // bare path, never a {{template}} appended to what was there.
                  const path = e.dataTransfer.getData(JSON_FIELD_DRAG_TYPE);
                  if (!path) return;
                  e.preventDefault();
                  onChange(path);
                }
              : undefined
          }
        />
      )}

      {field.type === "upstreamFile" && <UpstreamFilePicker value={str} files={upstreamFiles} placeholder={field.placeholder} onChange={onChange} />}

      {field.type === "textarea" && (
        <textarea value={str} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}

      {field.type === "number" && (
        <input type="number" value={Number.isFinite(num) ? num : 0} onChange={(e) => onChange(Number(e.target.value))} />
      )}

      {field.type === "select" && (
        <Select value={str} onChange={(e) => onChange(e.target.value)}>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}

      {field.type === "boolean" && (
        <label className="toggle">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span className="toggle-track" />
          <span className="toggle-label">{value ? "ON" : "OFF"}</span>
        </label>
      )}

      {field.type === "secret" && (
        <>
          <div className="secret-row">
            {/* Deliberately NOT type="password": Chrome treats password fields as
                credentials and keeps offering to save them in the browser's
                password manager. A masked text field (-webkit-text-security: disc,
                supported in Chrome/Edge/Safari/Firefox 121+) shows dots without
                triggering the browser's save-password prompt. The key is stored
                server-side in the encrypted workflow_secrets table instead. */}
            <input
              type="text"
              className={showSecret ? "" : "secret-mask"}
              value={str}
              placeholder={field.placeholder || "••••••••"}
              onChange={(e) => onChange(e.target.value)}
              autoComplete="off"
              data-lpignore="true"
              spellCheck={false}
            />
            <button className="secret-toggle" onClick={() => setShowSecret((s) => !s)}>
              {showSecret ? "HIDE" : "SHOW"}
            </button>
          </div>
          {(field.key === "apiKey" || field.key === "appPassword" || field.key === "token") && (
            <div className="field-help">
              Stored encrypted in the server database, tied to this workflow. Never exported with it and never
              shared when the workflow is published — anyone who imports it enters their own credential.
            </div>
          )}
        </>
      )}

      {field.type === "json" && (
        <>
          <textarea value={str} placeholder={field.placeholder || "{}"} onChange={(e) => onJson(e.target.value)} spellCheck={false} />
          {jsonError && <div className="field-json-error">⚠ {jsonError}</div>}
        </>
      )}

      {field.type === "code" && <textarea value={str} onChange={(e) => onChange(e.target.value)} spellCheck={false} style={{ minHeight: 180 }} />}

      {field.type === "keyvalue" && (
        <KeyValueRows
          value={(value as Array<{ key: string; value: string }>) || []}
          onChange={onChange}
          placeholderField={field.placeholderField}
          placeholderValue={field.placeholderValue}
        />
      )}

      {field.type === "note" && <div className="insp-hint-box">{field.help}</div>}

      {field.type === "oauth" && field.provider && nodeType && (
        <OAuthAccountField
          nodeType={nodeType}
          provider={field.provider}
          label={field.providerLabel || field.provider}
          scopes={field.scopes || []}
          value={str}
          onChange={onChange}
        />
      )}

      {field.type === "telegramBot" && (
        <TelegramBotField value={str} onChange={onChange} onPatch={onPatch} hasChat={"chatId" in config} />
      )}

      {field.type === "telegramAccount" && (
        <TelegramAccountField value={str} onChange={onChange} onPatch={onPatch} hasChat={"chatId" in config} />
      )}

      {field.type === "agentSelect" && (
        <Select value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">— select an agent —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      )}

      {field.type === "workflowSelect" && (
        <>
          <Select value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">— select one of your workflows —</option>
            {(workflowOptions || []).map((w) => {
              const isSelf = currentWorkflowId && w.id === currentWorkflowId;
              return (
                <option key={w.id} value={w.id} disabled={!!isSelf}>
                  {w.name || w.id}
                  {isSelf ? "  (this workflow — a workflow can't call itself)" : ""}
                </option>
              );
            })}
          </Select>
          {workflowOptions === null && <div className="field-help">⏳ Loading your workflows…</div>}
          {workflowOptions !== null && workflowOptions.length === 0 && (
            <div className="field-help">You have no saved workflows yet — create one on the Workflows page first.</div>
          )}
          {str && currentWorkflowId && str === currentWorkflowId && (
            <div className="field-help" style={{ color: "var(--red)" }}>
              This node points at the workflow you're editing — a workflow can't call itself. Pick another one.
            </div>
          )}
        </>
      )}

      {/* "note" fields ARE the explanation, so they stay inline. For every
          other parameter the help moved into the "?" tooltip next to the
          label, which keeps the inspector free of permanent helper text. */}
      {field.type === "note" && field.help && <div className="field-help">{field.help}</div>}
    </div>
  );
}

// A connected-account service the operator has not set up (or whose status is
// still loading) loses its account picker and "Send as"; the token field it
// demoted to "advanced" gets its own label and weight back.
function withoutUnsetServices(fields: FieldDef[], setUp: Record<string, boolean> | null): FieldDef[] {
  const ready = (provider: string) => !!setUp?.[provider];
  const out: FieldDef[] = [];
  for (const f of fields) {
    if (f.type === "oauth" && f.provider && !ready(f.provider)) continue;
    if (f.oauthOnly && !ready(f.oauthOnly)) continue;
    if (f.oauthFallback && !ready(f.oauthFallback.provider)) {
      const { label, optional, help } = f.oauthFallback;
      out.push({ ...f, label, optional, help });
      continue;
    }
    out.push(f);
  }
  return out;
}

function groupFields(allFields: FieldDef[], config: Record<string, unknown>, setUp: Record<string, boolean> | null) {
  const fields = withoutUnsetServices(allFields, setUp);
  const groups: Array<{ name: string; fields: FieldDef[] }> = [];
  for (const f of fields) {
    if (f.visibleWhen) {
      const { key, value, in: anyOf, not } = f.visibleWhen;
      const matches = anyOf ? anyOf.includes(config[key]) : config[key] === value;
      if (not ? matches : !matches) continue;
    }
    const name = f.section || "";
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, fields: [] };
      groups.push(g);
    }
    g.fields.push(f);
  }
  return groups;
}

function KeyValueRows({
  value,
  onChange,
  placeholderField = "field",
  placeholderValue = "value",
}: {
  value: Array<{ key: string; value: string }>;
  onChange: (v: unknown) => void;
  placeholderField?: string;
  placeholderValue?: string;
}) {
  const rows = value.length ? value : [{ key: "", value: "" }];
  const set = (i: number, patch: Partial<{ key: string; value: string }>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  };
  return (
    <div className="kv-rows">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input placeholder={placeholderField} value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input placeholder={placeholderValue} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button className="kv-del" onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
            <X size={12} />
          </button>
        </div>
      ))}
      <button className="btn btn-sm kv-add" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <Plus size={12} /> Add field
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- ai testing --- */
function AITest({ config }: { config: Record<string, unknown> }) {
  const [state, setState] = useState<"idle" | "testing" | "ok" | "err">("idle");
  const [msg, setMsg] = useState("");

  const test = async () => {
    setState("testing");
    setMsg("");
    try {
      const res = await api.ai.test(config as Record<string, unknown>);
      if (res.ok) {
        setState("ok");
        setMsg(res.reply || "Connected");
      } else {
        setState("err");
        setMsg(res.error || "Connection failed");
      }
    } catch (err) {
      setState("err");
      setMsg(String((err as Error).message || err));
    }
  };

  return (
    <div className="insp-section">
      <button className="btn btn-sm" onClick={test} disabled={state === "testing"} style={{ width: "100%", justifyContent: "center" }}>
        {state === "testing" ? "Testing…" : state === "ok" ? <Check size={12} /> : "Test connection"}
      </button>
      {state === "ok" && (
        <div className="field-help" style={{ color: "var(--green)" }}>
          ✓ {msg}
        </div>
      )}
      {state === "err" && (
        <div className="field-help" style={{ color: "var(--red)" }}>
          ✗ {msg}
        </div>
      )}
    </div>
  );
}