// ============================================================================
// The workflow reference for AI agents and the checks built on it:
//   - shared/node-outputs.js   — every node documents what it outputs,
//   - shared/paths.js          — {{json}} is the whole item,
//   - shared/workflow-validate.js — the validator the builder, the JSON editor
//     and MCP share,
//   - shared/workflow-schema.js — the JSON Schema served to editors,
//   - server/workflow-docs.js  — the reference text itself.
//
// Run: node --test tests/workflow-docs.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-wfdocs-"));
process.env.BF_DB_PATH = path.join(tempDir, "wfdocs.db");

const { NODES } = await import("../shared/catalog.js");
const { TEMPLATES } = await import("../shared/templates.js");
const { outputDocFor, outputHandlesFor } = await import("../shared/node-outputs.js");
const { resolvePath } = await import("../shared/paths.js");
const { validateWorkflow } = await import("../shared/workflow-validate.js");
const { buildWorkflowSchema } = await import("../shared/workflow-schema.js");
const { buildReferenceMarkdown, buildExamplesDoc } = await import("../server/workflow-docs.js");
const { executeNode } = await import("../server/executor.js");

const node = (id, type, config = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, config } });

// ---- outputs ----
test("every node type documents what it outputs", () => {
  const missing = Object.entries(NODES).filter(([type, def]) => !outputDocFor(type, def)).map(([t]) => t);
  assert.deepEqual(missing, [], `add these to OUTPUTS in shared/node-outputs.js: ${missing.join(", ")}`);
});

test("Switch and Router handles follow their rows, dead ends have none", () => {
  assert.deepEqual(outputHandlesFor(node("s", "switch", { cases: [{ key: "a" }, { key: "b" }] }), NODES.switch), ["case-0", "case-1", "default"]);
  assert.deepEqual(outputHandlesFor(node("r", "router", { rules: JSON.stringify([{ field: "x" }]) }), NODES.router), ["case-0", "fallback"]);
  assert.deepEqual(outputHandlesFor(node("i", "if"), NODES.if), ["true", "false"]);
  assert.deepEqual(outputHandlesFor(node("x", "stopError"), NODES.stopError), []);
  assert.deepEqual(outputHandlesFor(node("h", "http"), NODES.http), ["out"]);
});

// ---- placeholders ----
test("{{json}} is the whole item and {{json.a.b}} a path inside it", async () => {
  const item = { x: 1, y: { z: 2 } };
  assert.deepEqual(resolvePath(item, "json"), item);
  assert.equal(resolvePath(item, "json.y.z"), 2);
  assert.equal(resolvePath({ json: "own field" }, "json"), "own field", "a real field called json still wins");
  const wf = { id: "p", nodes: [node("s", "set", { fields: [{ key: "a", value: "{{json}}" }] })], edges: [] };
  const run = await executeNode(wf, "s", [{ json: item }], {});
  assert.deepEqual(JSON.parse(run.outputItems[0].a), item, "the AI nodes' default prompt now carries the data");
});

// ---- validator ----
test("every built-in template validates without errors or warnings", () => {
  for (const t of TEMPLATES) {
    const r = validateWorkflow(t, { nodes: NODES });
    assert.deepEqual([...r.errors, ...r.warnings].map((i) => i.message), [], t.id);
  }
});

test("the validator reports broken graphs, bad settings and placeholders nothing produces", () => {
  const wf = {
    nodes: [
      node("f", "formTrigger", { fields: "name, email" }),
      node("s", "slackSend", { text: "hi {{name}}" }),
      node("m", "emailSend", { to: "{{email}}", subject: "{{ first name }}", bogus: 1 }),
      node("sw", "switch", { value: "{{name}}", cases: [{ key: "a" }] }),
      node("x", "noop"),
      node("h", "http", { method: "FETCH", body: "{ \"a\": {{name}} " }),
      node("dup", "noop"),
      node("dup", "noop"),
      node("?", "notANode"),
    ],
    edges: [
      { source: "f", target: "s" },
      { source: "s", target: "m" },
      { source: "f", target: "sw" },
      { source: "sw", target: "x", sourceHandle: "a" },
      { source: "x", target: "ghost" },
      { source: "f", target: "h" },
    ],
  };
  const { ok, errors, warnings } = validateWorkflow(wf, { nodes: NODES });
  const all = [...errors, ...warnings].map((i) => `${i.severity} ${i.path} ${i.message}`).join("\n");
  assert.equal(ok, false);
  for (const needle of [
    /error edges\[3\]\.sourceHandle .*"case-0", "default"/,
    /error edges\[4\]\.target .*ghost/,
    /error nodes\[2\]\.data\.config\.subject .*not a valid placeholder/,
    /error nodes\[7\]\.id Duplicate node id "dup"/,
    /error nodes\[8\]\.type Unknown node type "notANode"/,
    /warning nodes\[2\]\.data\.config\.bogus .*not a setting/,
    /warning nodes\[2\]\.data\.config\.to \{\{email\}\}: no step before "m" outputs a field "email"/,
    /warning nodes\[5\]\.data\.config\.method "FETCH" is not an option/,
    /warning nodes\[5\]\.data\.config\.body .*not valid JSON/,
  ]) {
    assert.match(all, needle);
  }
  assert.doesNotMatch(all, /config\.text \{\{name\}\}/, "the form field right after the trigger is fine");
});

test("placeholders after a node with an open-ended output are not second-guessed", () => {
  const wf = {
    nodes: [node("w", "webhook"), node("h", "http", { url: "https://x.test/{{anything}}" }), node("m", "emailSend", { to: "{{whatever.deep}}" })],
    edges: [
      { source: "w", target: "h" },
      { source: "h", target: "m" },
    ],
  };
  const { warnings } = validateWorkflow(wf, { nodes: NODES });
  assert.deepEqual(warnings.filter((w) => /renders empty/.test(w.message)), []);
});

// ---- schema ----
test("the JSON Schema knows every node type and its select options", () => {
  const schema = buildWorkflowSchema(NODES, { baseUrl: "https://w.test" });
  assert.equal(schema.$id, "https://w.test/schema/workflow.schema.json");
  assert.deepEqual(new Set(schema.definitions.node.properties.type.enum), new Set(Object.keys(NODES)));
  const httpRule = schema.definitions.node.allOf.find((r) => r.if.properties.type.const === "http");
  assert.ok(httpRule.then.properties.data.properties.config.properties.method.enum.includes("POST"));
  assert.doesNotThrow(() => JSON.stringify(schema));
});

// ---- the reference ----
test("the reference documents outputs, handles, placeholder rules and runnable examples", () => {
  const md = buildReferenceMarkdown("https://w.test");
  for (const needle of ["ITEMS AND OUTPUTS", "case-0", "fallback", "{{json}}", "$vars", "_error", "runs ONCE", "out: = { status, ok, headers, data }", "https://w.test/mcp"]) {
    assert.ok(md.includes(needle), `reference mentions ${needle}`);
  }
  for (const type of Object.keys(NODES)) assert.ok(md.includes(`- ${type}`), type);
  // The examples are real JSON workflows that validate cleanly.
  const blocks = buildExamplesDoc().split("\n#### ").slice(1);
  assert.ok(blocks.length >= 3);
  for (const block of blocks) {
    const wf = JSON.parse(block.slice(block.indexOf("\n{") + 1));
    const r = validateWorkflow(wf, { nodes: NODES });
    assert.deepEqual(r.errors, [], wf.name);
  }
});
