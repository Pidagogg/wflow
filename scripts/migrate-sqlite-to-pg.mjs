#!/usr/bin/env node
// ============================================================================
// W FLOW — SQLite → PostgreSQL migration
//
// Copies every row of the built-in SQLite database (./data/admin.db) into a
// PostgreSQL database, so switching the app to Postgres does not lose accounts,
// sessions, settings, execution history, credentials, variables, data tables or
// the events journal.
//
//   npm run db:migrate -- --url postgres://user:pass@host:5432/wflow
//
// Options:
//   --url <conn>      target PostgreSQL. Default: DATABASE_URL from .env.
//   --sqlite <path>   source file. Default: BF_DB_PATH or ./data/admin.db.
//   --dry-run         report what would be copied, write nothing.
//   --truncate        wipe the target tables first (requires --yes).
//   --yes, -y         confirm the wipe caused by --truncate.
//   --help, -h        this text.
//
// Notes:
//   * Idempotent — rows that already exist in the target are left untouched
//     (ON CONFLICT DO NOTHING), so it can be re-run after a partial failure.
//   * The SQLite file is opened READ-ONLY and is never modified, so the old
//     database stays as your rollback until you delete it yourself.
//   * The schema created in PostgreSQL is the app's own schema (server/pg.js),
//     so nothing is duplicated here.
//   * Only SQL rows move. The JSON stores and the encryption key live in
//     ./data — keep that folder (see the closing checklist).
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import "../server/env.js"; // .env must be loaded before DATABASE_URL is read
import { applySchema, SCHEMA_TABLES } from "../server/pg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE = path.join(__dirname, "..", "data", "admin.db");

// PostgreSQL rejects a parameter list of more than 65535 ($1 … $65535), so keep
// the batch well below that.
const MAX_PARAMS = 30000;

// ---------------------------------------------------------------------------
// pure helpers (unit-tested in tests/migrate-sqlite-to-pg.test.js)
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const opts = { url: "", sqlite: "", dryRun: false, truncate: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--truncate") opts.truncate = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--url" || arg === "--database-url") opts.url = String(argv[++i] || "").trim();
    else if (arg.startsWith("--url=")) opts.url = arg.slice("--url=".length).trim();
    else if (arg.startsWith("--database-url=")) opts.url = arg.slice("--database-url=".length).trim();
    else if (arg === "--sqlite") opts.sqlite = String(argv[++i] || "").trim();
    else if (arg.startsWith("--sqlite=")) opts.sqlite = arg.slice("--sqlite=".length).trim();
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  // Wiping is destructive and hard to undo — never on a single flag.
  if (opts.truncate && !opts.yes) {
    throw new Error("--truncate deletes every row in the target tables; add --yes to confirm.");
  }
  return opts;
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Columns the target table actually has, in source order. A source column the
// target lacks (an older schema) is skipped instead of failing the whole copy.
export function intersectColumns(sourceColumns, targetColumns) {
  const known = new Set(targetColumns.map(String));
  return sourceColumns.map(String).filter((col) => known.has(col));
}

export function chunk(list, size) {
  const step = Math.max(1, Math.floor(Number(size) || 1));
  const out = [];
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

export function rowsPerBatch(columnCount) {
  return Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / Math.max(1, columnCount))));
}

export function toPgValue(value) {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString(); // BIGINT columns accept a string
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

// One multi-row INSERT for a batch of rows; duplicates already in the target are
// silently kept as they are.
export function buildInsert(table, columns, rows) {
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((col) => {
      params.push(toPgValue(row[col]));
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const sql =
    `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) ` +
    `VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`;
  return { sql, params };
}

export function maskUrl(url) {
  return String(url).replace(/\/\/[^@/]*@/, "//***@");
}

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------
function usage() {
  console.log(`
  W flow — move the SQLite database into PostgreSQL

    npm run db:migrate -- --url postgres://user:password@host:5432/wflow

  Options
    --url <conn>      target PostgreSQL (default: DATABASE_URL from .env)
    --sqlite <path>   source file (default: BF_DB_PATH or ./data/admin.db)
    --dry-run         report what would be copied, write nothing
    --truncate        wipe the target tables first (requires --yes)
    --yes, -y         confirm the wipe caused by --truncate

  The old SQLite database is opened read-only and left untouched.
`);
}

function openSource(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`SQLite database not found: ${file}\n  Pass the right path with --sqlite <path>.`);
  }
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw new Error(
      `Could not open ${file} read-only: ${err.message}\n` +
        "  Stop the app so SQLite checkpoints its WAL, or copy the file and pass --sqlite <copy>."
    );
  }
}

function readSource(db) {
  const present = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name))
  );
  const tables = SCHEMA_TABLES.filter((t) => present.has(t));
  const unknown = [...present].filter((t) => !SCHEMA_TABLES.includes(t) && !t.startsWith("sqlite_"));
  const plan = tables.map((table) => ({
    table,
    columns: db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((r) => String(r.name)),
    count: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n || 0),
  }));
  return { plan, unknown };
}

async function targetColumns(client) {
  const { rows } = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()"
  );
  const map = new Map();
  for (const r of rows) {
    const key = String(r.table_name);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(String(r.column_name));
  }
  return map;
}

async function resetSequences(client, tables) {
  // Tables with SERIAL / BIGSERIAL ids (admin_user, user_activity, db_events)
  // would otherwise hand out ids that are already taken once rows were copied
  // with their original ids.
  const reset = [];
  for (const table of tables) {
    try {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), ` +
          `GREATEST(COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 0), 1), ` +
          `(SELECT COUNT(*) > 0 FROM ${quoteIdent(table)}))`,
        [table]
      );
      reset.push(table);
    } catch {
      /* no sequence on this table — an id that is a plain TEXT key */
    }
  }
  return reset;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const sqlitePath = path.resolve(opts.sqlite || process.env.BF_DB_PATH || DEFAULT_SQLITE);
  const url = opts.url || process.env.DATABASE_URL || "";
  if (!url) {
    throw new Error("No target database. Pass --url postgres://… or set DATABASE_URL in .env.");
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(`Target must be a PostgreSQL connection string, got "${maskUrl(url)}".`);
  }

  console.log("");
  console.log(`  source   ${sqlitePath}`);
  console.log(`  target   ${maskUrl(url)}${opts.dryRun ? "   (dry run — nothing is written)" : ""}`);
  if (fs.existsSync(`${sqlitePath}-wal`)) {
    console.log("  note     SQLite is in WAL mode — stop the app first so the newest writes are checkpointed.");
  }
  console.log("");

  const db = openSource(sqlitePath);
  const { plan, unknown } = readSource(db);
  for (const t of unknown) console.log(`  skip     ${t} — not part of the app schema`);
  if (!plan.length) throw new Error("Nothing to copy: no W flow tables found in the SQLite database.");

  const client = new pg.Client({ connectionString: url });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    console.log(`  connected to PostgreSQL ${(await client.query("SHOW server_version")).rows[0].server_version}\n`);
  } catch (err) {
    db.close();
    throw new Error(`Could not connect to PostgreSQL: ${err.message}`);
  }

  const report = [];
  try {
    if (opts.dryRun) {
      const existing = await targetColumns(client);
      for (const item of plan) {
        report.push({
          table: item.table,
          source: item.count,
          copied: null,
          kept: null,
          target: (await tableCount(client, item.table)) ?? null,
          state: existing.has(item.table) ? "exists" : "will be created",
        });
      }
    } else {
      await applySchema((sql) => client.query(sql));
      if (opts.truncate) {
        for (const item of plan) {
          await client.query(`TRUNCATE TABLE ${quoteIdent(item.table)} CASCADE`);
        }
        console.log("  truncated  all target tables (--truncate)\n");
      }
      const existing = await targetColumns(client);
      for (const item of plan) {
        const columns = intersectColumns(item.columns, existing.get(item.table) || []);
        if (!columns.length) {
          console.log(`  skip     ${item.table} — no matching columns in the target`);
          continue;
        }
        const rows = db
          .prepare(`SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(item.table)}`)
          .all();
        let copied = 0;
        for (const batch of chunk(rows, rowsPerBatch(columns.length))) {
          const { sql, params } = buildInsert(item.table, columns, batch);
          const res = await client.query(sql, params);
          copied += res.rowCount || 0;
        }
        report.push({
          table: item.table,
          source: item.count,
          copied,
          kept: item.count - copied,
          target: await tableCount(client, item.table),
          state: "copied",
        });
      }
      const reset = await resetSequences(client, plan.map((p) => p.table));
      if (reset.length) console.log(`  sequences reset: ${reset.join(", ")}\n`);
    }

    printReport(report);
  } finally {
    await client.end().catch(() => {});
    db.close();
  }

  if (opts.dryRun) {
    console.log("\n  Dry run — re-run without --dry-run to copy the rows.\n");
    return;
  }
  printChecklist(sqlitePath, report);
}

async function tableCount(client, table) {
  try {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${quoteIdent(table)}`);
    return Number(rows[0].n);
  } catch {
    return null;
  }
}

function printReport(report) {
  const head = ["table", "sqlite", "copied", "kept", "postgres"];
  const body = report.map((r) => [
    r.table,
    String(r.source),
    r.copied === null ? "-" : String(r.copied),
    r.kept === null ? "-" : String(r.kept),
    r.target === null ? "-" : String(r.target),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] || "").length)));
  const line = (cells) => "  " + cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
  const total = report.reduce((sum, r) => sum + (r.copied || 0), 0);
  console.log(`\n  ${total} row(s) copied.`);
  const mismatch = report.filter((r) => r.copied !== null && r.target !== null && r.target < r.source);
  if (mismatch.length) {
    console.log(`  ! ${mismatch.map((r) => r.table).join(", ")} hold fewer rows than the source — check the log above.`);
  }
  const kept = report.reduce((sum, r) => sum + (r.kept || 0), 0);
  if (kept) console.log(`  ${kept} row(s) already existed in the target and were left as they are.`);
}

function printChecklist(sqlitePath, report) {
  console.log(`
  Next steps
    1. Keep ${path.dirname(sqlitePath)} — the encryption key (.secret), the JSON
       stores (workflows.json, agents.json, uploaded files) and the backups live
       there, not in the database. Losing .secret makes every encrypted value
       (provider tokens, node credentials, SMTP password) unreadable.
    2. Put the connection string in .env (or the admin panel → Deployment →
       PostgreSQL connection) and restart the app:
           DATABASE_URL=postgres://…
    3. Sign in and check your workflows, accounts and the admin panel. The
       SQLite file is untouched — delete it only after you are happy.
    4. Rollback at any time: remove DATABASE_URL and restart.
`);
}

export { main, readSource, printReport };

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`\n  ✗ ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}
