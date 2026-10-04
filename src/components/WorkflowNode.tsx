import { Handle, Position, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { MessageSquare, Pencil, StickyNote, Trash2 } from "lucide-react";
import type { NodeDef } from "../types";
import { NodeIcon } from "./icons";
import { NodeServiceBadge } from "./ServiceBadge";
import { STICKY_DEFAULT_HEIGHT, STICKY_DEFAULT_WIDTH, STICKY_MIN_HEIGHT, STICKY_MIN_WIDTH } from "./StickyNotesMenu";

export interface WorkflowNodeData {
  def: NodeDef;
  label: string;
  config: Record<string, unknown>;
  color: string;
  /** removes this node (and its connections) from the canvas — wired in the editor */
  onDelete?: () => void;
  [key: string]: unknown;
}

interface SourceSpec {
  id: string;
  label: string;
}

export default function WorkflowNode({ id, data, selected }: NodeProps<Node<WorkflowNodeData>>) {
  const { def, label, config, color } = data;
  // Canvas zoom — a resize drag happens in screen pixels, so it has to be
  // converted back into the note's own (flow) coordinates.
  const { getZoom } = useReactFlow();
  // Optional run-status marker driven by the last execution (drives the
  // "halted here" highlight + success/not-run states on the canvas).
  const runStatus = (data.runStatus as string) || "";
  // What went wrong on this node in the last run (applyRunStatuses) — shown
  // right on the card, so a failed run points at its cause without the Log.
  const runError = data.runError as { code?: number; short: string; message: string; handled: boolean } | undefined;
  // True while this node is the one currently executing (fed by the run-progress
  // poll from the editor) — the node gets a loading ring + glow.
  const isRunning = !!data.isRunning;
  // Other accounts that have THIS node open right now (shared workflows only) —
  // a small marker shows who is editing where, so two people on one workflow
  // don't silently overwrite each other.
  const editors = (data.presence as Array<{ userId: string; name: string; email: string }>) || [];
  const editorLabel = (e: { name: string; email: string }) => e.name || e.email || "another user";

  // --- source handles ------------------------------------------------------
  // The Switch and Router nodes derive one output handle per configured case /
  // rule (+ a default / fallback), so their handles are dynamic rather than
  // coming from the static def.sources.
  const isSwitch = def.type === "switch";
  const isRouter = def.type === "router";
  let sources: SourceSpec[];
  let handleTops: string[];
  if (isSwitch || isRouter) {
    const rows = (isSwitch ? config.cases : config.rules) as Array<{ key?: string; value?: string; label?: string }> | undefined;
    const list: SourceSpec[] = (Array.isArray(rows) ? rows : []).map((row, i) => ({
      id: `case-${i}`,
      label: (row && String(row.label || row.value || "").trim()) || (isSwitch ? `Case ${i + 1}` : `Rule ${i + 1}`),
    }));
    list.push(isSwitch ? { id: "default", label: "Default" } : { id: "fallback", label: "Fallback" });
    const count = list.length;
    sources = list;
    handleTops = list.map((_, i) => `${Math.round(((i + 1) / (count + 1)) * 100)}%`);
  } else {
    sources = (def.sources?.length ? def.sources : ["out"]).map((s) => ({ id: s, label: s }));
    // Even spacing for 1..N static handles (the old 33 + i*34 formula only
    // looked right for exactly two; multi-output nodes like Compare Datasets
    // need the general form).
    const count = sources.length;
    handleTops = sources.map((_, i) => `${Math.round(((i + 1) / (count + 1)) * 100)}%`);
  }

  // Build a small config preview from the first populated fields
  const preview = def.fields
    .filter((f) => f.type !== "note" && f.type !== "secret")
    .map((f) => ({ key: f.key, val: config[f.key] }))
    .filter((x) => x.val !== undefined && x.val !== null && x.val !== "")
    .slice(0, 2)
    .map((x) => ({ key: x.key, val: typeof x.val === "object" ? JSON.stringify(x.val).slice(0, 40) : String(x.val).slice(0, 40) }));

  // Sticky notes are a different beast: no handles, no execution — just a piece
  // of paper that lives BEHIND the workflow (the editor renders sticky nodes
  // first so they never cover real nodes). Double-clicking one opens its editor.
  if (def.type === "stickyNote") {
    const noteColor = (config.color as string) || "#3a3320";
    const text = String(config.content ?? "");
    // Size lives on the note's config so it is saved/exported with the workflow.
    const width = Math.max(STICKY_MIN_WIDTH, Number(config.width) || STICKY_DEFAULT_WIDTH);
    const height = Math.max(STICKY_MIN_HEIGHT, Number(config.height) || STICKY_DEFAULT_HEIGHT);
    const onResize = data.onResize as ((width: number, height: number) => void) | undefined;

    // Drag the corner grip to resize. The move listener lives on window (not the
    // grip) so the pointer may leave the little square while dragging, and the
    // event is stopped from reaching React Flow so the note is not dragged too.
    const startResize = (e: React.PointerEvent) => {
      if (!onResize) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const zoom = getZoom() || 1;
      const move = (ev: PointerEvent) => {
        onResize(
          Math.max(STICKY_MIN_WIDTH, Math.round(width + (ev.clientX - startX) / zoom)),
          Math.max(STICKY_MIN_HEIGHT, Math.round(height + (ev.clientY - startY) / zoom))
        );
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };

    return (
      <div className={`wfnote ${selected ? "selected" : ""}`} style={{ background: noteColor, width, height }}>
        <div className="wfnote-head">
          <StickyNote size={12} /> NOTE
          <span className="wfnote-size">{width} × {height}</span>
        </div>
        <div className="wfnote-body">{text || "Double-click to write a note…"}</div>
        {data.onDelete && (
          <button
            className="wfnote-del"
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete?.();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            title="Delete this note"
          >
            <Trash2 size={12} />
          </button>
        )}
        {onResize && (
          <span
            className="wfnote-grip nodrag nopan"
            onPointerDown={startResize}
            title="Drag to resize this note"
            aria-label="Resize note"
          />
        )}
      </div>
    );
  }

  const kindLabel = def.kind === "trigger" ? "trigger" : def.kind === "ai" ? "ai node" : def.kind;

  const statusClass = runStatus ? ` wfnode-status-${runStatus}` : "";
  const runningClass = isRunning ? " wfnode-running" : "";
  const presenceClass = editors.length ? " wfnode-presence" : "";

  return (
    <div className={`wfnode${statusClass}${runningClass}${presenceClass} ${selected ? "selected" : ""}`} style={{ ["--c" as string]: color }}>
      {isRunning && <span className="wfnode-running-ring" title="This node is executing right now" />}
      {/* open comment threads on this node — click opens them (CollabPanel) */}
      {Number(data.commentCount) > 0 && (
        <button
          className="wfnode-comments nodrag"
          title={`${data.commentCount} open comment${data.commentCount === 1 ? "" : "s"} — click to read`}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent("wflow:comments", { detail: id }));
          }}
        >
          <MessageSquare size={10} /> {String(data.commentCount)}
        </button>
      )}
      {/* small marker: which node another user of this shared workflow is
          editing right now (their name, or their e-mail when unnamed) */}
      {editors.length > 0 && (
        <span
          className="wfnode-editing"
          title={editors.map((e) => `${editorLabel(e)} is editing this node right now`).join("\n")}
        >
          <Pencil size={10} />
          {editors.map((e) => editorLabel(e)).join(", ")} editing
        </span>
      )}
      <div className="wfnode-head">
        <div className="wfnode-icon">
          <NodeIcon name={def.icon} size={13} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="wfnode-title">
            {label || def.name}
            <NodeServiceBadge type={def.type} name={def.name} description={def.description} size={12} />
            {def.demo && (
              <span className="demo-badge" title="Fires a sample when you press Run. It does not start by itself yet.">
                Demo
              </span>
            )}
          </div>
          <div className="wfnode-sub">{kindLabel}</div>
        </div>
        {isRunning && (
          <span className="wfnode-badge wfnode-badge-running" title="Executing right now">
            ● RUNNING
          </span>
        )}
        {!!config.manualOutput && (
          <span className="wfnode-badge" title="Manual output is set — the node is not executed">
            FIXED
          </span>
        )}
        {runStatus === "error" && (
          <span
            className="wfnode-badge wfnode-badge-error"
            title={runError?.handled ? "This node failed; its On error setting let the run continue" : "This node failed and the workflow halted here"}
          >
            {runError?.handled ? "● FAILED" : "● HALTED"}
          </span>
        )}
        {runStatus === "notrun" && (
          <span className="wfnode-badge wfnode-badge-notrun" title="Not reached — execution halted before this node">
            SKIPPED
          </span>
        )}
        {runStatus === "success" && (
          <span className="wfnode-badge wfnode-badge-success" title="Ran successfully">
            ✓
          </span>
        )}
      </div>

      {runStatus === "error" && runError && (
        <div className="wfnode-error" title={`${runError.message}

Open the node to see how to fix it.`}>
          <div className="wfnode-error-code">
            {runError.code ? `BF-${runError.code}` : "Error"}
            {runError.short ? ` · ${runError.short}` : ""}
          </div>
          {runError.message && <div className="wfnode-error-msg">{runError.message}</div>}
        </div>
      )}

      <Handle type="target" position={Position.Left} id="in" style={{ top: "50%" }} />
      <span className="wfnode-handle-label tgt">IN</span>

      {preview.length > 0 && (
        <div className="wfnode-config">
          {preview.map((p) => (
            <div key={p.key}>
              <span className="k">{p.key}:</span> {p.val}
            </div>
          ))}
        </div>
      )}

      {sources.map((s, i) => (
        <div key={s.id}>
          <Handle
            type="source"
            position={Position.Right}
            id={s.id}
            style={{ top: handleTops[i] }}
          />
          {(isSwitch || isRouter || sources.length > 1) && (
            <span className="wfnode-handle-label src" style={{ top: handleTops[i] }}>
              {s.label.toUpperCase()}
            </span>
          )}
        </div>
      ))}

      {/* The delete action lives just below the card and is revealed by the
          card hover state. Keep both handlers here: pointer-down prevents
          React Flow from starting a drag, while click performs the delete. */}
      {data.onDelete && (
        <div className="wfnode-footer">
          <button
            className="wfnode-del"
            onClick={(e) => {
              e.stopPropagation();
              data.onDelete?.();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            title="Delete this node"
            aria-label={`Delete ${label || def.name} node`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}