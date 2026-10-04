export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "boolean"
  | "secret"
  | "json"
  | "keyvalue"
  | "code"
  | "note"
  | "agentSelect"
  | "workflowSelect"
  | "oauth"
  | "telegramBot"
  | "telegramAccount"
  | "upstreamFile";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  /** one-line explanation shown by the inline "?" help next to the label */
  help?: string;
  /** small concrete valid value shown as the "?" help's example */
  example?: string;
  options?: Array<string | { value: string; label: string }>;
  /** groups fields under a labelled section in the inspector */
  section?: string;
  /** only show this field while another field has this value; `not: true` inverts */
  // `in` shows the field when the key equals any of the listed values.
  visibleWhen?: { key: string; value?: unknown; in?: unknown[]; not?: boolean };
  /** optional fields are tucked behind the "+ add optional parameters" toggle */
  optional?: boolean;
  /** keyvalue rows: placeholder texts for the key and value inputs */
  placeholderField?: string;
  placeholderValue?: string;
  /** "oauth" fields: which service, its display name and the scopes this node needs */
  provider?: string;
  providerLabel?: string;
  scopes?: string[];
  /** only shown while this connected-account service is set up by the operator */
  oauthOnly?: string;
  /** token field behind an "oauth" picker: how it looks while that service is not set up */
  oauthFallback?: { provider: string; label: string; optional: boolean; help?: string };
  /** text field that names a payload field: a dragged field drops as its bare path, not {{path}} */
  fieldPath?: boolean;
}

export interface NodeDef {
  type: string;
  kind: "trigger" | "action" | "ai" | "logic";
  category: "triggers" | "files" | "actions" | "ai" | "logic" | "feeds" | "integrations";
  name: string;
  description: string;
  icon: string;
  defaults: Record<string, unknown>;
  fields: FieldDef[];
  sources: string[];
  /** a trigger that only fires its sample on Run (shared/catalog.js DEMO_TRIGGERS) */
  demo?: boolean;
}

export interface Catalog {
  categories: Record<string, { label: string; color: string }>;
  nodes: Record<string, NodeDef>;
  groups: Array<{ id: string; label: string; nodes: string[] }>;
  providers?: Array<{ value: string; label: string; defaultBaseUrl: string; defaultModel: string; models?: string[] }>;
  /** sample payload per trigger type, used by the input overview */
  samples?: Record<string, Record<string, unknown>>;
}

export interface FlowNodeData {
  label: string;
  config: Record<string, unknown>;
}

export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface WorkflowFolder {
  id: string;
  name: string;
  /** Parent folder id; omitted means this folder sits directly in the main folder. */
  parentId?: string;
  createdAt?: string;
  /** the account's main folder — auto-created, cannot be deleted */
  home?: boolean;
}

/**
 * One folder an account shared with another user. An account can only have ONE
 * shared folder at a time, and `includeSubfolders` decides whether subfolders
 * (and the workflows inside them) are shared too.
 */
/** What a share allows (server/index.js workflowRoleOf). "editor" when unset. */
export type ShareRole = "viewer" | "runner" | "editor";
export type WorkflowRole = ShareRole | "owner";

/** A comment pinned to a node (or to the whole workflow when nodeId is null). */
export interface WorkflowComment {
  id: string;
  nodeId: string | null;
  parentId: string | null;
  userId: string;
  author: string;
  text: string;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  resolved: boolean;
}
export interface WorkflowPerson {
  userId: string;
  name: string;
  email: string;
  role: WorkflowRole;
}
/** One entry of "who changed what" (server/workflow-collab.js). */
export interface WorkflowHistoryEntry {
  id: string;
  at: string;
  userId: string;
  author: string;
  nodes: Array<{
    nodeId: string;
    label: string;
    kind: "added" | "changed" | "removed";
    fields?: string[];
    before: FlowNode | null;
    after: FlowNode | null;
  }>;
  edges: { added: number; removed: number };
  renamed?: { from: string; to: string };
}

export interface FolderShare {
  id: string;
  folderId: string;
  folderName?: string;
  ownerId: string;
  ownerEmail?: string;
  ownerName?: string;
  userId: string;
  email: string;
  name?: string;
  includeSubfolders: boolean;
  role?: ShareRole;
  createdAt?: string;
  /** incoming shares only: how many workflows currently live in the folder */
  workflowCount?: number;
}

/**
 * One other account currently editing a shared workflow — `nodeId` is the node
 * its editor has open, drawn as a small marker on the canvas.
 */
export interface SharedEditor {
  userId: string;
  name: string;
  email: string;
  nodeId: string | null;
  nodeLabel: string;
}

/** One automated workflow test used by the Evaluation menu. */
export interface WorkflowTest {
  id: string;
  name: string;
  /** trigger event handed to the run (JSON value, usually an object) */
  payload: unknown;
  /** assertion evaluated against the run result */
  expect: {
    /** the run must finish successfully (default true) */
    success?: boolean;
    /** restrict the check to one node's last output (default: every node) */
    nodeId?: string;
    /** text that must appear in the checked output (JSON-stringified) */
    contains?: string;
    /** exact JSON value the checked output must equal */
    equals?: string;
  };
}

/** Per-test outcome shown in the Evaluation menu. */
export interface TestResult {
  testId: string;
  name: string;
  pass: boolean;
  durationMs: number;
  /** one-line explanation when the test failed (or the assertion summary) */
  detail: string;
  /** the full run result, so a failing test can be inspected in the Log console */
  result?: ExecResult;
}

/**
 * The workflow's repeat setting: after a run finishes it runs again — a fixed
 * number of times, or (only in background execution) without end.
 */
export interface WorkflowLoop {
  enabled: boolean;
  /** total number of runs; 0 = keep repeating until it is switched off */
  times: number;
  /** seconds to wait between two runs */
  intervalSeconds: number;
}

/** Progress of a loop running on the server (GET /api/workflows/:id/loop). */
export interface LoopRunStatus {
  running: boolean;
  /** runs finished so far, the editor's first run included */
  done?: number;
  /** total runs; 0 = until stopped */
  total?: number;
  nextAt?: string;
}

/**
 * How a workflow executes:
 *  - "editor": when someone runs it, or a trigger fires while the server is up.
 *  - "background": the server keeps it running (repeat / live triggers) even
 *    while its owner is signed out — a Pro feature.
 */
export type WorkflowExecutionMode = "editor" | "background";

/** "test" uses Variables' test values and forces money-moving nodes into test mode. */
export type WorkflowEnvironment = "live" | "test";

/** Offer this workflow as a tool to AI assistants over MCP (server/mcp.js). */
/** One input of a workflow offered as an AI tool (server/mcp.js cleanFields). */
export interface McpParam {
  name: string;
  description: string;
  /** "string" when left out */
  type?: "string" | "number" | "boolean" | "enum";
  required?: boolean;
  /** the allowed values of an "enum" input */
  options?: string[];
  example?: string;
}

export interface WorkflowMcpSettings {
  enabled: boolean;
  description: string;
  params: McpParam[];
  /** optional description of the answer's fields — becomes the tool's outputSchema */
  outputs?: Array<{ name: string; description: string; type?: "string" | "number" | "boolean" }>;
}

export type McpAccess = "run" | "read" | "build";

/** A named AI-tools token (the secret itself is shown only once, on creation). */
export interface McpToken {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  access: McpAccess;
  /** "all", or the ids of the workflows the token may see and run */
  workflows: "all" | string[];
  /** runs this token may start per UTC day; 0 = no own limit */
  dailyRuns: number;
}

/** Per-workflow failure alert settings (the bot token itself never comes back). */
export interface WorkflowAlertSettings {
  enabled: boolean;
  email: string;
  telegramChatId: string;
  telegramBotTokenSet: boolean;
  includeEditorRuns: boolean;
}

/** The account's MCP connection info (Settings → AI tools). */
export interface McpInfo {
  endpoint: string;
  token: { createdAt: string; hint: string } | null;
  tokens: McpToken[];
  tools: Array<{ workflowId: string; workflowName: string; name: string }>;
  builderTools: Array<{ name: string; title: string; level: McpAccess }>;
}

/** A chart page written by Dashboard nodes. */
export interface DashboardSummary {
  id: string;
  name: string;
  series: string[];
  updatedAt?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  folderId?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** automated tests run by the Evaluation menu */
  tests?: WorkflowTest[];
  /** repeat the whole workflow after each run (null clears the setting) */
  loop?: WorkflowLoop | null;
  /** "editor" (default) or "background" (Pro) — see WorkflowExecutionMode */
  executionMode?: WorkflowExecutionMode;
  /** Test / Live environment (defaults to live) */
  environment?: WorkflowEnvironment;
  /** listed as a tool for AI assistants (MCP) */
  mcp?: WorkflowMcpSettings;
  /** this workflow's own AI token / cost limits (server/ai-budget.js) */
  aiBudget?: AiBudget;
  updatedAt?: string;
  /** custom webhook URL part — /webhook/<slug> resolves to this workflow */
  webhookSlug?: string;
  /** true when another user shared this workflow with the current account */
  shared?: boolean;
  /** true when access comes from a shared folder rather than a direct share */
  sharedViaFolder?: boolean;
  /** the OWNER's folder this workflow came from (folder shares only, display) */
  sharedFolderId?: string;
  /** name of that shared folder (resolved live for the viewer) */
  sharedFolderName?: string;
  /** owner view: this workflow sits in a folder the owner shared with a user */
  folderShared?: boolean;
  /** owner view: the user that folder is shared with */
  folderSharedWith?: string;
  /** users who can edit this workflow together with the owner */
  collaborators?: Array<{ userId: string; email: string; name?: string; role?: ShareRole }>;
  /** what the current account may do with this workflow (GET /api/workflows/:id) */
  role?: WorkflowRole;
  /** the owner of a workflow that was shared with the current account */
  sharedBy?: SharedBy;
}

/** Who shared a workflow with the current account (the workflow's owner). */
export interface SharedBy {
  userId: string;
  email: string;
  name?: string;
}

/** Response of the lightweight access check the editor polls while open. */
export interface WorkflowAccess {
  /** whether the current account can still open the workflow */
  accessible: boolean;
  /** true while the workflow has collaborators (owner view) */
  shared?: boolean;
  /** the collaborators the owner currently shares with (owner view) */
  sharedWith?: Array<{ userId: string; email: string; name?: string }>;
  /** the owner who shared this workflow with the current account (viewer view) */
  sharedBy?: SharedBy;
  /** true when access comes from a shared folder rather than a direct share */
  sharedViaFolder?: boolean;
  /** other accounts currently on the canvas of a shared workflow */
  editing?: SharedEditor[];
}

export interface AgentModelConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  model: AgentModelConfig;
  systemPrompt?: string;
  memory?: boolean;
  tools?: {
    http?: boolean;
    time?: boolean;
    httpMethod?: string;
    httpUrl?: string;
    httpHeaders?: string;
    httpBody?: string;
  };
  updatedAt?: string;
}

export interface ExecLogEntry {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: "success" | "error";
  durationMs: number;
  inputItems: unknown[];
  outputItems: unknown[];
  error?: string;
  /** error code (e.g. 3001) — see shared/errors.js and ERRORS.md */
  errorCode?: number;
  /** short description for the code, shown inline in the Log console */
  errorShort?: string;
  /** files this node produced ("Save output as file" / Write File) — shown in the Log console */
  filesWritten?: { name: string; path?: string; mimeType?: string; size?: number }[];
  /** tokens the model saw/returned for THIS node (AI nodes only) */
  usage?: { prompt?: number; completion?: number; total?: number; model?: string } | null;
  /** true when a per-node "on error → continue" setting handled the failure */
  handled?: boolean;
  /** how many attempts the node needed (retry-on-error) */
  attempts?: number;
  /** full number of input items (inputItems is a capped snapshot) */
  inputCount?: number;
  /** items sent out per output handle — labels the connections after a run */
  handleCounts?: Record<string, number>;
}

export interface ErrorCodeEntry {
  key: string;
  code: number;
  short: string;
  description: string;
  tips: string[];
}

/** One saved run in a workflow's execution history (Execution menu list). */
export interface ExecutionSummary {
  id: string;
  workflowId: string;
  /** what started the run: editor | webhook | chat | schedule | telegram */
  source: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  aborted: boolean;
  nodeCount: number;
  errorCount: number;
  /** model tokens this run consumed (0 when no model was called) */
  promptTokens?: number;
  completionTokens?: number;
  /** estimated cost of those tokens per the account's price table */
  aiCostUsd?: number;
  /** still executing — not saved yet, so there is no log to open */
  running?: boolean;
  /** Run was pressed but the trigger (webhook, input…) has not fired yet */
  waiting?: boolean;
  /** label of the node the running run is on right now */
  currentNode?: string;
  /** how many nodes the running run has started so far */
  nodesStarted?: number;
}

export interface ExecResult {
  workflowId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  log: ExecLogEntry[];
  consoleLog: string[];
  success: boolean;
  nodeCount: number;
  errorCount?: number;
  /** true when the user pressed Stop and the run was halted deliberately */
  aborted?: boolean;
  /** the payload the run was started with — lets a past run be replayed */
  input?: unknown;
  /** token usage across every model call in this run (null when none ran) */
  usage?: { prompt?: number; completion?: number; total?: number; model?: string } | null;
  /** this run's estimated AI cost (set on the run response once it is priced) */
  aiCostUsd?: number;
  /** nodes that were skipped with a handled error ("Continue" on error) */
  handledErrors?: number;
  /** the server-side loop this Run started (loop setting; absent = ran once) */
  loop?: LoopRunStatus;
  /** the environment the run used */
  environment?: WorkflowEnvironment;
  /** set when this run retried an earlier failed run from its failed node */
  retriedFrom?: { executionId: string; nodeId: string; nodeName: string };
  /** id of the saved execution */
  executionId?: string;
}

/** A run that is waiting for its trigger (returned by POST /run on a workflow
 * whose triggers are all non-manual — the trigger never invents test data).
 * `awaiting` says how input arrives:
 *  - "webhook": an inbound HTTP trigger — poll until a real request fires it.
 *  - "input": any other trigger — submit a payload to /run/input.
 *  - "chat": a Chat Trigger — use the chat panel (/chat). */
export interface WaitingRun {
  waiting: true;
  awaiting?: "webhook" | "input" | "chat";
  /** null for chat runs (no pending server entry to poll) */
  waitingId: string | null;
  method: string;
  webhookUrl: string;
  /** trigger node type, e.g. "slackTrigger" | "chatTrigger" */
  kind?: string;
  triggerType?: string;
  triggerLabel?: string;
  message: string;
}

/** One message in the Chat panel (Chat Trigger / Chat Output workflows). */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at?: string;
}

/** A credential stored in the account's vault (SQL, encrypted at rest). */
export interface Credential {
  id: string;
  name: string;
  type: string;
  /** the credential's fields (e.g. apiKey, header) — decrypted for the owner */
  fields: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

/** A named variable an account can reference from its workflows. */
export interface Variable {
  id: string;
  name: string;
  value: string;
  /** used instead of value by workflows in the Test environment (empty = same as value) */
  testValue?: string;
  /** stored encrypted at rest */
  secret: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** A lightweight spreadsheet stored in SQL. */
export interface DataTable {
  id: string;
  name: string;
  columns: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface DataTableRow {
  id: string;
  tableId: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** A workflow the author published to the community (secrets scrubbed). */
/**
 * Model credentials of the AI workflow builder agent. Every account brings its
 * own model — the API key is stored encrypted per account and only ever leaves
 * the server towards the provider the user configured (`hasKey` tells the UI
 * whether one is saved).
 */
export interface BuilderSettings {
  /** true when a model (and, for hosted providers, a key) is stored */
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  /** whether an API key is on file — the key itself is never sent to the browser */
  hasKey: boolean;
}

/**
 * A node the user pinned in the editor ("use this node as a reference") to tell
 * the AI builder exactly which step a request is about. Credentials are blanked
 * before it is sent.
 */
export interface BuilderReference {
  nodeId: string;
  label: string;
  type: string;
  config: Record<string, unknown>;
}

/** Result of one AI builder turn: the new workflow plus what it did. */
export interface BuilderBuildResult {
  workflow: Workflow;
  summary: string;
  /**
   * What the agent changed, computed by the server from the workflow the user
   * had and the one the model returned — one line per node/edge/rename, e.g.
   * `+ Added node "Slack" (slack)`. Empty when the graph is unchanged.
   */
  changes?: string[];
  /** non-fatal notes (e.g. a node type the model invented was dropped) */
  warnings: string[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** Workspace statistics shown on the Main page. */
export interface WorkspaceStats {
  /** runs nobody started by hand (webhook, schedule, chat, Telegram, …) */
  prodExecutions: number;
  failedProdExecutions: number;
  /** failed production runs as a percentage (one decimal) */
  failureRate: number;
  /** estimated human time those runs replaced, minus the machine time they took */
  timeSavedMs: number;
  /** average duration of every recorded run */
  avgRunTimeMs: number;
  totalExecutions: number;
  editorExecutions: number;
  /** the assumed manual handling time per production run (minutes) */
  manualMinutesPerRun: number;
  /** model tokens consumed across every recorded run */
  promptTokens: number;
  completionTokens: number;
  /** what those tokens cost according to the account's editable price table */
  aiSpendUsd: number;
}

/**
 * One pending "Wait for Approval" node of a live run — polled through the
 * run-status endpoint and answered from the Log console.
 */
export interface ApprovalRequest {
  id: string;
  nodeId?: string | null;
  nodeName?: string | null;
  message: string;
  approveLabel: string;
  rejectLabel: string;
  /** epoch millis when the request appeared (null when unknown) */
  startedAt?: number | null;
  /** epoch millis when "when nobody answers" applies (0 = waits forever) */
  expiresAt?: number;
}

/** Live state of a run started from the editor (progress + pending approval). */
export interface RunStatus {
  active: boolean;
  workflowId?: string;
  nodeId?: string | null;
  nodeIndex?: number;
  elapsedMs?: number;
  /** the approval the run is currently parked on, if any */
  approval?: ApprovalRequest | null;
  /** debug mode: still pausing before every node */
  stepping?: boolean;
  /** debug mode: the node the run is paused before, with its input */
  paused?: { nodeId: string; input: unknown[] } | null;
}

/** A snapshot of an earlier workflow state (undo history entry). */
export interface WorkflowVersion {
  id: string;
  workflowId: string;
  ownerId?: string;
  savedAt: string;
  /** "save" | "before-restore" | "manual" | … */
  reason: string;
  name: string;
  description?: string;
  nodeCount: number;
  edgeCount: number;
}

/** A full version snapshot including the graph (used for preview / restore). */
export interface WorkflowVersionFull extends WorkflowVersion {
  nodes: Workflow["nodes"];
  edges: Workflow["edges"];
}

/**
 * One entry of the rolling backup buffer a SHARED workflow can rewind to. Every
 * save appends the state it wrote, tagged with the account that made it, so a
 * collaborator can go back to the last minute, the last saves, or their own
 * last save after someone else wrote over the record.
 */
export interface WorkflowBackup {
  id: string;
  workflowId: string;
  savedAt: string;
  /** "manual" | "autosave" | "rewind" | "before-rewind" | "created" */
  reason: string;
  userId?: string;
  userName?: string;
  /** true when this save was made by the current account */
  mine?: boolean;
  name: string;
  description?: string;
  nodeCount: number;
  edgeCount: number;
}

/** The Backup & rewind menu's data: recent saves plus the two quick targets. */
export interface WorkflowBackupList {
  backups: WorkflowBackup[];
  total: number;
  max: number;
  /** the state ~1 minute ago (null when nothing old enough is kept) */
  rewind: WorkflowBackup | null;
  /** the newest save the current account made (null when they never saved) */
  myLast: WorkflowBackup | null;
}

/** A curated starter template offered on the Workflows page. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  level: string;
  requires: string[];
  nodeCount: number;
  edgeCount: number;
}

/** A template with its graph, ready to create as a real workflow. */
export interface Template extends TemplateSummary {
  nodes: Workflow["nodes"];
  edges: Workflow["edges"];
}

/** One model's price in the account's AI cost table (USD per 1M tokens). */
export interface AiPrice {
  input: number;
  output: number;
}

/** The account's editable AI price table + usage totals for the settings view. */
// ---- AI spending control (server/ai-budget.js, server/ai-usage.js) ----
export interface AiBudgetWindow {
  tokens: number;
  usd: number;
}
/** Token / USD limits per day and month — 0 = no limit. */
export interface AiBudget {
  daily: AiBudgetWindow;
  monthly: AiBudgetWindow;
}
export interface AiAccountBudget extends AiBudget {
  fallback: { enabled: boolean; model: string; at: number };
  alerts: { telegram: boolean; botId: string; chatId: string };
}
export interface AiBudgetStatus {
  scope: "account" | "workflow";
  window: "daily" | "monthly";
  unit: "tokens" | "usd";
  limit: number;
  used: number;
  pct: number;
}
export interface AiUsed {
  tokens: number;
  costUsd: number;
  runs: number;
}
export interface AiBudgetOverview {
  settings: AiAccountBudget;
  used: { account: { daily: AiUsed; monthly: AiUsed }; workflow: { daily: AiUsed; monthly: AiUsed } };
  status: AiBudgetStatus[];
  bots?: Array<{ id: string; name: string; email: string }>;
}
export interface AiUsageDashboard {
  days: number;
  totals: { tokens: number; prompt: number; completion: number; costUsd: number; runs: number };
  byDay: Array<{ day: string; tokens: number; costUsd: number; runs: number }>;
  byWorkflow: Array<{ workflowId: string; name: string; tokens: number; costUsd: number; runs: number }>;
  byModel: Array<{ model: string; tokens: number; costUsd: number; calls: number }>;
  topNodes: Array<{ workflowId: string; workflowName: string; nodeId: string; nodeName: string; nodeType: string; tokens: number; costUsd: number; runs: number }>;
  budgets: AiBudgetStatus[];
  unpriced: boolean;
}
export interface AiWorkflowEstimate {
  basedOnRuns: number;
  perRun: { tokens: number; minTokens: number; maxTokens: number; costUsd: number };
  nodes: Array<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    model: string;
    avgTokens: number | null;
    avgCostUsd: number | null;
    maxOutputTokens: number | null;
    tokenCap: number;
    reuseAnswers: boolean;
  }>;
  used: { workflow: { daily: AiUsed; monthly: AiUsed }; account: { daily: AiUsed; monthly: AiUsed } };
  budgets: AiBudgetStatus[];
  fallback: { enabled: boolean; model: string; at: number };
}

export interface AiPriceSettings {
  prices: Record<string, AiPrice>;
  fallback: AiPrice;
  /** preset table for models the user has not priced yet */
  presets: Record<string, AiPrice>;
}

/** The current account's subscription state read from /api/billing. */
export interface BillingStatus {
  /** whether the site has Stripe wired up (secret key + price id set) */
  configured: boolean;
  /** whether the operator accepts Pro purchases right now (admin Billing toggle).
   * A fresh install starts closed: everyone is on free, Pro opens next month. */
  salesOpen: boolean;
  /** human label of the plan, e.g. "€9.99 / month" */
  priceLabel: string;
  /** whether this account has Pro access right now (subscription OR role grant) */
  active: boolean;
  /**
   * Where the Pro access comes from: "role" (an operator granted the account
   * the pro_user role in the admin panel), "subscription" (active Stripe plan)
   * or "none" (free plan).
   */
  source: "role" | "subscription" | "none";
  /** raw Stripe status: active | trialing | past_due | canceled | none … */
  status: string;
  since: string;
  /** epoch millis when the current period ends (0 when none) */
  periodEnd: number;
  /** whether a Stripe customer exists — the Billing Portal can only open then */
  hasCustomer: boolean;
  /** whether a Stripe subscription is on file */
  hasSubscription: boolean;
  /** true when the plan is set to end at periodEnd (scheduled cancellation) */
  cancelAtPeriodEnd: boolean;
  /** true when the active plan was bought with crypto (NOWPayments) — it does
   * not renew automatically, so each period is a new payment */
  crypto: boolean;
  /** whether this instance accepts crypto payments, and how they are priced */
  cryptoPayments: {
    enabled: boolean;
    configured: boolean;
    priceAmount: string;
    priceCurrency: string;
    /** a fixed coin, or empty when the payer chooses on the hosted page */
    payCurrency: string;
    priceLabel: string;
  };
  /** plan the account is on: "free" (capped) or "pro" (unlimited) */
  plan: "free" | "pro";
  /** number of workflows the account currently owns */
  workflowCount: number;
  /** max owned workflows on the current plan (null = unlimited / Pro) */
  workflowLimit: number | null;
  /** workflow runs the account started today (editor runs + webhooks) */
  runsToday: number;
  /** daily run cap on the current plan (null = unlimited / Pro) */
  runsPerDayLimit: number | null;
}

/** One connection test on the Setup page (database / runner). */
export interface SetupTestResult {
  ok: boolean;
  message: string;
}

/**
 * Instance setup (the Setup page): where this copy stores its data and where its
 * workflows execute. Written into the copy's own .env by the server.
 */
export interface SetupState {
  allowed: boolean;
  /** true on a copy the user installed themselves (the installer sets it) */
  standalone: boolean;
  /** the backend this process is running on right now */
  activeEngine: "sqlite" | "postgres";
  storage: {
    engine: "sqlite" | "postgres";
    sqlitePath: string;
    /** password masked — never the real connection string */
    databaseUrl: string;
    hasDatabaseUrl: boolean;
  };
  execution: {
    mode: "local" | "remote";
    remoteUrl: string;
    hasRemoteToken: boolean;
    /** this copy as an execution host for another builder */
    acceptsRuns: boolean;
    hasRunnerToken: boolean;
    /** shown to the owner so it can be pasted into the other copy */
    runnerToken: string;
  };
  port: number;
  /** .env was changed — restart the app to apply it */
  restartRequired: boolean;
  envPath: string;
}

/** Self-hosted installer state (Settings → Defaults → "Run it self-hosted"). */
export interface SelfhostStatus {
  /** whether this account may download the installer (Pro) */
  pro: boolean;
  /** whether the instance carries the app files a downloaded copy needs */
  ready: boolean;
  /** why it cannot (empty when ready) */
  reason: string;
  /** port the local copy starts on — the UI opens http://localhost:<port> */
  port: number;
}

export interface CommunityPost {
  id: string;
  workflowId?: string;
  title: string;
  description?: string;
  ownerId: string;
  ownerName: string;
  nodeCount: number;
  edgeCount: number;
  createdAt?: string;
  /** true when the post was published by the current user */
  mine?: boolean;
  /** public (everyone) | private (only me) | restricted (only allowed users) */
  visibility?: "public" | "private" | "restricted";
  /** user ids a restricted post is shared with (only sent to the author) */
  allowedUserIds?: string[];
  /** published without revealing the author (ownerName = "Anonymous") */
  anonymous?: boolean;
  /** engagement counts (never the raw id lists) */
  likeCount: number;
  commentCount: number;
  saveCount: number;
  importCount: number;
  /** combined ranking score: likes + comments + saves + imports */
  popularity: number;
  /** whether the current user liked / bookmarked this post */
  liked: boolean;
  saved: boolean;
}

/** One comment under a community post. */
export interface CommunityComment {
  id: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
  /** true when the current user wrote it */
  mine?: boolean;
  /** true when the current user may delete it (its author or the post owner) */
  canRemove?: boolean;
}

/** A single community post with its comment thread (detail page). */
export interface CommunityPostDetail extends CommunityPost {
  comments: CommunityComment[];
}

/** The feed response: a page of posts plus how many matched in total. */
export interface CommunityListResult {
  posts: CommunityPost[];
  total: number;
}

/** Feed ranking. "popular" combines likes + comments + saves + imports. */
export type CommunitySort = "newest" | "oldest" | "popular" | "likes" | "comments" | "saves" | "imports";

/** The account's own, editable profile. */
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  bio: string;
  location: string;
  website: string;
  /** emoji or image URL shown as the avatar */
  avatar: string;
  /** publish to the community anonymously by default */
  anonymousByDefault: boolean;
  joinedAt: string;
  postCount: number;
  likeCount: number;
}

/** Another user's public profile (no e-mail, only their public posts). */
export interface PublicProfile {
  id: string;
  displayName: string;
  bio: string;
  location: string;
  website: string;
  avatar: string;
  joinedAt: string;
  postCount: number;
  likeCount: number;
  publicWorkflows: CommunityPost[];
}

/** This copy's self-hosted licence (GET /api/license, server/license.js). */
export interface LicenseState {
  /** false in the cloud — only a self-hosted copy needs a licence */
  required: boolean;
  active: boolean;
  plan: "" | "pro" | "team" | "cloud";
  seats: number;
  validUntil: number;
  checkedAt: number;
  reason: string;
  hasKey: boolean;
  keyHint: string;
  /** where the copy checks its key */
  server: string;
  offlineSince: number;
  /** the signed-in account set this copy up (it may paste the key, run the team) */
  isOwner: boolean;
  /** the team admin limits this account to the shared credentials */
  restricted: boolean;
}

/** The account's custom Team plan request / plan (server/teams.js teamView). */
export interface TeamPlan {
  id: string;
  status: "pending" | "approved" | "rejected" | "active" | "ended";
  active: boolean;
  seats: number;
  company: string;
  message: string;
  priceMonthly: number;
  currency: string;
  note: string;
  members: string[];
  paidUntil: number;
  createdAt: string;
}

export interface TeamPlanInfo {
  team: TeamPlan | null;
  minSeats: number;
  maxSeats: number;
  seatPrice: number;
}

/** One outside address an account's runs reached (server/team-admin.js). */
export interface TeamFlow {
  host: string;
  get: number;
  send: number;
  lastAt: number;
  workflows: { id: string; name: string }[];
  allowed: boolean;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastLogin: string | null;
  status: string;
  owner: boolean;
  restricted: boolean;
  flows: TeamFlow[];
}

/** The Team page of a self-hosted copy (instance owner only). */
export interface TeamOverview {
  plan: string;
  seats: number;
  used: number;
  members: TeamMember[];
  allowedHosts: string[];
  credentials: { id: string; name: string; type: string; pooled: boolean }[];
  variables: { id: string; name: string; secret: boolean; pooled: boolean }[];
}

export interface MoveResult {
  ok: boolean;
  workflows: number;
  agents: number;
  variables: number;
  credentials: number;
  dataTables: number;
  skipped: string[];
}

/** One-click update of a self-hosted copy (GET /api/update, server/updater.js). */
export interface UpdateStatus {
  current: string;
  latest: string;
  available: boolean;
  canUpdate: boolean;
  /** why this copy cannot update itself (git checkout, Docker, the cloud) */
  reason: string;
  isOwner: boolean;
  state: {
    phase: "idle" | "downloading" | "installing" | "restarting" | "done" | "failed";
    message: string;
    error: string;
    target?: string;
    at?: number;
  };
}
