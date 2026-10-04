// ============================================================================
// W FLOW — per-run context (variables + environment)
//
// A run can reference the owner's Variables as {{$vars.NAME}} anywhere a node
// renders templates. Threading the values through every renderTemplate call
// site (hundreds of them, plus the service engine) would touch half the
// executor, so the current run's values live in an AsyncLocalStorage that the
// template renderers consult. Concurrent runs each see their own values.
//
// Environments: a workflow set to "test" uses each variable's test value
// (when one is set) instead of its live value, and every node that moves money
// (exchange orders, wallet transfers) is forced into its test mode — one switch
// flips a whole workflow between testnet keys and real trading.
// ============================================================================
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./dbx.js";
import { withPooledVariables } from "./team-admin.js";

const store = new AsyncLocalStorage();

export const ENVIRONMENTS = ["live", "test"];

export function normalizeEnvironment(value) {
  return value === "test" ? "test" : "live";
}

/** The variables a run sees: name → value, picking test values in the test environment. */
export async function loadRunVars(userId, environment = "live") {
  if (!userId) return {};
  try {
    // On a self-hosted team copy the admin's shared variables join in.
    const rows = await withPooledVariables(userId, (await db.variablesList(userId)) || []);
    const vars = {};
    for (const v of rows || []) {
      const useTest = environment === "test" && String(v.testValue ?? "") !== "";
      vars[v.name] = useTest ? v.testValue : v.value;
    }
    return vars;
  } catch {
    return {}; // variables are optional — a lookup failure must not break a run
  }
}

/** Run `fn` with this run's variables and environment available to templates. */
export function withRunContext(context, fn) {
  // `ai` is the run's spending-control slot (server/ai-budget.js): who owns the
  // run, which node is running, where its log lines go. A sub-workflow run
  // shares its caller's slot, so the caller's budget covers both.
  // `filesOwner` is whose folder the file nodes use (server/disk.js); a
  // sub-workflow works in its caller's folder the same way.
  const parent = store.getStore();
  const ai = parent?.ai || context.ai || null;
  const filesOwner = parent?.filesOwner || context.filesOwner || "";
  return store.run({ vars: context.vars || {}, environment: normalizeEnvironment(context.environment), ai, filesOwner }, fn);
}

export function currentRunContext() {
  return store.getStore() || { vars: {}, environment: "live" };
}

/**
 * Resolve a template path that starts with `$vars.` / `$env`. Returns
 * undefined for any other path so the caller falls back to the item's fields.
 */
export function resolveRunPath(path) {
  if (path === "$env") return currentRunContext().environment;
  if (!path.startsWith("$vars.")) return undefined;
  const value = currentRunContext().vars[path.slice(6)];
  return value === undefined ? "" : value;
}

/** True when the current run belongs to a workflow in the test environment. */
export function inTestEnvironment() {
  return currentRunContext().environment === "test";
}
