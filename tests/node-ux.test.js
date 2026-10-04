// ============================================================================
// "Can a user understand and use this node?" — catalog-level UX contract tests.
//
// The palette, the config modal and the node search are all driven straight
// from shared/catalog.js. If a node type is broken there, the user sees it
// before the executor ever runs: a node without an icon renders a generic box,
// a field without a label is unreadable, a select whose options point nowhere
// can never be filled in. These tests hold every catalog entry to the minimum
// contract the UI needs so a broken node shows up in CI instead of in front of
// a user.
//
// Run: node --test tests/node-ux.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NODES, CATEGORIES, NODE_KINDS } from "../shared/catalog.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ICONS_SOURCE = fs.readFileSync(new URL("../src/components/icons.tsx", import.meta.url), "utf8");

const FIELD_TYPES = new Set([
  "text",
  "textarea",
  "number",
  "select",
  "boolean",
  "secret",
  "json",
  "code",
  "keyvalue",
  "note",
  "agentSelect",
  "workflowSelect",
  "oauth",
  "telegramBot",
  "telegramAccount",
  "upstreamFile",
]);

// Icon names registered in the frontend icon map (src/components/icons.tsx).
function iconNames() {
  const names = new Set();
  for (const m of ICONS_SOURCE.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)) names.add(m[1]);
  return names;
}

const nodeTypes = Object.keys(NODES);

test("catalog exposes a large, organised set of nodes", () => {
  assert.ok(nodeTypes.length >= 100, `expected at least 100 node types, got ${nodeTypes.length}`);
  for (const def of Object.values(NODES)) {
    assert.ok(def.type, "every node has a type key");
    assert.ok(CATEGORIES[def.category], `node "${def.type}" has a known category, got "${def.category}"`);
    assert.ok(NODE_KINDS[def.kind], `node "${def.type}" has a known kind, got "${def.kind}"`);
  }
});

test("every node the user can add has a name + description (palette & search)", () => {
  const seen = new Set();
  for (const [type, def] of Object.entries(NODES)) {
    assert.ok(typeof def.name === "string" && def.name.trim().length >= 2, `node "${type}" needs a readable name`);
    assert.ok(typeof def.description === "string" && def.description.trim().length >= 10, `node "${type}" needs a description so users understand it in the palette`);
    assert.equal(def.description, def.description.trim(), `node "${type}" description has stray whitespace`);
    assert.ok(!seen.has(def.name), `duplicate node name "${def.name}" would confuse the picker search`);
    seen.add(def.name);
  }
});

test("every node has an icon that exists in the frontend icon map", () => {
  const icons = iconNames();
  assert.ok(icons.size > 30, `expected to parse the icon map, got ${icons.size} icons`);
  const missing = [];
  for (const [type, def] of Object.entries(NODES)) {
    if (!icons.has(def.icon)) missing.push(`${type} -> "${def.icon}"`);
  }
  assert.deepEqual(missing, [], "nodes with unknown icons render a generic box instead of a real icon");
});

test("every config field is renderable and labelled (config modal)", () => {
  const errors = [];
  for (const [type, def] of Object.entries(NODES)) {
    const fields = def.fields || [];
    assert.ok(Array.isArray(fields), `node "${type}" fields must be an array`);
    const seenKeys = new Set();
    for (const f of fields) {
      if (!f.key || typeof f.key !== "string") {
        errors.push(`${type}: field without a key`);
        continue;
      }
      if (seenKeys.has(f.key)) errors.push(`${type}.${f.key}: duplicate field key`);
      seenKeys.add(f.key);
      if (f.type === "note") continue; // hint boxes don't need a label
      if (!f.label || String(f.label).trim().length < 2) {
        errors.push(`${type}.${f.key}: field has no readable label`);
      }
      if (!FIELD_TYPES.has(f.type)) errors.push(`${type}.${f.key}: unknown field type "${f.type}"`);
    }
  }
  assert.deepEqual(errors, [], "every field must be something the config modal can render with a label");
});

test("conditional (visibleWhen) fields always reference a real sibling field", () => {
  const errors = [];
  for (const [type, def] of Object.entries(NODES)) {
    const keys = new Set((def.fields || []).map((f) => f.key));
    for (const f of def.fields || []) {
      if (f.visibleWhen?.key && !keys.has(f.visibleWhen.key)) {
        errors.push(`${type}.${f.key}: visibleWhen points at missing field "${f.visibleWhen.key}" (the field could never be shown)`);
      }
    }
  }
  assert.deepEqual(errors, [], "a condition that can never be true hides the field forever");
});

test("live-capable triggers ship the 'Always listen' option off by default", () => {
  for (const type of ["webhook", "githubTrigger", "telegramTrigger"]) {
    const def = NODES[type];
    assert.ok(def, `live-capable trigger "${type}" still exists`);
    assert.equal(def.defaults?.live, false, `${type}: live defaults to OFF (opt-in)`);
    const hasLiveField = (def.fields || []).some(
      (f) => f.key === "live" && f.type === "boolean" && /listen|Always listen/i.test(f.label || "")
    );
    assert.ok(hasLiveField, `${type}: needs the boolean "Always listen" field`);
  }
});

test("select options are always present as arrays", () => {
  const errors = [];
  for (const [type, def] of Object.entries(NODES)) {
    for (const f of def.fields || []) {
      if (f.type === "select" && !Array.isArray(f.options)) errors.push(`${type}.${f.key}: select without options`);
      if (f.type === "select" && Array.isArray(f.options) && f.options.length === 0) {
        errors.push(`${type}.${f.key}: select with zero options`);
      }
    }
  }
  assert.deepEqual(errors, [], "empty dropdowns give a user nothing to choose");
});

test("sample-only service triggers tell the user the truth about Run", () => {
  // Service triggers (Gmail, Slack, GitHub, …) cannot ingest live events yet —
  // pressing Run fires a representative sample payload. The description and a
  // note field in the config must say so, otherwise users believe the node is
  // watching their inbox/feed when it is not. Deliberately NOT in this list
  // (they support real live events since 2026-09): rssTrigger (feed polling)
  // and webhook / githubTrigger / telegramTrigger via their "Always listen"
  // server-side option — the executor + live-trigger tests prove those paths.
  const sampleOnly = [
    "gmail", "slackTrigger", "imap",
    "notionTrigger", "sheetsTrigger", "teamsTrigger", "outlookTrigger",
    "stripeTrigger", "jiraTrigger", "discordTrigger", "googleDriveTrigger",
    "errorTrigger", "hubspotTrigger", "airtableTrigger",
    "supabaseTrigger", "slackReactionTrigger",
  ];
  const missing = [];
  for (const type of sampleOnly) {
    const def = NODES[type];
    assert.ok(def, `sample-only trigger "${type}" still exists in the catalog`);
    const fields = def.fields || [];
    const hasNote = fields.some((f) => f.key === "sampleInfo" && f.type === "note");
    if (!hasNote) missing.push(`${type}: no sampleInfo note field`);
    if (!/run/i.test(def.description) && !/sample/i.test(def.description)) {
      missing.push(`${type}: description does not explain the sample behaviour`);
    }
  }
  assert.deepEqual(missing, [], "these triggers currently only fire samples — the UI must say so");
});
