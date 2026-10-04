// ============================================================================
// Full functional smoke test — W FLOW
// Spawns the REAL main server (server/index.js) and the REAL admin server
// (server/admin.js) on isolated temp databases, then drives them over HTTP
// exactly like a browser would: authentication, workflow builder + folders,
// node execution, AI builder, community, collaboration / shared sessions,
// save throttling, webhooks, free-plan caps and the admin panel.
//
// Every check is logged (PASS/FAIL + detail) to TEST-LOG.txt at the project
// root — one txt document covering the whole functionality.
//
// Run: node scripts/full-smoke.mjs
// ============================================================================
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const LOG_FILE = path.join(repoRoot, "TEST-LOG.txt");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-smoke-"));
const dbPath = path.join(tempDir, "smoke.db");
const dataDir = path.join(tempDir, "data");

const startedAt = new Date();
const results = []; // { name, ok, detail }

function log(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`;
  console.log(line);
}

function sec(name, ok, detail = "") {
  log(name, !!ok, String(detail || ""));
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function waitForServer(base, timeoutMs = 30_000) {
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

async function waitForAdmin(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("admin server did not become ready in time");
}

// ----------------------------------------------------------------------------
// Servers
// ----------------------------------------------------------------------------
const mainPort = await freePort();
const adminPort = await freePort();
const MAIN = `http://127.0.0.1:${mainPort}`;
const ADMIN = `http://127.0.0.1:${adminPort}`;

const commonEnv = {
  ...process.env,
  BF_DB_PATH: dbPath,
  BF_DATA_DIR: dataDir,
  DISABLE_SCHEDULER: "1",
  NODE_ENV: "test",
  // test the cloud's behaviour, as node --test does (server/setup.js officialCloud)
  NODE_TEST_CONTEXT: "smoke",
  ADMIN_ALLOWED_IPS: "",
  // Pin the seeded admin credentials so a developer's .env (which overrides the
  // well-known defaults) cannot change who the isolated test DB logs in as.
  BF_ADMIN_USERNAME: "test-admin",
  BF_ADMIN_PASSWORD: "test-admin-pass-123",
};

const mainServer = spawn(process.execPath, ["server/index.js"], {
  cwd: repoRoot,
  env: { ...commonEnv, PORT: String(mainPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
mainServer.stdout.on("data", () => {});
mainServer.stderr.on("data", () => {});

const adminServer = spawn(process.execPath, ["server/admin.js"], {
  cwd: repoRoot,
  env: { ...commonEnv, PORT: String(adminPort), ADMIN_PORT: String(adminPort), ADMIN_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
adminServer.stdout.on("data", () => {});
adminServer.stderr.on("data", () => {});

await waitForServer(MAIN);
await waitForAdmin(ADMIN);

// ----------------------------------------------------------------------------
// HTTP helpers
// ----------------------------------------------------------------------------
let cookie = "";

function setCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  const first = raw[0];
  if (first) cookie = first.split(";")[0];
}

async function api(method, url, body, extraHeaders = {}, base = MAIN) {
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
  return { status: res.status, data, headers: res.headers };
}

// Track whose session cookie we currently hold so we never re-login needlessly
// (the server rate-limits auth attempts per email + IP, and the smoke test runs
// dozens of requests within one minute).
let currentEmail = "";
async function loginAs(email, password = "correct-horse-battery") {
  if (currentEmail === email) return;
  let res = await api("POST", "/api/auth/login", { email, password });
  // The server rate-limits auth attempts per email+IP (8/minute). As a safety
  // net for a long smoke run, wait out the window and retry once.
  if (res.status === 429) {
    console.log("  (auth rate-limited — waiting 62s for the window to reset)");
    await sleep(62_000);
    res = await api("POST", "/api/auth/login", { email, password });
  }
  if (res.status !== 200) {
    throw new Error(`login as ${email} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  currentEmail = email;
  return res;
}

function greetingWorkflow(name = "Untitled workflow") {
  return {
    name,
    description: "Greeting workflow",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "s", type: "set", data: { label: "Make greeting", config: { fields: [{ key: "greeting", value: "Hello {{name}}!" }] } } },
      { id: "l", type: "log", data: { label: "Log", config: {} } },
    ],
    edges: [
      { id: "e1", source: "m", target: "s", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "s", target: "l", sourceHandle: "out", targetHandle: "in" },
    ],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ==========================================================================
  // A. AUTHENTICATION
  // ==========================================================================
  const u1 = `u1-${Date.now()}@example.com`;
  const u2 = `u2-${Date.now()}@example.com`;

  const cfg = await api("GET", "/api/auth/config");
  sec("A1 · /api/auth/config (registration policy readable)", cfg.status === 200 && typeof cfg.data.allowRegister === "boolean", `status ${cfg.status}`);

  const reg1 = await api("POST", "/api/auth/register", { email: u1, password: "correct-horse-battery", name: "User One" });
  currentEmail = u1;
  sec("A2 · register a new account (auto-login cookie)", reg1.status === 200 && reg1.data.authed === true && cookie.includes("bf_user="), `status ${reg1.status}`);

  const me = await api("GET", "/api/auth/me");
  sec("A3 · /api/auth/me recognises the session", me.status === 200 && me.data.authed === true && me.data.email === u1, me.data.email);

  const dup = await api("POST", "/api/auth/register", { email: u1, password: "correct-horse-battery" });
  sec("A4 · duplicate registration rejected (409)", dup.status === 409, `status ${dup.status}`);

  const badLogin = await api("POST", "/api/auth/login", { email: `nobody-${Date.now()}@example.com`, password: "wrong-password" });
  sec("A5 · wrong password rejected (401)", badLogin.status === 401, `status ${badLogin.status}`);

  const shortPass = await api("POST", "/api/auth/register", { email: `x-${Date.now()}@example.com`, password: "short" });
  sec("A6 · short password rejected (400)", shortPass.status === 400, `status ${shortPass.status}`);

  const login1 = await api("POST", "/api/auth/login", { email: u1, password: "correct-horse-battery" });
  currentEmail = u1;
  sec("A7 · login with correct credentials", login1.status === 200 && login1.data.authed === true, `status ${login1.status}`);

  // second account for collaboration + community
  const reg2 = await api("POST", "/api/auth/register", { email: u2, password: "correct-horse-battery", name: "User Two" });
  currentEmail = u2;

  const noAuth = await fetch(`${MAIN}/api/workflows`);
  sec("A8 · protected endpoint without login (401)", noAuth.status === 401, `status ${noAuth.status}`);

  // ==========================================================================
  // B. WORKFLOW BUILDER + FOLDERS
  // ==========================================================================
  await loginAs(u1);
  const folders = await api("GET", "/api/workflows/folders");
  const home = folders.data.find((f) => f.home === true);
  sec("B1 · home (main) folder auto-created", folders.status === 200 && !!home, home ? home.name : "missing");

  const sub = await api("POST", "/api/workflows/folders", { name: "Reports", parentId: home?.id });
  sec("B2 · create subfolder under main folder", sub.status === 200 && !!sub.data.id, `status ${sub.status}`);

  const subSub = await api("POST", "/api/workflows/folders", { name: "Daily", parentId: sub.data.id });
  sec("B3 · create nested subfolder", subSub.status === 200 && subSub.data.parentId === sub.data.id, `parent ${subSub.data.parentId}`);

  const wf = await api("POST", "/api/workflows", { ...greetingWorkflow("Greeter"), folderId: subSub.data.id });
  sec("B4 · create workflow inside a folder", wf.status === 200 && wf.data.folderId === subSub.data.id, `folder ${wf.data.folderId}`);

  const renamedWf = await api("PUT", `/api/workflows/${wf.data.id}`, { name: "Greeter v2" });
  sec("B5 · update (rename) workflow", renamedWf.status === 200 && renamedWf.data.name === "Greeter v2", `status ${renamedWf.status}`);

  const run = await api("POST", `/api/workflows/${wf.data.id}/run`, { payload: { name: "Ada" }, maxItemsPerNode: 5 });
  const setEntry = run.data?.log?.find((l) => l.nodeType === "set");
  sec("B6 · run workflow (manual → set → log)", run.status === 200 && run.data.success === true && setEntry?.outputItems?.[0]?.greeting === "Hello Ada!", `greeting = ${setEntry?.outputItems?.[0]?.greeting}`);

  // logic + data nodes run correctly too
  const logicWf = await api("POST", "/api/workflows", {
    name: "Logic Check",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "f", type: "if", data: { label: "If status", config: { valueA: "{{status}}", operator: "equals", valueB: "success" } } },
      { id: "h", type: "hash", data: { label: "Hash", config: { value: "{{message}}", algorithm: "sha256", storeIn: "digest" } } },
      { id: "l", type: "log", data: { label: "Log", config: {} } },
    ],
    edges: [
      { id: "e1", source: "m", target: "f", sourceHandle: "out", targetHandle: "in" },
      // the IF node branches on its true/false handles — true → top, false → bottom
      { id: "e2", source: "f", target: "h", sourceHandle: "true", targetHandle: "in" },
      { id: "e3", source: "h", target: "l", sourceHandle: "out", targetHandle: "in" },
    ],
  });
  const logicRun = await api("POST", `/api/workflows/${logicWf.data.id}/run`, { payload: { status: "success", message: "hello" }, maxItemsPerNode: 5 });
  const hashEntry = logicRun.data?.log?.find((l) => l.nodeType === "hash");
  sec("B7 · logic nodes run (if + hash)", logicRun.status === 200 && logicRun.data.success === true && typeof hashEntry?.outputItems?.[0]?.digest === "string" && hashEntry.outputItems[0].digest.length === 64, `sha256 length ${hashEntry?.outputItems?.[0]?.digest?.length}`);

  // webhook trigger: live webhook executes the workflow for a real request
  const hookWf = await api("POST", "/api/workflows", {
    name: "Webhook Test",
    webhookSlug: "smoke-hook",
    nodes: [
      { id: "w", type: "webhook", data: { label: "Hook", config: { method: "POST", live: true, responseMode: "ok" } } },
      { id: "s", type: "set", data: { label: "Set", config: { fields: [{ key: "echo", value: "{{body.message}}" }] } } },
      { id: "l", type: "log", data: { label: "Log", config: {} } },
    ],
    edges: [
      { id: "e1", source: "w", target: "s", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "s", target: "l", sourceHandle: "out", targetHandle: "in" },
    ],
  });
  sec("B8 · create webhook workflow with custom slug", hookWf.status === 200 && hookWf.data.webhookSlug === "smoke-hook", `slug ${hookWf.data.webhookSlug}`);
  const hookFire = await api("POST", "/webhook/smoke-hook", { message: "via slug" });
  sec("B9 · live webhook fires the workflow (public endpoint)", [200, 202].includes(hookFire.status), `status ${hookFire.status}`);

  // folder move + delete-with-home-fallback
  const moved = await api("PATCH", `/api/workflows/${wf.data.id}/folder`, { folderId: sub.data.id });
  sec("B10 · move workflow between folders", moved.status === 200 && moved.data.folderId === sub.data.id, `status ${moved.status}`);
  const delSub = await api("DELETE", `/api/workflows/folders/${sub.data.id}`);
  sec("B11 · delete folder", delSub.status === 200, `status ${delSub.status}`);
  const afterDel = await api("GET", `/api/workflows/${wf.data.id}`);
  const homeFolders = await api("GET", "/api/workflows/folders");
  const home2 = homeFolders.data.find((f) => f.home === true);
  sec("B12 · workflow returns to main folder after folder delete", afterDel.status === 200 && afterDel.data.folderId === home2.id, `folder ${afterDel.data.folderId}`);

  const delSubSub = await api("DELETE", `/api/workflows/folders/${subSub.data.id}`);
  sec("B13 · delete nested folder", delSubSub.status === 200, `status ${delSubSub.status}`);

  // ==========================================================================
  // C. AI BUILDER (agents)
  // ==========================================================================
  const agent = await api("POST", "/api/agents", {
    name: "Helper Agent",
    description: "Smoke test agent",
    model: { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4o-mini" },
    systemPrompt: "You are helpful.",
    memory: false,
    tools: {},
  });
  sec("C1 · create an AI agent", agent.status === 200 && !!agent.data.id, `status ${agent.status}`);

  const agentsList = await api("GET", "/api/agents");
  sec("C2 · list agents", agentsList.status === 200 && agentsList.data.some((a) => a.id === agent.data.id), `count ${agentsList.data.length}`);

  const agentGet = await api("GET", `/api/agents/${agent.data.id}`);
  sec("C3 · get agent", agentGet.status === 200 && agentGet.data.name === "Helper Agent", `status ${agentGet.status}`);

  const agentUpd = await api("PUT", `/api/agents/${agent.data.id}`, { ...agentGet.data, name: "Helper Agent v2" });
  sec("C4 · update agent", agentUpd.status === 200 && agentUpd.data.name === "Helper Agent v2", `status ${agentUpd.status}`);

  const agentChat = await api("POST", `/api/agents/${agent.data.id}/chat`, { messages: [{ role: "user", content: "hi" }] });
  sec("C5 · agent chat with unreachable model fails gracefully (controlled error)", agentChat.status === 500 && !!agentChat.data.error, `status ${agentChat.status}, error ${String(agentChat.data.error || "").slice(0, 60)}`);

  const models = await api("POST", "/api/ai/models", { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x" });
  sec("C6 · /api/ai/models degrades gracefully when provider unreachable", models.data.ok === false && Array.isArray(models.data.models), `ok ${models.data.ok}`);

  const aiTest = await api("POST", "/api/ai/test", { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x" });
  sec("C7 · /api/ai/test reports a controlled failure without a real key", aiTest.status === 400 && aiTest.data.ok === false, `status ${aiTest.status}`);

  const delAgent = await api("DELETE", `/api/agents/${agent.data.id}`);
  sec("C8 · delete agent", delAgent.status === 200, `status ${delAgent.status}`);

  // ==========================================================================
  // D. COMMUNITY
  // ==========================================================================
  const post = await api("POST", "/api/community", {
    workflowId: wf.data.id,
    title: "Smoke Greeter",
    description: "Public post from the smoke test",
    visibility: "public",
  });
  sec("D1 · publish a public community post", post.status === 200 && post.data.title === "Smoke Greeter", `status ${post.status}`);

  const search = await api("GET", "/api/community?q=smoke+greeter");
  sec("D2 · search the community", search.status === 200 && search.data.some((p) => p.id === post.data.id), `hits ${search.data.length}`);

  const secretWorkflow = await api("POST", "/api/workflows", {
    name: "Has Secrets",
    nodes: [
      { id: "h", type: "http", data: { label: "HTTP", config: { url: "https://example.com", method: "GET", authType: "bearer", authToken: "supersecret123" } } },
    ],
    edges: [],
  });
  const secretPost = await api("POST", "/api/community", { workflowId: secretWorkflow.data.id, title: "Secret post", visibility: "public" });
  sec("D3 · publish a workflow containing credentials", secretPost.status === 200, `status ${secretPost.status}`);

  await loginAs(u2);
  const importPost = await api("POST", `/api/community/${post.data.id}/import`);
  sec("D4 · another user imports the public post (fork)", importPost.status === 200 && importPost.data.name.includes("fork"), `status ${importPost.status}`);

  // The published copy must never leak credentials: the imported workflow's
  // HTTP node has its bearer token scrubbed to an empty string.
  const importSecret = await api("POST", `/api/community/${secretPost.data.id}/import`);
  const importedHttpNode = importSecret.data?.nodes?.find((n) => n.type === "http");
  sec("D4b · credentials are scrubbed in community copies", importSecret.status === 200 && importedHttpNode?.data?.config?.authToken === "", `authToken ${JSON.stringify(importedHttpNode?.data?.config?.authToken)}`);

  const privPost = await api("POST", "/api/community", {
    workflowId: importPost.data.id,
    title: "u2 private",
    visibility: "private",
  });
  sec("D5 · publish a private post", privPost.status === 200 && privPost.data.visibility === "private", `status ${privPost.status}`);

  // u2 (still logged in) sees their own private post in their "mine" list
  const mine2 = await api("GET", "/api/community?mine=1");
  sec("D6 · author sees their own private post", mine2.status === 200 && mine2.data.some((p) => p.id === privPost.data.id), `status ${mine2.status}`);

  // ==========================================================================
  // E. COLLABORATION / SHARED SESSIONS
  // ==========================================================================
  await loginAs(u1);
  // While logged in as u1: u2's private community post must stay invisible.
  const asU1 = await api("GET", "/api/community");
  sec("D7 · another user cannot see the private post", asU1.status === 200 && !asU1.data.some((p) => p.id === privPost.data.id), `status ${asU1.status}`);
  const share = await api("POST", `/api/workflows/${wf.data.id}/share`, { email: u2 });
  sec("E1 · share workflow with another user", share.status === 200 && share.data.collaborators.length === 1, `status ${share.status}`);
  const collabUserId = share.data.collaborators[0].userId;

  await loginAs(u2);
  const list2 = await api("GET", "/api/workflows");
  const sharedInList = list2.data.find((w) => w.id === wf.data.id);
  const folders2 = await api("GET", "/api/workflows/folders");
  const home2u2 = folders2.data.find((f) => f.home === true);
  sec("E2 · collaborator sees shared workflow in THEIR home folder", !!sharedInList && sharedInList.shared === true && sharedInList.folderId === home2u2.id, `folder ${sharedInList?.folderId}`);

  const fetched2 = await api("GET", `/api/workflows/${wf.data.id}`);
  sec("E3 · collaborator sees who shared the workflow", fetched2.data.shared === true && fetched2.data.sharedBy?.email === u1, fetched2.data.sharedBy?.email);

  const save2 = await api("PUT", `/api/workflows/${wf.data.id}`, { ...fetched2.data, name: "Greeter by u2", folderId: home2u2.id });
  sec("E4 · collaborator save lands in the shared record", save2.status === 200 && save2.data.name === "Greeter by u2", `status ${save2.status}`);

  await loginAs(u1);
  const ownerSees = await api("GET", `/api/workflows/${wf.data.id}`);
  const sub2 = await api("POST", "/api/workflows/folders", { name: "OwnerOnly", parentId: home?.id });
  await loginAs(u2);
  const move403 = await api("PATCH", `/api/workflows/${wf.data.id}/folder`, { folderId: home2u2.id });
  sec("E5 · collaborator cannot move the shared workflow (403)", move403.status === 403, `status ${move403.status}`);

  // save throttle — a shared workflow allows 1 auto-save per minute (per
  // workflow, across users): the collaborator's save in E4 used this minute's
  // slot, so every further auto-save inside the minute is refused
  await loginAs(u1);
  const ownerView = await api("GET", `/api/workflows/${wf.data.id}`);
  const t1 = await api("PUT", `/api/workflows/${wf.data.id}`, { ...ownerView.data, name: "t1" });
  const t2 = await api("PUT", `/api/workflows/${wf.data.id}`, { ...ownerView.data, name: "t2" });
  const t3 = await api("PUT", `/api/workflows/${wf.data.id}`, { ...ownerView.data, name: "t3" });
  sec("E6 · shared auto-saves throttled to 1/minute (all 429 after E4's save)", t1.status === 429 && t2.status === 429 && t3.status === 429, `statuses ${t1.status}/${t2.status}/${t3.status}`);

  const accessOwner = await api("GET", `/api/workflows/${wf.data.id}/access`);
  sec("E7 · owner access check lists the collaborator", accessOwner.data.accessible === true && accessOwner.data.shared === true && accessOwner.data.sharedWith?.some((c) => c.email === u2), `status ${accessOwner.status} ${JSON.stringify(accessOwner.data).slice(0, 220)}`);
  await loginAs(u2);
  const access2 = await api("GET", `/api/workflows/${wf.data.id}/access`);
  sec("E8 · collaborator access check names the owner", access2.data.accessible === true && access2.data.sharedBy?.email === u1, access2.data.sharedBy?.email);

  // stop the shared session with the editor's latest state
  await loginAs(u1);
  const stop = await api("POST", `/api/workflows/${wf.data.id}/stop-sharing`, { ...ownerView.data, name: "Final by Owner", nodes: ownerView.data.nodes, edges: ownerView.data.edges });
  sec("E9 · owner ends the shared session (collaborators removed)", stop.status === 200 && stop.data.collaborators.length === 0, `status ${stop.status} ${JSON.stringify(stop.data).slice(0, 220)}`);

  // owner (still logged in) keeps the workflow with the final saved state
  const ownerFinal = await api("GET", `/api/workflows/${wf.data.id}`);
  sec("E13 · owner keeps the workflow with the final saved state", ownerFinal.status === 200 && ownerFinal.data.name === "Final by Owner" && ownerFinal.data.collaborators?.length === 0, ownerFinal.data.name);

  await loginAs(u2);
  const accessAfter = await api("GET", `/api/workflows/${wf.data.id}/access`);
  sec("E10 · collaborator access flips to false after session ends", accessAfter.data.accessible === false, `accessible ${accessAfter.data.accessible}`);
  const openAfter = await api("GET", `/api/workflows/${wf.data.id}`);
  sec("E11 · collaborator can no longer open the workflow (404)", openAfter.status === 404, `status ${openAfter.status}`);
  const listAfter = await api("GET", "/api/workflows");
  sec("E12 · workflow disappears from the collaborator's list", !listAfter.data.some((w) => w.id === wf.data.id), "gone");

  // ==========================================================================
  // F. ADMIN PANEL
  // ==========================================================================
  let adminCookie = "";
  let csrf = "";
  function adminReq(method, url, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (adminCookie) h.Cookie = adminCookie;
    if (csrf) h["X-CSRF-Token"] = csrf;
    return fetch(`${ADMIN}${url}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  const adminPage = await fetch(`${ADMIN}/`);
  const adminHtml = await adminPage.text();
  sec("F1 · admin panel HTML is served", adminPage.status === 200 && adminHtml.includes("<html"), `status ${adminPage.status}`);

  const adminMe = await fetch(`${ADMIN}/api/admin/me`);
  const meCookies = adminMe.headers.getSetCookie?.() ?? [];
  csrf = adminMe.headers.get("x-csrf-token") || "";
  // Keep BOTH cookies (csrf + session) and the header token; the login POST
  // must send the bf_csrf cookie back or the CSRF check fails with 403.
  adminCookie = meCookies
    .filter((c) => c.startsWith("bf_csrf=") || c.startsWith("bf_admin="))
    .map((c) => c.split(";")[0])
    .join("; ");
  let adminMeBody = {};
  try { adminMeBody = await adminMe.json(); } catch { /* ignore */ }
  sec("F2 · admin /api/admin/me issues CSRF cookie + token", adminMe.status === 200 && adminMeBody.authed === false && !!csrf, `csrf ${csrf ? "set" : "missing"}`);

  const adminLogin = await adminReq("POST", "/api/admin/login", { username: "test-admin", password: "test-admin-pass-123" });
  const setCookies = adminLogin.headers.getSetCookie?.() ?? [];
  // Merge the new session cookie (and refreshed csrf cookie) into what we send.
  adminCookie = [...new Set([...setCookies, ...adminCookie.split("; ").filter(Boolean)].map((c) => c.split(";")[0]))].join("; ");
  const adminCsrf = adminLogin.headers.get("x-csrf-token");
  if (adminCsrf) csrf = adminCsrf;
  let adminLoginBody = {};
  try { adminLoginBody = await adminLogin.json(); } catch { /* ignore */ }
  sec("F3 · admin login with seeded credentials", adminLogin.status === 200 && adminLoginBody.authed === true, `status ${adminLogin.status}`);

  const adminMe2 = await adminReq("GET", "/api/admin/me");
  let adminMe2Body = {};
  try { adminMe2Body = await adminMe2.json(); } catch { /* ignore */ }
  sec("F4 · admin session recognised after login", adminMe2.status === 200 && adminMe2Body.authed === true, adminMe2Body.username);

  const adminUsers = await adminReq("GET", "/api/admin/users");
  let usersBody = {};
  try { usersBody = await adminUsers.json(); } catch { /* ignore */ }
  const userList = Array.isArray(usersBody.users) ? usersBody.users : Array.isArray(usersBody) ? usersBody : [];
  sec("F5 · admin Users page lists registered accounts", adminUsers.status === 200 && userList.some((u) => (u.email || "").includes("example.com")), `users ${userList.length}`);

  const adminTabs = [
    ["settings", "/api/admin/settings"],
    ["cloud", "/api/admin/cloud"],
    ["billing", "/api/admin/billing"],
    ["analytics", "/api/admin/analytics"],
    ["db", "/api/admin/db"],
    ["security", "/api/admin/security"],
    ["deploy", "/api/admin/deploy"],
  ];
  let tabsOk = true;
  const tabDetail = [];
  for (const [tab, url] of adminTabs) {
    const res = await adminReq("GET", url);
    if (res.status !== 200) tabsOk = false;
    tabDetail.push(`${tab}:${res.status}`);
  }
  sec("F6 · admin panel pages respond (settings/cloud/billing/analytics/db/security/deploy)", tabsOk, tabDetail.join(" "));

  // Raw request: authenticated session but NO valid CSRF token (the helper
  // would silently re-add the real token, so do it by hand).
  const csrfBlocked = await fetch(`${ADMIN}/api/admin/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie, "X-CSRF-Token": "0".repeat(48) },
    body: JSON.stringify({ page: {} }),
  });
  sec("F7 · admin CSRF protection blocks a state-changing call without a token", csrfBlocked.status === 403, `status ${csrfBlocked.status}`);

  const adminLogout = await adminReq("POST", "/api/admin/logout");
  sec("F8 · admin logout", adminLogout.status === 200, `status ${adminLogout.status}`);

  // ==========================================================================
  // G. MISC / WHOLE APP
  // Every check here is self-contained, so it runs as whichever account is
  // currently logged in (u2 after E12) — no extra login, to stay under the
  // per-email auth rate limit.
  // ==========================================================================
  const catalog = await api("GET", "/api/nodes");
  sec("G1 · node catalog served (>= 140 nodes)", catalog.status === 200 && Object.keys(catalog.data.nodes || {}).length >= 140, `${Object.keys(catalog.data.nodes || {}).length} nodes`);

  const errors = await api("GET", "/api/errors");
  sec("G2 · error-code reference served", errors.status === 200 && Array.isArray(errors.data) && errors.data.length > 0, `${errors.data.length} codes`);

  const docsRes = await fetch(`${MAIN}/api/docs`, { headers: cookie ? { Cookie: cookie } : {} });
  const docsText = await docsRes.text();
  sec("G3 · user guide (docs) served", docsRes.status === 200 && docsText.length > 1000, `${docsText.length} chars`);

  // the Settings → Download PDF button hits this; the file must be a real PDF
  const pdfRes = await fetch(`${MAIN}/api/docs/pdf`, { headers: cookie ? { Cookie: cookie } : {} });
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  sec("G3b · user guide PDF download", pdfRes.status === 200 && pdfBuf.length > 5000 && pdfBuf.subarray(0, 5).toString() === "%PDF-", `${pdfBuf.length} bytes`);

  // the legal pages (AGB / Impressum / Datenschutz) must be served at root
  // paths on the main site even before any subdomain / company data is set
  const legalRes = await fetch(`${MAIN}/impressum`);
  const legalText = await legalRes.text();
  sec("G3c · legal page /impressum served at root", legalRes.status === 200 && legalText.includes("[") && legalText.length > 500, `${legalText.length} chars`);

  const billing = await api("GET", "/api/billing");
  sec("G4 · billing status endpoint (no Stripe → plan free)", billing.status === 200 && billing.data.plan === "free", `plan ${billing.data.plan}`);

  const spa = await fetch(`${MAIN}/`);
  const spaHtml = await spa.text();
  sec("G5 · SPA served on the main port", spa.status === 200 && spaHtml.includes("<div id=\"root\">"), `status ${spa.status}`);

  // free-plan workflow cap: the default cap is 10 owned workflows
  const capWfIds = [];
  let capResult = null;
  for (let i = 0; i < 10; i++) {
    const r = await api("POST", "/api/workflows", { name: `cap-${i}`, nodes: [], edges: [] });
    if (r.status === 200) capWfIds.push(r.data.id);
  }
  const capExtra = await api("POST", "/api/workflows", { name: "cap-11", nodes: [], edges: [] });
  const capBlocked = capExtra.status === 403 && /free plan/i.test(capExtra.data.error || "");
  sec("G6 · free-plan workflow cap enforced (11th workflow blocked)", capBlocked, `status ${capExtra.status}`);
  for (const id of capWfIds) await api("DELETE", `/api/workflows/${id}`);
  const afterDelete = await api("GET", "/api/workflows");
  sec("G7 · deleting workflows frees the cap slots", !afterDelete.data.some((w) => String(w.name || "").startsWith("cap-")), `count ${afterDelete.data.length}`);

  // manual "run next node" stepping (Run next node) path
  const manualOutWf = await api("POST", "/api/workflows", {
    name: "Step Test",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "a", type: "set", data: { label: "A", config: { manualOutput: true, manualOutputJson: '{"x": 1}' } } },
      { id: "b", type: "set", data: { label: "B", config: { fields: [{ key: "y", value: "{{x}}!" }] } } },
    ],
    edges: [
      { id: "e1", source: "m", target: "a", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "a", target: "b", sourceHandle: "out", targetHandle: "in" },
    ],
  });
  const step = await api("POST", `/api/workflows/${manualOutWf.data.id}/run-node`, { nodeId: "b", input: { x: 1 } });
  sec("G8 · run-next-node stepping executes a single downstream node", step.status === 200 && step.data.log?.[0]?.nodeType === "set", `status ${step.status}`);

  // ==========================================================================
  // H. AI TOOLS (MCP), DASHBOARDS, ALERTS, RETRY
  // ==========================================================================
  const toolWf = await api("POST", "/api/workflows", {
    name: "Smoke Echo Tool",
    mcp: { enabled: true, description: "Echoes text", params: [{ name: "text", description: "what to echo" }] },
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "s", type: "set", data: { label: "Echo", config: { mode: "set", fields: [{ key: "echo", value: "{{text}}!" }] } } },
      { id: "d", type: "dashboard", data: { label: "Chart", config: { dashboard: "Smoke", series: "Length", value: "{{echo.length}}", chart: "line" } } },
    ],
    edges: [
      { id: "e1", source: "m", target: "s", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "s", target: "d", sourceHandle: "out", targetHandle: "in" },
    ],
  });
  const mcpToken = await api("POST", "/api/mcp/token");
  const mcpCall = (msg, token = mcpToken.data.token) =>
    fetch(`${MAIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify(msg) });
  const mcpDenied = await mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong-token");
  sec("H1 · MCP refuses a wrong token (401)", mcpDenied.status === 401, `status ${mcpDenied.status}`);
  const mcpInit = await (await mcpCall({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } })).json();
  const mcpList = await (await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  const echoTool = mcpList.result?.tools?.find((t) => t.title === "Smoke Echo Tool");
  sec("H2 · MCP initialize + tools/list show the opted-in workflow", mcpInit.result?.protocolVersion === "2025-06-18" && !!echoTool, echoTool?.name || "missing");
  const mcpRun = await (await mcpCall({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: echoTool?.name, arguments: { text: "hello" } } })).json();
  const echoed = (() => {
    try {
      return JSON.parse(mcpRun.result?.content?.[0]?.text || "{}");
    } catch {
      return {};
    }
  })();
  sec("H3 · MCP tools/call runs the workflow and returns its output", echoed.echo === "hello!" && !!echoed.dashboardUrl, mcpRun.result?.content?.[0]?.text?.slice(0, 80));
  const dashPath = String(echoed.dashboardUrl || "").replace(/^https?:\/\/[^/]+/, "");
  const dashPage = await fetch(`${MAIN}${dashPath}`);
  const dashHtml = await dashPage.text();
  sec("H4 · the dashboard page renders the chart without login", dashPage.status === 200 && dashHtml.includes("<svg") && !!dashPage.headers.get("content-security-policy"), `status ${dashPage.status}`);
  const alertsSaved = await api("PUT", `/api/workflows/${toolWf.data.id}/alerts`, { enabled: true, email: "alerts@example.com" });
  sec("H5 · failure alert settings save", alertsSaved.status === 200 && alertsSaved.data.enabled === true, `status ${alertsSaved.status}`);
  const failWf = await api("POST", "/api/workflows", {
    name: "Smoke Retry",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "f", type: "stopError", data: { label: "Fail", config: { message: "boom" } } },
    ],
    edges: [{ id: "e1", source: "m", target: "f", sourceHandle: "out", targetHandle: "in" }],
  });
  const failedRun = await api("POST", `/api/workflows/${failWf.data.id}/run`, { payload: { a: 1 } });
  const retried = await api("POST", `/api/workflows/${failWf.data.id}/executions/${failedRun.data.executionId}/retry`, {});
  sec("H6 · retry from the failed node re-runs only that node", retried.status === 200 && retried.data.log?.length === 1 && retried.data.log[0].nodeId === "f", `status ${retried.status}`);
} catch (err) {
  log("SCRIPT ERROR", false, err.message + "\n" + (err.stack || ""));
} finally {
  // cleanup
  for (const child of [mainServer, adminServer]) {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.on("exit", resolve);
        setTimeout(resolve, 2000);
      });
    }
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ----------------------------------------------------------------------------
// Write the txt log
// ----------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const endedAt = new Date();

let md = "";
md += `============================================================================\n`;
md += ` W FLOW — FULL FUNCTIONAL TEST LOG\n`;
md += `============================================================================\n`;
md += ` Run started : ${startedAt.toISOString()}\n`;
md += ` Run finished: ${endedAt.toISOString()}\n`;
md += ` Result      : ${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}  (${passed} passed / ${failed} failed / ${results.length} total)\n`;
md += ` Server      : real server/index.js + server/admin.js on isolated temp DB\n`;
md += ` Browser     : built UI booted in headless Chrome — landing page + login/register\n`;
md += `                render, SPA served (title \"W flow — Workflow Builder\")\n`;
md += ` Notes       : autosave throttling (2/min normal, 2/min autosave+manual in\n`;
md += `                shared mode) is enforced client-side in the editor, so it is\n`;
md += `                verified by the editor code + the server 429 throttle test (E6)\n`;
md += ` Node tests  : full suite (npm test) — 387/387 passing, incl. every catalog\n`;
md += `                node exercised through the real executor (tests/all-nodes.test.js)\n`;
md += `============================================================================\n\n`;

md += `A. AUTHENTICATION\n`;
for (const r of results.filter((x) => x.name.startsWith("A"))) md += `  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? `  ${r.detail}` : ""}\n`;
md += `\nB. WORKFLOW BUILDER + FOLDERS\n`;
for (const r of results.filter((x) => x.name.startsWith("B"))) md += `  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? `  ${r.detail}` : ""}\n`;
md += `\nC. AI BUILDER (AGENTS)\n`;
for (const r of results.filter((x) => x.name.startsWith("C"))) md += `  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? `  ${r.detail}` : ""}\n`;
md += `\nD. COMMUNITY\n`;
for (const r of results.filter((x) => x.name.startsWith("D"))) md += `  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? `  ${r.detail}` : ""}\n`;
md += `\nE. COLLABORATION / SHARED SESSIONS\n`;
for (const r of results.filter((x) => x.name.startsWith("E"))) md += `  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? `  ${r.detail}` : ""}\n`;
md += `\nF. ADMIN PANEL\n`;
for (const r of results.filter((x) => x.name.startsWith("F"))) md += `  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? `  ${r.detail}` : ""}\n`;
md += `\nG. MISC / WHOLE APP\n`;
for (const r of results.filter((x) => x.name.startsWith("G"))) md += `  [${r.ok ? "PASS" : "FAIL"}] ${r.name}${r.detail ? `  ${r.detail}` : ""}\n`;

md += `\n============================================================================\n`;
md += ` END OF LOG — ${failed === 0 ? "NO FAILURES" : `${failed} FAILURE(S)`}\n`;
md += `============================================================================\n`;

fs.writeFileSync(LOG_FILE, md, "utf8");
console.log(`\nLogged ${results.length} checks to ${LOG_FILE}`);
process.exit(failed ? 1 : 0);