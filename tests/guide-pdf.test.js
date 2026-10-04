// ============================================================================
// User guide PDF (Settings → Download documentation).
//
// The footer is drawn inside the bottom margin. PDFKit treats text below the
// margin as overflow and silently starts a new page for it, which used to put
// an empty page after every real one. A guide that fits on one page must
// therefore come out as exactly one page, and the real guide must not double.
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { renderGuidePdf } from "../server/guide-pdf.js";

const pageCount = (buf) => (buf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;

test("a one-page guide renders as one page (no blank overflow page)", async () => {
  const pdf = await renderGuidePdf("# Title\n\nOne short paragraph.\n\n- a\n- b\n");
  assert.equal(pageCount(pdf), 1);
});

test("a long guide has no blank page after each real page", async () => {
  const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12);
  const md = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${para}\n`).join("\n");
  const pages = pageCount(await renderGuidePdf(md));
  // 40 sections of ~7 lines each fill a handful of A4 pages, never dozens.
  assert.ok(pages >= 3 && pages <= 12, `expected a few pages, got ${pages}`);

  const guide = pageCount(await renderGuidePdf(fs.readFileSync(new URL("../docs/guide.md", import.meta.url), "utf8")));
  const half = pageCount(await renderGuidePdf(fs.readFileSync(new URL("../docs/guide.md", import.meta.url), "utf8").slice(0, 2000)));
  assert.ok(half <= 2, "the first 2000 characters fit on one or two pages");
  assert.ok(guide > 1);
});
