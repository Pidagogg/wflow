// ============================================================================
// Workflow secrets — the encrypted workflow_secrets table + the helpers that
// lift credentials out of workflow JSON (collectSecrets / blankSecretsInWorkflow
// / hydrateSecretsInWorkflow), plus the admin panel's docker-compose PostgreSQL
// service toggle (togglePostgresInCompose).
//
// Run: node --test tests/
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-secrets-test-"));

// Point the database at an isolated file BEFORE the modules load it.
process.env.BF_DB_PATH = path.join(tempDir, "secrets-test.db");

const {
  collectSecrets,
  blankSecretsInWorkflow,
  hydrateSecretsInWorkflow,
  collectAgentSecrets,
  blankAgentSecrets,
  hydrateAgentSecrets,
} = await import("../server/store.js");
const db = await import("../server/db.js");
const { togglePostgresInCompose } = await import("../server/admin.js");

after(() => {
  // Release the SQLite handle (an open DB file is locked on Windows) so the
  // temp directory can be removed.
  db.closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// collect / blank / hydrate — pure workflow helpers
// ----------------------------------------------------------------------------
function sampleWorkflow() {
  return {
    id: "wf-1",
    name: "Test",
    nodes: [
      {
        id: "n1",
        type: "aiAgent",
        data: {
          config: {
            useInline: true,
            provider: "openai",
            apiKey: "sk-inline-secret",
            model: "gpt-4o-mini",
            baseUrl: "https://api.openai.com/v1",
          },
        },
      },
      {
        id: "n2",
        type: "http",
        data: {
          config: {
            method: "GET",
            url: "https://api.example.com",
            auth: { token: "tok-nested" },
            headers: [{ key: "X-Api-Key", value: "not-a-secret-key-name" }],
            empty: "",
          },
        },
      },
    ],
    edges: [],
  };
}

test("collectSecrets finds every non-empty secret field (incl. nested)", () => {
  const secrets = collectSecrets(sampleWorkflow());
  const byField = Object.fromEntries(secrets.map((s) => [s.field, s]));
  assert.equal(secrets.length, 2, JSON.stringify(secrets));
  assert.deepEqual(byField.apiKey, { nodeId: "n1", field: "apiKey", value: "sk-inline-secret" });
  assert.deepEqual(byField["auth.token"], { nodeId: "n2", field: "auth.token", value: "tok-nested" });
  // empty strings and non-secret keys are not collected
  assert.ok(!secrets.some((s) => s.field === "empty"));
  assert.ok(!secrets.some((s) => s.field === "headers.0.value"));
});

test("blankSecretsInWorkflow empties the secrets but keeps structure", () => {
  const blanked = blankSecretsInWorkflow(sampleWorkflow());
  const n1 = blanked.nodes.find((n) => n.id === "n1");
  const n2 = blanked.nodes.find((n) => n.id === "n2");
  assert.equal(n1.data.config.apiKey, "");
  assert.equal(n2.data.config.auth.token, "");
  // everything else untouched
  assert.equal(n1.data.config.provider, "openai");
  assert.equal(n2.data.config.headers[0].value, "not-a-secret-key-name");
  // the original object is not mutated
  assert.equal(sampleWorkflow().nodes[0].data.config.apiKey, "sk-inline-secret");
});

test("blank → hydrate roundtrip restores the original workflow exactly", () => {
  const original = sampleWorkflow();
  const blanked = blankSecretsInWorkflow(original);
  const secrets = collectSecrets(original);
  const restored = hydrateSecretsInWorkflow(blanked, secrets);
  assert.deepEqual(restored, original);
});

test("hydrate skips secrets whose node/path no longer exists", () => {
  const wf = sampleWorkflow();
  const restored = hydrateSecretsInWorkflow(wf, [
    { nodeId: "n1", field: "apiKey", value: "v1" },
    { nodeId: "ghost", field: "apiKey", value: "v2" },
    { nodeId: "n2", field: "auth.token", value: "v3" },
  ]);
  assert.equal(restored.nodes.find((n) => n.id === "n1").data.config.apiKey, "v1");
  assert.equal(restored.nodes.find((n) => n.id === "n2").data.config.auth.token, "v3");
  // node "ghost" does not exist → no error, nothing restored
});

// ----------------------------------------------------------------------------
// saved agents — collect / blank / hydrate
// ----------------------------------------------------------------------------
function sampleAgent() {
  return {
    id: "ag-1",
    name: "Helper",
    model: { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-agent-secret", model: "gpt-4o-mini", temperature: 0.7, maxTokens: 1024 },
    systemPrompt: "Be brief.",
    tools: { http: true, httpHeaders: '{"Authorization":"inside-json-string"}' },
  };
}

test("collectAgentSecrets finds the model API key (not JSON-string headers)", () => {
  const secrets = collectAgentSecrets(sampleAgent());
  assert.deepEqual(secrets, [{ field: "model.apiKey", value: "sk-agent-secret" }]);
});

test("blankAgentSecrets → hydrateAgentSecrets roundtrip restores the agent", () => {
  const original = sampleAgent();
  const blanked = blankAgentSecrets(original);
  assert.equal(blanked.model.apiKey, "");
  assert.equal(blanked.model.provider, "openai");
  assert.equal(original.model.apiKey, "sk-agent-secret", "original must not be mutated");
  const restored = hydrateAgentSecrets(blanked, collectAgentSecrets(original));
  assert.deepEqual(restored, original);
});

test("collectAgentSecrets skips agents without a key", () => {
  const agent = sampleAgent();
  agent.model.apiKey = "";
  assert.deepEqual(collectAgentSecrets(agent), []);
});

// ----------------------------------------------------------------------------
// workflow_secrets table (SQLite via db.js, isolated temp file)
// ----------------------------------------------------------------------------
test("replaceWorkflowSecrets stores encrypted values and getWorkflowSecrets decrypts them", async () => {
  const secrets = [
    { nodeId: "n1", field: "apiKey", value: "sk-super-secret" },
    { nodeId: "n2", field: "auth.token", value: "tok-abc" },
  ];
  await db.replaceWorkflowSecrets("wf-x", "user-1", secrets);
  const got = await db.getWorkflowSecrets("wf-x");
  assert.equal(got.length, 2);
  assert.deepEqual(
    [...got].sort((a, b) => a.field.localeCompare(b.field)),
    [
      { nodeId: "n1", field: "apiKey", value: "sk-super-secret" },
      { nodeId: "n2", field: "auth.token", value: "tok-abc" },
    ]
  );
});

test("secrets are encrypted at rest (plaintext never appears in the table)", async () => {
  const { rows } = await db.runSql("SELECT value FROM workflow_secrets WHERE workflow_id = 'wf-x' AND field = 'apiKey'");
  assert.equal(rows.length, 1);
  assert.ok(!String(rows[0].value).includes("sk-super-secret"), "ciphertext must not contain the plaintext");
  assert.match(String(rows[0].value), /^\w+\.\w+\.\w+$/); // iv.tag.cipher shape
});

test("replacing secrets drops removed rows; deleteWorkflowSecrets removes all", async () => {
  await db.replaceWorkflowSecrets("wf-x", "user-1", [{ nodeId: "n1", field: "apiKey", value: "only-this" }]);
  const got = await db.getWorkflowSecrets("wf-x");
  assert.deepEqual(got, [{ nodeId: "n1", field: "apiKey", value: "only-this" }]);
  await db.deleteWorkflowSecrets("wf-x");
  assert.deepEqual(await db.getWorkflowSecrets("wf-x"), []);
});

// ----------------------------------------------------------------------------
// agent_secrets table
// ----------------------------------------------------------------------------
test("agent_secrets roundtrip: store encrypted, read decrypted, replace, delete", async () => {
  await db.replaceAgentSecrets("ag-1", "user-1", [{ field: "model.apiKey", value: "sk-agent-secret" }]);
  assert.deepEqual(await db.getAgentSecrets("ag-1"), [{ field: "model.apiKey", value: "sk-agent-secret" }]);
  const { rows } = await db.runSql("SELECT value FROM agent_secrets WHERE agent_id = 'ag-1'");
  assert.ok(!String(rows[0].value).includes("sk-agent-secret"), "ciphertext must not contain the plaintext");
  // replace drops the old row, then delete removes everything
  await db.replaceAgentSecrets("ag-1", "user-1", []);
  assert.deepEqual(await db.getAgentSecrets("ag-1"), []);
  await db.replaceAgentSecrets("ag-1", "user-1", [{ field: "model.apiKey", value: "sk-again" }]);
  await db.deleteAgentSecrets("ag-1");
  assert.deepEqual(await db.getAgentSecrets("ag-1"), []);
});

// ----------------------------------------------------------------------------
// docker-compose PostgreSQL service toggle (admin panel)
// ----------------------------------------------------------------------------
const COMPOSE_TEMPLATE = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");

test("togglePostgresInCompose enables the bundled postgres service + depends_on", () => {
  const result = togglePostgresInCompose(COMPOSE_TEMPLATE, { enable: true, password: "hunter2" });
  assert.equal(result.error, undefined);
  assert.equal(result.changed, true);
  const lines = result.text.split("\n").map((l) => l.trim());
  assert.ok(lines.includes("postgres:"), "postgres service must be uncommented");
  assert.ok(lines.includes("depends_on:"), "depends_on must be uncommented");
  assert.ok(lines.includes("- postgres"), "depends_on entry must be uncommented");
  assert.ok(lines.some((l) => l === "POSTGRES_PASSWORD: hunter2"), "password must be applied");
  // everything else intact
  assert.ok(lines.includes("wflow:"), "main service untouched");
  assert.ok(lines.includes("pgdata:"), "volumes untouched");
});

test("togglePostgresInCompose disable → enable roundtrip is stable", () => {
  const enabled = togglePostgresInCompose(COMPOSE_TEMPLATE, { enable: true, password: "hunter2" }).text;
  const disabled = togglePostgresInCompose(enabled, { enable: false });
  assert.equal(disabled.changed, true);
  const d = disabled.text.split("\n").map((l) => l.trim());
  assert.ok(!d.includes("postgres:"), "postgres service must be commented again");
  // The app's `- postgres` entry is what ties the service to the database. It is
  // the only marker unique to this wiring — other services in the compose file
  // may legitimately keep a live depends_on of their own.
  assert.ok(!d.includes("- postgres"), "the depends_on entry for postgres must be commented again");
  const reEnabled = togglePostgresInCompose(disabled.text, { enable: true, password: "hunter2" });
  assert.equal(reEnabled.error, undefined, "re-enable after disable must succeed: " + reEnabled.error);
  assert.equal(reEnabled.text, enabled, "enable → disable → enable must reproduce the same file");
});

test("togglePostgresInCompose leaves another service's depends_on alone", () => {
  // Regression: the optional caddy service declares a depends_on of its own, so
  // the toggle must locate the postgres wiring by its `- postgres` entry instead
  // of editing whichever `depends_on:` happens to come first in the file.
  const decoy = COMPOSE_TEMPLATE.replace(
    "  wflow-admin:",
    "  decoy:\n    image: busybox\n    depends_on:\n      - wflow\n\n  wflow-admin:"
  );
  assert.notEqual(decoy, COMPOSE_TEMPLATE, "the decoy service must have been inserted");
  const enabled = togglePostgresInCompose(decoy, { enable: true, password: "hunter3" });
  assert.equal(enabled.error, undefined, enabled.error);
  const lines = enabled.text.split("\n");
  const decoyIdx = lines.findIndex((l) => l.trim() === "decoy:");
  assert.ok(decoyIdx > 0, "the decoy service must survive");
  assert.deepEqual(
    lines.slice(decoyIdx, decoyIdx + 4).map((l) => l.trim()),
    ["decoy:", "image: busybox", "depends_on:", "- wflow"],
    "another service's depends_on must be left untouched"
  );
  const wired = (ls) => ls.some((l, i) => l.trim() === "depends_on:" && (ls[i + 1] || "").trim() === "- postgres");
  assert.ok(wired(lines), "the postgres depends_on must be enabled");

  // …and the same on the way back out.
  const disabled = togglePostgresInCompose(enabled.text, { enable: false }).text.split("\n");
  assert.deepEqual(
    disabled.slice(decoyIdx, decoyIdx + 4).map((l) => l.trim()),
    ["decoy:", "image: busybox", "depends_on:", "- wflow"],
    "another service's depends_on must survive disabling postgres"
  );
  assert.ok(!wired(disabled), "the postgres depends_on must be commented again");
});

test("togglePostgresInCompose refuses unknown compose files", () => {
  const result = togglePostgresInCompose("services:\n  custom:\n    image: nginx\n", { enable: true });
  assert.ok(result.error, "missing markers must produce an error, not a guess");
  assert.equal(result.changed, false);
});

test("togglePostgresInCompose is idempotent", () => {
  const enabled = togglePostgresInCompose(COMPOSE_TEMPLATE, { enable: true, password: "hunter2" }).text;
  const again = togglePostgresInCompose(enabled, { enable: true, password: "hunter2" });
  assert.equal(again.changed, false);
  assert.equal(again.already, true);
  const disabled = togglePostgresInCompose(enabled, { enable: false }).text;
  const againDisabled = togglePostgresInCompose(disabled, { enable: false });
  assert.equal(againDisabled.changed, false);
});
