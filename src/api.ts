import type { LicenseState, MoveResult, TeamOverview, TeamPlanInfo, TeamPlan, UpdateStatus } from "./types";
import type { Agent, AiAccountBudget, AiBudgetOverview, AiPriceSettings, AiUsageDashboard, AiWorkflowEstimate, BillingStatus, BuilderBuildResult, BuilderReference, BuilderSettings, Catalog, ChatMessage, CommunityComment, CommunityListResult, CommunityPost, CommunityPostDetail, CommunitySort, Credential, DashboardSummary, DataTable, DataTableRow, ErrorCodeEntry, ExecResult, ExecutionSummary, FolderShare, LoopRunStatus, McpAccess, McpInfo, McpToken, PublicProfile, RunStatus, SelfhostStatus, SetupState, SetupTestResult, ShareRole, SharedEditor, Template, TemplateSummary, UserProfile, Variable, WaitingRun, Workflow, WorkflowAccess, WorkflowComment, WorkflowHistoryEntry, WorkflowPerson, WorkflowRole, WorkflowAlertSettings, WorkflowBackupList, WorkflowFolder, WorkflowVersion, WorkflowVersionFull, WorkspaceStats } from "./types";

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    // HTTP/2 (Cloudflare) has no status text, and a proxy error page is not
    // JSON — fall back to something the user can act on, never a bare "Error".
    let msg = r.statusText || `The server could not complete the request (HTTP ${r.status}). Please try again.`;
    let body: Record<string, unknown> = {};
    try {
      body = await r.json();
      msg = String(body.error || msg);
    } catch {
      /* ignore */
    }
    const error = Object.assign(new Error(msg), body);
    throw error;
  }
  return r.json() as Promise<T>;
}

/**
 * The three self-hosted installers. Every platform is offered explicitly — a
 * `.bat` for Windows (double-clickable), a `.command` for macOS (double-
 * clickable in Finder) and a `.sh` for Linux.
 */
export const INSTALLER_OSES = [
  { key: "windows", label: "Windows", ext: "bat" },
  { key: "mac", label: "macOS", ext: "command" },
  { key: "linux", label: "Linux", ext: "sh" },
] as const;

/** The platform this browser is running on (used to pick the main button). */
export function detectOs(): "windows" | "mac" | "linux" {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  return "linux";
}

/** A connected Google / Microsoft account — never carries its tokens. */
/** Where Telegram sent a login code (server/telegram-accounts.js describeSentCode). */
export interface TelegramCodeDelivery {
  kind: "app" | "sms" | "call" | "email" | "setupEmail" | "fragment" | "unknown";
  message: string;
  /** Telegram offers another way to send it (see nextWay) */
  canResend: boolean;
  nextWay: string;
  /** seconds before that other way may be requested */
  timeout: number;
  url?: string;
}

/** A file in the account's own folder (My files; written by Write File nodes). */
export interface StoredFile {
  name: string;
  path: string;
  size: number;
  modified: string;
  ext?: string;
}

export interface StoredFilesList {
  files: StoredFile[];
  usedBytes: number;
  limitBytes: number;
  maxUploadBytes: number;
  /** Pro accounts get the bigger storage limit */
  pro?: boolean;
}

export interface OAuthConnection {
  id: string;
  provider: string;
  email: string;
  name: string;
  scopes: string[];
  /** service-specific details a node may need (QuickBooks realmId, Salesforce instanceUrl, LinkedIn memberUrn) */
  extra?: Record<string, string>;
  updatedAt?: string;
}

export const api = {
  nodes: () => fetch("/api/nodes").then((r) => j<Catalog>(r)),

  auth: {
    me: () =>
      fetch("/api/auth/me").then((r) =>
        j<{ authed: boolean; email?: string; name?: string; role?: string; emailVerified?: boolean; canSetup?: boolean }>(r)
      ),
    // public instance config — whether new accounts may register (BF_ALLOW_REGISTER)
    // and where the legal pages (Impressum / Datenschutz) live
    config: () =>
      fetch("/api/auth/config").then((r) =>
        j<{
          allowRegister: boolean;
          siteName?: string;
          siteTagline?: string;
          authBanner?: string;
          hideLegalAndPro?: boolean;
          /** show the "beta test" banner / note (admin switch) */
          betaBanner?: boolean;
          /** whether Pro subscriptions can be bought right now (admin switch) */
          salesOpen?: boolean;
          /** where the workspace (cloud version) lives, e.g. "cloud" → /cloud (§ admin-configurable) */
          cloudPath?: string;
          oauth?: { google?: boolean; github?: boolean };
          // optional Supabase login: the social buttons it should show and
          // whether passwordless e-mail links are offered
          supabase?: { enabled: boolean; providers: { id: string; label: string }[]; magicLink: boolean };
          mailConfigured?: boolean;
          /** a password sign-up must open the e-mailed link before it can log in */
          emailVerificationRequired?: boolean;
        }>(r)
      ),
    /** Ask Supabase to e-mail a sign-in link (passwordless login). */
    magicLink: (email: string) =>
      fetch("/api/auth/supabase/magic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }).then((r) =>
        j<{ ok: boolean; message: string }>(r)
      ),
    /** Start a Supabase-brokered login for one provider (discord, apple, …). */
    supabaseUrl: (provider: string) => `/api/auth/oauth/supabase/start?provider=${encodeURIComponent(provider)}`,
    forgot: (email: string) =>
      fetch("/api/auth/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }).then((r) =>
        j<{ ok: boolean; message: string; resetLink?: string }>(r)
      ),
    reset: (token: string, password: string) =>
      fetch("/api/auth/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }) }).then((r) =>
        j<{ ok: boolean; message: string }>(r)
      ),
    verifyEmail: (token: string) =>
      fetch("/api/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).then((r) =>
        // authed: the link also signed the account in (session cookie set)
        j<{ ok: boolean; emailVerified: boolean; email: string; authed?: boolean; name?: string; role?: string }>(r)
      ),
    /** Re-send the confirmation link from the login card (nobody signed in yet). */
    resendVerificationPublic: (email: string) =>
      fetch("/api/auth/resend-verification-public", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }).then((r) =>
        j<{ ok: boolean; message: string; verifyLink?: string }>(r)
      ),
    resendVerification: () =>
      fetch("/api/auth/resend-verification", { method: "POST" }).then((r) =>
        j<{ ok: boolean; message: string; alreadyVerified?: boolean; verifyLink?: string }>(r)
      ),
    deleteAccount: (password: string) =>
      fetch("/api/auth/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).then((r) =>
        j<{ ok: boolean; message: string }>(r)
      ),
    // Export is a plain download — the browser navigates to it directly.
    exportUrl: () => "/api/auth/export",
    oauthUrl: (provider: "google" | "github") => `/api/auth/oauth/${provider}/start`,
    // Note: Supabase logins use supabaseUrl() above — the provider travels as a
    // query parameter because it selects the Supabase-brokered provider.
    login: (email: string, password: string) =>
      fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }).then((r) =>
        j<{ authed: boolean; email: string; name: string; role?: string }>(r)
      ),
    // verifyRequired: nothing is created yet — the account appears when the e-mailed link is opened
    register: (email: string, password: string, name?: string) =>
      fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      }).then((r) => j<{ authed: boolean; email: string; name: string; verifyRequired?: boolean; message?: string; verifyLink?: string }>(r)),
    logout: () => fetch("/api/auth/logout", { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
    account: (patch: { name?: string; email?: string; current?: string; next?: string }) =>
      fetch("/api/auth/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => j<{ authed: boolean; email: string; name: string; message?: string }>(r)),
  },

  workflows: {
    list: () => fetch("/api/workflows").then((r) => j<Workflow[]>(r)),
    folders: () => fetch("/api/workflows/folders").then((r) => j<WorkflowFolder[]>(r)),
    createFolder: (name: string, parentId?: string) =>
      fetch("/api/workflows/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, parentId: parentId || "" }) }).then((r) => j<WorkflowFolder>(r)),
    renameFolder: (id: string, name: string) =>
      fetch(`/api/workflows/folders/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => j<WorkflowFolder>(r)),
    removeFolder: (id: string) => fetch(`/api/workflows/folders/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    moveToFolder: (id: string, folderId?: string) =>
      fetch(`/api/workflows/${encodeURIComponent(id)}/folder`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folderId: folderId || "" }) }).then((r) => j<Workflow>(r)),
    // Folder sharing — share ONE folder (with the workflows inside it) with
    // another account. An account may only have one shared folder at a time.
    folderShares: () => fetch("/api/workflows/folder-shares").then((r) => j<{ mine: FolderShare[]; incoming: FolderShare[] }>(r)),
    folderShare: (folderId: string) =>
      fetch(`/api/workflows/folders/${encodeURIComponent(folderId)}/share`).then((r) =>
        j<{ folder: { id: string; name: string }; share: FolderShare | null; blockedBy: { folderId: string; folderName: string } | null }>(r)
      ),
    shareFolder: (folderId: string, email: string, includeSubfolders: boolean, role: ShareRole = "editor") =>
      fetch(`/api/workflows/folders/${encodeURIComponent(folderId)}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, includeSubfolders, role }),
      }).then((r) => j<{ ok: boolean; share: FolderShare }>(r)),
    updateFolderShare: (folderId: string, patch: { includeSubfolders?: boolean; role?: ShareRole }) =>
      fetch(`/api/workflows/folders/${encodeURIComponent(folderId)}/share`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => j<{ ok: boolean; share: FolderShare }>(r)),
    unshareFolder: (folderId: string) =>
      fetch(`/api/workflows/folders/${encodeURIComponent(folderId)}/share`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    get: (id: string) => fetch(`/api/workflows/${id}`).then((r) => j<Workflow>(r)),
    create: (wf: Partial<Workflow>) =>
      fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(wf) }).then((r) => j<Workflow>(r)),
    // `manual` marks a deliberate Save click: on a shared workflow the server
    // gives every user one manual save per minute, separate from auto-saves.
    update: (wf: Workflow, opts?: { manual?: boolean }) =>
      fetch(`/api/workflows/${wf.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts?.manual ? { ...wf, manual: true } : wf),
      }).then((r) => j<Workflow>(r)),
    remove: (id: string) => fetch(`/api/workflows/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    // collaboration — give another registered user edit access to a workflow
    share: (id: string, email: string, role: ShareRole = "editor") =>
      fetch(`/api/workflows/${id}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) }).then(
        (r) => j<{ ok: boolean; collaborators: Workflow["collaborators"] }>(r)
      ),
    setRole: (id: string, userId: string, role: ShareRole) =>
      fetch(`/api/workflows/${id}/share/${encodeURIComponent(userId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) }).then(
        (r) => j<{ ok: boolean; collaborators: Workflow["collaborators"] }>(r)
      ),
    // node comments + "who changed what" (server/workflow-collab.js)
    comments: (id: string) => fetch(`/api/workflows/${id}/comments`).then((r) => j<{ comments: WorkflowComment[]; people: WorkflowPerson[]; role: WorkflowRole; me: string }>(r)),
    addComment: (id: string, body: { nodeId?: string | null; parentId?: string; text: string; mentions?: string[] }) =>
      fetch(`/api/workflows/${id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
        j<{ comment: WorkflowComment }>(r)
      ),
    updateComment: (id: string, commentId: string, patch: { text?: string; resolved?: boolean }) =>
      fetch(`/api/workflows/${id}/comments/${encodeURIComponent(commentId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then(
        (r) => j<{ comment: WorkflowComment }>(r)
      ),
    deleteComment: (id: string, commentId: string) =>
      fetch(`/api/workflows/${id}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    history: (id: string) => fetch(`/api/workflows/${id}/history`).then((r) => j<{ entries: WorkflowHistoryEntry[] }>(r)),
    unshare: (id: string, userId: string) =>
      fetch(`/api/workflows/${id}/share/${encodeURIComponent(userId)}`, { method: "DELETE" }).then(
        (r) => j<{ ok: boolean; collaborators: Workflow["collaborators"] }>(r)
      ),
    // End the shared session: the editor sends its current workflow state so
    // every pending change is saved while all collaborators lose access.
    stopSharing: (id: string, payload?: Partial<Workflow>) =>
      fetch(`/api/workflows/${id}/stop-sharing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      }).then((r) => j<{ ok: boolean; collaborators: Workflow["collaborators"] }>(r)),
    // Polled by the editor while open: flips to accessible:false the moment
    // the owner ends the shared session, so the collaborator is thrown out.
    access: (id: string) => fetch(`/api/workflows/${id}/access`).then((r) => j<WorkflowAccess>(r)),
    // The loop running on the server after a Run (server/loop-runner.js).
    loopStatus: (id: string) => fetch(`/api/workflows/${encodeURIComponent(id)}/loop`).then((r) => j<LoopRunStatus>(r)),
    stopLoop: (id: string) => fetch(`/api/workflows/${encodeURIComponent(id)}/loop/stop`, { method: "POST" }).then((r) => j<{ stopped: boolean }>(r)),
    // Shared-editing presence: report which node this user is editing right now
    // and get everyone else's position back (drives the small canvas marker).
    presence: (id: string, nodeId?: string | null, nodeLabel?: string) =>
      fetch(`/api/workflows/${id}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: nodeId || "", nodeLabel: nodeLabel || "" }),
      }).then((r) => j<{ ok: boolean; editing: SharedEditor[] }>(r)),
    clearPresence: (id: string) => fetch(`/api/workflows/${id}/presence`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    run: (id: string, opts?: { payload?: unknown; maxItemsPerNode?: number; runToken?: string; step?: boolean }) =>
      fetch(`/api/workflows/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: opts?.payload, maxItemsPerNode: opts?.maxItemsPerNode, runToken: opts?.runToken, step: opts?.step }),
      }).then((r) => j<ExecResult | WaitingRun>(r)),
    // Debug mode: let a paused run go on — one node, or the rest of the run.
    step: (id: string, runToken: string, action: "next" | "continue") =>
      fetch(`/api/workflows/${id}/run/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runToken, action }),
      }).then((r) => j<{ ok: boolean; message: string }>(r)),
    // Retry a failed run from the node that failed.
    retryExecution: (id: string, execId: string, maxItemsPerNode?: number) =>
      fetch(`/api/workflows/${id}/executions/${encodeURIComponent(execId)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxItemsPerNode }),
      }).then((r) => j<ExecResult>(r)),
    // Failure alerts (e-mail / Telegram) for one workflow.
    alerts: (id: string) => fetch(`/api/workflows/${id}/alerts`).then((r) => j<WorkflowAlertSettings>(r)),
    saveAlerts: (id: string, body: Partial<WorkflowAlertSettings> & { telegramBotToken?: string; clearTelegramBotToken?: boolean }) =>
      fetch(`/api/workflows/${id}/alerts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => j<WorkflowAlertSettings>(r)),
    testAlert: (id: string) => fetch(`/api/workflows/${id}/alerts/test`, { method: "POST" }).then((r) => j<{ ok: boolean; message: string }>(r)),
    // Live per-node progress of a run started from the editor (which node is
    // executing right now). Polled while the run is in flight so a loading
    // ring can be drawn over the current node.
    runStatus: (id: string, runToken: string) =>
      fetch(`/api/workflows/${id}/run/status?token=${encodeURIComponent(runToken)}`).then((r) => j<RunStatus>(r)),
    // Answer a pending "Wait for Approval" node of a live run.
    approval: (id: string, runToken: string, approvalId: string, approved: boolean, reason?: string) =>
      fetch(`/api/workflows/${id}/run/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runToken, approvalId, approved, reason }),
      }).then((r) => j<{ ok: boolean; message: string }>(r)),
    // Stop a live run started from the editor (toolbar Stop button). The run
    // halts after the node currently in flight and resolves with aborted: true.
    stopRun: (id: string, runToken: string) =>
      fetch(`/api/workflows/${id}/run/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runToken }),
      }).then((r) => j<{ ok: boolean; message: string }>(r)),
    // Poll a pending webhook wait (webhook-only workflow where Run is waiting
    // for a real /webhook/:id request). Resolves once the run completes.
    pollWaitingRun: (id: string, waitingId: string) =>
      fetch(`/api/workflows/${id}/run/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waitingId }),
      }).then((r) => j<ExecResult | WaitingRun>(r)),
    cancelWaitingRun: (id: string, waitingId: string) =>
      fetch(`/api/workflows/${id}/run/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waitingId }),
      }).then((r) => j<{ ok: boolean }>(r)),
    // Supply the payload a waiting (non-manual, non-inbound) trigger asked for.
    submitRunInput: (id: string, waitingId: string, payload: unknown) =>
      fetch(`/api/workflows/${id}/run/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waitingId, payload }),
      }).then((r) => j<ExecResult>(r)),
    // Run a Chat-Trigger workflow with one chat message; returns the run result.
    chat: (id: string, message: string, history: ChatMessage[], runToken?: string) =>
      fetch(`/api/workflows/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history, runToken }),
      }).then((r) => j<ExecResult>(r)),
    // Saved run history for the Execution menu (newest first).
    executions: (id: string, limit = 30) =>
      fetch(`/api/workflows/${id}/executions?limit=${limit}`).then((r) => j<ExecutionSummary[]>(r)),
    execution: (id: string, execId: string) =>
      fetch(`/api/workflows/${id}/executions/${encodeURIComponent(execId)}`).then((r) =>
        j<ExecutionSummary & { result: ExecResult }>(r)
      ),
    // Run a single node with a given input (used by "Run next node" to step past
    // a halted node using its manually-set output).
    runNode: (id: string, nodeId: string, input?: unknown) =>
      fetch(`/api/workflows/${id}/run-node`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, input }),
      }).then((r) => j<ExecResult>(r)),
    // Version history — every graph-changing save snapshots the state it left.
    versions: (id: string) =>
      fetch(`/api/workflows/${id}/versions`).then((r) => j<{ versions: WorkflowVersion[]; max: number }>(r)),
    version: (id: string, versionId: string) =>
      fetch(`/api/workflows/${id}/versions/${encodeURIComponent(versionId)}`).then((r) => j<WorkflowVersionFull>(r)),
    restoreVersion: (id: string, versionId: string) =>
      fetch(`/api/workflows/${id}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" }).then((r) => j<Workflow>(r)),
    // Rolling backup buffer (shared workflows) — "rewind 1 minute", the last
    // saves, and the last save this account made.
    backups: (id: string, limit = 10) =>
      fetch(`/api/workflows/${id}/backups?limit=${limit}`).then((r) => j<WorkflowBackupList>(r)),
    restoreBackup: (id: string, backupId: string) =>
      fetch(`/api/workflows/${id}/backups/${encodeURIComponent(backupId)}/restore`, { method: "POST" }).then((r) => j<Workflow>(r)),
  },

  // Curated starter templates (Workflows page → "Start from a template").
  templates: {
    list: () => fetch("/api/templates").then((r) => j<{ categories: string[]; templates: TemplateSummary[] }>(r)),
    get: (id: string) => fetch(`/api/templates/${encodeURIComponent(id)}`).then((r) => j<Template>(r)),
  },

  // AI spending control: budgets + alerts, the usage dashboard, a workflow's cost preview.
  aiBudget: {
    get: () => fetch("/api/ai/budget").then((r) => j<AiBudgetOverview>(r)),
    save: (settings: AiAccountBudget) =>
      fetch("/api/ai/budget", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }).then((r) => j<AiBudgetOverview>(r)),
    testAlert: () => fetch("/api/ai/budget/test-alert", { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
    usage: (days = 30) => fetch(`/api/ai/usage?days=${days}`).then((r) => j<AiUsageDashboard>(r)),
    estimate: (workflowId: string) => fetch(`/api/workflows/${encodeURIComponent(workflowId)}/ai-estimate`).then((r) => j<AiWorkflowEstimate>(r)),
  },

  // AI usage & cost — the account's editable USD-per-1M-token price table.
  aiPrices: {
    get: () => fetch("/api/ai/prices").then((r) => j<AiPriceSettings>(r)),
    save: (table: { prices: Record<string, { input: number; output: number }>; fallback: { input: number; output: number } }) =>
      fetch("/api/ai/prices", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(table) }).then((r) =>
        j<{ prices: Record<string, { input: number; output: number }>; fallback: { input: number; output: number } }>(r)
      ),
  },

  agents: {
    list: () => fetch("/api/agents").then((r) => j<Agent[]>(r)),
    get: (id: string) => fetch(`/api/agents/${id}`).then((r) => j<Agent>(r)),
    create: (a: Partial<Agent>) =>
      fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) }).then((r) => j<Agent>(r)),
    update: (a: Agent) =>
      fetch(`/api/agents/${a.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) }).then((r) => j<Agent>(r)),
    remove: (id: string) => fetch(`/api/agents/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    chat: (id: string, messages: Array<{ role: string; content: string }>) =>
      fetch(`/api/agents/${id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }) }).then((r) =>
        j<{ reply: string; toolRuns: Array<{ name: string; args: string; output: unknown }>; error?: string }>(r)
      ),
  },

  errors: () => fetch("/api/errors").then((r) => j<ErrorCodeEntry[]>(r)),

  // Problem report — e-mailed to the operator's address configured in the
  // admin panel. The Settings UI now sends through the contact form instead;
  // the endpoint is kept for API clients.
  report: (message: string, contact?: string) => {
    const body: { message: string; contact?: string } = { message };
    if (contact) body.contact = contact;
    return fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
      j<{ ok: boolean; message: string }>(r)
    );
  },

  // Contact form (Settings → Contact): the signed-in user's address + message
  // are e-mailed to the operator's configured contact address.
  contact: {
    /** the address messages go to (empty when the operator has not set one) */
    info: () => fetch("/api/contact").then((r) => j<{ to: string }>(r)),
    send: (email: string, message: string) =>
      fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, message }) }).then((r) =>
        j<{ ok: boolean; message: string }>(r)
      ),
  },

  // Workspace statistics for the Main page (production runs, failures, time saved).
  stats: () => fetch("/api/stats").then((r) => j<WorkspaceStats>(r)),

  // AI workflow builder — the agent that writes workflows for you. The model is
  // the user's own: credentials are saved per account (encrypted server-side).
  aiBuilder: {
    settings: () => fetch("/api/ai-builder").then((r) => j<BuilderSettings>(r)),
    save: (config: { provider?: string; baseUrl?: string; model?: string; apiKey?: string }) =>
      fetch("/api/ai-builder", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }).then((r) =>
        j<BuilderSettings>(r)
      ),
    // Forget the stored credentials (the agent is unavailable until they are set again).
    clear: () => fetch("/api/ai-builder", { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    models: (config: { provider?: string; baseUrl?: string; apiKey?: string }) =>
      fetch("/api/ai-builder/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }).then((r) =>
        j<{ ok: boolean; models: string[]; error?: string }>(r)
      ),
    // Send the prompt + the workflow on the canvas; the answer is the new
    // workflow, which the editor imports automatically. `references` are the
    // nodes the user pinned in the editor ("use this node as a reference").
    build: (payload: {
      prompt: string;
      workflow: Workflow;
      history?: Array<{ role: string; content: string }>;
      references?: BuilderReference[];
    }) =>
      fetch("/api/ai-builder/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then((r) =>
        j<BuilderBuildResult>(r)
      ),
  },

  // Credentials vault — per-account secrets stored in SQL, encrypted at rest.
  credentials: {
    list: () => fetch("/api/credentials").then((r) => j<Credential[]>(r)),
    create: (c: { name: string; type: string; fields: Record<string, string> }) =>
      fetch("/api/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) }).then((r) => j<Credential>(r)),
    update: (id: string, c: { name: string; type: string; fields: Record<string, string> }) =>
      fetch(`/api/credentials/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) }).then((r) => j<Credential>(r)),
    remove: (id: string) => fetch(`/api/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  },

  // Connected Google / Microsoft accounts used by nodes (shared/oauth.js).
  connections: {
    list: (provider?: string) =>
      fetch(`/api/connections${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`).then((r) =>
        j<{ providers: Record<string, boolean>; unavailable?: string[]; labels?: Record<string, string>; connections: OAuthConnection[] }>(r)
      ),
    startUrl: (provider: string, nodeType?: string) =>
      `/api/connections/${encodeURIComponent(provider)}/start${nodeType ? `?node=${encodeURIComponent(nodeType)}` : ""}`,
  },

  // My files — the account's own folder the file nodes use (server/disk.js).
  files: {
    list: () => fetch("/api/files").then((r) => j<StoredFilesList>(r)),
    downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,
    // octet-stream on purpose: an uploaded .json must reach the route as raw
    // bytes, not be parsed by the server's global JSON body parser
    upload: (path: string, file: Blob) =>
      fetch(`/api/files/upload?path=${encodeURIComponent(path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      }).then((r) => j<{ ok: boolean; path: string; size: number }>(r)),
    remove: (path: string) => fetch(`/api/files?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  },

  // Connected personal Telegram accounts (server/telegram-accounts.js).
  telegramAccounts: {
    list: () => fetch("/api/telegram/accounts").then((r) => j<{ accounts: OAuthConnection[]; needsApiKeys?: boolean }>(r)),
    login: (body: { apiId?: string; apiHash?: string; phone: string }) =>
      fetch("/api/telegram/accounts/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
        j<{ loginId: string; viaApp: boolean; delivery: TelegramCodeDelivery }>(r)
      ),
    resend: (loginId: string) =>
      fetch("/api/telegram/accounts/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId }) }).then((r) =>
        j<{ delivery: TelegramCodeDelivery }>(r)
      ),
    setupEmail: (loginId: string, email: string) =>
      fetch("/api/telegram/accounts/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId, email }) }).then((r) =>
        j<{ emailPattern: string }>(r)
      ),
    // QR login: `qr` is a PNG data URL of the tg://login link to scan
    qrStart: (body: { apiId?: string; apiHash?: string } = {}) =>
      fetch("/api/telegram/accounts/qr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
        j<{ loginId: string; qr: string; url: string; expiresIn: number }>(r)
      ),
    qrStatus: (loginId: string) =>
      fetch("/api/telegram/accounts/qr/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId }) }).then((r) =>
        j<{ waiting?: boolean; qr?: string; url?: string; expiresIn?: number; needPassword?: boolean; account?: OAuthConnection }>(r)
      ),
    verifyEmail: (loginId: string, code: string) =>
      fetch("/api/telegram/accounts/email/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId, code }) }).then((r) =>
        j<{ delivery: TelegramCodeDelivery }>(r)
      ),
    verify: (body: { loginId: string; code?: string; password?: string }) =>
      fetch("/api/telegram/accounts/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
        j<{ account?: OAuthConnection; needPassword?: boolean }>(r)
      ),
    chats: (id: string) =>
      fetch(`/api/telegram/accounts/${encodeURIComponent(id)}/chats`).then((r) =>
        j<{ chats: Array<{ id: string; type: string; title: string; username: string }> }>(r)
      ),
  },

  // Connected Telegram bots (server/telegram-bots.js).
  telegram: {
    bots: () => fetch("/api/telegram/bots").then((r) => j<{ bots: OAuthConnection[] }>(r)),
    connect: (botToken: string) =>
      fetch("/api/telegram/bots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botToken }) }).then((r) =>
        j<{ bot: OAuthConnection }>(r)
      ),
    chats: (id: string) =>
      fetch(`/api/telegram/bots/${encodeURIComponent(id)}/chats`).then((r) =>
        j<{ chats: Array<{ id: string; type: string; title: string; username: string }> }>(r)
      ),
  },

  // Variables — named values referenced from workflows.
  variables: {
    list: () => fetch("/api/variables").then((r) => j<Variable[]>(r)),
    create: (v: { name: string; value: string; testValue?: string; secret?: boolean }) =>
      fetch("/api/variables", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) }).then((r) => j<Variable>(r)),
    update: (id: string, v: { name?: string; value?: string; testValue?: string; secret?: boolean }) =>
      fetch(`/api/variables/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) }).then((r) => j<Variable>(r)),
    remove: (id: string) => fetch(`/api/variables/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  },

  // Workflows as tools for AI assistants (MCP).
  mcp: {
    info: () => fetch("/api/mcp").then((r) => j<McpInfo>(r)),
    createToken: (opts: { name: string; access: McpAccess; workflows: "all" | string[]; dailyRuns: number }) =>
      fetch("/api/mcp/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) }).then((r) =>
        j<{ token: string; info: McpToken }>(r)
      ),
    updateToken: (id: string, patch: Partial<Pick<McpToken, "name" | "access" | "workflows" | "dailyRuns">>) =>
      fetch(`/api/mcp/token/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) =>
        j<{ info: McpToken }>(r)
      ),
    revokeToken: (id: string) => fetch(`/api/mcp/token/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  },

  // Chart pages written by Dashboard nodes.
  dashboards: {
    list: () => fetch("/api/dashboards").then((r) => j<DashboardSummary[]>(r)),
    remove: (id: string) => fetch(`/api/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  },

  // Data tables — lightweight spreadsheets stored in SQL.
  dataTables: {
    list: () => fetch("/api/data-tables").then((r) => j<DataTable[]>(r)),
    create: (t: { name: string; columns?: string[] }) =>
      fetch("/api/data-tables", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) }).then((r) => j<DataTable>(r)),
    update: (id: string, t: { name?: string; columns?: string[] }) =>
      fetch(`/api/data-tables/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) }).then((r) => j<DataTable>(r)),
    // CSV import — creates a new table, or appends to `tableId` when given.
    importCsv: (t: { csv: string; name?: string; tableId?: string; delimiter?: string; headerRow?: boolean }) =>
      fetch("/api/data-tables/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) }).then((r) =>
        j<{ table: DataTable; imported: number; columns: string[] }>(r)
      ),
    remove: (id: string) => fetch(`/api/data-tables/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    rows: (id: string) => fetch(`/api/data-tables/${encodeURIComponent(id)}/rows`).then((r) => j<DataTableRow[]>(r)),
    addRow: (id: string, data: Record<string, unknown>) =>
      fetch(`/api/data-tables/${encodeURIComponent(id)}/rows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }).then((r) => j<DataTableRow>(r)),
    updateRow: (id: string, rowId: string, data: Record<string, unknown>) =>
      fetch(`/api/data-tables/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) }).then((r) => j<DataTableRow>(r)),
    removeRow: (id: string, rowId: string) =>
      fetch(`/api/data-tables/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  },

  // Every run of any workflow the account owns (global Executions page).
  executions: {
    list: (limit = 50) => fetch(`/api/executions?limit=${limit}`).then((r) => j<ExecutionSummary[]>(r)),
  },

  ai: {
    test: (config: Record<string, unknown>) =>
      fetch("/api/ai/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }).then((r) =>
        j<{ ok: boolean; reply?: string; error?: string }>(r)
      ),
    chat: (config: Record<string, unknown>, messages: Array<{ role: string; content: string }>) =>
      fetch("/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, messages }) }).then((r) =>
        j<{ text: string; error?: string }>(r)
      ),
    // Fetch the models a provider exposes using the user's own base URL + key,
    // so the model dropdown is always up to date. Falls back to the static
    // catalog list on error (the server returns ok:false in that case).
    models: (config: Record<string, unknown>) =>
      fetch("/api/ai/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }).then((r) =>
        j<{ ok: boolean; models: string[]; error?: string }>(r)
      ),
  },

  // Self-hosted installer (Pro) — a one-file installer that brings the whole
  // builder onto the user's own machine (Settings → Defaults).
  selfhosted: {
    info: () => fetch("/api/selfhosted").then((r) => j<SelfhostStatus>(r)),
    // plain download URL: the browser saves the script, the script pulls the app
    // and asks the setup questions (folder, port, execution target, storage)
    installerUrl: (os: "windows" | "mac" | "linux") => `/api/selfhosted/installer?os=${os}`,
  },

  // Self-hosted licence. In the cloud: the account's key. On a copy: its
  // licence state, a pasted key, a fresh check (server/license.js).
  license: {
    status: () => fetch("/api/license").then((r) => j<LicenseState>(r)),
    setKey: (key: string) =>
      fetch("/api/license/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }).then((r) => j<{ ok: boolean; error: string; status: LicenseState }>(r)),
    refresh: () => fetch("/api/license/refresh", { method: "POST" }).then((r) => j<LicenseState>(r)),
    myKey: () => fetch("/api/selfhosted/license").then((r) => j<{ key: string; plan?: string; seats?: number }>(r)),
    rotate: () => fetch("/api/selfhosted/license/rotate", { method: "POST" }).then((r) => j<{ key: string }>(r)),
  },

  // Move a self-hosted account to the cloud (server/migrate.js): the cloud
  // makes a one-time code, the copy sends its data with it.
  migrate: {
    code: () => fetch("/api/migrate/code", { method: "POST" }).then((r) => j<{ code: string; expiresAt: number }>(r)),
    send: (code: string, cloudUrl?: string) =>
      fetch("/api/migrate/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, cloudUrl }) }).then((r) => j<MoveResult>(r)),
  },

  // One-click update of a self-hosted copy (server/updater.js).
  update: {
    status: () => fetch("/api/update").then((r) => j<UpdateStatus>(r)),
    check: () => fetch("/api/update/check", { method: "POST" }).then((r) => j<UpdateStatus>(r)),
    apply: () => fetch("/api/update/apply", { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  },

  // Team admin of a self-hosted copy (instance owner only).
  team: {
    get: () => fetch("/api/team").then((r) => j<TeamOverview>(r)),
    update: (patch: { restrict?: Record<string, boolean>; poolCredentials?: string[]; poolVariables?: string[]; allowedHosts?: string[] }) =>
      fetch("/api/team", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) => j<TeamOverview>(r)),
  },

  // Instance setup (Setup page, /setup): where this copy keeps its data and
  // where its workflow runs execute. Owner-only — the server answers 403 to
  // every other account.
  setup: {
    get: () => fetch("/api/setup").then((r) => j<SetupState>(r)),
    save: (body: {
      storage?: { engine: "sqlite" | "postgres"; sqlitePath?: string; databaseUrl?: string };
      execution?: { mode: "local" | "remote"; remoteUrl?: string; remoteToken?: string; acceptRuns?: boolean; runnerToken?: string };
    }) =>
      fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
        j<{ ok: boolean; changed: string[]; restartRequired: boolean; runnerToken?: string; setup: SetupState }>(r)
      ),
    /** Try a PostgreSQL connection before saving it. */
    testDb: (databaseUrl: string) =>
      fetch("/api/setup/test-db", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ databaseUrl }) }).then((r) =>
        j<SetupTestResult>(r)
      ),
    /** Ask a remote runner whether it accepts runs with this token. */
    testRunner: (url: string, token: string) =>
      fetch("/api/setup/test-runner", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, token }) }).then((r) =>
        j<SetupTestResult>(r)
      ),
  },

  billing: {
    // the paying/non-paying state of your account + whether Stripe is wired up
    status: () => fetch("/api/billing").then((r) => j<BillingStatus>(r)),
    // the custom Team plan: request → operator approval → purchase
    team: () => fetch("/api/billing/team").then((r) => j<TeamPlanInfo>(r)),
    requestTeam: (body: { seats: number; company: string; message: string }) =>
      fetch("/api/billing/team/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<{ ok: boolean; team: TeamPlan }>(r)),
    teamCheckout: () => fetch("/api/billing/team/checkout", { method: "POST" }).then((r) => j<{ url: string }>(r)),
    teamMembers: (members: string[]) =>
      fetch("/api/billing/team/members", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ members }) }).then((r) =>
        j<{ ok: boolean; team: TeamPlan }>(r)
      ),
    // create a Stripe Checkout Session and get its hosted checkout URL
    checkout: () =>
      fetch("/api/billing/checkout", { method: "POST" }).then((r) => j<{ url: string }>(r)),
    // buy the same Pro plan with crypto — returns the hosted NOWPayments invoice URL
    cryptoCheckout: () =>
      fetch("/api/billing/crypto/checkout", { method: "POST" }).then((r) => j<{ url: string }>(r)),
    // Stripe Billing Portal: update the card, view invoices, cancel — self-service
    portal: () => fetch("/api/billing/portal", { method: "POST" }).then((r) => j<{ url: string }>(r)),
    // cancel at the end of the paid period / undo that cancellation
    cancel: () =>
      fetch("/api/billing/cancel", { method: "POST" }).then((r) =>
        j<{ ok: boolean; cancelAtPeriodEnd: boolean; periodEnd: number }>(r)
      ),
    resume: () =>
      fetch("/api/billing/resume", { method: "POST" }).then((r) =>
        j<{ ok: boolean; cancelAtPeriodEnd: boolean; periodEnd: number }>(r)
      ),
  },

  // Community social layer: feed with ranking/paging, a detail page with the
  // comment thread, likes, bookmarks and (for the author) removal.
  community: {
    list: async (opts?: {
      q?: string;
      mine?: boolean;
      saved?: boolean;
      author?: string;
      sort?: CommunitySort;
      limit?: number;
      offset?: number;
    }): Promise<CommunityListResult> => {
      const params = new URLSearchParams({ q: opts?.q || "" });
      if (opts?.mine) params.set("mine", "1");
      if (opts?.saved) params.set("saved", "1");
      if (opts?.author) params.set("author", opts.author);
      params.set("sort", opts?.sort || "newest");
      params.set("limit", String(opts?.limit ?? 50));
      params.set("offset", String(opts?.offset ?? 0));
      const r = await fetch(`/api/community?${params}`);
      const posts = await j<CommunityPost[]>(r);
      const total = Number(r.headers.get("X-Total-Count"));
      return { posts, total: Number.isFinite(total) ? total : posts.length };
    },
    get: (id: string) => fetch(`/api/community/${encodeURIComponent(id)}`).then((r) => j<CommunityPostDetail>(r)),
    publish: (wf: {
      workflowId: string;
      title: string;
      description?: string;
      visibility?: "public" | "private" | "restricted";
      allowedUsers?: string[];
      anonymous?: boolean;
    }) =>
      fetch("/api/community", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(wf) }).then((r) =>
        j<CommunityPost>(r)
      ),
    remove: (id: string) => fetch(`/api/community/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
    import: (id: string) =>
      fetch(`/api/community/${id}/import`, { method: "POST" }).then((r) => j<Workflow>(r)),
    // engagement — every call returns the fresh state so the UI can patch in place
    like: (id: string) =>
      fetch(`/api/community/${id}/like`, { method: "POST" }).then((r) => j<{ liked: boolean; likeCount: number }>(r)),
    save: (id: string) =>
      fetch(`/api/community/${id}/save`, { method: "POST" }).then((r) => j<{ saved: boolean; saveCount: number }>(r)),
    comment: (id: string, text: string) =>
      fetch(`/api/community/${id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }).then((r) => j<CommunityComment & { commentCount: number }>(r)),
    removeComment: (id: string, commentId: string) =>
      fetch(`/api/community/${id}/comments/${commentId}`, { method: "DELETE" }).then((r) =>
        j<{ ok: boolean; commentCount: number }>(r)
      ),
  },

  // User profiles: the editable own profile and the public profile of others.
  profile: {
    me: () => fetch("/api/profile").then((r) => j<UserProfile>(r)),
    update: (patch: Partial<Pick<UserProfile, "displayName" | "bio" | "location" | "website" | "avatar" | "anonymousByDefault">>) =>
      fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => j<UserProfile>(r)),
    get: (userId: string) => fetch(`/api/profile/${encodeURIComponent(userId)}`).then((r) => j<PublicProfile>(r)),
  },
};
