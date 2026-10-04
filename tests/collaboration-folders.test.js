// ============================================================================
// Collaboration beyond a single workflow — driven over the real HTTP server
// (server/index.js) with an isolated database + data dir:
//
//   - sharing a FOLDER gives another account access to the workflows inside it
//   - an account may only have ONE shared folder at a time
//   - the “include subfolders” toggle decides whether subfolders are shared too
//   - the shared folder’s workflows keep working after the share ends
//   - shared-editing presence reports which node the other editor has open
//   - the contact form validates its input and reports the recipient
//
// Run: node --test tests/collaboration-folders.test.js
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-collab-folders-"));
const dbPath = path.join(tempDir, "collab.db");
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

// ----------------------------------------------------------------------------
// Folder sharing — one shared folder per account, with an optional subfolder
// switch.
// ----------------------------------------------------------------------------
test("sharing a folder shares its workflows, only one folder at a time, subfolders toggled", async () => {
  const ownerEmail = `fowner-${Date.now()}@example.com`;
  const collabEmail = `fcollab-${Date.now()}@example.com`;
  await register(ownerEmail, "Folder Owner");
  await register(collabEmail, "Folder Collab");

  await loginAs(ownerEmail);
  const folder = await api("POST", "/api/workflows/folders", { name: "Client work" });
  assert.equal(folder.status, 200, JSON.stringify(folder.data));
  const subfolder = await api("POST", "/api/workflows/folders", { name: "Archive", parentId: folder.data.id });
  assert.equal(subfolder.status, 200, JSON.stringify(subfolder.data));

  const top = await api("POST", "/api/workflows", { ...tinyWorkflow("Top workflow"), folderId: folder.data.id });
  assert.equal(top.status, 200, JSON.stringify(top.data));
  const nested = await api("POST", "/api/workflows", { ...tinyWorkflow("Nested workflow"), folderId: subfolder.data.id });
  assert.equal(nested.status, 200, JSON.stringify(nested.data));

  // No share yet: the collaborator sees nothing.
  await loginAs(collabEmail);
  const before = await api("GET", "/api/workflows");
  assert.ok(!before.data.some((w) => w.id === top.data.id), "an unshared folder stays private");

  // Share the folder WITHOUT subfolders.
  await loginAs(ownerEmail);
  const share = await api("POST", `/api/workflows/folders/${folder.data.id}/share`, { email: collabEmail, includeSubfolders: false });
  assert.equal(share.status, 200, JSON.stringify(share.data));
  assert.equal(share.data.share.email, collabEmail);
  assert.equal(share.data.share.includeSubfolders, false);

  await loginAs(collabEmail);
  const shared = await api("GET", "/api/workflows");
  const sharedTop = shared.data.find((w) => w.id === top.data.id);
  assert.ok(sharedTop, "the workflow in the shared folder appears for the collaborator");
  assert.equal(sharedTop.shared, true);
  assert.equal(sharedTop.sharedViaFolder, true, "the list says the access comes from a shared folder");
  assert.equal(sharedTop.sharedFolderId, folder.data.id, "the owner's folder id is reported for grouping");
  assert.ok(!shared.data.some((w) => w.id === nested.data.id), "subfolder workflows are NOT shared while the toggle is off");

  // The collaborator can open and edit it.
  const fetched = await api("GET", `/api/workflows/${top.data.id}`);
  assert.equal(fetched.status, 200, "the folder-shared workflow can be opened");
  assert.equal(fetched.data.sharedViaFolder, true);
  const edited = await api("PUT", `/api/workflows/${top.data.id}`, { ...fetched.data, name: "Top workflow v2" });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));

  // The incoming share is listed for the collaborator, the owned share for the owner.
  const incoming = await api("GET", "/api/workflows/folder-shares");
  assert.equal(incoming.data.incoming.length, 1);
  assert.equal(incoming.data.incoming[0].folderId, folder.data.id);
  assert.equal(incoming.data.incoming[0].ownerEmail, ownerEmail);
  assert.equal(incoming.data.incoming[0].ownerName, "Folder Owner");

  await loginAs(ownerEmail);
  const mine = await api("GET", "/api/workflows/folder-shares");
  assert.equal(mine.data.mine.length, 1, "one shared folder per account");
  assert.equal(mine.data.mine[0].folderName, "Client work");

  // The OWNER's own view of the workflow says it is shared through the folder,
  // so their editor enables the shared-editing features (save budget, presence).
  const ownerWorkflow = await api("GET", `/api/workflows/${top.data.id}`);
  assert.equal(ownerWorkflow.data.shared, false, "the owner does not become a viewer");
  assert.equal(ownerWorkflow.data.folderShared, true, "the owner sees that a folder share covers this workflow");
  assert.equal(ownerWorkflow.data.folderSharedWith, collabEmail);
  const ownerList = await api("GET", "/api/workflows");
  const ownerRow = ownerList.data.find((w) => w.id === top.data.id);
  assert.equal(ownerRow.folderShared, true, "the owner's list marks folder-shared workflows");

  // Only ONE folder may be shared at a time.
  const second = await api("POST", "/api/workflows/folders", { name: "Other project" });
  const blocked = await api("POST", `/api/workflows/folders/${second.data.id}/share`, { email: collabEmail });
  assert.equal(blocked.status, 409, "a second folder cannot be shared while one is shared");
  assert.ok(/one folder can be shared/i.test(blocked.data.error || ""), `clear error: ${blocked.data.error}`);
  assert.ok(/Client work/.test(blocked.data.error || ""), "the error names the folder to end first");

  // Turn subfolders on — the nested workflow becomes accessible too.
  const toggled = await api("PATCH", `/api/workflows/folders/${folder.data.id}/share`, { includeSubfolders: true });
  assert.equal(toggled.status, 200, JSON.stringify(toggled.data));
  assert.equal(toggled.data.share.includeSubfolders, true);

  await loginAs(collabEmail);
  const withSubs = await api("GET", "/api/workflows");
  assert.ok(withSubs.data.some((w) => w.id === nested.data.id), "subfolder workflows are shared once the toggle is on");
  const nestedOpen = await api("GET", `/api/workflows/${nested.data.id}`);
  assert.equal(nestedOpen.status, 200);

  // Ending the share takes the access away again — in one step for both.
  await loginAs(ownerEmail);
  const ended = await api("DELETE", `/api/workflows/folders/${folder.data.id}/share`);
  assert.equal(ended.status, 200, JSON.stringify(ended.data));
  const afterEnd = await api("GET", "/api/workflows/folder-shares");
  assert.equal(afterEnd.data.mine.length, 0, "no folder is shared any more");

  await loginAs(collabEmail);
  const lostTop = await api("GET", `/api/workflows/${top.data.id}`);
  assert.equal(lostTop.status, 404, "the collaborator loses access when the folder share ends");
  const lostNested = await api("GET", `/api/workflows/${nested.data.id}`);
  assert.equal(lostNested.status, 404);

  // The owner keeps everything, including the collaborator's edit.
  await loginAs(ownerEmail);
  const ownerView = await api("GET", `/api/workflows/${top.data.id}`);
  assert.equal(ownerView.data.name, "Top workflow v2", "edits made through the folder share stayed in the record");

  // Deleting a shared folder ends its share, so the one-folder slot is free
  // again instead of being blocked forever by a share pointing nowhere.
  const doomed = await api("POST", "/api/workflows/folders", { name: "Temp shared" });
  const doomedShare = await api("POST", `/api/workflows/folders/${doomed.data.id}/share`, { email: collabEmail });
  assert.equal(doomedShare.status, 200, JSON.stringify(doomedShare.data));
  const deleted = await api("DELETE", `/api/workflows/folders/${doomed.data.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  const sharesAfterDelete = await api("GET", "/api/workflows/folder-shares");
  assert.equal(sharesAfterDelete.data.mine.length, 0, "deleting a shared folder removes its share");
  const shareAnother = await api("POST", `/api/workflows/folders/${second.data.id}/share`, { email: collabEmail });
  assert.equal(shareAnother.status, 200, "another folder can be shared after the delete");
});

// ----------------------------------------------------------------------------
// Shared-editing presence — who is on which node right now.
// ----------------------------------------------------------------------------
test("presence reports which node the other editor is working on", async () => {
  const ownerEmail = `powner-${Date.now()}@example.com`;
  const collabEmail = `pcollab-${Date.now()}@example.com`;
  const strangerEmail = `pstranger-${Date.now()}@example.com`;
  await register(ownerEmail, "Presence Owner");
  await register(collabEmail, "Presence Collab");
  await register(strangerEmail, "Stranger");

  await loginAs(ownerEmail);
  const wf = await api("POST", "/api/workflows", tinyWorkflow("Presence workflow"));
  const share = await api("POST", `/api/workflows/${wf.data.id}/share`, { email: collabEmail });
  assert.equal(share.status, 200, JSON.stringify(share.data));

  // The owner opens the “Log” node — the collaborator sees the marker.
  const reported = await api("POST", `/api/workflows/${wf.data.id}/presence`, { nodeId: "l", nodeLabel: "Log" });
  assert.equal(reported.status, 200, JSON.stringify(reported.data));
  assert.equal(reported.data.editing.length, 0, "you never see yourself");

  await loginAs(collabEmail);
  const seen = await api("POST", `/api/workflows/${wf.data.id}/presence`, { nodeId: "m", nodeLabel: "Start" });
  assert.equal(seen.status, 200);
  const other = seen.data.editing.find((e) => e.email === ownerEmail);
  assert.ok(other, "the collaborator sees the owner");
  assert.equal(other.nodeId, "l", "the owner's open node is reported");
  assert.equal(other.nodeLabel, "Log");
  assert.equal(other.name, "Presence Owner");

  // The owner's access poll carries the same list (the editor uses one poll).
  await loginAs(ownerEmail);
  const access = await api("GET", `/api/workflows/${wf.data.id}/access`);
  assert.equal(access.data.accessible, true);
  assert.ok(access.data.editing.some((e) => e.email === collabEmail && e.nodeId === "m"), "access check includes presence");

  // An account without access can neither read nor report presence.
  await loginAs(strangerEmail);
  const denied = await api("POST", `/api/workflows/${wf.data.id}/presence`, { nodeId: "l" });
  assert.equal(denied.status, 404, "presence requires access to the workflow");

  // Looking at the canvas (no node) keeps the user present without a marker.
  await loginAs(collabEmail);
  await api("POST", `/api/workflows/${wf.data.id}/presence`, {});
  await loginAs(ownerEmail);
  const viewOnly = await api("GET", `/api/workflows/${wf.data.id}/access`);
  assert.ok(viewOnly.data.editing.some((e) => e.email === collabEmail && e.nodeId === null), "no node open → present but unmarked");
});

// ----------------------------------------------------------------------------
// Contact form — authenticated, validated, addressed to the configured inbox.
// ----------------------------------------------------------------------------
test("contact form requires a signed-in user and reports the configured address", async () => {
  const email = `contact-${Date.now()}@example.com`;

  cookie = "";
  const anon = await api("GET", "/api/contact");
  assert.notEqual(anon.status, 200, "the contact endpoint is not public");

  await register(email, "Contact User");
  const info = await api("GET", "/api/contact");
  assert.equal(info.status, 200, JSON.stringify(info.data));
  assert.equal(info.data.to, CONTACT_EMAIL, "the admin's contact address is reported");

  const noMessage = await api("POST", "/api/contact", { email, message: "   " });
  assert.equal(noMessage.status, 400);
  const badEmail = await api("POST", "/api/contact", { email: "not-an-email", message: "help" });
  assert.equal(badEmail.status, 400);

  // Without SMTP the message is recorded (and logged) instead of being sent —
  // the request still succeeds so the user is told what happened.
  const sent = await api("POST", "/api/contact", { email, message: "The Set node loses my header." });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.ok, true);
  assert.ok(/recorded|sent/i.test(sent.data.message || ""), sent.data.message);

  const tooLong = await api("POST", "/api/contact", { email, message: "x".repeat(4001) });
  assert.equal(tooLong.status, 400, "the message length is capped");

  // Three accepted messages per hour — the rejected attempts above did not
  // count, so two more go through and the fourth is refused with a wait time.
  for (const n of [2, 3]) {
    const ok = await api("POST", "/api/contact", { email, message: `Follow-up ${n}` });
    assert.equal(ok.status, 200, `message ${n} of 3: ${JSON.stringify(ok.data)}`);
  }
  const fourth = await api("POST", "/api/contact", { email, message: "One more" });
  assert.equal(fourth.status, 429);
  assert.match(fourth.data.error, /up to 3 messages per hour/);
  assert.ok(fourth.data.retryAfter > 3500 && fourth.data.retryAfter <= 3600, String(fourth.data.retryAfter));
});
