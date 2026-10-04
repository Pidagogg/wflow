// ============================================================================
// {{path}} resolution (shared/paths.js): the exact path wins, otherwise the
// field is found where a node saved it (e.g. {{price}} → result.price).
//
// Run: node --test tests/template-paths.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePath } from "../shared/paths.js";

const item = { symbol: "BTC-USD", result: { price: 75000.5, raw: { price: "75000.50" }, symbol: "BTC-USD" }, rows: [{ total: 3 }] };

test("the exact path always wins", () => {
  assert.equal(resolvePath(item, "result.price"), 75000.5);
  assert.equal(resolvePath(item, "symbol"), "BTC-USD");
  assert.equal(resolvePath({ raw: "top", nested: { raw: "deep" } }, "raw"), "top");
});

test("a field saved under a result key is found by its own name, shallowest first", () => {
  assert.equal(resolvePath(item, "price"), 75000.5, "result.price, not result.raw.price");
  assert.equal(resolvePath(item, "raw.price"), "75000.50", "the rest of the path continues exactly");
  assert.equal(resolvePath(item, "total"), 3, "inside a table (array of rows) too");
});

test("missing fields stay missing", () => {
  assert.equal(resolvePath(item, "volume"), undefined);
  assert.equal(resolvePath(item, "price.nope"), undefined);
  assert.equal(resolvePath(null, "x"), undefined);
});
