// ============================================================================
// GitHub trigger — real webhook deliveries over HTTP.
//
// Spawns the real server (server/index.js) with an isolated temp database and
// drives /webhook/:id like GitHub would: POST a signed delivery with an
// X-GitHub-Event header. Verifies:
//   - a valid X-Hub-Signature-256 delivery executes the workflow (live mode)
//   - a missing / wrong signature is rejected (401)
//   - owner / repository / event filters silence non-matching deliveries
//   - without the "Always listen" option the URL only fires while a Run is
//     armed (one-shot); armed deliveries work exactly like the webhook
//
// GitHub's real service is never contacted — deliveries are synthesized with
// the same signing scheme GitHub uses (HMAC-SHA256 over the raw body).
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-gh-"));
const dbPath = path.join(tempDir, "gh.db");
const dataDir = path.join(tempDir, "data");

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

let child;
let base = "";
let cookie = "";
let workflowId = "";
let owner = "";

const SECRET = "hunter2-github-secret";
const EVENT = "issues";

function setCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  const first = raw[0];
  if (!first) return;
  cookie = first.split(";")[0];
}

async function api(method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  setCookie(res);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

function sign(payload, secret) {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

// POST a GitHub delivery exactly like GitHub does: raw JSON body + event +
// signature headers, no session cookie.
async function deliver(bodyObj, { event = EVENT, secret = SECRET, signature } = {}) {
  const body = JSON.stringify(bodyObj);
  const sig = signature !== undefined ? signature : sign(body, secret);
  const res = await fetch(`${base}/webhook/${workflowId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": sig,
      "User-Agent": "GitHub-Hookshot/abc",
    },
    body,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

function ghWorkflow(triggerConfig = {}) {
  const config = { owner: "", repo: "", event: EVENT, webhookSecret: SECRET, live: true, ...triggerConfig };
  return {
    name: "GitHub responder",
    description: "Replies to GitHub webhook deliveries",
    nodes: [
      { id: "trig", type: "githubTrigger", data: { label: "On GitHub", config } },
      {
        id: "echo",
        type: "set",
        data: { label: "Echo title", config: { fields: [{ key: "title", value: "{{title}}" }] } },
      },
    ],
    edges: [{ id: "e1", source: "trig", target: "echo", sourceHandle: "out", targetHandle: "in" }],
  };
}

const issuePayload = (overrides = {}) => ({
  action: "opened",
  issue: {
    number: 7,
    title: "Something is broken",
    labels: [{ name: "bug" }],
  },
  repository: { full_name: "octocat/Hello-World" },
  sender: { login: "octocat" },
  ...overrides,
});

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
      BF_DB_PATH: dbPath,
      BF_DATA_DIR: dataDir,
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[gh-srv] ${d}`));
  child.stderr.on("data", (d) => process.stdout.write(`[gh-srv-err] ${d}`));
  await waitForServer();

  // Register a fresh account and save the live GitHub workflow.
  const email = `gh-${Date.now()}@example.com`;
  const reg = await api("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: "GH Tester" });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  owner = email;
  const created = await api("POST", "/api/workflows", ghWorkflow());
  assert.equal(created.status, 200, JSON.stringify(created.data));
  workflowId = created.data.id;
  assert.ok(workflowId, "the server assigns the workflow an id");
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

test("github trigger (live): a valid signed delivery runs the workflow", async () => {
  const res = await deliver(issuePayload());
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.ok, true, "GitHub gets a 200 so it stops retrying");
  assert.equal(res.data.success, true, "the workflow executed successfully");
});

test("github trigger: missing or wrong signature is rejected (401)", async () => {
  // wrong signature
  const bad = await deliver(issuePayload(), { secret: "wrong-secret" });
  assert.equal(bad.status, 401, JSON.stringify(bad.data));

  // missing signature header entirely
  const body = JSON.stringify(issuePayload());
  const res = await fetch(`${base}/webhook/${workflowId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": EVENT },
    body,
  });
  assert.equal(res.status, 401, "a delivery without X-Hub-Signature-256 is rejected");
});

test("github trigger: non-matching events / repos are ignored with a 200", async () => {
  // Wrong event type (the trigger listens for "issues").
  const wrongEvent = await deliver(issuePayload(), { event: "push" });
  assert.equal(wrongEvent.status, 200);
  assert.ok(String(wrongEvent.data.ignored || "").length > 0, "a push delivery is ignored with an explanation, not retried");

  // A delivery for a different repository — the trigger's owner+repo filter
  // needs a workflow whose filters are set, so update it first.
  await api("PUT", `/api/workflows/${workflowId}`, {
    ...ghWorkflow({ owner: "octocat", repo: "Hello-World" }),
  });
  const otherRepo = await deliver(issuePayload({ repository: { full_name: "someone/Else" } }));
  assert.equal(otherRepo.status, 200);
  assert.ok(String(otherRepo.data.ignored || "").length > 0, "different-repo deliveries are ignored");
  // matching repo still runs
  const match = await deliver(issuePayload());
  assert.equal(match.status, 200);
  assert.equal(match.data.success, true);
});

test("github trigger: a delivery for a filtered-out label is ignored", async () => {
  await api("PUT", `/api/workflows/${workflowId}`, {
    ...ghWorkflow({ owner: "octocat", repo: "Hello-World", filterLabel: "urgent" }),
  });
  const noLabel = await deliver(issuePayload()); // issue has label "bug", not "urgent"
  assert.equal(noLabel.status, 200);
  assert.ok(String(noLabel.data.ignored || "").length > 0, "non-matching label deliveries are ignored");

  const matching = await deliver(issuePayload({ issue: { number: 8, title: "Urgent!", labels: [{ name: "urgent" }] } }));
  assert.equal(matching.data.success, true, "matching label runs the workflow");
});

test("github trigger (no always-listen): URL only fires while a Run is armed", async () => {
  // Turn the always-listen option off — the URL must then reject deliveries
  // unless a Run is waiting for one.
  await api("PUT", `/api/workflows/${workflowId}`, { ...ghWorkflow({ live: false }) });

  // 1. no Run armed → the delivery is refused
  const refused = await deliver(issuePayload());
  assert.equal(refused.status, 409, "without an armed run the URL is inert");
  assert.ok(String(refused.data.error || "").includes("not listening"), "explains why");

  // 2. press Run (no payload) → arms a one-shot wait for a GitHub delivery
  const armed = await api("POST", `/api/workflows/${workflowId}/run`);
  assert.equal(armed.status, 200, JSON.stringify(armed.data));
  assert.equal(armed.data.waiting, true, "the run waits for a real delivery");
  assert.equal(armed.data.kind, "githubTrigger");

  // 3. the next signed delivery completes the run
  const fired = await deliver(issuePayload());
  assert.equal(fired.status, 200, JSON.stringify(fired.data));
  assert.equal(fired.data.ok, true);

  // 4. the run was consumed — a further delivery is refused again
  const second = await deliver(issuePayload());
  assert.equal(second.status, 409, "one delivery per Run; the URL is inert afterwards");
});
