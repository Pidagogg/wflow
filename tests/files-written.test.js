// ============================================================================
// Log transparency — the execution log must say which files a node produced:
//   - \"Save output as file\" (outputFile config) on any node
//   - the Write File node (writes into the ./data/files sandbox)
// Both surface as entry.filesWritten, which the Log console renders.
// ============================================================================
import assert from "node:assert/strict";
import { test, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.BF_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-files-")), "files.db");
const { executeWorkflow } = await import("../server/executor.js");
const { FILES_DIR } = await import("../server/disk.js");

// stub fetch so the HTTP node runs offline
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { entries: () => [], get: () => null, getSetCookie: () => [] },
  json: async () => ({ data: { ok: true } }),
  text: async () => JSON.stringify({ data: { ok: true } }),
  arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
});

after(() => {
  globalThis.fetch = originalFetch;
  try {
    if (fs.existsSync(path.join(FILES_DIR, "transparency-test.txt"))) fs.rmSync(path.join(FILES_DIR, "transparency-test.txt"));
  } catch {
    /* best-effort */
  }
});

function buildWorkflow(target) {
  return {
    id: "wf-files",
    name: "files",
    nodes: [
      {
        id: "feed",
        type: "manual",
        position: { x: -400, y: 0 },
        data: { label: "Feed", config: { manualOutput: true, manualOutputJson: JSON.stringify({ message: "hello", text: "hello world" }) } },
      },
      target,
    ],
    edges: [{ id: "e1", source: "feed", target: "n1", sourceHandle: "out", targetHandle: "in" }],
  };
}

test('"Save output as file" surfaces the file name in the run log', async () => {
  const workflow = buildWorkflow({
    id: "n1",
    type: "http",
    position: { x: 0, y: 0 },
    data: { label: "Fetch", config: { method: "GET", url: "https://example.com/x", outputFile: "report.json" } },
  });
  const res = await executeWorkflow(workflow, { maxItemsPerNode: 50 });
  const entry = res.log.find((l) => l.nodeId === "n1");
  assert.equal(entry.status, "success");
  assert.ok(Array.isArray(entry.filesWritten), "entry.filesWritten is present");
  assert.equal(entry.filesWritten[0].name, "report.json");
  assert.ok(entry.filesWritten[0].size > 0);
  // the summary is also visible in the node's output items
  assert.equal(entry.outputItems[0].filesWritten[0].name, "report.json");
});

test("Write File node surfaces the sandbox file name and path in the run log", async () => {
  const workflow = buildWorkflow({
    id: "n1",
    type: "writeFile",
    position: { x: 0, y: 0 },
    data: { label: "Save", config: { fileName: "transparency-test.txt", contentMode: "text", sourceField: "text" } },
  });
  const res = await executeWorkflow(workflow, { maxItemsPerNode: 50 });
  const entry = res.log.find((l) => l.nodeId === "n1");
  assert.equal(entry.status, "success");
  assert.ok(Array.isArray(entry.filesWritten), "entry.filesWritten is present");
  const f = entry.filesWritten.find((x) => x.name === "transparency-test.txt");
  assert.ok(f, "the written file name appears in the log");
  assert.ok(f.path, "the sandbox path appears in the log");
});

test("a node skipped via Manual output registers no files", async () => {
  const workflow = buildWorkflow({
    id: "n1",
    type: "http",
    position: { x: 0, y: 0 },
    data: {
      label: "Fetch",
      config: { method: "GET", url: "https://example.com/x", outputFile: "report.json", manualOutput: true, manualOutputJson: JSON.stringify({ fixed: true }) },
    },
  });
  const res = await executeWorkflow(workflow, { maxItemsPerNode: 50 });
  const entry = res.log.find((l) => l.nodeId === "n1");
  assert.equal(entry.status, "success");
  assert.deepEqual(entry.outputItems, [{ fixed: true }], "manual data flows through untouched");
  assert.ok(!entry.filesWritten || entry.filesWritten.length === 0, "no files registered for a skipped node");
});
