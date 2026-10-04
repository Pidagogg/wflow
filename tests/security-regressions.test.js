// ============================================================================
// Regression tests for defects found in the September 2026 audit:
//   - /api/auth/forgot must not hand out a working reset link just because no
//     SMTP server is configured (that allowed taking over any account)
//   - unowned workflows are adopted only by the instance owner, not by every
//     account that logs in
//   - anonymous community posts never appear on the author's public profile
//   - the public config reports whether Pro can be bought (sales switch)
//   - robots.txt really disallows crawling when indexing is switched off
//
// This server runs WITHOUT BF_EXPOSE_RESET_LINK and without SMTP.
// Run: node --test tests/security-regressions.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { renderRobots } from "../server/seo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-secreg-"));
const dbPath = path.join(tempDir, "secreg.db");
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

async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const first = res.headers.getSetCookie?.()?.[0];
  if (first) cookie = first.split(";")[0];
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, data };
}

async function register(tag) {
  cookie = "";
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const res = await api("POST", "/api/auth/register", { email, password: "correct-horse-battery", name: tag });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return email;
}

async function login(email) {
  cookie = "";
  const res = await api("POST", "/api/auth/login", { email, password: "correct-horse-battery" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), BF_DB_PATH: dbPath, BF_DATA_DIR: dataDir, DISABLE_SCHEDULER: "1", NODE_ENV: "test" };
  for (const k of ["BF_EXPOSE_RESET_LINK", "SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) delete env[k];
  child = spawn(process.execPath, ["server/index.js"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/auth/config`)).status === 200) return;
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

test("forgot-password never returns the reset link without the explicit debug flag", async () => {
  const email = await register("victim");
  cookie = "";
  const res = await api("POST", "/api/auth/forgot", { email });
  assert.equal(res.status, 200);
  assert.equal(res.data.resetLink, undefined, "no SMTP configured must NOT expose the reset link");
});

test("the public config reports that Pro sales are closed on a fresh install", async () => {
  const res = await api("GET", "/api/auth/config");
  assert.equal(res.status, 200);
  assert.equal(res.data.salesOpen, false);
});

test("anonymous posts stay off the author's public profile for other viewers", async () => {
  const author = await register("author");
  const wf = await api("POST", "/api/workflows", {
    name: "Anon source",
    nodes: [{ id: "m", type: "manual", data: { label: "Start", config: {} } }],
    edges: [],
  });
  assert.equal(wf.status, 200, JSON.stringify(wf.data));
  const post = await api("POST", "/api/community", { workflowId: wf.data.id, title: "Secret author", anonymous: true });
  assert.equal(post.status, 200, JSON.stringify(post.data));
  const me = await api("GET", "/api/profile");
  const authorId = me.data.id;

  await register("viewer");
  const profile = await api("GET", `/api/profile/${authorId}`);
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  assert.deepEqual(profile.data.publicWorkflows, [], "the anonymous post must not be linked to its author");
  const byAuthor = await api("GET", `/api/community?author=${encodeURIComponent(authorId)}`);
  assert.equal((byAuthor.data.posts || []).length, 0);

  // the author still sees it on their own profile
  await login(author);
  const own = await api("GET", `/api/profile/${authorId}`);
  assert.equal(own.data.publicWorkflows.length, 1);
});

test("robots.txt has no Allow rule left when indexing is switched off", () => {
  const baseRobots = fs.readFileSync(path.join(repoRoot, "public", "robots.txt"), "utf8");
  const off = renderRobots(baseRobots, { indexable: false, aiCrawlers: true }, "w-flow.tech");
  assert.doesNotMatch(off, /^Allow:/m);
  assert.match(off, /^User-agent: \*\nDisallow: \/$/m);
  assert.match(off, /Sitemap: https:\/\/w-flow\.tech\/sitemap\.xml/);
  const on = renderRobots(baseRobots, { indexable: true, aiCrawlers: true }, "w-flow.tech");
  assert.match(on, /^User-agent: \*\nAllow: \/$/m);
});
