// ============================================================================
// W FLOW — CSV / TSV parsing
//
// Shared helpers for turning pasted or uploaded delimited text into table
// columns + rows. Used by the data-table import endpoint (server/index.js) and
// covered by tests/csv.test.js. Dependency-free, so the browser could use it
// too if an import ever needs to be previewed client-side.
// ============================================================================

/** Parse delimited text into a matrix of strings (RFC 4180 quoting, "" escape). */
export function parseDelimited(text, delimiter = ",") {
  const d = delimiter || ",";
  const src = String(text ?? "");
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === d) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// Spreadsheet-style column name for a 0-based index: A..Z, AA, AB, …
function columnLetter(index) {
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** Which delimiter the text most likely uses — the one with the most, most consistent columns. */
export function detectDelimiter(text) {
  const lines = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 10);
  if (!lines.length) return ",";
  let best = ",";
  let bestScore = 0;
  for (const d of [",", "\t", ";", "|"]) {
    const counts = lines.map((l) => (parseDelimited(l, d)[0] || []).length);
    const max = Math.max(...counts);
    if (max < 2) continue;
    const min = Math.min(...counts);
    // A delimiter that splits every sampled line into the same number of fields
    // wins over one that only appears in some of them.
    const score = min === max ? max * 2 : max;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Turn delimited text into `{ delimiter, columns, rows }`, where every row is an
 * object keyed by the column names. `headerRow` (default true) uses the first
 * line as the column names — otherwise they are A, B, C ….
 */
export function csvToTable(text, { delimiter = "auto", headerRow = true, maxRows = 5000 } = {}) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const delim = delimiter && delimiter !== "auto" ? delimiter : detectDelimiter(src);
  const limit = Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0;
  let matrix = parseDelimited(src, delim);
  if (limit) matrix = matrix.slice(0, headerRow ? limit + 1 : limit);

  const headers = headerRow ? matrix.shift() || [] : [];
  const width = matrix.reduce((max, r) => Math.max(max, r.length), headers.length);
  const columns = [];
  for (let i = 0; i < width; i++) {
    const base = String(headers[i] ?? "").trim() || columnLetter(i);
    let name = base;
    let n = 2;
    while (columns.includes(name)) name = `${base} ${n++}`;
    columns.push(name);
  }

  const rows = matrix.map((r) => {
    const row = {};
    columns.forEach((c, i) => {
      const v = r[i];
      row[c] = v === undefined || v === null ? "" : String(v);
    });
    return row;
  });

  return { delimiter: delim, columns, rows };
}
