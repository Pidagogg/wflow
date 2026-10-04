// ============================================================================
// Sharing with roles, node comments and "who changed what" — driven over the
// real HTTP server with an isolated database + data dir:
//
//   - the owner sets a role per person: viewer (look), runner (look + run),
//     editor (change and save); older shares without a role stay editors
//   - folder shares carry a role too
//   - comments on nodes, replies, resolving, @mentions limited to people with
//     access, deleting
//   - every save that changes the graph lands in the history with its author
//     and the node before / after, so one node can be restored
//
// Run: node --test tests/sharing-roles.test.js
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-roles-"));
const dbPath = path.join(tempDir, "roles.db");
const dataDir = path.join(tempDir, "data");

const CONTACT_EMAIL = "support@example.com";
const PASSWORD = "correct-horse-battery";

let child;
let base = "";
let cookie = "";

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const raw = res.headers.getSetCookie?.() ?? [];
  if (raw[0]) cookie = raw[0].split(";")[0];
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

async function register(email, name) {
  const res = await api("POST", "/api/auth/register", { email, password: PASSWORD, name });
  assert.equal(res.status, 200, `register ${email}: ${JSON.stringify(res.data)}`);
}

async function loginAs(email) {
  const res = await api("POST", "/api/auth/login", { email, password: PASSWORD });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.data)}`);
}

function tinyWorkflow(name) {
  return {
    name,
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "l", type: "log", data: { label: "Log", config: {} } },
    ],
    edges: [{ id: "e", source: "m", target: "l", sourceHandle: "out", targetHandle: "in" }],
  };
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
      CONTACT_EMAIL: CONTACT_EMAIL,
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const deadline = Date.now() + 20_000;
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


const OWNER = `owner-${Date.now()}@example.com`;
const BOB = `bob-${Date.now()}@example.com`;
const EVE = `eve-${Date.now()}@example.com`;
let wfId = "";
let bobId = "";

test("roles decide who may look, run and change a shared workflow", async () => {
  await register(OWNER, "Olivia Owner");
  await register(BOB, "Bob Viewer");
  await register(EVE, "Eve Outsider");
  await loginAs(OWNER);
  const created = await api("POST", "/api/workflows", tinyWorkflow("Shared with roles"));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  wfId = created.data.id;
  const shared = await api("POST", `/api/workflows/${wfId}/share`, { email: BOB, role: "viewer" });
  assert.equal(shared.status, 200, JSON.stringify(shared.data));
  bobId = shared.data.collaborators[0].userId;
  assert.equal(shared.data.collaborators[0].role, "viewer");

  await loginAs(BOB);
  const opened = await api("GET", `/api/workflows/${wfId}`);
  assert.equal(opened.data.role, "viewer");
  const save = await api("PUT", `/api/workflows/${wfId}`, { ...tinyWorkflow("Renamed by viewer") });
  assert.equal(save.status, 403);
  assert.match(save.data.error, /only view/);
  const run = await api("POST", `/api/workflows/${wfId}/run`, {});
  assert.equal(run.status, 403, "a viewer cannot run");

  await loginAs(OWNER);
  const promoted = await api("PUT", `/api/workflows/${wfId}/share/${bobId}`, { role: "runner" });
  assert.equal(promoted.data.collaborators[0].role, "runner");
  await loginAs(BOB);
  assert.equal((await api("POST", `/api/workflows/${wfId}/run`, {})).status, 200, "a runner can run");
  assert.equal((await api("PUT", `/api/workflows/${wfId}`, tinyWorkflow("Renamed by runner"))).status, 403, "…but not save");

  await loginAs(OWNER);
  await api("PUT", `/api/workflows/${wfId}/share/${bobId}`, { role: "editor" });
  await loginAs(BOB);
  const edit = await api("PUT", `/api/workflows/${wfId}`, { ...tinyWorkflow("Renamed by editor") });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));

  await loginAs(EVE);
  assert.equal((await api("GET", `/api/workflows/${wfId}`)).status, 404, "no share, no access");
});

test("comments live on nodes, mention only people with access and can be resolved", async () => {
  await loginAs(BOB);
  const people = (await api("GET", `/api/workflows/${wfId}/comments`)).data.people;
  const owner = people.find((p) => p.role === "owner");
  assert.ok(owner && people.some((p) => p.userId === bobId));

  const eveId = "not-a-member";
  const first = await api("POST", `/api/workflows/${wfId}/comments`, { nodeId: "l", text: "@Olivia should this log more?", mentions: [owner.userId, eveId] });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data.comment.mentions, [owner.userId], "only people with access can be mentioned");
  assert.equal(first.data.comment.nodeId, "l");

  await loginAs(OWNER);
  const reply = await api("POST", `/api/workflows/${wfId}/comments`, { parentId: first.data.comment.id, text: "Yes, add the item count." });
  assert.equal(reply.data.comment.parentId, first.data.comment.id);
  assert.equal(reply.data.comment.nodeId, "l", "a reply stays on the thread's node");
  const resolved = await api("PATCH", `/api/workflows/${wfId}/comments/${reply.data.comment.id}`, { resolved: true });
  assert.equal(resolved.status, 200);
  const list = (await api("GET", `/api/workflows/${wfId}/comments`)).data.comments;
  assert.equal(list.find((c) => c.id === first.data.comment.id).resolved, true, "resolving a reply resolves its thread");

  const notMine = await api("PATCH", `/api/workflows/${wfId}/comments/${first.data.comment.id}`, { text: "rewritten" });
  assert.equal(notMine.status, 403, "only the author edits the text");
  assert.equal((await api("DELETE", `/api/workflows/${wfId}/comments/${first.data.comment.id}`)).status, 200, "the owner may delete");
  assert.equal((await api("GET", `/api/workflows/${wfId}/comments`)).data.comments.length, 0, "the thread's replies go with it");
});

test("the history names who changed which node, with the node before and after", async () => {
  await loginAs(OWNER);
  const wf = (await api("GET", `/api/workflows/${wfId}`)).data;
  wf.nodes.find((n) => n.id === "l").data.config.message = "count: {{json}}";
  const saved = await api("PUT", `/api/workflows/${wfId}`, { name: wf.name, nodes: wf.nodes, edges: wf.edges, manual: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const entries = (await api("GET", `/api/workflows/${wfId}/history`)).data.entries;
  const mine = entries[0];
  assert.equal(mine.author, "Olivia Owner");
  const change = mine.nodes.find((n) => n.nodeId === "l");
  assert.equal(change.kind, "changed");
  assert.deepEqual(change.fields, ["message"]);
  assert.equal(change.after.data.config.message, "count: {{json}}");
  assert.equal(change.before.data.config.message, undefined, "the node as it was — what “restore this node” puts back");
  assert.ok(entries.some((e) => e.author === "Bob Viewer"), "the collaborator's earlier save is listed under their name");
});

test("a folder share carries a role too", async () => {
  await loginAs(OWNER);
  const folders = (await api("GET", "/api/workflows/folders")).data;
  const home = folders[0];
  await api("DELETE", `/api/workflows/${wfId}/share/${bobId}`);
  const share = await api("POST", `/api/workflows/folders/${home.id}/share`, { email: EVE, role: "runner" });
  assert.equal(share.status, 200, JSON.stringify(share.data));
  assert.equal(share.data.share.role, "runner");
  await loginAs(EVE);
  assert.equal((await api("GET", `/api/workflows/${wfId}`)).data.role, "runner");
  assert.equal((await api("PUT", `/api/workflows/${wfId}`, tinyWorkflow("x"))).status, 403);
  await loginAs(OWNER);
  await api("PATCH", `/api/workflows/folders/${home.id}/share`, { role: "editor" });
  await loginAs(EVE);
  assert.equal((await api("GET", `/api/workflows/${wfId}`)).data.role, "editor");
});
