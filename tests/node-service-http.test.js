// ============================================================================
// External-service node tests — auth schemes + failure handling.
//
// The 215 service nodes in shared/services.js all run through the same engine
// (server/service-exec.js). These tests drive a representative node per auth
// scheme against a scripted fetch and assert:
//   * the credential lands where the service expects it (Bearer / Basic /
//     custom header / query param / SigV4 signature),
//   * the method + body are built from the node's config,
//   * 401 / 403 / 429 / 5xx are classified into the right BF-… codes,
//   * a malformed response body is kept as raw text rather than crashing,
//   * timeouts and network failures are classified, never unhandled.
//
// No real network is touched: globalThis.fetch is replaced per test.
//
// Run: node --test tests/node-service-http.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import {
  NODES,
  executeNode,
  configFor,
  ensureFixtures,
  cleanupFixtures,
  installFetch,
  restoreFetch,
  RICH_PAYLOAD,
} from "./helpers/node-harness.js";

const INPUT = [{ json: RICH_PAYLOAD }];
const mkNode = (type, config) => ({ id: "n1", type, position: { x: 0, y: 0 }, data: { label: NODES[type].name, config } });
const loneWorkflow = (type, node) => ({ id: `wf-${type}`, name: type, nodes: [node], edges: [] });

let lastRequest;
function scriptFetch(handler) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), init: init || {} };
    return handler(lastRequest);
  };
}
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: { get: () => "application/json" },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

// Credentials filled in so the node passes its pre-flight check.
function credConfig(type, extra = {}) {
  const def = NODES[type];
  const cfg = { ...configFor(type), ...extra };
  if (def.service?.auth === "aws") {
    cfg.accessKey = "AKIATESTTESTTEST";
    cfg.secretKey = "test-secret-key";
  } else if (def.service && def.service.auth !== "none") {
    cfg[def.service.credKey] = def.service.auth === "basic" ? "user:pass" : "test-credential";
  }
  return cfg;
}

const pickService = (pred) => {
  const hit = Object.entries(NODES).find(([, d]) => d.service && pred(d.service));
  assert.ok(hit, "expected a service node for this auth scheme");
  return hit[0];
};

before(() => {
  installFetch(); // baseline stub, replaced per test
  ensureFixtures();
});
after(() => {
  restoreFetch();
  cleanupFixtures();
});
beforeEach(() => {
  installFetch();
});

// ---------------------------------------------------------------------------
// Auth schemes
// ---------------------------------------------------------------------------
test("bearer service nodes send Authorization: Bearer <token>", async () => {
  const type = pickService((s) => s.auth === "bearer");
  scriptFetch(() => jsonResponse({ ok: true }));
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  assert.equal(lastRequest.init.headers.authorization, "Bearer test-credential");
});

test("basic service nodes send a base64 Authorization header", async () => {
  const type = pickService((s) => s.auth === "basic");
  scriptFetch(() => jsonResponse({ ok: true }));
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  const expected = `Basic ${Buffer.from("user:pass").toString("base64")}`;
  assert.equal(lastRequest.init.headers.authorization, expected);
});

test("custom-header service nodes put the credential in the named header", async () => {
  const type = pickService((s) => s.auth.startsWith("header:"));
  const headerName = NODES[type].service.auth.slice(7);
  scriptFetch(() => jsonResponse({ ok: true }));
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  assert.equal(lastRequest.init.headers[headerName], "test-credential");
});

test("query-param service nodes put the credential in the URL query string", async () => {
  const type = pickService((s) => s.auth.startsWith("query:"));
  const param = NODES[type].service.auth.slice(6);
  scriptFetch(() => jsonResponse({ ok: true }));
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  assert.equal(new URL(lastRequest.url).searchParams.get(param), "test-credential");
});

test("AWS service nodes sign the request with SigV4", async () => {
  const type = pickService((s) => s.auth === "aws");
  scriptFetch(() => jsonResponse({ ok: true }));
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  assert.match(String(lastRequest.init.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTEST\//);
  assert.ok(lastRequest.init.headers["x-amz-date"], "the request is dated");
  assert.ok(lastRequest.init.headers["x-amz-content-sha256"], "the payload is hashed");
});

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------
test("GET nodes send no body; POST nodes send the rendered JSON body", async () => {
  const postType = pickService((s) => s.defaultMethod === "POST" && s.auth === "bearer");
  scriptFetch(() => jsonResponse({ ok: true }));
  await executeNode(loneWorkflow(postType, mkNode(postType, credConfig(postType))), "n1", INPUT);
  assert.ok(lastRequest.init.body, "a POST carries a body");
  assert.doesNotThrow(() => JSON.parse(lastRequest.init.body));

  // a URL placeholder left empty now stops the node before sending, so pick one whose URL needs none
  const getType = pickService((s) => s.defaultMethod === "GET" && s.auth.startsWith("query:") && !`${s.base}${String(s.defaultPath).split("?")[0]}`.includes("{{"));
  scriptFetch(() => jsonResponse({ ok: true }));
  await executeNode(loneWorkflow(getType, mkNode(getType, credConfig(getType))), "n1", INPUT);
  assert.equal(lastRequest.init.body, undefined, "a GET carries no body");
});

test("a successful response is stored under storeIn with service metadata", async () => {
  const type = pickService((s) => s.auth === "bearer");
  scriptFetch(() => jsonResponse({ ok: true, id: 99 }));
  const cfg = credConfig(type, { storeIn: "payload" });
  const r = await executeNode(loneWorkflow(type, mkNode(type, cfg)), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  const out = r.outputItems[0];
  assert.deepEqual(out.payload, { ok: true, id: 99 });
  assert.equal(out._service.status, 200);
  assert.equal(out._service.type, type);
  assert.match(out._service.endpoint, /^(GET|POST|PUT|PATCH|DELETE) /);
  assert.equal(out.name, "Ada", "the inbound item is preserved");
});

test("a malformed (non-JSON) response body is kept as raw text", async () => {
  const type = pickService((s) => s.auth === "bearer");
  scriptFetch(() => jsonResponse("<html>not json</html>"));
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, true, r.error);
  assert.equal(r.outputItems[0].data, "<html>not json</html>");
});

// ---------------------------------------------------------------------------
// Failure classification (mocked 4xx / 5xx / timeout / network)
// ---------------------------------------------------------------------------
test("HTTP failure statuses map to the right error codes", async () => {
  const type = pickService((s) => s.auth === "bearer");
  const cases = [
    [401, ERROR_CODES.AUTH_FAILED.code],
    [403, ERROR_CODES.AUTH_FAILED.code],
    [429, ERROR_CODES.RATE_LIMITED.code],
    [400, ERROR_CODES.SERVICE_ERROR.code],
    [500, ERROR_CODES.SERVICE_ERROR.code],
  ];
  for (const [status, expected] of cases) {
    scriptFetch(() => jsonResponse({ error: "nope" }, status));
    const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
    assert.equal(r.success, false, `HTTP ${status} must fail the node`);
    assert.equal(r.errorCode, expected, `HTTP ${status} → code ${expected}, got ${r.errorCode} (${r.error})`);
    assert.match(String(r.error), new RegExp(String(status)), "the message mentions the status");
  }
});

test("a timeout is classified as HTTP_TIMEOUT", async () => {
  const type = pickService((s) => s.auth === "bearer");
  scriptFetch(() => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  });
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.HTTP_TIMEOUT.code, r.error);
});

test("a network failure is classified as HTTP_REQUEST_FAILED", async () => {
  const type = pickService((s) => s.auth === "bearer");
  scriptFetch(() => {
    throw new Error("fetch failed");
  });
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type))), "n1", INPUT);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.HTTP_REQUEST_FAILED.code, r.error);
});

test("invalid JSON in the node's own body field is reported, not sent", async () => {
  const type = pickService((s) => s.defaultMethod === "POST" && s.auth === "bearer");
  let called = false;
  scriptFetch(() => {
    called = true;
    return jsonResponse({ ok: true });
  });
  const r = await executeNode(loneWorkflow(type, mkNode(type, credConfig(type, { body: "{ broken" }))), "n1", INPUT);
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.INVALID_JSON.code, r.error);
  assert.equal(called, false, "no request is sent with a malformed body");
});
