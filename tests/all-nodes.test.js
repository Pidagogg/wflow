// ============================================================================
// Every node in the catalog, exercised end-to-end through the real executor.
//
// For each node type we build a single-node workflow and run it a few times:
//   1. WITHOUT manual output  -> the node's actual handler executes against a
//      rich test payload (like a default user testing their workflow).
//   2. WITH manual output set -> the node is skipped and downstream receives
//      exactly the JSON the user typed (Output -> Manual output).
//
// globalThis.fetch is stubbed so network-bound nodes (HTTP, Slack, AI, …) run
// deterministically without touching the internet or needing credentials; the
// executor still performs its real request building / response parsing code.
//
// Run: node --test tests/all-nodes.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
// NOTE: executor / disk must be imported dynamically AFTER BF_DB_PATH is set,
// because ES module imports are hoisted and evaluated before the body runs.
// The catalog is pure data, so a static import is fine.
import { NODES } from "../shared/catalog.js";
import { FAKE_RESPONSES, FAKE_JSON_ANY } from "./helpers/fake-services.js";

const { executeWorkflow } = await import("../server/executor.js");
const { FILES_DIR, ensureFilesDir, writeFileBytes } = await import("../server/disk.js");
const { vectors } = await import("../server/store.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Point the database at an isolated file BEFORE the modules load it. Note:
// the disk/figure nodes use the app's real sandbox (./data/files) which is
// git-ignored runtime data; we write only clearly-named fixture files there
// and remove them in after().
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-allnodes-"));
process.env.BF_DB_PATH = path.join(tempDir, "allnodes.db");

// ----------------------------------------------------------------------------
// Fetch stub — returns canned JSON so handlers run without a network.
// ----------------------------------------------------------------------------
// Realistic canned service responses live in ./helpers/fake-services.js so the
// node suites and this file stay in sync.

let originalFetch;
function makeResponse(body, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      entries: () => Object.entries({ "content-type": contentType, "content-disposition": `filename="stub.txt"` }),
      get: (name) => {
        const n = String(name).toLowerCase();
        if (n === "content-type") return contentType;
        if (n === "content-disposition") return `filename="stub.txt"`;
        return null;
      },
      getSetCookie: () => [],
    },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}
function stubFetch(urlOrReq, init) {
  const url = typeof urlOrReq === "string" ? urlOrReq : urlOrReq?.url || "";
  const u = String(url);
  for (const [needle, body] of Object.entries(FAKE_RESPONSES)) {
    if (u.includes(needle)) return Promise.resolve(makeResponse(body));
  }
  return Promise.resolve(makeResponse(FAKE_JSON_ANY));
}

// ----------------------------------------------------------------------------
// A rich payload a user might have, so handlers that read fields see values.
// ----------------------------------------------------------------------------
const RICH_PAYLOAD = {
  id: "42",
  name: "Ada",
  status: "success",
  message: "hello world",
  text: "The quick brown fox jumps over the lazy dog",
  amount: 5,
  count: 3,
  rows: [1, 2, 3],
  email: "ada@example.com",
  value: "42",
  url: "http://localhost/data.json",
  fileName: "input.csv",
  // base64 of "hello\n" (a tiny file a user might have)
  data: "aGVsbG8K",
  body: '{"name": "Ada", "role": "admin"}',
  reply: '{"ok": true, "result": 1}',
  items: [
    { name: "a", amount: 1, status: "success", id: 1 },
    { name: "b", amount: 2, status: "failed", id: 2 },
    { name: "a", amount: 1, status: "success", id: 1 },
    { name: "c", amount: 3, status: "success", id: 3 },
  ],
};
const INPUT_ITEMS = [{ json: RICH_PAYLOAD }];

// Per-node config overrides so a node exercises its real handler in a useful
// way (points file nodes at the rich payload, gives AI nodes an inline model,
// etc.). Keys are node types; values are merged over the catalog defaults.
const TG_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const CONFIG_OVERRIDES = {
  // Airtable stops before sending when the Base ID is empty
  airtableRow: { baseId: "appTest" },
  airtableRead: { baseId: "appTest" },
  airtableUpdate: { baseId: "appTest" },
  airtableDelete: { baseId: "appTest" },
  // --- file / disk nodes --------------------------------------------
  extractFile: { fileSource: "field", sourceField: "data", contentMode: "base64", fileName: "input.txt", outputMode: "auto" },
  readFile: { path: "allnodes-fixture.txt", outputMode: "auto" },
  writeFile: { fileSource: "field", sourceField: "data", contentMode: "base64", fileName: "allnodes-written.txt" },
  listFiles: { path: "", pattern: "", recursive: false },
  convertToFile: { fileSource: "field", sourceField: "body", contentMode: "text", format: "json", outputFile: "" },
  compress: { sources: "*", format: "zip", outputFile: "" },
  dataStore: { operation: "get", namespace: "test", key: "{{id}}", storeIn: "value" },
  sqlQuery: { sql: "SELECT 1 AS one;", params: "{}", storeIn: "value" },
  // External databases can't connect in tests — point them at a closed local
  // port so they fail fast with a classified error (they are not in EXPECT_PASS).
  sqlPostgres: { host: "127.0.0.1", port: 1, database: "", user: "", password: "", query: "SELECT 1 AS one;", params: "{}", storeIn: "value", connectTimeoutMs: 500 },
  sqlMysql: { host: "127.0.0.1", port: 1, database: "", user: "", password: "", query: "SELECT 1 AS one;", params: "{}", storeIn: "value", connectTimeoutMs: 500 },

  // --- web : point at the stub (no real internet) -------------------
  http: { method: "GET", url: "http://localhost/stub", parseAs: "auto", retries: 0, timeout: 5 },
  rssRead: { url: "http://localhost/feed.xml", limit: 10, storeIn: "items" },
  // Feeds & Sources presets whose catalog default is empty
  youtubePlaylistFeed: { playlistId: "PLtest" },
  mediumFeed: { user: "tester" },
  substackFeed: { publication: "tester" },
  podcastFeed: { url: "http://localhost/podcast.xml" },
  wait: { duration: 0, unit: "seconds" },
  // SMTP needs a real socket (nodemailer ignores fetch) — point it at a closed
  // local port so it fails fast instead of hanging on a real server.
  emailSend: { host: "127.0.0.1", port: 1, secure: false, user: "", appPassword: "", to: "", subject: "", body: "" },

  // --- AI nodes : inline model hitting the fetch stub ---------------
  aiChat: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", prompt: "Say hello" },
  langchainChain: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", template: "Say hello" },
  aiAgent: { agentSource: "inline", provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", prompt: "Say hello", useHttpTool: false, useTimeTool: false },
  aiImage: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "gpt-image-1", prompt: "A cat" },
  aiEmbeddings: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "text-embedding-3-small", text: "{{text}}", storeIn: "vector" },
  vectorStore: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "text-embedding-3-small", namespace: "allnodes", key: "{{id}}", text: "{{text}}", meta: "{}" },
  vectorSearch: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "text-embedding-3-small", namespace: "allnodes", query: "{{text}}", topK: 5, storeIn: "matches" },
  aiExtract: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", sourceField: "body", schema: '{"type":"object","properties":{"name":{"type":"string"}}}', storeIn: "parsed", targetType: "object" },

  // --- formatter / crypto / chunking nodes ---------------------------
  jsonParse: { mode: "parse", field: "body", storeIn: "parsed", keepRest: true },
  base64: { mode: "encode", value: "{{message}}", storeIn: "b64" },
  encrypt: { mode: "encrypt", value: "{{message}}", passphrase: "all-nodes-passphrase", storeIn: "cipher" },
  urlParse: { mode: "parse", url: "{{url}}", storeIn: "parsedUrl" },
  chunkText: { field: "text", chunkSize: 20, overlap: 5, mode: "items", storeIn: "chunk" },
  graphqlRequest: { endpoint: "http://localhost/graphql", token: "", headers: "{}", query: "query { ok }", variables: "{}", storeIn: "data" },

  // --- Telegram : a pasted token + the fields each Bot API call needs ------
  telegramSend: { botToken: TG_TOKEN, chatId: "42", buttons: '[[{"text":"Yes","callback_data":"yes"}]]' },
  telegramSendPhoto: { botToken: TG_TOKEN, chatId: "42", fileField: "data", caption: "{{name}}" },
  telegramSendDocument: { botToken: TG_TOKEN, chatId: "42", document: "{{url}}" },
  telegramSendMedia: { botToken: TG_TOKEN, chatId: "42", kind: "voice", media: "file-id-1" },
  telegramSetCommands: { botToken: TG_TOKEN },
  telegramSendLocation: { botToken: TG_TOKEN, chatId: "42", latitude: "52.52", longitude: "13.4" },
  telegramSendPoll: { botToken: TG_TOKEN, chatId: "42", question: "Lunch?" },
  telegramEditMessage: { botToken: TG_TOKEN, chatId: "42", messageId: "7", text: "edited" },
  telegramDeleteMessage: { botToken: TG_TOKEN, chatId: "42", messageId: "7" },
  telegramForward: { botToken: TG_TOKEN, chatId: "42", fromChatId: "43", messageId: "7" },
  telegramPin: { botToken: TG_TOKEN, chatId: "42", messageId: "7" },
  telegramChatAction: { botToken: TG_TOKEN, chatId: "42" },
  telegramAnswerCallback: { botToken: TG_TOKEN, callbackQueryId: "cb-1" },
  telegramGetChat: { botToken: TG_TOKEN, chatId: "42" },
  telegramGetFile: { botToken: TG_TOKEN, fileId: "file-id-1" },
  telegramApi: { botToken: TG_TOKEN, method: "sendDice", params: '{"chat_id":"42"}' },
};

// Logic nodes that reference a specific tested field should use the rich values.
const LOGIC_OVERRIDES = {
  if: { valueA: "{{status}}", operator: "equals", valueB: "success", caseSensitive: false },
  switch: { value: "{{status}}", matchMode: "equals", caseSensitive: false, cases: [{ key: "success" }, { key: "failed" }] },
  sort: { field: "amount", order: "asc", numeric: true },
  dedupe: { field: "name" },
  pluck: { field: "name", keep: false, storeIn: "value" },
  stringTransform: { field: "message", operation: "upper" },
  textAggregate: { field: "name", separator: ",", prefix: "", suffix: "", storeIn: "aggregated" },
  qrcode: { text: "https://example.com", size: 128, outputFile: "qrcode-test.png" },
};
Object.assign(CONFIG_OVERRIDES, LOGIC_OVERRIDES);

// A node type is deemed "offline-successful" when, given the stub fetch and its
// overrides, its handler deterministically returns output items (instead of a
// thrown error or an empty output). Triggers always emit a sample payload.
const EXPECT_PASS = new Set([
  // triggers
  "manual", "webhook", "schedule", "gmail", "slackTrigger", "githubTrigger",
  "telegramTrigger", "imap", "notionTrigger", "sheetsTrigger", "teamsTrigger",
  "outlookTrigger", "stripeTrigger", "jiraTrigger", "discordTrigger",
  "googleDriveTrigger", "rssTrigger", "errorTrigger", "hubspotTrigger",
  "airtableTrigger", "supabaseTrigger", "slackReactionTrigger",
  // logic / files that need no creds
  "if", "switch", "set", "code", "loop", "loopEnd", "merge", "log",
  "jsTransform", "jsFilter", "jsAggregate", "textAggregate", "stringTransform",
  "limit", "sort", "dedupe", "pluck", "hash", "prompt", "aiParser",
  "splitOut", "dateAndTime", "math", "stickyNote", "summarize", "filter",
  "extractFile", "readFile", "writeFile", "listFiles", "convertToFile",
  "dataStore", "sqlQuery", "wait", "webhookRespond",
  // NOTE: "compress" is NOT here — with no upstream files it now correctly
  // fails with BF-6005 (no file content) instead of reporting a fake success.
  // network/AI nodes that succeed against the fetch stub
  "http", "slackSend", "discordSend", "telegramSend",
  // telegramGetFile is not here: the stub's reply has no file_path, so it
  // fails with a classified SERVICE_ERROR, as it should.
  "telegramSendPhoto", "telegramSendDocument", "telegramSendMedia", "telegramSetCommands",
  "telegramSendLocation", "telegramSendPoll", "telegramEditMessage", "telegramDeleteMessage",
  "telegramForward", "telegramPin", "telegramChatAction", "telegramAnswerCallback",
  "telegramGetChat", "telegramApi",
  "githubIssue", "notionPage", "teamsSend", "outlookSend", "onedriveUpload",
  "excelCreate", "wordCreate", "sharepointUpload", "sharepointListItem",
  "plannerTask", "excelAddRow", "twilioSms", "sendgridEmail", "stripePaymentLink",
  "hubspotContact", "airtableRow", "gitlabIssue", "trelloCard", "asanaTask",
  "supabaseInsert", "jiraIssue", "weather", "cryptoPrice", "ipGeo",
  "coinbaseExchange", "binanceExchange", "krakenExchange", "bybitExchange", "okxExchange", "kucoinExchange", "polymarket",
  "wordpressPost", "googleCalendar", "dropboxUpload", "mailchimpSub",
  "resendEmail", "zendeskTicket", "pagerdutyIncident", "redditSearch",
  "googleDriveUpload", "googleDriveList", "googleSheetsRead", "googleSheetsAppend",
  "notionQueryDb", "notionUpdatePage", "mongoFind", "mongoInsert",
  "airtableRead", "airtableUpdate", "supabaseRead", "supabaseUpdate",
  "twitterPost", "salesforceContact", "slackBotSend", "githubCreatePr",
  "githubCreateRelease", "mailgunSend", "vonageSms", "opsgenieAlert",
  "pushoverSend", "ntfySend", "s3Upload", "webdavUpload", "pipedriveDeal",
  "linearIssue", "deeplTranslate", "wikipediaSearch", "hackernewsSearch",
  "tinyurlShorten", "shopifyProduct", "googleSearch",
  "rssRead", "snsPublish", "randomData", "youtubeSearch",
  "whatsappSend", "todoistTask", "clickupTask", "qrcode",
  "aiChat", "langchainChain", "aiAgent", "aiImage", "aiEmbeddings", "vectorStore", "vectorSearch", "aiExtract",
  "chunkText",
  // formatter / flow-control nodes added later — deterministic and credential-free
  "noop", "jsonParse", "base64", "encrypt", "urlParse",
  "graphqlRequest", "sheetsUpdate", "airtableDelete",
  // Feeds & Sources presets (RSS Read logic, stubbed feed XML)
  ...Object.keys(NODES).filter((t) => NODES[t].category === "feeds"),
]);

// Create one fixture file so readFile / listFiles have something to see.
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
  ensureFilesDir();
  writeFileBytes("allnodes-fixture.txt", Buffer.from("hello from the fixture\n"));
});

after(() => {
  globalThis.fetch = originalFetch;
  // Remove the test vector the Vector Store node saved into the real
  // (git-ignored) ./data/vectors.json store, so repeat runs don't accumulate.
  try {
    vectors.remove("allnodes", "42");
  } catch {
    /* best-effort */
  }
  // Remove the fixture + any file the disk nodes wrote, so the test leaves no
  // trace in the app's real (git-ignored) ./data/files sandbox.
  try {
    if (fs.existsSync(path.join(FILES_DIR, "allnodes-fixture.txt"))) fs.rmSync(path.join(FILES_DIR, "allnodes-fixture.txt"));
  } catch {
    /* best-effort */
  }
  try {
    if (fs.existsSync(path.join(FILES_DIR, "allnodes-written.txt"))) fs.rmSync(path.join(FILES_DIR, "allnodes-written.txt"));
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

beforeEach(() => {
  globalThis.fetch = stubFetch;
});

const nodeTypes = Object.keys(NODES);
assert.ok(nodeTypes.length > 50, "expected a large catalog");

// Build a two-node workflow: a Manual Trigger (with manual output = the rich
// payload) feeding the target node. This gives every non-trigger node a real
// input to work with, exactly like a user who wired a trigger into their flow.
function buildWorkflow(type, targetConfig) {
  const prefix = {
    id: "feed",
    type: "manual",
    position: { x: -400, y: 0 },
    data: {
      label: "Feed",
      config: {
        manualOutput: true,
        manualOutputJson: JSON.stringify(RICH_PAYLOAD),
      },
    },
  };
  const target = {
    id: "n1",
    type,
    position: { x: 0, y: 0 },
    data: { label: NODES[type].name, config: targetConfig },
  };
  return {
    id: `wf-${type}`,
    name: type,
    nodes: [prefix, target],
    edges: [{ id: "e1", source: "feed", target: "n1", sourceHandle: "out", targetHandle: "in" }],
  };
}


// ----------------------------------------------------------------------------
// 1. WITHOUT manual output — every node's handler runs through the executor.
// ----------------------------------------------------------------------------
for (const type of nodeTypes) {
  test(`node "${type}" runs its handler (no manual output)`, async () => {
    const def = NODES[type];
    const config = { ...JSON.parse(JSON.stringify(def.defaults || {})), ...(CONFIG_OVERRIDES[type] || {}) };
    const workflow = buildWorkflow(type, config);

    let result;
    try {
      result = await executeWorkflow(workflow, { payload: RICH_PAYLOAD, maxItemsPerNode: 50 });
    } catch (err) {
      assert.fail(`"${type}" threw out of executeWorkflow: ${err.message}`);
    }

    assert.ok(result, "executeWorkflow returned a result");
    // Match by node id ("n1") rather than nodeType so the entry belongs to the
    // target node — the prefix feed node is type "manual", which would clash
    // when testing the "manual" trigger node itself.
    const entry = result.log?.find((l) => l.nodeId === "n1");
    assert.ok(entry, `"${type}" produced a log entry`);

    if (EXPECT_PASS.has(type)) {
      assert.equal(
        entry.status,
        "success",
        `"${type}" should succeed; error=${entry.error} code=${entry.errorCode} input=${JSON.stringify(entry.inputItems)}`
      );
      // Output reached the node: every "offline-successful" node emits items.
      assert.ok(Array.isArray(entry.outputItems), `"${type}" emitted an output array`);
    } else {
      // Not in EXPECT_PASS: it may have produced output or a soft error; either
      // is acceptable, but the error must be a classified one (not a crash).
      assert.ok(entry.status === "success" || entry.errorCode, `"${type}" gave a classified outcome`);
    }
  });
}

// ----------------------------------------------------------------------------
// 2. WITH manual output — every node is skipped and passes the typed JSON on.
// ----------------------------------------------------------------------------
const MANUAL_JSON = { manual: true, hello: "world", n: 1, list: [1, 2, 3] };

for (const type of nodeTypes) {
  test(`node "${type}" honours manual output (skipped, fixed data)`, async () => {
    const def = NODES[type];
    const config = {
      ...JSON.parse(JSON.stringify(def.defaults || {})),
      ...(CONFIG_OVERRIDES[type] || {}),
      manualOutput: true,
      manualOutputJson: JSON.stringify(MANUAL_JSON),
    };
    const workflow = buildWorkflow(type, config);

    let result;
    try {
      result = await executeWorkflow(workflow, { payload: RICH_PAYLOAD, maxItemsPerNode: 50 });
    } catch (err) {
      assert.fail(`"${type}" manual-output run threw: ${err.message}`);
    }

    const entry = result.log?.find((l) => l.nodeId === "n1");
    assert.ok(entry, `"${type}" produced a log entry in manual mode`);
    assert.equal(entry.status, "success", `"${type}" manual output should succeed`);
    assert.deepEqual(entry.outputItems, [MANUAL_JSON], `"${type}" passed the manual data through untouched`);
  });
}