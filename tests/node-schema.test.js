// ============================================================================
// Node schema / registration contract.
//
// Data-level checks over the whole catalog (no executor): the registry key
// matches the node's own `type`, every default value matches its field type,
// every dropdown default is one of its own options, and every external-service
// descriptor is well formed. These catch the mistakes that only show up at
// runtime — a typo'd type key that the executor cannot dispatch, a select
// whose saved default is not a real option, a service node with no base URL.
//
// Run: node --test tests/node-schema.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { NODES, CATEGORIES, NODE_KINDS } from "../shared/catalog.js";

const entries = Object.entries(NODES);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

test("registry key matches the node's own type (no typos in the dispatch key)", () => {
  const bad = entries.filter(([key, def]) => def.type !== key).map(([key, def]) => `${key} -> ${def.type}`);
  assert.deepEqual(bad, [], "a mismatched type makes the executor fall through to \"Unsupported node type\"");
});

test("every node declares a known kind and category", () => {
  const bad = [];
  for (const [type, def] of entries) {
    if (!NODE_KINDS[def.kind]) bad.push(`${type}: kind "${def.kind}"`);
    if (!CATEGORIES[def.category]) bad.push(`${type}: category "${def.category}"`);
  }
  assert.deepEqual(bad, []);
});

test("every node ships a defaults object (the config modal's initial state)", () => {
  const bad = entries.filter(([, def]) => def.defaults !== undefined && !isPlainObject(def.defaults)).map(([type]) => type);
  assert.deepEqual(bad, [], "defaults must be an object when present");
});

// Nodes that deliberately end the flow have no output handle: the Router grows
// its handles at runtime, Loop End closes a loop and Stop and Error halts.
const NO_OUTPUT_HANDLE = new Set(["router", "loopEnd", "stopError"]);

test("every node declares string output handles (or is the dynamic Router)", () => {
  const bad = [];
  for (const [type, def] of entries) {
    if (NO_OUTPUT_HANDLE.has(type)) continue;
    const s = def.sources;
    if (!Array.isArray(s) || s.length === 0) bad.push(`${type}: sources=${JSON.stringify(s)}`);
    else if (s.some((h) => typeof h !== "string" || h.trim() === "")) bad.push(`${type}: bad handle in ${JSON.stringify(s)}`);
  }
  assert.deepEqual(bad, [], "a node with no output handle can never feed a downstream node");
});

test("boolean fields default to a boolean (not the string \"false\")", () => {
  const bad = [];
  for (const [type, def] of entries) {
    for (const f of def.fields || []) {
      if (f.type !== "boolean") continue;
      const d = (def.defaults || {})[f.key];
      if (d !== undefined && typeof d !== "boolean") bad.push(`${type}.${f.key} = ${JSON.stringify(d)}`);
    }
  }
  assert.deepEqual(bad, [], "a stringy \"false\" is truthy in JS and silently flips the toggle on");
});

test("number fields default to a number (or the empty \"unset\" sentinel)", () => {
  // Optional numbers use "" to mean "not filled in" — the handlers test for it
  // (e.g. pipedriveDeal skips the field when c.value === ""), so that sentinel
  // is intentional. A *stringy* number ("5") is still a bug.
  const bad = [];
  for (const [type, def] of entries) {
    for (const f of def.fields || []) {
      if (f.type !== "number") continue;
      const d = (def.defaults || {})[f.key];
      if (d === undefined) continue;
      const allowedUnset = d === "" && f.optional === true;
      if (typeof d !== "number" && !allowedUnset) bad.push(`${type}.${f.key} = ${JSON.stringify(d)} (${typeof d})`);
    }
  }
  assert.deepEqual(bad, [], "the config modal renders number inputs from numeric defaults");
});

test("every select default is one of the field's own options", () => {
  const bad = [];
  for (const [type, def] of entries) {
    for (const f of def.fields || []) {
      if (f.type !== "select") continue;
      const values = (f.options || []).map((o) => (isPlainObject(o) ? o.value : o));
      const d = (def.defaults || {})[f.key];
      if (typeof d === "string" && d !== "" && !values.includes(d)) {
        bad.push(`${type}.${f.key}: default "${d}" not in [${values.join(", ")}]`);
      }
    }
  }
  assert.deepEqual(bad, [], "a default outside the option list renders an empty dropdown");
});

test("no select lists the same option twice", () => {
  const bad = [];
  for (const [type, def] of entries) {
    for (const f of def.fields || []) {
      if (f.type !== "select") continue;
      const values = (f.options || []).map((o) => (isPlainObject(o) ? o.value : o));
      const dupes = values.filter((v, i) => values.indexOf(v) !== i);
      if (dupes.length) bad.push(`${type}.${f.key}: duplicate option(s) ${[...new Set(dupes)].join(", ")}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("external-service descriptors are complete and well formed", () => {
  // Simple schemes, or a "header:<name>" / "query:<param>" variant that puts
  // the credential in a service-specific place.
  const knownAuth = (auth) => /^(bearer|basic|aws|none)$/.test(auth) || /^(header|query):.+/.test(auth);
  const bad = [];
  for (const [type, def] of entries) {
    const svc = def.service;
    if (!svc) continue;
    if (!knownAuth(svc.auth)) bad.push(`${type}: unknown auth "${svc.auth}"`);
    if (typeof svc.base !== "string" || !/^https?:\/\//.test(svc.base)) bad.push(`${type}: base "${svc.base}" is not http(s)`);
    if (!svc.defaultMethod) bad.push(`${type}: missing defaultMethod`);
    if (svc.auth !== "none" && svc.auth !== "aws" && !svc.credKey) bad.push(`${type}: auth ${svc.auth} without a credential key`);
    if (typeof svc.defaultPath !== "string") bad.push(`${type}: defaultPath must be a string`);
  }
  assert.deepEqual(bad, [], "service-exec.js builds the real request from this descriptor");
});

test("service nodes expose their credential field and an endpoint path", () => {
  const bad = [];
  for (const [type, def] of entries) {
    if (!def.service) continue;
    const keys = new Set((def.fields || []).map((f) => f.key));
    if (def.service.auth === "aws") {
      if (!keys.has("accessKey") || !keys.has("secretKey")) bad.push(`${type}: AWS node missing accessKey/secretKey`);
    } else if (def.service.auth !== "none") {
      if (!keys.has(def.service.credKey)) bad.push(`${type}: credential field "${def.service.credKey}" not in fields`);
    }
    if (!keys.has("path")) bad.push(`${type}: no endpoint path field`);
    if (!keys.has("storeIn")) bad.push(`${type}: no storeIn output field`);
  }
  assert.deepEqual(bad, [], "a service node without these fields cannot be configured by the user");
});

test("non-service action nodes still declare at least one config field", () => {
  // Triggers may legitimately have no fields (manual / chat). Actions must not:
  // a node the user cannot configure is a palette entry that does nothing.
  const bad = entries
    .filter(([type, def]) => def.kind === "action" && !def.service && type !== "noop" && !(def.fields || []).length)
    .map(([type]) => type);
  assert.deepEqual(bad, []);
});

test("no node name or type collides with another (picker + dispatch stay unambiguous)", () => {
  const names = new Map();
  for (const [type, def] of entries) names.set(def.name, [...(names.get(def.name) || []), type]);
  const collisions = [...names.entries()].filter(([, types]) => types.length > 1);
  assert.deepEqual(collisions, []);
});

test("catalog size stays large (guards against a silent mass-deletion)", () => {
  assert.ok(entries.length >= 350, `expected >= 350 nodes, got ${entries.length}`);
});
