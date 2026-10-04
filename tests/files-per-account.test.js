// ============================================================================
// File nodes per account — Write / Read / List File work in the workflow
// owner's own folder (data/files/users/<id>), so one account on a shared
// instance never sees another account's files; List Files accepts the folder
// root; a Write File that cannot write fails the node instead of reporting
// `written: false` on a green node.
//
// Run: node --test tests/files-per-account.test.js
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { executeNode, configFor, filesRoot } from "./helpers/node-harness.js";
import { mkNode } from "./helpers/node-scenarios.js";

const ALICE = `files-alice-${process.pid}`;
const BOB = `files-bob-${process.pid}`;

after(() => {
  for (const owner of [ALICE, BOB]) fs.rmSync(filesRoot(owner), { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(filesRoot(ALICE))); // data/files/users, only when now empty
  } catch {
    /* other accounts' folders are there — leave it */
  }
});

const runAs = (ownerId, type, extra, items = [{ json: { data: "secret of alice" } }]) =>
  executeNode({ id: `wf-${ownerId}`, ownerId, nodes: [mkNode(type, configFor(type, extra))], edges: [] }, "n1", items);

test("Write File saves into the owner's folder and Read File reads it back", async () => {
  const w = await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "data", contentMode: "text", fileName: "notes/a.txt" });
  assert.equal(w.success, true, w.error);
  assert.equal(w.outputItems[0].written, true);
  assert.equal(w.outputItems[0].path, "notes/a.txt");
  assert.equal(fs.readFileSync(`${filesRoot(ALICE)}/notes/a.txt`, "utf8"), "secret of alice");

  const r = await runAs(ALICE, "readFile", { path: "notes/a.txt" });
  assert.equal(r.success, true, r.error);
  assert.match(JSON.stringify(r.outputItems[0]), /secret of alice/);
});

test("another account cannot read or list the file", async () => {
  await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "data", contentMode: "text", fileName: "private.txt" });
  const bobInput = [{ json: { data: "bob" } }];
  const r = await runAs(BOB, "readFile", { path: "private.txt" }, bobInput);
  assert.doesNotMatch(JSON.stringify(r.outputItems), /secret of alice/);
  const l = await runAs(BOB, "listFiles", { path: "", recursive: true }, bobInput);
  assert.equal(l.success, true, l.error);
  assert.doesNotMatch(JSON.stringify(l.outputItems), /private\.txt/);
});

test("List Files lists the folder root (empty path)", async () => {
  await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "data", contentMode: "text", fileName: "root.txt" });
  const l = await runAs(ALICE, "listFiles", { path: "", recursive: false });
  assert.equal(l.success, true, l.error);
  assert.ok(l.outputItems.some((it) => it.name === "root.txt"), JSON.stringify(l.outputItems));
});

test("Write File fails the node when there is nothing to write", async () => {
  const r = await runAs(ALICE, "writeFile", { fileSource: "named", sourceFile: "never-produced.txt", fileName: "x.txt" });
  assert.equal(r.success, false);
  assert.match(String(r.error), /never-produced\.txt/);
});

test("Write File stops at the free plan's storage limit", async () => {
  // test accounts are not in the DB, so they count as free (25 MB)
  const big = [{ json: { data: "x".repeat(26 * 1024 * 1024) } }];
  const r = await runAs(BOB, "writeFile", { fileSource: "field", sourceField: "data", contentMode: "text", fileName: "big.txt" }, big);
  assert.equal(r.success, false);
  assert.match(String(r.error), /storage is full \(25 MB/);
  assert.equal(fs.existsSync(`${filesRoot(BOB)}/big.txt`), false);
});

test("Write File fails the node on a path that leaves the folder", async () => {
  const r = await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "data", contentMode: "text", fileName: "../escape.txt" });
  assert.equal(r.success, false);
  assert.match(String(r.error), /must stay inside/);
});

// The BTC-price workflow from a bug report: the price was dragged into "Field
// with the file", which drops a {{template}} (here with a stray brace) where a
// field name belongs, and "Save as" repeated the data/files prefix. Both used
// to fail with BF-6005.
test("Write File accepts a dragged-in {{field}} and a data/files/ prefix", async () => {
  const items = [{ json: { result: { price: 95123.45 } } }];
  const r = await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "}{{result.price}}", contentMode: "text", fileName: "data/files/btc.txt" }, items);
  assert.equal(r.success, true, r.error);
  assert.equal(r.outputItems[0].path, "btc.txt");
  assert.equal(fs.readFileSync(`${filesRoot(ALICE)}/btc.txt`, "utf8"), "95123.45");
});

test("Write File renders a mixed template as the file's text", async () => {
  const items = [{ json: { result: { price: 80000 } } }];
  const r = await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "BTC is {{result.price}} USD", contentMode: "text", fileName: "btc-line.txt" }, items);
  assert.equal(r.success, true, r.error);
  assert.equal(fs.readFileSync(`${filesRoot(ALICE)}/btc-line.txt`, "utf8"), "BTC is 80000 USD");
});

test("Write File's missing-field error names the field and what the item has", async () => {
  const r = await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "nope", contentMode: "text", fileName: "n.txt" }, [{ json: { result: 1 } }]);
  assert.equal(r.success, false);
  assert.match(String(r.error), /looked in "nope".*has: result/);
});

test("deleting an account erases its file folder, and only its own", async () => {
  const { removeAccountFolder } = await import("../server/disk.js");
  await runAs(ALICE, "writeFile", { fileSource: "field", sourceField: "data", contentMode: "text", fileName: "gone.txt" });
  await runAs(BOB, "writeFile", { fileSource: "field", sourceField: "data", contentMode: "text", fileName: "stays.txt" }, [{ json: { data: "bob" } }]);
  assert.equal(removeAccountFolder(ALICE), true);
  assert.equal(fs.existsSync(filesRoot(ALICE)), false);
  assert.equal(fs.existsSync(`${filesRoot(BOB)}/stays.txt`), true);
  assert.equal(removeAccountFolder(""), false, "no id never removes the shared root");
  assert.equal(removeAccountFolder("../.."), false);
});
