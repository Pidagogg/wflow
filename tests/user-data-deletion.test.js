// ============================================================================
// Deleting an account erases everything stored for it, and run history is
// pruned after the retention window.
//
// The privacy policy and the developer terms of connected services (X, Google,
// …) promise both, so these guard the database layer that the app's own
// account deletion and the admin panel's user deletion both end in.
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-userdel-"));
process.env.BF_DB_PATH = path.join(tempDir, "inproc.db");
delete process.env.BF_EXECUTION_RETENTION_DAYS;

const { db } = await import("../server/dbx.js");
const { pruneExecutions, executionRetentionDays } = await import("../server/executions.js");
const { DatabaseSync } = await import("node:sqlite");

function seedUser(email) {
  const user = db.createUser({ email, name: "T", passwordHash: "x" });
  const wfId = `wf-${email}`;
  db.addWorkflowToUser(user.id, wfId);
  db.replaceWorkflowSecrets(wfId, user.id, [{ nodeId: "n1", field: "bearerToken", value: "secret-x-token" }]);
  db.credentialCreate({ userId: user.id, name: "X", type: "oauth:x", fields: { accessToken: "a", refreshToken: "r" } });
  db.variableCreate({ userId: user.id, name: "V", value: "1", secret: false });
  const table = db.dataTableCreate({ userId: user.id, name: "T", columns: ["a"] });
  db.dataTableRowCreate({ tableId: table.id, userId: user.id, data: { a: 1 } });
  db.executionsSave({ workflowId: wfId, ownerId: user.id, result: { success: true } });
  return { user, wfId };
}

test("deleting a user erases connections, secrets, variables, tables and runs — and nobody else's", async () => {
  const gone = seedUser("gone@example.com");
  const kept = seedUser("kept@example.com");

  await db.deleteUser(gone.user.id);

  assert.ok(!db.getUserById(gone.user.id));
  assert.equal(db.credentialsList(gone.user.id).length, 0);
  assert.equal(db.variablesList(gone.user.id).length, 0);
  assert.equal(db.dataTablesList(gone.user.id).length, 0);
  assert.equal(db.getWorkflowSecrets(gone.wfId).length, 0);
  assert.equal(db.executionsListByWorkflow(gone.wfId).length, 0);
  // straight at the file, so no row survives that the list helpers would hide
  const raw = new DatabaseSync(process.env.BF_DB_PATH, { readOnly: true });
  try {
    for (const [table, col] of [["user_credentials", "user_id"], ["variables", "user_id"], ["data_table_rows", "user_id"], ["executions", "owner_id"], ["workflow_secrets", "user_id"], ["user_sessions", "user_id"]]) {
      const n = raw.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`).get(gone.user.id).c;
      assert.equal(n, 0, `${table} has no rows left for the deleted user`);
    }
  } finally {
    raw.close();
  }

  assert.ok(db.getUserById(kept.user.id));
  assert.equal(db.credentialsList(kept.user.id).length, 1);
  assert.equal(db.getWorkflowSecrets(kept.wfId).length, 1);
  assert.equal(db.executionsListByWorkflow(kept.wfId).length, 1);
});

test("runs older than the retention window are pruned, newer ones stay", async () => {
  assert.equal(executionRetentionDays(), 30);
  const day = 24 * 60 * 60_000;
  const old = new Date(Date.now() - 31 * day).toISOString();
  const fresh = new Date(Date.now() - 2 * day).toISOString();
  db.executionsSave({ id: "run-old", workflowId: "wf-ret", ownerId: "u", startedAt: old, result: {} });
  db.executionsSave({ id: "run-new", workflowId: "wf-ret", ownerId: "u", startedAt: fresh, result: {} });

  const removed = await pruneExecutions();
  assert.ok(removed >= 1);
  const left = db.executionsListByWorkflow("wf-ret").map((r) => r.id);
  assert.deepEqual(left, ["run-new"]);
});

test("retention 0 keeps runs forever", async () => {
  process.env.BF_EXECUTION_RETENTION_DAYS = "0";
  try {
    db.executionsSave({ id: "run-ancient", workflowId: "wf-forever", ownerId: "u", startedAt: "2000-01-01T00:00:00.000Z", result: {} });
    assert.equal(await pruneExecutions(), 0);
    assert.equal(db.executionsListByWorkflow("wf-forever").length, 1);
  } finally {
    delete process.env.BF_EXECUTION_RETENTION_DAYS;
  }
});
