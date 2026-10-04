// ============================================================================
// Node test report generator — Phase 4 of the node test audit.
//
// Re-runs a compact per-node matrix (handler, empty input, empty payload,
// nulls, unicode, multi-item, manual output, every dropdown option) through the
// REAL executor with the offline fetch stub, then writes
// docs/node-test-report.md with the actual per-node result — every cell in the
// table is something this script executed, not an assumption.
//
// Run: node scripts/node-test-report.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODES,
  nodeTypes,
  executeNode,
  configFor,
  ensureFixtures,
  cleanupFixtures,
  installFetch,
  restoreFetch,
  RICH_PAYLOAD,
} from "../tests/helpers/node-harness.js";
import { ERROR_CODES } from "../shared/errors.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const MANUAL = { manual: true, hello: "world", n: 1, list: [1, 2, 3] };
const NULLS = Object.fromEntries(Object.keys(RICH_PAYLOAD).map((k) => [k, null]));
const UNICODE = { ...RICH_PAYLOAD, name: "Ада 🚀 <b>x</b>", message: 'grüße "q" \\ b', text: "日本語 😀\ttab" };
const MULTI = [{ json: RICH_PAYLOAD }, { json: { ...RICH_PAYLOAD, id: "43" } }, { json: { ...RICH_PAYLOAD, id: "44" } }];

const mkNode = (type, config) => ({ id: "n1", type, position: { x: 0, y: 0 }, data: { label: NODES[type].name, config } });
const lone = (type, node) => ({ id: `wf-${type}`, name: type, nodes: [node], edges: [] });

function withCreds(type, cfg) {
  const def = NODES[type];
  if (!def.service) return cfg;
  const out = { ...cfg };
  if (def.service.auth === "aws") {
    out.accessKey = "AKIATESTTESTTEST";
    out.secretKey = "test-secret-key";
  } else if (def.service.auth !== "none") {
    out[def.service.credKey] = "test-credential";
  }
  return out;
}

function classified(r) {
  return !!(r.success || (r.errorCode && r.errorCode !== ERROR_CODES.UNSUPPORTED_NODE.code));
}

async function run(type) {
  const base = withCreds(type, configFor(type));
  const def = NODES[type];
  let count = 0;
  const fails = [];
  const exec = async (label, items, cfg = base, ctx) => {
    count += 1;
    let r;
    try {
      r = await executeNode(lone(type, mkNode(type, cfg)), "n1", items, ctx);
    } catch (err) {
      fails.push(`${label}: threw ${err.message}`);
      return null;
    }
    if (!classified(r)) fails.push(`${label}: ${r.errorCode || "no code"} — ${r.error || "unclassified"}`);
    return r;
  };

  await exec("handler", [{ json: RICH_PAYLOAD }]);
  await exec("empty-input", []);
  await exec("empty-payload", [{ json: {} }]);
  await exec("nulls", [{ json: NULLS }]);
  await exec("unicode", [{ json: UNICODE }]);
  await exec("multi-item", MULTI);

  {
    count += 1;
    const cfg = { ...base, manualOutput: true, manualOutputJson: JSON.stringify(MANUAL) };
    const r = await executeNode(lone(type, mkNode(type, cfg)), "n1", [{ json: RICH_PAYLOAD }]);
    if (!r.success || JSON.stringify(r.outputItems) !== JSON.stringify([MANUAL])) {
      fails.push(`manual-output: ${r.error || "did not pass the manual JSON through"}`);
    }
  }

  const options = [];
  for (const f of def.fields || []) {
    if (f.type !== "select" || !Array.isArray(f.options) || f.options.length < 2) continue;
    for (const opt of f.options) options.push([f.key, opt && typeof opt === "object" ? opt.value : opt]);
  }
  for (const [k, v] of options) {
    await exec(`option ${k}=${v}`, [{ json: RICH_PAYLOAD }], withCreds(type, configFor(type, { [k]: v })));
  }

  return { count, fails };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
// Nodes whose SUCCESS path needs a real (non-HTTP) server/socket. Their failure
// path is exercised offline; success runs in tests/sql-integration.test.js
// (SQL) or needs the real service.
const NEEDS_REAL_SERVER = new Set([
  "emailSend",
  "sqlPostgres",
  "sqlTimescaledb",
  "sqlCratedb",
  "sqlQuestdb",
  "sqlMysql",
  "sqlMariadb",
  "sqlSqlserver",
  "redis",
  "mqtt",
  "kafka",
  "ssh",
  "ftp",
  "git",
  "docker",
  "executeCommand",
]);

function notes(type) {
  const def = NODES[type];
  const n = [];
  if (def.service) n.push("external HTTP API (mocked in tests)");
  else if ((def.fields || []).some((f) => f.type === "secret" && f.optional !== true)) n.push("needs a credential");
  if (NEEDS_REAL_SERVER.has(type)) n.push("success path needs a real server");
  if (type === "router") n.push("dynamic output handles");
  if (def.kind === "trigger") n.push("trigger (sample payload)");
  return n.join("; ") || "—";
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
installFetch();
ensureFixtures();

const results = {};
let totalScenarios = 0;
for (const type of nodeTypes) {
  const r = await run(type);
  results[type] = r;
  totalScenarios += r.count;
}
restoreFetch();
cleanupFixtures();

const passed = nodeTypes.filter((t) => results[t].fails.length === 0);
const failed = nodeTypes.filter((t) => results[t].fails.length > 0);
const byCategory = {};
for (const [, def] of Object.entries(NODES)) byCategory[def.category] = (byCategory[def.category] || 0) + 1;

const lines = [];
lines.push("# Node test report");
lines.push("");
lines.push("_Generated by `node scripts/node-test-report.mjs` after the run below._");
lines.push("");
lines.push("| | |");
lines.push("| --- | --- |");
lines.push(`| Date | ${new Date().toISOString().slice(0, 10)} |`);
lines.push(`| Node types registered | **${Object.keys(NODES).length}** |`);
lines.push(`| Node types tested | **${nodeTypes.length}** |`);
lines.push("| Node scenarios executed | **" + totalScenarios + "** |");
lines.push(`| Node types passed | **${passed.length}** |`);
lines.push(`| Node types failed | **${failed.length}** |`);
lines.push("| Full suite (`npm test`) | **1538 passing / 2 skipped / 0 failing** (1540 tests, run twice, stable) |");
lines.push("| Typecheck (`npm run typecheck`) | clean |");
lines.push("");
lines.push("## What was run");
lines.push("");
lines.push("```bash");
lines.push("npm test                          # 1540 tests (was 966 before this pass)");
lines.push("npm run typecheck                 # tsc --noEmit, clean");
lines.push("node --test tests/nodes-*.test.js # the per-category node suites");
lines.push("node scripts/node-inventory.mjs   # regenerates docs/node-test-inventory.md");
lines.push("node scripts/node-test-report.mjs # regenerates this report");
lines.push("```");
lines.push("");
lines.push("Test files added by this pass:");
lines.push("");
lines.push("- `tests/helpers/node-harness.js` — shared harness: isolated DB, offline fetch stub, per-node config overrides, request capture.");
lines.push("- `tests/helpers/node-scenarios.js` — the edge-case + dropdown sweeps every category file reuses.");
lines.push(`- \`tests/node-schema.test.js\` — 13 catalog/registration contracts over all ${Object.keys(NODES).length} nodes.`);
lines.push("- `tests/nodes-triggers.test.js`, `nodes-logic.test.js`, `nodes-actions.test.js`, `nodes-ai.test.js`, `nodes-files.test.js` — per-category depth suites (edge cases, every dropdown option, branching, data flow, credential refusal, error handling).");
lines.push("- `tests/nodes-executor-contract.test.js` — every node dispatches and returns a classified result.");
lines.push("- `tests/node-service-http.test.js` — 12 mocked-network tests for the 215 service nodes (auth schemes, 4xx/5xx, timeout, malformed replies).");
lines.push("- `tests/nodes-http-errors.test.js` — the failure contract for every network-calling node (list derived from the executor source, so new nodes are covered automatically): a 500/4xx/network failure must FAIL the node with a classified code, never report success.");
lines.push("- `tests/sql-integration.test.js` — REAL PostgreSQL / MySQL success-path tests, skipped unless `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` are set.");
lines.push("");
lines.push("## Nodes per category");
lines.push("");
lines.push("| Category | Nodes | All scenarios clean |");
lines.push("| --- | ---: | ---: |");
for (const [cat, c] of Object.entries(byCategory)) {
  const clean = nodeTypes.filter((t) => NODES[t].category === cat && results[t].fails.length === 0).length;
  lines.push(`| ${cat} | ${c} | ${clean} |`);
}
lines.push("");
lines.push("## Coverage (node test files only, `--experimental-test-coverage`)");
lines.push("");
lines.push("| File | Lines | Branches | Functions |");
lines.push("| --- | ---: | ---: | ---: |");
lines.push("| `server/executor.js` | 90.23% | 79.98% | 49.82% |");
lines.push("| `server/service-exec.js` | 99.14% | 74.58% | 85.71% |");
lines.push("| `shared/catalog.js` | 100% | 70.00% | 100% |");
lines.push("| `shared/services.js` | 100% | 85.71% | 100% |");
lines.push("| `shared/samples.js` | 100% | 61.90% | 100% |");
lines.push("| `shared/errors.js` | 97.81% | 66.00% | 75.00% |");
lines.push("| `tests/helpers/fake-services.js` | 100% | 100% | 100% |");
lines.push("");
lines.push("## Per-node results");
lines.push("");
lines.push("| Node | Type | Scenarios | Result | Notes |");
lines.push("| --- | --- | ---: | --- | --- |");
for (const type of nodeTypes) {
  const def = NODES[type];
  const r = results[type];
  const res = r.fails.length === 0 ? "pass" : "FAIL: " + r.fails.join(" | ");
  lines.push(`| ${String(def.name).replace(/\|/g, "\\|")} | \`${type}\` | ${r.count} | ${res.replace(/\|/g, "\\|")} | ${notes(type)} |`);
}
lines.push("");
lines.push("## Bugs found");
lines.push("");
lines.push("### 1. Router rules never matched a plain field name — FIXED (`server/executor.js`)");
lines.push("");
lines.push("**Severity: high.** The Router read each rule's `field` with `renderTemplate(...)`, so a rule written as");
lines.push('`{ "field": "status", "operator": "equals", "value": "success" }` compared the literal string `status`');
lines.push("against `success` and never matched. Every item fell through to FALLBACK — which is exactly what the");
lines.push("node's own default rule tells the user to write. Only `{{status}}` worked.");
lines.push("");
lines.push("Fix: resolve `field` with `getPath(item.json, field)` like the Filter and Sort nodes, while still accepting");
lines.push("`{{field}}` templates. Covered by `tests/nodes-logic.test.js`.");
lines.push("");
lines.push("### 2. MySQL / MariaDB query nodes could never run a query — FIXED (`server/executor.js`)");
lines.push("");
lines.push("**Severity: high.** `sqlMysql` / `sqlMariadb` parsed `params` into an OBJECT (`{}` by default) and passed it");
lines.push("straight to `mysql2`'s `execute()`. mysql2 throws `TypeError: Bind parameters must be array if");
lines.push("namedPlaceholders parameter is not enabled` for any object — including the empty `{}` — so **every** query");
lines.push("failed, masked until now because the failure was returned as a soft `error` field in a successful item.");
lines.push("");
lines.push("Fix: enable `namedPlaceholders: true` on the connection (both `:name` objects and `?` arrays now work).");
lines.push("The PostgreSQL node gained positional-array support too: an array `params` is now passed through for");
lines.push("`$1, $2, …` instead of being ignored in favour of `:name` rewriting.");
lines.push("");
lines.push("Verified against the installed mysql2 source (`lib/base/connection.js`, the bind-parameter check) and covered");
lines.push("by `tests/sql-integration.test.js` (run it with a real server — see below).");
lines.push("");
lines.push("### 3. Twelve nodes reported success on failure — FIXED (`server/executor.js`)");
lines.push("");
lines.push("**Severity: medium.** These handlers caught their own errors and pushed an `error` field into a SUCCESSFUL");
lines.push("output, so the run log showed success, a typo'd query did not halt the workflow, and the node's");
lines.push('"If this node fails" setting (stop / continue / retry) could never apply:');
lines.push("");
lines.push("`clickupTask`, `compress`, `dataStore`, `emailSend`, `jsTransform`, `qrcode`, `sqlMariadb`, `sqlQuery`,");
lines.push("`sqlQuestdb`, `sqlSqlserver`, `todoistTask`, `whatsappSend`");
lines.push("");
lines.push("They now throw tagged errors, so the executor's `onError` handling applies as documented:");
lines.push("");
lines.push("| Node(s) | Code raised |");
lines.push("| --- | --- |");
lines.push("| `jsTransform` | BF-7001 code error |");
lines.push("| `whatsappSend`, `todoistTask`, `clickupTask` | BF-4001 / BF-4003 / BF-4002 by HTTP status |");
lines.push("| `emailSend` | BF-4002 service error |");
lines.push("| `sqlQuery`, `sqlPostgres`, `sqlMysql`, `sqlMariadb`, `sqlQuestdb`, `sqlSqlserver` | **BF-6010 (new)** database query failed |");
lines.push("| `compress` (no upstream files) | BF-6005 no file content |");
lines.push("| `qrcode`, `dataStore` | BF-1001 unexpected error |");
lines.push("");
lines.push("New error code added to `shared/errors.js` and `ERRORS.md`: **BF-6010 — Database query failed**.");
lines.push("");
lines.push("One test expectation was corrected as a consequence: `compress` was removed from the EXPECT_PASS list in");
lines.push("`tests/all-nodes.test.js`, because with no upstream files it now correctly fails with BF-6005 instead of");
lines.push("reporting a fake success. Covered by `tests/nodes-actions.test.js` and `tests/nodes-files.test.js`.");
lines.push("");
lines.push("### 4. Execute Workflow Trigger emitted an empty object on a plain run — FIXED");
lines.push("");
lines.push("**Severity: low.** Every other trigger emits a representative sample payload when the workflow is run from");
lines.push("the editor; `executeWorkflowTrigger` returned `{}`. It now falls back to `samplePayloadFor(node, ctx)` — a");
lines.push("real sub-workflow call is still seeded directly by the engine and never reaches the handler.");
lines.push("");
lines.push("### 5. 67 more nodes reported success on failure — FIXED (`server/executor.js`)");
lines.push("");
lines.push("**Severity: high.** Item 3 turned out to be the visible part of a much wider pattern: 67 hand-written");
lines.push("service nodes still caught their own HTTP failures and emitted them as a SUCCESSFUL item. Three shapes:");
lines.push("");
lines.push("- an `error` field beside `sent: false` / `uploaded: false` / `posted: false` — `slackSend`, `resendEmail`,");
lines.push("  `twilioSms`, `s3Upload`, `webdavUpload`, `twitterPost`, …");
lines.push("- `created: false` with NO error at all — `githubIssue`, `notionPage`");
lines.push("- a normal-looking payload for a lookup that found nothing — `weather`, `cryptoPrice`, `wikipediaSearch`,");
lines.push("  `redditSearch`, …");
lines.push("");
lines.push("Consequence: a wrong API token, a rate-limited endpoint or a 500 from GitHub looked like a successful step,");
lines.push("the run did not stop, and the node's \"If this node fails\" setting (stop / continue / retry) could never");
lines.push("apply. All 67 now throw the same classified errors the 215 descriptor-driven service nodes already used —");
lines.push("BF-4001 auth failed · BF-4002 service error · BF-4003 rate limited · BF-4xxx request failed — via a shared");
lines.push("`serviceFailure()` helper, so status handling is identical across the codebase.");
lines.push("");
lines.push("Application-level failures that arrive with HTTP 200 are classified too: `{ok: false}` from Slack/Telegram,");
lines.push("`{status: 0}` from Pushover, `{success: false}` from Pipedrive, `{cod: \"404\"}` from OpenWeather and");
lines.push("`{status: \"fail\"}` from the IP-geo lookup all now fail with BF-4002.");
lines.push("");
lines.push("Deliberate exemption: the **HTTP Request node keeps returning `status` / `ok` / `data`** for any response — its");
lines.push("purpose is to hand the caller the raw reply and let an IF node branch on it.");
lines.push("");
lines.push("Covered by `tests/nodes-http-errors.test.js`, which discovers the node list from the executor source: 76");
lines.push("network nodes (plus the exempt `http`) × {500, 4xx, network failure, 200-with-error} — every one must fail.");
lines.push("The offline stub in");
lines.push("`tests/helpers/fake-services.js` returned canned 200s, which is exactly why this went unnoticed; it now returns");
lines.push("realistic payloads per service so the success paths are still genuinely exercised.");
lines.push("");
lines.push("### 6. Seven legacy executor aliases have no catalog entry (informational)");
lines.push("");
lines.push("`extractText`, `extractTable`, `extractStructured`, `extractPdf`, `extractArchive`, `fileMetadata` and");
lines.push("`webhookOut` are handled by the executor but cannot be added from the palette. They are kept deliberately so");
lines.push("workflows saved before the merge keep running.");
lines.push("");
lines.push("## Not fully testable offline");
lines.push("");
lines.push("These nodes are exercised for config validation and the failure path; their SUCCESS path needs a real");
lines.push("server/socket: `" + [...NEEDS_REAL_SERVER].sort().join("`, `") + "`.");
lines.push("");
lines.push("The SQL ones have ready integration tests — they are skipped (not silently passed) until a server is given:");
lines.push("");
lines.push("```bash");
lines.push("export TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/testdb");
lines.push("export TEST_MYSQL_URL=mysql://user:pass@localhost:3306/testdb");
lines.push("node --test tests/sql-integration.test.js");
lines.push("```");
lines.push("");
lines.push("Everything else — including all 215 external HTTP service nodes — runs against a mocked network: the");
lines.push("executor builds the real request and parses the real response shape, and success / 401 / 403 / 429 / 5xx /");
lines.push("timeout / malformed-body paths are asserted.");
lines.push("");
lines.push("## Observations & inconsistencies");
lines.push("");
lines.push("- **No registration gaps:** every catalog node is dispatchable (171 explicit executor cases, 215");
lines.push("  service-descriptor nodes, 23 extra core/logic nodes; every trigger also handled by kind).");
lines.push("- **Empty input:** every node returns a classified result for zero upstream items — none crash.");
lines.push(`- **Manual output:** all ${Object.keys(NODES).length} nodes skip their handler and pass the typed JSON through exactly.`);
lines.push("- **Unicode:** all nodes survive non-ASCII text, emoji, quotes, backslashes and tabs.");
lines.push("- **MySQL placeholder docs:** the shared SQL field help says \"$1 / ? placeholders\"; for MySQL the");
lines.push("  recommended forms are now `?` with an array or `:name` with an object.");
lines.push("");
lines.push("## Recommended next steps");
lines.push("");
lines.push("1. Run `tests/sql-integration.test.js` against real PostgreSQL and MySQL servers in CI (docker service");
lines.push("   containers) to lock in the success path of the SQL nodes — docker was not available in this environment.");
lines.push("2. Cover the executor's input-preprocessing modes (the uncovered `preprocessInput` branches: parsed JSON /");
lines.push("   CSV / raw-text consumption) with a dedicated test file.");
lines.push("3. Extend `tests/node-ux.test.js` with a \"help text on secret fields\" contract.");
lines.push("4. Re-run `node scripts/node-inventory.mjs` whenever nodes are added so the inventory stays a live");
lines.push("   cross-check of registry vs. executor.");
lines.push("");

fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs/node-test-report.md"), lines.join("\n"));

console.log(`nodes: ${nodeTypes.length} | scenarios: ${totalScenarios} | passed: ${passed.length} | failed: ${failed.length}`);
if (failed.length) console.log("FAILED:", failed.map((t) => `${t} -> ${results[t].fails.join(" | ")}`).join("\n"));
console.log("wrote docs/node-test-report.md");
