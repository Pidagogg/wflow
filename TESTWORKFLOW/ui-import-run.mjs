// Imports the 10 TESTWORKFLOW workflows into the builder and runs each one,
// using the SAME endpoints the UI uses:
//   - Import  = POST /api/workflows          (WorkflowsPage import handler)
//   - Run     = POST /api/workflows/:id/run  (Run button)
//   - Webhook = POST /webhook/:id            (Webhook trigger receives)
// The test workflows are registered under a dedicated test account so your real
// account and data/workflows.json stay untouched.
//
// Run:  node ui-import-run.mjs   (server must be running on :3001)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WF_DIR = path.join(__dirname, "workflows");
const BASE = "http://localhost:3001";

const EMAIL = "test.workflows@localhost.test";
const PASSWORD = "testtest1234";

let cookie = "";
const headers = (extra = {}) => ({ "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extra });

async function j(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- register / login to get a session cookie --------------------------------
{
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Test Workflows" }),
  });
  if (res.status === 409) {
    const res2 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    cookie = res2.headers.get("set-cookie") || "";
  } else {
    cookie = res.headers.get("set-cookie") || "";
  }
  if (!cookie) {
    console.error("FATAL: could not authenticate test user. status check done.");
    process.exit(1);
  }
  // keep only the bf_user=... part
  cookie = cookie.split(";")[0];
  console.log("authenticated as test account:", cookie.split("=")[1]?.slice(0, 12) + "…");
}

// --- import each workflow -----------------------------------------------------
const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".json"));
const imported = [];

for (const f of files) {
  const w = JSON.parse(fs.readFileSync(path.join(WF_DIR, f), "utf8"));
  // exactly what the UI Import handler sends
  const body = { name: w.name, description: w.description, nodes: w.nodes, edges: w.edges || [] };
  const res = await fetch(`${BASE}/api/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const created = await j(res);
  if (res.status !== 200) {
    console.log(`IMPORT FAIL ${f}:`, JSON.stringify(created).slice(0, 160));
    continue;
  }
  imported.push({ file: f, ...created });
  console.log(`IMPORTED ${f} -> ${created.id} (${created.nodes.length} nodes)`);
}

// --- run each the way the UI does --------------------------------------------
const hasWebhook = (w) => w.nodes.some((n) => n.type === "webhook");
const hasManual = (w) => w.nodes.some((n) => n.type === "manual");

let pass = 0;
let fail = 0;
const detail = [];

for (const w of imported) {
  try {
    if (hasWebhook(w)) {
      const payload = { message: "from ui", source: "ui", status: "success", name: "Ada" };
      const res = await fetch(`${BASE}/webhook/${w.id}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      const body = await j(res);
      const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      // In the new model the webhook responds from the Webhook Respond node, so a
      // 200 + a non-error body means the Respond node ran and replied. A 500 or an
      // "error" field means the chain failed before reaching Respond.
      const isErr = res.status !== 200 || /\\"error\\"/i.test(bodyStr) || /\[manual\]/.test(bodyStr) === false && bodyStr.includes("errorCount");
      const ok = !isErr;
      detail.push(`${ok ? "PASS" : "FAIL"} ${w.file}: webhook -> HTTP ${res.status} :: ${bodyStr.slice(0, 120)}`);
      ok ? pass++ : fail++;
      continue;
    }
    if (hasManual(w)) {
      const res = await fetch(`${BASE}/api/workflows/${w.id}/run`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30000),
      });
      const result = await j(res);
      const ok = res.status === 200 && result.success;
      detail.push(`${ok ? "PASS" : "FAIL"} ${w.file}: run -> success=${!!result.success} errorCount=${result.errorCount} :: ${JSON.stringify((result.log || []).filter((l) => l.status === "error").map((l) => l.error)).slice(0, 120)}`);
      ok ? pass++ : fail++;
      continue;
    }
    detail.push(`SKIP ${w.file}: no trigger`);
  } catch (err) {
    fail++;
    detail.push(`FAIL ${w.file}: ${err.message}`);
  }
}

console.log("\n===== UI IMPORT+RUN RESULTS =====");
for (const d of detail) console.log(d);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);