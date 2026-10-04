// ----------------------------------------------------------------------------
// W FLOW — user guide → PDF renderer (Settings → Download PDF)
//
// Renders docs/guide.md to a real PDF with PDFKit — no browser, no HTML, no
// external fonts. It supports exactly the markdown subset the guide uses:
// headings, paragraphs, **bold** / *italic* / `code` inline, bullet + numbered
// lists, simple pipe tables, fenced code blocks and "> Note / Tip" callouts.
// Standard PDF fonts only cover WinAnsi, so a few glyphs the guide uses
// (→ ✓ ≈ 🔒 ● ▶) are mapped to ASCII lookalikes before rendering.
// ----------------------------------------------------------------------------
import PDFDocument from "pdfkit";

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_ITALIC = "Helvetica-Oblique";
const FONT_BOLD_ITALIC = "Helvetica-BoldOblique";
const FONT_MONO = "Courier";

const PAGE_W = 595.28; // A4 portrait (points)
const PAGE_H = 841.89;
const MARGIN = 52;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - MARGIN;

const INK = "#1f2328";
const HEADING_INK = "#111827";
const MUTED = "#57606a";

// Chars outside WinAnsi that appear in docs/guide.md, mapped to ASCII stand-ins.
const GLYPH_MAP = {
  "\u2192": "->", // →
  "\u2713": "OK", // ✓
  "\u2248": "~=", // ≈
  "\u{1F512}": "", // 🔒
  "\u25CF": "*", // ●
  "\u25B6": ">", // ▶
};

function sanitize(md) {
  return md.replace(/[\u2192\u2713\u2248\u{1F512}\u25CF\u25B6]/gu, (ch) => GLYPH_MAP[ch]);
}

export function renderGuidePdf(markdown) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: { Title: "W flow — User Guide", Author: "W flow" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let y = MARGIN;
    let pageNo = 1;

    const leading = (size) => Math.round(size * 1.45);
    const fontFor = (r) => {
      if (r.mono) return r.bold ? FONT_MONO : FONT_MONO;
      if (r.bold && r.italic) return FONT_BOLD_ITALIC;
      if (r.bold) return FONT_BOLD;
      if (r.italic) return FONT_ITALIC;
      return FONT;
    };
    const runWidth = (r, size) => doc.widthOfString(r.text, { font: fontFor(r), size });

    // The footer sits inside the bottom margin. PDFKit treats any text drawn
    // below `page.margins.bottom` as overflow and silently adds a page for it,
    // which left every second page blank — so lift the margin while drawing.
    const footer = () => {
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font(FONT).fontSize(8).fillColor(MUTED);
      doc.text(`W flow — User Guide   ·   page ${pageNo}`, MARGIN, PAGE_H - 28, { lineBreak: false });
      doc.page.margins.bottom = bottom;
    };
    const newPage = () => {
      footer();
      doc.addPage();
      pageNo++;
      y = MARGIN;
    };
    const ensure = (h) => {
      if (y + h > BOTTOM) newPage();
    };

    // --- inline markdown → styled runs --------------------------------------
    function inlineRuns(text) {
      const runs = [];
      const re = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
      let last = 0;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) runs.push({ text: text.slice(last, m.index) });
        const tok = m[0];
        if (tok.startsWith("***") && tok.endsWith("***")) runs.push({ text: tok.slice(3, -3), bold: true, italic: true });
        else if (tok.startsWith("**") && tok.endsWith("**")) runs.push({ text: tok.slice(2, -2), bold: true });
        else if (tok.startsWith("*") && tok.endsWith("*")) runs.push({ text: tok.slice(1, -1), italic: true });
        else if (tok.startsWith("`") && tok.endsWith("`")) runs.push({ text: tok.slice(1, -1), mono: true });
        last = re.lastIndex;
      }
      if (last < text.length) runs.push({ text: text.slice(last) });
      return runs;
    }

    // Greedy word-wrap of styled runs into lines that fit maxWidth.
    function wrapRuns(runs, maxWidth, size) {
      const lines = [];
      let line = [];
      let lineW = 0;
      const flush = () => {
        if (line.length) {
          lines.push(line);
          line = [];
          lineW = 0;
        }
      };
      for (const run of runs) {
        const tokens = run.text.match(/\S+\s*|\s+/g) || [];
        for (const tok of tokens) {
          if (/^\s+$/.test(tok) && line.length === 0) continue; // no leading space on a fresh line
          const tr = { ...run, text: tok };
          const w = runWidth(tr, size);
          if (lineW + w > maxWidth && line.length) flush();
          if (w > maxWidth) {
            // a single token wider than the line — hard-break it
            let rest = tok.replace(/\s+$/, "");
            while (rest.length) {
              let lo = 1;
              let hi = rest.length;
              let best = 1;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (runWidth({ ...run, text: rest.slice(0, mid) }, size) <= maxWidth) {
                  best = mid;
                  lo = mid + 1;
                } else hi = mid - 1;
              }
              if (line.length) flush();
              line.push({ ...run, text: rest.slice(0, best) });
              flush();
              rest = rest.slice(best);
            }
          } else {
            line.push(tr);
            lineW += w;
          }
        }
      }
      flush();
      return lines;
    }

    // Draw one already-wrapped line of runs at (x, y); does not advance y.
    function drawLineRuns(line, x, size, color) {
      let cx = x;
      for (let i = 0; i < line.length; i++) {
        const r = line[i];
        if (!r.text) continue;
        doc.font(fontFor(r)).fontSize(size).fillColor(color || INK);
        doc.text(r.text, cx, y, { continued: i < line.length - 1, lineBreak: false });
        cx += runWidth(r, size);
      }
    }

    // Wrap + draw a paragraph-like run list, advancing y and breaking pages.
    function drawRuns(runs, x, size, opts = {}) {
      const width = opts.width || CONTENT_W - (opts.indent || 0);
      const lh = leading(size);
      const lines = wrapRuns(runs, width, size);
      for (const line of lines) {
        ensure(lh);
        drawLineRuns(line, x + (opts.indent || 0), size, opts.color);
        y += lh;
      }
    }

    // --- blocks --------------------------------------------------------------
    function drawHeading(level, text) {
      const size = { 1: 19, 2: 14, 3: 12, 4: 11 }[level] || 11;
      const runs = inlineRuns(text).map((r) => ({ ...r, bold: true }));
      const lh = leading(size);
      ensure(lh + 8);
      y += level === 1 ? 2 : 10;
      drawRuns(runs, MARGIN, size, { color: HEADING_INK });
      if (level === 1) {
        // accent rule under the document title
        ensure(3);
        y += 4;
        doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).lineWidth(1.4).strokeColor("#2563eb").stroke();
        y += 12;
      } else {
        y += 3;
      }
    }

    function drawParagraph(text) {
      drawRuns(inlineRuns(text), MARGIN, 10, { color: INK });
      y += 5;
    }

    function drawList(items, ordered) {
      const size = 10;
      const lh = leading(size);
      const bullet = ordered ? "•" : "•";
      const px = ordered
        ? doc.widthOfString(`${items.length}. `, { font: FONT_BOLD, size })
        : doc.widthOfString(`${bullet}  `, { font: FONT, size });
      for (let idx = 0; idx < items.length; idx++) {
        const lines = wrapRuns(inlineRuns(items[idx]), CONTENT_W - px, size);
        const label = ordered ? `${idx + 1}. ` : `${bullet}  `;
        for (let j = 0; j < lines.length; j++) {
          ensure(lh);
          if (j === 0) {
            doc.font(ordered ? FONT_BOLD : FONT).fontSize(size).fillColor(INK);
            doc.text(label, MARGIN, y, { lineBreak: false });
          }
          drawLineRuns(lines[j], MARGIN + px, size, INK);
          y += lh;
        }
      }
      y += 4;
    }

    function drawCode(codeLines) {
      const size = 8.5;
      const lh = leading(size);
      const pad = 9;
      const wrapped = [];
      for (const raw of codeLines) {
        for (const wl of wrapCodeLine(raw, CONTENT_W - pad * 2, size)) wrapped.push(wl);
      }
      const h = wrapped.length * lh + pad * 2;
      ensure(h);
      doc.roundedRect(MARGIN, y, CONTENT_W, h, 4).fill("#f6f8fa");
      y += pad;
      for (const wl of wrapped) {
        doc.font(FONT_MONO).fontSize(size).fillColor("#24292f");
        doc.text(wl, MARGIN + pad, y, { lineBreak: false });
        y += lh;
      }
      y += pad + 8;
    }

    // Plain-text (mono) wrap that preserves leading whitespace — significant in
    // curl examples and error messages.
    function wrapCodeLine(text, maxWidth, size) {
      if (!text.trim()) return [text];
      const m = text.match(/^( *)(.*)$/);
      const effective = m[1] && m[2] ? m[1] + m[2] : text;
      const toks = effective.match(/\S+\s*|\s+/g) || [];
      const out = [];
      let cur = "";
      let curW = 0;
      const push = () => {
        if (cur.length) {
          out.push(cur);
          cur = "";
          curW = 0;
        }
      };
      for (const t of toks) {
        if (/^\s+$/.test(t) && cur.length === 0) continue;
        const w = doc.widthOfString(t, { font: FONT_MONO, size });
        if (curW + w > maxWidth && cur.length) push();
        if (w > maxWidth) {
          let rest = t.replace(/\s+$/, "");
          while (rest.length) {
            let lo = 1;
            let hi = rest.length;
            let best = 1;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              if (doc.widthOfString(rest.slice(0, mid), { font: FONT_MONO, size }) <= maxWidth) {
                best = mid;
                lo = mid + 1;
              } else hi = mid - 1;
            }
            if (cur.length) push();
            out.push(rest.slice(0, best));
            rest = rest.slice(best);
          }
        } else {
          cur += t;
          curW += w;
        }
      }
      push();
      return out;
    }

    function drawNote(lines) {
      const runs = inlineRuns(lines.join(" "));
      const size = 9.5;
      const lh = leading(size);
      const ws = wrapRuns(runs, CONTENT_W - 26, size);
      const h = ws.length * lh + 12;
      ensure(h);
      doc.roundedRect(MARGIN, y, CONTENT_W, h, 4).fill("#f1f5f9");
      doc.rect(MARGIN, y, 3.5, h).fill("#64748b");
      y += 6;
      for (const line of ws) {
        drawLineRuns(line, MARGIN + 14, size, "#1f2937");
        y += lh;
      }
      y += 6 + 7;
    }

    function splitRow(line) {
      const body = line.trim().replace(/^\||\|$/g, "");
      return body.split("|").map((c) => c.trim());
    }
    function isSepRow(line) {
      const cells = splitRow(line);
      return cells.length > 0 && cells.every((c) => c === "" || /^:?-{2,}:?$/.test(c));
    }

    function drawTable(header, rows) {
      const size = 9;
      const lh = leading(size);
      const padX = 7;
      const padY = 5;
      const allRows = [header, ...rows];
      const nCols = header.length;

      // Natural column widths: widest cell (sampled to 60 chars so one huge
      // cell can't dominate), capped so no column eats the page.
      const contentW = [];
      for (let c = 0; c < nCols; c++) {
        let w = 0;
        for (const r of allRows) {
          const sample = String(r[c] || "").replace(/\s+/g, " ").slice(0, 60);
          w = Math.max(w, doc.widthOfString(sample, { font: FONT_BOLD, size }) + padX * 2);
        }
        contentW.push(w);
      }
      let widths = contentW.map((w) => Math.min(w, CONTENT_W * 0.5));
      let total = widths.reduce((a, b) => a + b, 0);
      if (total > CONTENT_W) {
        widths = widths.map((w) => Math.max(Math.floor((w * CONTENT_W) / total), 30));
        total = widths.reduce((a, b) => a + b, 0);
      }
      if (total < CONTENT_W) {
        // fill the page so tables read as one aligned block
        const extra = CONTENT_W - total;
        widths = widths.map((w) => w + Math.floor((extra * w) / total));
      }
      const colX = [];
      let x = MARGIN;
      for (const w of widths) {
        colX.push(x);
        x += w;
      }

      const headerRuns = header.map((c) => inlineRuns(c).map((r) => ({ ...r, bold: true })));

      const drawRow = (cells, isHeader, cellRuns) => {
        const wrapped = cells.map((c, ci) => wrapRuns(cellRuns[ci], widths[ci] - padX * 2, size));
        const rowH = Math.max(...wrapped.map((l) => l.length), 1) * lh + padY * 2;
        if (y + rowH > BOTTOM) {
          // continue on a fresh page, repeating the header row
          newPage();
          drawRow(header, true, headerRuns);
        }
        if (isHeader) doc.rect(MARGIN, y, CONTENT_W, rowH).fill("#eef1f5");
        let cy = y + padY;
        for (let ci = 0; ci < nCols; ci++) {
          const lines = wrapped[ci];
          for (const line of lines) {
            if (cy + lh > y + rowH - padY + 1) break;
            drawLineRuns(line, colX[ci] + padX, size, isHeader ? HEADING_INK : INK);
            cy += lh;
          }
        }
        doc.rect(MARGIN, y, CONTENT_W, rowH).lineWidth(0.5).strokeColor("#d0d7de").stroke();
        if (isHeader) {
          doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).lineWidth(1).strokeColor("#9aa4b2").stroke();
        }
        y += rowH;
      };
      drawRow(header, true, headerRuns);
      for (const row of rows) {
        drawRow(row, false, row.map((c) => inlineRuns(c)));
      }
      y += 8;
    }

    // --- parse the markdown --------------------------------------------------
    const lines = sanitize(markdown).split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trim = line.trim();

      // fenced code block
      if (trim.startsWith("```")) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        drawCode(buf);
        continue;
      }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        drawHeading(h[1].length, h[2]);
        i++;
        continue;
      }

      if (line === "") {
        i++;
        continue;
      }

      // pipe table
      if (trim.startsWith("|")) {
        const header = splitRow(lines[i]);
        let next = i + 1;
        if (next < lines.length && isSepRow(lines[next])) next++;
        const rows = [];
        while (next < lines.length && lines[next].trim().startsWith("|")) {
          rows.push(splitRow(lines[next]));
          next++;
        }
        drawTable(header, rows);
        i = next;
        continue;
      }

      // "> Note / Tip" callout
      if (trim.startsWith(">")) {
        const buf = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          buf.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        drawNote(buf);
        continue;
      }

      // numbered list
      const ol = trim.match(/^\d+[.)]\s+(.*)/);
      if (ol) {
        const items = [ol[1]];
        i++;
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
          i++;
        }
        drawList(items, true);
        continue;
      }

      // bullet list
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
          i++;
        }
        drawList(items, false);
        continue;
      }

      // paragraph — consume contiguous lines that start no other block
      const para = [];
      const isBlockStart = (l) => {
        const t = l.trim();
        return (
          t === "" ||
          /^(#{1,4})\s+/.test(l) ||
          t.startsWith("```") ||
          t.startsWith("|") ||
          t.startsWith(">") ||
          /^\s*[-*]\s+/.test(l) ||
          /^\s*\d+[.)]\s+/.test(l)
        );
      };
      while (i < lines.length && !isBlockStart(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) drawParagraph(para.join(" "));
    }

    footer();
    doc.end();
  });
}