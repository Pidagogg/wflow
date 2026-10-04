// ============================================================================
// CSV parsing (shared/csv.js) — backs the data-table CSV import.
//
// Covers the pieces the import endpoint relies on: quoted fields with embedded
// delimiters / newlines, delimiter detection for comma / tab / semicolon / pipe
// files, header handling (including duplicate and empty header cells) and the
// column mapping of the resulting rows.
//
// Run: node --test tests/csv.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDelimited, detectDelimiter, csvToTable } from "../shared/csv.js";

test("parseDelimited handles quotes, embedded delimiters and newlines", () => {
  const rows = parseDelimited('name,note\nAda,"says ""hi"", loudly"\nLin,"two\nlines"');
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Ada", 'says "hi", loudly'],
    ["Lin", "two\nlines"],
  ]);
});

test("parseDelimited drops blank lines and skips a BOM-free empty input", () => {
  assert.deepEqual(parseDelimited("\n\n"), []);
  assert.deepEqual(parseDelimited("a,b\n\n,c\n"), [["a", "b"], ["", "c"]]);
});

test("detectDelimiter picks the separator used by most lines", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a|b|c\n1|2|3"), "|");
  assert.equal(detectDelimiter("single column"), ",");
});

test("detectDelimiter ignores delimiters inside quoted fields", () => {
  assert.equal(detectDelimiter('name;note\nAda;"a, b, c"'), ";");
});

test("csvToTable builds columns and object rows from a header row", () => {
  const { delimiter, columns, rows } = csvToTable("id,name\n1,Ada\n2,Lin");
  assert.equal(delimiter, ",");
  assert.deepEqual(columns, ["id", "name"]);
  assert.deepEqual(rows, [{ id: "1", name: "Ada" }, { id: "2", name: "Lin" }]);
});

test("csvToTable names columns A, B, … when there is no header row", () => {
  const { columns, rows } = csvToTable("1,Ada\n2,Lin", { headerRow: false });
  assert.deepEqual(columns, ["A", "B"]);
  assert.deepEqual(rows, [{ A: "1", B: "Ada" }, { A: "2", B: "Lin" }]);
});

test("csvToTable de-duplicates header names and pads ragged rows", () => {
  // the widest line wins the row width, so a field past the last header name
  // becomes its own column instead of being dropped
  const { columns, rows } = csvToTable("name,name,,extra\nAda,9\nLin,7,x,y,z");
  assert.deepEqual(columns, ["name", "name 2", "C", "extra", "E"]);
  assert.deepEqual(rows, [
    { name: "Ada", "name 2": "9", C: "", extra: "", E: "" },
    { name: "Lin", "name 2": "7", C: "x", extra: "y", E: "z" },
  ]);
});

test("csvToTable honours an explicit delimiter and the row cap", () => {
  const tsv = csvToTable("a\tb\n1\t2", { delimiter: "\t" });
  assert.deepEqual(tsv.columns, ["a", "b"]);
  const capped = csvToTable("n\n1\n2\n3", { maxRows: 2 });
  assert.equal(capped.rows.length, 2);
});

test("csvToTable imports a header-only file as an empty table", () => {
  const { columns, rows } = csvToTable("id,name");
  assert.deepEqual(columns, ["id", "name"]);
  assert.deepEqual(rows, []);
});
