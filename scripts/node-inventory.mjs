// ============================================================================
// Node inventory generator — Phase 1 of the node test audit.
//
// Scans:
//   * the registry   (shared/catalog.js -> NODES, merged with shared/services.js)
//   * the executor   (server/executor.js -> explicit `case "type":` handlers)
//   * the tests      (tests/all-nodes.test.js EXPECT_PASS + per-trigger files)
//
// and writes docs/node-test-inventory.md with one row per node, flagging any
// node that is registered without an implementation (or implemented without a
// registration).
//
// Run: node scripts/node-inventory.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NODES, CATEGORIES } from "../shared/catalog.js";
import { EXTRA_NODES } from "../shared/services.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const executorSrc = read("server/executor.js");
const allNodesSrc = read("tests/all-nodes.test.js");
const helperSrcPath = "tests/helpers/node-harness.js";
const depthSrc = fs.existsSync(path.join(root, helperSrcPath)) ? read(helperSrcPath) : "";
const allNodesSrcAll = allNodesSrc + depthSrc;

// --- explicit executor handlers ---------------------------------------------
// Only the top-level `switch (node.type)` dispatch counts: nested switches
// (IF operators, math ops, random-value generators …) reuse plain string cases
// that must not be mistaken for node types. Slice the runNode switch body out.
const switchStart = executorSrc.indexOf("switch (node.type) {");
const nodeSwitch = switchStart === -1 ? "" : executorSrc.slice(switchStart, executorSrc.indexOf("export async function executeNode"));
const handledCases = new Set([...nodeSwitch.matchAll(/^ {4}case "([A-Za-z0-9]+)":/gm)].map((m) => m[1]));
// triggers are handled generically by kind in the executor's default branch
const sampleSrc = read("shared/samples.js");
const isTriggerTypeHandledByKind = (def) => def.kind === "trigger";

// --- service nodes (shared/services.js ACTION entries carry a descriptor) ----
const serviceTypes = new Set(Object.values(EXTRA_NODES).filter((d) => d.service).map((d) => d.type));
const coreExtraTypes = new Set(Object.values(EXTRA_NODES).filter((d) => !d.service).map((d) => d.type));

// --- coverage from the offline harness --------------------------------------
function extractSet(src, name) {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}
const expectPass = extractSet(allNodesSrcAll, "EXPECT_PASS");
const manualCovered = new Set(Object.keys(NODES)); // all-nodes.test.js covers every node for manual output

const needsConfigOverride = extractSet(allNodesSrcAll, "CONFIG_OVERRIDES");
// CONFIG_OVERRIDES is an object, not a Set — extract keys
const overrideKeys = new Set([...allNodesSrcAll.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)].map((m) => m[1]));

const CREDENTIAL_FIELD = /^(apiKey|token|accessToken|secret|secretKey|password|appPassword|serverToken|basicAuth|databaseSecret|botToken|webhookSecret)$/;

function outputHandles(def) {
  if (def.type === "router") return "dynamic (1 per rule + fallback)";
  const s = def.sources || [];
  if (s.length === 0) return "—";
  return s.join(", ");
}

function requiredParams(def) {
  const defaults = def.defaults || {};
  const out = [];
  for (const f of def.fields || []) {
    if (f.type === "note" || f.optional === true) continue;
    const hasDefault = Object.prototype.hasOwnProperty.call(defaults, f.key) && defaults[f.key] !== "" && defaults[f.key] !== null;
    if (!hasDefault) out.push(f.key);
  }
  return out;
}

function credentialNeed(def) {
  if (def.service) {
    if (def.service.auth === "aws") return "AWS keys (SigV4) / external service";
    if (def.service.auth === "none") return "external service (no key)";
    return "API credential / external service";
  }
  const secret = (def.fields || []).find((f) => f.type === "secret" && f.optional !== true);
  if (secret) return `credential field "${secret.key}"`;
  if (def.type === "emailSend") return "SMTP server";
  if (["sqlPostgres", "sqlMysql", "sqlServer", "redis", "mqtt", "kafka", "ssh", "ftp"].includes(def.type)) {
    return "external server";
  }
  return "no (network/public only)";
}

function existingTests(type) {
  const files = [];
  if (manualCovered.has(type)) files.push("all-nodes (manual + handler)");
  if (expectPass.has(type)) files.push("all-nodes (expected-pass)");
  if (type === "rssTrigger") files.push("rss-trigger");
  if (type === "githubTrigger") files.push("github-trigger");
  if (type === "telegramTrigger") files.push("telegram-trigger");
  if (["webhook", "schedule", "manual"].includes(type)) files.push("api-e2e");
  if (type === "subworkflow") files.push("subworkflow");
  if (type === "aiChat" || (def0(type)?.kind === "ai")) files.push("ai-providers");
  return files.join(" · ") || "—";
}
function def0(type) {
  return NODES[type];
}

// --- gap analysis ------------------------------------------------------------
const implemented = (type) => {
  const def = NODES[type];
  return handledCases.has(type) || serviceTypes.has(type) || isTriggerTypeHandledByKind(def);
};
const unimplemented = Object.keys(NODES).filter((t) => !implemented(t));
const handledNotInCatalog = [...handledCases].filter((t) => !NODES[t]).sort();

// --- build markdown ----------------------------------------------------------
const byCategory = {};
for (const def of Object.values(NODES)) {
  byCategory[def.category] = (byCategory[def.category] || 0) + 1;
}

const lines = [];
lines.push("# Node test inventory");
lines.push("");
lines.push("_Generated by `node scripts/node-inventory.mjs` — do not edit by hand._");
lines.push("");
lines.push(`Total registered nodes: **${Object.keys(NODES).length}**`);
lines.push("");
lines.push("| Category | Nodes |");
lines.push("| --- | ---: |");
for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${CATEGORIES[cat]?.label || cat} (\`${cat}\`) | ${count} |`);
}
lines.push("");
lines.push("## Registration / implementation cross-check");
lines.push("");
lines.push(`- Registered in the catalog: **${Object.keys(NODES).length}**`);
lines.push(`- Explicit executor \`case\` handlers: **${handledCases.size}**`);
lines.push(`- Service-descriptor nodes (via \`server/service-exec.js\`): **${serviceTypes.size}**`);
lines.push(`- Extra core/logic nodes (handler in the big switch): **${coreExtraTypes.size}**`);
lines.push(`- Registered but no visible implementation: **${unimplemented.length}**${unimplemented.length ? " → " + unimplemented.join(", ") : ""}`);
lines.push(`- Executor cases with no catalog entry (aliases/dead): **${handledNotInCatalog.length}**${handledNotInCatalog.length ? " → " + handledNotInCatalog.join(", ") : ""}`);
lines.push("");
lines.push("> Every trigger is also handled generically by `kind === \"trigger\"` in the executor's");
lines.push("> default branch (sample payload, or the real inbound event when one was supplied).");
lines.push("");
lines.push("## Per-node inventory");
lines.push("");
lines.push("| Node | Type | File | Category | Inputs | Outputs | Required params | Credentials / external service | Existing tests | Status |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [type, def] of Object.entries(NODES)) {
  const file = serviceTypes.has(type) || coreExtraTypes.has(type) ? "shared/services.js" : "shared/catalog.js";
  const inputs = def.kind === "trigger" ? "— (starts a run)" : "in";
  const req = requiredParams(def);
  const status = implemented(type) ? "implemented" : "**NOT IMPLEMENTED**";
  lines.push(
    [
      def.name,
      "`" + type + "`",
      file,
      def.category,
      inputs,
      outputHandles(def),
      req.length ? req.map((k) => "`" + k + "`").join(", ") : "—",
      credentialNeed(def),
      existingTests(type),
      status,
    ]
      .map((v) => String(v).replace(/\|/g, "\\|"))
      .join(" | ")
      .replace(/^/, "| ") + " |"
  );
}
lines.push("");

fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs/node-test-inventory.md"), lines.join("\n"));

// --- console summary ---------------------------------------------------------
console.log("nodes:", Object.keys(NODES).length);
console.log("categories:", JSON.stringify(byCategory));
console.log("executor cases:", handledCases.size, "| service nodes:", serviceTypes.size, "| extra core:", coreExtraTypes.size);
console.log("unimplemented:", unimplemented.length ? unimplemented.join(", ") : "(none)");
console.log("handled-not-in-catalog:", handledNotInCatalog.length ? handledNotInCatalog.join(", ") : "(none)");
console.log("wrote docs/node-test-inventory.md");
