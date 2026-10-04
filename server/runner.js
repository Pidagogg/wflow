// ============================================================================
// W FLOW — remote execution (the "runner")
//
// A workflow run can happen on another server the owner controls — typically
// their own VPS — while the builder (UI + database) stays where it is. Both
// sides run the very same app:
//
//   Builder  WFLOW_REMOTE_URL + WFLOW_REMOTE_TOKEN → every run is sent to that
//            URL instead of executing here. The run's live progress is streamed
//            back over the same HTTP response (NDJSON), so the editor's node
//            ring, Stop button and run log behave exactly as they do locally.
//            The workflow, its sub-workflows, the agents it uses and its
//            credentials travel with the request; the runner stores nothing.
//
//   Runner   WFLOW_RUNNER_TOKEN → this copy ACCEPTS runs from a builder that
//            presents that token. Without the token every /api/runner request
//            is refused, so an instance that never opted in can never be used as
//            somebody else's execution host.
//
// What cannot run remotely: nodes that pause for a human (Wait for Approval,
// Chat Trigger). A run that contains one is refused with a clear message
// instead of hanging forever — see interactiveNodes().
// ============================================================================
import { timingSafeEqual } from "node:crypto";
import { executeWorkflow } from "./executor.js";
import { workflows, agents, hydrateSecretsInWorkflow, hydrateAgentSecrets } from "./store.js";
import { db } from "./dbx.js";
import { licenseRequired, licenseActive, licenseStatus } from "./license.js";
import { attachCode } from "../shared/errors.js";
import { acceptsRemoteRuns, remoteEnabled, remoteTarget, runnerToken, standaloneMode } from "./setup.js";
import { beginRunning, noteRunningNode, finishRunning } from "./running-executions.js";
import { loadRunVars, normalizeEnvironment } from "./run-context.js";

/** How deep Execute Sub-Workflow nodes are followed when bundling a run. */
const MAX_BUNDLE_DEPTH = 3;
/** Node types that need a human in the loop — impossible on a remote runner. */
const INTERACTIVE_TYPES = new Set(["approval", "chatTrigger"]);

/** The ctx keys a run may hand to another instance (never signals/functions). */
// `vars` travel resolved: the runner has its own database and could not look
// up the builder's Variables itself.
const REMOTE_CTX_KEYS = ["webhookPayload", "triggerPayload", "webhookResponse", "runInput", "maxItemsPerNode", "subflowDepth", "userId", "vars", "environment", "resumeFrom"];

/**
 * Nodes in this workflow that wait for a person. A remote runner has no editor
 * open, so these are refused before anything is dispatched.
 */
export function interactiveNodes(workflow) {
  return (workflow?.nodes || [])
    .filter((n) => INTERACTIVE_TYPES.has(String(n.type)))
    .map((n) => ({ id: n.id, type: n.type, label: n.data?.label || n.type }));
}

/** Is this instance configured to send its runs somewhere else? */
export function isRemoteRun() {
  return remoteEnabled();
}

/** Short description of where runs currently happen, for the UI. */
export function executionTargetLabel() {
  const { url } = remoteTarget();
  return remoteEnabled() ? url : "this machine";
}

// ---------------------------------------------------------------------------
// What travels with a remote run
// ---------------------------------------------------------------------------

/**
 * Everything the runner needs to execute `workflow` without a database: the
 * sub-workflows it calls (with their own credentials re-injected) and the saved
 * AI agents it uses. Depth-limited so a cycle can never grow the payload
 * forever.
 */
export async function collectBundles(workflow, userId, depth = 0, into = { subWorkflows: {}, agents: {} }) {
  if (!workflow || depth > MAX_BUNDLE_DEPTH) return into;

  for (const node of workflow.nodes || []) {
    const config = node.data?.config || {};
    if (node.type === "subworkflow") {
      const targetId = String(config.workflowId || "");
      if (!targetId || into.subWorkflows[targetId] || targetId === workflow.id) continue;
      const stored = userId ? await workflows.getOwned(targetId, userId) : await workflows.get(targetId);
      if (!stored) continue;
      const hydrated = userId ? await hydrateSecretsInWorkflow(stored, await db.getWorkflowSecrets(targetId)) : stored;
      into.subWorkflows[targetId] = hydrated;
      await collectBundles(hydrated, userId, depth + 1, into);
    } else if (node.type === "aiAgent" && String(config.agentSource || "") === "saved") {
      const agentId = String(config.agentId || "");
      if (!agentId || into.agents[agentId]) continue;
      const stored = userId ? agents.getOwned(agentId, userId) : agents.get(agentId);
      if (!stored) continue;
      into.agents[agentId] = await hydrateAgentSecrets(stored, await db.getAgentSecrets(agentId));
    }
  }
  return into;
}

// ---------------------------------------------------------------------------
// The runner side: /api/runner
// ---------------------------------------------------------------------------

function tokenMatches(provided) {
  const expected = runnerToken();
  const got = String(provided || "").trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Header or body field — curl users usually send the header. */
function providedToken(req) {
  return req.get?.("x-wflow-runner-token") || req.body?.token || "";
}

/** What `GET /api/runner/ping` answers: enough to identify the target. */
export function runnerPingPayload() {
  return {
    ok: true,
    app: "w-flow",
    role: standaloneMode() ? "standalone runner" : "runner",
    acceptsRuns: acceptsRemoteRuns(),
  };
}

/** Ask another instance whether it accepts runs with this token (Setup → Test). */
export async function testRunner(url, token) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  const secret = String(token || "").trim();
  if (!base) return { ok: false, message: "Enter the runner's address first." };
  if (!/^https?:\/\//i.test(base)) return { ok: false, message: "The runner URL must start with http:// or https://" };
  try {
    const res = await fetch(`${base}/api/runner/ping`, {
      headers: secret ? { "x-wflow-runner-token": secret } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, message: String(data?.error || `The runner answered ${res.status}.`) };
    }
    return { ok: true, message: `Runner reachable — ${data?.app || "w-flow"} (${data?.role || "runner"}).` };
  } catch (err) {
    return { ok: false, message: `Could not reach the runner: ${String(err.message || err)}` };
  }
}

/**
 * Mount the two runner endpoints. Both are token-gated; an instance with no
 * WFLOW_RUNNER_TOKEN answers 403 and says how to become a runner, so an
 * operator's instance is never usable as a free execution host.
 */
export function mountRunnerRoutes(app) {
  const guard = (req, res, next) => {
    if (!acceptsRemoteRuns()) {
      return res.status(403).json({
        error:
          "This instance does not accept remote runs. Turn on “Accept runs from a remote builder” in its Setup page to create a runner token.",
      });
    }
    if (!tokenMatches(providedToken(req))) {
      return res.status(401).json({ error: "The runner token is missing or wrong." });
    }
    next();
  };

  app.get("/api/runner/ping", guard, (_req, res) => res.json(runnerPingPayload()));

  // Body: { workflow, ctx?, subWorkflows?, agents? } — the answer is a stream of
  // NDJSON events so the builder can mirror the run live:
  //   {"t":"node","nodeId":"..."}   a node started
  //   {"t":"done","result":{...}}   the finished run (same shape as a local run)
  //   {"t":"error","message":"..."} the run failed before producing a result
  app.post("/api/runner/execute", guard, async (req, res) => {
    const workflow = req.body?.workflow;
    if (!workflow || !Array.isArray(workflow.nodes)) {
      return res.status(400).json({ error: "A workflow object is required." });
    }
    const blocked = interactiveNodes(workflow);
    if (blocked.length) {
      return res.status(400).json({
        error: `This workflow needs a person at “${blocked[0].label}”, which a remote runner cannot provide. Run it on the builder instead.`,
      });
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-store");
    res.flushHeaders?.();

    // A builder that presses Stop (or closes the tab) aborts its request — stop
    // the run here too, at the next node boundary.
    const controller = new AbortController();
    let closed = false;
    req.on("close", () => {
      closed = true;
      controller.abort();
    });

    const send = (event) => {
      if (closed) return;
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch {
        /* the socket went away */
      }
    };

    const incoming = req.body?.ctx && typeof req.body.ctx === "object" ? req.body.ctx : {};
    const ctx = {};
    for (const key of REMOTE_CTX_KEYS) {
      if (incoming[key] !== undefined) ctx[key] = incoming[key];
    }
    ctx.subWorkflows = req.body?.subWorkflows && typeof req.body.subWorkflows === "object" ? req.body.subWorkflows : {};
    ctx.agents = req.body?.agents && typeof req.body.agents === "object" ? req.body.agents : {};
    ctx.signal = controller.signal;
    ctx.onNodeStart = (nodeId) => send({ t: "node", nodeId });

    try {
      const result = await executeWorkflow(workflow, ctx);
      send({ t: "done", result });
    } catch (err) {
      send({ t: "error", message: String(err?.message || err) });
    } finally {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The builder side: dispatch a run to the runner
// ---------------------------------------------------------------------------

/**
 * Send one run to another instance and mirror its progress locally. `ctx` is
 * the builder's own run context; only its serializable keys travel, plus the
 * bundles collected from the database.
 */
async function executeRemote(workflow, ctx = {}) {
  const { url, token } = remoteTarget();
  const environment = normalizeEnvironment(ctx.environment ?? workflow.environment);
  if (!ctx.vars) ctx = { ...ctx, environment, vars: await loadRunVars(ctx.userId, environment) };
  const payloadCtx = {};
  for (const key of REMOTE_CTX_KEYS) {
    if (ctx[key] !== undefined) payloadCtx[key] = ctx[key];
  }
  const bundles = await collectBundles(workflow, ctx.userId);
  const body = JSON.stringify({ workflow, ctx: payloadCtx, subWorkflows: bundles.subWorkflows, agents: bundles.agents });

  // Stop on the builder aborts the network request, which aborts the run there.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (ctx.signal) {
    if (ctx.signal.aborted) throw new Error("The run was stopped before it started.");
    ctx.signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const res = await fetch(`${url}/api/runner/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wflow-runner-token": token },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {
        /* keep the raw body */
      }
      throw new Error(`The remote runner refused the run (${res.status}): ${message || "no reason given"}`);
    }

    // NDJSON — one JSON event per line, so progress arrives while the run is
    // still going instead of after it finished.
    const reader = res.body?.getReader?.();
    if (!reader) {
      // No streaming body (an old proxy, a runner that answered all at once) —
      // parse the same NDJSON from the whole response.
      const text = await res.text();
      let plain = null;
      let plainError = null;
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const event = parseEvent(line);
        if (!event) continue;
        if (event.t === "node") ctx.onNodeStart?.(event.nodeId);
        else if (event.t === "done") plain = event.result;
        else if (event.t === "error") plainError = event.message;
      }
      if (plainError) throw new Error(plainError);
      if (!plain) throw new Error("The remote runner returned nothing usable.");
      return plain;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;
    let failure = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const event = parseEvent(line);
        if (!event) continue;
        if (event.t === "node") ctx.onNodeStart?.(event.nodeId);
        else if (event.t === "done") result = event.result;
        else if (event.t === "error") failure = event.message;
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const event = parseEvent(tail);
      if (event?.t === "done") result = event.result;
      else if (event?.t === "error") failure = event.message;
    }

    if (failure) throw new Error(failure);
    if (!result) throw new Error("The remote run ended without a result — check the runner's log.");
    return result;
  } catch (err) {
    if (err?.name === "AbortError") {
      // The Stop button: report a stopped run the way a local abort does.
      return { aborted: true, log: [], consoleLog: ["■ run stopped"], success: false, nodeCount: workflow.nodes?.length || 0, errorCount: 0 };
    }
    throw err;
  } finally {
    ctx.signal?.removeEventListener?.("abort", forwardAbort);
  }
}

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Run a workflow: on the remote runner when one is configured, otherwise here.
 * Every server-side entry point (editor Run, webhook, schedule, Telegram,
 * sub-workflow) goes through this, so “where do my runs happen” is one setting.
 */
export async function executeRouted(workflow, ctx = {}) {
  // A self-hosted copy whose licence lapsed runs nothing — every entry point
  // (editor, webhook, schedule, Telegram, sub-workflow) passes through here.
  if (licenseRequired() && !(await licenseActive())) {
    const { reason } = await licenseStatus();
    throw attachCode(new Error(reason || "This self-hosted copy has no active licence."), "LICENSE_INACTIVE");
  }
  // A run that will be saved (the caller names its `source`) is listed as
  // running while it executes; its id becomes the saved execution's id. A run
  // answering a Run-button trigger wait passes that wait's id as executionId.
  if (!ctx.source) return executeHere(workflow, ctx);
  const id = beginRunning(workflow, { source: ctx.source, ownerId: ctx.userId, id: ctx.executionId });
  const onNodeStart = ctx.onNodeStart;
  const tracked = {
    ...ctx,
    onNodeStart: (nodeId) => {
      noteRunningNode(id, nodeId);
      onNodeStart?.(nodeId);
    },
  };
  try {
    const result = await executeHere(workflow, tracked);
    if (result && typeof result === "object") result.executionId = id;
    finishRunning(id);
    return result;
  } catch (err) {
    finishRunning(id, { awaitRecord: false });
    throw err;
  }
}

function executeHere(workflow, ctx) {
  if (!remoteEnabled()) return executeWorkflow(workflow, ctx);

  const blocked = interactiveNodes(workflow);
  if (blocked.length) {
    throw new Error(
      `Runs execute on your remote runner, which cannot wait for a person at “${blocked[0].label}”. ` +
        "Switch execution back to this machine in Setup, or remove that node."
    );
  }
  return executeRemote(workflow, ctx);
}
