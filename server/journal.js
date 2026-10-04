// ============================================================================
// W FLOW — database events journal
//
// Every contact with the database (through the db facade in server/dbx.js) is
// recorded here and flushed to the `db_events` table in batches. The journal
// answers "what touched the database, when and how fast" for the admin panel's
// Journal tab, and its rows live in the same database, so a database backup
// carries the journal with it.
//
// Design notes
// - Writes are batched (default every 1 s) so a burst of reads does not turn
//   into one INSERT per request. Failures are swallowed: auditing must never
//   break a request or take the server down.
// - The journal writes through the RAW backend module (db.js / pg.js) directly,
//   never through the proxied facade, so it cannot journal itself.
// - Retention is configurable (BF_JOURNAL_RETENTION_DAYS, default 7) and pruned
//   on a timer. Disable entirely with BF_JOURNAL=0.
// - Argument summaries never include secret values: string args are truncated
//   and anything that looks like a credential is replaced with a marker.
// ============================================================================
import "./env.js";
import * as sqliteBackend from "./db.js";
import * as pgBackend from "./pg.js";

const backend = process.env.DATABASE_URL ? pgBackend : sqliteBackend;

const ENABLED = process.env.BF_JOURNAL !== "0" && process.env.BF_JOURNAL !== "false";
const FLUSH_MS = Math.max(250, Number(process.env.BF_JOURNAL_FLUSH_MS) || 1000);
const RETENTION_MS = Math.max(60_000, (Number(process.env.BF_JOURNAL_RETENTION_DAYS) || 7) * 24 * 60 * 60_000);
const MAX_BUFFER = 5000; // hard cap so a broken DB cannot grow memory without bound

// Which process is doing the writing — shown in the journal.
export const SOURCE =
  process.env.BF_JOURNAL_SOURCE ||
  (String(process.argv[1] || "").includes("admin.js") ? "admin" : "server");

// Best-effort mapping from a db facade function name to the table it touches.
const TABLE_HINTS = [
  [/credential/i, "user_credentials"],
  [/variable/i, "variables"],
  [/dataTables|dataTableRow|data_table/i, "data_tables"],
  [/execution/i, "executions"],
  [/workflow/i, "workflows"],
  [/agent/i, "agents"],
  [/subscription/i, "subscriptions"],
  [/usage/i, "usage_runs"],
  [/activity/i, "user_activity"],
  [/alert/i, "alerts"],
  [/journal/i, "db_events"],
  [/admin/i, "admin_user"],
  [/session/i, "user_sessions"],
  [/signup/i, "pending_signups"],
  [/token/i, "auth_tokens"],
  [/store/i, "settings"],
  [/user/i, "users"],
];

function targetFor(op) {
  for (const [re, table] of TABLE_HINTS) if (re.test(op)) return table;
  return "";
}

// Ops whose arguments must never be printed verbatim. "store" covers the
// encrypted settings store, which is where the AI builder agent keeps the
// account's model credentials.
const SECRET_OP = /pass|secret|token|credential|apikey|api_key|encrypt|store/i;

// A privacy-safe one-line summary of the call arguments: type + size only.
function summarize(op, args) {
  if (!args || !args.length) return "";
  const parts = [];
  for (const a of args.slice(0, 4)) {
    if (a === null) parts.push("null");
    else if (a === undefined) parts.push("undef");
    else if (typeof a === "string") {
      if (SECRET_OP.test(op)) parts.push(`str(${a.length})`);
      else parts.push(a.length > 64 ? `str(${a.length})` : JSON.stringify(a));
    } else if (typeof a === "number" || typeof a === "boolean") parts.push(String(a));
    else if (Array.isArray(a)) parts.push(`array(${a.length})`);
    else if (typeof a === "object") parts.push(`obj(${Object.keys(a).length})`);
    else parts.push(typeof a);
  }
  return parts.join(", ").slice(0, 400);
}

let buffer = [];
let flushTimer = null;
let flushing = false;
let prunedAt = 0;

async function flush() {
  if (flushing || !buffer.length) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    await backend.journalInsert(batch);
  } catch (err) {
    // Drop the batch rather than retry forever — a failing journal must not
    // become a memory leak or a crash loop.
    console.error("[journal] flush failed:", err?.message || err);
  } finally {
    flushing = false;
    if (buffer.length) schedule();
  }
}

function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_MS);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

async function prune() {
  if (Date.now() - prunedAt < 60 * 60_000) return;
  prunedAt = Date.now();
  try {
    await backend.journalPrune(RETENTION_MS);
  } catch {
    /* best effort */
  }
}

/** Record one database contact. Never throws, never blocks. */
export function record(event) {
  if (!ENABLED) return;
  try {
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push({
      ts: Date.now(),
      source: event?.source || SOURCE,
      actor: event?.actor || "",
      op: String(event?.op || "unknown").slice(0, 120),
      target: event?.target || targetFor(String(event?.op || "")),
      detail: String(event?.detail || "").slice(0, 400),
      durationMs: Number(event?.durationMs || 0),
      ok: event?.ok !== false,
    });
    schedule();
    prune();
  } catch {
    /* auditing must never break anything */
  }
}

/** Wrap a raw db module so every function call is journalled. */
export function instrument(module) {
  const skip = new Set(["journalInsert", "journalList", "journalPrune", "journalCount"]);
  return new Proxy(module, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || skip.has(prop)) return value;
      return function instrumented(...args) {
        const t0 = Date.now();
        const op = prop;
        try {
          const result = value.apply(target, args);
          if (result && typeof result.then === "function") {
            return result.then(
              (r) => {
                record({ op, detail: summarize(op, args), durationMs: Date.now() - t0, ok: true });
                return r;
              },
              (err) => {
                record({ op, detail: summarize(op, args), durationMs: Date.now() - t0, ok: false });
                throw err;
              }
            );
          }
          record({ op, detail: summarize(op, args), durationMs: Date.now() - t0, ok: true });
          return result;
        } catch (err) {
          record({ op, detail: summarize(op, args), durationMs: Date.now() - t0, ok: false });
          throw err;
        }
      };
    },
  });
}

export function journalEnabled() {
  return ENABLED;
}

export async function journalStats() {
  try {
    return { enabled: ENABLED, source: SOURCE, buffered: buffer.length, total: await backend.journalCount() };
  } catch {
    return { enabled: ENABLED, source: SOURCE, buffered: buffer.length, total: 0 };
  }
}

export async function flushJournal() {
  await flush();
}

// Make sure a clean shutdown does not lose buffered events.
process.on("beforeExit", () => {
  try {
    if (buffer.length) backend.journalInsert(buffer.splice(0));
  } catch {
    /* ignore */
  }
});
