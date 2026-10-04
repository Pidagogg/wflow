// ============================================================================
// Telegram bots — connected bots, the node runner and the poller's filters.
//
//   - connectBot() checks the token with getMe, stores it encrypted as an
//     "oauth:telegram" connection and refreshes (not duplicates) a reconnect
//   - a node with a connected bot runs with that bot's token; the token never
//     shows up in the node output
//   - node fields become the right Bot API parameters (buttons, reply
//     keyboards, polls, commands, uploads from an earlier node)
//   - "Listen for" modes and the chat filter decide which updates fire
//   - two workflows on the same bot share ONE poller (Telegram allows one
//     getUpdates caller per bot) and both fire for one update
//
// The database and data dir point at a temp folder; fetch is stubbed.
// ============================================================================
import assert from "node:assert/strict";
import { test, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-tgbots-"));
process.env.BF_DB_PATH = path.join(tempDir, "tg.db");
process.env.BF_DATA_DIR = tempDir;

const { db, closeDb } = await import("../server/dbx.js");
const { connectBot, listBots, botTokenFor, recentChats, resetSeenChats } = await import("../server/telegram-bots.js");
const { executeWorkflow } = await import("../server/executor.js");
const { workflows, setWorkflowStorageMode } = await import("../server/store.js");
const { pollTelegramBots, resetTelegramPollers, updateMatches } = await import("../server/telegram.js");

const TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const user = db.createUser({ email: "tg-bots@example.com", name: "TG", passwordHash: "x" });
const userId = String(user.id);

// Captures every Bot API call; answers like Telegram does.
let calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = u.split("/").pop();
  const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : {};
  calls.push({ url: u, method, body });
  let result = { message_id: 1 };
  if (method === "getMe") result = { id: 123456, is_bot: true, first_name: "Demo", username: "demo_bot" };
  if (method === "getUpdates") result = [{ update_id: 5, message: { message_id: 9, chat: { id: 777, type: "private", first_name: "Ada" }, text: "hi" } }];
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
};

after(() => {
  globalThis.fetch = originalFetch;
  try {
    closeDb();
  } catch {
    /* best-effort */
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  resetSeenChats();
  resetTelegramPollers();
});

// A manual trigger with fixed output feeds `json` into the node under test.
function run(type, config, json = {}) {
  return executeWorkflow(
    {
      id: `wf-${type}`,
      name: type,
      nodes: [
        { id: "in", type: "manual", data: { config: { manualOutput: true, manualOutputJson: JSON.stringify(json) } } },
        { id: "n", type, data: { config } },
      ],
      edges: [{ id: "e", source: "in", target: "n", sourceHandle: "out", targetHandle: "in" }],
    },
    { userId, maxItemsPerNode: 10 }
  );
}

test("connectBot validates, stores and refreshes one connection per bot", async () => {
  await assert.rejects(connectBot(userId, "not-a-token"), /does not look like a bot token/);
  const bot = await connectBot(userId, TOKEN);
  assert.equal(bot.email, "@demo_bot");
  assert.equal(bot.provider, "telegram");
  assert.equal(JSON.stringify(bot).includes(TOKEN), false, "the view never carries the token");
  const again = await connectBot(userId, TOKEN);
  assert.equal(again.id, bot.id, "reconnecting the same bot updates it");
  assert.equal((await listBots(userId)).length, 1);
  assert.equal(await botTokenFor({ id: bot.id, userId }), TOKEN);
  await assert.rejects(botTokenFor({ id: bot.id, userId: "someone-else" }), /no longer connected/);
});

test("recentChats finds the chat that messaged the bot without acknowledging it", async () => {
  const bot = await connectBot(userId, TOKEN);
  calls = [];
  const chats = await recentChats({ id: bot.id, userId });
  assert.deepEqual(chats.map((c) => c.id), ["777"]);
  assert.equal(chats[0].title, "Ada");
  assert.equal(calls[0].body.offset, -100, "peeks with a negative offset");
});

test("a node with a connected bot sends with its token and keeps it out of the output", async () => {
  const bot = await connectBot(userId, TOKEN);
  calls = [];
  const res = await run("telegramSend", { telegramBot: bot.id, chatId: "42", text: "Hi {{name}}", parseMode: "HTML", buttons: '[[{"text":"Yes","callback_data":"yes"}]]' }, { name: "Ada" });
  const entry = res.log.find((l) => l.nodeId === "n");
  assert.equal(entry.status, "success", entry.error);
  const call = calls.find((c) => c.method === "sendMessage");
  assert.ok(call.url.includes(`/bot${TOKEN}/`));
  assert.equal(call.body.text, "Hi Ada");
  assert.equal(call.body.parse_mode, "HTML");
  assert.deepEqual(call.body.reply_markup, { inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]] });
  assert.equal(JSON.stringify(entry.outputItems).includes(TOKEN), false);
});

test("reply keyboards, polls and bot commands become Bot API parameters", async () => {
  await run("telegramSend", { botToken: TOKEN, chatId: "1", text: "menu", keyboard: "A | B\nC" });
  assert.deepEqual(calls.at(-1).body.reply_markup, { keyboard: [[{ text: "A" }, { text: "B" }], [{ text: "C" }]], resize_keyboard: true });

  await run("telegramSendPoll", { botToken: TOKEN, chatId: "1", question: "Lunch?", options: "Pizza\nSushi\n", anonymous: false });
  assert.deepEqual(calls.at(-1).body.options, [{ text: "Pizza" }, { text: "Sushi" }]);
  assert.equal(calls.at(-1).body.is_anonymous, false);

  await run("telegramSetCommands", { botToken: TOKEN, commands: "/start - Start\nhelp: Help me" });
  assert.deepEqual(calls.at(-1).body.commands, [
    { command: "start", description: "Start" },
    { command: "help", description: "Help me" },
  ]);

  const bad = await run("telegramSendPoll", { botToken: TOKEN, chatId: "1", question: "?", options: "only one" });
  assert.equal(bad.log.find((l) => l.nodeId === "n").status, "error");
});

test("a file from an earlier node is uploaded as multipart", async () => {
  await run("telegramSendPhoto", { botToken: TOKEN, chatId: "1", fileField: "img", caption: "look" }, { img: "data:image/png;base64,aGVsbG8=" });
  const call = calls.at(-1);
  assert.equal(call.method, "sendPhoto");
  assert.ok(call.body instanceof FormData);
  const file = call.body.get("photo");
  assert.equal(file.type, "image/png");
  assert.equal(await file.text(), "hello");
  assert.equal(call.body.get("caption"), "look");
});

test("Listen for: text, commands, button presses and the chat filter", () => {
  const text = { update_id: 1, message: { chat: { id: 5 }, text: "hello" } };
  const photo = { update_id: 2, message: { chat: { id: 5 }, photo: [{ file_id: "x" }] } };
  const cmd = { update_id: 3, message: { chat: { id: 5 }, text: "/start@demo_bot now" } };
  const press = { update_id: 4, callback_query: { id: "q", data: "yes", message: { chat: { id: 5 } } } };

  assert.equal(updateMatches(text, {}), true, "text messages is the default");
  assert.equal(updateMatches(photo, {}), false);
  assert.equal(updateMatches(photo, { updates: "all messages" }), true);
  assert.equal(updateMatches(cmd, { updates: "commands" }), true);
  assert.equal(updateMatches(cmd, { updates: "commands", command: "start" }), true);
  assert.equal(updateMatches(cmd, { updates: "commands", command: "/help" }), false);
  assert.equal(updateMatches(text, { updates: "commands" }), false);
  assert.equal(updateMatches(press, { updates: "button presses" }), true);
  assert.equal(updateMatches(text, { updates: "button presses" }), false);
  assert.equal(updateMatches(press, { updates: "button presses", chatId: "6" }), false);
  assert.equal(updateMatches(press, { updates: "everything", chatId: "5" }), true);
});

test("two workflows on one bot share one poller and both fire", async () => {
  await setWorkflowStorageMode("database");
  const wf = (id) => ({
    id,
    ownerId: userId,
    name: `Shared bot ${id}`,
    nodes: [
      { id: "trig", type: "telegramTrigger", data: { config: { botToken: TOKEN, live: true } } },
      { id: "sink", type: "log", data: { config: {} } },
    ],
    edges: [{ id: "e", source: "trig", target: "sink", sourceHandle: "out", targetHandle: "in" }],
  });
  await workflows.save(wf("wf-share-a"));
  await workflows.save(wf("wf-share-b"));

  let apiCalls = 0;
  const callApi = async (_method, { params }) => {
    apiCalls++;
    return { ok: true, result: params.offset > 1 ? [] : [{ update_id: 1, message: { chat: { id: 1 }, text: "hi" } }] };
  };
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const t0 = Date.now();
    await pollTelegramBots({ now: t0, callApi }); // arm
    await pollTelegramBots({ now: t0 + 21_000, callApi });
  } finally {
    console.log = orig;
  }
  assert.equal(apiCalls, 1, "one getUpdates call for the shared bot");
  assert.ok(lines.some((l) => l.includes('ran "Shared bot wf-share-a"')));
  assert.ok(lines.some((l) => l.includes('ran "Shared bot wf-share-b"')));
});

// ---- personal accounts (server/telegram-accounts.js) ----
// A real login needs Telegram; these cover everything around it.

const { NODES } = await import("../shared/catalog.js");
const { startLogin, finishLogin, ACCOUNT_NODE_TYPES } = await import("../server/telegram-accounts.js");

test("account-capable Telegram nodes offer 'Connect as', bot-only ones do not", () => {
  for (const type of ACCOUNT_NODE_TYPES) {
    const keys = NODES[type].fields.map((f) => f.key);
    assert.ok(keys.includes("connectAs") && keys.includes("telegramAccount"), `${type} can run as an account`);
    assert.equal(NODES[type].defaults.connectAs, "bot", `${type} stays a bot by default`);
  }
  assert.ok(NODES.telegramTrigger.fields.some((f) => f.key === "telegramAccount"), "the trigger can listen as an account");
  for (const type of ["telegramSetCommands", "telegramAnswerCallback", "telegramSendPoll", "telegramApi", "telegramGetFile"]) {
    assert.ok(!NODES[type].fields.some((f) => f.key === "connectAs"), `${type} is bot-only`);
  }
});

test("the account login checks its inputs before contacting Telegram", async () => {
  await assert.rejects(startLogin(userId, { apiId: "abc", apiHash: "0".repeat(32), phone: "+491701234567" }), /API ID/);
  await assert.rejects(startLogin(userId, { apiId: "12345", apiHash: "short", phone: "+491701234567" }), /API hash/);
  await assert.rejects(startLogin(userId, { apiId: "12345", apiHash: "a".repeat(32), phone: "call me" }), /phone number/);
  await assert.rejects(finishLogin(userId, { loginId: "nope", code: "12345" }), /expired/);
});

test("a node set to 'my account' needs a picked, still-connected account", async () => {
  const none = await run("telegramSend", { connectAs: "account", telegramAccount: "", chatId: "me", text: "hi" });
  assert.match(none.log.find((l) => l.nodeId === "n").error, /Pick your Telegram account/);
  const gone = await run("telegramSend", { connectAs: "account", telegramAccount: "cred-missing", chatId: "me", text: "hi" });
  assert.match(gone.log.find((l) => l.nodeId === "n").error, /no longer connected/);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0, "nothing went to the Bot API");
});

test("triggers listening as an account are not polled through the Bot API", async () => {
  await setWorkflowStorageMode("database");
  // only this test's workflow may be live
  await workflows.remove("wf-share-a");
  await workflows.remove("wf-share-b");
  await workflows.save({
    id: "wf-acct-trigger",
    ownerId: userId,
    name: "Account trigger",
    nodes: [{ id: "t", type: "telegramTrigger", data: { config: { connectAs: "account", telegramAccount: "cred-x", live: true } } }],
    edges: [],
  });
  let apiCalls = 0;
  const callApi = async () => {
    apiCalls++;
    return { ok: true, result: [] };
  };
  const t0 = Date.now();
  await pollTelegramBots({ now: t0, callApi });
  await pollTelegramBots({ now: t0 + 60_000, callApi });
  assert.equal(apiCalls, 0);
  await workflows.remove("wf-acct-trigger");
});
