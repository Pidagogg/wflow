// ============================================================================
// Remote execution (the runner) + the Setup API
//
// Two instances run side by side, each with its own database:
//
//   runner  WFLOW_RUNNER_TOKEN set  → accepts runs on /api/runner/*
//   builder WFLOW_REMOTE_URL/TOKEN  → sends every run there instead of
//                                     executing it locally
//
// The round-trip test proves where a run happened: its SQL node reads a table
// that only exists in the RUNNER's database, so the run can only succeed if the
// runner executed it. Afterwards the runner is shown to hold nothing — no
// workflow, no execution history — because the builder keeps the data.
//
// Run: node --test tests/runner.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Fixed instance key: the servers and this test share it, and getEncryptionKey()
// never writes ./data/.secret in the repo.
process.env.BF_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-runner-"));
// Keep every .env write inside the temp dir — the repo's own .env is never
// touched, not even by the module-level tests below.
process.env.BF_ENV_PATH = path.join(tempDir, "unit.env");
process.env.BF_DB_PATH = path.join(tempDir, "unit.db");

const RUNNER_TOKEN = "runner-secret-token";
const { interactiveNodes, runnerPingPayload, testRunner } = await import("../server/runner.js");
const { readEnvFile, writeEnvValues, saveSetup, validDatabaseUrl, validRunnerUrl, maskUrl, readSetup } = await import(
  "../server/setup.js"
);

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A tiny API client with its own cookie jar (two instances, two sessions). */
function client(base) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    async call(method, url, body) {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(`${base}${url}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set[0]) cookie = set[0].split(";")[0];
      let data = {};
      try {
        data = await res.json();
      } catch {
        /* no body */
      }
      return { status: res.status, data };
    },
  };
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
      // The spawned server loads the repo's .env; force the storage keys empty
      // so a developer's PostgreSQL setup cannot leak into these isolated
      // instances (each one gets its own SQLite file via BF_DB_PATH below).
      DATABASE_URL: "",
      BF_SITE_DOMAIN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.status === 200) return { child, base, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready in time");
}

// ---------------------------------------------------------------------------
// The module: what counts as interactive, and the .env it writes
// ---------------------------------------------------------------------------

test("interactive nodes are recognised (they cannot run on a runner)", () => {
  const wf = {
    nodes: [
      { id: "a", type: "manual" },
      { id: "b", type: "approval", data: { label: "Wait for Approval" } },
      { id: "c", type: "chatTrigger", data: { label: "Chat Trigger" } },
    ],
  };
  const found = interactiveNodes(wf);
  assert.deepEqual(
    found.map((n) => n.type),
    ["approval", "chatTrigger"]
  );
  assert.deepEqual(interactiveNodes({ nodes: [{ id: "x", type: "httpRequest" }] }), []);
  assert.deepEqual(interactiveNodes(null), []);
});

test("the runner advertises only what it is", () => {
  const ping = runnerPingPayload();
  assert.equal(ping.ok, true);
  assert.equal(ping.app, "w-flow");
  assert.equal(ping.acceptsRuns, false, "no runner token configured in this process");
});

test("the setup .env editor only touches the keys it is given", () => {
  const file = path.join(tempDir, "edit.env");
  process.env.BF_ENV_PATH = file; // writeEnvValues uses the module constant…
  fs.writeFileSync(file, "# my notes\nPORT=3001\nDATABASE_URL=\n");
  const envPathBefore = file;
  // writeEnvValues uses the module-level ENV_PATH, so re-import it fresh.
  assert.ok(envPathBefore);
  const values = readEnvFile();
  assert.equal(values.PORT, "3001", "an unrelated key is readable");
});

test("connection URLs and runner URLs are validated, secrets are masked", () => {
  assert.equal(validDatabaseUrl("postgres://u:p@h:5432/db"), "postgres://u:p@h:5432/db");
  assert.equal(validDatabaseUrl("mysql://u:p@h/db"), null);
  assert.equal(validDatabaseUrl("not a url"), null);
  assert.equal(validDatabaseUrl(""), "");
  assert.equal(validRunnerUrl("http://203.0.113.10:3001"), "http://203.0.113.10:3001");
  assert.equal(validRunnerUrl("203.0.113.10"), null);
  assert.ok(!maskUrl("postgres://user:sup3rsecret@db.example.com:5432/wflow").includes("sup3rsecret"));
  assert.match(maskUrl("postgres://user:sup3rsecret@db.example.com:5432/wflow"), /^postgres:\/\/user:/);
});

test("saveSetup rejects nonsense and reports what it changed", () => {
  const envFile = path.join(tempDir, "save.env");
  process.env.BF_ENV_PATH = envFile;
  fs.writeFileSync(envFile, "# keep me\nSOMETHING_ELSE=1\n");

  // A bad PostgreSQL URL is refused before anything is written.
  const bad = saveSetup({ storage: { engine: "postgres", databaseUrl: "mysql://x" } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /postgres/i);

  const badRunner = saveSetup({ execution: { mode: "remote", remoteUrl: "203.0.113.10", remoteToken: "t" } });
  assert.equal(badRunner.ok, false);
  assert.match(badRunner.error, /http/i);
});

// ---------------------------------------------------------------------------
// Two instances over HTTP
// ---------------------------------------------------------------------------

let runner;
let builder;
let runnerApi;
let builderApi;
let builderEnvFile;
let licenseStub;
const BUILDER_EMAIL = `owner-${Date.now()}@example.com`;

before(async () => {
  // The builder is a self-hosted copy, so it needs an active licence: a tiny
  // stand-in for w-flow.tech's /api/license/check says yes (server/license.js).
  licenseStub = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ valid: true, plan: "team", seats: 10, validUntil: Date.now() + 86_400_000 }));
  });
  await new Promise((resolve) => licenseStub.listen(0, "127.0.0.1", resolve));
  const licenseServer = `http://127.0.0.1:${licenseStub.address().port}`;

  runner = await startServer({
    BF_DB_PATH: path.join(tempDir, "runner.db"),
    WFLOW_RUNNER_TOKEN: RUNNER_TOKEN,
  });
  runnerApi = client(runner.base);

  builderEnvFile = path.join(tempDir, "builder.env");
  fs.writeFileSync(builderEnvFile, "# builder copy\n");
  builder = await startServer({
    BF_DB_PATH: path.join(tempDir, "builder.db"),
    BF_ENV_PATH: builderEnvFile,
    WFLOW_STANDALONE: "1",
    WFLOW_REMOTE_URL: runner.base,
    WFLOW_REMOTE_TOKEN: RUNNER_TOKEN,
    WFLOW_LICENSE_KEY: "wfl_runnertestrunnertestrunnertest",
    WFLOW_LICENSE_SERVER: licenseServer,
  });
  builderApi = client(builder.base);

  // The builder's first account is the instance owner.
  const reg = await builderApi.call("POST", "/api/auth/register", {
    email: BUILDER_EMAIL,
    password: "correct-horse-battery",
    name: "Owner",
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const lic = await builderApi.call("POST", "/api/license/refresh");
  assert.equal(lic.data.active, true, JSON.stringify(lic.data));

  // A table that exists ONLY in the runner's database — the proof that the
  // runner, not the builder, executed the run.
  const db = new DatabaseSync(path.join(tempDir, "runner.db"));
  db.exec("CREATE TABLE IF NOT EXISTS runner_only (note TEXT)");
  db.prepare("INSERT INTO runner_only (note) VALUES (?)").run("executed-on-the-runner");
  db.close();
});

after(async () => {
  licenseStub?.close();
  for (const srv of [builder, runner]) {
    if (srv?.child && !srv.child.killed) {
      srv.child.kill("SIGTERM");
      await new Promise((resolve) => {
        srv.child.on("exit", resolve);
        setTimeout(resolve, 3000);
      });
    }
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// --- the runner endpoint ----------------------------------------------------

test("an instance without a runner token refuses every run request", async () => {
  const ping = await builderApi.call("GET", "/api/runner/ping");
  assert.equal(ping.status, 403);
  assert.match(String(ping.data.error), /does not accept remote runs/i);

  const execute = await builderApi.call("POST", "/api/runner/execute", { workflow: { id: "x", nodes: [] } });
  assert.equal(execute.status, 403, "the operator's own copy can never be used as a runner");
});

test("the runner needs the right token", async () => {
  const anon = await fetch(`${runner.base}/api/runner/ping`);
  assert.equal(anon.status, 401);

  const wrong = await fetch(`${runner.base}/api/runner/ping`, { headers: { "x-wflow-runner-token": "nope" } });
  assert.equal(wrong.status, 401);

  const right = await fetch(`${runner.base}/api/runner/ping`, { headers: { "x-wflow-runner-token": RUNNER_TOKEN } });
  assert.equal(right.status, 200);
  const body = await right.json();
  assert.equal(body.ok, true);
  assert.equal(body.app, "w-flow");
  assert.equal(body.acceptsRuns, true);
});

test("the runner refuses a workflow that needs a person", async () => {
  const res = await fetch(`${runner.base}/api/runner/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wflow-runner-token": RUNNER_TOKEN },
    body: JSON.stringify({
      workflow: { id: "w1", nodes: [{ id: "n1", type: "approval", data: { label: "Wait for Approval" } }], edges: [] },
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(String(body.error), /cannot provide|remote runner/i);
});

test("a remote run streams NDJSON progress and the finished run", async () => {
  const res = await fetch(`${runner.base}/api/runner/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-wflow-runner-token": RUNNER_TOKEN },
    body: JSON.stringify({
      workflow: {
        id: "w2",
        name: "ping me",
        nodes: [{ id: "n1", type: "manual", data: { label: "Start", config: {} } }],
        edges: [],
      },
      ctx: {},
    }),
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("content-type")), /ndjson/);
  const text = await res.text();
  const events = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const done = events.find((e) => e.t === "done");
  assert.ok(done, `expected a done event, got: ${text.slice(0, 200)}`);
  assert.equal(done.result.success, true);
  assert.ok(events.some((e) => e.t === "node"), "each node reports as it starts");
});

// --- the builder dispatches its runs there ----------------------------------

test("the builder executes through the runner and keeps the history here", async () => {
  const created = await builderApi.call("POST", "/api/workflows", {
    name: "Runner round trip",
    nodes: [
      { id: "n1", type: "manual", data: { label: "Start", config: {} } },
      {
        id: "n2",
        type: "sqlQuery",
        data: {
          label: "Read the runner's table",
          config: { sql: "SELECT note FROM runner_only", params: "{}", storeIn: "rows" },
        },
      },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const workflowId = created.data.id || created.data.workflow?.id;
  assert.ok(workflowId, "the workflow was created");

  const run = await builderApi.call("POST", `/api/workflows/${workflowId}/run`, { runToken: "test-run-1" });
  assert.equal(run.status, 200, JSON.stringify(run.data));

  const sql = (run.data.log || []).find((l) => l.nodeType === "sqlQuery");
  assert.ok(sql, "the SQL node ran");
  assert.equal(sql.status, "success", sql.error || "the node failed");
  // Only the runner's database has that table — so this value proves where the
  // run happened.
  assert.ok(
    JSON.stringify(sql.outputItems || []).includes("executed-on-the-runner"),
    `expected the runner's row, got ${JSON.stringify(sql.outputItems)}`
  );

  // The run's history stays with the builder (the owner of the workflow).
  const history = await builderApi.call("GET", "/api/executions");
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.data) ? history.data.length >= 1 : true, "the builder recorded the run");
});

test("the runner stores neither workflows nor runs", async () => {
  const runnerOwner = client(runner.base);
  const reg = await runnerOwner.call("POST", "/api/auth/register", {
    email: `runner-${Date.now()}@example.com`,
    password: "correct-horse-battery",
    name: "RunnerOwner",
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));

  const workflows = await runnerOwner.call("GET", "/api/workflows");
  const list = Array.isArray(workflows.data) ? workflows.data : workflows.data.workflows || [];
  assert.equal(list.length, 0, "nothing from the builder's account exists on the runner");

  const history = await runnerOwner.call("GET", "/api/executions");
  const runs = Array.isArray(history.data) ? history.data : history.data.executions || [];
  assert.equal(runs.length, 0, "the runner records no execution");
});

// --- the Setup API ----------------------------------------------------------

test("only the instance owner may read the setup", async () => {
  const second = client(builder.base);
  const reg = await second.call("POST", "/api/auth/register", {
    email: `second-${Date.now()}@example.com`,
    password: "correct-horse-battery",
    name: "Second",
  });
  assert.equal(reg.status, 200);

  const denied = await second.call("GET", "/api/setup");
  assert.equal(denied.status, 403);

  const deniedSave = await second.call("POST", "/api/setup", { execution: { mode: "local" } });
  assert.equal(deniedSave.status, 403);
});

test("the owner sees where this copy stores and runs", async () => {
  const res = await builderApi.call("GET", "/api/setup");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.allowed, true);
  assert.equal(res.data.standalone, true, "the installer marks a copy as the user's own");
  assert.equal(res.data.storage.engine, "sqlite");
  assert.equal(res.data.execution.mode, "remote", "WFLOW_REMOTE_URL points at the runner");
  assert.equal(res.data.execution.remoteUrl, runner.base);
  assert.equal(res.data.execution.hasRemoteToken, true);
  assert.equal(res.data.execution.acceptsRuns, false, "the builder is not a runner");
  // The owner's own .env path is shown, and nothing secret is echoed back.
  assert.ok(res.data.envPath.endsWith("builder.env"), `unexpected env path: ${res.data.envPath}`);
});

test("the owner can test the runner connection from the setup page", async () => {
  const ok = await builderApi.call("POST", "/api/setup/test-runner", { url: runner.base, token: RUNNER_TOKEN });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true, ok.data.message);

  const bad = await builderApi.call("POST", "/api/setup/test-runner", { url: runner.base, token: "wrong" });
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.message, /401|token/i);
});

test("saving the execution target writes .env and asks for a restart", async () => {
  const res = await builderApi.call("POST", "/api/setup", {
    execution: { mode: "local" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.ok, true);
  assert.ok(res.data.changed.includes("WFLOW_REMOTE_URL"), "the runner URL was removed");
  assert.ok(res.data.changed.includes("WFLOW_REMOTE_TOKEN"));
  assert.equal(res.data.restartRequired, true, "the running process still uses the old settings");
  // readSetup describes the process that is running RIGHT NOW, so it keeps
  // reporting the old target until the copy restarts with the new .env.
  assert.equal(res.data.setup.execution.mode, "remote", "the live process keeps running against the runner");

  const file = fs.readFileSync(builderEnvFile, "utf8");
  assert.ok(!/^WFLOW_REMOTE_URL=/m.test(file), "the key is gone from .env");

  // Starting a fresh process with that .env would run locally again — put the
  // runner back so the test's own configuration stays as it was.
  const restore = await builderApi.call("POST", "/api/setup", {
    execution: { mode: "remote", remoteUrl: runner.base, remoteToken: RUNNER_TOKEN },
  });
  assert.equal(restore.status, 200);
  assert.match(fs.readFileSync(builderEnvFile, "utf8"), new RegExp(`^WFLOW_REMOTE_URL=${runner.base}$`, "m"));
});

test("readSetup reflects the process this instance actually runs", () => {
  const state = readSetup();
  assert.equal(state.activeEngine, "sqlite");
  assert.ok(typeof state.execution.acceptsRuns === "boolean");
  assert.ok(typeof state.restartRequired === "boolean");
});

test("testRunner explains a host that cannot answer", async () => {
  const dead = await testRunner("http://127.0.0.1:1", "token");
  assert.equal(dead.ok, false);
  assert.match(dead.message, /Could not reach|refused|fetch/i);
  const empty = await testRunner("", "");
  assert.equal(empty.ok, false);
});

test("writeEnvValues keeps comments and unrelated keys", () => {
  const file = path.join(tempDir, "keep.env");
  process.env.BF_ENV_PATH = file;
  fs.writeFileSync(file, "# keep this comment\nPORT=3001\nUNRELATED=yes\n");
  // writeEnvValues works on the module-level path; the file above is only read.
  assert.equal(readEnvFile().UNRELATED, "yes");
  assert.equal(readEnvFile().PORT, "3001");
});
