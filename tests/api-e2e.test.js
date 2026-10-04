// ============================================================================
// End-to-end API test — the whole app through the real HTTP server, exactly
// like a user in a browser: register an account, save a workflow, run it,
// inspect results, share it with the community, and clean up.
//
// Spawns the real server (server/index.js) as a child process with an isolated
// temp database + data dir and a random port, then drives it over HTTP. No
// network is needed: the workflow under test is fully offline (manual trigger
// + a Set node that transforms the submitted payload).
//
// Run: node --test tests/api-e2e.test.js
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-e2e-"));
const dbPath = path.join(tempDir, "e2e.db");
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
let csrf = ""; // the main site does not use CSRF headers — kept for clarity

function setCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  const first = raw[0];
  if (!first) return;
  cookie = first.split(";")[0];
}

// Log in as a specific registered user (tests share one cookie variable, so
// switching identities requires an explicit login call).
async function loginAs(email) {
  const res = await api("POST", "/api/auth/login", { email, password: "correct-horse-battery" });
  assert.equal(res.status, 200, `login as ${email}: ${JSON.stringify(res.data)}`);
  return res;
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

// A tiny offline workflow a real user would build: Manual trigger → Set that
// turns {{name}} into a greeting field → log sink.
function greetingWorkflow(name = "Untitled workflow") {
  return {
    name,
    description: "E2E greeting workflow",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      {
        id: "s",
        type: "set",
        data: { label: "Make greeting", config: { fields: [{ key: "greeting", value: "Hello {{name}}!" }] } },
      },
      { id: "l", type: "log", data: { label: "Log", config: {} } },
    ],
    edges: [
      { id: "e1", source: "m", target: "s", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "s", target: "l", sourceHandle: "out", targetHandle: "in" },
    ],
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
      BF_DB_PATH: dbPath,
      BF_DATA_DIR: dataDir,
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

test("register → me → create → run → list → update → share → delete (real server)", async () => {
  // 1. Instance config — registration is open by default
  const cfg = await api("GET", "/api/auth/config");
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.allowRegister, true, "a fresh install lets visitors register");

  // 2. Register a brand-new account (auto-login sets the session cookie)
  const email = `ada-${Date.now()}@example.com`;
  const reg = await api("POST", "/api/auth/register", {
    email,
    password: "correct-horse-battery",
    name: "Ada E2E",
  });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.equal(reg.data.authed, true);
  assert.ok(cookie.includes("bf_user="), "register issues the session cookie");

  // 3. /api/auth/me recognises the session
  const me = await api("GET", "/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.email, email);

  // 4. Create a workflow folder and verify it is account-scoped metadata
  const folder = await api("POST", "/api/workflows/folders", { name: "Reports" });
  assert.equal(folder.status, 200, JSON.stringify(folder.data));
  assert.ok(folder.data.id, "the server assigns a folder id");
  const folders = await api("GET", "/api/workflows/folders");
  assert.equal(folders.status, 200);
  assert.ok(folders.data.some((f) => f.id === folder.data.id && f.name === "Reports"));
  const renamedFolder = await api("PUT", `/api/workflows/folders/${folder.data.id}`, { name: "Reports and exports" });
  assert.equal(renamedFolder.status, 200);
  assert.equal(renamedFolder.data.name, "Reports and exports");

  // Nested folders behave like a real directory and are scoped to their parent.
  const childFolder = await api("POST", "/api/workflows/folders", { name: "Daily", parentId: folder.data.id });
  assert.equal(childFolder.status, 200, JSON.stringify(childFolder.data));
  assert.equal(childFolder.data.parentId, folder.data.id);
  const listedNestedFolders = await api("GET", "/api/workflows/folders");
  assert.ok(listedNestedFolders.data.some((f) => f.id === childFolder.data.id && f.parentId === folder.data.id));

  // 5. Create a workflow the way the editor does, inside the nested folder
  const created = await api("POST", "/api/workflows", { ...greetingWorkflow("Greeter"), folderId: childFolder.data.id });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const wfId = created.data.id;
  assert.ok(wfId, "the server assigns the workflow an id");
  assert.equal(created.data.name, "Greeter");
  assert.equal(created.data.folderId, childFolder.data.id, "the workflow keeps its nested folder assignment");

  // 6. Run it with a payload (the toolbar Run button)
  const run = await api("POST", `/api/workflows/${wfId}/run`, { payload: { name: "Ada" }, maxItemsPerNode: 5 });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.success, true, "the run finished successfully");
  assert.ok(Array.isArray(run.data.log) && run.data.log.length >= 2, "every node produced a log entry");
  const setEntry = run.data.log.find((l) => l.nodeType === "set");
  assert.ok(setEntry, "the Set node ran");
  assert.equal(setEntry.status, "success");
  assert.equal(setEntry.outputItems[0].greeting, "Hello Ada!", "the {{name}} placeholder was resolved from the payload");

  // 6. The workflow is listed under the account and readable back
  const list = await api("GET", "/api/workflows");
  assert.equal(list.status, 200);
  assert.ok(list.data.some((w) => w.id === wfId), "the workflow appears in the owner's list");
  const fetched = await api("GET", `/api/workflows/${wfId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.id, wfId);

  // 7. Update (rename) and read back
  const renamed = await api("PUT", `/api/workflows/${wfId}`, { name: "Greeter v2" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.name, "Greeter v2");
  assert.equal(renamed.data.folderId, childFolder.data.id, "renaming preserves the nested folder assignment");

  // 8. Deleting a parent promotes its children instead of destroying the tree.
  const delFolder = await api("DELETE", `/api/workflows/folders/${folder.data.id}`);
  assert.equal(delFolder.status, 200);
  const afterParentDelete = await api("GET", "/api/workflows/folders");
  const promotedChild = afterParentDelete.data.find((f) => f.id === childFolder.data.id);
  assert.ok(promotedChild, "the child folder remains after its parent is deleted");
  assert.equal(promotedChild.parentId, undefined, "the child folder is promoted to the workspace root");
  const afterParentDeleteWorkflow = await api("GET", `/api/workflows/${wfId}`);
  assert.equal(afterParentDeleteWorkflow.status, 200);
  assert.equal(afterParentDeleteWorkflow.data.folderId, childFolder.data.id, "the workflow remains in its child folder");

  // Deleting the remaining folder keeps the workflow safe and returns it to
  // the account's MAIN folder (workflows can never be unfiled / outside the
  // folder tree).
  const delChildFolder = await api("DELETE", `/api/workflows/folders/${childFolder.data.id}`);
  assert.equal(delChildFolder.status, 200);
  const afterFolderDelete = await api("GET", `/api/workflows/${wfId}`);
  assert.equal(afterFolderDelete.status, 200);
  const foldersAfter = await api("GET", "/api/workflows/folders");
  const homeFolder = foldersAfter.data.find((f) => f.home === true);
  assert.ok(homeFolder, "the account's main folder exists");
  assert.equal(afterFolderDelete.data.folderId, homeFolder.id, "the workflow moves back into the main folder");

  // 9. Share it with the community, find it in search, remove it
  const post = await api("POST", "/api/community", {
    workflowId: wfId,
    title: "E2E Greeter",
    description: "Says hello from an end-to-end test",
    visibility: "public",
  });
  assert.equal(post.status, 200, JSON.stringify(post.data));
  const search = await api("GET", "/api/community?q=e2e+greeter");
  assert.equal(search.status, 200);
  assert.ok(search.data.some((p) => p.id === post.data.id), "the post is searchable");
  const delPost = await api("DELETE", `/api/community/${post.data.id}`);
  assert.equal(delPost.status, 200);

  // 10. Delete the workflow; it must be gone afterwards
  const del = await api("DELETE", `/api/workflows/${wfId}`);
  assert.equal(del.status, 200);
  const gone = await api("GET", `/api/workflows/${wfId}`);
  assert.equal(gone.status, 404, "deleting removes the workflow");

  // 11. Logout ends the session
  const out = await api("POST", "/api/auth/logout");
  assert.equal(out.status, 200);
  cookie = "";
  const after = await api("GET", "/api/auth/me");
  assert.equal(after.data.authed, false, "after logout the session is gone");
});

test("logged-out visitors can read the public catalog but not private tools", async () => {
  cookie = "";
  const catalog = await api("GET", "/api/nodes");
  assert.equal(catalog.status, 200);
  assert.ok(Object.keys(catalog.data.nodes || {}).length >= 140);

  for (const path of ["/api/workflows", "/api/agents", "/api/community", "/api/ai/models"]) {
    const res = await api("GET", path);
    assert.equal(res.status, 401, `${path} must require authentication`);
  }

  const config = await api("GET", "/api/auth/config");
  assert.equal(config.status, 200);
  assert.equal(typeof config.data.allowRegister, "boolean");
});

test("the node catalog the UI renders is served intact", async () => {
  const res = await api("GET", "/api/nodes");
  assert.equal(res.status, 200);
  const types = Object.keys(res.data.nodes || {});
  assert.ok(types.length >= 140, `the editor expects the full catalog (got ${types.length})`);
  // Every trigger entry the palette needs must be present (spot check the
  // ones touched by the audit).
  for (const t of ["manual", "webhook", "schedule", "rssTrigger", "gmail", "slackTrigger"]) {
    assert.ok(res.data.nodes[t], `catalog serves "${t}"`);
  }
  assert.ok(res.data.groups?.length >= 5, "the picker has all five category groups");
});

// ----------------------------------------------------------------------------
// Community visibility — private posts are invisible to everyone but the author,
// restricted posts are only visible to the author + explicitly allowed users.
// ----------------------------------------------------------------------------
test("community visibility: private + restricted posts are gated per user", async () => {
  // register two accounts
  const emailA = `vis-a-${Date.now()}@example.com`;
  const regA = await api("POST", "/api/auth/register", { email: emailA, password: "correct-horse-battery", name: "Vis A" });
  assert.equal(regA.status, 200, JSON.stringify(regA.data));

  const emailB = `vis-b-${Date.now()}@example.com`;
  const regB = await api("POST", "/api/auth/register", { email: emailB, password: "correct-horse-battery", name: "Vis B" });
  assert.equal(regB.status, 200, JSON.stringify(regB.data));

  // switch to user A — user A creates a workflow and publishes a PRIVATE post
  await loginAs(emailA);
  const wfA = await api("POST", "/api/workflows", { ...greetingWorkflow("Private Greeter") });
  assert.equal(wfA.status, 200);
  const privPost = await api("POST", "/api/community", {
    workflowId: wfA.data.id,
    title: "A's private post",
    description: "nobody should see this",
    visibility: "private",
  });
  assert.equal(privPost.status, 200, JSON.stringify(privPost.data));
  assert.equal(privPost.data.visibility, "private");

  // user A publishes a RESTRICTED post allowed only to user B
  const restPost = await api("POST", "/api/community", {
    workflowId: wfA.data.id,
    title: "A's restricted post",
    description: "only B",
    visibility: "restricted",
    allowedUsers: [emailB],
  });
  assert.equal(restPost.status, 200, JSON.stringify(restPost.data));

  // user A sees both posts (author always sees their own)
  await loginAs(emailA);
  const mine = await api("GET", "/api/community?mine=1");
  assert.ok(mine.data.some((p) => p.id === privPost.data.id), "author sees their private post");
  assert.ok(mine.data.some((p) => p.id === restPost.data.id), "author sees their restricted post");

  // user B sees only the restricted post — never the private one
  await loginAs(emailB);
  const asB = await api("GET", "/api/community");
  assert.ok(asB.data.some((p) => p.id === restPost.data.id), "allowed user sees the restricted post");
  assert.ok(!asB.data.some((p) => p.id === privPost.data.id), "private post is invisible to others");

  // user B can import the restricted post, but NOT the private post
  const importRestricted = await api("POST", `/api/community/${restPost.data.id}/import`);
  assert.equal(importRestricted.status, 200, JSON.stringify(importRestricted.data));
  const importPrivate = await api("POST", `/api/community/${privPost.data.id}/import`);
  assert.equal(importPrivate.status, 404, "private post cannot be imported by others");

});

// ----------------------------------------------------------------------------
// Collaboration — share a workflow with another user: they can open/edit it,
// every save updates the single shared record, auto-saves are throttled to
// 1/min, and each user additionally gets ONE manual save per minute.
// ----------------------------------------------------------------------------
test("collaboration: share a workflow, collaborator edits it, Save budget kicks in", async () => {
  const ownerEmail = `own-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email: ownerEmail, password: "correct-horse-battery", name: "Owner" });
  const collabEmail = `col-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email: collabEmail, password: "correct-horse-battery", name: "Collab" });

  // switch to the owner — the owner creates a workflow
  await loginAs(ownerEmail);
  const wf = await api("POST", "/api/workflows", { ...greetingWorkflow("Team Workflow") });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));

  // share with the collaborator by email
  const share = await api("POST", `/api/workflows/${wf.data.id}/share`, { email: collabEmail });
  assert.equal(share.status, 200, JSON.stringify(share.data));
  assert.equal(share.data.collaborators.length, 1);
  assert.equal(share.data.collaborators[0].email, collabEmail);

  // switch to the collaborator — they can now open and edit the workflow
  await loginAs(collabEmail);
  const fetchedByCollab = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(fetchedByCollab.status, 200, "collaborator can open the workflow");
  assert.equal(fetchedByCollab.data.name, "Team Workflow");
  const collabList = await api("GET", "/api/workflows");
  assert.ok(collabList.data.some((w) => w.id === wf.data.id && w.shared === true), "shared workflow appears in the collaborator's list");

  // collaborator renames it — the single shared record changes
  const renamedByCollab = await api("PUT", `/api/workflows/${wf.data.id}`, {
    ...fetchedByCollab.data,
    name: "Team Workflow v2 by Collab",
    nodes: fetchedByCollab.data.nodes,
    edges: fetchedByCollab.data.edges,
  });
  assert.equal(renamedByCollab.status, 200, JSON.stringify(renamedByCollab.data));

  // back to the owner — they see the collaborator's rename (same record)
  await loginAs(ownerEmail);
  const ownerSees = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(ownerSees.data.name, "Team Workflow v2 by Collab");

  // Auto-saves on a shared workflow are throttled to 1 per minute, and the
  // collaborator's rename above already used that slot — so neither of these
  // rapid saves lands, and the server says when the next one is possible.
  const rapid1 = await api("PUT", `/api/workflows/${wf.data.id}`, { ...ownerSees.data, name: "r1" });
  const rapid2 = await api("PUT", `/api/workflows/${wf.data.id}`, { ...ownerSees.data, name: "r2" });
  assert.equal(rapid1.status, 429, "the second auto-save in the window is throttled");
  assert.equal(rapid2.status, 429, "the third auto-save in the window is throttled");
  assert.ok(/1 auto-save per minute/.test(rapid1.data.error || rapid2.data.error || ""));
  assert.ok(Number(rapid1.data.retryAfterMs) > 0, "the throttle reports when the next save is possible");

  // A MANUAL save has its own budget of one per minute and per user, so it is
  // accepted even though the auto-save slot is used up. The owner uses theirs
  // first, then the collaborator still has their own. A second manual save by
  // the same user within the minute is refused with manualSavesLeft: 0.
  const manualOwner = await api("PUT", `/api/workflows/${wf.data.id}`, { ...ownerSees.data, name: "r4-manual", manual: true });
  assert.equal(manualOwner.status, 200, JSON.stringify(manualOwner.data));
  const manualOwnerAgain = await api("PUT", `/api/workflows/${wf.data.id}`, { ...ownerSees.data, name: "r5-manual", manual: true });
  assert.equal(manualOwnerAgain.status, 429, "the owner's manual save budget is spent");
  assert.equal(manualOwnerAgain.data.manualSavesLeft, 0);
  assert.ok(/manual save/.test(manualOwnerAgain.data.error || ""));

  await loginAs(collabEmail);
  const collabView = await api("GET", `/api/workflows/${wf.data.id}`);
  const manualCollab = await api("PUT", `/api/workflows/${wf.data.id}`, { ...collabView.data, name: "collab-manual", manual: true });
  assert.equal(manualCollab.status, 200, "every user has their own manual save budget");

  // owner removes the collaborator; access is gone
  await loginAs(ownerEmail);
  const unshare = await api("DELETE", `/api/workflows/${wf.data.id}/share/${share.data.collaborators[0].userId}`);
  assert.equal(unshare.status, 200, JSON.stringify(unshare.data));
  await loginAs(collabEmail);
  const afterUnshare = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(afterUnshare.status, 404, "removed collaborator loses access");
});

// ----------------------------------------------------------------------------
// Shared sessions — the workflow stays visible in the viewer's own home
// folder (never written back into the owner's record), only the owner can move
// it between folders, and ending the session throws collaborators out.
// ----------------------------------------------------------------------------
test("shared session: viewer folder mapping, move protection, stop-sharing kicks collaborators", async () => {
  const ownerEmail = `so-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email: ownerEmail, password: "correct-horse-battery", name: "SOwner" });
  const collabEmail = `sc-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email: collabEmail, password: "correct-horse-battery", name: "SCollab" });

  // Owner creates a folder + workflow inside it, then shares with the collaborator.
  await loginAs(ownerEmail);
  const ownerFolder = await api("POST", "/api/workflows/folders", { name: "Owner Secrets" });
  assert.equal(ownerFolder.status, 200);
  const wf = await api("POST", "/api/workflows", { ...greetingWorkflow("Session Workflow"), folderId: ownerFolder.data.id });
  assert.equal(wf.status, 200);
  const share = await api("POST", `/api/workflows/${wf.data.id}/share`, { email: collabEmail });
  assert.equal(share.status, 200);
  const collabUserId = share.data.collaborators[0].userId;

  // The collaborator's list maps the shared workflow into THEIR home folder
  // (display only) so it is visible in their explorer — never the owner's id.
  await loginAs(collabEmail);
  const collabList = await api("GET", "/api/workflows");
  const collabFolders = await api("GET", "/api/workflows/folders");
  const collabHome = collabFolders.data.find((f) => f.home === true);
  assert.ok(collabHome, "collaborator has a home folder");
  const sharedInList = collabList.data.find((w) => w.id === wf.data.id);
  assert.ok(sharedInList, "the shared workflow appears in the collaborator's list");
  assert.equal(sharedInList.folderId, collabHome.id, "the viewer sees it inside their own home folder");
  assert.equal(sharedInList.shared, true);

  // The collaborator learns WHO shared it with them (owner info in the response).
  const fetched = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(fetched.data.shared, true);
  assert.equal(fetched.data.sharedBy?.email, ownerEmail, "collaborator sees the owner's identity");

  // The collaborator can edit it, but the owner's folder assignment survives
  // the save (the collaborator's own folder ids must never leak into the record).
  const savedByCollab = await api("PUT", `/api/workflows/${wf.data.id}`, { ...fetched.data, name: "Session v2", folderId: collabHome.id });
  assert.equal(savedByCollab.status, 200, JSON.stringify(savedByCollab.data));
  await loginAs(ownerEmail);
  const ownerStillSees = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(ownerStillSees.status, 200);
  assert.equal(ownerStillSees.data.folderId, ownerFolder.data.id, "collaborator save keeps the owner's folder assignment");
  assert.equal(ownerStillSees.data.name, "Session v2", "the shared edit landed in the same record");

  // Moving the shared workflow is owner-only — the collaborator gets a 403.
  await loginAs(collabEmail);
  const moveAsCollab = await api("PATCH", `/api/workflows/${wf.data.id}/folder`, { folderId: collabHome.id });
  assert.equal(moveAsCollab.status, 403, "only the owner can move a shared workflow between folders");

  // The owner's access view lists who the workflow is shared with; the
  // collaborator's access view shows who shared it.
  await loginAs(ownerEmail);
  const ownerAccess = await api("GET", `/api/workflows/${wf.data.id}/access`);
  assert.equal(ownerAccess.data.accessible, true);
  assert.equal(ownerAccess.data.shared, true);
  assert.ok(ownerAccess.data.sharedWith?.some((c) => c.email === collabEmail), "owner sees the collaborator");
  await loginAs(collabEmail);
  const collabAccess = await api("GET", `/api/workflows/${wf.data.id}/access`);
  assert.equal(collabAccess.data.accessible, true);
  assert.equal(collabAccess.data.shared, true);
  assert.equal(collabAccess.data.sharedBy?.email, ownerEmail, "collaborator access check names the owner");

  // End the session: the owner sends their latest editor state in the same
  // request, so pending changes are saved while every collaborator is removed.
  await loginAs(ownerEmail);
  const current = await api("GET", `/api/workflows/${wf.data.id}`);
  const stop = await api("POST", `/api/workflows/${wf.data.id}/stop-sharing`, {
    ...current.data,
    name: "Session Final",
    nodes: current.data.nodes,
    edges: current.data.edges,
  });
  assert.equal(stop.status, 200, JSON.stringify(stop.data));
  assert.equal(stop.data.collaborators.length, 0, "every collaborator is removed");

  // The collaborator is thrown out: access check flips to false, open and edit
  // both 404, and the workflow is gone from their list.
  await loginAs(collabEmail);
  const accessAfter = await api("GET", `/api/workflows/${wf.data.id}/access`);
  assert.equal(accessAfter.data.accessible, false, "access check flips to false after the session ends");
  const openAfter = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(openAfter.status, 404, "collaborator can no longer open the workflow");
  const listAfter = await api("GET", "/api/workflows");
  assert.ok(!listAfter.data.some((w) => w.id === wf.data.id), "the workflow disappears from the collaborator's list");

  // The owner keeps it — with the editor's final state persisted.
  await loginAs(ownerEmail);
  const ownerFinal = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(ownerFinal.status, 200);
  assert.equal(ownerFinal.data.name, "Session Final", "the session-end save carried the editor's pending changes");
  assert.equal(ownerFinal.data.folderId, ownerFolder.data.id, "owner's folder assignment is intact");
  assert.equal(ownerFinal.data.collaborators?.length || 0, 0, "workflow is no longer shared");
});

// ----------------------------------------------------------------------------
// Non-manual triggers wait for input — pressing Run never invents test data.
// ----------------------------------------------------------------------------
test("non-manual triggers wait for input; a submitted payload runs the workflow", async () => {
  const email = `wait-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: "Waiter" });

  // A service trigger (Slack) usually only receives external events, so Run
  // must wait instead of firing a fabricated sample payload.
  const wf = await api("POST", "/api/workflows", {
    name: "Slack Wait",
    nodes: [
      { id: "t", type: "slackTrigger", data: { label: "Slack In", config: {} } },
      { id: "s", type: "set", data: { label: "Set", config: { fields: [{ key: "echo", value: "{{text}}" }] } } },
    ],
    edges: [{ id: "e", source: "t", target: "s", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));

  const run = await api("POST", `/api/workflows/${wf.data.id}/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.waiting, true, "a non-manual trigger waits instead of executing");
  assert.equal(run.data.awaiting, "input");
  assert.ok(run.data.waitingId, "the wait has an id");
  assert.equal(run.data.triggerType, "slackTrigger");
  assert.equal(run.data.log.length, 0, "nothing ran yet");

  // while waiting, a poll still reports waiting (with the trigger metadata)
  const poll = await api("POST", `/api/workflows/${wf.data.id}/run/poll`, { waitingId: run.data.waitingId });
  assert.equal(poll.data.waiting, true);
  assert.equal(poll.data.awaiting, "input");

  // submitting the event payload executes the workflow with it
  const submit = await api("POST", `/api/workflows/${wf.data.id}/run/input`, {
    waitingId: run.data.waitingId,
    payload: { text: "from the wait" },
  });
  assert.equal(submit.status, 200, JSON.stringify(submit.data));
  assert.equal(submit.data.success, true);
  const setEntry = submit.data.log.find((l) => l.nodeType === "set");
  assert.equal(setEntry.outputItems[0].echo, "from the wait", "the submitted payload fed the trigger");

  // the wait is consumed — a second submission is rejected, never a double run
  const again = await api("POST", `/api/workflows/${wf.data.id}/run/input`, {
    waitingId: run.data.waitingId,
    payload: { text: "again" },
  });
  assert.equal(again.status, 409);
});

test("a workflow with a Manual trigger still executes immediately", async () => {
  const email = `manual-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: "Manual" });
  const wf = await api("POST", "/api/workflows", { ...greetingWorkflow("Manual Immediate") });
  const run = await api("POST", `/api/workflows/${wf.data.id}/run`, { payload: { name: "Ada" } });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.waiting, undefined, "a manual trigger does not wait");
  assert.equal(run.data.success, true);
});

// ----------------------------------------------------------------------------
// Chat Trigger + Chat Output — Run opens a chat; each message runs the workflow
// and a Chat Output node answers in the panel.
// ----------------------------------------------------------------------------
test("chat trigger opens a chat and a chat output answers each message", async () => {
  const email = `chat-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: "Chatter" });
  const wf = await api("POST", "/api/workflows", {
    name: "Echo Chat",
    nodes: [
      { id: "c", type: "chatTrigger", data: { label: "Chat", config: {} } },
      { id: "o", type: "chatOutput", data: { label: "Reply", config: { text: "Echo: {{message}}" } } },
    ],
    edges: [{ id: "e", source: "c", target: "o", sourceHandle: "out", targetHandle: "in" }],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));

  // Pressing Run opens the chat instead of executing with invented input.
  const run = await api("POST", `/api/workflows/${wf.data.id}/run`, {});
  assert.equal(run.data.waiting, true);
  assert.equal(run.data.awaiting, "chat");
  assert.equal(run.data.waitingId, null, "chat runs are driven by the panel, nothing to poll");

  // Each message is one run; the reply comes from the Chat Output node.
  const chat = await api("POST", `/api/workflows/${wf.data.id}/chat`, { message: "hello" });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  assert.equal(chat.data.success, true);
  const out = chat.data.log.find((l) => l.nodeType === "chatOutput");
  assert.ok(out, "the Chat Output node ran");
  assert.equal(out.outputItems[0].text, "Echo: hello");
  assert.equal(out.outputItems[0].role, "assistant");

  // A workflow without a Chat Trigger refuses chat runs.
  const plain = await api("POST", "/api/workflows", { ...greetingWorkflow("No Chat") });
  const refused = await api("POST", `/api/workflows/${plain.data.id}/chat`, { message: "hi" });
  assert.equal(refused.status, 400);
});

// ----------------------------------------------------------------------------
// Custom webhook URL part (slug) — /webhook/<slug> resolves to the workflow.
// ----------------------------------------------------------------------------
test("custom webhook slug: changing the URL part still fires the workflow", async () => {
  const email = `slug-${Date.now()}@example.com`;
  await api("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: "Slugger" });

  // a webhook-triggered workflow with a custom slug and Always-listen on
  const wf = await api("POST", "/api/workflows", {
    name: "Webhook Slug Test",
    webhookSlug: "my-awesome-hook",
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
  assert.equal(wf.status, 200, JSON.stringify(wf.data));
  assert.equal(wf.data.webhookSlug, "my-awesome-hook");


  // another workflow cannot take the same slug
  const dup = await api("POST", "/api/workflows", { name: "Dup", webhookSlug: "my-awesome-hook", nodes: [], edges: [] });
  assert.equal(dup.status, 409, "slugs are unique");

  // firing /webhook/<slug> works (no login needed — public endpoint)
  const fired = await api("POST", "/webhook/my-awesome-hook", { message: "hello via slug" });
  assert.ok([200, 202].includes(fired.status), `webhook by slug fired (${fired.status}) ${JSON.stringify(fired.data)}`);
  // the raw workflow id also still works
  const firedById = await api("POST", `/webhook/${wf.data.id}`, { message: "hello via id" });
  assert.ok([200, 202].includes(firedById.status), `webhook by id fired (${firedById.status}) ${JSON.stringify(firedById.data)}`);
});
