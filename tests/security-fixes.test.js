// ============================================================================
// Security regression tests — the exploits found in the Oct 2026 review, each
// locked shut. Spawns the real server (like api-e2e) on an isolated temp DB and
// a known BF_ENCRYPTION_KEY, then drives it over HTTP with two accounts.
//
//   C1  the Code node runs sandboxed: it cannot read process.env or the disk
//   C3  POST /api/workflows ignores a client-supplied id / ownerId
//   C4  POST /api/agents ignores a client-supplied id
//   H1  a shared viewer never receives the owner's decrypted node secrets
//   H4  stop-sharing cannot switch on Pro-only loop for a free account
//
// Run: node --test tests/security-fixes.test.js
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-sec-"));
const SECRET_ENV_VALUE = "TOP-SECRET-ENCRYPTION-KEY-DO-NOT-LEAK";

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

let child;
let base = "";

// Each helper carries its own cookie jar so two users can act independently.
function makeClient() {
  let cookie = "";
  return async function api(method, url, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const raw = res.headers.getSetCookie?.() ?? [];
    if (raw[0] && raw[0].startsWith("bf_user=")) cookie = raw[0].split(";")[0];
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, data };
  };
}

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

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: path.join(tempDir, "sec.db"),
      BF_DATA_DIR: path.join(tempDir, "data"),
      BF_ENCRYPTION_KEY: SECRET_ENV_VALUE,
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForServer();
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

const stamp = Date.now();
const A = makeClient();
const B = makeClient();

test("accounts register", async () => {
  const a = await A("POST", "/api/auth/register", { email: `a-${stamp}@ex.com`, password: "correct-horse-battery", name: "Alice" });
  const b = await B("POST", "/api/auth/register", { email: `b-${stamp}@ex.com`, password: "correct-horse-battery", name: "Bob" });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));
});

test("C1 — the Code node cannot read process.env secrets or the disk", async () => {
  const create = await A("POST", "/api/workflows", {
    name: "sandbox probe",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      {
        id: "c",
        type: "code",
        data: {
          label: "Probe",
          config: {
            code: "let fsRead='blocked'; try { require('fs'); fsRead='required-fs'; } catch(e){} try { process.getBuiltinModule('fs').readFileSync('package.json'); fsRead='read-file'; } catch(e){} return [{ json: { secret: process.env.BF_ENCRYPTION_KEY || null, envCount: Object.keys(process.env).length, fsRead } }];",
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "m", target: "c", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const run = await A("POST", `/api/workflows/${create.data.id}/run`, { payload: {} });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const codeLog = (run.data.log || []).find((l) => l.nodeId === "c");
  assert.ok(codeLog, "the code node ran");
  const out = codeLog.outputItems?.[0] || {};
  assert.equal(out.secret, null, "the sandbox must not expose BF_ENCRYPTION_KEY");
  assert.notEqual(out.fsRead, "read-file", "the sandbox must not read files from disk");
});

test("C3 — POST /api/workflows ignores a client-supplied id and ownerId", async () => {
  const mine = await A("POST", "/api/workflows", { name: "Alice real", nodes: [], edges: [] });
  assert.equal(mine.status, 200);
  const victimId = mine.data.id;

  // Bob tries to overwrite Alice's workflow by reusing its id (and claim it).
  const attack = await B("POST", "/api/workflows", { id: victimId, ownerId: "bob", name: "HIJACKED", nodes: [], edges: [] });
  assert.equal(attack.status, 200, JSON.stringify(attack.data));
  assert.notEqual(attack.data.id, victimId, "the server must mint a fresh id, not honour the client's");

  // Alice's workflow is untouched.
  const still = await A("GET", `/api/workflows/${victimId}`);
  assert.equal(still.status, 200);
  assert.equal(still.data.name, "Alice real", "Alice's workflow name is unchanged");

  // Bob cannot even read it.
  const peek = await B("GET", `/api/workflows/${victimId}`);
  assert.equal(peek.status, 404, "Bob has no access to Alice's workflow");
});

test("C4 — POST /api/agents ignores a client-supplied id", async () => {
  const mine = await A("POST", "/api/agents", { name: "Alice agent" });
  assert.equal(mine.status, 200);
  const victimId = mine.data.id;
  const attack = await B("POST", "/api/agents", { id: victimId, name: "HIJACKED agent" });
  assert.equal(attack.status, 200);
  assert.notEqual(attack.data.id, victimId, "agents also get a fresh server id");
  const still = await A("GET", `/api/agents/${victimId}`);
  assert.equal(still.status, 200);
  assert.equal(still.data.name, "Alice agent");
});

test("H1 — a shared viewer never receives the owner's node secrets", async () => {
  const wf = await A("POST", "/api/workflows", {
    name: "has a secret",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "h", type: "httpRequest", data: { label: "HTTP", config: { url: "https://example.com", authType: "bearer", authToken: "SECRET-BEARER-TOKEN" } } },
    ],
    edges: [{ id: "e1", source: "m", target: "h", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));
  // Owner sees the token re-injected.
  const ownerView = await A("GET", `/api/workflows/${wf.data.id}`);
  const ownerToken = ownerView.data.nodes.find((n) => n.id === "h").data.config.authToken;
  assert.equal(ownerToken, "SECRET-BEARER-TOKEN", "the owner gets their own secret back");

  // Share read-only with Bob.
  const share = await A("POST", `/api/workflows/${wf.data.id}/share`, { email: `b-${stamp}@ex.com`, role: "viewer" });
  assert.equal(share.status, 200, JSON.stringify(share.data));

  const viewerView = await B("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(viewerView.status, 200, JSON.stringify(viewerView.data));
  const viewerToken = viewerView.data.nodes.find((n) => n.id === "h").data.config.authToken;
  assert.equal(viewerToken, "", "a viewer must receive the secret blanked");
  assert.equal(viewerView.data.role, "viewer");

  // And a viewer save does not wipe the owner's stored secret.
  await B("PUT", `/api/workflows/${wf.data.id}`, viewerView.data).catch(() => {});
  const ownerAfter = await A("GET", `/api/workflows/${wf.data.id}`);
  const stillToken = ownerAfter.data.nodes.find((n) => n.id === "h").data.config.authToken;
  assert.equal(stillToken, "SECRET-BEARER-TOKEN", "a viewer save must not erase the owner's secret");
});

test("H4 — stop-sharing cannot enable Pro-only loop for a free account", async () => {
  const wf = await A("POST", "/api/workflows", { name: "loop attempt", nodes: [], edges: [] });
  assert.equal(wf.status, 200);
  const res = await A("POST", `/api/workflows/${wf.data.id}/stop-sharing`, {
    loop: { enabled: true, times: 0, intervalSeconds: 1 },
    executionMode: "background",
    webhookSlug: "sneaky-slug",
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = await A("GET", `/api/workflows/${wf.data.id}`);
  assert.ok(!after.data.loop || after.data.loop.enabled !== true, "loop must stay off");
  assert.notEqual(after.data.executionMode, "background", "background mode must stay off");
  assert.notEqual(after.data.webhookSlug, "sneaky-slug", "the slug must not be set through stop-sharing");
});
