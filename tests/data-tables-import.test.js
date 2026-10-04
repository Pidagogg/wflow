// ============================================================================
// Data-table CSV import (POST /api/data-tables/import) — end-to-end over HTTP.
//
// The real server is spawned with an isolated database and driven like the Data
// Tables page does: a CSV (pasted or uploaded) either creates a new table with
// the columns from the file's header, or appends its rows to an existing table
// (adding the columns the file brings along).
//
//   - comma / tab / semicolon files and quoted fields with embedded separators
//   - "first row holds the column names" on and off (A, B, C … otherwise)
//   - appending to an existing table, including a new column
//   - empty input and unknown tables are rejected
//   - another account can neither see nor import into a foreign table
//
// Run: node --test tests/data-tables-import.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-datatables-"));
const dbPath = path.join(tempDir, "datatables.db");
const dataDir = path.join(tempDir, "data");

let child;
let base = "";

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// One browser-like session per account, each keeping its own session cookie.
function client() {
  let cookie = "";
  return async (method, url, body) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const raw = res.headers.getSetCookie?.() ?? [];
    if (raw[0]) cookie = raw[0].split(";")[0];
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, data };
  };
}

const owner = client();
const stranger = client();

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready in time");
}

async function register(session, email) {
  const res = await session("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: "Importer" });
  assert.equal(res.status, 200, `register ${email}: ${JSON.stringify(res.data)}`);
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: dbPath,
      BF_DATA_DIR: dataDir,
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForServer();
  await register(owner, `importer-${Date.now()}@example.com`);
  await register(stranger, `stranger-${Date.now()}@example.com`);
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("a pasted CSV creates a table with the header as columns and the rows", async () => {
  const res = await owner("POST", "/api/data-tables/import", {
    name: "Customers",
    csv: "id,name,plan\n1,Ada,pro\n2,Lin,free",
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.deepEqual(res.data.table.columns, ["id", "name", "plan"]);
  assert.equal(res.data.table.name, "Customers");
  assert.equal(res.data.imported, 2);

  const rows = await owner("GET", `/api/data-tables/${res.data.table.id}/rows`);
  assert.equal(rows.status, 200);
  assert.deepEqual(rows.data.map((r) => r.data), [
    { id: "1", name: "Ada", plan: "pro" },
    { id: "2", name: "Lin", plan: "free" },
  ]);
});

test("quoted fields keep embedded commas, quotes and line breaks", async () => {
  const res = await owner("POST", "/api/data-tables/import", {
    name: "Notes",
    csv: 'name,note\nAda,"says ""hi"", loudly"\nLin,"two\nlines"',
  });
  assert.equal(res.status, 201);
  const rows = await owner("GET", `/api/data-tables/${res.data.table.id}/rows`);
  assert.deepEqual(rows.data.map((r) => r.data.note), ['says "hi", loudly', "two\nlines"]);
});

test("tab and semicolon separated files are detected automatically", async () => {
  const tsv = await owner("POST", "/api/data-tables/import", { name: "TSV", csv: "a\tb\n1\t2" });
  assert.equal(tsv.status, 201);
  assert.deepEqual(tsv.data.table.columns, ["a", "b"]);

  const semis = await owner("POST", "/api/data-tables/import", { name: "Semi", csv: "a;b\n1;2" });
  assert.deepEqual(semis.data.table.columns, ["a", "b"]);
  assert.equal(semis.data.imported, 1);
});

test("without a header row the columns are A, B, C …", async () => {
  const res = await owner("POST", "/api/data-tables/import", { name: "NoHeader", csv: "1,Ada\n2,Lin", headerRow: false });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.table.columns, ["A", "B"]);
  const rows = await owner("GET", `/api/data-tables/${res.data.table.id}/rows`);
  assert.deepEqual(rows.data.map((r) => r.data), [{ A: "1", B: "Ada" }, { A: "2", B: "Lin" }]);
});

test("importing into an existing table appends rows and adds new columns", async () => {
  const created = await owner("POST", "/api/data-tables", { name: "Append target", columns: ["id", "name"] });
  assert.equal(created.status, 201);
  const id = created.data.id;

  const first = await owner("POST", "/api/data-tables/import", { tableId: id, csv: "id,name\n1,Ada" });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.deepEqual(first.data.columns, ["id", "name"]);
  assert.equal(first.data.imported, 1);

  const second = await owner("POST", "/api/data-tables/import", { tableId: id, csv: "id,name,plan\n2,Lin,pro" });
  assert.equal(second.status, 201);
  assert.deepEqual(second.data.columns, ["id", "name", "plan"]);
  assert.deepEqual(second.data.table.columns, ["id", "name", "plan"]);

  // the first batch predates the "plan" column, so those rows simply carry no
  // value for it — the table view renders a missing key as an empty cell
  const rows = await owner("GET", `/api/data-tables/${id}/rows`);
  assert.deepEqual(rows.data.map((r) => r.data), [
    { id: "1", name: "Ada" },
    { id: "2", name: "Lin", plan: "pro" },
  ]);
});

test("a header-only file creates the columns and no rows", async () => {
  const res = await owner("POST", "/api/data-tables/import", { name: "Empty", csv: "id,name" });
  assert.equal(res.status, 201);
  assert.equal(res.data.imported, 0);
  assert.deepEqual(res.data.table.columns, ["id", "name"]);
});

test("empty input and a missing name are rejected", async () => {
  const blank = await owner("POST", "/api/data-tables/import", { name: "Nope", csv: "   \n  " });
  assert.equal(blank.status, 400);

  const unnamed = await owner("POST", "/api/data-tables/import", { csv: "a,b\n1,2" });
  assert.equal(unnamed.status, 201);
  assert.equal(unnamed.data.table.name, "Imported table");
});

test("an unknown table id is a 404, a foreign table too", async () => {
  const missing = await owner("POST", "/api/data-tables/import", { tableId: "does-not-exist", csv: "a\n1" });
  assert.equal(missing.status, 404);

  const mine = await owner("POST", "/api/data-tables", { name: "Private", columns: ["a"] });
  const theirs = await stranger("POST", "/api/data-tables/import", { tableId: mine.data.id, csv: "a\n1" });
  assert.equal(theirs.status, 404);

  const list = await stranger("GET", "/api/data-tables");
  assert.equal(list.data.some((t) => t.id === mine.data.id), false);
});
