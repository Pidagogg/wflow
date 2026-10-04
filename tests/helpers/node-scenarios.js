// ============================================================================
// Shared node-scenario helpers for the per-category depth test files.
//
// tests/nodes-<category>.test.js each call registerEdgeCaseSweeps() and
// registerEnumSweep() with their own node list, so every catalog node still
// gets the full edge-case + dropdown coverage, but the tests live next to the
// category they belong to.
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { NODES, nodeTypes, executeNode, configFor, RICH_PAYLOAD } from "./node-harness.js";

export const INPUT = [{ json: RICH_PAYLOAD }];

/** Every catalog node in a category, in registry order. */
export function typesIn(category) {
  return nodeTypes.filter((t) => NODES[t].category === category);
}

export const mkNode = (type, config) => ({
  id: "n1",
  type,
  position: { x: 0, y: 0 },
  data: { label: NODES[type]?.name || type, config },
});

export const loneWorkflow = (type, node) => ({ id: `wf-${type}`, name: type, nodes: [node], edges: [] });

/** A failure counts as "handled" when the node either succeeded or returned a
 *  classified BF-… error. Falling through to "Unsupported node type" does not. */
export function assertClassified(type, r, how) {
  const msg = String(r.error || "");
  assert.ok(!/Unsupported node type/i.test(msg), `${type}: fell through to "Unsupported node type" (${how})`);
  assert.ok(r.success || r.errorCode, `${type}: neither succeeded nor produced a classified error (${how}): ${msg}`);
  assert.ok(Array.isArray(r.outputItems), `${type}: outputItems must be an array (${how})`);
}

/** Fill a service node's credentials so it reaches the request-building code
 *  (the offline fetch stub then answers, so no real network is touched). */
export function withCreds(type, cfg) {
  const def = NODES[type];
  if (!def?.service) return cfg;
  const out = { ...cfg };
  if (def.service.auth === "aws") {
    out.accessKey = "AKIATESTTESTTEST";
    out.secretKey = "test-secret-key";
  } else if (def.service.auth !== "none") {
    out[def.service.credKey] = "test-credential";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-test fetch scripting (used by the hand-written sender / SQL tests)
// ---------------------------------------------------------------------------
export let lastRequest = null;

/** Replace global fetch with a scripted handler and record what was sent. */
export function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), init: init || {} };
    return handler(lastRequest);
  };
}

// A response shape that satisfies both styles in the executor: the service
// engine reads res.text(), the hand-written senders read res.json().
export const jsonResponse = (body, status = 200) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : name?.toLowerCase() === "content-disposition" ? 'filename="stub.txt"' : null),
      entries: () => Object.entries({ "content-type": "application/json" }),
      getSetCookie: () => [],
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};

// ---------------------------------------------------------------------------
// Payloads the edge-case sweeps push through every node
// ---------------------------------------------------------------------------
export const NULL_PAYLOAD = Object.fromEntries(Object.keys(RICH_PAYLOAD).map((k) => [k, null]));
export const UNICODE_PAYLOAD = {
  ...RICH_PAYLOAD,
  name: "Ада 🚀 <b>bold</b>",
  message: 'grüße "double" \'single\' \\ backslash',
  text: "日本語テキスト ÆØÅ emoji 😀 tab\tend",
  body: '{"name":"Ünïcødé","emoji":"🎉"}',
};
export const MULTI_ITEMS = [
  { json: RICH_PAYLOAD },
  { json: { ...RICH_PAYLOAD, id: "43", name: "Grace" } },
  { json: { ...RICH_PAYLOAD, id: "44", name: "Linus" } },
];

const SWEEPS = [
  ["empty input (no upstream items) never crashes a node", [{ label: "empty-input", items: [] }]],
  ["empty-object payload never crashes a node", [{ label: "empty-payload", items: [{ json: {} }] }]],
  ["null field values never crash a node", [{ label: "nulls", items: [{ json: NULL_PAYLOAD }] }]],
  ["unicode / quotes / markup never crash a node", [{ label: "unicode", items: [{ json: UNICODE_PAYLOAD }] }]],
  ["multiple input items are handled (fan-out)", [{ label: "multi-item", items: MULTI_ITEMS }]],
];

/** Register the 5 edge-case sweeps for a category's nodes. */
export function registerEdgeCaseSweeps(label, types, timeout = 180000) {
  for (const [name, payloads] of SWEEPS) {
    test(`${label}: ${name}`, { timeout }, async () => {
      const failures = [];
      for (const type of types) {
        const config = withCreds(type, configFor(type));
        for (const { label: how, items } of payloads) {
          let r;
          try {
            r = await executeNode(loneWorkflow(type, mkNode(type, config)), "n1", items);
          } catch (err) {
            failures.push(`${type} [${how}]: threw out of executeNode: ${err.message}`);
            continue;
          }
          try {
            assertClassified(type, r, how);
          } catch (err) {
            failures.push(`${type} [${how}]: ${err.message.split("\n")[0]}`);
          }
        }
      }
      assert.deepEqual(failures, [], `${failures.length} node/scenario failures`);
    });
  }
}

/** Register one test per node that runs EVERY option of EVERY dropdown field. */
export function registerEnumSweep(label, types) {
  for (const type of types) {
    const def = NODES[type];
    const selects = (def.fields || []).filter((f) => f.type === "select" && Array.isArray(f.options) && f.options.length > 1);
    if (!selects.length) continue;

    test(`${label}: every dropdown option runs without crashing: ${type}`, { timeout: 30000 }, async () => {
      const failures = [];
      for (const f of selects) {
        for (const opt of f.options) {
          const value = opt && typeof opt === "object" ? opt.value : opt;
          const config = withCreds(type, configFor(type, { [f.key]: value }));
          const node = mkNode(type, config);
          let r;
          try {
            r = await executeNode(loneWorkflow(type, node), "n1", INPUT);
          } catch (err) {
            failures.push(`${f.key}="${value}": threw ${err.message}`);
            continue;
          }
          try {
            assertClassified(type, r, `${f.key}="${value}"`);
          } catch (err) {
            failures.push(`${f.key}="${value}": ${err.message.split("\n")[0]}`);
          }
        }
      }
      assert.deepEqual(failures, [], `${type} option failures`);
    });
  }
}
