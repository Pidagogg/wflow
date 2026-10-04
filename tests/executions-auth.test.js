// ============================================================================
// E2E coverage for the newer features: saved execution history, automated
// evaluation tests stored on the workflow, password reset + e-mail
// verification, and the admin "hide legal pages" switch.
//
// Spawns the real server against an isolated temp database and drives it over
// HTTP. No network access is needed (the reset/verify links are exposed in the
// API responses via BF_EXPOSE_RESET_LINK=1).
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-extras-"));
const dbPath = path.join(tempDir, "extras.db");
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

function setCookie(res) {
  const first = res.headers.getSetCookie?.()?.[0];
  if (first) cookie = first.split(";")[0];
}

async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  setCookie(res);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, data };
}

async function registerFresh(tag) {
  cookie = "";
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const res = await api("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: tag });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return email;
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
      BF_DB_PATH: dbPath,
      BF_DATA_DIR: dataDir,
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
      // return reset / verify links in the API so tests never need SMTP
      BF_EXPOSE_RESET_LINK: "1",
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

test("a run is listed as running while it executes and becomes the saved run", async () => {
  await registerFresh("live");
  const wf = await api("POST", "/api/workflows", {
    name: "Slow workflow",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "w", type: "wait", data: { label: "Pause", config: { duration: 2, unit: "seconds" } } },
    ],
    edges: [{ id: "e", source: "m", target: "w", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));
  const id = wf.data.id;

  // start the run without waiting for it
  const pending = api("POST", `/api/workflows/${id}/run`, {});

  let live = null;
  for (let i = 0; i < 40 && !live; i++) {
    const list = await api("GET", `/api/workflows/${id}/executions`);
    live = list.data.find((r) => r.running) || null;
    if (!live) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(live, "the run shows up while it is still executing");
  assert.equal(live.source, "editor");
  assert.equal(live.success, false);
  assert.equal(live.currentNode, "Pause");
  assert.equal(live.nodeCount, 2);
  assert.ok(live.nodesStarted >= 1);

  // the account-wide list has it too
  const all = await api("GET", "/api/executions");
  assert.ok(all.data.some((r) => r.id === live.id && r.running));

  // a running run has no log yet
  const early = await api("GET", `/api/workflows/${id}/executions/${live.id}`);
  assert.equal(early.status, 409);
  assert.equal(early.data.running, true);

  const run = await pending;
  assert.equal(run.status, 200, JSON.stringify(run.data));

  // same id, now saved and finished — listed once
  const after = await api("GET", `/api/workflows/${id}/executions`);
  assert.equal(after.data.length, 1);
  assert.equal(after.data[0].id, live.id);
  assert.equal(after.data[0].running, undefined);
  assert.equal(after.data[0].success, true);
  assert.equal((await api("GET", `/api/workflows/${id}/executions/${live.id}`)).status, 200);
});

test("a Run waiting for its webhook is listed, and the same row becomes the run", async () => {
  await registerFresh("waiting");
  const wf = await api("POST", "/api/workflows", {
    name: "Webhook workflow",
    nodes: [
      { id: "h", type: "webhook", data: { label: "Incoming order", config: { method: "POST" } } },
      { id: "s", type: "set", data: { label: "Set", config: { fields: [{ key: "ok", value: "yes" }] } } },
    ],
    edges: [{ id: "e", source: "h", target: "s", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));
  const id = wf.data.id;

  // nothing is listed before Run is pressed
  assert.deepEqual((await api("GET", `/api/workflows/${id}/executions`)).data, []);

  // Run arms the webhook — the run is waiting, not executing a node yet
  const run = await api("POST", `/api/workflows/${id}/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.waiting, true);
  const waitingId = run.data.waitingId;

  const listed = await api("GET", `/api/workflows/${id}/executions`);
  assert.equal(listed.data.length, 1);
  const row = listed.data[0];
  assert.equal(row.id, waitingId);
  assert.equal(row.waiting, true);
  assert.equal(row.running, true);
  assert.equal(row.source, "webhook");
  assert.equal(row.currentNode, "Incoming order");
  assert.equal(row.nodesStarted, 0);
  assert.ok((await api("GET", "/api/executions")).data.some((r) => r.id === waitingId && r.waiting));
  assert.equal((await api("GET", `/api/workflows/${id}/executions/${waitingId}`)).status, 409);

  // the webhook fires: the run takes over the waiting row's id
  const hook = await fetch(`${base}/webhook/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: 7 }),
  });
  assert.equal(hook.status, 200);
  const after = await api("GET", `/api/workflows/${id}/executions`);
  assert.equal(after.data.length, 1, "one row, not a waiting row plus a run");
  assert.equal(after.data[0].id, waitingId);
  assert.equal(after.data[0].waiting, undefined);
  assert.equal(after.data[0].success, true);

  // Cancel wait removes the row again
  const again = await api("POST", `/api/workflows/${id}/run`, {});
  assert.ok((await api("GET", `/api/workflows/${id}/executions`)).data.some((r) => r.waiting));
  await api("POST", `/api/workflows/${id}/run/cancel`, { waitingId: again.data.waitingId });
  assert.ok(!(await api("GET", `/api/workflows/${id}/executions`)).data.some((r) => r.waiting));
});

test("every run is saved and listed in the execution history", async () => {
  await registerFresh("hist");
  const wf = await api("POST", "/api/workflows", {
    name: "History workflow",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      { id: "s", type: "set", data: { label: "Set", config: { fields: [{ key: "hello", value: "Hi {{name}}" }] } } },
    ],
    edges: [{ id: "e", source: "m", target: "s", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));
  const id = wf.data.id;

  // no runs yet
  const empty = await api("GET", `/api/workflows/${id}/executions`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, []);

  // run it twice
  for (let i = 0; i < 2; i++) {
    const run = await api("POST", `/api/workflows/${id}/run`, { payload: { name: `Ada ${i}` } });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.equal(run.data.success, true);
  }

  const list = await api("GET", `/api/workflows/${id}/executions`);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 2, "both runs were persisted");
  assert.equal(list.data[0].success, true);
  assert.equal(list.data[0].source, "editor");
  assert.ok(list.data[0].durationMs >= 0);
  assert.ok(list.data[0].nodeCount >= 2);

  // the detail endpoint returns the full ExecResult (log)
  const detail = await api("GET", `/api/workflows/${id}/executions/${list.data[0].id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.ok(Array.isArray(detail.data.result.log) && detail.data.result.log.length >= 2);
  assert.equal(detail.data.workflowId, id);

  // another account cannot read this workflow's history
  await registerFresh("hist-other");
  const foreign = await api("GET", `/api/workflows/${id}/executions`);
  assert.equal(foreign.status, 404, "history is owner-scoped");
});

test("evaluation tests are stored on the workflow and come back on reload", async () => {
  await registerFresh("eval");
  const created = await api("POST", "/api/workflows", {
    name: "Evaluated",
    nodes: [{ id: "m", type: "manual", data: { label: "Start", config: {} } }],
    edges: [],
  });
  const id = created.data.id;
  const tests = [
    { id: "t1", name: "greets Ada", payload: { name: "Ada" }, expect: { success: true, contains: "Ada" } },
    { id: "t2", name: "must succeed", payload: {}, expect: { success: true } },
  ];
  const updated = await api("PUT", `/api/workflows/${id}`, { tests });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  const fetched = await api("GET", `/api/workflows/${id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.tests.length, 2);
  assert.equal(fetched.data.tests[0].name, "greets Ada");
  assert.deepEqual(fetched.data.tests[0].payload, { name: "Ada" });
});

test("password reset: request a link, set a new password, log in with it", async () => {
  const email = await registerFresh("reset");
  const forgot = await api("POST", "/api/auth/forgot", { email });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.data.resetLink, "the reset link is exposed for this test instance");
  const token = new URL(forgot.data.resetLink).searchParams.get("reset");
  assert.ok(token);

  // unknown address answers identically (no account probing) but has no link
  const unknown = await api("POST", "/api/auth/forgot", { email: `nobody-${Date.now()}@example.com` });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.resetLink, undefined);

  const tooShort = await api("POST", "/api/auth/reset", { token, password: "short" });
  assert.equal(tooShort.status, 400);

  const done = await api("POST", "/api/auth/reset", { token, password: "brand-new-password" });
  assert.equal(done.status, 200, JSON.stringify(done.data));

  // the token is single-use
  const reuse = await api("POST", "/api/auth/reset", { token, password: "another-password" });
  assert.equal(reuse.status, 400);

  // old password no longer works, the new one does
  cookie = "";
  const oldLogin = await api("POST", "/api/auth/login", { email, password: "correct-horse-battery" });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api("POST", "/api/auth/login", { email, password: "brand-new-password" });
  assert.equal(newLogin.status, 200, JSON.stringify(newLogin.data));
});

test("email verification: register is unverified, the link verifies the account", async () => {
  const email = await registerFresh("verify");
  const meBefore = await api("GET", "/api/auth/me");
  assert.equal(meBefore.data.emailVerified, false, "a fresh account starts unverified");

  const resent = await api("POST", "/api/auth/resend-verification");
  assert.equal(resent.status, 200);
  assert.ok(resent.data.verifyLink, "verify link exposed for this test instance");
  const token = new URL(resent.data.verifyLink).searchParams.get("verify");
  assert.ok(token);

  const verified = await api("POST", "/api/auth/verify-email", { token });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.emailVerified, true);
  assert.equal(verified.data.email, email);

  const meAfter = await api("GET", "/api/auth/me");
  assert.equal(meAfter.data.emailVerified, true);

  // bad token is rejected
  const bad = await api("POST", "/api/auth/verify-email", { token: "not-a-real-token" });
  assert.equal(bad.status, 400);
});

test("account export returns the account's data without credentials", async () => {
  await registerFresh("export");
  const wf = await api("POST", "/api/workflows", {
    name: "Exportable",
    nodes: [{ id: "m", type: "manual", data: { label: "Start", config: { apiKey: "super-secret" } } }],
    edges: [],
  });
  assert.equal(wf.status, 200);
  const res = await fetch(`${base}/api/auth/export`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment/);
  const data = await res.json();
  assert.ok(data.account && data.account.email);
  assert.ok(Array.isArray(data.workflows));
  // credentials are blanked in the export, exactly like an exported workflow
  assert.ok(!JSON.stringify(data.workflows).includes("super-secret"));
});

test("admin 'hide legal pages' switch removes the pages and their links", async () => {
  await registerFresh("legal");

  // Before the switch the legal document is served.
  const before = await fetch(`${base}/impressum`);
  assert.equal(before.status, 200);

  // Flip the admin setting directly in the shared database (the admin panel
  // writes the same key via its own process).
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO settings (key, value, encrypted) VALUES ('page.hideLegalAndPro', '1', 0) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
  db.close();

  const cfg = await api("GET", "/api/auth/config");
  assert.equal(cfg.data.hideLegalAndPro, true, "the UI is told to hide the links");

  const impressum = await fetch(`${base}/impressum`);
  assert.equal(impressum.status, 404, "the legal page now returns 404");
  const datenschutz = await fetch(`${base}/datenschutz`);
  assert.equal(datenschutz.status, 404);

  // Turn it back off and the page is served again.
  const db2 = new DatabaseSync(dbPath);
  db2.prepare("UPDATE settings SET value = '0' WHERE key = 'page.hideLegalAndPro'").run();
  db2.close();
  const after = await fetch(`${base}/impressum`);
  assert.equal(after.status, 200);
});

test("the AGB / Widerruf pages are gone; Impressum + Datenschutz remain", async () => {
  // Only two legal documents exist — terms and withdrawal return 404.
  for (const gone of ["/agb", "/terms", "/widerruf", "/withdrawal"]) {
    const res = await fetch(`${base}${gone}`);
    assert.equal(res.status, 404, `${gone} must not exist`);
  }
  const impressum = await fetch(`${base}/impressum`);
  assert.equal(impressum.status, 200);
  assert.match(await impressum.text(), /Impressum/);
  const ds = await fetch(`${base}/datenschutz`);
  assert.equal(ds.status, 200);
  const html = await ds.text();
  assert.match(html, /Datenschutzerklärung/);
  // the deployment-specific sections are always part of the policy
  assert.match(html, /Hosting \/ VPS/);
  assert.match(html, /Cloudflare/);
  // Supabase is not used on this deployment, so the policy does not name it
  assert.doesNotMatch(html, /Supabase/);
});
