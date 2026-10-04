// ============================================================================
// Feeds & Sources nodes — presets that run the RSS Read logic against a
// service-specific feed URL. Edge cases, dropdown options, URL building,
// missing inputs and the Atom / podcast parser fields.
//
// Run: node --test tests/nodes-feeds.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { ERROR_CODES } from "../shared/errors.js";
import { NODES, executeNode, configFor, installFetch, restoreFetch, ensureFixtures, cleanupFixtures, capturedRequests } from "./helpers/node-harness.js";
import { typesIn, registerEdgeCaseSweeps, registerEnumSweep, mkNode, loneWorkflow, INPUT, mockFetch, jsonResponse } from "./helpers/node-scenarios.js";
import { parseRssFeed } from "../server/fileextract.js";

const TYPES = typesIn("feeds");

before(() => {
  installFetch();
  ensureFixtures();
});
after(() => {
  restoreFetch();
  cleanupFixtures();
});
beforeEach(() => {
  installFetch();
});

registerEdgeCaseSweeps("feeds", TYPES);
registerEnumSweep("feeds", TYPES);

const run = (type, extra = {}) => executeNode(loneWorkflow(type, mkNode(type, configFor(type, extra))), "n1", INPUT);

test("the Feeds & Sources group exists and every preset carries a feed URL template", () => {
  assert.ok(TYPES.length >= 15, `expected at least 15 feed presets, got ${TYPES.length}`);
  for (const type of TYPES) {
    assert.match(NODES[type].feed?.url || "", /\{\{\w+\}\}/, `${type} has a feed URL template`);
  }
});

test("every feed preset reads items offline", async () => {
  const failures = [];
  for (const type of TYPES) {
    const r = await run(type);
    const out = r.success ? r.outputItems?.[0] : null;
    if (!r.success) failures.push(`${type}: ${r.error}`);
    else if (!(out?.count >= 1)) failures.push(`${type}: no items`);
  }
  assert.deepEqual(failures, []);
});

test("preset inputs are URL-encoded into the service URL", async () => {
  capturedRequests.length = 0;
  await run("googleNewsFeed", { query: "ai & automation", language: "de" });
  await run("mastodonFeed", { instance: "https://fosstodon.org/", account: "@alice" });
  const urls = capturedRequests.map((r) => String(r.url || r));
  assert.ok(urls.some((u) => u.includes("q=ai%20%26%20automation&hl=de")), urls.join("\n"));
  assert.ok(urls.some((u) => u.startsWith("https://fosstodon.org/@alice.rss")), urls.join("\n"));
});

test("an empty preset input fails with MISSING_CONFIG before any request", async () => {
  capturedRequests.length = 0;
  const r = await run("githubReleasesFeed", { owner: "", repo: "node" });
  assert.equal(r.success, false);
  assert.equal(r.errorCode, ERROR_CODES.MISSING_CONFIG.code);
  assert.equal(capturedRequests.length, 0);
});

test("rss read and every preset fail (never report success) on an HTTP error", async () => {
  const failures = [];
  for (const [status, code] of [[401, "AUTH_FAILED"], [429, "RATE_LIMITED"], [500, "SERVICE_ERROR"]]) {
    for (const type of ["rssRead", ...TYPES]) {
      mockFetch(() => jsonResponse("<error/>", status));
      const r = await run(type);
      if (r.success) failures.push(`${type} [${status}]: reported success`);
      else if (r.errorCode !== ERROR_CODES[code].code) failures.push(`${type} [${status}]: ${r.errorCode} (expected ${code})`);
    }
  }
  installFetch();
  assert.deepEqual(failures, []);
});

test("Atom entries use the rel=alternate link and the feed title", () => {
  const { feedTitle, items } = parseRssFeed(
    '<feed><title>Releases</title><entry><title>v1</title><link rel="replies" href="https://x/r"/><link rel="alternate" href="https://x/v1"/><author><name>alice</name></author><category term="stable"/></entry></feed>'
  );
  assert.equal(feedTitle, "Releases");
  assert.equal(items[0].link, "https://x/v1");
  assert.equal(items[0].author, "alice");
  assert.deepEqual(items[0].categories, ["stable"]);
});

test("podcast items carry the enclosure and duration", () => {
  const { items } = parseRssFeed(
    '<rss><channel><title>Pod</title><item><title>Ep 1</title><link>https://p/1</link><enclosure url="https://p/1.mp3" type="audio/mpeg" length="42"/><itunes:duration>31:00</itunes:duration></item></channel></rss>'
  );
  assert.deepEqual(items[0].enclosure, { url: "https://p/1.mp3", type: "audio/mpeg", length: 42 });
  assert.equal(items[0].duration, "31:00");
});
