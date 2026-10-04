// ============================================================================
// W FLOW — common file-type registry
// A single source of truth for the ~110 most common file types a workflow is
// likely to meet. Used by the "Files & Data" nodes (palette) and by the
// extraction engine in server/fileextract.js (executor).
//
// Each entry:
//   ext       canonical extension (lowercase, no dot)
//   name      human-readable name
//   mime      primary MIME type
//   category  one of FILE_TYPE_CATEGORIES
//   extractor how the extraction engine should treat the bytes:
//               text | csv | json | jsonl | xml | yaml | toml | ini | html |
//               pdf | docx | odt | ods | xlsx | epub | zip | tar | gz |
//               rtf | ics | vcf | srt | vtt | image | mp3 | wav | flac |
//               ogg | mp4 | webm | metadata
//   binary    true when the file is not plain text (base64 / buffer expected)
// ============================================================================

export const FILE_TYPE_CATEGORIES = {
  document: { label: "Document" },
  spreadsheet: { label: "Spreadsheet" },
  data: { label: "Data / structured" },
  markup: { label: "Markup / web" },
  code: { label: "Code / dev" },
  config: { label: "Config" },
  image: { label: "Image" },
  audio: { label: "Audio" },
  video: { label: "Video" },
  archive: { label: "Archive" },
  font: { label: "Font" },
  ebook: { label: "eBook" },
  database: { label: "Database" },
  certificate: { label: "Certificate / key" },
  other: { label: "Other" },
};

export const FILE_TYPES = [
  // --- documents -----------------------------------------------------------
  { ext: "txt", name: "Plain Text", mime: "text/plain", category: "document", extractor: "text" },
  { ext: "md", name: "Markdown", mime: "text/markdown", category: "document", extractor: "text" },
  { ext: "log", name: "Log File", mime: "text/plain", category: "document", extractor: "text" },
  { ext: "rst", name: "reStructuredText", mime: "text/x-rst", category: "document", extractor: "text" },
  { ext: "tex", name: "LaTeX Source", mime: "application/x-tex", category: "document", extractor: "text" },
  { ext: "pdf", name: "PDF Document", mime: "application/pdf", category: "document", extractor: "pdf", binary: true },
  { ext: "docx", name: "Word Document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", category: "document", extractor: "docx", binary: true },
  { ext: "doc", name: "Word 97-2003 Document", mime: "application/msword", category: "document", extractor: "metadata", binary: true },
  { ext: "odt", name: "OpenDocument Text", mime: "application/vnd.oasis.opendocument.text", category: "document", extractor: "odt", binary: true },
  { ext: "rtf", name: "Rich Text Format", mime: "application/rtf", category: "document", extractor: "rtf", binary: true },
  { ext: "pages", name: "Apple Pages", mime: "application/vnd.apple.pages", category: "document", extractor: "metadata", binary: true },
  { ext: "eml", name: "Email Message", mime: "message/rfc822", category: "document", extractor: "text" },
  { ext: "msg", name: "Outlook Message", mime: "application/vnd.ms-outlook", category: "document", extractor: "metadata", binary: true },
  { ext: "mbox", name: "Mbox Mailbox", mime: "application/mbox", category: "document", extractor: "text" },

  // --- spreadsheets --------------------------------------------------------
  { ext: "csv", name: "CSV", mime: "text/csv", category: "spreadsheet", extractor: "csv" },
  { ext: "tsv", name: "TSV", mime: "text/tab-separated-values", category: "spreadsheet", extractor: "csv" },
  { ext: "xlsx", name: "Excel Workbook", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", category: "spreadsheet", extractor: "xlsx", binary: true },
  { ext: "xlsm", name: "Excel Macro-Enabled Workbook", mime: "application/vnd.ms-excel.sheet.macroenabled.12", category: "spreadsheet", extractor: "xlsx", binary: true },
  { ext: "xls", name: "Excel 97-2003 Workbook", mime: "application/vnd.ms-excel", category: "spreadsheet", extractor: "metadata", binary: true },
  { ext: "ods", name: "OpenDocument Spreadsheet", mime: "application/vnd.oasis.opendocument.spreadsheet", category: "spreadsheet", extractor: "ods", binary: true },
  { ext: "numbers", name: "Apple Numbers", mime: "application/vnd.apple.numbers", category: "spreadsheet", extractor: "metadata", binary: true },
  { ext: "parquet", name: "Parquet", mime: "application/vnd.apache.parquet", category: "spreadsheet", extractor: "metadata", binary: true },
  { ext: "dbf", name: "dBASE Table", mime: "application/x-dbf", category: "spreadsheet", extractor: "metadata", binary: true },

  // --- data / structured ---------------------------------------------------
  { ext: "json", name: "JSON", mime: "application/json", category: "data", extractor: "json" },
  { ext: "jsonl", name: "JSON Lines", mime: "application/x-ndjson", category: "data", extractor: "jsonl" },
  { ext: "ndjson", name: "NDJSON", mime: "application/x-ndjson", category: "data", extractor: "jsonl" },
  { ext: "geojson", name: "GeoJSON", mime: "application/geo+json", category: "data", extractor: "json" },
  { ext: "xml", name: "XML", mime: "application/xml", category: "data", extractor: "xml" },
  { ext: "yaml", name: "YAML", mime: "application/yaml", category: "data", extractor: "yaml" },
  { ext: "yml", name: "YAML", mime: "application/yaml", category: "data", extractor: "yaml" },
  { ext: "toml", name: "TOML", mime: "application/toml", category: "data", extractor: "toml" },
  { ext: "plist", name: "Property List", mime: "application/x-plist", category: "data", extractor: "xml" },
  { ext: "sql", name: "SQL Script", mime: "application/sql", category: "data", extractor: "text" },
  { ext: "ipynb", name: "Jupyter Notebook", mime: "application/x-ipynb+json", category: "data", extractor: "json" },
  { ext: "ics", name: "iCalendar", mime: "text/calendar", category: "data", extractor: "ics" },
  { ext: "vcf", name: "vCard", mime: "text/vcard", category: "data", extractor: "vcf" },
  { ext: "srt", name: "SubRip Subtitles", mime: "application/x-subrip", category: "data", extractor: "srt" },
  { ext: "vtt", name: "WebVTT Subtitles", mime: "text/vtt", category: "data", extractor: "vtt" },
  { ext: "graphql", name: "GraphQL Schema", mime: "application/graphql", category: "data", extractor: "text" },
  { ext: "proto", name: "Protocol Buffers", mime: "text/x-protobuf", category: "data", extractor: "text" },
  { ext: "avro", name: "Avro Schema", mime: "application/avro", category: "data", extractor: "text" },
  { ext: "msgpack", name: "MessagePack", mime: "application/msgpack", category: "data", extractor: "metadata", binary: true },
  { ext: "bson", name: "BSON", mime: "application/bson", category: "data", extractor: "metadata", binary: true },
  { ext: "pickle", name: "Python Pickle", mime: "application/octet-stream", category: "data", extractor: "metadata", binary: true },

  // --- markup / web --------------------------------------------------------
  { ext: "html", name: "HTML", mime: "text/html", category: "markup", extractor: "html" },
  { ext: "htm", name: "HTML", mime: "text/html", category: "markup", extractor: "html" },
  { ext: "xhtml", name: "XHTML", mime: "application/xhtml+xml", category: "markup", extractor: "xml" },
  { ext: "mht", name: "MHTML Web Archive", mime: "multipart/related", category: "markup", extractor: "text" },
  { ext: "rss", name: "RSS Feed", mime: "application/rss+xml", category: "markup", extractor: "xml" },
  { ext: "atom", name: "Atom Feed", mime: "application/atom+xml", category: "markup", extractor: "xml" },
  { ext: "sitemap", name: "Sitemap", mime: "application/xml", category: "markup", extractor: "xml" },
  { ext: "svg", name: "SVG Vector Image", mime: "image/svg+xml", category: "markup", extractor: "xml" },

  // --- code / dev ----------------------------------------------------------
  { ext: "js", name: "JavaScript", mime: "application/javascript", category: "code", extractor: "text" },
  { ext: "mjs", name: "JavaScript Module", mime: "application/javascript", category: "code", extractor: "text" },
  { ext: "cjs", name: "CommonJS Module", mime: "application/javascript", category: "code", extractor: "text" },
  { ext: "jsx", name: "React JSX", mime: "text/jsx", category: "code", extractor: "text" },
  { ext: "ts", name: "TypeScript", mime: "application/typescript", category: "code", extractor: "text" },
  { ext: "tsx", name: "React TSX", mime: "text/tsx", category: "code", extractor: "text" },
  { ext: "py", name: "Python", mime: "text/x-python", category: "code", extractor: "text" },
  { ext: "java", name: "Java", mime: "text/x-java-source", category: "code", extractor: "text" },
  { ext: "c", name: "C Source", mime: "text/x-c", category: "code", extractor: "text" },
  { ext: "h", name: "C Header", mime: "text/x-c", category: "code", extractor: "text" },
  { ext: "cpp", name: "C++ Source", mime: "text/x-c++src", category: "code", extractor: "text" },
  { ext: "cs", name: "C# Source", mime: "text/x-csharp", category: "code", extractor: "text" },
  { ext: "go", name: "Go Source", mime: "text/x-go", category: "code", extractor: "text" },
  { ext: "rb", name: "Ruby", mime: "text/x-ruby", category: "code", extractor: "text" },
  { ext: "php", name: "PHP", mime: "application/x-php", category: "code", extractor: "text" },
  { ext: "swift", name: "Swift", mime: "text/x-swift", category: "code", extractor: "text" },
  { ext: "kt", name: "Kotlin", mime: "text/x-kotlin", category: "code", extractor: "text" },
  { ext: "rs", name: "Rust", mime: "text/x-rust", category: "code", extractor: "text" },
  { ext: "sh", name: "Shell Script", mime: "application/x-sh", category: "code", extractor: "text" },
  { ext: "bash", name: "Bash Script", mime: "application/x-sh", category: "code", extractor: "text" },
  { ext: "zsh", name: "Zsh Script", mime: "text/x-scriptzsh", category: "code", extractor: "text" },
  { ext: "bat", name: "Windows Batch", mime: "application/x-msdos-program", category: "code", extractor: "text" },
  { ext: "ps1", name: "PowerShell", mime: "application/x-powershell", category: "code", extractor: "text" },
  { ext: "css", name: "CSS", mime: "text/css", category: "code", extractor: "text" },
  { ext: "scss", name: "SCSS", mime: "text/x-scss", category: "code", extractor: "text" },
  { ext: "less", name: "LESS", mime: "text/less", category: "code", extractor: "text" },
  { ext: "vue", name: "Vue Component", mime: "text/x-vue", category: "code", extractor: "text" },
  { ext: "svelte", name: "Svelte Component", mime: "text/x-svelte", category: "code", extractor: "text" },
  { ext: "dockerfile", name: "Dockerfile", mime: "text/plain", category: "code", extractor: "text" },
  { ext: "makefile", name: "Makefile", mime: "text/x-makefile", category: "code", extractor: "text" },
  { ext: "diff", name: "Diff / Patch", mime: "text/x-diff", category: "code", extractor: "text" },
  { ext: "patch", name: "Patch File", mime: "text/x-diff", category: "code", extractor: "text" },

  // --- config --------------------------------------------------------------
  { ext: "ini", name: "INI Config", mime: "text/plain", category: "config", extractor: "ini" },
  { ext: "cfg", name: "Config File", mime: "text/plain", category: "config", extractor: "ini" },
  { ext: "conf", name: "Configuration", mime: "text/plain", category: "config", extractor: "ini" },
  { ext: "properties", name: "Java Properties", mime: "text/x-java-properties", category: "config", extractor: "ini" },
  { ext: "env", name: "Environment File", mime: "text/plain", category: "config", extractor: "ini" },
  { ext: "lock", name: "Lock File", mime: "application/json", category: "config", extractor: "text" },

  // --- images --------------------------------------------------------------
  { ext: "png", name: "PNG Image", mime: "image/png", category: "image", extractor: "image", binary: true },
  { ext: "jpg", name: "JPEG Image", mime: "image/jpeg", category: "image", extractor: "image", binary: true },
  { ext: "jpeg", name: "JPEG Image", mime: "image/jpeg", category: "image", extractor: "image", binary: true },
  { ext: "gif", name: "GIF Image", mime: "image/gif", category: "image", extractor: "image", binary: true },
  { ext: "webp", name: "WebP Image", mime: "image/webp", category: "image", extractor: "image", binary: true },
  { ext: "bmp", name: "BMP Image", mime: "image/bmp", category: "image", extractor: "image", binary: true },
  { ext: "tiff", name: "TIFF Image", mime: "image/tiff", category: "image", extractor: "image", binary: true },
  { ext: "tif", name: "TIFF Image", mime: "image/tiff", category: "image", extractor: "image", binary: true },
  { ext: "ico", name: "Icon (ICO)", mime: "image/x-icon", category: "image", extractor: "image", binary: true },
  { ext: "heic", name: "HEIC Image", mime: "image/heic", category: "image", extractor: "metadata", binary: true },
  { ext: "avif", name: "AVIF Image", mime: "image/avif", category: "image", extractor: "metadata", binary: true },

  // --- audio ---------------------------------------------------------------
  { ext: "mp3", name: "MP3 Audio", mime: "audio/mpeg", category: "audio", extractor: "mp3", binary: true },
  { ext: "wav", name: "WAV Audio", mime: "audio/wav", category: "audio", extractor: "wav", binary: true },
  { ext: "ogg", name: "OGG Audio", mime: "audio/ogg", category: "audio", extractor: "ogg", binary: true },
  { ext: "oga", name: "OGG Audio", mime: "audio/ogg", category: "audio", extractor: "ogg", binary: true },
  { ext: "flac", name: "FLAC Audio", mime: "audio/flac", category: "audio", extractor: "flac", binary: true },
  { ext: "m4a", name: "M4A Audio", mime: "audio/mp4", category: "audio", extractor: "mp4", binary: true },
  { ext: "aac", name: "AAC Audio", mime: "audio/aac", category: "audio", extractor: "metadata", binary: true },
  { ext: "wma", name: "WMA Audio", mime: "audio/x-ms-wma", category: "audio", extractor: "metadata", binary: true },
  { ext: "opus", name: "Opus Audio", mime: "audio/opus", category: "audio", extractor: "metadata", binary: true },
  { ext: "mid", name: "MIDI", mime: "audio/midi", category: "audio", extractor: "metadata", binary: true },

  // --- video ---------------------------------------------------------------
  { ext: "mp4", name: "MP4 Video", mime: "video/mp4", category: "video", extractor: "mp4", binary: true },
  { ext: "m4v", name: "M4V Video", mime: "video/x-m4v", category: "video", extractor: "mp4", binary: true },
  { ext: "mkv", name: "Matroska Video", mime: "video/x-matroska", category: "video", extractor: "webm", binary: true },
  { ext: "webm", name: "WebM Video", mime: "video/webm", category: "video", extractor: "webm", binary: true },
  { ext: "avi", name: "AVI Video", mime: "video/x-msvideo", category: "video", extractor: "metadata", binary: true },
  { ext: "mov", name: "QuickTime Movie", mime: "video/quicktime", category: "video", extractor: "metadata", binary: true },
  { ext: "wmv", name: "WMV Video", mime: "video/x-ms-wmv", category: "video", extractor: "metadata", binary: true },
  { ext: "flv", name: "Flash Video", mime: "video/x-flv", category: "video", extractor: "metadata", binary: true },
  { ext: "mpg", name: "MPEG Video", mime: "video/mpeg", category: "video", extractor: "metadata", binary: true },
  { ext: "mpeg", name: "MPEG Video", mime: "video/mpeg", category: "video", extractor: "metadata", binary: true },
  { ext: "3gp", name: "3GPP Video", mime: "video/3gpp", category: "video", extractor: "metadata", binary: true },

  // --- archives ------------------------------------------------------------
  { ext: "zip", name: "ZIP Archive", mime: "application/zip", category: "archive", extractor: "zip", binary: true },
  { ext: "jar", name: "Java Archive", mime: "application/java-archive", category: "archive", extractor: "zip", binary: true },
  { ext: "apk", name: "Android Package", mime: "application/vnd.android.package-archive", category: "archive", extractor: "zip", binary: true },
  { ext: "ipa", name: "iOS App Archive", mime: "application/octet-stream", category: "archive", extractor: "zip", binary: true },
  { ext: "tar", name: "TAR Archive", mime: "application/x-tar", category: "archive", extractor: "tar", binary: true },
  { ext: "gz", name: "GZip Archive", mime: "application/gzip", category: "archive", extractor: "gz", binary: true },
  { ext: "tgz", name: "TAR.GZ Archive", mime: "application/gzip", category: "archive", extractor: "gz", binary: true },
  { ext: "bz2", name: "BZip2 Archive", mime: "application/x-bzip2", category: "archive", extractor: "metadata", binary: true },
  { ext: "xz", name: "XZ Archive", mime: "application/x-xz", category: "archive", extractor: "metadata", binary: true },
  { ext: "7z", name: "7-Zip Archive", mime: "application/x-7z-compressed", category: "archive", extractor: "metadata", binary: true },
  { ext: "rar", name: "RAR Archive", mime: "application/vnd.rar", category: "archive", extractor: "metadata", binary: true },
  { ext: "iso", name: "ISO Disk Image", mime: "application/x-iso9660-image", category: "archive", extractor: "metadata", binary: true },
  { ext: "deb", name: "Debian Package", mime: "application/vnd.debian.binary-package", category: "archive", extractor: "metadata", binary: true },

  // --- fonts ---------------------------------------------------------------
  { ext: "ttf", name: "TrueType Font", mime: "font/ttf", category: "font", extractor: "metadata", binary: true },
  { ext: "otf", name: "OpenType Font", mime: "font/otf", category: "font", extractor: "metadata", binary: true },
  { ext: "woff", name: "WOFF Font", mime: "font/woff", category: "font", extractor: "metadata", binary: true },
  { ext: "woff2", name: "WOFF2 Font", mime: "font/woff2", category: "font", extractor: "metadata", binary: true },
  { ext: "eot", name: "Embedded OpenType Font", mime: "application/vnd.ms-fontobject", category: "font", extractor: "metadata", binary: true },

  // --- ebooks --------------------------------------------------------------
  { ext: "epub", name: "EPUB eBook", mime: "application/epub+zip", category: "ebook", extractor: "epub", binary: true },
  { ext: "mobi", name: "MOBI eBook", mime: "application/x-mobipocket-ebook", category: "ebook", extractor: "metadata", binary: true },

  // --- databases -----------------------------------------------------------
  { ext: "sqlite", name: "SQLite Database", mime: "application/vnd.sqlite3", category: "database", extractor: "metadata", binary: true },
  { ext: "sqlite3", name: "SQLite Database", mime: "application/vnd.sqlite3", category: "database", extractor: "metadata", binary: true },
  { ext: "db", name: "Database File", mime: "application/octet-stream", category: "database", extractor: "metadata", binary: true },

  // --- certificates / keys -------------------------------------------------
  { ext: "pem", name: "PEM Certificate / Key", mime: "application/x-pem-file", category: "certificate", extractor: "text" },
  { ext: "crt", name: "Certificate", mime: "application/x-x509-ca-cert", category: "certificate", extractor: "text" },
  { ext: "key", name: "Private Key", mime: "application/x-iwork-keynote-sffkey", category: "certificate", extractor: "text" },
  { ext: "pub", name: "Public Key", mime: "application/octet-stream", category: "certificate", extractor: "text" },

  // --- other ---------------------------------------------------------------
  { ext: "exe", name: "Windows Executable", mime: "application/vnd.microsoft.portable-executable", category: "other", extractor: "metadata", binary: true },
  { ext: "dll", name: "Windows DLL", mime: "application/vnd.microsoft.portable-executable", category: "other", extractor: "metadata", binary: true },
  { ext: "elf", name: "ELF Executable", mime: "application/x-executable", category: "other", extractor: "metadata", binary: true },
  { ext: "bin", name: "Binary File", mime: "application/octet-stream", category: "other", extractor: "metadata", binary: true },
];

// ----------------------------------------------------------------------------
// Lookup helpers
// ----------------------------------------------------------------------------

const byExt = new Map();
const byMime = new Map();
for (const t of FILE_TYPES) {
  if (!byExt.has(t.ext)) byExt.set(t.ext, t);
  if (t.mime && !byMime.has(t.mime.toLowerCase())) byMime.set(t.mime.toLowerCase(), t);
}

// Magic-byte sniffers, tried in order after extension/MIME lookup.
const MAGIC = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: "png" },
  { bytes: [0xff, 0xd8, 0xff], type: "jpg" },
  { bytes: [0x47, 0x49, 0x46, 0x38], type: "gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46], type: "riff" }, // WAV / AVI / WebP — refined below
  { bytes: [0x49, 0x49, 0x2a, 0x00], type: "tiff" },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], type: "tiff" },
  { bytes: [0x25, 0x50, 0x44, 0x46], type: "pdf" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: "zip" },
  { bytes: [0x50, 0x4b, 0x05, 0x06], type: "zip" },
  { bytes: [0x1f, 0x8b], type: "gz" },
  { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], type: "tar" },
  { bytes: [0x66, 0x4c, 0x61, 0x43], type: "flac" },
  { bytes: [0x4f, 0x67, 0x67, 0x53], type: "ogg" },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], type: "webm" },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], type: "7z" },
  { bytes: [0x52, 0x61, 0x72, 0x21], type: "rar" },
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], type: "sqlite" },
  { bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66], type: "rtf" },
  { bytes: [0x42, 0x4d], type: "bmp" },
  { bytes: [0x00, 0x00, 0x01, 0x00], type: "ico" },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], type: "elf" },
  { bytes: [0x4d, 0x5a], type: "exe" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], type: "docx" }, // docx/xlsx are zips; extension decides
];

function sniffType(buf) {
  if (!buf || buf.length < 4) return null;
  for (const m of MAGIC) {
    if (m.bytes.length > buf.length) continue;
    let ok = true;
    for (let i = 0; i < m.bytes.length; i++) {
      if (buf[i] !== m.bytes[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      // RIFF containers: distinguish WAV / AVI / WebP
      if (m.type === "riff" && buf.length >= 12) {
        const kind = buf.toString("latin1", 8, 12);
        if (kind === "WAVE") return "wav";
        if (kind === "AVI ") return "avi";
        if (kind === "WEBP") return "webp";
        return "riff";
      }
      return m.type;
    }
  }
  return null;
}

function extFromName(fileName) {
  if (!fileName) return null;
  const clean = String(fileName).split(/[?#]/)[0].replace(/\\/g, "/").split("/").pop() || "";
  const dot = clean.lastIndexOf(".");
  if (dot <= 0 || dot === clean.length - 1) return null;
  return clean.slice(dot + 1).toLowerCase();
}

function isProbablyText(buf) {
  if (!buf || !buf.length) return true;
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

/**
 * Best-effort detection of a file's type.
 * Order: file name extension → MIME type → magic bytes → "looks like text".
 * Returns a FILE_TYPES entry or null.
 */
export function detectFileType({ fileName, mimeType, data } = {}) {
  const ext = extFromName(fileName);
  if (ext && byExt.has(ext)) return byExt.get(ext);

  if (mimeType) {
    const mime = String(mimeType).split(";")[0].trim().toLowerCase();
    if (byMime.has(mime)) return byMime.get(mime);
  }

  const buf = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data) : null;
  if (buf) {
    const sniffed = sniffType(buf);
    if (sniffed && byExt.has(sniffed)) return byExt.get(sniffed);
    if (isProbablyText(buf)) return byExt.get("txt");
  }

  return null;
}

export function categoryLabel(category) {
  return FILE_TYPE_CATEGORIES[category]?.label || category || "Other";
}

/** MIME type for a file name (best effort, falls back to application/octet-stream). */
export function mimeTypeFor(fileName) {
  const ext = extFromName(fileName);
  const t = ext && byExt.get(ext);
  return t?.mime || "application/octet-stream";
}
