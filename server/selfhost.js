// ============================================================================
// W FLOW — self-hosted installer (a Pro perk)
//
// Settings → Defaults → “Run it self-hosted” (and the main page's self-hosted
// card) downloads a one-file installer from this instance: a Windows `.bat`, a
// macOS `.command` or a Linux `.sh`. The installer pulls a ZIP of the app
// (buildSelfhostBundle), unpacks it into the folder the user picks, installs its
// dependencies and creates a launcher — so the copy runs on the user's own
// machine and nothing about it is ever stored here.
//
// The installer also SETS THE COPY UP (see the prompts in the scripts): where it
// lives, which port the builder UI uses, whether it is a builder (UI +
// database), a runner (executes runs sent by another copy) or both, where
// workflows should execute (this machine or a remote runner) and where the data
// lives (a file next to the app, or the user's own PostgreSQL server). The
// answers are written into the copy's own .env — a fresh encryption key, its
// own database path, its own runner token — and can be changed later from the
// copy's Setup page (server/setup.js). An existing .env is never overwritten:
// it holds the key that decrypts that copy's stored credentials.
//
// Why the script carries a link instead of a session cookie: the bundle is
// downloaded by curl/wget on the user's machine, which has no cookie jar. The
// link is HMAC-signed with the instance key (security.getEncryptionKey) and
// expires after BUNDLE_TTL_MS — the Pro check happens when the script itself is
// requested (GET /api/selfhosted/installer), not when the bundle is fetched.
//
// What goes into the bundle: the files a running copy needs (server, shared,
// public, package files, and either the prebuilt dist/ or the src/ to rebuild
// it) plus the docs and launchers. Never the ./data folder (the database with
// accounts, sessions and workflows) and never the .env (encryption key, Stripe
// and admin secrets) — see EXCLUDE for the full skip list. A downloaded copy
// therefore starts empty and can reach no other instance: WFLOW_STANDALONE=1
// marks it as the user's own, and it only accepts runs from a remote builder
// once its owner created a runner token for it.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createZipBuffer } from "./fileextract.js";
import { getEncryptionKey } from "./security.js";

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the installer starts the local copy (same default as start.sh). */
export const SELFHOST_PORT = 3001;
/** How long the download link inside the script stays valid. */
export const BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// What to ship
// ---------------------------------------------------------------------------

/** Folders a running copy needs. `src` is optional: without it we ship `dist`. */
export const SHIP_DIRS = ["server", "shared", "public", "dist", "src", "docs"];
/** Files at the root worth shipping (only the ones that exist are included). */
export const SHIP_FILES = [
  "package.json",
  "package-lock.json",
  ".env.example",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "README.md",
  "ERRORS.md",
  "docker-compose.yml",
  "Dockerfile",
  "start.sh",
  "start.bat",
  "admin.sh",
  "admin.bat",
  ".gitignore",
];
/** Folder names never walked. `data` is the database, `tests` is dev-only. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  "data",
  "tests",
  "coverage",
  ".vite",
  ".cache",
  "tmp",
  "bug screens",
  "TESTWORKFLOW",
]);
/** Security / noise: the live .env, databases, logs and archives. */
const SKIP_FILE = /^(\.env|\.DS_Store)$|\.(log|db|db-wal|db-shm|sqlite|sqlite3|zip|gz)$/i;

const MAX_FILES = 4000;
const MAX_BYTES = 64 * 1024 * 1024;

function walk(dir, out, depth = 0) {
  if (depth > 8 || out.length >= MAX_FILES) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out, depth + 1);
    } else if (entry.isFile() && !SKIP_FILE.test(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * Everything the installer should receive, as `{ name, data }` ZIP entries.
 * Returns an empty list when this instance has no app files to ship (a
 * deployment that only carries the built UI, for instance).
 */
export function collectShipFiles() {
  const files = [];
  for (const file of SHIP_FILES) {
    const full = path.join(APP_ROOT, file);
    try {
      if (fs.statSync(full).isFile()) files.push(full);
    } catch {
      /* not present — the installer copes */
    }
  }
  for (const dir of SHIP_DIRS) {
    const full = path.join(APP_ROOT, dir);
    try {
      if (fs.statSync(full).isDirectory()) walk(full, files);
    } catch {
      /* not present */
    }
  }
  return files;
}

/** Can this instance produce a usable self-hosted copy? */
export function selfhostReadiness() {
  const has = (rel) => {
    try {
      return fs.existsSync(path.join(APP_ROOT, rel));
    } catch {
      return false;
    }
  };
  if (!has("package.json") || !has("server/index.js")) {
    return {
      ready: false,
      port: SELFHOST_PORT,
      reason: "This instance does not carry the application files (package.json / server) — it cannot offer a self-hosted copy. Run the server from the project folder.",
    };
  }
  if (!has("dist") && !has("src")) {
    return {
      ready: false,
      port: SELFHOST_PORT,
      reason: "Neither the built interface (dist/) nor its source (src/) is present, so a downloaded copy could not serve the UI. Build it with `npm run build` first.",
    };
  }
  return {
    ready: true,
    port: SELFHOST_PORT,
    // prebuilt: the copy needs no build step — only production dependencies
    prebuilt: !has("src"),
    reason: "",
  };
}

/** The file inside every bundle that names its version (server/updater.js reads it). */
export const VERSION_FILE = "wflow-version.json";

function shipEntries() {
  const entries = [];
  let bytes = 0;
  for (const full of collectShipFiles()) {
    let data;
    try {
      data = fs.readFileSync(full);
    } catch {
      continue;
    }
    bytes += data.length;
    if (bytes > MAX_BYTES) break;
    const name = path.relative(APP_ROOT, full).split(path.sep).join("/");
    if (name === VERSION_FILE) continue; // a copy's own stamp is never shipped back out
    entries.push({ name, data });
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The version of a set of app files: package.json's version plus a hash of
 * every shipped file. Any deploy that changes a file changes the version, so a
 * copy can tell "behind" from "current" without release numbers.
 */
export function versionOf(entries) {
  const hash = createHash("sha256");
  for (const e of entries) hash.update(e.name).update("\0").update(e.data).update("\0");
  let pkg = "0.0.0";
  try {
    pkg = JSON.parse(entries.find((e) => e.name === "package.json")?.data.toString("utf8") || "{}").version || pkg;
  } catch {
    /* keep the default */
  }
  return `${pkg}+${hash.digest("hex").slice(0, 12)}`;
}

// Built once per process: the files only change with a deploy, which restarts.
let bundleCache = null;

/** Build the ZIP the installer downloads, or null when there is nothing to ship. */
export function buildSelfhostBundle() {
  if (bundleCache) return bundleCache;
  const entries = shipEntries();
  if (!entries.length) return null;
  const version = versionOf(entries);
  const stamp = { name: VERSION_FILE, data: Buffer.from(JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2)) };
  const bytes = entries.reduce((n, e) => n + e.data.length, 0);
  bundleCache = { zip: createZipBuffer([...entries, stamp]), files: entries.length + 1, bytes, version };
  return bundleCache;
}

/** The version this instance would ship ("" when it carries no app files). */
export function shippedVersion() {
  return buildSelfhostBundle()?.version || "";
}

/** Test hook. */
export function resetBundleCache() {
  bundleCache = null;
}

// ---------------------------------------------------------------------------
// Download link (HMAC-signed, no session needed)
// ---------------------------------------------------------------------------

function bundleSecret() {
  return createHmac("sha256", getEncryptionKey()).update("wflow:selfhosted:bundle").digest();
}

function sign(expiry) {
  return createHmac("sha256", bundleSecret()).update(String(expiry)).digest("hex");
}

/** A link token that lets curl fetch the bundle without a login cookie. */
export function newBundleToken(ttlMs = BUNDLE_TTL_MS) {
  const expiry = Date.now() + Math.max(0, Number(ttlMs) || 0);
  return `${expiry}.${sign(expiry)}`;
}

/** True when the token was signed by this instance and has not expired. */
export function verifyBundleToken(token) {
  const [expiry, signature] = String(token || "").split(".");
  if (!expiry || !signature) return false;
  const expected = sign(expiry);
  if (expected.length !== signature.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  return Number(expiry) > Date.now();
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/**
 * Which of the three supported desktop platforms an installer request is for.
 * Unknown values fall back to Linux — the bash script is the portable one.
 */
export function normalizeInstallerOs(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "windows" || v === "win" || v === "win32") return "windows";
  if (v === "mac" || v === "macos" || v === "mac-os" || v === "darwin") return "mac";
  return "linux";
}

/**
 * File extension for the installer: `.bat` on Windows, `.command` on macOS
 * (double-clickable in Finder) and `.sh` on Linux.
 */
export function installerExtension(os) {
  const platform = normalizeInstallerOs(os);
  return platform === "windows" ? "bat" : platform === "mac" ? "command" : "sh";
}

/**
 * The one-file installer the user downloads. `os` picks the Windows batch
 * script or the POSIX shell script (macOS / Linux); `baseUrl` + `token` become
 * the download link the script uses.
 */
export function installerScript({ os = "unix", baseUrl = "", token = "", port = SELFHOST_PORT, licenseKey = "", licenseServer = "" } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/api/selfhosted/bundle?token=${token}`;
  const p = Number(port) || SELFHOST_PORT;
  const platform = normalizeInstallerOs(os);
  const lic = licenseLines({ licenseKey, licenseServer });
  return platform === "windows" ? windowsScript(url, p, lic) : unixScript(url, p, platform, lic);
}

/**
 * The .env lines that tie the copy to the downloader's licence (server/
 * license.js). Both values are checked against a strict pattern because they
 * are pasted into shell and PowerShell source as literals.
 */
export function licenseLines({ licenseKey = "", licenseServer = "" } = {}) {
  const lines = [];
  if (/^wfl_[A-Za-z0-9_-]{20,64}$/.test(licenseKey)) lines.push(`WFLOW_LICENSE_KEY=${licenseKey}`);
  if (/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(licenseServer)) lines.push(`WFLOW_LICENSE_SERVER=${licenseServer}`);
  return lines;
}

// ---------------------------------------------------------------------------
// The POSIX installer (Linux + macOS)
// ---------------------------------------------------------------------------

function unixScript(url, port, platform = "linux", lic = []) {
  const isMac = platform === "mac";
  const label = isMac ? "macOS" : "Linux";
  const scriptName = isMac ? "wflow-selfhost.command" : "wflow-selfhost.sh";
  const nodeHint = isMac
    ? "  echo '  [ERROR] Node.js 20 or newer is required - install it from https://nodejs.org or with: brew install node'"
    : "  echo '  [ERROR] Node.js 20 or newer is required: https://nodejs.org'";
  const openCmd = isMac ? "open" : "xdg-open";
  return [
    "#!/usr/bin/env bash",
    "# ==========================================================================",
    `# W flow — self-hosted installer (${label})`,
    "#",
    "# Downloads the W flow app onto THIS machine, sets it up and creates a",
    "# launcher that starts the builder and opens it in your browser.",
    "#",
    `#   bash ${scriptName}                  # installs into ~/wflow`,
    "#",
    "# Non-interactive use (every question can be answered up front):",
    `#   WFLOW_DIR=/opt/wflow PORT=3001 WFLOW_ROLE=builder bash ${scriptName}`,
    "#   WFLOW_ROLE=runner                       only executes runs sent by a builder",
    "#   WFLOW_ROLE=both                         builder and runner",
    "#   WFLOW_REMOTE_URL=http://203.0.113.10:3001 WFLOW_REMOTE_TOKEN=…",
    "#                                           send runs to that runner instead",
    "#   DATABASE_URL=postgres://user:pw@host:5432/wflow",
    "#                                           keep the data on your own server",
    "#",
    "# The app link below expires 24 hours after you downloaded this file; get a",
    "# fresh installer from Settings -> Defaults if it has.",
    "# ==========================================================================",
    "set -euo pipefail",
    "",
    `BUNDLE_URL="${url}"`,
    `DEFAULT_PORT="${port}"`,
    "",
    "# ask <question> <default> <variable-name> - an already-set variable wins, so",
    "# the script also works unattended (CI, cloud-init, a setup script).",
    "ask() {",
    "  local answer=",
    '  if [ -n "${!3-}" ]; then return 0; fi',
    '  printf "  %s [%s]: " "$1" "$2"',
    "  read -r answer || true",
    '  answer="${answer:-$2}"',
    '  printf -v "$3" "%s" "$answer"',
    "}",
    "",
    'echo ""',
    "echo '  W FLOW - self-hosted setup'",
    "echo '  --------------------------'",
    `echo "  System : ${label}"`,
    "echo ''",
    "echo '  Answer the questions below (Enter keeps the value in brackets).'",
    "echo ''",
    "",
    'ask "Install folder" "$HOME/wflow" WFLOW_DIR',
    'ask "Port for the builder UI" "$DEFAULT_PORT" WFLOW_PORT',
    "",
    "# --- what this copy is ----------------------------------------------------",
    'ROLE_RAW="${WFLOW_ROLE:-}"',
    'if [ -z "$ROLE_RAW" ]; then',
    '  echo ""',
    "  echo '  What is this copy for?'",
    "  echo '    1) builder - the interface and the database (default)'",
    "  echo '    2) runner  - executes runs another copy sends here'",
    "  echo '    3) both'",
    '  ask "  Choose 1-3" "1" ROLE_RAW',
    "fi",
    'case "$ROLE_RAW" in',
    '  2|runner|r) WFLOW_ROLE=runner ;;',
    '  3|both|b)   WFLOW_ROLE=both ;;',
    "  *)          WFLOW_ROLE=builder ;;",
    "esac",
    "",
    "# --- where runs execute ---------------------------------------------------",
    "EXEC_MODE=local",
    'if [ "$WFLOW_ROLE" != "runner" ]; then',
    '  if [ -n "${WFLOW_REMOTE_URL:-}" ]; then',
    "    EXEC_MODE=remote",
    "  else",
    '    echo ""',
    "    echo '  Where should workflows execute?'",
    "    echo '    1) on this machine (default)'",
    "    echo '    2) on a runner I installed on another server'",
    '    ask "  Choose 1-2" "1" EXEC_RAW',
    '    case "$EXEC_RAW" in',
    "      2|remote|r)",
    "        EXEC_MODE=remote",
    '        ask "  Runner URL (e.g. http://203.0.113.10:3001)" "" WFLOW_REMOTE_URL',
    '        ask "  Runner token (from the runner\'s Setup page)" "" WFLOW_REMOTE_TOKEN',
    '        if [ -z "$WFLOW_REMOTE_URL" ] || [ -z "$WFLOW_REMOTE_TOKEN" ]; then',
    "          echo '  [WARN] A remote runner needs both a URL and a token - running locally instead.'",
    "          EXEC_MODE=local",
    "        fi",
    "        ;;",
    "    esac",
    "  fi",
    "fi",
    "",
    "# --- where the data lives -------------------------------------------------",
    'if [ -n "${DATABASE_URL:-}" ]; then',
    "  STORAGE=postgres",
    "else",
    '  echo ""',
    "  echo '  Where should workflows, credentials and run history be stored?'",
    "  echo '    1) a database file on this machine (default)'",
    "  echo '    2) PostgreSQL on a server I run (e.g. my VPS)'",
    '  ask "  Choose 1-2" "1" STORE_RAW',
    '  case "$STORE_RAW" in',
    "    2|postgres|db)",
    "      STORAGE=postgres",
    '      ask "  PostgreSQL URL (postgres://user:password@host:5432/database)" "" DATABASE_URL',
    '      if [ -z "$DATABASE_URL" ]; then',
    "        echo '  [WARN] No PostgreSQL URL given - using a local database file instead.'",
    "        STORAGE=sqlite",
    "      fi",
    "      ;;",
    "    *) STORAGE=sqlite ;;",
    "  esac",
    "fi",
    "if [ \"$STORAGE\" = \"sqlite\" ]; then DB_PATH=\"$WFLOW_DIR/data/admin.db\"; else DB_PATH=\"\"; fi",
    "# A runner URL preset through the environment still needs a token.",
    'if [ "$EXEC_MODE" = "remote" ] && { [ -z "${WFLOW_REMOTE_URL:-}" ] || [ -z "${WFLOW_REMOTE_TOKEN:-}" ]; }; then',
    "  echo '  [WARN] A remote runner needs both a URL and a token - running locally instead.'",
    "  EXEC_MODE=local",
    "fi",
    "",
    "# Depending on the role this copy needs its own token: it is what lets a",
    "# builder send runs here, and nothing else can use this machine.",
    'RUNNER_TOKEN="${WFLOW_RUNNER_TOKEN:-}"',
    'if [ "$WFLOW_ROLE" != "builder" ] && [ -z "$RUNNER_TOKEN" ]; then',
    '  RUNNER_TOKEN="$(node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))")"',
    "fi",
    "",
    "echo ''",
    "echo '  Installing into : '$WFLOW_DIR",
    "echo '  Builder port    : '$WFLOW_PORT",
    "echo '  This copy is    : '$WFLOW_ROLE",
    "echo '  Runs execute on : '$( [ \"$EXEC_MODE\" = remote ] && echo \"$WFLOW_REMOTE_URL\" || echo 'this machine' )",
    "echo '  Data stored     : '$STORAGE",
    "echo ''",
    "",
    "if ! command -v node >/dev/null 2>&1; then",
    nodeHint,
    "  exit 1",
    "fi",
    "if ! command -v npm >/dev/null 2>&1; then",
    "  echo '  [ERROR] npm was not found next to Node.js.'",
    "  exit 1",
    "fi",
    "",
    'mkdir -p "$WFLOW_DIR"',
    'cd "$WFLOW_DIR"',
    "",
    "echo '  Downloading the application...'",
    "if command -v curl >/dev/null 2>&1; then",
    '  curl -fsSL "$BUNDLE_URL" -o wflow-bundle.zip',
    "elif command -v wget >/dev/null 2>&1; then",
    '  wget -q "$BUNDLE_URL" -O wflow-bundle.zip',
    "else",
    "  echo '  [ERROR] curl or wget is needed to download the app.'",
    "  exit 1",
    "fi",
    "",
    "# Unpack into a scratch folder first, so a broken download never leaves a",
    "# half-written app behind, then copy it over the target folder.",
    "echo '  Unpacking...'",
    "rm -rf .wflow-unpack",
    "mkdir -p .wflow-unpack",
    "if command -v unzip >/dev/null 2>&1; then",
    "  unzip -oq wflow-bundle.zip -d .wflow-unpack",
    "elif command -v bsdtar >/dev/null 2>&1; then",
    "  bsdtar -xf wflow-bundle.zip -C .wflow-unpack",
    "else",
    "  tar -xf wflow-bundle.zip -C .wflow-unpack",
    "fi",
    "cp -R .wflow-unpack/. .",
    "rm -rf .wflow-unpack wflow-bundle.zip",
    "",
    "# .env holds this copy's own secrets (its encryption key, its database, its",
    "# runner token). An existing one is NEVER touched: it carries the key that",
    "# decrypts the credentials already stored here.",
    "if [ -f .env ]; then",
    "  echo '  Keeping the existing .env - change these settings in the Setup page.'",
    "else",
    '  KEY="$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")"',
    "  {",
    "    echo '# W flow - written by the self-hosted installer'",
    "    printf 'PORT=%s\\n' \"$WFLOW_PORT\"",
    "    printf 'WFLOW_STANDALONE=1\\n'",
    "    printf 'BF_ENCRYPTION_KEY=%s\\n' \"$KEY\"",
    '    if [ "$STORAGE" = "postgres" ]; then printf \'DATABASE_URL=%s\\n\' "$DATABASE_URL"; else printf \'BF_DB_PATH=%s\\n\' "$DB_PATH"; fi',
    '    if [ "$EXEC_MODE" = "remote" ]; then printf \'WFLOW_REMOTE_URL=%s\\n\' "$WFLOW_REMOTE_URL"; printf \'WFLOW_REMOTE_TOKEN=%s\\n\' "$WFLOW_REMOTE_TOKEN"; fi',
    '    if [ -n "$RUNNER_TOKEN" ]; then printf \'WFLOW_RUNNER_TOKEN=%s\\n\' "$RUNNER_TOKEN"; fi',
    "  } > .env",
    "  echo '  Wrote a fresh .env with its own encryption key.'",
    "fi",
    "# The licence ties this copy to your Pro / Team plan (only the key is ever",
    "# sent to w-flow.tech). A reinstall adds it to an older .env that lacks it.",
    ...lic.map((line) => `grep -q '^${line.split("=")[0]}=' .env || echo '${line}' >> .env`),
    "",
    "# Sources are shipped -> build the interface once (like start.sh); otherwise",
    "# only the runtime dependencies are needed for the prebuilt one.",
    "if [ -d src ] && [ -f vite.config.ts ]; then",
    "  echo '  Installing dependencies (the first run takes a minute)...'",
    "  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi",
    "  echo '  Building the interface...'",
    "  npm run build",
    "else",
    "  echo '  Installing runtime dependencies (the first run takes a minute)...'",
    "  if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi",
    "fi",
    "",
    "# An app you can run: it starts the copy and opens the builder in the default",
    "# browser. On macOS the .command file is double-clickable from Finder.",
    "cat > start-wflow.sh <<'LAUNCH'",
    "#!/usr/bin/env bash",
    "cd \"$(dirname \"$0\")\"",
    `( sleep 4; command -v ${openCmd} >/dev/null 2>&1 && ${openCmd} http://localhost:__LAUNCHPORT__ ) >/dev/null 2>&1 &`,
    "exec node server/index.js",
    "LAUNCH",
    "chmod +x start-wflow.sh",
    `printf '%s\\n' '#!/usr/bin/env bash' 'cd "$(dirname "$0")"' 'exec bash start-wflow.sh' > 'Start W flow.command'`,
    "chmod +x 'Start W flow.command' 2>/dev/null || true",
    "# The launcher carries a placeholder, so the port chosen above ends up in it",
    "# even when it differs from the default. -i.bak works with GNU and BSD sed.",
    'sed -i.bak "s/__LAUNCHPORT__/"$WFLOW_PORT"/" start-wflow.sh 2>/dev/null || true',
    "rm -f start-wflow.sh.bak",
    "",
    "echo ''",
    "echo '  ✓ Installed in '$WFLOW_DIR",
    "echo \"  ✓ Start it with: bash '$WFLOW_DIR/start-wflow.sh'\"",
    isMac ? "echo '    (or double-click “Start W flow.command” in Finder)'" : "echo '    (or make a shortcut to start-wflow.sh)'",
    'echo "  ✓ Builder:     http://localhost:$WFLOW_PORT"',
    'echo "  ✓ Setup page:  http://localhost:$WFLOW_PORT/setup"',
    'echo "    → configure storage + where runs execute there, no .env editing needed."',
    'if [ -n "$RUNNER_TOKEN" ]; then',
    "  echo ''",
    "  echo '  This copy executes runs for a builder. In the OTHER copy open'",
    "  echo '  Setup and enter:'",
    '  echo "    Runner URL   : http://<this-machine>:$WFLOW_PORT"',
    '  echo "    Runner token : $RUNNER_TOKEN"',
    "fi",
    "echo ''",
    'echo "  Starting W flow now on http://localhost:$WFLOW_PORT - press Ctrl+C to stop."',
    "echo ''",
    'PORT="$WFLOW_PORT" node server/index.js',
    "",
  ]
    .join("\n");
}

// ---------------------------------------------------------------------------
// The Windows installer
// ---------------------------------------------------------------------------

/**
 * The PowerShell half of the Windows installer, shipped base64-encoded inside
 * the batch file. It writes the copy's .env (values arrive as process env vars,
 * so nothing has to survive cmd's quoting rules) and creates the launcher plus
 * a desktop shortcut. Templated only with the port.
 */
function windowsHelper(port, lic = []) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$dir = $env:WFLOW_DIR",
    "$lines = @()",
    "$lines += '# W flow - written by the self-hosted installer'",
    "$lines += 'PORT=' + $env:WFLOW_PORT",
    "$lines += 'WFLOW_STANDALONE=1'",
    "$lines += 'BF_ENCRYPTION_KEY=' + $env:WFLOW_KEY",
    "if ($env:WFLOW_DATABASE_URL) { $lines += 'DATABASE_URL=' + $env:WFLOW_DATABASE_URL } else { $lines += 'BF_DB_PATH=' + $env:WFLOW_DB_PATH }",
    "if ($env:WFLOW_REMOTE_URL) { $lines += 'WFLOW_REMOTE_URL=' + $env:WFLOW_REMOTE_URL; $lines += 'WFLOW_REMOTE_TOKEN=' + $env:WFLOW_REMOTE_TOKEN }",
    "if ($env:WFLOW_RUNNER_TOKEN) { $lines += 'WFLOW_RUNNER_TOKEN=' + $env:WFLOW_RUNNER_TOKEN }",
    ...lic.map((line) => `$lines += '${line}'`),
    "$envFile = Join-Path $dir '.env'",
    "if (Test-Path -LiteralPath $envFile) {",
    "  Write-Host '  Keeping the existing .env - change these settings in the Setup page.'",
    // a reinstall adds the licence to an older .env that lacks it
    ...lic.map(
      (line) =>
        `  if (-not (Select-String -LiteralPath $envFile -Pattern '^${line.split("=")[0]}=' -Quiet)) { Add-Content -LiteralPath $envFile -Value '${line}' -Encoding ascii }`
    ),
    "} else {",
    "  Set-Content -LiteralPath $envFile -Value $lines -Encoding ascii",
    "  Write-Host '  Wrote a fresh .env with its own encryption key.'",
    "}",
    "$launcher = @(",
    "  '@echo off'",
    "  'cd /d \"%~dp0\"'",
    "  'echo Starting W flow on http://localhost:" + port + " - close this window to stop.'",
    "  'start \"\" cmd /c \"timeout /t 4 >nul & start http://localhost:" + port + "\"'",
    "  'node server/index.js'",
    "  'pause'",
    ")",
    "Set-Content -LiteralPath (Join-Path $dir 'Start W flow.bat') -Value $launcher -Encoding ascii",
    "try {",
    "  $ws = New-Object -ComObject WScript.Shell",
    "  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'W flow.lnk'))",
    "  $lnk.TargetPath = (Join-Path $dir 'Start W flow.bat')",
    "  $lnk.WorkingDirectory = $dir",
    "  $lnk.Save()",
    "  Write-Host '  Added a desktop shortcut: W flow'",
    "} catch { }",
    "",
  ].join("\n");
}

function windowsScript(url, port, lic = []) {
  const helper = Buffer.from(windowsHelper(port, lic), "utf8").toString("base64");
  return [
    "@echo off",
    "REM ========================================================================",
    "REM W flow - self-hosted installer (Windows)",
    "REM",
    "REM Downloads W flow onto THIS machine, sets it up and adds a launcher that",
    "REM starts the builder and opens it in your browser.",
    "REM",
    "REM   double-click wflow-selfhost.bat      (installs into %USERPROFILE%\\wflow)",
    "REM",
    "REM Non-interactive use (every question can be answered up front):",
    "REM   set WFLOW_DIR=C:\\wflow & set WFLOW_PORT=3001 & set WFLOW_ROLE=builder",
    "REM   set WFLOW_ROLE=runner               only executes runs sent by a builder",
    "REM   set WFLOW_ROLE=both                 builder and runner",
    "REM   set WFLOW_REMOTE_URL=http://203.0.113.10:3001 & set WFLOW_REMOTE_TOKEN=...",
    "REM   set DATABASE_URL=postgres://user:pw@host:5432/wflow",
    "REM",
    "REM The app link below expires 24 hours after you downloaded this file; get a",
    "REM fresh installer from Settings -> Defaults if it has.",
    "REM ========================================================================",
    "setlocal enabledelayedexpansion",
    `if "%WFLOW_PORT%"=="" set "WFLOW_PORT=${port}"`,
    `set "BUNDLE_URL=${url}"`,
    "",
    "echo.",
    "echo   W FLOW - self-hosted setup",
    "echo   --------------------------",
    "echo   System : Windows",
    "echo.",
    "echo   Answer the questions below (Enter keeps the value in brackets).",
    "echo.",
    "",
    'if "%WFLOW_DIR%"=="" set /p "WFLOW_DIR=  Install folder [%USERPROFILE%\\wflow]: "',
    'if "%WFLOW_DIR%"=="" set "WFLOW_DIR=%USERPROFILE%\\wflow"',
    'set /p "TMP_PORT=  Port for the builder UI [%WFLOW_PORT%]: "',
    'if not "%TMP_PORT%"=="" set "WFLOW_PORT=%TMP_PORT%"',
    "",
    "REM --- what this copy is -------------------------------------------------",
    'if "%WFLOW_ROLE%"=="" (',
    "  echo.",
    "  echo   What is this copy for?",
    "  echo     1) builder - the interface and the database (default)",
    "  echo     2) runner  - executes runs another copy sends here",
    "  echo     3) both",
    '  set /p "ROLE_RAW=  Choose 1-3 [1]: "',
    ")",
    'if "%ROLE_RAW%"=="" set "ROLE_RAW=1"',
    'if "%WFLOW_ROLE%"=="" if "%ROLE_RAW%"=="2" set "WFLOW_ROLE=runner"',
    'if "%WFLOW_ROLE%"=="" if "%ROLE_RAW%"=="3" set "WFLOW_ROLE=both"',
    'if "%WFLOW_ROLE%"=="" set "WFLOW_ROLE=builder"',
    "",
    "REM --- where runs execute ------------------------------------------------",
    'set "EXEC_MODE=local"',
    'if not "%WFLOW_ROLE%"=="runner" (',
    '  if not "%WFLOW_REMOTE_URL%"=="" (',
    '    set "EXEC_MODE=remote"',
    "  ) else (",
    "    echo.",
    "    echo   Where should workflows execute?",
    "    echo     1) on this machine (default)",
    "    echo     2) on a runner I installed on another server",
    '    set /p "EXEC_RAW=  Choose 1-2 [1]: "',
    '    if "!EXEC_RAW!"=="2" (',
    '      set "EXEC_MODE=remote"',
    '      set /p "WFLOW_REMOTE_URL=  Runner URL (e.g. http://203.0.113.10:3001): "',
    '      set /p "WFLOW_REMOTE_TOKEN=  Runner token: "',
    "    )",
    "  )",
    ")",
    'if "!EXEC_MODE!"=="remote" if "!WFLOW_REMOTE_TOKEN!"=="" (',
    "  echo   [WARN] A remote runner needs a URL and a token - running locally instead.",
    '  set "EXEC_MODE=local"',
    ")",
    "",
    "REM --- where the data lives ----------------------------------------------",
    'set "STORAGE=sqlite"',
    'if not "%DATABASE_URL%"=="" (',
    '  set "STORAGE=postgres"',
    ") else (",
    "  echo.",
    "  echo   Where should workflows, credentials and run history be stored?",
    "  echo     1) a database file on this machine (default)",
    "  echo     2) PostgreSQL on a server I run (e.g. my VPS)",
    '  set /p "STORE_RAW=  Choose 1-2 [1]: "',
    '  if "!STORE_RAW!"=="2" (',
    '    set "STORAGE=postgres"',
    '    set /p "DATABASE_URL=  PostgreSQL URL (postgres://user:password@host:5432/database): "',
    '    if "!DATABASE_URL!"=="" set "STORAGE=sqlite"',
    "  )",
    ")",
    'if "%STORAGE%"=="sqlite" set "WFLOW_DB_PATH=%WFLOW_DIR%\\data\\admin.db"',
    "",
    "echo.",
    'echo   Installing into : %WFLOW_DIR%',
    'echo   Builder port    : %WFLOW_PORT%',
    'echo   This copy is    : %WFLOW_ROLE%',
    'echo   Data stored     : %STORAGE%',
    "echo.",
    "",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo   [ERROR] Node.js 20 or newer is required: https://nodejs.org",
    "  pause",
    "  exit /b 1",
    ")",
    "where npm >nul 2>nul",
    "if errorlevel 1 (",
    "  echo   [ERROR] npm was not found next to Node.js.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    'if not exist "%WFLOW_DIR%" mkdir "%WFLOW_DIR%"',
    'cd /d "%WFLOW_DIR%"',
    "if errorlevel 1 (",
    "  echo   [ERROR] Could not open %WFLOW_DIR%",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "echo   Downloading the application...",
    'curl -fsSL "%BUNDLE_URL%" -o wflow-bundle.zip',
    "if errorlevel 1 (",
    "  echo   [ERROR] The download failed - the link may have expired.",
    "  echo   Download the installer again from Settings - Defaults.",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "REM Unpack into a scratch folder first, so a broken download never leaves a",
    "REM half-written app behind, then copy it over the target folder.",
    "echo   Unpacking...",
    'if exist ".wflow-unpack" rmdir /s /q ".wflow-unpack"',
    'mkdir ".wflow-unpack"',
    'tar -xf wflow-bundle.zip -C ".wflow-unpack"',
    "if errorlevel 1 (",
    '  powershell -NoProfile -Command "Expand-Archive -Force -Path \'wflow-bundle.zip\' -DestinationPath \'.wflow-unpack\'"',
    "  if errorlevel 1 (",
    "    echo   [ERROR] Could not unpack the download.",
    "    pause",
    "    exit /b 1",
    "  )",
    ")",
    'xcopy ".wflow-unpack" "." /E /Y /Q >nul',
    'rmdir /s /q ".wflow-unpack"',
    "del wflow-bundle.zip >nul 2>nul",
    "",
    "REM Sources are shipped -> build the interface once (like start.bat); otherwise",
    "REM only the runtime dependencies are needed for the prebuilt one. Labels keep",
    "REM every construct at the top level, where batch parsing is predictable.",
    'if not exist "src" goto :runtime_deps',
    'if not exist "vite.config.ts" goto :runtime_deps',
    "",
    "echo   Installing dependencies (the first run takes a minute)...",
    "if exist package-lock.json ( call npm ci --no-audit --no-fund ) else ( call npm install --no-audit --no-fund )",
    "if errorlevel 1 goto :deps_failed",
    "echo   Building the interface...",
    "call npm run build",
    "if errorlevel 1 goto :deps_failed",
    "goto :setup_files",
    "",
    ":runtime_deps",
    "echo   Installing runtime dependencies (the first run takes a minute)...",
    "if exist package-lock.json ( call npm ci --omit=dev --no-audit --no-fund ) else ( call npm install --omit=dev --no-audit --no-fund )",
    "if errorlevel 1 goto :deps_failed",
    "goto :setup_files",
    "",
    ":deps_failed",
    "echo   [ERROR] Installing dependencies failed.",
    "pause",
    "exit /b 1",
    "",
    ":setup_files",
    "REM .env, the launcher and the desktop shortcut. The values are already",
    "REM environment variables of this process, so the PowerShell helper can read",
    "REM them without any cmd quoting in between.",
    'if "%STORAGE%"=="postgres" (set "WFLOW_DATABASE_URL=%DATABASE_URL%") else (set "WFLOW_DATABASE_URL=")',
    'for /f "delims=" %%i in (\'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\') do set "WFLOW_KEY=%%i"',
    'if not "%WFLOW_ROLE%"=="builder" if "%WFLOW_RUNNER_TOKEN%"=="" for /f "delims=" %%i in (\'node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"\') do set "WFLOW_RUNNER_TOKEN=%%i"',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${helper}')); Invoke-Expression $s"`,
    "if errorlevel 1 (",
    "  echo   [ERROR] Could not write the settings file (.env).",
    "  pause",
    "  exit /b 1",
    ")",
    "",
    "echo.",
    "echo   Installed in %WFLOW_DIR%",
    'echo   Start it with: "%WFLOW_DIR%\\Start W flow.bat"  (desktop shortcut: W flow)',
    'echo   Builder:     http://localhost:%WFLOW_PORT%',
    'echo   Setup page:  http://localhost:%WFLOW_PORT%/setup',
    "echo     - configure storage and where runs execute there, no file editing needed.",
    'if not "%WFLOW_RUNNER_TOKEN%"=="" (',
    "  echo.",
    "  echo   This copy executes runs for a builder. In the OTHER copy open Setup:",
    "  echo     Runner URL   : http://^<this-machine^>:%WFLOW_PORT%",
    "  echo     Runner token : %WFLOW_RUNNER_TOKEN%",
    ")",
    "echo.",
    'echo   Starting W flow now on http://localhost:%WFLOW_PORT% - close this window to stop it.',
    "echo.",
    "set PORT=%WFLOW_PORT%",
    "node server/index.js",
    "",
  ].join("\r\n");
}
