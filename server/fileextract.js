// ============================================================================
// W FLOW — file extraction engine
// Best-effort extractors for the common file types in shared/filetypes.js.
// Uses only Node built-ins (zlib, Buffer) plus exceljs for .xlsx — no new
// dependencies. Every extractor is defensive: on failure it records an `error`
// note instead of throwing, so downstream nodes still get useful metadata.
//
// The main entry point is extractFileContent(). Each extractor returns a
// partial result object; the caller merges { detected, metadata, text,
// structured, rows, entries, error } into a single shape.
// ============================================================================
import { detectFileType, categoryLabel } from "../shared/filetypes.js";
import { inflateSync, inflateRawSync, gunzipSync, deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";

const DEFAULT_MAX_TEXT = 100000;
const DEFAULT_MAX_ROWS = 1000;

// ----------------------------------------------------------------------------
// Text helpers
// ----------------------------------------------------------------------------

function decodeBuffer(buf, encoding) {
  const enc = encoding || "utf-8";
  if (enc === "latin1") return buf.toString("latin1");
  if (enc === "utf-16le") return buf.toString("utf16le");
  if (enc === "base64") return buf.toString("base64");
  return buf.toString("utf8");
}

function truncateText(s, max) {
  const limit = Math.max(1, Number(max || DEFAULT_MAX_TEXT));
  if (s.length <= limit) return s;
  return s.slice(0, limit) + "\n… [truncated]";
}

function stripXmlTags(xml) {
  return String(xml)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ----------------------------------------------------------------------------
// CSV
// ----------------------------------------------------------------------------

function parseCsv(text, delimiter) {
  const d = delimiter || ",";
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === d) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
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

// ----------------------------------------------------------------------------
// JSON / JSONL
// ----------------------------------------------------------------------------

function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// XML → tree
// ----------------------------------------------------------------------------

export function xmlToTree(xml) {
  const text = String(xml)
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const root = parseXmlNode(text);
  if (!root) throw new Error("Could not parse XML");
  return root.node;
}

// Parse an RSS / Atom feed into { feedTitle, items } where each item carries
// title / link / description / pubDate / guid, plus author / categories and a
// media enclosure (podcast audio, video) when the feed has them. Shared by the
// RSS Read action and the Feeds & Sources presets (server/executor.js) and the
// RSS trigger's background poller (server/scheduler.js) so all of them see
// exactly the same items.
export function parseRssFeed(xml, limit = 200) {
  const feedItems = [];
  let feedTitle = "";
  try {
    const tree = xmlToTree(xml);
    const txt = (v) => (typeof v === "string" ? v : Array.isArray(v) ? txt(v[0]) : v?.text ?? "");
    const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const channel = tree.children?.channel;
    // RSS: <rss><channel><title>. Atom: <feed><title>. RDF (RSS 1.0): <rdf:RDF><channel>.
    feedTitle = txt(channel?.children?.title) || txt(tree.children?.title);
    // RSS: <rss><channel><item>. Atom: <feed><entry>. (item/entry may be a
    // single node when the feed has exactly one entry.)
    const itemsNode =
      channel?.children?.item || channel?.children?.entry || tree.children?.item || tree.children?.entry;
    const list = asList(itemsNode);
    for (const n of list.slice(0, Math.max(0, Math.min(Number(limit) || 200, 500)))) {
      const ch = n.children || {};
      // RSS <link>url</link>; Atom <link href="…"/>, possibly several of them
      // (alternate / enclosure / replies …) — prefer rel="alternate".
      let link = "";
      const links = asList(ch.link);
      for (const l of links) {
        if (typeof l === "string" || l?.text) {
          link = txt(l);
          break;
        }
      }
      if (!link) {
        const alt = links.find((l) => l?.attributes?.href && (!l.attributes.rel || l.attributes.rel === "alternate"));
        link = alt?.attributes?.href || links.find((l) => l?.attributes?.href)?.attributes?.href || "";
      }
      // author: RSS <author>/<dc:creator>, Atom <author><name>
      const authorNode = asList(ch.author)[0];
      const author = txt(authorNode?.children?.name) || txt(authorNode) || txt(ch["dc:creator"]) || txt(ch["itunes:author"]);
      const categories = asList(ch.category)
        .map((c) => txt(c) || c?.attributes?.term || "")
        .filter(Boolean);
      // media: RSS <enclosure url type length/>, Atom <link rel="enclosure">, Media RSS
      const enc =
        asList(ch.enclosure)[0]?.attributes ||
        links.find((l) => l?.attributes?.rel === "enclosure")?.attributes ||
        asList(ch["media:content"])[0]?.attributes ||
        asList(ch["media:group"])[0]?.children?.["media:content"]?.attributes;
      const item = {
        title: txt(ch.title),
        link,
        description: txt(ch.description || ch.content || ch.summary || ch["media:group"]?.children?.["media:description"]),
        pubDate: txt(ch.pubDate || ch.updated || ch.published || ch["dc:date"]),
        guid: txt(ch.guid || ch.id),
      };
      if (author) item.author = author;
      if (categories.length) item.categories = categories;
      if (enc && (enc.url || enc.href)) {
        item.enclosure = { url: enc.url || enc.href, type: enc.type || "", length: Number(enc.length || enc.fileSize || 0) || 0 };
      }
      const duration = txt(ch["itunes:duration"]);
      if (duration) item.duration = duration;
      feedItems.push(item);
    }
  } catch {
    // unparseable body — return whatever could be read
  }
  return { feedTitle, items: feedItems };
}

function parseXmlNode(s) {
  const tagMatch = s.match(/^<([\w:.-]+)([^>]*)>/);
  if (!tagMatch) return null;
  const tag = tagMatch[1];
  const attrs = {};
  const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let am;
  while ((am = attrRe.exec(tagMatch[2]))) attrs[am[1]] = am[3] ?? am[4];
  const selfClosing = /\/\s*>$/.test(tagMatch[0]);
  let rest = s.slice(tagMatch[0].length);
  const children = [];
  let textContent = "";
  if (selfClosing) {
    return { node: { tag, attributes: Object.keys(attrs).length ? attrs : undefined, text: "" }, rest };
  }
  while (rest.length) {
    if (rest.startsWith(`</${tag}>`)) {
      rest = rest.slice(tag.length + 3);
      const out = { tag };
      if (Object.keys(attrs).length) out.attributes = attrs;
      const t = textContent.trim();
      if (children.length) {
        const grouped = {};
        for (const c of children) {
          if (!grouped[c.tag]) grouped[c.tag] = [];
          grouped[c.tag].push(c);
        }
        out.children = {};
        for (const [t2, list] of Object.entries(grouped)) out.children[t2] = list.length === 1 ? list[0] : list;
      }
      if (t) out.text = t;
      return { node: out, rest };
    }
    if (rest.startsWith("<")) {
      if (rest.startsWith("<![CDATA[")) {
        const end = rest.indexOf("]]>");
        if (end === -1) break;
        textContent += rest.slice(9, end);
        rest = rest.slice(end + 3);
        continue;
      }
      const child = parseXmlNode(rest);
      if (!child) {
        rest = rest.slice(1);
        continue;
      }
      children.push(child.node);
      rest = child.rest;
      continue;
    }
    const next = rest.indexOf("<");
    if (next === -1) {
      textContent += rest;
      rest = "";
    } else {
      textContent += rest.slice(0, next);
      rest = rest.slice(next);
    }
  }
  const out = { tag };
  if (Object.keys(attrs).length) out.attributes = attrs;
  const t = textContent.trim();
  if (children.length) {
    const grouped = {};
    for (const c of children) {
      if (!grouped[c.tag]) grouped[c.tag] = [];
      grouped[c.tag].push(c);
    }
    out.children = {};
    for (const [t2, list] of Object.entries(grouped)) out.children[t2] = list.length === 1 ? list[0] : list;
  }
  if (t) out.text = t;
  return { node: out, rest: "" };
}

// ----------------------------------------------------------------------------
// YAML (common subset)
// ----------------------------------------------------------------------------

function parseYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const clean = (line) => {
    let inS = null;
    let out = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inS) {
        out += ch;
        if (ch === inS && line[i - 1] !== "\\") inS = null;
      } else if (ch === "'" || ch === '"') {
        inS = ch;
        out += ch;
      } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) break;
      else out += ch;
    }
    return out;
  };
  let idx = 0;

  const scalar = (s) => {
    const v = s.trim();
    if (v === "" || v === "null" || v === "~") return null;
    if (v === "true" || v === "True") return true;
    if (v === "false" || v === "False") return false;
    const un = unquote(v);
    if (un !== null) return un;
    if (/^-?\d+$/.test(v)) return Number(v);
    if (/^-?\d*\.\d+$/.test(v)) return Number(v);
    if (v.startsWith("[") && v.endsWith("]")) {
      try {
        return JSON.parse(v);
      } catch {
        /* fall through */
      }
    }
    if (v.startsWith("{") && v.endsWith("}")) {
      try {
        return JSON.parse(v.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":'));
      } catch {
        /* fall through */
      }
    }
    return v;
  };
  const unquote = (s) => {
    const t = s.trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      return t.slice(1, -1).replace(/\\"/g, '"');
    }
    return null;
  };

  const parseBlockScalar = (indent, literal) => {
    const parts = [];
    while (idx < lines.length) {
      const raw = lines[idx];
      if (!raw.trim()) {
        parts.push("");
        idx++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (ind <= indent) break;
      parts.push(literal ? raw.slice(ind) : raw.trim());
      idx++;
    }
    return parts.join(literal ? "\n" : " ").replace(/\n{3,}/g, "\n\n").trim();
  };

  const parseList = (indent) => {
    const list = [];
    while (idx < lines.length) {
      const raw = lines[idx];
      const line = clean(raw);
      if (!line.trim()) {
        idx++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (ind < indent) break;
      if (ind > indent) throw new Error("Unexpected indentation in list");
      const content = line.trim();
      if (!content.startsWith("-")) break;
      const rest = content.slice(1).trim();
      idx++;
      if (!rest) {
        const nextRaw = lines[idx];
        if (nextRaw !== undefined) {
          const nextInd = nextRaw.length - nextRaw.trimStart().length;
          if (nextInd > indent && nextRaw.trim().startsWith("- ")) list.push(parseList(nextInd));
          else if (nextInd > indent) list.push(parseBlock(nextInd));
          else list.push(null);
        } else list.push(null);
      } else if (/^[\w."'-]+\s*:/.test(rest) && !rest.startsWith('"') && !rest.startsWith("'")) {
        const m = rest.match(/^([^:]+):\s*(.*)$/);
        const item = {};
        item[unquote(m[1].trim()) ?? m[1].trim()] = m[2].trim() === "" ? null : scalar(m[2]);
        list.push(item);
      } else {
        list.push(scalar(rest));
      }
    }
    return list;
  };

  const parseBlock = (indent) => {
    const result = {};
    while (idx < lines.length) {
      const raw = lines[idx];
      const line = clean(raw);
      if (!line.trim() || line.trim().startsWith("---")) {
        idx++;
        continue;
      }
      const ind = raw.length - raw.trimStart().length;
      if (ind < indent) break;
      if (ind > indent) throw new Error("Unexpected indentation");
      const content = line.trim();
      if (content.startsWith("- ")) break;
      const m = content.match(/^([^:]+):\s*(.*)$/);
      if (!m) throw new Error("Expected 'key: value'");
      const key = unquote(m[1].trim()) ?? m[1].trim();
      const value = m[2].trim();
      idx++;
      if (value === "|" || value === ">" || value === "|-" || value === ">-") {
        result[key] = parseBlockScalar(ind, value.startsWith("|"));
      } else if (value === "") {
        const nextRaw = lines[idx];
        if (nextRaw !== undefined) {
          const nextInd = nextRaw.length - nextRaw.trimStart().length;
          if (nextInd > indent && nextRaw.trim().startsWith("- ")) result[key] = parseList(nextInd);
          else if (nextInd > indent) result[key] = parseBlock(nextInd);
          else result[key] = null;
        } else result[key] = null;
      } else {
        result[key] = scalar(value);
      }
    }
    return result;
  };

  const result = parseBlock(0);
  return result;
}

// ----------------------------------------------------------------------------
// TOML (common subset)
// ----------------------------------------------------------------------------

function tomlValue(s) {
  const v = s.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    try {
      return JSON.parse(v.replace(/'/g, '"'));
    } catch {
      return v
        .slice(1, -1)
        .split(",")
        .map((x) => tomlValue(x.trim()))
        .filter((x) => x !== "");
    }
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const obj = {};
    for (const part of v.slice(1, -1).split(",")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      obj[part.slice(0, eq).trim().replace(/^"|"$/g, "")] = tomlValue(part.slice(eq + 1));
    }
    return obj;
  }
  return v;
}

function parseToml(text) {
  const result = {};
  let current = result;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const am = line.match(/^\[\[(.+)\]\]$/);
    if (am) {
      const parts = am[1].trim().split(".").map((p) => p.trim());
      let cur = result;
      for (const p of parts) {
        if (!Array.isArray(cur[p])) cur[p] = [];
        // each [[table]] header starts a NEW table in the array
        const fresh = {};
        cur[p].push(fresh);
        cur = fresh;
      }
      current = cur;
      continue;
    }
    const tm = line.match(/^\[(.+)\]$/);
    if (tm) {
      const parts = tm[1].trim().split(".").map((p) => p.trim());
      let cur = result;
      for (const p of parts) {
        if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
        cur = cur[p];
      }
      current = cur;
      continue;
    }
    const kv = line.match(/^([^=]+)=\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim().replace(/^"|"$/g, "");
      current[key] = tomlValue(kv[2].trim());
    }
  }
  return result;
}

// ----------------------------------------------------------------------------
// INI / properties / env
// ----------------------------------------------------------------------------

function parseIni(text) {
  const result = {};
  let current = result;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("//")) continue;
    const sm = line.match(/^\[(.+)\]$/);
    if (sm) {
      current = result[sm[1].trim()] = {};
      continue;
    }
    const kv = line.match(/^([^=:]+)[=:]\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (/^-?\d+$/.test(val)) current[key] = Number(val);
      else if (val === "true") current[key] = true;
      else if (val === "false") current[key] = false;
      else current[key] = val;
    }
  }
  return result;
}

// ----------------------------------------------------------------------------
// HTML → text / tables / links
// ----------------------------------------------------------------------------

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch {
        return "";
      }
    });
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function extractHtml(text) {
  const src = String(text);
  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  const descMatch =
    src.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    src.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const metaDescription = descMatch ? descMatch[1] : "";

  const links = [];
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = linkRe.exec(src)) && links.length < 50) {
    const href = lm[1];
    if (/^(javascript:|#)/.test(href)) continue;
    links.push({ href, text: stripTags(lm[2]) });
  }

  const headings = [];
  for (const level of [1, 2, 3]) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, "gi");
    let hm;
    while ((hm = re.exec(src)) && headings.length < 20) headings.push({ level, text: stripTags(hm[1]) });
  }

  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(src)) && tables.length < 5) {
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tm[1]))) {
      const cells = [];
      const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) cells.push(stripTags(cm[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }

  const bodyText = stripTags(src.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " "));
  return { title, metaDescription, links, headings, tables, text: bodyText };
}

// ----------------------------------------------------------------------------
// RTF → text
// ----------------------------------------------------------------------------

function extractRtf(text) {
  const src = String(text);
  const unicodeEscapes = [];
  const withoutUnicode = src.replace(/\\u(-?\d+)\??/g, (_, d) => {
    try {
      const ch = String.fromCodePoint((Number(d) + 65536) % 65536);
      unicodeEscapes.push(ch);
      return "\u0001";
    } catch {
      return "";
    }
  });
  let out = "";
  let i = 0;
  const chars = withoutUnicode.split("");
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\\") {
      const next = chars[i + 1];
      if (next === undefined) break;
      if (next === "\\" || next === "{" || next === "}") {
        out += next;
        i += 2;
      } else if (next === "'") {
        const hex = chars.slice(i + 2, i + 4).join("");
        if (/^[0-9a-f]{2}$/i.test(hex)) out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else if (next === "par" || next === "line") {
        out += "\n";
        i += 4;
      } else if (next === "tab") {
        out += "\t";
        i += 4;
      } else {
        // skip control word: \wordN or \word
        let j = i + 1;
        while (j < chars.length && /[a-zA-Z]/.test(chars[j])) j++;
        while (j < chars.length && /[-0-9]/.test(chars[j])) j++;
        if (chars[j] === " ") j++;
        i = j;
      }
    } else if (ch === "{" || ch === "}") {
      i++;
    } else if (ch === "\u0001") {
      out += unicodeEscapes.shift() || "";
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ----------------------------------------------------------------------------
// PDF (best effort — FlateDecode streams, Tj/TJ/'/" operators)
// Handles both parenthesized ("(text)") and hex ("<…>") string literals and
// TJ kerning arrays, which is how modern generators (pdf-lib, jsPDF, Chrome,
// Word) emit text. Streams compressed with other filters (LZW, ASCII85…) are
// not decoded — those PDFs may yield empty text.
// ----------------------------------------------------------------------------

function decodePdfString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === "n") {
        out += "\n";
        i++;
      } else if (next === "r") {
        out += "\r";
        i++;
      } else if (next === "t") {
        out += "\t";
        i++;
      } else if (next === "(" || next === ")" || next === "\\") {
        out += next;
        i++;
      } else if (next >= "0" && next <= "7") {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 4), 8));
        i += 3;
      } else i++;
    } else out += ch;
  }
  return out;
}

// Decode a hex string literal body (without the angle brackets). Whitespace is
// ignored, an odd digit count is padded (spec behavior), and a FE FF BOM means
// UTF-16BE — common for PDFs produced from Unicode text.
function decodePdfHexString(s) {
  const clean = String(s || "").replace(/\s+/g, "");
  if (!clean) return "";
  const hex = clean.length % 2 ? clean + "0" : clean;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    const swapped = Buffer.alloc(Math.floor(body.length / 2) * 2);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return swapped.toString("utf16le");
  }
  return bytes.toString("latin1");
}

// Best-effort text extraction from one BT…ET content block. Operates on the
// raw (decompressed) operator stream: strings can be "(…)" or "<…>", shown
// with Tj / TJ / ' / ". TJ arrays interleave strings with kerning numbers
// (thousandths of a text unit) — a positive gap that grows past a threshold
// becomes a word space, matching how viewers reconstruct words.
function extractPdfTextFromContent(content) {
  const lines = [];
  let line = "";
  const flush = () => {
    const t = line.trim();
    if (t) lines.push(t);
    line = "";
  };
  const appendStr = (raw) => {
    if (raw.startsWith("<")) line += decodePdfHexString(raw.slice(1, -1));
    else if (raw.startsWith("(")) line += decodePdfString(raw.slice(1, -1));
  };

  // Tokenize operands + operators: hex strings, parenthesized strings, arrays,
  // numbers, names, and operator words.
  const tokenRe = /<[0-9a-fA-F\s]*>|\((?:[^()\\]|\\.)*\)|\[[^\]]*\]|[-+]?\d*\.?\d+|\/[\w.]+|[\w"']+/g;
  const btRe = /BT([\s\S]*?)ET/g;
  let m;
  while ((m = btRe.exec(content))) {
    const tokens = m[1].match(tokenRe) || [];
    let adj = 0; // accumulated TJ kerning adjustment
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const prev = tokens[i - 1];
      const isString = (t) => t && (t.startsWith("(") || t.startsWith("<"));
      if (tok === "Tj" || tok === '"' || tok === "'") {
        // ' and " also show text (" moves to the next line first)
        if (isString(prev)) appendStr(prev);
        if (tok === "'") flush();
        else line += " ";
        adj = 0;
      } else if (tok === "TJ") {
        if (prev && prev.startsWith("[")) {
          const arrRe = /<[0-9a-fA-F\s]*>|\((?:[^()\\]|\\.)*\)|[-+]?\d*\.?\d+/g;
          let e;
          while ((e = arrRe.exec(prev.slice(1, -1)))) {
            const el = e[0];
            if (el.startsWith("(") || el.startsWith("<")) {
              appendStr(el);
              adj = 0;
            } else {
              adj += parseFloat(el);
              // ~0.2 em gap → word boundary (negative adjustments are kerning)
              if (adj >= 150) {
                line += " ";
                adj = 0;
              }
            }
          }
        }
        line += " ";
        adj = 0;
      } else if (tok === "Td" || tok === "TD" || tok === "T*" || tok === "Tm") {
        flush(); // text-positioning operator → new line
        adj = 0;
      }
    }
    flush();
  }
  return lines.join("\n");
}

function extractPdf(buffer) {
  const text = buffer.toString("latin1");
  const metadata = {};
  const metaTags = { Title: "title", Author: "author", Subject: "subject", Keywords: "keywords", Creator: "creator", Producer: "producer" };
  for (const [tag, key] of Object.entries(metaTags)) {
    const paren = text.match(new RegExp(`/${tag}\\s*\\(([^)]*)\\)`, "i"));
    if (paren) {
      metadata[key] = decodePdfString(paren[1]);
      continue;
    }
    const hex = text.match(new RegExp(`/${tag}\\s*<([0-9a-fA-F]+)>`, "i"));
    if (hex) metadata[key] = Buffer.from(hex[1], "hex").toString("utf8");
  }
  const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;

  // Only page CONTENT streams are candidates for text — scanning every stream
  // in the file leaks binary data from embedded files / fonts / images into
  // the extracted text (decompressed font programs etc. can contain accidental
  // BT…ET blocks with parenthesized strings, which look like garbage).
  //
  // Parse each /Type /Page object, collect its /Contents stream ref(s), and
  // extract text exclusively from those. If pages can't be parsed (e.g. pages
  // living inside compressed object streams), fall back to scanning all
  // streams so the pre-consolidation behavior keeps working.
  const contentStreams = new Set();
  const pageRe = /(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g;
  let pm;
  while ((pm = pageRe.exec(text))) {
    const body = pm[2];
    if (!/\/Type\s*\/Page\b/.test(body)) continue;
    const cm = body.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
    if (!cm) continue;
    const refs = cm[1].startsWith("[")
      ? [...cm[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => Number(r[1]))
      : [Number((cm[1].match(/(\d+)\s+\d+\s+R/) || [])[1] || 0)];
    for (const n of refs) if (n > 0) contentStreams.add(n);
  }

  const pages = [];
  const extractStream = (rawBody) => {
    let raw;
    try {
      raw = inflateSync(Buffer.from(rawBody, "latin1"));
    } catch {
      raw = Buffer.from(rawBody, "latin1");
    }
    return extractPdfTextFromContent(raw.toString("latin1"));
  };

  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  if (contentStreams.size > 0) {
    // Object-number → stream body index, then extract only page contents.
    const byNum = new Map();
    const objStartRe = /(\d+)\s+\d+\s+obj\b/g;
    let om;
    const segments = [];
    while ((om = objStartRe.exec(text))) {
      segments.push({ num: Number(om[1]), start: om.index });
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const end = i + 1 < segments.length ? segments[i + 1].start : text.length;
      const body = text.slice(seg.start, end);
      const sm = body.match(/stream\r?\n([\s\S]*?)endstream/);
      if (sm) byNum.set(seg.num, sm[1]);
    }
    for (const n of contentStreams) {
      const body = byNum.get(n);
      if (!body) continue;
      const pageText = extractStream(body);
      if (pageText) pages.push(pageText);
    }
  } else {
    // Fallback: no parseable page objects → scan every stream (legacy path).
    let m;
    while ((m = streamRe.exec(text))) {
      const pageText = extractStream(m[1]);
      if (pageText) pages.push(pageText);
    }
  }
  return { metadata, pageCount, text: pages.join("\n\n") };
}

// ----------------------------------------------------------------------------
// ZIP reader (central directory) — enough for docx/ods/epub and listing
// ----------------------------------------------------------------------------

export function readZip(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  const min = Math.max(0, b.length - 22 - 65535);
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Not a valid ZIP archive");
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) break;
    const method = b.readUInt16LE(off + 10);
    const compSize = b.readUInt32LE(off + 20);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const localOff = b.readUInt32LE(off + 42);
    const name = b.toString("utf8", off + 46, off + 46 + nameLen);
    let data = null;
    try {
      const lNameLen = b.readUInt16LE(localOff + 26);
      const lExtraLen = b.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = b.subarray(dataStart, dataStart + compSize);
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
    } catch {
      data = null;
    }
    entries.push({ name, compressedSize: compSize, size: data ? data.length : compSize, method, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ----------------------------------------------------------------------------
// TAR reader
// ----------------------------------------------------------------------------

function readTar(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = [];
  let off = 0;
  while (off + 512 <= b.length) {
    const header = b.subarray(off, off + 512);
    if (header.every((x) => x === 0)) break;
    const name = header.toString("utf8", 0, 100).replace(/\0[\s\S]*$/, "");
    if (!name) break;
    const size = parseInt(header.toString("utf8", 124, 136).trim() || "0", 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const data = size > 0 ? Buffer.from(b.subarray(off + 512, off + 512 + size)) : Buffer.alloc(0);
    if (typeflag === "0" || typeflag === "" || typeflag === " ") {
      entries.push({ name, size: data.length, data });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ----------------------------------------------------------------------------
// DOCX / ODT / ODS / EPUB (zip → xml → text/rows)
// ----------------------------------------------------------------------------

function docxText(entries) {
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc || !doc.data) throw new Error("document.xml not found in the .docx");
  const xml = doc.data.toString("utf8");
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tr>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function odtText(entries) {
  const content = entries.find((e) => e.name === "content.xml");
  if (!content || !content.data) throw new Error("content.xml not found in the archive");
  const xml = content.data.toString("utf8");
  return xml
    .replace(/<text:tab\/>/g, "\t")
    .replace(/<text:line-break\/>/g, "\n")
    .replace(/<\/text:p>/g, "\n")
    .replace(/<\/text:h>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function odsRows(entries, maxRows) {
  const content = entries.find((e) => e.name === "content.xml");
  if (!content || !content.data) throw new Error("content.xml not found in the archive");
  const xml = content.data.toString("utf8");
  const rows = [];
  const rowRe = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g;
  let m;
  while ((m = rowRe.exec(xml)) && rows.length < maxRows) {
    const cells = [];
    const cellRe = /<table:table-cell[^>]*>([\s\S]*?)<\/table:table-cell>/g;
    let cm;
    while ((cm = cellRe.exec(m[1]))) {
      const p = cm[1].match(/<text:p[^>]*>([\s\S]*?)<\/text:p>/);
      cells.push(p ? p[1].replace(/<[^>]+>/g, "") : "");
    }
    if (cells.some((c) => c.trim() !== "")) rows.push(cells);
  }
  return rows;
}

function epubText(entries) {
  const opf = entries.find((e) => /\.opf$/.test(e.name));
  if (!opf || !opf.data) throw new Error("Package document (.opf) not found in the .epub");
  const opfXml = opf.data.toString("utf8");
  const spine = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
  const ids = [];
  if (spine) {
    const refRe = /<itemref[^>]+idref=["']([^"']+)["']/gi;
    let rm;
    while ((rm = refRe.exec(spine[1]))) ids.push(rm[1]);
  }
  const manifest = {};
  const itemRe = /<item[^>]+id=["']([^"']+)["'][^>]+href=["']([^"']+)["'][^>]*\/?>/gi;
  let im;
  while ((im = itemRe.exec(opfXml))) manifest[im[1]] = im[2];
  const parts = [];
  for (const id of ids) {
    const href = manifest[id];
    if (!href) continue;
    const entry = entries.find((e) => e.name.endsWith("/" + href) || e.name === href || e.name.endsWith(href));
    if (entry && entry.data) {
      const html = entry.data.toString("utf8");
      parts.push(stripTags(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")));
    }
  }
  if (!parts.length) throw new Error("No readable content found in the .epub");
  return parts.join("\n\n");
}

// ----------------------------------------------------------------------------
// Images — header-based dimensions
// ----------------------------------------------------------------------------

function pngDims(b) {
  if (b.length < 24 || b.toString("latin1", 1, 4) !== "PNG") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifDims(b) {
  if (b.toString("latin1", 0, 3) !== "GIF") return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpegDims(b) {
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    const len = b.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: b.readUInt16BE(off + 7), height: b.readUInt16BE(off + 5) };
    }
    off += 2 + len;
  }
  return null;
}

function webpDims(b) {
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const four = b.toString("latin1", 12, 16);
  if (four === "VP8X" && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  if (four === "VP8 " && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (four === "VP8L" && b.length >= 25) return { width: (b.readUInt16LE(21) & 0x3fff) + 1, height: (b.readUInt16LE(23) & 0x3fff) + 1 };
  return null;
}

function bmpDims(b) {
  if (b.toString("latin1", 0, 2) !== "BM" || b.length < 26) return null;
  return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
}

function icoDims(b) {
  if (b.length < 8 || b.readUInt16LE(0) !== 0) return null;
  const count = b.readUInt16LE(4);
  if (!count) return null;
  return { width: b[6] || 256, height: b[7] || 256, count };
}

function tiffDims(b) {
  const le = b.toString("latin1", 0, 2) === "II";
  if (!le && b.toString("latin1", 0, 2) !== "MM") return null;
  const read = (o, len) => (le ? (len === 2 ? b.readUInt16LE(o) : b.readUInt32LE(o)) : len === 2 ? b.readUInt16BE(o) : b.readUInt32BE(o));
  if (read(2, 2) !== 42) return null;
  const ifd = read(4, 4);
  if (ifd + 2 > b.length) return null;
  const count = read(ifd, 2);
  let width;
  let height;
  for (let i = 0; i < count && i < 100; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > b.length) break;
    const tag = read(entry, 2);
    if (tag === 256) width = read(entry + 8, 4);
    else if (tag === 257) height = read(entry + 8, 4);
  }
  if (width === undefined) return null;
  return { width, height };
}

// ----------------------------------------------------------------------------
// Audio / video metadata
// ----------------------------------------------------------------------------

function extractMp3(b) {
  const meta = {};
  if (b.toString("latin1", 0, 3) === "ID3" && b.length >= 10) {
    meta.tag = `ID3v2.${b[3]}.${b[4]}`;
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    const end = Math.min(10 + size, b.length - 10);
    let off = 10;
    const map = { TIT2: "title", TPE1: "artist", TALB: "album", TYER: "year", TDRC: "year", TRCK: "track", TCON: "genre", TCOM: "composer" };
    while (off + 10 <= end) {
      const id = b.toString("latin1", off, off + 4);
      const sz = b.readUInt32BE(off + 4);
      if (sz <= 0 || sz > end - off - 10) break;
      if (map[id]) meta[map[id]] = b.toString("utf8", off + 10, off + 10 + sz).replace(/\0+$/, "").trim();
      off += 10 + sz;
    }
  } else if (b.length > 128 && b.toString("latin1", b.length - 128, b.length - 125) === "TAG") {
    const t = b.toString("latin1", b.length - 128);
    meta.tag = "ID3v1";
    meta.title = t.slice(3, 33).replace(/\0+$/, "").trim();
    meta.artist = t.slice(33, 63).replace(/\0+$/, "").trim();
    meta.album = t.slice(63, 93).replace(/\0+$/, "").trim();
    meta.year = t.slice(93, 97).trim();
  }
  return meta;
}

function extractWav(b) {
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return null;
  let fmt = null;
  let dataSize = 0;
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString("latin1", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt " && off + 24 <= b.length) {
      fmt = {
        audioFormat: b.readUInt16LE(off + 8),
        channels: b.readUInt16LE(off + 10),
        sampleRate: b.readUInt32LE(off + 12),
        bitsPerSample: b.readUInt16LE(off + 22),
      };
    }
    if (id === "data") dataSize = size;
    off += 8 + size + (size % 2);
  }
  if (!fmt) return null;
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return {
    format: "WAV",
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    durationSec: bytesPerSec ? Math.round((dataSize / bytesPerSec) * 100) / 100 : null,
  };
}

function extractFlac(b) {
  if (b.toString("latin1", 0, 4) !== "fLaC" || b.length < 42) return null;
  const header = b.readUInt32BE(4);
  const type = (header >> 24) & 0x7f;
  if (type !== 0) return null;
  const block = b.subarray(8, 42);
  const sampleRate = (block.readUIntBE(10, 3) >> 4) & 0xfffff;
  const channels = ((block[13] >> 1) & 7) + 1;
  const bits = ((block[13] & 1) << 4) | (block[14] >> 4);
  const totalSamples = ((block[14] & 0x0f) << 32) | block.readUInt32BE(15);
  return {
    format: "FLAC",
    sampleRate,
    channels,
    bitsPerSample: bits,
    durationSec: sampleRate ? Math.round((totalSamples / sampleRate) * 100) / 100 : null,
  };
}

function extractOgg(b) {
  if (b.toString("latin1", 0, 4) !== "OggS") return null;
  const head = b.toString("latin1", 28, 60);
  if (head.includes("vorbis")) return { format: "Ogg Vorbis" };
  if (head.includes("OpusHead")) return { format: "Ogg Opus" };
  return { format: "Ogg" };
}

function extractMp4(b) {
  const meta = {};
  if (b.toString("latin1", 4, 8) === "ftyp") {
    meta.brand = b.toString("latin1", 8, 12).replace(/\0/g, "");
    meta.format = meta.brand === "M4A " ? "M4A audio" : "MP4";
  }
  let off = 0;
  while (off + 8 <= b.length) {
    const size = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    if (type === "mvhd" && off + 32 <= b.length) {
      const version = b[off + 8];
      const tsOff = version === 1 ? off + 20 : off + 12;
      const durOff = version === 1 ? off + 28 : off + 20;
      const timescale = b.readUInt32BE(tsOff);
      const duration = version === 1 ? Number(b.readBigUInt64BE(durOff)) : b.readUInt32BE(durOff);
      if (timescale) meta.durationSec = Math.round((duration / timescale) * 100) / 100;
      break;
    }
    if (size < 8) break;
    off += size;
  }
  return meta;
}

function extractWebm(b) {
  if (b.toString("latin1", 0, 4) !== "\x1a\x45\xdf\xa3") return null;
  const meta = { format: "Matroska / WebM" };
  // Duration is an 8-byte float (element 0x4489); timecode scale is a uint (0x2AD7B1).
  let duration = null;
  let scale = 1000000;
  for (let i = 0; i + 12 < b.length; i++) {
    if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] & 0x80) {
      const size = vintValue(b, i + 2);
      if (size === 8 && i + 2 + vintLen(b[i + 2]) + 8 <= b.length) {
        duration = b.readDoubleBE(i + 2 + vintLen(b[i + 2]));
      }
    }
    if (b[i] === 0x2a && b[i + 1] === 0xd7 && b[i + 2] === 0xb1) {
      const len = vintLen(b[i + 3]);
      const size = vintValue(b, i + 3);
      if (size <= 8) scale = readUintBE(b, i + 3 + len, size);
    }
  }
  if (duration !== null && Number.isFinite(duration)) {
    meta.durationSec = Math.round((duration * scale) / 1e9 * 100) / 100;
  }
  return meta;
}

function vintLen(firstByte) {
  let len = 1;
  while (len <= 8 && !(firstByte & (1 << (8 - len)))) len++;
  return Math.min(len, 8);
}

function vintValue(b, off) {
  const first = b[off];
  const len = vintLen(first);
  let v = first & ((1 << (8 - len)) - 1);
  for (let i = 1; i < len; i++) v = v * 256 + b[off + i];
  return v;
}

function readUintBE(b, off, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[off + i];
  return v;
}

// ----------------------------------------------------------------------------
// ICS / VCF / SRT / VTT
// ----------------------------------------------------------------------------

function parseIcs(text) {
  const unfolded = String(text).replace(/\r?\n[ \t]/g, "");
  const events = [];
  for (const block of unfolded.split(/BEGIN:VEVENT/).slice(1)) {
    const b = block.split(/END:VEVENT/)[0];
    const get = (k) => {
      const m = b.match(new RegExp(`^${k}[:;][^\\n]*`, "m"));
      return m ? m[0].split(":").slice(1).join(":").trim() : "";
    };
    events.push({
      summary: get("SUMMARY"),
      start: get("DTSTART"),
      end: get("DTEND"),
      location: get("LOCATION"),
      description: get("DESCRIPTION"),
      status: get("STATUS"),
    });
  }
  return { events };
}

function parseVcf(text) {
  const cards = [];
  for (const block of String(text).split(/END:VCARD/)) {
    if (!block.includes("BEGIN:VCARD")) continue;
    const get = (k) => {
      const m = block.match(new RegExp(`^(?:ITEM\\d+\\.)?${k}[^:]*:([^\\n]*)`, "m"));
      return m ? m[1].trim() : "";
    };
    cards.push({ name: get("FN"), email: get("EMAIL"), tel: get("TEL"), org: get("ORG"), title: get("TITLE"), note: get("NOTE") });
  }
  return { cards };
}

function parseSrtLike(text) {
  const out = [];
  for (const block of String(text).replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const time = lines.find((l) => l.includes("-->"));
    if (!time) continue;
    const [start, end] = time.split("-->").map((t) => t.trim().split(/\s+/)[0]);
    const content = lines
      .filter((l) => l !== time && !/^\d+$/.test(l.trim()))
      .join(" ")
      .trim();
    if (content) out.push({ start, end, text: content });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Input resolution — turn a payload field / URL / raw text into bytes
// ----------------------------------------------------------------------------

function looksLikeBase64(s) {
  if (typeof s !== "string" || !s) return false;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) return false;
  const t = s.trim();
  if (t.length < 8 && !t.includes("=")) return false;
  if (t.length % 4 === 1) return false;
  // base64 may be line-wrapped (\r\n) but not contain plain spaces
  return /^[A-Za-z0-9+/=\r\n\t]+$/.test(t);
}

/**
 * Resolve the node's "file input" for one item.
 * Returns { buffer, fileName, mimeType } or { error }.
 */
export async function resolveFileInput(config, item) {
  const c = config || {};
  const json = item?.json || {};
  const mode = c.contentMode || "auto";
  // Resolve field paths that may be dotted (e.g. "body.pdf" for a webhook's
  // payload nested under the trigger's output). Bracket-free dot traversal.
  const pathValue = (p) =>
    String(p || "")
      .split(".")
      .reduce((acc, k) => (acc == null ? acc : acc[k]), json);
  // sourceValue: content the executor already rendered from a template.
  const raw = c.sourceValue !== undefined ? c.sourceValue : c.sourceField ? pathValue(c.sourceField) : json;

  // Resolve file name from a payload field, else the literal config.
  let fileName = "";
  if (c.fileNameField && pathValue(c.fileNameField) != null) fileName = String(pathValue(c.fileNameField));
  else if (c.fileName) fileName = String(c.fileName);

  try {
    if (mode === "url") {
      const url = String(raw ?? "");
      if (!url) return { error: "No URL found in the source field" };
      const res = await fetch(url);
      if (!res.ok) return { error: `Download failed with status ${res.status}` };
      const buffer = Buffer.from(await res.arrayBuffer());
      const cd = res.headers.get("content-disposition") || "";
      const nameMatch = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      if (nameMatch) fileName = nameMatch[1].replace(/"/g, "").trim();
      else if (!fileName) {
        try {
          fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
        } catch {
          fileName = "";
        }
      }
      const mimeType = res.headers.get("content-type")?.split(";")[0] || "";
      return { buffer, fileName, mimeType };
    }

    if (mode === "text") {
      if (raw === undefined || raw === null) return { error: "No file content found in the source field" };
      const s = typeof raw === "string" ? raw : JSON.stringify(raw);
      return { buffer: Buffer.from(s, "utf8"), fileName, mimeType: "text/plain" };
    }

    if (mode === "json") {
      const s = JSON.stringify(raw);
      return { buffer: Buffer.from(s, "utf8"), fileName, mimeType: "application/json" };
    }

    if (mode === "base64") {
      const s = typeof raw === "string" ? raw.trim() : "";
      if (!s) return { error: "No file content found in the source field" };
      const buffer = Buffer.from(s, "base64");
      return { buffer, fileName };
    }

    // auto
    if (raw === undefined || raw === null || raw === "") {
      return { error: "No file content found in the source field" };
    }
    if (typeof raw === "object") {
      return { buffer: Buffer.from(JSON.stringify(raw), "utf8"), fileName, mimeType: "application/json" };
    }
    const s = String(raw);
    if (looksLikeBase64(s)) {
      return { buffer: Buffer.from(s.trim(), "base64"), fileName };
    }
    return { buffer: Buffer.from(s, "utf8"), fileName, mimeType: "text/plain" };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

// ----------------------------------------------------------------------------
// Main extraction dispatcher
// ----------------------------------------------------------------------------

/**
 * Extract content from a file. `data` is a Buffer (or a string for text files).
 * `mode` focuses the output:
 *   auto       return everything the type supports
 *   text       text content only (raw text or extracted text)
 *   structured parsed object (json/xml/yaml/toml/ini/…)
 *   rows       table rows (csv/xlsx/ods/html tables)
 *   entries    archive listing (zip/tar/gz)
 *   metadata   type + metadata only
 *   pdf        force PDF text extraction
 */
export async function extractFileContent({ fileName, mimeType, data, mode = "auto", opts = {} }) {
  const buffer = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.alloc(0);
  const detected = detectFileType({ fileName, mimeType, data: buffer });
  const base = {
    fileName: fileName || "",
    fileSize: buffer.length,
    detected: detected
      ? { ext: detected.ext, name: detected.name, category: detected.category, categoryLabel: categoryLabel(detected.category), mime: detected.mime, extractor: detected.extractor }
      : null,
  };

  const maxRows = Math.max(1, Number(opts.maxRows || DEFAULT_MAX_ROWS));
  const error = (msg) => ({ ...base, error: msg });
  if (!detected) {
    // Unknown but textual content still gets a raw text extraction.
    const s = decodeBuffer(buffer, opts.encoding);
    if (mode === "structured") return error("Could not detect the file type — nothing to parse");
    return { ...base, text: truncateText(s, opts.maxTextLength), error: "Could not detect the file type — returning raw text" };
  }

  let extractor = detected.extractor;
  // Explicit format override (used by the "Parse Structured Data" node).
  if (opts.format && opts.format !== "auto" && ["json", "jsonl", "xml", "yaml", "toml", "ini", "ics", "vcf", "srt", "vtt", "html", "text"].includes(opts.format)) {
    extractor = opts.format;
  }
  const isBinaryDoc = ["docx", "odt", "ods", "xlsx", "epub"].includes(extractor);
  const metadataOnly = mode === "metadata";

  // --- text modes ----------------------------------------------------------
  if (mode === "text" || mode === "auto") {
    if (extractor === "text") {
      const s = decodeBuffer(buffer, opts.encoding);
      const result = { text: truncateText(s, opts.maxTextLength) };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "csv") {
      const s = decodeBuffer(buffer, opts.encoding);
      const delimiter = opts.delimiter === "auto" || !opts.delimiter ? (detected.ext === "tsv" ? "\t" : ",") : opts.delimiter;
      const rows = parseCsv(s, delimiter);
      const headerRow = opts.headerRow !== false;
      const records = rows.length > 1 && headerRow ? rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) : [];
      const result = { text: truncateText(s, opts.maxTextLength), rows: rows.slice(0, maxRows), records: records.slice(0, maxRows) };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "json") {
      const s = decodeBuffer(buffer, opts.encoding);
      let parsed = null;
      try {
        parsed = JSON.parse(s);
      } catch {
        parsed = null;
      }
      const result = { text: truncateText(s, opts.maxTextLength), structured: parsed, error: parsed === null ? "Invalid JSON — returning raw text" : undefined };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "jsonl") {
      const s = decodeBuffer(buffer, opts.encoding);
      const parsed = parseJsonl(s);
      const result = { text: truncateText(s, opts.maxTextLength), structured: parsed, records: parsed };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "html") {
      const s = decodeBuffer(buffer, opts.encoding);
      const parsed = extractHtml(s);
      const result = { text: truncateText(parsed.text, opts.maxTextLength), structured: { title: parsed.title, metaDescription: parsed.metaDescription, links: parsed.links, headings: parsed.headings }, rows: (parsed.tables[0] || []).slice(0, maxRows), tables: parsed.tables.slice(0, maxRows) };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "xml") {
      const s = decodeBuffer(buffer, opts.encoding);
      let tree = null;
      try {
        tree = xmlToTree(s);
      } catch {
        tree = null;
      }
      const result = { text: truncateText(s, opts.maxTextLength), structured: tree, error: tree === null ? "Could not parse XML — returning raw text" : undefined };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "rtf") {
      const s = decodeBuffer(buffer, opts.encoding);
      const result = { text: truncateText(extractRtf(s), opts.maxTextLength) };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "ics") {
      const s = decodeBuffer(buffer, opts.encoding);
      const parsed = parseIcs(s);
      const result = { text: truncateText(s, opts.maxTextLength), structured: parsed };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "vcf") {
      const s = decodeBuffer(buffer, opts.encoding);
      const parsed = parseVcf(s);
      const result = { text: truncateText(s, opts.maxTextLength), structured: parsed };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "srt" || extractor === "vtt") {
      const s = decodeBuffer(buffer, opts.encoding);
      const cues = parseSrtLike(s);
      const result = { text: truncateText(s, opts.maxTextLength), structured: cues, records: cues };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "yaml") {
      const s = decodeBuffer(buffer, opts.encoding);
      let structured;
      try {
        structured = parseYaml(s);
      } catch (err) {
        structured = null;
      }
      const result = {
        text: truncateText(s, opts.maxTextLength),
        structured,
        error: structured === null ? "Could not parse YAML — returning raw text" : undefined,
      };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "toml") {
      const s = decodeBuffer(buffer, opts.encoding);
      const result = { text: truncateText(s, opts.maxTextLength), structured: parseToml(s) };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "ini") {
      const s = decodeBuffer(buffer, opts.encoding);
      const result = { text: truncateText(s, opts.maxTextLength), structured: parseIni(s) };
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (isBinaryDoc) {
      const result = await extractDocument(extractor, buffer, { ...opts, maxRows, maxTextLength: opts.maxTextLength });
      if (mode === "text") return { ...base, ...result };
      Object.assign(base, result);
    } else if (extractor === "pdf") {
      const result = extractPdf(buffer);
      const out = { text: truncateText(result.text, opts.maxTextLength), pageCount: result.pageCount, metadata: { ...(base.metadata || {}), ...result.metadata } };
      // A PDF with no extractable text is almost always a scanned/image-only
      // document or an unsupported encoding — flag it instead of silently
      // passing empty text downstream (the editor log shows this reason).
      if (!out.text.trim()) {
        out.error = "No text could be extracted from the PDF — it may be a scanned (image-only) document or use an unsupported text encoding";
      }
      if (mode === "text") return { ...base, ...out };
      Object.assign(base, out);
    }
  }

  // --- structured mode -----------------------------------------------------
  if (mode === "structured") {
    const s = decodeBuffer(buffer, opts.encoding);
    if (extractor === "json") return { ...base, structured: JSON.parse(s) };
    if (extractor === "jsonl") return { ...base, structured: parseJsonl(s), records: parseJsonl(s) };
    if (extractor === "xml") return { ...base, structured: xmlToTree(s) };
    if (extractor === "yaml") {
      try {
        return { ...base, structured: parseYaml(s) };
      } catch (err) {
        return error("Could not parse YAML — the document uses a syntax outside the supported subset");
      }
    }
    if (extractor === "toml") return { ...base, structured: parseToml(s) };
    if (extractor === "ini") return { ...base, structured: parseIni(s) };
    if (extractor === "ics") return { ...base, structured: parseIcs(s) };
    if (extractor === "vcf") return { ...base, structured: parseVcf(s) };
    if (extractor === "srt" || extractor === "vtt") return { ...base, structured: parseSrtLike(s), records: parseSrtLike(s) };
    if (extractor === "html") {
      const parsed = extractHtml(s);
      return { ...base, structured: { title: parsed.title, metaDescription: parsed.metaDescription, links: parsed.links, headings: parsed.headings }, rows: parsed.tables.slice(0, maxRows) };
    }
    if (extractor === "text") return { ...base, structured: s, text: truncateText(s, opts.maxTextLength) };
    return error(`File type ${detected.name} is not structured — no parser for it`);
  }

  // --- rows mode -----------------------------------------------------------
  if (mode === "rows") {
    if (extractor === "csv") {
      const s = decodeBuffer(buffer, opts.encoding);
      const delimiter = opts.delimiter === "auto" || !opts.delimiter ? (detected.ext === "tsv" ? "\t" : ",") : opts.delimiter;
      const rows = parseCsv(s, delimiter);
      const headerRow = opts.headerRow !== false;
      const records = rows.length > 1 && headerRow ? rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) : [];
      return { ...base, rows: rows.slice(0, maxRows), records: records.slice(0, maxRows), rowCount: rows.length };
    }
    if (extractor === "xlsx") {
      const out = await readXlsxRows(buffer, opts.sheetIndex, maxRows, opts.headerRow !== false);
      return { ...base, ...out };
    }
    if (extractor === "ods") {
      const rows = odsRows(readZip(buffer), maxRows);
      const headerRow = opts.headerRow !== false;
      const records = rows.length > 1 && headerRow ? rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) : [];
      return { ...base, rows, records: records.slice(0, maxRows), rowCount: rows.length };
    }
    if (extractor === "html") {
      const parsed = extractHtml(decodeBuffer(buffer, opts.encoding));
      const tables = parsed.tables.slice(0, maxRows);
      return { ...base, rows: tables[0] || [], tables, text: truncateText(parsed.text, opts.maxTextLength) };
    }
    return error(`${detected.name} is not a table format — no rows to extract`);
  }

  // --- entries mode (archives) ---------------------------------------------
  if (mode === "entries") {
    if (extractor === "zip") {
      try {
        const entries = readZip(buffer);
        const list = entries.map((e) => ({ name: e.name, size: e.size, compressedSize: e.compressedSize, method: e.method }));
        const selected = pickArchiveEntry(entries, opts.entryPattern);
        const result = { entries: list.slice(0, Math.max(1, Number(opts.maxEntries || 500))), entryCount: list.length };
        if (selected) {
          result.selectedEntry = { name: selected.name, size: selected.size };
          if (selected.data && isProbablyTextual(selected.data)) result.selectedText = truncateText(decodeBuffer(selected.data, opts.encoding), opts.maxTextLength);
          else if (selected.data) result.selectedBase64 = selected.data.toString("base64");
        }
        return { ...base, ...result };
      } catch (err) {
        return error("Could not read the ZIP archive: " + String(err.message || err));
      }
    }
    if (extractor === "tar") {
      try {
        const entries = readTar(buffer);
        const list = entries.map((e) => ({ name: e.name, size: e.size }));
        const selected = pickArchiveEntry(entries, opts.entryPattern);
        const result = { entries: list.slice(0, Math.max(1, Number(opts.maxEntries || 500))), entryCount: list.length };
        if (selected) {
          result.selectedEntry = { name: selected.name, size: selected.size };
          if (selected.data && isProbablyTextual(selected.data)) result.selectedText = truncateText(decodeBuffer(selected.data, opts.encoding), opts.maxTextLength);
          else if (selected.data) result.selectedBase64 = selected.data.toString("base64");
        }
        return { ...base, ...result };
      } catch (err) {
        return error("Could not read the TAR archive: " + String(err.message || err));
      }
    }
    if (extractor === "gz") {
      try {
        const inner = gunzipSync(buffer);
        const entries = readTar(inner);
        const list = entries.map((e) => ({ name: e.name, size: e.size }));
        const selected = pickArchiveEntry(entries, opts.entryPattern);
        const result = { decompressedSize: inner.length, entries: list.slice(0, Math.max(1, Number(opts.maxEntries || 500))), entryCount: list.length };
        if (selected) {
          result.selectedEntry = { name: selected.name, size: selected.size };
          if (selected.data && isProbablyTextual(selected.data)) result.selectedText = truncateText(decodeBuffer(selected.data, opts.encoding), opts.maxTextLength);
          else if (selected.data) result.selectedBase64 = selected.data.toString("base64");
        }
        return { ...base, ...result };
      } catch (err) {
        return error("Could not decompress the .gz file: " + String(err.message || err));
      }
    }
    return error(`${detected.name} is not an archive format this node can list`);
  }

  // --- pdf mode ------------------------------------------------------------
  if (mode === "pdf") {
    const result = extractPdf(buffer);
    return { ...base, text: truncateText(result.text, opts.maxTextLength), pageCount: result.pageCount, metadata: result.metadata };
  }

  // --- metadata ------------------------------------------------------------
  if (metadataOnly) {
    const meta = readBinaryMetadata(extractor, buffer);
    return { ...base, metadata: meta || {} };
  }

  // --- auto fallbacks ------------------------------------------------------
  if (extractor === "zip") {
    try {
      const entries = readZip(buffer);
      return { ...base, entries: entries.slice(0, maxRows).map((e) => ({ name: e.name, size: e.size, compressedSize: e.compressedSize })), entryCount: entries.length };
    } catch (err) {
      return error("Could not read the ZIP archive: " + String(err.message || err));
    }
  }
  if (extractor === "tar") {
    try {
      const entries = readTar(buffer);
      return { ...base, entries: entries.slice(0, maxRows).map((e) => ({ name: e.name, size: e.size })), entryCount: entries.length };
    } catch (err) {
      return error("Could not read the TAR archive: " + String(err.message || err));
    }
  }
  if (extractor === "gz") {
    try {
      const inner = gunzipSync(buffer);
      const entries = readTar(inner);
      return { ...base, decompressedSize: inner.length, entries: entries.slice(0, maxRows).map((e) => ({ name: e.name, size: e.size })), entryCount: entries.length };
    } catch (err) {
      return { ...base, error: "Could not decompress the .gz file" };
    }
  }

  // binary formats that only yield metadata
  const meta = readBinaryMetadata(extractor, buffer);
  if (meta && Object.keys(meta).length) {
    return { ...base, metadata: meta };
  }
  // An earlier auto branch may already have extracted content or set an error — don't overwrite it.
  if (base.text !== undefined || base.structured !== undefined || base.rows !== undefined || base.entries !== undefined || base.error !== undefined) {
    return base;
  }
  return { ...base, error: `No extractor for ${detected.name} — metadata only` };
}

// ----------------------------------------------------------------------------
// Document extraction (docx / odt / ods / xlsx / epub)
// ----------------------------------------------------------------------------

async function extractDocument(extractor, buffer, opts) {
  try {
    if (extractor === "docx") return { text: truncateText(docxText(readZip(buffer)), opts.maxTextLength) };
    if (extractor === "odt") return { text: truncateText(odtText(readZip(buffer)), opts.maxTextLength) };
    if (extractor === "epub") return { text: truncateText(epubText(readZip(buffer)), opts.maxTextLength) };
    if (extractor === "ods") {
      const rows = odsRows(readZip(buffer), opts.maxRows);
      const headerRow = opts.headerRow !== false;
      const records = rows.length > 1 && headerRow ? rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) : [];
      return { rows, records: records.slice(0, opts.maxRows), rowCount: rows.length };
    }
    if (extractor === "xlsx") return await readXlsxRows(buffer, opts.sheetIndex, opts.maxRows, opts.headerRow !== false);
    return {};
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

async function readXlsxRows(buffer, sheetIndex, maxRows, headerRow) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = wb.worksheets;
  if (!sheets.length) throw new Error("The .xlsx file has no worksheets");
  const ws = sheets[Math.min(Math.max(1, Number(sheetIndex || 1)) - 1, sheets.length - 1)];
  const rows = [];
  const cellValue = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      if (v.text !== undefined && v.text !== null) return String(v.text); // rich text runs
      if (v.result !== undefined) return v.result; // formula result
      if (v.hyperlink !== undefined) return String(v.hyperlink);
      if (v instanceof Date) return v.toISOString();
      return String(v);
    }
    return v; // numbers / booleans keep their type
  };
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= maxRows) return;
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(cellValue(cell.value));
    });
    if (values.some((v) => v !== undefined && v !== null && String(v).trim() !== "")) rows.push(values);
  });
  const records = rows.length > 1 && headerRow ? rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) : [];
  return {
    sheetName: ws.name,
    sheetCount: sheets.length,
    rows,
    records: records.slice(0, maxRows),
    rowCount: rows.length,
  };
}

function pickArchiveEntry(entries, pattern) {
  if (!pattern) return null;
  const re = new RegExp(String(pattern));
  return entries.find((e) => re.test(e.name)) || null;
}

function isProbablyTextual(buf) {
  if (!buf || !buf.length) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nul = 0;
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) nul++;
    if ((c >= 9 && c <= 13) || (c >= 32 && c < 127) || c >= 128) printable++;
  }
  return nul === 0 && printable / sample.length > 0.9;
}

function readBinaryMetadata(extractor, buffer) {
  const meta = {};
  if (extractor === "image") {
    const dims =
      pngDims(buffer) || jpegDims(buffer) || gifDims(buffer) || webpDims(buffer) || bmpDims(buffer) || icoDims(buffer) || tiffDims(buffer);
    if (dims) {
      meta.width = dims.width;
      meta.height = dims.height;
      meta.pixelCount = dims.width * dims.height;
    }
  } else if (extractor === "mp3") {
    Object.assign(meta, extractMp3(buffer));
    meta.format = "MP3";
  } else if (extractor === "wav") {
    const w = extractWav(buffer);
    if (w) Object.assign(meta, w);
  } else if (extractor === "flac") {
    const f = extractFlac(buffer);
    if (f) Object.assign(meta, f);
  } else if (extractor === "ogg") {
    const o = extractOgg(buffer);
    if (o) Object.assign(meta, o);
  } else if (extractor === "mp4") {
    const m = extractMp4(buffer);
    if (m) Object.assign(meta, m);
  } else if (extractor === "webm") {
    const m = extractWebm(buffer);
    if (m) Object.assign(meta, m);
  } else if (extractor === "pdf") {
    const p = extractPdf(buffer);
    meta.pageCount = p.pageCount;
    Object.assign(meta, p.metadata);
  } else if (extractor === "sqlite") {
    meta.format = "SQLite";
  } else if (extractor === "gz") {
    meta.format = "GZip";
  } else if (extractor === "7z") {
    meta.format = "7-Zip";
  } else if (extractor === "rar") {
    meta.format = "RAR";
  } else if (extractor === "bmp" || extractor === "ico" || extractor === "tiff") {
    const dims = extractor === "bmp" ? bmpDims(buffer) : extractor === "ico" ? icoDims(buffer) : tiffDims(buffer);
    if (dims) {
      meta.width = dims.width;
      meta.height = dims.height;
      if (dims.count) meta.count = dims.count;
    }
  }
  return meta;
}

// ----------------------------------------------------------------------------
// ZIP writer (deflate) — used by the Compress node.
// ----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a real .zip buffer from [{ name, data }] entries (deflate method). */
export function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
    const comp = data.length ? deflateRawSync(data) : Buffer.alloc(0);
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    localParts.push(Buffer.concat([lfh, nameBuf, comp]));
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([cdh, nameBuf]));
    offset += lfh.length + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

// ----------------------------------------------------------------------------
// Convert to File — text / JSON / CSV / HTML conversions (Convert to File node)
// ----------------------------------------------------------------------------

export function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Normalize a JSON value into table rows: array-of-arrays as-is, array of
// objects → header + value rows, { rows: [...] } unwrapped. Returns null if it
// cannot be represented as a table.
function coerceRows(value) {
  if (Array.isArray(value)) {
    if (value.every((r) => Array.isArray(r))) return value;
    if (value.length) {
      const headers = [...new Set(value.flatMap((r) => Object.keys(r || {})))];
      return [headers, ...value.map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? "" : typeof r[h] === "object" ? JSON.stringify(r[h]) : r[h])))];
    }
    return [[]];
  }
  return null;
}

export function itemsToHtml(rows) {
  if (!rows || !rows.length) return "<table></table>";
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const head = rows[0].map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .slice(1)
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>${body}</tbody>\n</table>`;
}

/**
 * Convert raw bytes into a target format (auto / txt / json / csv / html).
 * Returns a partial result { format, text, structured, rows, html, error? }.
 */
export function convertToFormat(buffer, format, detectedExt = "", opts = {}) {
  let text;
  try {
    text = decodeBuffer(buffer, opts.encoding);
  } catch {
    text = buffer.toString("utf8");
  }
  const resolved = format === "auto" ? (detectedExt === "json" ? "json" : detectedExt === "csv" || detectedExt === "tsv" ? "csv" : "txt") : format;

  if (resolved === "json") {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed !== null) return { format: "json", structured: parsed };
    return { format: "json", text, error: "Input is not valid JSON — returning raw text" };
  }

  if (resolved === "csv") {
    const delimiter = opts.delimiter === "auto" || !opts.delimiter ? (detectedExt === "tsv" ? "\t" : ",") : opts.delimiter;
    let rows = null;
    try {
      const parsed = JSON.parse(text);
      rows = coerceRows(parsed) || (parsed && typeof parsed === "object" ? coerceRows(parsed.rows) : null);
    } catch {
      rows = null;
    }
    if (!rows) rows = parseCsv(text, delimiter);
    const csv = rows.map((r) => (Array.isArray(r) ? r.map(csvCell).join(delimiter) : csvCell(r))).join("\n");
    return { format: "csv", rows, text: csv };
  }

  if (resolved === "html") {
    let rows = null;
    try {
      const parsed = JSON.parse(text);
      rows = coerceRows(parsed) || (parsed && typeof parsed === "object" ? coerceRows(parsed.rows) : null);
    } catch {
      rows = null;
    }
    if (!rows) rows = parseCsv(text, opts.delimiter === "auto" || !opts.delimiter ? "," : opts.delimiter);
    const html = rows.length > 1 || (rows.length === 1 && rows[0].length) ? itemsToHtml(rows) : `<pre>${String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
    return { format: "html", html, rows, text: String(text) };
  }

  return { format: "txt", text };
}
