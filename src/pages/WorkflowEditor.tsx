import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  MarkerType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, BookOpen, Braces, Eye, Bug, CircleHelp, FastForward, StepForward, Copy, Download, FlaskConical, Gauge, History, LayoutGrid, Map as MapIcon, MoreHorizontal, PanelLeft, Play, Redo2, RotateCcw, Save, Settings, Share2, Sparkles, StickyNote, Terminal, Trash2, Undo2, Upload, Users, Webhook, X } from "lucide-react";
import { api } from "../api";
import type { AiBudget, Agent, ApprovalRequest, WorkflowRole, BuilderReference, Catalog, ChatMessage, ExecResult, ExecutionSummary, FlowEdge, LoopRunStatus, FlowNode, SharedEditor, WaitingRun, Workflow, WorkflowEnvironment, WorkflowExecutionMode, WorkflowFolder, WorkflowLoop, WorkflowMcpSettings, WorkflowTest } from "../types";
import Palette, { NODE_DRAG_TYPE } from "../components/Palette";
import NodeConfigModal, { type InputOverview, type UpstreamFile } from "../components/NodeConfigModal";
import WorkflowModal from "../components/WorkflowModal";
import ShareModal from "../components/ShareModal";
import LogConsole from "../components/LogConsole";
import WorkflowNode, { type WorkflowNodeData } from "../components/WorkflowNode";
import StickyNotesMenu, {
  STICKY_COLORS,
  STICKY_DEFAULT_HEIGHT,
  STICKY_DEFAULT_WIDTH,
  STICKY_MIN_HEIGHT,
  STICKY_MIN_WIDTH,
  clampStickySize,
  type StickyNoteEntry,
} from "../components/StickyNotesMenu";
import EvaluationModal from "../components/EvaluationModal";
import ConnectionEdge, { EdgeRunContext, type ConnectionEdgeData, type EdgeRunInfo } from "../components/ConnectionEdge";
import WorkflowAgent from "../components/WorkflowAgent";
import WorkflowExecutions from "../components/WorkflowExecutions";
import WorkflowVersions from "../components/WorkflowVersions";
import WorkflowBackups from "../components/WorkflowBackups";
import { Toast, useToast } from "../components/Toast";
import { getSettings } from "../settings";
import { stripSecretsFromConfig, stripSecretsFromWorkflow } from "../share";
import { mergeWorkflows } from "../../shared/workflow-merge.js";
import { AiCostButton } from "../components/AiSpending";
import CollabPanel, { type CollabTab } from "../components/CollabPanel";
// CodeMirror is only fetched when the JSON window opens.
const JsonCodeEditor = lazy(() => import("../components/JsonCodeEditor"));
import { stripPrivateFromWorkflow } from "../../shared/privacy.js";

interface Props {
  workflowId?: string;
  catalog: Catalog;
  onBack: () => void;
  /** open the app's Settings modal on the Documentation tab (inline help) */
  onOpenHelp?: () => void;
  /** navigate to the dashboard focused on a folder (clickable breadcrumb path) */
  onOpenFolder?: (folderId?: string) => void;
}

interface Meta {
  id: string;
  name: string;
  description: string;
  /** Test / Live environment */
  environment?: WorkflowEnvironment;
  /** listed as a tool for AI assistants (MCP) */
  mcp?: WorkflowMcpSettings;
  /** this workflow's own AI token / cost limits */
  aiBudget?: AiBudget;
  /** what this account may do here: owner / editor / runner / viewer */
  role?: WorkflowRole;
  folderId?: string;
  webhookSlug?: string;
  collaborators?: Workflow["collaborators"];
  /** automated tests edited in the Evaluation menu */
  tests?: WorkflowTest[];
  /** true when another user shared this workflow with the current account */
  shared?: boolean;
  /** true when the access comes from a shared folder, not a direct share */
  sharedViaFolder?: boolean;
  /** owner view: the folder holding this workflow is shared with someone */
  folderShared?: boolean;
  /** owner view: the user that shared folder belongs to */
  folderSharedWith?: string;
  /** the owner who shared this workflow with the current account */
  sharedBy?: Workflow["sharedBy"];
  /** repeat the whole workflow after each run (null clears the setting) */
  loop?: WorkflowLoop | null;
  /** "editor" (default) or "background" (Pro) execution */
  executionMode?: WorkflowExecutionMode;
}

function toRfNodes(
  flowNodes: FlowNode[],
  catalog: Catalog,
  onDeleteNode?: (id: string) => void,
  onResizeSticky?: (id: string, width: number, height: number) => void
): Node<WorkflowNodeData>[] {
  return flowNodes.map((n) => {
    const def = catalog.nodes[n.type];
    const color = def ? catalog.categories[def.category]?.color || "#7d9cc4" : "#7d9cc4";
    let config = n.data.config || {};
    // Migrate legacy AI Agent configs (the old `useInline` boolean) to the new
    // three-way `agentSource` selector so the editor shows the right option.
    if (def?.type === "aiAgent" && config.agentSource === undefined) {
      config = { ...config, agentSource: config.useInline ? "inline" : "saved" };
    }
    return {
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        def: def || { type: n.type, kind: "action", category: "actions", name: n.type, description: "", icon: "box", defaults: {}, fields: [], sources: ["out"] },
        label: n.data.label,
        config,
        color,
        onDelete: () => onDeleteNode?.(n.id),
        // Sticky notes carry their own resize handler (the corner grip).
        ...(def?.type === "stickyNote" ? { onResize: (w: number, h: number) => onResizeSticky?.(n.id, w, h) } : {}),
      },
    };
  });
}

// "Shared mode": another account can edit this workflow — a direct collaborator
// was added (owner view), it was shared with this account, or the folder holding
// it is shared (in either direction). It drives the shared-editing features:
// save budget, presence marker and the toolbar badge.
function isSharedMode(meta: Meta | null): boolean {
  if (!meta) return false;
  return !!meta.shared || (meta.collaborators?.length || 0) > 0 || !!meta.folderShared;
}

function toFlowNodes(rfNodes: Node<WorkflowNodeData>[]): FlowNode[] {
  return rfNodes.map((n) => ({
    id: n.id,
    type: (n.data.def as { type: string }).type,
    position: n.position,
    data: { label: n.data.label, config: n.data.config || {} },
  }));
}

// Clipboard text → something to merge onto the canvas: a workflow
// ({ nodes, edges }), an array of nodes or a single node. Anything else (plain
// text, a URL) is left alone so pasting into the canvas never does surprises.
function pastedWorkflow(text: string): { nodes: FlowNode[]; edges: FlowEdge[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const isNode = (v: unknown): v is FlowNode => !!v && typeof v === "object" && typeof (v as FlowNode).type === "string" && !!(v as FlowNode).data;
  if (Array.isArray(value)) return value.every(isNode) && value.length ? { nodes: value, edges: [] } : null;
  if (isNode(value)) return { nodes: [value], edges: [] };
  const wf = value as { nodes?: unknown; edges?: unknown };
  if (wf && Array.isArray(wf.nodes) && wf.nodes.length && wf.nodes.every(isNode)) {
    return { nodes: wf.nodes, edges: Array.isArray(wf.edges) ? (wf.edges as FlowEdge[]) : [] };
  }
  return null;
}

function toFlowEdges(rfEdges: Edge[]): FlowEdge[] {
  return rfEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
  }));
}

// --- canvas undo history ----------------------------------------------------
/** One point in the undo history: a graph plus the key that identifies it. */
interface GraphSnapshot {
  key: string;
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
}

// Canvas state is never mutated in place — every change produces new node/edge
// objects — so a shallow clone per node is enough to pin a history entry.
function cloneNodes(ns: Node<WorkflowNodeData>[]): Node<WorkflowNodeData>[] {
  return ns.map((n) => ({ ...n, position: { ...n.position }, data: { ...n.data } }));
}
function cloneEdges(es: Edge[]): Edge[] {
  return es.map((e) => ({ ...e }));
}
// Two graphs count as the same edit step when their persisted shape matches, so
// selecting a node or renaming a workflow never occupies an undo slot.
function graphKey(ns: Node<WorkflowNodeData>[], es: Edge[]): string {
  return JSON.stringify({ n: toFlowNodes(ns), e: toFlowEdges(es) });
}

// Mark each canvas node with the outcome of the last run so the user can see who
// ran, who succeeded, and — critically — where a run halted (the errored node is
// highlighted "HALTED" and anything downstream is dimmed as not-reached).
function applyRunStatuses(result: ExecResult | null, setNodesFn: (fn: (nds: Node<WorkflowNodeData>[]) => Node<WorkflowNodeData>[]) => void) {
  const log = result?.log || [];
  if (!log.length) {
    setNodesFn((nds) => nds.map((n) => ({ ...n, data: { ...n.data, runStatus: undefined, runError: undefined } })));
    return;
  }
  const ranIds = new Set(log.map((l) => l.nodeId));
  const erroredIds = new Set(log.filter((l) => l.status === "error").map((l) => l.nodeId));
  // The failure itself rides along so the node can show it on the canvas.
  const errorOf = new Map(
    log
      .filter((l) => l.status === "error")
      .map((l) => [l.nodeId, { code: l.errorCode, short: l.errorShort || "", message: l.error || "", handled: !!l.handled }])
  );
  // Nodes are also "halted/not reached" when the run was stopped by the user
  // (Stop button) — everything downstream of the last executed node is dimmed.
  const halted = (result?.errorCount ?? 0) > 0 || !!result?.aborted;
  setNodesFn((nds) =>
    nds.map((n) => {
      let runStatus: string | undefined;
      if (erroredIds.has(n.id)) runStatus = "error";
      else if (ranIds.has(n.id)) runStatus = "success";
      else if (halted) runStatus = "notrun";
      return { ...n, data: { ...n.data, runStatus, runError: errorOf.get(n.id) } };
    })
  );
}

// flatten a sample payload into dotted field paths, up to 2 levels deep
function flattenFields(obj: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 2) return out;
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === "object" && obj[0] !== null) {
      for (const k of Object.keys(obj[0])) out.push(prefix ? `${prefix}.${k}` : k);
    }
    return out;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      flattenFields(v, path, depth + 1, out);
    }
  }
  return out;
}

function EditorInner({ workflowId, catalog, onBack, onOpenHelp, onOpenFolder }: Props) {
  const { show, toast } = useToast();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [folders, setFolders] = useState<WorkflowFolder[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WorkflowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [runResult, setRunResult] = useState<ExecResult | null>(null);
  const [waiting, setWaiting] = useState<WaitingRun | null>(null);
  // Chat panel state — only used when the workflow has a Chat Trigger / Chat
  // Output node. Each message is a run; the assistant replies are appended here
  // and shown both in the Chat tab and in the Execution tab of the Log console.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [sendingChat, setSendingChat] = useState(false);
  // Id of the node that is executing right now (fed by the run-progress poll) —
  // the canvas draws a loading ring over it while the run is in flight.
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
  // Debug mode: the run pauses before every node until Next / Continue.
  const [debugRun, setDebugRun] = useState(false);
  const [paused, setPaused] = useState<{ nodeId: string; input: unknown[] } | null>(null);
  // Client-generated id for the current Run click. Sent with /run so the server
  // can report per-node progress and honour the Stop button.
  const runTokenRef = useRef<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleH, setConsoleH] = useState(260);
  const [consoleW, setConsoleW] = useState<number | null>(null);
  // Saved run history shown in the Execution menu (every run is persisted in
  // the SQL database — see server/executions.js).
  const [execHistory, setExecHistory] = useState<ExecutionSummary[]>([]);
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [endingSharing, setEndingSharing] = useState(false);
  // Set when a collaborator loses access (the owner ended the shared session)
  // while this editor was open — they are thrown out of the workflow.
  const [sessionEnded, setSessionEnded] = useState<{ message: string } | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  // null = the whole workflow; a node id = that one node (from its settings).
  const [jsonNodeId, setJsonNodeId] = useState<string | null>(null);
  const [jsonIssues, setJsonIssues] = useState({ errors: 0, warnings: 0 });
  const [helpShortcuts, setHelpShortcuts] = useState(false);
  // Toolbar dropdown menus (Help and the "More" overflow) — keeps the action
  // bar short instead of showing every advanced action as its own button.
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  const metaRef = useRef<Meta | null>(null);

  // --- undo / redo ----------------------------------------------------------
  // The canvas keeps a bounded history of graph states, driven by Ctrl+Z /
  // Ctrl+Y (and the toolbar buttons). Edits are COALESCED: after a burst of
  // changes settles (dragging a node, typing in a field) one snapshot is
  // committed, so undo steps back a meaningful edit instead of every mouse
  // move. The stacks live in refs because they must survive re-renders without
  // triggering one on every change; historyVersion only drives the buttons.
  const HISTORY_LIMIT = 60;
  const nodesRef = useRef<Node<WorkflowNodeData>[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const historyRef = useRef<{ undo: GraphSnapshot[]; redo: GraphSnapshot[]; present: GraphSnapshot; timer: ReturnType<typeof setTimeout> | null }>({
    undo: [],
    redo: [],
    present: { key: "", nodes: [], edges: [] },
    timer: null,
  });
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Commit whatever the canvas holds now, pushing the state it replaced onto
  // the undo stack. A no-op when the graph did not actually change (renames,
  // selection, a click), so those never fill the history.
  const commitHistory = useCallback(() => {
    const h = historyRef.current;
    const key = graphKey(nodesRef.current, edgesRef.current);
    if (key === h.present.key) return;
    h.undo.push(h.present);
    if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
    h.redo = [];
    h.present = { key, nodes: cloneNodes(nodesRef.current), edges: cloneEdges(edgesRef.current) };
    setHistoryVersion((v) => v + 1);
  }, []);

  const scheduleHistoryCommit = useCallback(() => {
    const h = historyRef.current;
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => {
      h.timer = null;
      commitHistory();
    }, 450);
  }, [commitHistory]);

  // Start a fresh history for a graph that replaced the canvas wholesale
  // (loading the workflow, importing a file, the AI builder's answer).
  const resetHistory = useCallback((ns: Node<WorkflowNodeData>[], es: Edge[]) => {
    historyRef.current.undo = [];
    historyRef.current.redo = [];
    historyRef.current.present = { key: graphKey(ns, es), nodes: cloneNodes(ns), edges: cloneEdges(es) };
    setHistoryVersion((v) => v + 1);
  }, []);

  useEffect(() => () => {
    if (historyRef.current.timer) clearTimeout(historyRef.current.timer);
  }, []);
  // --- save throttling ------------------------------------------------------
  // Autosaves are limited to 1 per minute for EVERY workflow, so a busy editing
  // session cannot hammer the server. While a workflow is shared each user gets
  // one MANUAL save per minute on top of that — pressing Save therefore always
  // has a budget of its own, and the toolbar says clearly when it is used up.
  // The server enforces the identical caps (rejecting the next save with 429),
  // so the client stops before that happens.
  const saveTimesRef = useRef<number[]>([]);
  const manualSaveTimesRef = useRef<number[]>([]);
  const SAVE_WINDOW_MS = 60_000;
  const SAVE_MAX_PER_MINUTE = 1;
  // bumped once a second while a shared workflow is open, so the countdown of
  // the manual-save budget in the toolbar stays accurate
  const [saveBudgetTick, setSaveBudgetTick] = useState(0);
  const buildPayloadRef = useRef<() => Workflow | null>(() => null);
  // set by the import/merge handler below; used by the canvas drop handler so
  // the JSON-file drop works even though the handlers are defined in separate
  // hooks. A dropped file either replaces the canvas (empty) or is merged into
  // it (see importOrMergeJson).
  const importFileRef = useRef<(text: string) => void>(() => {});
  // Latest merge handler / nodes for the keyboard shortcuts (copy & paste as JSON).
  const mergeJsonRef = useRef<(text: string) => void>(() => {});
  const [fileDragOver, setFileDragOver] = useState(false);
  // Side menu (node palette) — collapsible on every screen size via the square
  // button on the canvas. Starts open on desktop, closed on compact screens.
  const [paletteOpen, setPaletteOpen] = useState(() => (typeof window === "undefined" ? true : window.innerWidth > 720));
  // A "Wait for Approval" node the live run is parked on (fed by the run-status
  // poll) — the Log console shows Approve / Reject buttons while it is set.
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [answeringApproval, setAnsweringApproval] = useState(false);
  // Version history modal (restore an earlier state of this workflow).
  const [versionsOpen, setVersionsOpen] = useState(false);
  // Backup & rewind menu (shared workflows) — the rolling-buffer safety net.
  const [backupsOpen, setBackupsOpen] = useState(false);
  // Nodes the user pinned in a node's config as references for the AI helper.
  const [agentRefs, setAgentRefs] = useState<BuilderReference[]>([]);
  // --- editor view: the node canvas, or this workflow's execution history ---
  const [view, setView] = useState<"workspace" | "executions">("workspace");
  // bumped after every run so the Executions view reloads its list
  const [historyKey, setHistoryKey] = useState(0);
  // AI workflow builder — a floating panel in the bottom-left corner of the
  // workspace that writes this workflow with the user's own model.
  const [agentOpen, setAgentOpen] = useState(false);
  // Evaluation menu — define + run automated tests against this workflow.
  const [evalOpen, setEvalOpen] = useState(false);
  // Sticky-notes menu (the square button under the palette toggle).
  const [stickyMenuOpen, setStickyMenuOpen] = useState(false);
  const [activeStickyId, setActiveStickyId] = useState<string | null>(null);
  // Other accounts on the canvas right now (shared workflows only) — each one
  // carries the node its editor has open, drawn as a small marker on the node.
  const [sharedEditors, setSharedEditors] = useState<SharedEditor[]>([]);
  // The node this user is editing (kept in a ref so the presence poll reads the
  // latest position without restarting the interval on every node change).
  const editingNodeRef = useRef<{ id: string | null; label: string }>({ id: null, label: "" });
  // True only while a node is being dragged — the overview minimap is shown for
  // the duration of a drag so the whole workflow is visible while you move a node.
  const [draggingNode, setDraggingNode] = useState(false);
  // The whole-workflow overview minimap. It stays visible by default and can be
  // hidden with its square canvas button; it is interactive — drag it to pan the
  // canvas and scroll over it to zoom, so the workflow follows the map.
  const [minimapOpen, setMinimapOpen] = useState(true);
  // remember when a node drag just ended so a stray click that follows it does
  // NOT reopen the node config (the drag-to-open bug).
  const dragSuppressUntilRef = useRef(0);
  const markNodeDrag = useCallback(() => {
    dragSuppressUntilRef.current = Date.now() + 350;
  }, []);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);
  // A workflow shared as "view" or "view & run" opens read-only: nothing on the
  // canvas can be moved, connected, deleted or saved (the server enforces it
  // too); a viewer cannot run it either.
  const readOnly = meta?.role === "viewer" || meta?.role === "runner";
  const canRun = meta?.role !== "viewer";
  const readOnlyRef = useRef(false);
  readOnlyRef.current = readOnly;
  // Canvas nodes show their own delete button when they carry onDelete — a
  // read-only viewer gets none.
  const nodeCount = nodes.length;
  useEffect(() => {
    if (!readOnly) return;
    setNodes((nds) => (nds.some((n) => n.data.onDelete) ? nds.map((n) => (n.data.onDelete ? { ...n, data: { ...n.data, onDelete: undefined } } : n)) : nds));
  }, [readOnly, nodeCount, setNodes]);
  const { screenToFlowPosition, fitView, setCenter } = useReactFlow();

  const nodeTypes = useMemo(() => Object.fromEntries(Object.keys(catalog.nodes).map((t) => [t, WorkflowNode])), [catalog]);
  const edgeTypes = useMemo(() => ({ deleteEdge: ConnectionEdge }), []);

  // Sticky notes render BEHIND the workflow: React Flow paints nodes in array
  // order, so drawing them first keeps the notes from covering real nodes.
  const orderedNodes = useMemo(() => {
    const isSticky = (n: Node<WorkflowNodeData>) => n.data.def.type === "stickyNote";
    return [...nodes].sort((a, b) => Number(isSticky(a)) - Number(isSticky(b)));
  }, [nodes]);

  // --- load ----------------------------------------------------------------
  useEffect(() => {
    if (!workflowId) return;
    api.workflows
      .get(workflowId)
      .then((wf) => {
        setMeta({ id: wf.id, name: wf.name, description: wf.description || "", folderId: wf.folderId, webhookSlug: wf.webhookSlug, collaborators: wf.collaborators, shared: wf.shared, sharedViaFolder: wf.sharedViaFolder, folderShared: wf.folderShared, folderSharedWith: wf.folderSharedWith, sharedBy: wf.sharedBy, tests: wf.tests || [], loop: wf.loop, executionMode: wf.executionMode, environment: wf.environment, mcp: wf.mcp, aiBudget: wf.aiBudget, role: wf.role });
        const rfNodes = toRfNodes(wf.nodes || [], catalog, removeNodeById, resizeSticky);
        const rfEdges = (wf.edges || []).map((e) => makeEdge(e));
        setNodes(rfNodes);
        setEdges(rfEdges);
        resetHistory(rfNodes, rfEdges);
        loadedRef.current = true;
        setTimeout(() => fitView({ padding: 0.25, duration: 300 }), 80);
      })
      .catch((err) => setLoadError(String((err as Error).message || err)));
    api.agents.list().then(setAgents).catch(() => setAgents([]));
    api.workflows.folders().then(setFolders).catch(() => setFolders([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  // --- save / run -----------------------------------------------------------
  const buildPayload = useCallback((): Workflow | null => {
    if (!meta) return null;
    return {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      folderId: meta.folderId,
      webhookSlug: meta.webhookSlug,
      collaborators: meta.collaborators,
      tests: meta.tests || [],
      // null (not undefined) so turning the repeat off actually reaches the
      // server — JSON drops undefined keys, which would keep the old setting.
      loop: meta.loop ?? null,
      executionMode: meta.executionMode,
      environment: meta.environment || "live",
      mcp: meta.mcp,
      aiBudget: meta.aiBudget,
      nodes: toFlowNodes(nodes),
      edges: toFlowEdges(edges),
    };
  }, [meta, nodes, edges]);
  useEffect(() => {
    buildPayloadRef.current = buildPayload;
  }, [buildPayload]);

  // --- dirty tracking + auto-save -------------------------------------------
  // Register a save in a sliding 60 s window; false means the 1/minute cap is
  // reached (no timestamp is consumed in that case). Each bucket (auto-saves,
  // manual saves) has its own list of timestamps.
  const consumeSaveSlot = useCallback((bucket: { current: number[] }): boolean => {
    const now = Date.now();
    bucket.current = bucket.current.filter((t) => now - t < SAVE_WINDOW_MS);
    if (bucket.current.length >= SAVE_MAX_PER_MINUTE) return false;
    bucket.current.push(now);
    return true;
  }, []);

  // Milliseconds until the next save slot frees up (used to retry a throttled
  // autosave as soon as the oldest save drops out of the window).
  const msUntilSaveSlot = useCallback((bucket: { current: number[] }): number => {
    const now = Date.now();
    const times = bucket.current.filter((t) => now - t < SAVE_WINDOW_MS);
    if (times.length < SAVE_MAX_PER_MINUTE) return 0;
    return SAVE_WINDOW_MS - (now - Math.min(...times)) + 250;
  }, []);

  const save = useCallback(
    async (opts?: { silent?: boolean; autosave?: boolean; manual?: boolean }): Promise<Workflow | null> => {
      // Viewers and runners cannot change the workflow — the server refuses it
      // too, so there is nothing to send.
      const role = metaRef.current?.role;
      if (role === "viewer" || role === "runner") return null;
      const payload = buildPayload();
      if (!payload) return null;
      const isShared = isSharedMode(metaRef.current);
      if (opts?.manual && isShared) {
        // A deliberate Save on a shared workflow uses the user's own budget of
        // ONE manual save per minute — auto-saves are unaffected by it.
        if (!consumeSaveSlot(manualSaveTimesRef)) {
          setSaveBudgetTick((n) => n + 1);
          show("No manual saves left — on a shared workflow you have 1 manual save per minute. Auto-save keeps saving your changes; try again in a moment.", "err");
          return null;
        }
        setSaveBudgetTick((n) => n + 1);
      } else if (opts?.autosave || isShared) {
        // Auto-saves (and the implicit save when a shared editor flushes) are
        // limited to 1 per minute for every workflow.
        if (!consumeSaveSlot(saveTimesRef)) {
          if (opts?.autosave) {
            // Keep the workflow dirty and retry as soon as a slot frees, so
            // the latest state is still persisted automatically moments later.
            const delay = Math.min(msUntilSaveSlot(saveTimesRef), SAVE_WINDOW_MS);
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => save({ silent: true, autosave: true }), delay);
            return null;
          }
          // A background flush (e.g. closing a node's config) never nags the
          // user — the workflow stays dirty and the next tick retries.
          if (!opts?.silent) show("Auto-saves are limited to 1 per minute — wait a moment and save again.", "err");
          return null;
        }
      }
      setSaving(true);
      try {
        const saved = await api.workflows.update(payload, { manual: opts?.manual });
        setMeta((m) =>
          m
            ? {
                id: saved.id,
                name: saved.name,
                description: saved.description || "",
                folderId: saved.folderId,
                webhookSlug: saved.webhookSlug,
                collaborators: saved.collaborators,
                // the server normalises these, so trust its answer
                loop: saved.loop,
                executionMode: saved.executionMode,
                shared: m.shared,
                sharedBy: m.sharedBy,
                sharedViaFolder: m.sharedViaFolder,
              }
            : m
        );
        setDirty(false);
        setLastSavedAt(Date.now());
        if (!opts?.silent) show("Workflow saved");
        return saved;
      } catch (err) {
        const msg = String((err as Error).message || err);
        // The owner ended the shared session while this editor was open — the
        // workflow is gone from this account, so throw the collaborator out.
        if (metaRef.current?.shared && /not found/i.test(msg)) {
          setSessionEnded({ message: "The owner ended the shared session. This workflow is no longer shared with you, so you can no longer open or edit it." });
          return null;
        }
        show(`Save failed: ${msg}`, "err");
        return null;
      } finally {
        setSaving(false);
      }
    },
    [buildPayload, show, consumeSaveSlot, msUntilSaveSlot]
  );

  // Node callbacks (delete, sticky-note resize) live in the node data, which is
  // built once when a workflow loads and is not rebuilt on every render. Calling
  // the LATEST save through a ref keeps those handlers from being stuck on the
  // first render's state (which would silently drop their autosave).
  const saveRef = useRef<typeof save>(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // auto-save ~1.2 s after the last change, so closing the tab never loses
  // work. Autosaves respect the 1-per-minute cap (see save above).
  const scheduleAutoSave = useCallback(() => {
    if (!getSettings().autoSave) return; // Settings → Defaults
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveRef.current({ silent: true, autosave: true });
    }, 1200);
  }, []);

  const markDirty = useCallback(() => {
    if (loadedRef.current) {
      setDirty(true);
      scheduleAutoSave();
      scheduleHistoryCommit();
    }
  }, [scheduleAutoSave, scheduleHistoryCommit]);

  // Put a history entry back on the canvas. The graph is adopted as it is, the
  // workflow is marked dirty (so undo is saved like any other edit) and the
  // stacks are left alone — undo()/redo() decide what moves where.
  const applyHistoryState = useCallback(
    (state: GraphSnapshot) => {
      setNodes(cloneNodes(state.nodes));
      setEdges(cloneEdges(state.edges));
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      historyRef.current.present = { key: state.key, nodes: cloneNodes(state.nodes), edges: cloneEdges(state.edges) };
      if (loadedRef.current) {
        setDirty(true);
        scheduleAutoSave();
      }
      setHistoryVersion((v) => v + 1);
    },
    [setNodes, setEdges, scheduleAutoSave]
  );

  const undo = useCallback(() => {
    const h = historyRef.current;
    // Flush a pending edit first, so the very last change is undoable.
    if (h.timer) {
      clearTimeout(h.timer);
      h.timer = null;
      commitHistory();
    }
    if (!h.undo.length) return;
    const previous = h.undo.pop()!;
    h.redo.push(h.present);
    applyHistoryState(previous);
  }, [commitHistory, applyHistoryState]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.redo.length) return;
    const next = h.redo.pop()!;
    h.undo.push(h.present);
    applyHistoryState(next);
  }, [applyHistoryState]);

  // While a shared workflow is open, tick once a second so the manual-save
  // budget in the toolbar counts down instead of looking frozen.
  useEffect(() => {
    if (!isSharedMode(meta)) return;
    const t = setInterval(() => setSaveBudgetTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [meta]);

  // Remove one connection by id (used by the in-middle delete button on edges).
  const deleteEdgeById = useCallback(
    (edgeId: string) => {
      setEdges((eds) => eds.filter((e) => e.id !== edgeId));
      setSelectedEdgeId((cur) => (cur === edgeId ? null : cur));
      markDirty();
    },
    [setEdges, setSelectedEdgeId, markDirty]
  );

  // Decorate any new/loaded/imported edge with the custom (delete-on-select)
  // type and its handler. Accepts a raw Edge or an in-progress Connection (which
  // has no id yet — addEdge assigns one for connections).
  const makeEdge = useCallback(
    (base: Edge | Connection): Edge => {
      const decorated: Edge = {
        ...(base as Edge),
        type: "deleteEdge",
        markerEnd: { type: MarkerType.ArrowClosed, color: "#3d5080", width: 16, height: 16 },
        style: { stroke: "#3d5080" },
        data: { onDelete: deleteEdgeById } as ConnectionEdgeData,
      };
      return decorated;
    },
    [deleteEdgeById]
  );

  // final flush when the tab/window is closed
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (dirtyRef.current) {
        const payload = buildPayloadRef.current();
        if (payload) {
          fetch(`/api/workflows/${payload.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true,
          }).catch(() => {});
        }
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      markDirty();
    },
    [onNodesChange, markDirty]
  );
  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      markDirty();
    },
    [onEdgesChange, markDirty]
  );

  // --- add / connect --------------------------------------------------------
  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const def = catalog.nodes[type];
      if (!def) return;
      const id = `n-${crypto.randomUUID().slice(0, 8)}`;
      let pos = position;
      if (!pos) {
        const rect = canvasRef.current?.getBoundingClientRect();
        pos = rect
          ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
          : { x: 60 + Math.random() * 120, y: 60 + Math.random() * 120 };
      }
      const node: Node<WorkflowNodeData> = {
        id,
        type,
        position: pos,
        data: {
          def,
          label: def.name,
          config: { inputMode: "auto", inputField: "", ...def.defaults },
          color: catalog.categories[def.category]?.color || "#7d9cc4",
          onDelete: () => removeNodeById(id),
        },
      };
      setNodes((nds) => [...nds, node]);
      // On compact screens the palette is a drawer — close it after picking a
      // node so the canvas is visible. On desktop it stays open.
      if (typeof window !== "undefined" && window.innerWidth <= 720) setPaletteOpen(false);
      setSelectedNodeId(id);
      setSelectedEdgeId(null);
      markDirty();
    },
    [catalog, setNodes, markDirty, screenToFlowPosition]
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (conn.source === conn.target || readOnlyRef.current) return;
      setEdges((eds) => addEdge(makeEdge(conn), eds));
      markDirty();
    },
    [setEdges, markDirty, makeEdge]
  );

  // Remove a node and every connection attached to it (used by the delete
  // button under each canvas node, and the config modal's Delete button).
  const removeNodeById = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
      setSelectedEdgeId((cur) => (cur === nodeId ? null : cur));
      markDirty();
    },
    [setNodes, setEdges, setSelectedNodeId, setSelectedEdgeId, markDirty]
  );

  // --- sticky notes ---------------------------------------------------------
  // Sticky notes are non-executing nodes rendered BEHIND the workflow. The
  // side menu lists them so a large canvas can be organised with headings.
  const stickyNotes = useMemo<StickyNoteEntry[]>(
    () =>
      nodes
        .filter((n) => n.data.def.type === "stickyNote")
        .map((n) => {
          const config = (n.data.config || {}) as Record<string, unknown>;
          return {
            id: n.id,
            text: String(config.content ?? ""),
            color: String(config.color || STICKY_COLORS[0]),
            width: Math.max(STICKY_MIN_WIDTH, Number(config.width) || STICKY_DEFAULT_WIDTH),
            height: Math.max(STICKY_MIN_HEIGHT, Number(config.height) || STICKY_DEFAULT_HEIGHT),
          };
        }),
    [nodes]
  );

  const updateSticky = useCallback(
    (id: string, patch: { content?: string; color?: string; width?: number; height?: number }) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n))
      );
      markDirty();
    },
    [setNodes, markDirty]
  );

  // Resize a note (the corner grip on the canvas calls this through the node
  // data). Sizes are clamped and stored on the note's config, so they persist.
  const resizeSticky = useCallback(
    (id: string, width: number, height: number) => {
      updateSticky(id, {
        width: clampStickySize(width, STICKY_MIN_WIDTH),
        height: clampStickySize(height, STICKY_MIN_HEIGHT),
      });
    },
    [updateSticky]
  );

  const addSticky = useCallback(() => {
    const def = catalog.nodes.stickyNote;
    if (!def) return;
    const id = `n-${crypto.randomUUID().slice(0, 8)}`;
    const rect = canvasRef.current?.getBoundingClientRect();
    const pos = rect
      ? screenToFlowPosition({ x: rect.left + 200, y: rect.top + 190 })
      : { x: 80, y: 80 };
    const node: Node<WorkflowNodeData> = {
      id,
      type: "stickyNote",
      position: pos,
      data: {
        def,
        label: def.name,
        // A new note starts at the medium preset and can be resized from the
        // notes menu or by dragging its corner grip.
        config: { ...def.defaults, color: STICKY_COLORS[0], width: STICKY_DEFAULT_WIDTH, height: STICKY_DEFAULT_HEIGHT },
        color: catalog.categories[def.category]?.color || "#7d9cc4",
        onDelete: () => removeNodeById(id),
        onResize: (w: number, h: number) => resizeSticky(id, w, h),
      },
    };
    // Prepend so the note renders behind every other node.
    setNodes((nds) => [node, ...nds]);
    setActiveStickyId(id);
    markDirty();
  }, [catalog, setNodes, markDirty, removeNodeById, resizeSticky, screenToFlowPosition]);

  const focusSticky = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      setActiveStickyId(id);
      if (!node) return;
      setSelectedNodeId(id);
      setSelectedEdgeId(null);
      setCenter(node.position.x + 120, node.position.y + 70, { zoom: 1, duration: 400 });
    },
    [nodes, setCenter]
  );

  const deleteSticky = useCallback(
    (id: string) => {
      removeNodeById(id);
      setActiveStickyId((cur) => (cur === id ? null : cur));
    },
    [removeNodeById]
  );

  // Selection is separate from the node config. Dragging or marquee-selecting
  // nodes updates the highlight (React Flow does that) and tracks the selected
  // edge, but never opens the config modal.
  const onSelectionChange = useCallback(({ edges: selEdges }: OnSelectionChangeParams) => {
    setSelectedEdgeId(selEdges[0]?.id || null);
  }, []);

  // OPENING a node's config is now decoupled from selection: React Flow handles
  // the visual highlight itself, and selection (which runs during a drag) never
  // opens the modal. The config only opens on a genuine click, and only when the
  // click did not immediately follow a drag. Honors the "open node config on
  // click" setting — when off, a double click opens it instead.
  const openConfig = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
  }, []);

  // Sticky notes open the notes menu (not the node config modal) and never
  // start a connection — they are canvas annotations, not workflow steps.
  const openSticky = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setActiveStickyId(nodeId);
    setStickyMenuOpen(true);
  }, []);

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      setSelectedEdgeId(null);
      if (Date.now() < dragSuppressUntilRef.current) return; // came right after a drag
      if (node.type === "stickyNote") {
        openSticky(node.id);
        return;
      }
      if (!getSettings().openNodeOnClick) return; // user prefers double-click
      openConfig(node.id);
    },
    [openConfig, openSticky]
  );

  const onNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (node.type === "stickyNote") {
        openSticky(node.id);
        return;
      }
      if (getSettings().openNodeOnClick) return; // single click already opens it
      openConfig(node.id);
    },
    [openConfig, openSticky]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setFileDragOver(false);
      // dropping a workflow JSON file onto the canvas imports it
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        const file = files[0];
        if (file.name.toLowerCase().endsWith(".json") || file.type === "application/json") {
          file
            .text()
            .then((text) => importFileRef.current(text))
            .catch(() => {});
          return;
        }
      }
      const type = e.dataTransfer.getData(NODE_DRAG_TYPE);
      if (!type) return;
      addNode(type, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [addNode, screenToFlowPosition]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // show the import hint while dragging files over the canvas
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) {
      setFileDragOver(true);
      e.dataTransfer.dropEffect = "copy";
    } else {
      e.dataTransfer.dropEffect = "move";
    }
  }, []);

  // --- node editing ---------------------------------------------------------
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) || null;
  const selectedDef = selectedNode ? catalog.nodes[selectedNode.data.def.type] : null;
  const selectedColor = selectedNode ? selectedNode.data.color : undefined;

  const updateNodeData = useCallback(
    (patch: Partial<WorkflowNodeData>) => {
      if (!selectedNodeId) return;
      setNodes((nds) => nds.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
      markDirty();
    },
    [selectedNodeId, setNodes, markDirty]
  );

  // --- comments + "who changed what" (CollabPanel, next to the Log console) ---
  const [collab, setCollab] = useState<{ tab: CollabTab; nodeId: string | null } | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const openComments = useCallback((nodeId: string | null) => {
    setSelectedNodeId(null);
    setCollab({ tab: "comments", nodeId });
  }, []);
  // The badge on a canvas node asks for its thread through a window event, so
  // the node component needs no callback in its data (that would re-render
  // the whole canvas on every change).
  useEffect(() => {
    const onOpen = (e: Event) => openComments(String((e as CustomEvent).detail || "") || null);
    window.addEventListener("wflow:comments", onOpen);
    return () => window.removeEventListener("wflow:comments", onOpen);
  }, [openComments]);
  // Open threads per node — loaded with the workflow and refreshed by the panel.
  useEffect(() => {
    if (!meta?.id) return;
    const load = () =>
      api.workflows
        .comments(meta.id)
        .then((res) => {
          const counts: Record<string, number> = {};
          for (const c of res.comments) if (!c.parentId && !c.resolved && c.nodeId) counts[c.nodeId] = (counts[c.nodeId] || 0) + 1;
          setCommentCounts(counts);
        })
        .catch(() => {});
    load();
    const t = setInterval(() => !document.hidden && !collab && load(), 60_000);
    return () => clearInterval(t);
  }, [meta?.id, collab]);
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const count = commentCounts[n.id] || 0;
        if ((n.data.commentCount || 0) === count) return n;
        return { ...n, data: { ...n.data, commentCount: count } };
      })
    );
  }, [commentCounts, setNodes]);
  const focusNode = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      setCenter(node.position.x + 120, node.position.y + 70, { zoom: 1, duration: 400 });
      setNodes((nds) => nds.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
    },
    [nodes, setCenter, setNodes]
  );
  // Put one node back the way a history entry says it was (null = it did not
  // exist then). Only that node changes; its connections are left as they are.
  const restoreNode = useCallback(
    (nodeId: string, before: FlowNode | null) => {
      if (readOnlyRef.current) return;
      if (!before) {
        removeNodeById(nodeId);
        show("Node removed again — save to keep it");
        return;
      }
      const [restored] = toRfNodes([before], catalog, removeNodeById, resizeSticky);
      if (!restored) return;
      setNodes((nds) => (nds.some((n) => n.id === nodeId) ? nds.map((n) => (n.id === nodeId ? { ...restored, data: { ...restored.data, commentCount: n.data.commentCount } } : n)) : [...nds, restored]));
      markDirty();
      show(`“${before.data?.label || nodeId}” restored — save to keep it`);
    },
    [catalog, removeNodeById, resizeSticky, setNodes, markDirty, show]
  );

  const deleteSelected = useCallback(() => {
    if (selectedNodeId) removeNodeById(selectedNodeId);
    if (selectedEdgeId) setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    markDirty();
  }, [selectedNodeId, selectedEdgeId, setNodes, setEdges, markDirty, removeNodeById]);

  // --- AI helper references -------------------------------------------------
  // Pin a node so the AI builder chat knows exactly which step a request is
  // about. Credential fields are blanked before the node is handed over, and
  // the chat panel opens right away so the pinned node is immediately visible.
  const addAgentReference = useCallback(
    (node: Node<WorkflowNodeData>) => {
      const type = node.data.def.type;
      setAgentRefs((refs) =>
        refs.some((r) => r.nodeId === node.id)
          ? refs
          : [...refs, { nodeId: node.id, label: node.data.label, type, config: stripSecretsFromConfig(node.data.config || {}) }]
      );
      setAgentOpen(true);
      show(`“${node.data.label}” pinned as a reference for the AI helper`);
    },
    [show]
  );

  const removeAgentReference = useCallback((nodeId: string) => {
    setAgentRefs((refs) => refs.filter((r) => r.nodeId !== nodeId));
  }, []);

  // A pinned reference for a node that no longer exists would mislead the agent
  // (and the chip would point at nothing) — drop it as soon as the node is gone.
  useEffect(() => {
    setAgentRefs((refs) => {
      if (!refs.length) return refs;
      const ids = new Set(nodes.map((n) => n.id));
      const kept = refs.filter((r) => ids.has(r.nodeId));
      return kept.length === refs.length ? refs : kept;
    });
  }, [nodes]);

  // --- input overview -------------------------------------------------------
  const inputOverview = useMemo<InputOverview>(() => {
    if (!selectedNode) return { sources: [], fields: [], hasUpstream: false, upstream: [], producers: [], output: null, upstreamFiles: [] };
    const inMap = new Map<string, string[]>();
    for (const e of edges) {
      if (!inMap.has(e.target)) inMap.set(e.target, []);
      inMap.get(e.target)!.push(e.source);
    }
    const sources: string[] = [];
    const fields: string[] = [];
    const upstreamNodes: Array<Node<WorkflowNodeData>> = [];
    const seen = new Set<string>();
    const queue: string[] = [selectedNode.id];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const p of inMap.get(id) || []) {
        const pn = nodes.find((n) => n.id === p);
        if (!pn) continue;
        const def = catalog.nodes[pn.data.def.type];
        if (!def) continue;
        if (!upstreamNodes.some((u) => u.id === pn.id)) upstreamNodes.push(pn);
        if (!sources.includes(pn.data.label || def.name)) sources.push(pn.data.label || def.name);
        if (def.kind === "trigger") {
          const sample = catalog.samples?.[def.type];
          if (sample) flattenFields(sample).forEach((f) => !fields.includes(f) && fields.push(f));
        } else {
          queue.push(p);
        }
      }
    }
    const upstream = upstreamNodes.map((pn) => {
      const def = catalog.nodes[pn.data.def.type];
      const logEntry = runResult?.log.find((l) => l.nodeId === pn.id);
      return {
        nodeId: pn.id,
        label: pn.data.label || def?.name || pn.id,
        type: pn.data.def.type,
        items: logEntry?.outputItems ?? null,
        sample: def?.kind === "trigger" ? catalog.samples?.[def.type] ?? null : null,
        files: logEntry?.filesWritten || [],
      };
    });
    // Immediate, one-hop upstream producers — these are the nodes the selected
    // node can actually read input from, used by the "from which node" picker.
    const producers = [...new Set<string>(inMap.get(selectedNode.id) || [])]
      .map((pid) => {
        const pnode = nodes.find((n) => n.id === pid);
        const pdef = pnode ? catalog.nodes[pnode.data.def.type] : null;
        if (!pnode || !pdef) return null;
        const ple = runResult?.log.find((l) => l.nodeId === pid);
        return {
          nodeId: pid,
          label: pnode.data.label || pdef.name || pid,
          type: pnode.data.def.type,
          items: ple?.outputItems ?? null,
          sample: pdef.kind === "trigger" ? catalog.samples?.[pdef.type] ?? null : null,
          files: ple?.filesWritten || [],
        };
      })
      .filter((p): p is NonNullable<typeof p> => !!p);
    const selectedLog = runResult?.log.find((l) => l.nodeId === selectedNode.id);
    const selectedNodeDef = catalog.nodes[selectedNode.data.def.type];
    const output = {
      nodeId: selectedNode.id,
      label: selectedNode.data.label || selectedNodeDef?.name || selectedNode.id,
      type: selectedNode.data.def.type,
      items: selectedLog?.outputItems ?? null,
      sample: selectedNodeDef?.kind === "trigger" ? catalog.samples?.[selectedNodeDef.type] ?? null : null,
      files: selectedLog?.filesWritten || [],
    };
    // Files the selected node can pick by name: what every upstream node wrote
    // in the last run, else the name it will get — its "Save output as file"
    // setting or the automatic name the engine gives it (executor
    // defaultOutputFileName; the extension is a guess until it has run).
    const upstreamFiles: UpstreamFile[] = [];
    for (const pn of upstreamNodes) {
      const label = pn.data.label || catalog.nodes[pn.data.def.type]?.name || pn.id;
      const written = runResult?.log.find((l) => l.nodeId === pn.id)?.filesWritten || [];
      if (written.length) {
        for (const f of written) upstreamFiles.push({ name: f.name, nodeId: pn.id, nodeLabel: label, size: f.size, expected: false });
        continue;
      }
      const named = String((pn.data.config as Record<string, unknown> | undefined)?.outputFile || "").trim();
      upstreamFiles.push({ name: named || defaultOutputFileName(pn.id, label), nodeId: pn.id, nodeLabel: label, expected: true });
    }
    return { sources, fields, hasUpstream: sources.length > 0, upstream, producers, output, upstreamFiles };
  }, [selectedNode, edges, nodes, catalog, runResult]);

  // --- workflow meta --------------------------------------------------------
  const updateMeta = useCallback(
    (patch: Partial<Meta>) => {
      setMeta((m) => (m ? { ...m, ...patch } : m));
      if (loadedRef.current) {
        setDirty(true);
        scheduleAutoSave();
      }
    },
    [scheduleAutoSave]
  );

  // Reload the Execution menu's history list (newest first). The counter also
  // tells the Executions view that a new run was recorded.
  const refreshHistory = useCallback(() => {
    const id = meta?.id;
    if (!id) return;
    setHistoryKey((k) => k + 1);
    api.workflows
      .executions(id, 30)
      .then(setExecHistory)
      .catch(() => {});
  }, [meta?.id]);

  // Load one saved run into the Log console.
  const loadExecution = useCallback(
    async (execId: string) => {
      const id = meta?.id;
      if (!id) return;
      try {
        const entry = await api.workflows.execution(id, execId);
        setRunResult(entry.result);
        applyRunStatuses(entry.result, setNodes);
        setActiveExecutionId(execId);
      } catch (err) {
        show(`Could not load execution: ${(err as Error).message}`, "err");
      }
    },
    [meta?.id, show, setNodes]
  );

  // Keep the history in sync while the console is open.
  useEffect(() => {
    if (consoleOpen) refreshHistory();
  }, [consoleOpen, refreshHistory]);

  // Put a restored version back on the canvas. The server already saved it, so
  // the editor adopts it without being marked dirty.
  const onRestoredVersion = useCallback(
    (wf: Workflow) => {
      const rfNodes = toRfNodes(wf.nodes || [], catalog, removeNodeById, resizeSticky);
      const rfEdges = (wf.edges || []).map((e) => makeEdge(e));
      setNodes(rfNodes);
      setEdges(rfEdges);
      resetHistory(rfNodes, rfEdges);
      setMeta((m) => (m ? { ...m, name: wf.name || m.name, description: wf.description || "" } : m));
      setDirty(false);
      setRunResult(null);
      setApproval(null);
      setActiveExecutionId(null);
      refreshHistory();
    },
    [catalog, removeNodeById, setEdges, setNodes, refreshHistory, resetHistory]
  );

  const run = useCallback(async (replayPayload?: unknown, opts?: { step?: boolean }) => {
    let id = meta?.id;
    if (!id) return;
    setDebugRun(!!opts?.step);
    setPaused(null);
    // Enter the running state IMMEDIATELY — before autosave and before the run
    // request — so the workflow never executes while the UI still shows it as
    // idle. The toolbar Run button flips to a loading circle right away.
    const runToken = crypto.randomUUID();
    runTokenRef.current = runToken;
    setRunning(true);
    setStopping(false);
    setConsoleOpen(true);
    setWaiting(null);
    setRunningNodeId(null);
    setApproval(null);
    applyRunStatuses(null, setNodes); // clear stale node markers
    if (dirty) {
      const saved = await save();
      if (!saved) {
        setRunning(false);
        setStopping(false);
        runTokenRef.current = null;
        setRunningNodeId(null);
        return;
      }
      id = saved.id;
    }
    try {
      const res = await api.workflows.run(id, {
        maxItemsPerNode: getSettings().maxLogItems,
        runToken,
        // a replay re-sends the input the run on screen was started with
        payload: replayPayload,
        step: opts?.step,
      });
      if ("waiting" in res) {
        // Non-manual triggers wait for their real event instead of inventing
        // test data: an HTTP request (webhook/GitHub), a chat message, or a
        // payload the user pastes into the input panel. The Log console opens
        // and shows the matching panel.
        setWaiting(res);
      } else {
        // The previous execution's logs stay on screen until this new result
        // replaces them.
        setRunResult(res);
        applyRunStatuses(res, setNodes);
        setActiveExecutionId(null);
        setApproval(null);
        refreshHistory();
        if (res.loop) setLoopRun(res.loop);
        if (res.aborted) {
          show("Workflow stopped — the run halted after the current node.", "ok");
        }
      }
    } catch (err) {
      // Keep the previous logs; a failed run produced no result of its own.
      show(`Run failed: ${(err as Error).message}`, "err");
    } finally {
      setRunning(false);
      setStopping(false);
      runTokenRef.current = null;
      setRunningNodeId(null);
      setDebugRun(false);
      setPaused(null);
      // The run request is over — a request that was still pending can never be
      // answered now, so its buttons must go.
      setApproval(null);
    }
  }, [meta, dirty, save, show, setNodes, refreshHistory]);

  // Answer the approval the run is parked on. The server resolves the waiting
  // node and the run continues down Approved / Rejected.
  const answerApproval = useCallback(
    async (approved: boolean) => {
      const id = meta?.id;
      const token = runTokenRef.current;
      if (!id || !token || !approval) return;
      setAnsweringApproval(true);
      try {
        const res = await api.workflows.approval(id, token, approval.id, approved);
        show(res.message, res.ok ? "ok" : "err");
        if (res.ok) setApproval(null);
      } catch (err) {
        show(`Could not answer the approval: ${(err as Error).message}`, "err");
      } finally {
        setAnsweringApproval(false);
      }
    },
    [meta?.id, approval, show]
  );

  // Retry the run on screen from its failed node: that node runs again with
  // the input it had, then everything after it. Earlier nodes are not repeated.
  const retryFailed = useCallback(async () => {
    const id = meta?.id;
    const execId = runResult?.executionId;
    if (!id || !execId) return;
    setRunning(true);
    setConsoleOpen(true);
    try {
      const res = await api.workflows.retryExecution(id, execId, getSettings().maxLogItems);
      setRunResult(res);
      applyRunStatuses(res, setNodes);
      setActiveExecutionId(null);
      refreshHistory();
      show(res.success ? `Retried from “${res.retriedFrom?.nodeName}” — the run finished.` : `Retried from “${res.retriedFrom?.nodeName}” — it failed again.`, res.success ? "ok" : "err");
    } catch (err) {
      show(`Retry failed: ${(err as Error).message}`, "err");
    } finally {
      setRunning(false);
    }
  }, [meta?.id, runResult?.executionId, setNodes, refreshHistory, show]);

  // Replay the run on screen: run the workflow again with the same input.
  const replayRun = useCallback(() => {
    void run(runResult?.input);
  }, [run, runResult?.input]);

  // While a run waits for a webhook call (or a submitted payload), poll the
  // server until it fires and the executed result comes back (or the user
  // cancels / runs again). Chat runs are driven by the chat panel instead, so
  // they are never polled.
  useEffect(() => {
    if (!waiting || !meta?.id || waiting.awaiting === "chat" || !waiting.waitingId) return;
    const waitingId = waiting.waitingId;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await api.workflows.pollWaitingRun(meta.id, waitingId);
        if (cancelled) return;
        if (!("waiting" in res)) {
          clearInterval(timer);
          setWaiting(null);
          setRunResult(res);
          applyRunStatuses(res, setNodes);
          setActiveExecutionId(null);
          refreshHistory();
        }
      } catch (err) {
        clearInterval(timer);
        setWaiting(null);
        show(`Waiting for webhook failed: ${(err as Error).message}`, "err");
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [waiting, meta?.id, show, setNodes, refreshHistory]);

  const cancelWait = useCallback(() => {
    const id = meta?.id;
    const waitingId = waiting?.waitingId;
    setWaiting(null);
    if (id && waitingId) {
      api.workflows.cancelWaitingRun(id, waitingId).catch(() => {
        // The wait may have expired or completed between clicks; the UI is
        // already safely out of the waiting state.
      });
    }
  }, [meta?.id, waiting?.waitingId]);

  // Debug mode: run the node the run is paused before ("next"), or the rest of
  // the run without pausing ("continue").
  const stepRun = useCallback(
    async (action: "next" | "continue") => {
      const id = meta?.id;
      const token = runTokenRef.current;
      if (!id || !token) return;
      setPaused(null);
      try {
        const res = await api.workflows.step(id, token, action);
        if (!res.ok) show(res.message, "err");
      } catch (err) {
        show(`Could not continue the run: ${(err as Error).message}`, "err");
      }
    },
    [meta?.id, show]
  );

  // Item counts on the connections after a run: how many items each edge
  // carried, with the first item as a hover preview.
  const edgeRunInfo = useMemo<Record<string, EdgeRunInfo>>(() => {
    const out: Record<string, EdgeRunInfo> = {};
    const bySource = new Map((runResult?.log || []).map((l) => [l.nodeId, l]));
    for (const edge of edges) {
      const entry = bySource.get(edge.source);
      const count = entry?.handleCounts?.[edge.sourceHandle || "out"];
      if (typeof count === "number") out[edge.id] = { count, preview: entry?.outputItems?.[0] };
    }
    return out;
  }, [runResult, edges]);

  // Stop an active run. The server aborts the run's signal; the executor halts
  // at the next node boundary (the node in flight finishes first) and the
  // pending /run request resolves with an `aborted: true` result.
  const stopRun = useCallback(async () => {
    const id = meta?.id;
    const token = runTokenRef.current;
    if (!id || !token) return;
    setStopping(true);
    try {
      const res = await api.workflows.stopRun(id, token);
      if (!res.ok) show(res.message || "No active run to stop.", "err");
      else show("Stopping… the run halts after the current node.", "ok");
    } catch (err) {
      setStopping(false);
      show(`Could not stop the run: ${(err as Error).message}`, "err");
    }
  }, [meta?.id, show]);

  // End the shared session (owner only). The editor sends its CURRENT workflow
  // state in the same request, so everything that was still pending in the
  // browser is saved by the operation that removes all collaborators — nothing
  // is lost even if a save was throttled a moment before. From then on the
  // collaborators' access checks fail and they are thrown out of the workflow.
  const endSharing = useCallback(async () => {
    const current = metaRef.current;
    if (!current) return;
    if (
      !window.confirm(
        "End the shared session? The workflow is saved with your latest changes, then every collaborator loses access to it. Only you can open and edit it afterwards."
      )
    ) {
      return;
    }
    setEndingSharing(true);
    try {
      const payload = buildPayload();
      const res = await api.workflows.stopSharing(current.id, payload || {});
      setMeta((m) => (m ? { ...m, collaborators: res.collaborators || [], shared: false, sharedBy: undefined } : m));
      setDirty(false);
      setLastSavedAt(Date.now());
      show("Shared session ended — collaborators no longer have access.");
    } catch (err) {
      show(`Could not end the session: ${(err as Error).message}`, "err");
    } finally {
      setEndingSharing(false);
    }
  }, [buildPayload, show]);

  // While a collaborator has this shared workflow open, poll the server so the
  // moment the owner ends the shared session the collaborator is thrown out —
  // they must not keep editing a workflow they no longer have access to.
  useEffect(() => {
    if (!meta?.id || !meta.shared) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await api.workflows.access(meta.id);
        if (cancelled || res.accessible) return;
        setSessionEnded({ message: "The owner ended the shared session. This workflow is no longer shared with you, so you can no longer open or edit it." });
      } catch {
        /* transient — try again on the next tick */
      }
    };
    check();
    const t = setInterval(check, 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [meta?.id, meta?.shared]);

  // A loop keeps running on the server after the first pass (server/
  // loop-runner.js). While the loop setting is on, check its progress every 5 s
  // — only while this tab is visible, so a background tab costs nothing.
  const [loopRun, setLoopRun] = useState<LoopRunStatus | null>(null);
  useEffect(() => {
    if (!meta?.id || !meta.loop?.enabled) {
      setLoopRun(null);
      return;
    }
    let cancelled = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const s = await api.workflows.loopStatus(meta.id);
        if (!cancelled) setLoopRun(s);
      } catch {
        /* transient — keep the last state */
      }
    };
    check();
    const t = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [meta?.id, meta?.loop?.enabled]);

  const stopLoopRun = useCallback(async () => {
    if (!meta?.id) return;
    try {
      await api.workflows.stopLoop(meta.id);
      setLoopRun({ running: false });
      show("Loop stopped.", "ok");
    } catch (err) {
      show(`Could not stop the loop: ${(err as Error).message}`, "err");
    }
  }, [meta?.id, show]);

  // While a run is executing, poll the server for live per-node progress and
  // mark the node that is currently running (loading ring on the canvas). The
  // poll stops as soon as the run request resolves.
  useEffect(() => {
    const id = meta?.id;
    const token = runTokenRef.current;
    if (!running || !id || !token || waiting) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const st = await api.workflows.runStatus(id, token);
        if (cancelled) return;
        // A debug run parked before a node marks THAT node (it is next).
        setPaused(st.paused ?? null);
        setRunningNodeId(st.paused?.nodeId ?? (st.active && st.nodeId ? st.nodeId : null));
        // A run parked on a "Wait for Approval" node surfaces its request here.
        setApproval(st.approval ?? null);
      } catch {
        /* transient poll error — keep the current marker */
      }
    }, 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, waiting, meta?.id]);

  // Reflect the executing node on the canvas (keeps node objects untouched when
  // nothing changed so React Flow does not re-render them pointlessly).
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const isRunning = !!(running && !waiting && runningNodeId === n.id);
        return isRunning === !!n.data.isRunning ? n : { ...n, data: { ...n.data, isRunning } };
      })
    );
  }, [running, waiting, runningNodeId, setNodes]);

  // --- shared-editing presence ---------------------------------------------
  // Remember which node this user has open; the presence poll below reports it.
  useEffect(() => {
    const node = nodes.find((n) => n.id === selectedNodeId);
    editingNodeRef.current = { id: selectedNodeId, label: node?.data.label || "" };
  }, [selectedNodeId, nodes]);

  // While this workflow is shared, tell the server which node is being edited
  // (and receive everyone else's position) so each side sees a small marker on
  // the node the other person is working on. Leaving this editor, the TTL on the
  // server clears the marker by itself.
  useEffect(() => {
    const id = meta?.id;
    if (!id || !isSharedMode(meta)) {
      setSharedEditors([]);
      return;
    }
    let cancelled = false;
    const report = async () => {
      try {
        const res = await api.workflows.presence(id, editingNodeRef.current.id, editingNodeRef.current.label);
        if (!cancelled) setSharedEditors(res.editing || []);
      } catch {
        /* transient — the next tick tries again */
      }
    };
    report();
    const timer = setInterval(report, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [meta?.id, meta?.shared, meta?.folderShared, meta?.collaborators?.length, selectedNodeId]);

  // Draw the other editors' markers on their nodes (only when a node's editor
  // list actually changed, so React Flow does not re-render the canvas).
  useEffect(() => {
    const byNode = new Map<string, SharedEditor[]>();
    for (const editor of sharedEditors) {
      if (!editor.nodeId) continue;
      const list = byNode.get(editor.nodeId) || [];
      list.push(editor);
      byNode.set(editor.nodeId, list);
    }
    setNodes((nds) =>
      nds.map((n) => {
        const editors = byNode.get(n.id) || [];
        const sig = editors.map((e) => e.userId).join(",");
        if ((n.data.presenceSig as string) === sig) return n;
        return { ...n, data: { ...n.data, presence: editors, presenceSig: sig } };
      })
    );
  }, [sharedEditors, setNodes]);

  // --- manual stepping: "Run next node" ------------------------------------
  // When a node is halted (it errored) and the user sets its manual output,
  // running the next node executes the node(s) directly downstream of it using
  // that manual output as their input — the halted node itself is skipped.
  const runNextNode = useCallback(async () => {
    const workflowId = meta?.id;
    if (!workflowId || !selectedNode) return;
    const node = nodes.find((n) => n.id === selectedNode.id);
    if (!node) return;
    const cfg: Record<string, unknown> = (node.data.config || {}) as Record<string, unknown>;
    if (!cfg.manualOutput) {
      show("Enable Manual output on this node first to run the next node.", "err");
      return;
    }
    const raw = String(cfg.manualOutputJson ?? "").trim();
    if (!raw) {
      show("Set the manual output JSON first.", "err");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      show("Manual output JSON is invalid.", "err");
      return;
    }
    const targets = edges.filter((e) => e.source === selectedNode.id);
    if (!targets.length) {
      show("This node has no downstream node to run.", "err");
      return;
    }
    setRunning(true);
    setConsoleOpen(true);
    try {
      const target = targets[0];
      const res = await api.workflows.runNode(workflowId, target.target, parsed);
      // Merge this step's log entry into the prior run so the user sees the
      // full chain; then refresh the canvas markers from the combined result.
      setRunResult((prev) => (prev && prev.log ? { ...prev, log: [...prev.log, ...(res.log || [])] } : (res as ExecResult)));
      const merged = runResult && runResult.log ? { ...runResult, log: [...runResult.log, ...(res.log || [])] } : (res as ExecResult);
      applyRunStatuses(merged, setNodes);
    } catch (err) {
      show(`Run next node failed: ${(err as Error).message}`, "err");
    } finally {
      setRunning(false);
    }
  }, [meta, selectedNode, nodes, edges, show, runResult, setNodes]);

  // label of the immediate downstream node of the selected node (for the
  // "Run next node" button)
  const selectedNextLabel = (() => {
    if (!selectedNode) return undefined;
    const t = edges.find((e) => e.source === selectedNode.id);
    if (!t) return undefined;
    const tn = nodes.find((n) => n.id === t.target);
    if (!tn) return undefined;
    return tn.data.label || catalog.nodes[tn.data.def.type]?.name || tn.id;
  })();

  // --- export / import ------------------------------------------------------
  const exportJson = useCallback(() => {
    const payload = buildPayload();
    if (!payload) return;
    // Never ship credentials or personal values (recipients, chat IDs, logins
    // — shared/privacy.js) in an exported workflow file: anyone who imports it
    // enters their own. The saved copy keeps them.
    const clean = stripPrivateFromWorkflow(stripSecretsFromWorkflow(payload));
    // "$schema" lets VS Code and other editors check the file against the
    // catalog (served by the server, see shared/workflow-schema.js).
    const withSchema = { $schema: `${window.location.origin}/schema/workflow.schema.json`, ...clean };
    const blob = new Blob([JSON.stringify(withSchema, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clean.name.replace(/\s+/g, "-").toLowerCase() || "workflow"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    show("Exported without credentials and personal values — saved copy keeps them");
  }, [buildPayload, show]);

  const importJson = useCallback(
    (text: string) => {
      try {
        const wf = JSON.parse(text) as Workflow;
        if (!Array.isArray(wf.nodes)) throw new Error("no nodes");
        setNodes(toRfNodes(wf.nodes, catalog, removeNodeById, resizeSticky));
        setEdges((wf.edges || []).map((e) => makeEdge(e)));
        if (wf.name) updateMeta({ name: wf.name, description: wf.description || meta?.description || "" });
        markDirty();
        show("Workflow imported from JSON");
      } catch {
        show("Import failed: invalid workflow JSON", "err");
      }
    },
    [catalog, setNodes, setEdges, updateMeta, markDirty, show, meta, makeEdge, removeNodeById]
  );

  // --- merging an imported workflow into the canvas --------------------------
  // Importing a workflow file into a canvas that ALREADY has nodes does not
  // throw the current workflow away: the import is merged in — every node on the
  // canvas stays exactly as it is, and the imported nodes (with their own
  // settings and connections) are placed next to them. This is automatic; the
  // only case that replaces the graph is an empty canvas, where there is
  // nothing to lose.
  const mergeJson = useCallback(
    (text: string) => {
      let incoming: Workflow;
      try {
        incoming = JSON.parse(text) as Workflow;
        if (!Array.isArray(incoming?.nodes) || !incoming.nodes.length) throw new Error("no nodes");
      } catch {
        show("Import failed: invalid workflow JSON", "err");
        return;
      }
      try {
        const merged = mergeWorkflows({ nodes: toFlowNodes(nodes), edges: toFlowEdges(edges) }, incoming);
        setNodes((nds) => [...nds, ...toRfNodes(merged.nodes, catalog, removeNodeById, resizeSticky)]);
        setEdges((eds) => [...eds, ...merged.edges.map((e) => makeEdge(e))]);
        markDirty();
        show(`Merged ${merged.stats.nodes} node(s) and ${merged.stats.edges} connection(s) from "${incoming.name || "workflow"}"`);
        setTimeout(() => fitView({ padding: 0.25, duration: 300 }), 80);
      } catch (err) {
        show(String((err as Error).message || "Import failed: invalid workflow JSON"), "err");
      }
    },
    [nodes, edges, catalog, setNodes, setEdges, markDirty, show, makeEdge, removeNodeById, fitView]
  );

  // What a dropped / picked JSON file does, decided by the canvas: with nodes on
  // it the file is merged in, on an empty canvas it becomes the workflow.
  const importOrMergeJson = useCallback(
    (text: string) => {
      if (nodes.length) mergeJson(text);
      else importJson(text);
    },
    [nodes.length, mergeJson, importJson]
  );

  // keep the ref used by the canvas drop handler pointing at the latest handler
  useEffect(() => {
    importFileRef.current = importOrMergeJson;
    mergeJsonRef.current = importOrMergeJson;
  }, [importOrMergeJson]);

  // hidden file input behind the toolbar Import button (the canvas drop handler
  // covers drag-and-drop of JSON files onto the canvas)
  const importInputRef = useRef<HTMLInputElement>(null);
  const onImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      file
        .text()
        .then((text) => {
          importOrMergeJson(text);
          e.target.value = "";
        })
        .catch(() => {});
    },
    [importOrMergeJson]
  );

  // --- shortcuts ------------------------------------------------------------
  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) undo and redo canvas edits. While the
  // user is typing in a field the browser's own text undo wins, so editing a
  // node's config never rewrites the graph underneath them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (mod && key === "s") {
        e.preventDefault();
        save({ manual: true });
      } else if (mod && key === "z" && !e.shiftKey) {
        if (typing) return; // let the field undo its own text
        e.preventDefault();
        undo();
      } else if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
        if (typing) return;
        e.preventDefault();
        redo();
      } else if (mod && key === "c" && !typing && !window.getSelection()?.toString()) {
        // Copy the selected nodes (and the connections between them) as
        // workflow JSON — paste it into another workflow, a file or a chat.
        const payload = buildPayloadRef.current();
        const picked = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
        if (!payload || !picked.size) return;
        e.preventDefault();
        const clip = {
          nodes: payload.nodes.filter((n) => picked.has(n.id)),
          edges: (payload.edges || []).filter((ed) => picked.has(ed.source) && picked.has(ed.target)),
        };
        navigator.clipboard
          ?.writeText(JSON.stringify(clip, null, 2))
          .then(() => show(`Copied ${clip.nodes.length} node${clip.nodes.length === 1 ? "" : "s"} as JSON`))
          .catch(() => show("Copy failed — the browser blocked the clipboard", "err"));
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpShortcuts((v) => !v);
      } else if (mod && key === "h") {
        e.preventDefault();
        onOpenHelp?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, onOpenHelp, undo, redo, show]);

  // Ctrl/Cmd+V on the canvas: workflow JSON, a node array or one node object
  // becomes new nodes next to the graph. The browser's paste event carries the
  // text without a clipboard permission prompt; plain text is ignored.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (readOnlyRef.current) return;
      const clip = pastedWorkflow(e.clipboardData?.getData("text") || "");
      if (!clip) return;
      e.preventDefault();
      mergeJsonRef.current(JSON.stringify({ name: "the clipboard", ...clip }));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // True when the workflow uses chat nodes — the Log console then offers a Chat
  // tab and the chat is mirrored into the Execution tab.
  const hasChat = useMemo(
    () => nodes.some((n) => n.data.def.type === "chatTrigger" || n.data.def.type === "chatOutput"),
    [nodes]
  );

  // Pull the assistant's reply out of a chat run: the last Chat Output node's
  // output wins; otherwise fall back to the last node's text. Returns a null
  // marker (the caller renders a friendly placeholder) when nothing was said.
  const extractChatReply = useCallback((res: ExecResult): string => {
    for (let i = res.log.length - 1; i >= 0; i--) {
      const entry = res.log[i];
      if (entry.nodeType !== "chatOutput") continue;
      const item = entry.outputItems[entry.outputItems.length - 1] as Record<string, unknown> | undefined;
      if (!item) continue;
      const text = item.text ?? item.message;
      if (text !== undefined && text !== null && String(text).trim() !== "") return String(text);
    }
    // No Chat Output node — surface the run's outcome instead of staying silent.
    const failed = res.log.filter((l) => l.status === "error");
    if (failed.length) {
      const e = failed[failed.length - 1];
      return `⚠ ${e.nodeName} failed: ${e.error || "unknown error"}`;
    }
    return "(no Chat Output node produced a reply — add a Chat Output node to answer in the chat)";
  }, []);

  // Send a chat message: appends the user's turn immediately, runs the workflow
  // once through /chat, then appends the assistant's reply from the Chat Output
  // node. Supports the Stop button (a runToken is sent for live progress).
  const sendChat = useCallback(
    async (text: string) => {
      const id = meta?.id;
      if (!id || !text.trim() || sendingChat) return;
      const history: ChatMessage[] = chatMessages.map((m) => ({ role: m.role, text: m.text }));
      setChatMessages((prev) => [...prev, { role: "user", text, at: new Date().toISOString() }]);
      const runToken = crypto.randomUUID();
      runTokenRef.current = runToken;
      setSendingChat(true);
      setRunning(true);
      setStopping(false);
      setWaiting(null);
      setRunningNodeId(null);
      try {
        const res = await api.workflows.chat(id, text, history, runToken);
        setRunResult(res);
        applyRunStatuses(res, setNodes);
        setActiveExecutionId(null);
        refreshHistory();
        setChatMessages((prev) => [...prev, { role: "assistant", text: extractChatReply(res), at: new Date().toISOString() }]);
      } catch (err) {
        setChatMessages((prev) => [...prev, { role: "assistant", text: `⚠ ${(err as Error).message}`, at: new Date().toISOString() }]);
      } finally {
        setSendingChat(false);
        setRunning(false);
        setStopping(false);
        runTokenRef.current = null;
        setRunningNodeId(null);
      }
    },
    [meta?.id, chatMessages, sendingChat, extractChatReply, setNodes, refreshHistory]
  );

  // Submit the payload a waiting (non-manual, non-inbound) trigger asked for.
  // The server claims the wait and runs the workflow with this payload.
  const submitRunInput = useCallback(
    async (payload: unknown): Promise<boolean> => {
      const id = meta?.id;
      const waitingId = waiting?.waitingId;
      if (!id || !waitingId) return false;
      setRunning(true);
      try {
        const res = await api.workflows.submitRunInput(id, waitingId, payload);
        setWaiting(null);
        setRunResult(res);
        applyRunStatuses(res, setNodes);
        setActiveExecutionId(null);
        refreshHistory();
        return true;
      } catch (err) {
        setWaiting(null);
        show(`Could not submit input: ${(err as Error).message}`, "err");
        return false;
      } finally {
        setRunning(false);
      }
    },
    [meta?.id, waiting?.waitingId, show, setNodes, refreshHistory]
  );

  const clampConsoleH = useCallback(
    (h: number) => Math.min(Math.max(h, 140), (canvasRef.current?.clientHeight ?? 600) - 120),
    []
  );
  const clampConsoleW = useCallback((w: number) => Math.min(Math.max(w, 320), canvasRef.current?.clientWidth ?? 900), []);

  // Shared mode: the workflow has collaborators (owner view) or was shared with
  // this account (collaborator view). The toolbar badge shows WHO is involved
  // and lets the owner end the session at any time.
  const sharedMode = isSharedMode(meta);
  const sharedWithLabel = meta?.shared
    ? meta.sharedBy?.name || meta.sharedBy?.email || "another user"
    : meta?.collaborators?.map((c) => c.name || c.email).join(", ") || meta?.folderSharedWith || "another user";

  // --- manual save budget ---------------------------------------------------
  // On a shared workflow every user has ONE manual save per minute, on top of
  // the auto-save. saveBudgetTick re-evaluates this once a second, so the
  // toolbar shows a live countdown once the budget is spent.
  const manualSaveMsLeft = useMemo(() => {
    void saveBudgetTick; // recomputed once a second while a shared workflow is open
    const now = Date.now();
    const times = manualSaveTimesRef.current.filter((t) => now - t < SAVE_WINDOW_MS);
    if (times.length < SAVE_MAX_PER_MINUTE) return 0;
    return Math.max(0, SAVE_WINDOW_MS - (now - Math.min(...times)));
  }, [saveBudgetTick]);
  const manualSavesLeft = manualSaveMsLeft > 0 ? 0 : SAVE_MAX_PER_MINUTE;

  // Enabled state of the undo / redo buttons — recomputed whenever a history
  // entry is committed or consumed (historyVersion).
  const { canUndo, canRedo } = useMemo(
    () => ({ canUndo: historyRef.current.undo.length > 0, canRedo: historyRef.current.redo.length > 0 }),
    [historyVersion]
  );

  // Folder path from the workspace root to this workflow's folder — each entry
  // is a clickable part of the breadcrumb at the top of the editor.
  const folderTrail = useMemo(() => {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const trail: WorkflowFolder[] = [];
    let cursor = meta?.folderId ? byId.get(meta.folderId) : undefined;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      trail.unshift(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return trail;
  }, [folders, meta?.folderId]);

  const hasWebhook = useMemo(() => nodes.some((n) => n.data.def.type === "webhook"), [nodes]);
  // The webhook URL uses the workflow's custom slug when one is set — the user
  // can change it on the Webhook trigger node and /webhook/<slug> still works.
  const webhookUrl = hasWebhook && meta ? `${window.location.origin}/webhook/${meta.webhookSlug || meta.id}` : null;
  const triggerLabels = useMemo(
    () => nodes.filter((n) => catalog.nodes[n.data.def.type]?.kind === "trigger").map((n) => n.data.label),
    [nodes, catalog]
  );

  const copyWebhook = () => {
    if (!webhookUrl) return;
    navigator.clipboard?.writeText(webhookUrl).then(() => show("Webhook URL copied"));
  };

  // --- raw JSON editing -----------------------------------------------------
  // "Edit workflow JSON" lives at the bottom of the node palette. Opening it
  // snapshots the current workflow; applying it replaces the canvas graph.
  const openJsonEditor = useCallback(
    (nodeId?: string) => {
      const payload = buildPayload();
      if (!payload) return;
      const node = nodeId ? payload.nodes.find((n) => n.id === nodeId) : null;
      if (nodeId && !node) return;
      setJsonDraft(JSON.stringify(node || payload, null, 2));
      setJsonNodeId(node ? node.id : null);
      setJsonError(null);
      setJsonIssues({ errors: 0, warnings: 0 });
      setJsonOpen(true);
    },
    [buildPayload]
  );

  const applyJson = useCallback(() => {
    try {
      let wf: Workflow;
      if (jsonNodeId) {
        // One node: swap it into the current graph, identity unchanged.
        const node = JSON.parse(jsonDraft) as FlowNode;
        if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("a node must be a JSON object");
        if (node.id !== jsonNodeId) throw new Error(`id must stay "${jsonNodeId}" — connections point at it`);
        if (!catalog.nodes[node.type]) throw new Error(`unknown node type "${node.type}"`);
        const payload = buildPayload();
        if (!payload) return;
        wf = { ...payload, nodes: payload.nodes.map((n) => (n.id === jsonNodeId ? node : n)) };
      } else {
        wf = JSON.parse(jsonDraft) as Workflow;
        if (!Array.isArray(wf.nodes)) throw new Error("no nodes");
        if (!wf.id || wf.id !== meta?.id) throw new Error("id must match this workflow");
      }
      if (jsonIssues.errors && !window.confirm(`The checker still reports ${jsonIssues.errors} error(s) (underlined in red). Apply anyway?`)) return;
      setNodes(toRfNodes(wf.nodes, catalog, removeNodeById, resizeSticky));
      setEdges((wf.edges || []).map((e) => makeEdge(e)));
      if (!jsonNodeId && wf.name) updateMeta({ name: wf.name, description: wf.description || meta?.description || "", webhookSlug: wf.webhookSlug, folderId: wf.folderId });
      setJsonOpen(false);
      setJsonError(null);
      markDirty();
      show(jsonNodeId ? "Node JSON applied" : "Workflow JSON applied");
    } catch (err) {
      setJsonError(String((err as Error).message || err));
    }
  }, [jsonDraft, jsonNodeId, jsonIssues.errors, meta, catalog, buildPayload, setNodes, setEdges, updateMeta, markDirty, show, makeEdge, removeNodeById]);

  // The AI builder hands back a COMPLETE workflow as JSON — import it onto the
  // canvas (replacing the graph, like importing a file) and keep this
  // workflow's identity, so the agent edits the workflow the user is working on
  // instead of creating a new one.
  const applyAgentWorkflow = useCallback(
    (wf: Workflow) => {
      if (!wf || !Array.isArray(wf.nodes)) return;
      const current = metaRef.current;
      setNodes(toRfNodes(wf.nodes, catalog, removeNodeById, resizeSticky));
      setEdges((wf.edges || []).map((e) => makeEdge(e)));
      updateMeta({
        name: wf.name || current?.name || "Workflow",
        description: wf.description ?? current?.description ?? "",
        folderId: wf.folderId ?? current?.folderId,
      });
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setView("workspace");
      markDirty();
      setTimeout(() => fitView({ padding: 0.25, duration: 300 }), 80);
    },
    [catalog, setNodes, setEdges, updateMeta, markDirty, makeEdge, removeNodeById, fitView]
  );

  // Open one saved run from the Executions view: back to the canvas with that
  // run loaded into the Log console.
  const openRunInWorkspace = useCallback(
    (execId: string) => {
      setView("workspace");
      setConsoleOpen(true);
      loadExecution(execId);
    },
    [loadExecution]
  );

  if (sessionEnded) {
    return (
      <div className="boot">
        <div className="boot-line">✗ Shared session ended</div>
        <div className="boot-line dim">{sessionEnded.message}</div>
        <button className="btn btn-sm" onClick={onBack} style={{ marginTop: 16 }}>
          ← Back to workflows
        </button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="boot">
        <div className="boot-line">✗ Workflow not found</div>
        <div className="boot-line dim">{loadError}</div>
        <button className="btn btn-sm" onClick={onBack} style={{ marginTop: 16 }}>
          ← Back to workflows
        </button>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="boot">
        <div className="run-loading">
          <span className="spinner" /> LOADING WORKFLOW…
        </div>
      </div>
    );
  }

  const edgeInfo = selectedEdge
    ? {
        source: nodes.find((n) => n.id === selectedEdge.source)?.data.label || selectedEdge.source,
        target: nodes.find((n) => n.id === selectedEdge.target)?.data.label || selectedEdge.target,
        onDelete: deleteSelected,
      }
    : null;

  return (
    <div className="editor">
      {/* toolbar */}
      <div className="ed-toolbar">          <button className="btn btn-sm btn-ghost" onClick={onBack} title="Back to workflows">
            <ArrowLeft size={13} />
          </button>

        <div className="ed-name">
          {/* Clickable breadcrumb: every part of the path opens that folder on
              the dashboard, so you always land where you clicked. */}
          <span className="ed-path ed-crumbs">
            <button className="ed-crumb" onClick={() => onOpenFolder?.()} title="All workflows">
              Workflows
            </button>
            {folderTrail.map((folder) => (
              <span key={folder.id} className="ed-crumb-seg">
                <span className="ed-crumb-sep">/</span>
                <button className="ed-crumb" onClick={() => onOpenFolder?.(folder.id)} title={`Open folder “${folder.name}”`}>
                  {folder.name}
                </button>
              </span>
            ))}
            <span className="ed-crumb-sep">/</span>
          </span>
          <input value={meta.name} onChange={(e) => updateMeta({ name: e.target.value })} />
          {readOnly ? null : dirty ? (
            <span className="ed-dirty">● Unsaved · auto-saves</span>
          ) : lastSavedAt ? (
            <span className="ed-saved">✓ Saved {new Date(lastSavedAt).toLocaleTimeString()}</span>
          ) : null}
          {sharedMode && !readOnly && (
            <span
              className={`ed-save-budget ${manualSavesLeft > 0 ? "ok" : "empty"}`}
              title={
                manualSavesLeft > 0
                  ? "Manual save budget — on a shared workflow you have 1 manual save per minute"
                  : `No manual saves left. The next manual save is available in ${Math.ceil(manualSaveMsLeft / 1000)} s. Auto-save still saves your changes.`
              }
            >
              <Save size={11} />
              {manualSavesLeft > 0 ? "Manual save ready" : `No manual saves left · ${Math.ceil(manualSaveMsLeft / 1000)}s`}
            </span>
          )}
          {sharedMode && (
            <div
              className={`ed-shared ${meta?.shared ? "viewer" : "owner"}`}
              title={
                meta?.shared
                  ? `Shared with you by ${sharedWithLabel}${meta.sharedViaFolder ? " through a shared folder" : ""}`
                  : meta?.folderShared
                    ? `The folder “${folderTrail[folderTrail.length - 1]?.name || "this folder"}” is shared with ${sharedWithLabel} — every workflow inside it, this one included`
                    : `You are sharing this workflow with ${sharedWithLabel}`
              }
            >
              <Users size={12} />
              <span>
                {meta?.shared
                  ? `SHARED BY ${sharedWithLabel.toUpperCase()}${meta.sharedViaFolder ? " · FOLDER" : ""}`
                  : meta?.folderShared && (meta.collaborators?.length || 0) === 0
                    ? `SHARED FOLDER WITH ${sharedWithLabel.toUpperCase()}`
                    : `SHARED WITH ${sharedWithLabel.toUpperCase()}`}
              </span>
              {!meta?.shared && (
                <button
                  className="btn btn-sm btn-danger ed-shared-stop"
                  onClick={endSharing}
                  disabled={endingSharing}
                  title="End the shared session — saves the workflow with your latest changes and removes every collaborator"
                >
                  {endingSharing ? "Ending…" : "End session"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Workspace ↔ Executions: work on the canvas, or study how this
            workflow actually ran, without leaving the editor. */}
        <div className="ed-view-switch" role="tablist" aria-label="Editor view">
          <button
            role="tab"
            aria-selected={view === "workspace"}
            className={`ed-view-btn ${view === "workspace" ? "active" : ""}`}
            onClick={() => setView("workspace")}
            title="The node canvas"
          >
            <LayoutGrid size={12} /> Workspace
          </button>
          <button
            role="tab"
            aria-selected={view === "executions"}
            className={`ed-view-btn ${view === "executions" ? "active" : ""}`}
            onClick={() => setView("executions")}
            title="Every recorded run of this workflow"
          >
            <Gauge size={12} /> Executions
            {execHistory.length > 0 && <span className="ed-view-count">{execHistory.length}</span>}
          </button>
        </div>

        {webhookUrl && (
          <div
            className={`ed-webhook ${waiting ? "armed" : "idle"}`}
            title={
              waiting
                ? "Listening — the first request to this URL fires the run, then it turns off until you press Run again (click to copy)"
                : "Not listening — press Run to arm this URL for exactly one request (click to copy)"
            }
          >
            <Webhook size={12} />
            <code>{webhookUrl}</code>
            <span className={`ed-webhook-state ${waiting ? "on" : "off"}`}>
              {waiting ? "● LISTENING" : "○ OFF · PRESS RUN"}
            </span>
            <span className="copy" onClick={copyWebhook} title="Copy webhook URL">
              <Copy size={12} />
            </span>
          </div>
        )}

        <div className="ed-actions">
          {/* Help: keyboard shortcuts and the user guide share one menu instead
              of two side-by-side buttons. */}
          <div className="ed-menu-wrap">
            <button
              className={`btn btn-sm ${helpShortcuts ? "btn-active" : ""}`}
              onClick={() => setHelpMenuOpen((o) => !o)}
              title="Help — keyboard shortcuts and the user guide"
            >
              <CircleHelp size={13} /> Help
            </button>
            {helpMenuOpen && (
              <div className="ed-menu" onMouseLeave={() => setHelpMenuOpen(false)}>
                <button
                  className="ed-menu-item"
                  onClick={() => {
                    setHelpMenuOpen(false);
                    setHelpShortcuts(true);
                  }}
                >
                  <CircleHelp size={13} /> Keyboard shortcuts
                </button>
                <button
                  className="ed-menu-item"
                  onClick={() => {
                    setHelpMenuOpen(false);
                    onOpenHelp?.();
                  }}
                >
                  <BookOpen size={13} /> Documentation (Ctrl/Cmd+H)
                </button>
              </div>
            )}
          </div>

          <button className="btn btn-sm" onClick={() => setShareOpen(true)} title="Publish to the community or share with another user">
            <Share2 size={13} /> Share
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={onImportFile}
          />
          <span className="ed-sep" aria-hidden="true" />
          <button className="btn btn-sm" onClick={undo} disabled={!canUndo} title="Undo the last canvas edit (Ctrl/Cmd+Z)" aria-label="Undo">
            <Undo2 size={13} />
          </button>
          <button className="btn btn-sm" onClick={redo} disabled={!canRedo} title="Redo the edit you just undid (Ctrl/Cmd+Y)" aria-label="Redo">
            <Redo2 size={13} />
          </button>
          <button
            className={`btn btn-sm ${consoleOpen ? "btn-active" : ""}`}
            onClick={() => setConsoleOpen((o) => !o)}
            title="Toggle execution log"
          >
            <Terminal size={13} /> Log
          </button>

          {/* Occasional/advanced actions live in one overflow menu so the bar
              stays short: versions, backups, tests, import/export, settings. */}
          <div className="ed-menu-wrap">
            <button
              className={`btn btn-sm ${moreMenuOpen ? "btn-active" : ""}`}
              onClick={() => setMoreMenuOpen((o) => !o)}
              title="More actions"
              aria-label="More actions"
            >
              <MoreHorizontal size={13} /> More
            </button>
            {moreMenuOpen && (
              <div className="ed-menu ed-menu-right" onMouseLeave={() => setMoreMenuOpen(false)}>
                <button
                  className="ed-menu-item"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setVersionsOpen(true);
                  }}
                >
                  <History size={13} /> Version history
                </button>
                {sharedMode && (
                  <button
                    className="ed-menu-item"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setBackupsOpen(true);
                    }}
                  >
                    <RotateCcw size={13} /> Backup &amp; rewind
                  </button>
                )}
                <button
                  className="ed-menu-item"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setEvalOpen(true);
                  }}
                >
                  <FlaskConical size={13} /> Evaluate (tests)
                </button>
                <button
                  className="ed-menu-item"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    exportJson();
                  }}
                >
                  <Download size={13} /> Export JSON
                </button>
                <button
                  className="ed-menu-item"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    importInputRef.current?.click();
                  }}
                >
                  <Upload size={13} /> Import JSON
                </button>
                <button
                  className="ed-menu-item"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                >
                  <Settings size={13} /> Workflow settings
                </button>
              </div>
            )}
          </div>
          <span className="ed-sep" aria-hidden="true" />
          {readOnly ? (
            <span className="role-badge" title={canRun ? "You can open and run this workflow, not change it — ask its owner for edit access." : "You can open this workflow, not run or change it — ask its owner for more access."}>
              <Eye size={12} /> {canRun ? "View & run" : "View only"}
            </span>
          ) : (
          <button
            className={`btn btn-sm ${sharedMode && manualSavesLeft === 0 ? "btn-warn" : ""}`}
            onClick={() => save({ manual: true })}
            disabled={saving || !dirty || (sharedMode && manualSavesLeft === 0)}
            title={
              sharedMode
                ? manualSavesLeft > 0
                  ? "Save now — on a shared workflow you have 1 manual save per minute"
                  : `No manual saves left (next one in ${Math.ceil(manualSaveMsLeft / 1000)} s). Auto-save keeps saving your changes.`
                : "Save now (Ctrl/Cmd+S)"
            }
          >
            <Save size={13} /> {saving ? "Saving…" : !sharedMode ? "Save" : manualSavesLeft > 0 ? "Save (1)" : "No manual saves"}
          </button>
          )}
          {meta.environment === "test" && (
            <span className="env-badge" title="Test environment: Variables use their test values and orders / transfers never execute (Workflow settings)">
              TEST
            </span>
          )}
          {meta && (
            <AiCostButton
              workflowId={meta.id}
              workflowName={meta.name}
              hasAiNodes={nodes.some((n) => catalog.nodes[n.data.def.type]?.kind === "ai")}
            />
          )}
          {running && debugRun && (
            <>
              <button className="btn btn-sm" onClick={() => stepRun("next")} disabled={!paused} title="Run the next node, then pause again">
                <StepForward size={13} /> Next node
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => stepRun("continue")} disabled={!paused} title="Run the rest without pausing">
                <FastForward size={13} /> Continue
              </button>
            </>
          )}
          {running || waiting ? (
            waiting ? (
              <button className="btn btn-sm btn-primary" onClick={cancelWait} title="Cancel the wait — the workflow will not execute until a request hits the webhook URL">
                <span className="spinner run-btn-spinner" /> Waiting…
              </button>
            ) : (
              <button className="btn btn-sm btn-danger" onClick={stopRun} disabled={stopping} title="Stop the run after the current node finishes">
                <span className="spinner run-btn-spinner" /> {stopping ? "Stopping…" : "Stop"}
              </button>
            )
          ) : (
            canRun && (
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => run(undefined, { step: true })} title="Debug: pause before every node so you can check its input, then run it with Next node">
                <Bug size={13} /> Debug
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => run()}>
                <Play size={13} /> Run
              </button>
            </>
            )
          )}
        </div>
      </div>

      {helpShortcuts && (
        <div className="help-popover" onClick={() => setHelpShortcuts(false)}>
          <div className="help-panel" onClick={(e) => e.stopPropagation()}>
            <div className="help-panel-title">Keyboard shortcuts</div>
            <div className="help-row"><kbd>Ctrl/Cmd + S</kbd><span>Save workflow</span></div>
            <div className="help-row"><kbd>Ctrl/Cmd + Z</kbd><span>Undo the last canvas edit</span></div>
            <div className="help-row"><kbd>Ctrl/Cmd + Y</kbd><span>Redo (Ctrl/Cmd + Shift + Z also works)</span></div>
            <div className="help-row"><kbd>Ctrl/Cmd + C</kbd><span>Copy the selected nodes as JSON</span></div>
            <div className="help-row"><kbd>Ctrl/Cmd + V</kbd><span>Paste workflow or node JSON as new nodes</span></div>
            <div className="help-row"><kbd>?</kbd><span>Toggle this help</span></div>
            <div className="help-row"><kbd>Ctrl/Cmd + H</kbd><span>Open the User Guide</span></div>
            <div className="help-row"><kbd>Delete</kbd><span>Delete selected node / edge</span></div>
          </div>
        </div>
      )}

      {/* palette (left) + canvas — or this workflow's execution history */}
      <div className="editor-body">
      {view === "executions" ? (
        <WorkflowExecutions workflowId={meta.id} refreshKey={historyKey} onOpenRun={openRunInWorkspace} />
      ) : (
      <>
      {!readOnly && <Palette catalog={catalog} onAdd={addNode} mobileOpen={paletteOpen} collapsed={!paletteOpen} onEditJson={() => openJsonEditor()} />}
      <div
        className="canvas"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as unknown as globalThis.Node)) setFileDragOver(false);
        }}
        ref={canvasRef}
      >
        {fileDragOver && (
          <div className="drop-import-overlay">
            <div className="drop-import-box">
              {nodes.length ? "Drop to merge workflow" : "Drop to import workflow"}
              <small>{nodes.length ? "the current workflow stays — the imported nodes land next to it" : "the file becomes this workflow"}</small>
            </div>
          </div>
        )}
        {/* Square side-menu buttons: the first toggles the node palette, the one
            under it opens the sticky-notes menu. */}
        <div className="canvas-side-buttons">
          <button
            className={`canvas-sq ${paletteOpen ? "active" : ""}`}
            onClick={() => setPaletteOpen((open) => !open)}
            title={paletteOpen ? "Hide the node menu" : "Show the node menu"}
            aria-label="Toggle node menu"
            aria-pressed={paletteOpen}
          >
            <PanelLeft size={15} />
          </button>
          <button
            className={`canvas-sq ${minimapOpen ? "active" : ""}`}
            onClick={() => setMinimapOpen((open) => !open)}
            title={minimapOpen ? "Hide the workflow overview map" : "Show the workflow overview map"}
            aria-label="Toggle workflow overview map"
            aria-pressed={minimapOpen}
          >
            <MapIcon size={15} />
          </button>
          <button
            className={`canvas-sq ${stickyMenuOpen ? "active" : ""}`}
            onClick={() => setStickyMenuOpen((open) => !open)}
            title="Sticky notes — organise the canvas"
            aria-label="Toggle sticky notes menu"
            aria-pressed={stickyMenuOpen}
          >
            <StickyNote size={15} />
          </button>
          {stickyMenuOpen && (
            <StickyNotesMenu
              notes={stickyNotes}
              activeId={activeStickyId}
              onAdd={addSticky}
              onSelect={focusSticky}
              onUpdate={(id, text) => updateSticky(id, { content: text })}
              onColor={(id, color) => updateSticky(id, { color })}
              onSize={(id, size) => updateSticky(id, size)}
              onDelete={deleteSticky}
              onClose={() => setStickyMenuOpen(false)}
            />
          )}
        </div>

        {paused && (
          <div className="debug-banner" role="status">
            <div>
              <b>Paused before “{nodes.find((n) => n.id === paused.nodeId)?.data.label || paused.nodeId}”</b>
              <span> · {paused.input.length} input item{paused.input.length === 1 ? "" : "s"}</span>
            </div>
            {paused.input.length > 0 && <pre className="debug-preview">{JSON.stringify(paused.input[0], null, 2).slice(0, 1200)}</pre>}
            <div className="debug-actions">
              <button className="btn btn-sm btn-primary" onClick={() => stepRun("next")}>
                <StepForward size={13} /> Run this node
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => stepRun("continue")}>
                <FastForward size={13} /> Continue without pausing
              </button>
              <button className="btn btn-sm btn-ghost btn-danger" onClick={stopRun}>
                Stop
              </button>
            </div>
          </div>
        )}
        <EdgeRunContext.Provider value={edgeRunInfo}>
        <ReactFlow
          nodes={orderedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeDragStart={() => {
            markNodeDrag();
            setDraggingNode(true);
          }}
          onNodeDragStop={() => setDraggingNode(false)}
          onPaneClick={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
          }}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.2}
          maxZoom={2}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          // No third-party attribution on the canvas — the app ships as its own
          // product, so the React Flow badge is hidden everywhere.
          proOptions={{ hideAttribution: true }}
        >
          <Controls position="bottom-left" style={{ marginLeft: 44, marginBottom: 62 }} />
          {/* The whole-workflow overview map is always available (toggle it with
              the square button under the palette). It is interactive: drag the
              map to pan the canvas and scroll over it to zoom, so moving the map
              brings the workflow along. While a node is dragged it is shown even
              when hidden, so you can see where the node is heading. */}
          {(minimapOpen || draggingNode) && (
            <MiniMap
              position="bottom-right"
              style={{ marginBottom: 178, cursor: "grab" }}
              pannable
              zoomable
              ariaLabel="Workflow overview — drag to move the canvas, scroll to zoom"
              nodeColor={(n) => (n.data as WorkflowNodeData).color || "#7d9cc4"}
              maskColor="rgba(10, 15, 29, 0.7)"
            />
          )}
        </ReactFlow>
        </EdgeRunContext.Provider>

        {/* drafting frame: corner brackets */}
        <div className="bf-frame">
          <span className="bf-corner bf-corner-tl" />
          <span className="bf-corner bf-corner-tr" />
          <span className="bf-corner bf-corner-bl" />
          <span className="bf-corner bf-corner-br" />
        </div>

        {nodes.length === 0 && (
          <div className="canvas-empty">
            <div className="hint">
              <span className="big">+</span>
              Start by adding a trigger
              <br />
              <span className="dim">Click one in the left panel — e.g. Webhook, Manual or Gmail</span>
            </div>
          </div>
        )}

        <div className="canvas-toolbar">
          <span>
            <b>{nodes.length}</b> Nodes · <b>{edges.length}</b> CONNECTIONS
          </span>
          {/* Workflow-level settings worth seeing at a glance on the canvas. */}
          {meta.loop?.enabled && (
            <span className="canvas-badge" title="This workflow repeats after each run — change it in Workflow settings">
              ↻ {meta.loop.times === 0 ? "CONTINUOUS" : `×${meta.loop.times}`}
            </span>
          )}
          {loopRun?.running && (
            <span className="canvas-badge on" title="The loop runs on the server — it continues when you close this page">
              Loop running · {loopRun.done}
              {loopRun.total ? `/${loopRun.total}` : ""}
              <button className="canvas-badge-btn" onClick={stopLoopRun} title="Stop the loop">
                STOP
              </button>
            </span>
          )}
          {meta.executionMode === "background" && (
            <span className="canvas-badge on" title="Always on: the server keeps this workflow running even while you are offline">
              ALWAYS ON
            </span>
          )}
        </div>

        {edgeInfo && (
          <div className="edge-bar">
            <span>
              CONNECTION: <b style={{ color: "var(--cyan)" }}>{edgeInfo.source}</b> →{" "}
              <b style={{ color: "var(--cyan)" }}>{edgeInfo.target}</b>
            </span>
            <button className="btn btn-sm btn-danger" onClick={deleteSelected}>
              <Trash2 size={12} /> DELETE CONNECTION
            </button>
          </div>
        )}

        {collab && meta && (
          <CollabPanel
            workflowId={meta.id}
            tab={collab.tab}
            onTab={(tab) => setCollab((c) => (c ? { ...c, tab } : c))}
            nodeId={collab.nodeId}
            onNodeFilter={(nodeId) => setCollab((c) => (c ? { ...c, nodeId } : c))}
            nodeLabels={Object.fromEntries(nodes.map((n) => [n.id, n.data.label || catalog.nodes[n.data.def.type]?.name || n.id]))}
            onClose={() => setCollab(null)}
            onCounts={setCommentCounts}
            onRestoreNode={restoreNode}
            onFocusNode={focusNode}
          />
        )}

        {consoleOpen && (
          <LogConsole
            result={runResult}
            loading={running && !waiting}
            stopping={stopping}
            waiting={waiting}
            onCancelWait={cancelWait}
            height={consoleH}
            width={consoleW}
            onResizeHeight={(h) => setConsoleH(clampConsoleH(h))}
            onResizeWidth={(w) => setConsoleW(clampConsoleW(w))}
            onClose={() => setConsoleOpen(false)}
            hasChat={hasChat}
            chatMessages={chatMessages}
            sendingChat={sendingChat}
            onSendChat={sendChat}
            onSubmitInput={submitRunInput}
            history={execHistory}
            activeExecutionId={activeExecutionId}
            onLoadHistory={loadExecution}
            onRefreshHistory={refreshHistory}
            approval={approval}
            onAnswerApproval={answerApproval}
            answeringApproval={answeringApproval}
            onReplay={replayRun}
            onRetryFailed={retryFailed}
            onOpenCollab={(tab) => setCollab({ tab, nodeId: null })}
            openComments={Object.values(commentCounts).reduce((a, b) => a + b, 0)}
          />
        )}

        {/* AI workflow builder — the button lives in the bottom-left corner of
            the workspace, the chat panel opens right above it. */}
        {!readOnly && (
        <button
          className={`canvas-agent-btn ${agentOpen ? "active" : ""}`}
          onClick={() => setAgentOpen((o) => !o)}
          title="Build or change this workflow with the AI agent — it uses your own model"
          aria-expanded={agentOpen}
        >
          <Sparkles size={14} />
          <span>Build with AI</span>
        </button>
        )}

        {agentOpen && !readOnly && (
          <WorkflowAgent
            catalog={catalog}
            getWorkflow={buildPayload}
            onApply={applyAgentWorkflow}
            onClose={() => setAgentOpen(false)}
            references={agentRefs}
            onRemoveReference={removeAgentReference}
          />
        )}
      </div>
      </>
      )}
      </div>

      {/* centered modals */}
      {selectedDef && selectedNode && selectedDef.type !== "stickyNote" && (
        <NodeConfigModal
          def={selectedDef}
          color={selectedColor || ""}
          label={selectedNode.data.label}
          config={selectedNode.data.config}
          agents={agents}
          input={inputOverview}
          onLabel={(v) => updateNodeData({ label: v })}
          onConfig={(patch) => updateNodeData({ config: { ...(selectedNode.data.config || {}), ...patch } })}
          onDelete={deleteSelected}
          onClose={() => {
            setSelectedNodeId(null);
            setSelectedEdgeId(null);
            // flush any pending auto-save (e.g. a just-pasted API key) so it is
            // persisted the moment the user closes the node config
            if (dirtyRef.current) save({ silent: true });
          }}
          onRunNext={runNextNode}
          nextNodeLabel={selectedNextLabel}
          providers={catalog.providers}
          currentWorkflowId={meta?.id || undefined}
          // Webhook trigger nodes show their live URL and let the user change
          // the URL part — /webhook/<slug> resolves to this workflow.
          webhookUrl={selectedDef.type === "webhook" ? webhookUrl : null}
          webhookSlug={meta?.webhookSlug || ""}
          onWebhookSlug={(slug) => updateMeta({ webhookSlug: slug || undefined })}
          onEditJson={() => openJsonEditor(selectedNode.id)}
          lastError={runResult?.log.find((l) => l.nodeId === selectedNode.id && l.status === "error") || null}
          readOnly={readOnly}
          onComments={() => openComments(selectedNode.id)}
          commentCount={commentCounts[selectedNode.id] || 0}
          onAddReference={() => addAgentReference(selectedNode)}
          isReferenced={agentRefs.some((r) => r.nodeId === selectedNode.id)}
        />
      )}

      {backupsOpen && meta && (
        <WorkflowBackups
          workflowId={meta.id}
          onRestored={onRestoredVersion}
          onClose={() => setBackupsOpen(false)}
          onMessage={show}
        />
      )}

      {versionsOpen && meta && (
        <WorkflowVersions
          workflowId={meta.id}
          onRestored={onRestoredVersion}
          onClose={() => setVersionsOpen(false)}
          onMessage={show}
        />
      )}

      {shareOpen && meta && (
        <ShareModal
          workflow={{ id: meta.id, name: meta.name, description: meta.description }}
          collaborators={meta.collaborators}
          sharedBy={meta.sharedBy}
          isOwner={!meta.shared}
          onStopSharing={!meta.shared && sharedMode ? endSharing : undefined}
          onClose={() => setShareOpen(false)}
          onCollaboratorsChange={(collabs) => {
            setMeta((m) => (m ? { ...m, collaborators: collabs } : m));
            if (loadedRef.current) {
              setDirty(true);
              scheduleAutoSave();
            }
          }}
        />
      )}

      {evalOpen && meta && (
        <EvaluationModal
          workflowId={meta.id}
          tests={meta.tests || []}
          nodes={toFlowNodes(nodes)}
          onChange={(tests) => {
            setMeta((m) => (m ? { ...m, tests } : m));
            if (loadedRef.current) {
              setDirty(true);
              scheduleAutoSave();
            }
          }}
          onShowResult={(result) => {
            setRunResult(result);
            applyRunStatuses(result, setNodes);
            setConsoleOpen(true);
          }}
          onClose={() => setEvalOpen(false)}
        />
      )}

      {jsonOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setJsonOpen(false)} onKeyDown={(e) => e.key === "Escape" && setJsonOpen(false)}>
          <div className="modal modal-json" role="dialog" aria-modal="true" aria-label="Edit workflow JSON" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title"><Braces size={13} /> {jsonNodeId ? "Node JSON" : "Workflow JSON"}</div>
                <div className="modal-sub">
                  {jsonNodeId
                    ? "This node's type, label, position and settings. Its id stays — connections point at it."
                    : "Nodes, edges and settings. Problems are underlined as you type; invalid JSON is never applied."}
                </div>
              </div>
              <button className="modal-x" onClick={() => setJsonOpen(false)} title="Close">
                <X size={14} />
              </button>
            </div>
            <Suspense fallback={<div className="json-code-editor json-code-loading">Loading editor…</div>}>
            <JsonCodeEditor
              initialValue={jsonDraft}
              catalog={catalog}
              mode={jsonNodeId ? "node" : "workflow"}
              onChange={(text) => {
                setJsonDraft(text);
                setJsonError(null);
              }}
              onIssues={setJsonIssues}
              context={() => {
                const p = buildPayloadRef.current();
                return { nodes: (p?.nodes || []) as unknown as Array<Record<string, unknown>>, edges: (p?.edges || []) as unknown as Array<Record<string, unknown>> };
              }}
              onSubmit={applyJson}
            />
            </Suspense>
            <div className="json-editor-status">
              {jsonIssues.errors || jsonIssues.warnings ? (
                <span>
                  {jsonIssues.errors > 0 && <b className="json-status-err">{jsonIssues.errors} error{jsonIssues.errors === 1 ? "" : "s"}</b>}
                  {jsonIssues.errors > 0 && jsonIssues.warnings > 0 && " · "}
                  {jsonIssues.warnings > 0 && <b className="json-status-warn">{jsonIssues.warnings} warning{jsonIssues.warnings === 1 ? "" : "s"}</b>}
                  {" "}— hover the underlined text or the marks in the gutter
                </span>
              ) : (
                <span className="json-status-ok">✓ No problems found</span>
              )}
              <span className="json-editor-hints">
                Ctrl+Space suggestions · Ctrl+F search · Ctrl+Enter apply ·{" "}
                <a href="/docs/workflow-reference.md" target="_blank" rel="noopener">reference</a> ·{" "}
                <a href="/schema/workflow.schema.json" target="_blank" rel="noopener">schema</a>
              </span>
            </div>
            {jsonError && <div className="field-json-error">⚠ {jsonError}</div>}
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setJsonOpen(false)}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={applyJson} disabled={!!jsonError || readOnly} title={readOnly ? "You cannot change this workflow" : undefined}>
                {jsonNodeId ? "Apply to node" : "Apply JSON to canvas"}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && meta && (
        <WorkflowModal
          workflow={{ id: meta.id, name: meta.name, description: meta.description, folderId: meta.folderId, nodes: toFlowNodes(nodes), edges: toFlowEdges(edges) }}
          triggers={triggerLabels}
          webhookUrl={webhookUrl}
          agentsCount={agents.length}
          loop={meta.loop}
          executionMode={meta.executionMode || "editor"}
          onName={(v) => updateMeta({ name: v })}
          onDescription={(v) => updateMeta({ description: v })}
          onLoop={(loop) => updateMeta({ loop })}
          onExecutionMode={(mode) => updateMeta({ executionMode: mode })}
          environment={meta.environment || "live"}
          onEnvironment={(environment) => updateMeta({ environment })}
          mcp={meta.mcp}
          onMcp={(mcp) => updateMeta({ mcp })}
          aiBudget={meta.aiBudget}
          onAiBudget={(aiBudget) => updateMeta({ aiBudget })}
          isOwner={!meta.shared}
          onExport={exportJson}
          onImport={importOrMergeJson}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}

// Mirrors server/executor.js defaultOutputFileName for a node that has not run
// yet. The real extension depends on the output, so ".json" is the best guess.
function defaultOutputFileName(id: string, label: string): string {
  const slug =
    String(label || id || "node")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "output";
  const shortId = String(id || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(-10);
  return `${slug}-${shortId || "out"}.json`;
}

export default function WorkflowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}
