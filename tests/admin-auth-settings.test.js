// ============================================================================
// Admin panel → Auth & e-mail: OAuth (Google / GitHub) credentials setup.
//
// Two phases over ONE isolated database:
//  1) the real admin server saves the credentials + public URL (encrypted at
//     rest) and reports them as configured while masking the secret;
//  2) the real app server (server/index.js) is spawned against the SAME
//     database and must pick the stored credentials up without any env vars —
//     /api/auth/config offers the providers and reset links are built from the
//     saved public URL.
//
// Run: node --test tests/admin-auth-settings.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-admin-auth-"));
const dbPath = path.join(tempDir, "auth.db");
const dataDir = path.join(tempDir, "data");

const ADMIN = { username: "test-admin", password: "test-admin-pass-123" };
const PUBLIC_URL = "https://flow.example.com";
const GOOGLE = { clientId: "google-client-id.apps.googleusercontent.com", clientSecret: "google-secret-value" };
const GITHUB = { clientId: "Iv1.abcdef0123456789", clientSecret: "github-secret-value" };
// A reserved ".invalid" host, so the magic-link send fails immediately instead
// of reaching the network (see the passwordless assertion below).
const SUPABASE = { url: "https://projectref.supabase.invalid", anonKey: "sb_publishable_supabase-anon-key" };

// Isolated DB + pinned admin credentials BEFORE the admin modules are imported.
process.env.BF_DB_PATH = dbPath;
process.env.BF_ADMIN_USERNAME = ADMIN.username;
process.env.BF_ADMIN_PASSWORD = ADMIN.password;
// The panel values must win over any env fallback that may exist locally.
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GITHUB_CLIENT_ID;
delete process.env.GITHUB_CLIENT_SECRET;
delete process.env.BF_PUBLIC_URL;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_PROVIDERS;
delete process.env.SUPABASE_MAGIC_LINK;

const { startAdminServer } = await import("../server/admin.js");
const db = await import("../server/db.js");
// The admin process starts a health monitor and a batched journal; both can touch
// the SQLite file after the server closes, so stop them before cleanup.
const { stopHealthMonitor } = await import("../server/alerts.js");
const { flushJournal } = await import("../server/journal.js");

let adminServer;
let adminBase = "";

function parseCookies(res) {
  const out = {};
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const m = line.match(/^([^=]+)=([^;]*)/);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

before(async () => {
  adminServer = startAdminServer(0);
  await new Promise((resolve, reject) => {
    adminServer.on("listening", resolve);
    adminServer.on("error", reject);
  });
  adminBase = `http://127.0.0.1:${adminServer.address().port}`;
});

test("admin panel stores OAuth credentials and masks the secrets", async () => {
  // Login (double-submit CSRF: cookie + echoed header).
  const root = await fetch(`${adminBase}/`);
  const { bf_csrf: csrf } = parseCookies(root);
  assert.ok(csrf, "admin page issues a CSRF cookie");
  const login = await fetch(`${adminBase}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `bf_csrf=${csrf}`, "X-CSRF-Token": csrf },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(login.status, 200, `admin login failed: ${login.status}`);
  const session = parseCookies(login).bf_admin;
  assert.ok(session, "login issues a session cookie");
  const cookie = `bf_admin=${session}; bf_csrf=${csrf}`;

  // Save credentials + public URL exactly like the panel's Save button does.
  const save = await fetch(`${adminBase}/api/admin/authsettings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
    body: JSON.stringify({
      smtpHost: "smtp.example.com",
      smtpPort: "587",
      publicUrl: PUBLIC_URL,
      oauth: { google: GOOGLE, github: GITHUB },
    }),
  });
  assert.equal(save.status, 200, `save failed: ${save.status} ${await save.text()}`);

  // Read back: ids intact, secrets masked but reported as configured.
  const read = await fetch(`${adminBase}/api/admin/authsettings`, { headers: { Cookie: cookie } });
  assert.equal(read.status, 200);
  const data = await read.json();
  assert.equal(data.publicUrl, PUBLIC_URL);
  assert.equal(data.oauth.google.clientId, GOOGLE.clientId);
  assert.equal(data.oauth.github.clientId, GITHUB.clientId);
  assert.equal(data.oauth.google.configured, true);
  assert.equal(data.oauth.github.configured, true);
  assert.equal(data.oauth.google.hasSecret, true);
  assert.ok(!String(data.oauth.google.secretMasked).includes(GOOGLE.clientSecret), "secret never returned in clear");
  assert.ok(data.oauth.google.secretMasked.startsWith("••••"), "secret is masked");

  // A blank secret must not wipe the stored one (the panel sends "" to keep it).
  const keep = await fetch(`${adminBase}/api/admin/authsettings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
    body: JSON.stringify({ publicUrl: PUBLIC_URL, oauth: { google: { clientId: GOOGLE.clientId, clientSecret: "" } } }),
  });
  assert.equal(keep.status, 200);
  const after = await (await fetch(`${adminBase}/api/admin/authsettings`, { headers: { Cookie: cookie } })).json();
  assert.equal(after.oauth.google.configured, true, "blank secret keeps the stored value");
});

test("admin panel stores the Supabase project and masks the anon key", async () => {
  const root = await fetch(`${adminBase}/`);
  const { bf_csrf: csrf } = parseCookies(root);
  const login = await fetch(`${adminBase}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `bf_csrf=${csrf}`, "X-CSRF-Token": csrf },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(login.status, 200, `admin login failed: ${login.status}`);
  const cookie = `bf_admin=${parseCookies(login).bf_admin}; bf_csrf=${csrf}`;
  const saveSb = (supabase) =>
    fetch(`${adminBase}/api/admin/authsettings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: JSON.stringify({ publicUrl: PUBLIC_URL, supabase }),
    });
  const readSb = async () => (await fetch(`${adminBase}/api/admin/authsettings`, { headers: { Cookie: cookie } })).json();

  // Trailing slash is trimmed (the authorize URL is built by appending to it).
  const saved = await saveSb({ url: `${SUPABASE.url}/`, anonKey: SUPABASE.anonKey, providers: "discord, apple", magicLink: true });
  assert.equal(saved.status, 200, `supabase save failed: ${saved.status}`);
  const sb = await readSb();
  assert.equal(sb.supabase.url, SUPABASE.url);
  assert.equal(sb.supabase.urlNote, "", "a clean URL needs no explanation");
  assert.equal(sb.supabase.configured, true);
  assert.equal(sb.supabase.providers, "discord, apple");
  assert.equal(sb.supabase.magicLink, true);
  assert.equal(sb.supabase.hasAnonKey, true);
  assert.ok(!JSON.stringify(sb).includes(SUPABASE.anonKey), "the anon key is never returned in clear");
  assert.ok(sb.supabase.anonKeyMasked.startsWith("••••"), "the anon key is masked");

  // A blank key keeps the stored one (the panel sends "" to keep it).
  assert.equal((await saveSb({ url: SUPABASE.url, anonKey: "", providers: "discord, apple", magicLink: true })).status, 200);
  assert.equal((await readSb()).supabase.configured, true, "blank anon key keeps the stored value");

  // The passwordless switch is honoured, and a non-http project URL is refused.
  assert.equal((await saveSb({ url: SUPABASE.url, anonKey: "", providers: "discord, apple", magicLink: false })).status, 200);
  assert.equal((await readSb()).supabase.magicLink, false);
  assert.equal((await saveSb({ url: "projectref.supabase.co", anonKey: "", providers: "", magicLink: true })).status, 400);

  // The dashboard shows the Data API URL (…/rest/v1) right next to the project
  // URL, and pasting that one is what makes Supabase answer "No API key found in
  // request" in the browser: every request would go to /rest/v1/auth/v1/…, which
  // is a gateway route that wants an API key. Such a value is reduced to the
  // project origin and the correction is reported back to the panel.
  const stripped = await saveSb({ url: `${SUPABASE.url}/rest/v1`, anonKey: "", providers: "discord, apple", magicLink: true });
  assert.equal(stripped.status, 200);
  const strippedBody = await stripped.json();
  assert.equal(strippedBody.supabase.url, SUPABASE.url, "the /rest/v1 API path is removed");
  assert.match(strippedBody.note, /rest\/v1/, "the panel is told which part was corrected");
  assert.equal((await readSb()).supabase.url, SUPABASE.url, "and only the clean URL is stored");

  // /auth/v1 goes the same way, and a value that cannot be used at all is
  // refused with advice instead of being stored.
  await saveSb({ url: `${SUPABASE.url}/auth/v1/`, anonKey: "", providers: "discord, apple", magicLink: true });
  assert.equal((await readSb()).supabase.url, SUPABASE.url);
  const nonsense = await saveSb({ url: "supabase.co/project", anonKey: "", providers: "", magicLink: true });
  assert.equal(nonsense.status, 400);
  assert.match((await nonsense.json()).error, /Project Settings/, "the error says where the right URL is");

  // Leave the project configured and the e-mail form on for the next test — but
  // with the API path put back by hand, the way a value stored before the panel
  // knew to strip it would look, so the app phase below proves it is corrected
  // on the read side too. "google" is in the list there to cover the built-in
  // button that Supabase now brokers.
  assert.equal((await saveSb({ url: SUPABASE.url, anonKey: "", providers: "discord, apple, google", magicLink: true })).status, 200);
  await db.storeSet("oauth.supabase.url", `${SUPABASE.url}/rest/v1`);
});

test("Test connection reports what the project itself answers", async () => {
  // A stand-in for a Supabase project. It answers the settings call, and — like
  // the real gateway — refuses an unknown key with Kong's exact wording, which
  // is the error that reaches a user's browser as a bare JSON page.
  const GOOD_KEY = "sb_publishable_test-key";
  const seen = [];
  const project = http.createServer((req, res) => {
    seen.push({ url: req.url, apikey: req.headers.apikey });
    if (!String(req.url).endsWith("/auth/v1/settings")) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.apikey !== GOOD_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "No API key found in request", hint: "No `apikey` request header or url param was found." }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ external: { email: true, google: true, github: false } }));
  });
  await new Promise((resolve) => project.listen(0, "127.0.0.1", resolve));
  const projectUrl = `http://127.0.0.1:${project.address().port}`;

  try {
    const root = await fetch(`${adminBase}/`);
    const { bf_csrf: csrf } = parseCookies(root);
    const login = await fetch(`${adminBase}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `bf_csrf=${csrf}`, "X-CSRF-Token": csrf },
      body: JSON.stringify(ADMIN),
    });
    assert.equal(login.status, 200);
    const cookie = `bf_admin=${parseCookies(login).bf_admin}; bf_csrf=${csrf}`;
    const test = (body) =>
      fetch(`${adminBase}/api/admin/supabase/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
        body: JSON.stringify(body),
      });

    // Typed values are checked, so a URL can be tried before it is saved. The
    // Data API path is stripped first — that is the whole point of the button,
    // since a wrong URL otherwise only shows up as an opaque error page.
    const ok = await test({ url: `${projectUrl}/rest/v1`, anonKey: GOOD_KEY, providers: "google, github, discord" });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true, JSON.stringify(okBody));
    assert.equal(okBody.url, projectUrl, "the pasted API path is corrected before the call");
    assert.match(okBody.note, /rest\/v1/);
    assert.equal(seen.at(-1).url, "/auth/v1/settings", "the API path never reaches the wire");
    assert.equal(seen.at(-1).apikey, GOOD_KEY, "the key is sent as the apikey header");
    assert.deepEqual(okBody.enabled, ["email", "google"], "what the project has switched on");
    assert.deepEqual(okBody.missing, ["github", "discord"], "providers offered here but off there are named");
    assert.equal(okBody.emailOn, true, "the e-mail provider is on, so sign-in links can be sent");
    // Supabase is the OAuth client for the social providers, so its own callback
    // is the address the user's Google / GitHub app has to allow — reported so
    // the panel can say it, instead of the provider answering
    // "redirect_uri_mismatch" with no explanation.
    assert.equal(okBody.providerCallback, `${projectUrl}/auth/v1/callback`);

    // The masked placeholder the panel leaves in the field ("saved •••• — leave
    // empty to keep") must not be sent as a key: it falls back to the stored one.
    const masked = (await (await fetch(`${adminBase}/api/admin/authsettings`, { headers: { Cookie: cookie } })).json()).supabase.anonKeyMasked;
    const withMask = await test({ url: projectUrl, anonKey: masked });
    const withMaskBody = await withMask.json();
    assert.equal(withMask.status, 200, "the stored key was tried, not the mask");
    assert.equal(seen.at(-1).apikey, SUPABASE.anonKey, "the mask falls back to the stored anon key");
    assert.equal(withMaskBody.note, "", "a clean URL needs no correction note");

    // A wrong key surfaces Supabase's own words instead of a raw JSON page.
    const wrong = await (await test({ url: projectUrl, anonKey: "not-the-key" })).json();
    assert.equal(wrong.ok, false);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.message, "No API key found in request");
    assert.match(wrong.hint, /apikey/);

    // An unreachable project is reported, not thrown.
    const unreachable = await (await test({ url: "https://projectref.supabase.invalid", anonKey: GOOD_KEY })).json();
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.message, /Could not reach/);

    // A value that cannot be a project URL is refused with advice.
    const junk = await test({ url: "supabase.co/rest/v1" });
    assert.equal(junk.status, 400);
    assert.match((await junk.json()).error, /Project Settings/);
  } finally {
    await new Promise((resolve) => project.close(resolve));
  }
});

test("the app server uses the credentials saved in the admin panel", async () => {
  // Close the admin server + DB so the spawned app process can own the file.
  const s = adminServer;
  adminServer = null;
  await new Promise((resolve) => s.close(resolve));
  db.closeDb();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: dbPath,
      BF_DATA_DIR: dataDir,
      DISABLE_SCHEDULER: "1",
      BF_EXPOSE_RESET_LINK: "1",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  try {
    const deadline = Date.now() + 20_000;
    let cfg = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/auth/config`);
        if (res.status === 200) {
          cfg = await res.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(cfg, "app server became ready");
    assert.equal(cfg.oauth.github, true, "GitHub login is offered from the stored credentials");

    // Supabase: the login card gets one button per configured provider, plus
    // the passwordless e-mail option — and the anon key stays server-side.
    assert.equal(cfg.supabase.enabled, true, "Supabase login is offered from the stored credentials");
    assert.deepEqual(cfg.supabase.providers, [
      { id: "discord", label: "Discord" },
      { id: "apple", label: "Apple" },
      { id: "google", label: "Google" },
    ]);
    // …and the built-in Google button is left out, because Supabase brokers
    // Google here: two buttons for one login would only confuse. GitHub is not
    // in the Supabase list, so its built-in button stays.
    assert.equal(cfg.oauth.google, false, "the built-in Google button steps aside for the Supabase one");
    assert.equal(cfg.supabase.providers.some((p) => p.id === "google"), true);
    assert.equal(cfg.supabase.magicLink, true);
    assert.ok(!JSON.stringify(cfg).includes(SUPABASE.anonKey), "the anon key never reaches the browser");

    // Starting a login bounces to the project's authorize endpoint with the
    // PKCE parameters, and remembers the flow in a cookie — the verifier is what
    // the callback exchanges the authorization code with.
    const start = await fetch(`${base}/api/auth/oauth/supabase/start?provider=discord`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get("location"));
    // The project URL was stored with /rest/v1 appended; the request must still
    // go to the authorize endpoint, not to /rest/v1/auth/v1/authorize (which is
    // where the browser used to end up with "No API key found in request").
    assert.equal(location.origin, SUPABASE.url);
    assert.equal(location.pathname, "/auth/v1/authorize");
    assert.equal(location.searchParams.get("provider"), "discord");
    // The redirect URI is the origin the browser is actually on, not the
    // configured public URL — that names a domain that is not deployed here, and
    // the bounce back from Supabase would never arrive.
    assert.equal(location.searchParams.get("redirect_to"), `${base}/api/auth/oauth/supabase/callback`);
    assert.equal(location.searchParams.get("code_challenge_method"), "s256");
    assert.ok(location.searchParams.get("code_challenge"), "a PKCE challenge is sent");
    assert.ok(location.searchParams.get("bf_state"), "the login state is round-tripped");
    const setCookies = start.headers.getSetCookie();
    assert.ok(setCookies.some((c) => c.startsWith("bf_sb_state=")), "a login-state cookie is set");
    const pkce = setCookies.find((c) => c.startsWith("bf_sb_pkce="));
    assert.ok(pkce, "a PKCE cookie is set");
    // Every key the client stored travels in ONE cookie as a JSON map — storing
    // them under a single shared name would let them overwrite each other.
    const stored = JSON.parse(decodeURIComponent(pkce.slice(pkce.indexOf("=") + 1).split(";")[0]));
    assert.ok(
      Object.keys(stored).some((k) => k.endsWith("-code-verifier")),
      `the code verifier is kept for the callback: ${JSON.stringify(Object.keys(stored))}`
    );

    // A provider this instance does not offer is refused rather than passed on.
    const unknown = await fetch(`${base}/api/auth/oauth/supabase/start?provider=evil`, { redirect: "manual" });
    assert.equal(unknown.status, 400);

    // Passwordless: the address is validated, and the mail is sent by Supabase
    // (the project here is a reserved ".invalid" host, so the send fails — that
    // must surface as an error, never as a silent success).
    const badEmail = await fetch(`${base}/api/auth/supabase/magic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assert.equal(badEmail.status, 400);
    const magic = await fetch(`${base}/api/auth/supabase/magic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "magic-link@example.com" }),
    });
    assert.equal(magic.status, 503, "an unreachable Supabase project surfaces as an error");

    // The stored public URL drives reset links (no BF_PUBLIC_URL in the env).
    const email = `admin-auth-${Date.now()}@example.com`;
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "settings" }),
    });
    assert.equal(reg.status, 200, `register failed: ${reg.status}`);
    const forgot = await fetch(`${base}/api/auth/forgot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = await forgot.json();
    assert.ok(body.resetLink, "reset link is exposed in tests");
    assert.ok(body.resetLink.startsWith(`${PUBLIC_URL}/`), `reset link uses the saved public URL: ${body.resetLink}`);

    // A redirect that comes back without a code has to say why. Providers report
    // a cancellation as ?error=…, Supabase reports its own exchange failures with
    // an error_description — both of which used to read as a flat
    // "Missing authorization code." with no clue what went wrong.
    const refused = await fetch(
      `${base}/api/auth/oauth/supabase/callback?error=server_error&error_description=${encodeURIComponent("Unable to exchange external code")}`
    );
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /Unable to exchange external code/, "the project's reason is shown, not a shrug");
    const empty = await fetch(`${base}/api/auth/oauth/supabase/callback`);
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /fragment/, "the page also reads the fragment, which never reaches a server");

    // The built-in providers behave the same way: cancelling on Google's screen
    // returns the state together with error=access_denied instead of a code.
    const ghStart = await fetch(`${base}/api/auth/oauth/github/start`, { redirect: "manual" });
    assert.equal(ghStart.status, 302);
    const ghState = new URL(ghStart.headers.get("location")).searchParams.get("state");
    const ghCookie = ghStart.headers.getSetCookie().find((c) => c.startsWith("bf_oauth_state="));
    assert.ok(ghState && ghCookie, "the start request hands back a state to check against");
    const denied = await fetch(`${base}/api/auth/oauth/github/callback?error=access_denied&state=${ghState}`, {
      headers: { Cookie: ghCookie.slice(0, ghCookie.indexOf(";")) },
    });
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /access_denied/, "a cancelled Google/GitHub login says so");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
});

after(async () => {
  // Stop everything that could still touch the database, then close it so the
  // temp folder can be removed (Windows locks an open SQLite file).
  try {
    stopHealthMonitor();
  } catch {
    /* ignore */
  }
  if (adminServer) {
    const s = adminServer;
    adminServer = null;
    await new Promise((resolve) => s.close(resolve));
  }
  try {
    await flushJournal();
  } catch {
    /* ignore */
  }
  db.closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});
