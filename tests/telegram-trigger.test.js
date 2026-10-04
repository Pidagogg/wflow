// ============================================================================
// Telegram trigger — live getUpdates polling.
//
// The "Always listen" option on the Telegram trigger makes the server poll the
// bot (getUpdates) in the background and run the workflow for each new text
// message. These tests drive pollTelegramBots() with an injected clock and an
// injected fake Bot API layer to verify:
//   - triggers without the option on (or without a token) are never polled
//   - each new message fires the workflow exactly once; replays don't re-fire
//   - offsets advance so Telegram stops re-delivering acknowledged updates
//   - the chat-id filter only lets matching chats through
//   - an owner at the free-plan cap is skipped (message acknowledged, no run)
//   - the executor turns the update into the run's input (same shape as the
//     manual sample, so downstream logic stays identical)
//
// Timing note: the first sight of a live trigger only arms the poller — the
// Bot API is first hit POLL_MIN_INTERVAL_MS later, so a server restart never
// hammers Telegram at boot. Tests drive the clock forward past that interval.
//
// The SQL database (BF_DB_PATH) and JSON data dir (BF_DATA_DIR) point at a
// temp folder so the real ./data is never touched.
// ============================================================================
import assert from "node:assert/strict";
import { test, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-tg-"));
process.env.BF_DB_PATH = path.join(tempDir, "tg.db");
process.env.BF_DATA_DIR = tempDir;

const { workflows, setWorkflowStorageMode } = await import("../server/store.js");
const { pollTelegramBots, resetTelegramPollers } = await import("../server/telegram.js");
const { db, closeDb } = await import("../server/dbx.js");
const { executeWorkflow } = await import("../server/executor.js");
const { FREE_MAX_RUNS_PER_DAY } = await import("../server/quota.js");

const TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const POLL_INTERVAL = 20_000; // mirrors POLL_MIN_INTERVAL_MS in telegram.js

function upd(id, { text = "hello", chat = 777, messageId } = {}) {
  return {
    update_id: id,
    message: {
      message_id: messageId ?? id * 10,
      chat: { id: chat, type: "private" },
      from: { id: 555, first_name: "Demo", username: "demo_user" },
      text,
      date: 1_700_000_000,
    },
  };
}

// Fake Bot API — mirrors the real getUpdates acknowledgement semantics: the
// offset the client sends confirms every update below it, so a confirmed
// update is never delivered again. `pending` is what the "server" holds;
// delivered offsets update the confirmed watermark.
let pending = []; // updates the "server" still holds
let confirmed = 0; // highest update_id confirmed by the client's offsets
let deliveredOffsets = []; // offsets the poller sent
let apiCalls = 0;
const fakeCallApi = async (_method, { botToken, params }) => {
  apiCalls++;
  const offset = Number(params.offset);
  deliveredOffsets.push(offset);
  if (offset - 1 > confirmed) confirmed = offset - 1;
  const batch = pending.filter((u) => u.update_id > confirmed).slice(0, 2);
  return { ok: true, result: batch };
};

function tgWorkflow(id, ownerId = "tg-owner", overrides = {}) {
  const config = { botToken: TOKEN, chatId: "", live: true, ...overrides };
  return {
    id,
    ownerId,
    name: `TG Test WF ${id}`,
    nodes: [
      { id: "trig", type: "telegramTrigger", data: { config } },
      { id: "sink", type: "log", data: { config: {} } },
    ],
    edges: [{ id: "e1", source: "trig", target: "sink", sourceHandle: "out", targetHandle: "in" }],
  };
}

async function runPoll(now, name = "TG Test WF") {
  const lines = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    await pollTelegramBots({ now, callApi: fakeCallApi });
  } finally {
    console.log = orig;
    console.error = origErr;
  }
  const runs = lines.filter((l) => l.includes(`[telegram] ran "${name}`)).length;
  return { runs, lines };
}

after(() => {
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
  apiCalls = 0;
  pending = [];
  confirmed = 0;
  deliveredOffsets = [];
  resetTelegramPollers();
});

test("telegram trigger: live workflows are polled, non-live / tokenless are skipped", async () => {
  await setWorkflowStorageMode("database");
  db.clearRunUsage("tg-owner");
  // live:true → polled; live:false (default) → never; no token → never
  await workflows.save(tgWorkflow("wf-tg-live"));
  await workflows.save(tgWorkflow("wf-tg-off", "tg-owner", { live: false }));
  await workflows.save(tgWorkflow("wf-tg-notoken", "tg-owner", { botToken: "" }));

  const t0 = Date.now();
  pending = [upd(1)];

  // First pass only arms the pollers (never hits the API immediately).
  assert.equal((await runPoll(t0)).runs, 0, "arming pass fires nothing");
  assert.equal(apiCalls, 0, "arming pass makes no API call");
  assert.equal(deliveredOffsets.length, 0);

  // Past the poll interval: only the live trigger is polled (one API call),
  // and the new message fires the workflow.
  const fired = await runPoll(t0 + POLL_INTERVAL + 1, "TG Test WF wf-tg-live");
  assert.equal(fired.runs, 1, "the new message fires the live workflow");
  assert.equal(apiCalls, 1, "exactly one bot was polled (non-live / tokenless skipped)");
  assert.equal(deliveredOffsets[0], 0, "first poll starts from offset 0");

  // Next poll immediately (not yet due — the next poll is due at +1 from the
  // previous poll's finish, i.e. t0 + 2*POLL_INTERVAL + 2) — no extra call.
  const early = await runPoll(t0 + POLL_INTERVAL + 2);
  assert.equal(early.runs, 0);
  assert.equal(apiCalls, 1, "no tight-loop polling");
});

test("telegram trigger: replays never re-fire and the offset advances", async () => {
  await setWorkflowStorageMode("database");
  db.clearRunUsage("tg-owner");
  await workflows.save(tgWorkflow("wf-tg-dedup"));
  const t0 = Date.now();

  await runPoll(t0); // arm
  pending = [upd(1)];
  assert.equal((await runPoll(t0 + POLL_INTERVAL + 1, "TG Test WF wf-tg-dedup")).runs, 1, "first delivery fires");

  // A new update 2 appears after update 1 was acknowledged → only 2 fires.
  pending = [upd(2)];
  const second = await runPoll(t0 + 2 * POLL_INTERVAL + 2, "TG Test WF wf-tg-dedup");
  assert.equal(second.runs, 1, "only the genuinely new update fires");
  assert.ok(
    deliveredOffsets[deliveredOffsets.length - 1] > 1,
    "offset advanced past delivered updates"
  );

  // Everything is acknowledged now — a later poll with the same updates fires nothing.
  pending = [upd(1), upd(2)];
  const third = await runPoll(t0 + 3 * POLL_INTERVAL + 2, "TG Test WF wf-tg-dedup");
  assert.equal(third.runs, 0, "nothing new left to fire");
});

test("telegram trigger: chat-id filter only fires the configured chat", async () => {
  await setWorkflowStorageMode("database");
  db.clearRunUsage("tg-owner");
  await workflows.save(tgWorkflow("wf-tg-chat", "tg-owner", { chatId: "777" }));
  const t0 = Date.now();

  await runPoll(t0); // arm
  pending = [upd(1, { chat: 999 }), upd(2, { chat: 777 })];
  const { runs, lines } = await runPoll(t0 + POLL_INTERVAL + 1, "TG Test WF wf-tg-chat");
  assert.equal(runs, 1, "only the chat that matches the filter fires");
  assert.ok(lines.some((l) => l.includes("update 2")), "the matching update ran");
});

test("telegram trigger: an owner at the free-plan cap is skipped without executing", async () => {
  await setWorkflowStorageMode("database");
  const owner = "tg-owner-cap";
  db.clearRunUsage(owner);
  for (let i = 0; i < FREE_MAX_RUNS_PER_DAY; i++) await db.bumpRunUsage(owner);

  await workflows.save(tgWorkflow("wf-tg-cap", owner));
  const t0 = Date.now();

  await runPoll(t0); // arm
  pending = [upd(1)];
  const { runs, lines } = await runPoll(t0 + POLL_INTERVAL + 1, "TG Test WF wf-tg-cap");
  assert.equal(runs, 0, "no execution while the owner is at the cap");
  assert.ok(lines.some((l) => l.includes("[telegram] skipped")), "explains the skip in the log");

  // The skipped update is acknowledged in memory (offset advanced past it), so
  // the next API poll asks from update 2 on — update 1 never replays.
  pending = [upd(2)];
  const { runs: afterReset } = await runPoll(t0 + 2 * POLL_INTERVAL + 2, "TG Test WF wf-tg-cap");
  assert.equal(afterReset, 0, "the skipped update is not replayed or double-fired");
  assert.ok(
    deliveredOffsets[deliveredOffsets.length - 1] > 1,
    "the next poll's offset advanced past the skipped update"
  );

  // With quota restored, genuinely new messages fire again.
  db.clearRunUsage("tg-owner-cap");
  pending = [upd(3)];
  const { runs: afterReset2 } = await runPoll(t0 + 3 * POLL_INTERVAL + 2, "TG Test WF wf-tg-cap");
  assert.equal(afterReset2, 1, "later messages fire once the quota resets");
});

test("executor: a polled update becomes run input; manual run still samples", async () => {
  const makeWf = () => ({
    id: "wf-tg-exec",
    name: "exec",
    nodes: [
      { id: "trig", type: "telegramTrigger", data: { config: { botToken: TOKEN, live: true } } },
    ],
    edges: [],
  });

  // Live fire: the poller passes the update through triggerPayload.
  const liveUpdate = upd(42, { text: "Live message", chat: 888 });
  const live = await executeWorkflow(makeWf(), {
    triggerPayload: liveUpdate,
    maxItemsPerNode: 10,
    userId: "tg-owner",
  });
  const liveEntry = live.log.find((l) => l.nodeId === "trig");
  assert.equal(liveEntry.status, "success");
  assert.equal(liveEntry.outputItems[0].update_id, 42);
  assert.equal(liveEntry.outputItems[0].message.text, "Live message");

  // Manual run from the editor (no triggerPayload): the sample update comes back.
  const manual = await executeWorkflow(makeWf(), { maxItemsPerNode: 10 });
  const manualEntry = manual.log.find((l) => l.nodeId === "trig");
  assert.equal(manualEntry.status, "success");
  assert.equal(manualEntry.outputItems[0].message.text, "Hello from Telegram!");
});
