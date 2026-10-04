// ============================================================================
// W FLOW — database facade
//
// Picks the backend once at startup:
//   - DATABASE_URL set  → PostgreSQL (server/pg.js, async functions)
//   - otherwise         → SQLite built into Node (server/db.js, sync functions)
//
// Both expose the same function names. Call sites use `await`, which works for
// either backend (awaiting a synchronous SQLite result is a no-op).
// ============================================================================
import "./env.js"; // .env must be loaded before DATABASE_URL is read below
import * as sqliteDb from "./db.js";
import * as pgDb from "./pg.js";
import { instrument } from "./journal.js";

// An explicitly configured SQLite file wins over DATABASE_URL: BF_DB_PATH names
// one exact database file ("use this one"), which is how the test suite and
// second instances point the app at their own data. Without that rule a
// developer .env that also sets DATABASE_URL would silently send every
// BF_DB_PATH-isolated test run into the shared cloud database, where the runs
// overwrite each other's accounts, workflows and quota counters.
export const usingPostgres = !!process.env.DATABASE_URL && !process.env.BF_DB_PATH;
// The raw backend (no journaling) — used by the journal/backup modules so they
// can write without recording themselves.
export const rawDb = usingPostgres ? pgDb : sqliteDb;
// The shared facade every other module imports: identical to the backend, but
// each call is recorded in the db_events journal (batched, best-effort).
export const db = instrument(rawDb);
export const databaseEngine = usingPostgres ? "postgres" : "sqlite";

// Convenience re-exports used by the executor / admin panel. `await` works for
// both the synchronous SQLite implementations and the async PostgreSQL ones.
export const runSql = (sql, params = {}) => db.runSql(sql, params);

// Workflow SQL is read-only: the SQL Query node may only run queries that read
// data (SELECT / WITH / VALUES / EXPLAIN). Anything that can change the
// database — INSERT / UPDATE / DELETE / DDL / transactions / write pragmas —
// is rejected, because this database also holds user accounts, sessions and
// secrets, and a workflow can be triggered by a public webhook. The check is
// lexical (comment/string/identifier aware): the first keyword must be a read
// verb and no write verb may appear anywhere in the statement, so sneaking a
// write past a WITH prefix is blocked too. The admin panel's SQL console is
// unaffected — it calls db.runSql directly.
const WRITE_SQL_VERBS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|DETACH|VACUUM|REINDEX|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i;
export function isReadOnlySql(sql) {
  const stripped = String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block comments */
    .replace(/--[^\n]*/g, " ") // -- line comments
    .replace(/'([^'\\]|\\.|'')*'/g, " ") // 'string literals'
    .replace(/"([^"\\]|\\.|"")*"/g, " ") // "identifiers"
    .replace(/`[^`]*`/g, " ") // `backtick identifiers`
    .replace(/\[[^\]]*\]/g, " "); // [bracketed identifiers]
  const first = (stripped.match(/\b([A-Za-z]+)\b/) || [])[1] || "";
  return /^(SELECT|WITH|VALUES|EXPLAIN)$/i.test(first) && !WRITE_SQL_VERBS.test(stripped);
}
export const storeGet = (key) => db.storeGet(key);
export const storeSet = (key, value, opts) => db.storeSet(key, value, opts);
export const storeDelete = (key) => db.storeDelete(key);
export const closeDb = () => db.closeDb?.();

// Public-domain value for the landing page / SEO files: lowercased host with
// scheme and paths stripped, validated to a plain DNS-ish hostname. Used by
// the admin panel (save) and the main server (substitution), which run as
// separate processes, so it lives here next to the other shared helpers.
export function sanitizeSiteDomain(raw) {
  let d = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // strip https:// / http://
    .split(/[/?#]/)[0] // strip any path / query
    .replace(/\.+$/, ""); // strip trailing dots
  if (d === "localhost") return d;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return "";
  return d;
}
