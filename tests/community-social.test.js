// ============================================================================
// Community social layer + profiles — end-to-end against the real server.
//
// Covers the feed (50-per-page paging, ranking, filters), likes, bookmarks,
// comments, anonymous publishing and the user profile endpoints.
//
// Run: node --test tests/community-social.test.js
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-community-"));
const dbPath = path.join(tempDir, "community.db");
const dataDir = path.join(tempDir, "data");
const PASSWORD = "correct-horse-battery";

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
  const raw = res.headers.getSetCookie?.() ?? [];
  const first = raw[0];
  if (!first) return;
  cookie = first.split(";")[0];
}

async function raw(method, url, body) {
  const headers = {};
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
  return { res, status: res.status, data };
}

const api = (method, url, body) => raw(method, url, body);

async function loginAs(email) {
  const res = await api("POST", "/api/auth/login", { email, password: PASSWORD });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.data)}`);
}

async function register(email, name) {
  const res = await api("POST", "/api/auth/register", { email, password: PASSWORD, name });
  assert.equal(res.status, 200, `register ${email}: ${JSON.stringify(res.data)}`);
}

function pingWorkflow(name) {
  return {
    name,
    description: "community test workflow",
    nodes: [{ id: "m", type: "manual", data: { label: "Start", config: {} } }],
    edges: [],
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

test("community feed: paging, ranking, likes, bookmarks, comments, anonymity", async () => {
  const stamp = Date.now();
  const emailA = `social-a-${stamp}@example.com`;
  const emailB = `social-b-${stamp}@example.com`;
  await register(emailA, "Social A");
  await register(emailB, "Social B");

  // --- author A publishes two posts: one public, one anonymous --------------
  await loginAs(emailA);
  const wf = await api("POST", "/api/workflows", pingWorkflow("Social Source"));
  assert.equal(wf.status, 200, JSON.stringify(wf.data));

  const first = await api("POST", "/api/community", {
    workflowId: wf.data.id,
    title: "Public Greeter",
    description: "a plain public post",
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.likeCount, 0);
  assert.equal(first.data.commentCount, 0);
  assert.equal(first.data.saveCount, 0);
  assert.equal(first.data.popularity, 0);

  const anon = await api("POST", "/api/community", {
    workflowId: wf.data.id,
    title: "Anonymous Post",
    description: "no name attached",
    anonymous: true,
  });
  assert.equal(anon.status, 200, JSON.stringify(anon.data));
  assert.equal(anon.data.anonymous, true);
  assert.equal(anon.data.ownerName, "Anonymous");
  assert.equal(anon.data.ownerId, "", "an anonymous post never leaks the author id");

  // --- viewer B sees both, likes + saves + comments the public one ----------
  await loginAs(emailB);
  const feed = await api("GET", "/api/community");
  assert.equal(feed.status, 200);
  assert.ok(Array.isArray(feed.data), "the feed stays a JSON array");
  assert.ok(feed.data.some((p) => p.id === first.data.id));
  const anonSeen = feed.data.find((p) => p.id === anon.data.id);
  assert.equal(anonSeen.ownerName, "Anonymous");

  const liked = await api("POST", `/api/community/${first.data.id}/like`);
  assert.equal(liked.status, 200);
  assert.deepEqual({ liked: liked.data.liked, likeCount: liked.data.likeCount }, { liked: true, likeCount: 1 });

  const likedAgain = await api("POST", `/api/community/${first.data.id}/like`);
  assert.deepEqual({ liked: likedAgain.data.liked, likeCount: likedAgain.data.likeCount }, { liked: false, likeCount: 0 });

  const reliked = await api("POST", `/api/community/${first.data.id}/like`);
  assert.equal(reliked.data.liked, true);

  const saved = await api("POST", `/api/community/${first.data.id}/save`);
  assert.deepEqual({ saved: saved.data.saved, saveCount: saved.data.saveCount }, { saved: true, saveCount: 1 });

  const comment = await api("POST", `/api/community/${first.data.id}/comments`, { text: "Great workflow!" });
  assert.equal(comment.status, 200, JSON.stringify(comment.data));
  assert.equal(comment.data.text, "Great workflow!");
  assert.equal(comment.data.commentCount, 1);

  const empty = await api("POST", `/api/community/${first.data.id}/comments`, { text: "   " });
  assert.equal(empty.status, 400, "an empty comment is rejected");

  // --- the detail page carries the thread ----------------------------------
  const detail = await api("GET", `/api/community/${first.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.likeCount, 1);
  assert.equal(detail.data.commentCount, 1);
  assert.equal(detail.data.comments.length, 1);
  assert.equal(detail.data.comments[0].userName, "Social B");
  assert.equal(detail.data.comments[0].mine, true, "the viewer's own comment is flagged");
  assert.equal(detail.data.saved, true);
  assert.equal(detail.data.liked, true);

  // --- filters: saved=1 and mine=1 -----------------------------------------
  const savedFeed = await api("GET", "/api/community?saved=1");
  assert.ok(savedFeed.data.some((p) => p.id === first.data.id));
  assert.ok(!savedFeed.data.some((p) => p.id === anon.data.id));

  const mineA = await api("GET", "/api/community?mine=1&author=");
  assert.equal(mineA.data.length, 0, "B has no posts of their own");

  // --- ranking + paging -----------------------------------------------------
  const popular = await api("GET", "/api/community?sort=popular");
  assert.equal(popular.data[0].id, first.data.id, "the liked/commented post ranks first");
  assert.ok(popular.data[0].popularity > popular.data[1].popularity);

  const paged = await raw("GET", "/api/community?limit=1&offset=0");
  assert.equal(paged.data.length, 1);
  assert.equal(paged.res.headers.get("x-total-count"), "2", "X-Total-Count reports the match total");

  const page2 = await raw("GET", "/api/community?limit=1&offset=1");
  assert.equal(page2.data.length, 1);
  assert.notEqual(page2.data[0].id, paged.data[0].id, "the second page is a different post");

  // --- the author can delete their own comment -----------------------------
  await loginAs(emailA);
  const asOwner = await api("GET", `/api/community/${first.data.id}`);
  assert.equal(asOwner.data.comments[0].mine, false, "the comment is not the owner's");
  const removed = await api("DELETE", `/api/community/${first.data.id}/comments/${comment.data.id}`);
  assert.equal(removed.status, 200, "the post owner can remove any comment");
  assert.equal(removed.data.commentCount, 0);
});

test("profiles: editable own profile and a public profile with public workflows", async () => {
  const stamp = Date.now();
  const emailA = `prof-a-${stamp}@example.com`;
  const emailB = `prof-b-${stamp}@example.com`;
  await register(emailA, "Prof A");
  await register(emailB, "Prof B");

  // A publishes a public post so the profile has something to show.
  await loginAs(emailA);
  const wf = await api("POST", "/api/workflows", pingWorkflow("Profile Source"));
  const post = await api("POST", "/api/community", { workflowId: wf.data.id, title: "Profile Post" });
  assert.equal(post.status, 200);

  // B edits their profile.
  await loginAs(emailB);
  const me = await api("GET", "/api/profile");
  assert.equal(me.status, 200);
  assert.ok(me.data.email, "your own profile includes your e-mail");
  assert.equal(me.data.displayName, "Prof B");

  const updated = await api("PUT", "/api/profile", {
    displayName: "Bee",
    bio: "I automate things.",
    location: "Berlin",
    website: "example.com",
    avatar: "🐝",
    anonymousByDefault: true,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.displayName, "Bee");
  assert.equal(updated.data.avatar, "🐝");
  assert.equal(updated.data.website, "https://example.com", "a bare host gets an https:// prefix");
  assert.equal(updated.data.anonymousByDefault, true);

  // A looks at B's public profile.
  await loginAs(emailA);
  const publicProfile = await api("GET", `/api/profile/${me.data.id}`);
  assert.equal(publicProfile.status, 200, JSON.stringify(publicProfile.data));
  assert.equal(publicProfile.data.displayName, "Bee");
  assert.equal(publicProfile.data.email, undefined, "a public profile never exposes the e-mail");
  assert.deepEqual(publicProfile.data.publicWorkflows, [], "B has no public posts yet");

  // A's own public profile lists the post they published.
  const meA = await api("GET", "/api/profile");
  const publicA = await api("GET", `/api/profile/${meA.data.id}`);
  assert.equal(publicA.data.postCount, 1);
  assert.equal(publicA.data.publicWorkflows.length, 1);
  assert.equal(publicA.data.publicWorkflows[0].title, "Profile Post");

  const missing = await api("GET", "/api/profile/does-not-exist");
  assert.equal(missing.status, 404);
});

test("publishing keeps recipients and other personal values with the author", async () => {
  const stamp = Date.now();
  const emailA = `private-a-${stamp}@example.com`;
  const emailB = `private-b-${stamp}@example.com`;
  await register(emailA, "Private A");
  await register(emailB, "Private B");

  await loginAs(emailA);
  const wf = await api("POST", "/api/workflows", {
    name: "Price mail",
    nodes: [
      { id: "m", type: "manual", data: { label: "Start", config: {} } },
      {
        id: "g",
        type: "gmailSend",
        data: { label: "Mail me", config: { to: "owner@example.com", cc: "{{body.cc}}", subject: "btc price", message: "price {{result.price}}" } },
      },
      { id: "t", type: "telegramSend", data: { label: "Ping", config: { chatId: "123456789", text: "hi" } } },
    ],
    edges: [],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));
  const post = await api("POST", "/api/community", { workflowId: wf.data.id, title: "Price mail", description: "x" });
  assert.equal(post.status, 200, JSON.stringify(post.data));

  // the author's own workflow is untouched
  const own = await api("GET", `/api/workflows/${wf.data.id}`);
  assert.equal(own.data.nodes.find((n) => n.id === "g").data.config.to, "owner@example.com");

  await loginAs(emailB);
  const imported = await api("POST", `/api/community/${post.data.id}/import`);
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const mail = imported.data.nodes.find((n) => n.id === "g").data.config;
  assert.equal(mail.to, "", "the author's address does not travel");
  assert.equal(mail.cc, "{{body.cc}}", "a placeholder is not personal and stays");
  assert.equal(mail.subject, "btc price", "ordinary settings stay");
  assert.equal(imported.data.nodes.find((n) => n.id === "t").data.config.chatId, "");
});
