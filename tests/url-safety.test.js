// ============================================================================
// SSRF guard — BF_BLOCK_PRIVATE_URLS.
//
// On a public deployment (e.g. AWS EC2) a workflow must not be able to call the
// server itself, its VPC, or the cloud instance-metadata service at
// 169.254.169.254 (which can hand out IAM credentials). With
// BF_BLOCK_PRIVATE_URLS=1 the HTTP Request / RSS Read / webhook-sender nodes
// refuse private, link-local and loopback addresses before any network I/O.
//
// Run: node --test tests/url-safety.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Enable the guard BEFORE the executor module is imported (it reads env on each
// call, but keeping it deterministic from the start avoids surprises).
process.env.BF_BLOCK_PRIVATE_URLS = "1";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-urlsafety-"));
process.env.BF_DB_PATH = path.join(tempDir, "urlsafety.db");
process.env.BF_DATA_DIR = tempDir;

const { executeWorkflow } = await import("../server/executor.js");

const FAKE_JSON = { ok: true, sent: true };
let originalFetch;
function makeResponse(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { entries: () => [], get: () => null, getSetCookie: () => [] },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}
function stubFetch() {
  return Promise.resolve(makeResponse(FAKE_JSON));
}

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
});
after(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
beforeEach(() => {
  globalThis.fetch = stubFetch;
});

// A workflow with a single node (no edges) — the executor seeds it with one
// input item, exactly like running a lone action node from the editor.
function singleNodeWorkflow(type, config) {
  return {
    id: `wf-${type}-${Math.random().toString(36).slice(2)}`,
    name: type,
    nodes: [{ id: "n1", type, position: { x: 0, y: 0 }, data: { label: type, config } }],
    edges: [],
  };
}

async function runOne(type, config) {
  const result = await executeWorkflow(singleNodeWorkflow(type, config), { payload: {}, maxItemsPerNode: 10 });
  const entry = result.log.find((l) => l.nodeId === "n1");
  assert.ok(entry, `"${type}" produced a log entry`);
  return entry;
}

const BLOCKED_URLS = [
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://10.0.0.5/internal",
  "http://172.16.0.7/internal",
  "http://192.168.1.10/internal",
  "https://127.0.0.1/secret",
  "http://localhost/secret",
  // IPv4-in-IPv6 forms the URL parser rewrites to hex — these slipped past the
  // old string-prefix check straight to loopback / the metadata service.
  "http://[::ffff:127.0.0.1]/secret",
  "http://[::ffff:169.254.169.254]/latest/meta-data/",
  "http://[::127.0.0.1]/secret",
  "http://[::1]/secret",
];

for (const url of BLOCKED_URLS) {
  test(`HTTP Request node refuses ${url}`, async () => {
    const entry = await runOne("http", { method: "GET", url });
    assert.equal(entry.status, "error", `"${url}" must not be called`);
    assert.equal(entry.errorCode, 3005, `"${url}" should map to BF-3005 (URL_BLOCKED)`);
    assert.match(String(entry.error || ""), /blocked/i);
  });
}

test("public URLs still work when the guard is on", async () => {
  const entry = await runOne("http", { method: "GET", url: "https://example.com/stub" });
  assert.equal(entry.status, "success", `public call should succeed; error=${entry.error}`);
  assert.equal(entry.outputItems[0]?.ok, true);
});

test("webhook-sender nodes refuse internal webhook URLs too", async () => {
  for (const [type, config] of [
    ["slackSend", { webhookUrl: "http://127.0.0.1/hook", text: "hi" }],
    ["discordSend", { webhookUrl: "http://10.1.2.3/hook", content: "hi" }],
    ["teamsSend", { webhookUrl: "http://169.254.169.254/hook", text: "hi" }],
  ]) {
    const entry = await runOne(type, config);
    assert.equal(entry.status, "error", `${type} must refuse the internal webhook URL`);
    assert.equal(entry.errorCode, 3005, `${type} should map to BF-3005`);
  }
});

test("RSS Read node refuses internal feed URLs", async () => {
  const entry = await runOne("rssRead", { url: "http://192.168.50.10/feed.xml", limit: 5 });
  assert.equal(entry.status, "error");
  assert.equal(entry.errorCode, 3005);
});

test("Feeds & Sources presets refuse internal feed URLs", async () => {
  const entry = await runOne("podcastFeed", { url: "http://192.168.50.10/podcast.xml", limit: 5 });
  assert.equal(entry.status, "error");
  assert.equal(entry.errorCode, 3005);
});
