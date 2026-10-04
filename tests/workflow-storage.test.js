// ============================================================================
// Workflow storage — local (device JSON file) vs SQL database mode.
//
// Covers the admin "Workflow storage" toggle on the Cloud servers page:
//   - default is "local" (./data/workflows.json on this device)
//   - "database" saves each workflow in the SQL workflows table with an
//     assigned per-workflow code
//   - ownership rules hold in both modes (one user can't see another's)
//   - switching mode migrates existing workflows in both directions
//   - a workflow can be fetched back by its assigned code (owner-scoped)
//
// Both the SQL database (BF_DB_PATH) and the JSON data dir (BF_DATA_DIR) are
// pointed at a temp folder so the real ./data is never touched.
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-wfstore-"));
// Isolate BOTH backends BEFORE the modules load (ESM imports are hoisted).
process.env.BF_DB_PATH = path.join(tempDir, "wfstore.db");
process.env.BF_DATA_DIR = tempDir;

const {
  workflows,
  workflowStorageMode,
  setWorkflowStorageMode,
  countLocalWorkflows,
  countDbWorkflows,
} = await import("../server/store.js");
const { db, closeDb } = await import("../server/dbx.js");

function makeWorkflow(id, ownerId, extra = {}) {
  return {
    id,
    ownerId,
    name: `Workflow ${id}`,
    nodes: [{ id: "n1", type: "log", data: { config: {} } }],
    edges: [],
    ...extra,
  };
}

let lastCode = null;

before(() => {
  // Make sure we always start from the default (device) mode in a fresh DB.
  return setWorkflowStorageMode("local");
});

after(() => {
  try {
    closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("defaults to local (device) storage", async () => {
  assert.equal(await workflowStorageMode(), "local");
  assert.equal(countLocalWorkflows(), 0);
  assert.equal(await countDbWorkflows(), 0);
});

test("local mode: save / get / ownership rules", async () => {
  await workflows.save(makeWorkflow("wf-a", "u1"));
  await workflows.save(makeWorkflow("wf-b", "u2"));
  assert.equal(countLocalWorkflows(), 2);

  const mine = await workflows.listOwned("u1");
  assert.deepEqual(mine.map((w) => w.id), ["wf-a"]);
  assert.ok(await workflows.getOwned("wf-a", "u1"));
  assert.equal(await workflows.getOwned("wf-a", "u2"), null);
  assert.equal(await workflows.removeOwned("wf-a", "u2"), false);
  assert.ok(await workflows.removeOwned("wf-a", "u1"));
  assert.equal(await workflows.get("wf-a"), null);
});

test("toggle to database migrates local workflows and assigns codes", async () => {
  await workflows.save(makeWorkflow("wf-local-1", "u1"));
  assert.equal(await setWorkflowStorageMode("database"), "database");
  assert.equal(await workflowStorageMode(), "database");

  // both pre-existing + newly saved workflows are now in the SQL table
  assert.equal(await countDbWorkflows(), 2); // wf-b + wf-local-1
  assert.equal(countLocalWorkflows(), 2); // file untouched by migration

  const all = await workflows.all();
  for (const wf of all) {
    assert.ok(wf.code, `workflow ${wf.id} got an assigned code`);
    assert.match(wf.code, /^[0-9A-F]{8}$/);
  }
  lastCode = all.find((w) => w.id === "wf-local-1").code;
});

test("database mode: save / re-save keeps code / remove", async () => {
  const wf = makeWorkflow("wf-db-1", "u1");
  const saved = await workflows.save(wf);
  assert.ok(saved.code, "save in database mode assigns a code");

  // re-saving keeps the assigned code
  const again = await workflows.save({ ...saved, name: "Renamed" });
  assert.equal(again.code, saved.code);
  assert.equal((await workflows.get("wf-db-1")).name, "Renamed");
  assert.equal(await countDbWorkflows(), 3);

  assert.equal(await workflows.getOwned("wf-db-1", "u2"), null);
  assert.equal(await workflows.removeOwned("wf-db-1", "u2"), false);
  assert.ok(await workflows.removeOwned("wf-db-1", "u1"));
  assert.equal(await workflows.get("wf-db-1"), null);
});

test("database mode: assigned codes are unique", async () => {
  const a = await workflows.save(makeWorkflow("wf-code-a", "u1"));
  const b = await workflows.save(makeWorkflow("wf-code-b", "u1"));
  assert.ok(a.code && b.code, "both saves got codes");
  assert.notEqual(a.code, b.code, "codes are unique per workflow");
  assert.match(a.code, /^[0-9A-F]{8}$/);
});

test("database mode: listOwned filters by owner and all() carries ownerId", async () => {
  await workflows.save(makeWorkflow("wf-u1x", "u1"));
  await workflows.save(makeWorkflow("wf-u2x", "u2"));
  const u1 = await workflows.listOwned("u1");
  assert.ok(u1.every((w) => w.ownerId === "u1"), "only u1's workflows are listed");
  assert.ok(u1.some((w) => w.id === "wf-u1x"));
  assert.ok(!u1.some((w) => w.id === "wf-u2x"), "u2's workflow is invisible to u1");
  const all = await workflows.all();
  assert.ok(all.every((w) => w.ownerId), "every database workflow carries an ownerId");
});

test("database mode: claimUnowned adopts ownerless rows", async () => {
  await workflows.save(makeWorkflow("wf-orphan", null)); // saved before ownership existed
  assert.equal(await workflows.claimUnowned("u3"), 1);
  const adopted = await workflows.getOwned("wf-orphan", "u3");
  assert.ok(adopted, "the orphaned workflow was adopted");
  assert.equal(adopted.ownerId, "u3");
});

test("storage mode lives in the SQL store (survives a restart)", async () => {
  // the mode is persisted in the database, not held in memory
  assert.equal(await db.storeGet("storage.workflows"), "database");
});

test("by-code lookup works and is owner-scoped", async () => {
  const wf = makeWorkflow("wf-code-1", "u1");
  const saved = await workflows.save(wf);
  assert.ok(saved.code);

  const found = await workflows.getByCode(saved.code, "u1");
  assert.ok(found, "owner can look the workflow up by its code");
  assert.equal(found.id, "wf-code-1");

  // other accounts / unknown codes get nothing
  assert.equal(await workflows.getByCode(saved.code, "u2"), null);
  assert.equal(await workflows.getByCode("FFFFFFFF", "u1"), null);
  assert.equal(await workflows.getByCode("", "u1"), null);
});

test("toggle back to local migrates DB workflows, codes preserved", async () => {
  const localCountBefore = countLocalWorkflows();
  assert.equal(await setWorkflowStorageMode("local"), "local");

  // the database workflows were copied back into the file, codes intact
  const local = await workflows.listOwned("u1");
  const migrated = local.find((w) => w.id === "wf-local-1");
  assert.ok(migrated, "wf-local-1 came back to the device store");
  assert.equal(migrated.code, lastCode, "assigned code survived the round trip");
  assert.ok(await workflows.getByCode(lastCode, "u1"), "code still resolves after migrating back");
  assert.ok(countLocalWorkflows() > localCountBefore, "database workflows were copied back into the file");
  assert.ok((await workflows.all()).some((w) => w.id === "wf-code-1"), "wf-code-1 joined the file");

  // writes now land in the file again
  await workflows.save(makeWorkflow("wf-after-1", "u1"));
  assert.equal((await workflows.listOwned("u1")).some((w) => w.id === "wf-after-1"), true);
  assert.equal(await workflowStorageMode(), "local");
});
