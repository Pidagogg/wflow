// ============================================================================
// RSS trigger — live feed polling.
//
// Since the RSS trigger was made real, the background scheduler polls saved
// workflows that contain one, and runs the workflow when NEW items appear.
// These tests drive the scheduler's tick loop with an injected clock and a
// stubbed fetch to verify:
//   - the first poll only records a baseline (existing items never fire)
//   - unchanged feeds never fire
//   - a feed with a new item fires exactly once, and does not re-fire
//   - the executor turns the scheduler payload into the run's input (same
//     shape as the manual sample, so downstream logic stays identical)
//
// The SQL database (BF_DB_PATH) and the JSON data dir (BF_DATA_DIR) are
// pointed at a temp folder so the real ./data is never touched.
// ============================================================================
import assert from "node:assert/strict";
import { test, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-rss-"));
process.env.BF_DB_PATH = path.join(tempDir, "rss.db");
process.env.BF_DATA_DIR = tempDir;

const { workflows, setWorkflowStorageMode } = await import("../server/store.js");
const { tick, resetSchedulerState } = await import("../server/scheduler.js");
const { db, closeDb } = await import("../server/dbx.js");
const { executeWorkflow } = await import("../server/executor.js");
const { FREE_MAX_RUNS_PER_DAY } = await import("../server/quota.js");

const FEED_URL = "https://example.com/feed.xml";
const ITEM_A = "<item><title>First story</title><link>http://localhost/a</link><guid>a</guid><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate></item>";
const ITEM_B = "<item><title>Second story</title><link>http://localhost/b</link><guid>b</guid><pubDate>Tue, 02 Sep 2026 10:00:00 GMT</pubDate></item>";
const ITEM_C = "<item><title>Third story</title><link>http://localhost/c</link><guid>c</guid><pubDate>Wed, 03 Sep 2026 10:00:00 GMT</pubDate></item>";
function feed(...items) {
  return '<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title>' + items.join("") + "</channel></rss>";
}

let currentFeed = feed(ITEM_A);
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchCalls++;
  return {
    ok: true,
    status: 200,
    headers: { entries: () => [], get: () => null, getSetCookie: () => [] },
    text: async () => currentFeed,
    json: async () => ({}),
  };
};

function rssWorkflow(id, ownerId = "r-owner") {
  return {
    id,
    ownerId,
    name: `RSS Test WF ${id}`,
    nodes: [
      { id: "trig", type: "rssTrigger", data: { config: { url: FEED_URL, pollInterval: 1 } } },
      { id: "sink", type: "log", data: { config: {} } },
    ],
    edges: [{ id: "e1", source: "trig", target: "sink", sourceHandle: "out", targetHandle: "in" }],
  };
}

async function runTick(now, name = "RSS Test WF") {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try {
    await tick(now);
  } finally {
    console.log = orig;
  }
  const rssRuns = lines.filter((l) => l.includes(`[scheduler] rss ran "${name}`)).length;
  const cronRuns = lines.filter((l) => l.includes(`[scheduler] ran "${name}`)).length;
  return { rssRuns, cronRuns, lines };
}

after(() => {
  globalThis.fetch = originalFetch;
  try {
    closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(() => {
  fetchCalls = 0;
  currentFeed = feed(ITEM_A);
});

test("rss trigger: baseline first, then fires exactly once per new item", async () => {
  await setWorkflowStorageMode("database");
  db.clearRunUsage("r-owner");
  await workflows.save(rssWorkflow("wf-rss-1"));
  resetSchedulerState();

  const t0 = Date.now();
  // 1. first sight — poll records the current feed head as baseline, no fire
  assert.equal((await runTick(t0, "RSS Test WF wf-rss-1")).rssRuns, 0, "baseline poll must not fire");
  assert.equal(fetchCalls, 1, "baseline fetched the feed once");

  // 2. next poll with an unchanged feed — still nothing
  assert.equal((await runTick(t0 + 60_000, "RSS Test WF wf-rss-1")).rssRuns, 0, "unchanged feed never fires");

  // 3. feed gains a new item → fires exactly once
  currentFeed = feed(ITEM_B, ITEM_A);
  assert.equal((await runTick(t0 + 120_000, "RSS Test WF wf-rss-1")).rssRuns, 1, "new item fires the workflow");
  assert.equal(fetchCalls, 3, "three polls by now");

  // 4. same feed again → the new item is already seen, no double fire
  assert.equal((await runTick(t0 + 180_000, "RSS Test WF wf-rss-1")).rssRuns, 0, "no re-fire for already-seen items");

  // 5. feed rotates (previous head dropped) with a genuinely newer item → fires once
  currentFeed = feed(ITEM_C);
  assert.equal((await runTick(t0 + 240_000, "RSS Test WF wf-rss-1")).rssRuns, 1, "rotated feed with a newer item fires");
});

test("rss trigger: an owner at the free-plan cap is skipped without executing", async () => {
  await setWorkflowStorageMode("database");
  const owner = "r-owner-cap";
  db.clearRunUsage(owner);
  for (let i = 0; i < FREE_MAX_RUNS_PER_DAY; i++) await db.bumpRunUsage(owner); // exhaust the free day

  await workflows.save(rssWorkflow("wf-rss-cap", owner));
  resetSchedulerState();

  const t0 = Date.now();
  await runTick(t0); // baseline (no fire)
  currentFeed = feed(ITEM_B, ITEM_A);
  const { rssRuns, lines } = await runTick(t0 + 60_000, "RSS Test WF wf-rss-cap");
  assert.equal(rssRuns, 0, "no execution while the owner is at the cap");
  assert.ok(lines.some((l) => l.includes(`[scheduler] rss skipped "RSS Test WF wf-rss-cap`)), "explains the skip in the log");
});

test("executor: scheduler payload becomes run input; manual run still samples", async () => {
  const makeWf = () => ({
    id: "wf-rss-exec",
    name: "exec",
    nodes: [{ id: "trig", type: "rssTrigger", data: { config: { url: FEED_URL, pollInterval: 1 } } }],
    edges: [],
  });

  // Live fire: the scheduler passes the new items in triggerPayload.
  const items = [
    { title: "Live story", link: "http://localhost/live", guid: "live-1", pubDate: new Date().toISOString() },
  ];
  const live = await executeWorkflow(makeWf(), {
    triggerPayload: { feed: FEED_URL, feedTitle: "Test Feed", polledAt: new Date().toISOString(), items, count: 1 },
    maxItemsPerNode: 10,
    userId: "r-owner",
  });
  const liveEntry = live.log.find((l) => l.nodeId === "trig");
  assert.equal(liveEntry.status, "success");
  assert.equal(liveEntry.outputItems[0].count, 1);
  assert.equal(liveEntry.outputItems[0].items[0].guid, "live-1");
  assert.equal(liveEntry.outputItems[0].feed, FEED_URL);

  // Manual run from the editor (no triggerPayload): the sample item comes back.
  const manual = await executeWorkflow(makeWf(), { maxItemsPerNode: 10 });
  const manualEntry = manual.log.find((l) => l.nodeId === "trig");
  assert.equal(manualEntry.status, "success");
  assert.equal(manualEntry.outputItems[0].items[0].guid, "bf-post-001");
});
