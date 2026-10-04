// ============================================================================
// Startup secrets migration — a field newly added to SECRET_FIELD_NAMES (as
// webhookSecret was) is still plain text in saved workflows; the migration
// moves it into the encrypted table. It used to REPLACE the workflow's stored
// secrets with only the newly found ones, wiping every other credential.
//
// Run: node --test tests/secrets-migration.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-secret-migration-"));
process.env.BF_DB_PATH = path.join(tempDir, "test.db");
process.env.BF_DATA_DIR = tempDir;

const { workflows, migrateWorkflowSecretsToDb } = await import("../server/store.js");
const { db } = await import("../server/dbx.js");

test("migrating a newly secret field keeps the credentials already stored", async () => {
  const wf = {
    id: "wf-mig",
    ownerId: "u1",
    name: "migration",
    nodes: [
      { id: "gh", type: "githubTrigger", data: { config: { webhookSecret: "plain-hook-secret" } } },
      { id: "ai", type: "http", data: { config: { authToken: "" } } },
    ],
    edges: [],
  };
  await workflows.save(wf);
  await db.replaceWorkflowSecrets("wf-mig", "u1", [{ nodeId: "ai", field: "authToken", value: "stored-token" }]);

  assert.equal(await migrateWorkflowSecretsToDb(), 1);
  const stored = Object.fromEntries((await db.getWorkflowSecrets("wf-mig")).map((s) => [`${s.nodeId}.${s.field}`, s.value]));
  assert.deepEqual(stored, { "ai.authToken": "stored-token", "gh.webhookSecret": "plain-hook-secret" });
  const saved = await workflows.get("wf-mig");
  assert.equal(saved.nodes[0].data.config.webhookSecret, "", "blanked in the workflow file");
  assert.equal(await migrateWorkflowSecretsToDb(), 0, "nothing left to move on the next start");
});
