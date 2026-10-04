// ============================================================================
// Shared node-test harness.
//
// Extracted so every node test file (schema, depth, service auth, …) exercises
// nodes through the SAME real executor, the SAME offline fetch stub and the
// SAME per-node config overrides. Importing this module sets BF_DB_PATH before
// server modules load, so tests never touch the developer's real database.
//
// Usage (in a test file):
//   import { executeWorkflow, buildWorkflow, configFor, richPayload } from
//     "./helpers/node-harness.js";
// ============================================================================
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { NODES } from "../../shared/catalog.js";
import { FAKE_RESPONSES, FAKE_JSON_ANY } from "./fake-services.js";

// Point the database at an isolated file BEFORE the server modules load it.
// The disk nodes still use the app's real sandbox (./data/files, git-ignored);
// tests write only clearly-named fixtures there and remove them afterwards.
export const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-nodes-"));
if (!process.env.BF_DB_PATH) process.env.BF_DB_PATH = path.join(tempDir, "nodes.db");

export const { executeWorkflow, executeNode } = await import("../../server/executor.js");
export const { FILES_DIR, ensureFilesDir, writeFileBytes, filesRoot } = await import("../../server/disk.js");
export const { vectors } = await import("../../server/store.js");

// ----------------------------------------------------------------------------
// Offline fetch stub. Canned JSON for known endpoints, a generic 200 for the
// rest — service handlers still build their real request and parse the reply.
// Requests are captured so auth/URL tests can assert what was sent.
// ----------------------------------------------------------------------------
export { FAKE_RESPONSES };

export const capturedRequests = [];
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

export function stubFetch(urlOrReq, init) {
  const url = typeof urlOrReq === "string" ? urlOrReq : urlOrReq?.url || "";
  const u = String(url);
  capturedRequests.push({ url: u, init });
  for (const [needle, body] of Object.entries(FAKE_RESPONSES)) {
    if (u.includes(needle)) return Promise.resolve(makeResponse(body));
  }
  return Promise.resolve(makeResponse(FAKE_JSON_ANY));
}

export function installFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
  capturedRequests.length = 0;
}
export function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ----------------------------------------------------------------------------
// Rich payload a user might have, so handlers that read fields see values.
// ----------------------------------------------------------------------------
export const RICH_PAYLOAD = {
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
  data: "aGVsbG8K", // base64 of "hello\n"
  body: '{"name": "Ada", "role": "admin"}',
  reply: '{"ok": true, "result": 1}',
  items: [
    { name: "a", amount: 1, status: "success", id: 1 },
    { name: "b", amount: 2, status: "failed", id: 2 },
    { name: "a", amount: 1, status: "success", id: 1 },
    { name: "c", amount: 3, status: "success", id: 3 },
  ],
};

export const buildWorkflow = (type, targetConfig, payload = RICH_PAYLOAD) => ({
  id: `wf-${type}`,
  name: type,
  nodes: [
    {
      id: "feed",
      type: "manual",
      position: { x: -400, y: 0 },
      data: { label: "Feed", config: { manualOutput: true, manualOutputJson: JSON.stringify(payload) } },
    },
    { id: "n1", type, position: { x: 0, y: 0 }, data: { label: NODES[type]?.name || type, config: targetConfig } },
  ],
  edges: [{ id: "e1", source: "feed", target: "n1", sourceHandle: "out", targetHandle: "in" }],
});

// Per-node config overrides so a node exercises its real handler offline.
// (Identical intent to tests/all-nodes.test.js — keep the two in sync.)
export const CONFIG_OVERRIDES = {
  extractFile: { fileSource: "field", sourceField: "data", contentMode: "base64", fileName: "input.txt", outputMode: "auto" },
  readFile: { path: "allnodes-fixture.txt", outputMode: "auto" },
  writeFile: { fileSource: "field", sourceField: "data", contentMode: "base64", fileName: "allnodes-written.txt" },
  listFiles: { path: "", pattern: "", recursive: false },
  convertToFile: { fileSource: "field", sourceField: "body", contentMode: "text", format: "json", outputFile: "" },
  compress: { sources: "*", format: "zip", outputFile: "" },
  dataStore: { operation: "get", namespace: "test", key: "{{id}}", storeIn: "value" },
  sqlQuery: { sql: "SELECT 1 AS one;", params: "{}", storeIn: "value" },
  sqlPostgres: { host: "127.0.0.1", port: 1, database: "", user: "", password: "", query: "SELECT 1 AS one;", params: "{}", storeIn: "value", connectTimeoutMs: 500 },
  sqlMysql: { host: "127.0.0.1", port: 1, database: "", user: "", password: "", query: "SELECT 1 AS one;", params: "{}", storeIn: "value", connectTimeoutMs: 500 },
  airtableRow: { baseId: "appTest" },
  airtableRead: { baseId: "appTest" },
  airtableUpdate: { baseId: "appTest" },
  airtableDelete: { baseId: "appTest" },
  http: { method: "GET", url: "http://localhost/stub", parseAs: "auto", retries: 0, timeout: 5 },
  rssRead: { url: "http://localhost/feed.xml", limit: 10, storeIn: "items" },
  // Feeds & Sources presets whose catalog default is empty
  youtubePlaylistFeed: { playlistId: "PLtest" },
  mediumFeed: { user: "tester" },
  substackFeed: { publication: "tester" },
  podcastFeed: { url: "http://localhost/podcast.xml" },
  wait: { duration: 0, unit: "seconds" },
  emailSend: { host: "127.0.0.1", port: 1, secure: false, user: "", appPassword: "", to: "", subject: "", body: "" },
  aiChat: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", prompt: "Say hello" },
  langchainChain: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", template: "Say hello" },
  aiAgent: { agentSource: "inline", provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", prompt: "Say hello", useHttpTool: false, useTimeTool: false },
  aiImage: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "gpt-image-1", prompt: "A cat" },
  aiEmbeddings: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "text-embedding-3-small", text: "{{text}}", storeIn: "vector" },
  vectorStore: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "text-embedding-3-small", namespace: "allnodes", key: "{{id}}", text: "{{text}}", meta: "{}" },
  vectorSearch: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "text-embedding-3-small", namespace: "allnodes", query: "{{text}}", topK: 5, storeIn: "matches" },
  aiExtract: { provider: "openai", baseUrl: "http://localhost/v1", apiKey: "sk-test", model: "stub-model", sourceField: "body", schema: '{"type":"object","properties":{"name":{"type":"string"}}}', storeIn: "parsed", targetType: "object" },
  jsonParse: { mode: "parse", field: "body", storeIn: "parsed", keepRest: true },
  base64: { mode: "encode", value: "{{message}}", storeIn: "b64" },
  encrypt: { mode: "encrypt", value: "{{message}}", passphrase: "all-nodes-passphrase", storeIn: "cipher" },
  urlParse: { mode: "parse", url: "{{url}}", storeIn: "parsedUrl" },
  chunkText: { field: "text", chunkSize: 20, overlap: 5, mode: "items", storeIn: "chunk" },
  graphqlRequest: { endpoint: "http://localhost/graphql", token: "", headers: "{}", query: "query { ok }", variables: "{}", storeIn: "data" },
  if: { valueA: "{{status}}", operator: "equals", valueB: "success", caseSensitive: false },
  switch: { value: "{{status}}", matchMode: "equals", caseSensitive: false, cases: [{ key: "success" }, { key: "failed" }] },
  sort: { field: "amount", order: "asc", numeric: true },
  dedupe: { field: "name" },
  pluck: { field: "name", keep: false, storeIn: "value" },
  stringTransform: { field: "message", operation: "upper" },
  textAggregate: { field: "name", separator: ",", prefix: "", suffix: "", storeIn: "aggregated" },
  qrcode: { text: "https://example.com", size: 128, outputFile: "qrcode-test.png" },
};

export const deepClone = (v) => JSON.parse(JSON.stringify(v));

// Build the config a depth test should use: catalog defaults, then the offline
// overrides, then whatever the individual test asked for.
export function configFor(type, extra = {}) {
  const def = NODES[type] || {};
  return { ...deepClone(def.defaults || {}), ...(CONFIG_OVERRIDES[type] || {}), ...extra };
}

// Create the disk fixture the file nodes expect. Safe to call repeatedly.
export function ensureFixtures() {
  ensureFilesDir();
  writeFileBytes("allnodes-fixture.txt", Buffer.from("hello from the fixture\n"));
}

export function cleanupFixtures() {
  try {
    vectors.remove("allnodes", "42");
  } catch {
    /* best-effort */
  }
  for (const f of ["allnodes-fixture.txt", "allnodes-written.txt", "qrcode-test.png"]) {
    try {
      const p = path.join(FILES_DIR, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    } catch {
      /* best-effort */
    }
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export { NODES };
export const richPayload = RICH_PAYLOAD;
export const nodeTypes = Object.keys(NODES);
