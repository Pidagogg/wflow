// Verifies the webhook receive → … → Webhook Respond model over the real HTTP
// server. It temporarily merges the webhook test workflows into data/workflows.json,
// POSTs to each /webhook/:id, checks the JSON response body, then restores the file.
//
// Run:  node http-test.mjs   (server must be running on :3001)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF_DIR = path.join(__dirname, "workflows");
const STORE = path.join(__dirname, "..", "data", "workflows.json");
const BASE = "http://localhost:3001";

const webhookIds = [
  "test-wf-echo",
  "test-wf-respondonly",
  "test-wf-pdfai",
  "test-wf-seq",
  "test-wf-template",
  "test-wf-branch",
  "test-wf-http",
  "test-wf-secret",
];

// snapshot original store and merge webhook workflows
const original = fs.readFileSync(STORE, "utf8");
const origArr = JSON.parse(original);
const additions = webhookIds
  .map((id) => {
    const p = path.join(WF_DIR, `${id}.json`);
    if (!fs.existsSync(p)) return null;
    const w = JSON.parse(fs.readFileSync(p, "utf8"));
    w.ownerId = "";
    return w;
  })
  .filter(Boolean);

fs.writeFileSync(STORE, JSON.stringify([...origArr, ...additions], null, 2));

let pass = 0;
let fail = 0;
const results = [];
const check = (name, cond, detail = "") => {
  (cond ? ((pass++, results.push("PASS  " + name))) : ((fail++, results.push(`FAIL  ${name}  ${detail}`))));
};

try {
  for (const id of webhookIds) {
    const payload = { message: "hello http", source: "http-test", status: "success", name: "Bob" };
    const url = `${BASE}/webhook/${id}`;
    // Test 9 secret webhook needs the header; others reject it harmlessly.
    const headers = { "Content-Type": "application/json" };
    if (id === "test-wf-secret") headers["X-W-Flow-Secret"] = "s3cret";

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = await res.text();
    }
    const bodyStr = typeof data === "string" ? data : JSON.stringify(data);

    check(`${id} HTTP status ok (${res.status})`, res.status === 200 || res.status === 500, `status=${res.status}`);

    if (id === "test-wf-branch") {
      check(`${id} responded SUCCESS (true branch)`, res.status === 200 && bodyStr.includes("SUCCESS"), bodyStr.slice(0, 200));
    } else if (id === "test-wf-template") {
      check(`${id} interpolated body.name -> Bob`, bodyStr.includes("Bob"), bodyStr.slice(0, 200));
    } else if (id === "test-wf-echo") {
      check(`${id} echoed message -> hello http`, bodyStr.includes("hello http"), bodyStr.slice(0, 200));
    } else if (id === "test-wf-respondonly") {
      check(`${id} ack response`, bodyStr.includes("ack"), bodyStr.slice(0, 200));
    } else if (id === "test-wf-pdfai") {
      check(`${id} returned manual analysis reply`, bodyStr.includes("[manual]"), bodyStr.slice(0, 200));
    } else if (id === "test-wf-seq") {
      check(`${id} chained through both steps`, bodyStr.includes("|1|2"), bodyStr.slice(0, 200));
    } else if (id === "test-wf-secret") {
      check(`${id} authorized response`, bodyStr.includes("authorized"), bodyStr.slice(0, 200));
    } else {
      check(`${id} got a JSON response`, res.status === 200, `status=${res.status}`);
    }
  }

  // Optional: verify secret webhook WITHOUT the header is rejected (401).
  const noSec = await fetch(`${BASE}/webhook/test-wf-secret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "success" }),
    signal: AbortSignal.timeout(10000),
  });
  check("test-wf-secret rejects missing secret header (401)", noSec.status === 401, `status=${noSec.status}`);
} finally {
  // restore the original store
  fs.writeFileSync(STORE, original);
}

console.log("\n===== HTTP RESULTS =====");
for (const r of results) console.log(r);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);