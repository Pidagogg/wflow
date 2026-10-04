// ============================================================================
// Connected accounts — Google / Microsoft nodes sign in without passwords.
//
// Covers the catalog wiring (every mapped node gets the account picker, no
// Gmail node asks for a mailbox password), token injection and refresh in the
// executor, the Gmail message builder, and the HTTP routes: consent start,
// state checking on the callback, and tokens never leaving the vault API.
// ============================================================================
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-oauth-"));
process.env.BF_DB_PATH = path.join(tempDir, "inproc.db");
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

const { NODES } = await import("../shared/catalog.js");
const { OAUTH_NODES, OAUTH_FIELD_KEY } = await import("../shared/oauth.js");
const { TEMPLATES } = await import("../shared/templates.js");
const { executeNode } = await import("../server/executor.js");
const { db } = await import("../server/dbx.js");

// ---- catalog ----

test("every account-connected node has a picker above its fallback credential", () => {
  for (const [type, spec] of Object.entries(OAUTH_NODES)) {
    const def = NODES[type];
    assert.ok(def, `${type} exists in the catalog`);
    const idx = def.fields.findIndex((f) => f.key === OAUTH_FIELD_KEY);
    assert.ok(idx >= 0, `${type} has an account picker`);
    const picker = def.fields[idx];
    assert.equal(picker.type, "oauth");
    assert.equal(picker.provider, spec.provider);
    const cred = def.fields.find((f) => f.key === (spec.credField || "token"));
    if (cred) {
      assert.equal(cred.optional, true, `${type}'s hand-entered credential is optional now`);
      assert.ok(def.fields.indexOf(cred) > idx, `${type}'s picker comes first`);
    }
  }
});

test("no Gmail node or template asks for a mailbox password", () => {
  for (const [type, def] of Object.entries(NODES)) {
    if (!/gmail/i.test(type)) continue;
    for (const f of def.fields) {
      // The New Email trigger reads over IMAP (the cloud is not verified for
      // Gmail's restricted read scopes), so it takes a revocable APP password
      // and says plainly that it is not the Google password.
      if (type === "gmail" && f.key === "appPassword") {
        assert.match(f.label, /app password/i);
        assert.match(f.help, /NOT your Google password/);
        continue;
      }
      assert.ok(!/pass/i.test(f.key), `${type}.${f.key} is a password field`);
    }
  }
  for (const t of TEMPLATES) {
    for (const n of t.nodes) {
      assert.notEqual(n.data?.config?.host, "smtp.gmail.com", `${t.id} still sends Gmail through SMTP`);
      assert.notEqual(n.data?.config?.host, "imap.gmail.com", `${t.id} still reads Gmail through IMAP`);
    }
  }
});

// ---- executor ----

const realFetch = globalThis.fetch;
let calls = [];
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const { status = 200, body = {} } = (await handler(u, init)) || {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}
after(() => {
  globalThis.fetch = realFetch;
});

const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

async function connection(userId, fields) {
  return db.credentialCreate({
    userId,
    name: "Google — me@example.com",
    type: "oauth:google",
    fields: { provider: "google", email: "me@example.com", scope: `openid email profile ${GMAIL_SEND}`, ...fields },
  });
}

function gmailWorkflow(config) {
  const def = NODES.gmailSend;
  return { id: "wf", nodes: [{ id: "n1", type: "gmailSend", data: { config: { ...def.defaults, ...config } } }], edges: [] };
}

test("a connected account's fresh token is sent, and the message is built from To / Subject / Message", async () => {
  const cred = await connection("u1", { accessToken: "live-token", refreshToken: "r1", expiresAt: Date.now() + 3600_000 });
  stubFetch(() => ({ body: { id: "msg-1" } }));
  const res = await executeNode(
    gmailWorkflow({ oauthAccount: cred.id, to: "{{email}}", subject: "Grüße", message: "Hello {{name}}" }),
    "n1",
    [{ json: { email: "ada@example.com", name: "Ada" } }],
    { userId: "u1" }
  );
  assert.equal(res.status, "success", res.error);
  const send = calls.find((c) => c.url.includes("/messages/send"));
  assert.ok(send, "Gmail send endpoint called");
  assert.equal(new Headers(send.init.headers).get("authorization"), "Bearer live-token");
  const raw = Buffer.from(JSON.parse(send.init.body).raw, "base64url").toString("utf8");
  assert.match(raw, /^To: ada@example\.com\r\n/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/, "non-ASCII subject is encoded");
  assert.match(Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8"), /Hello Ada/);
});

test("an expired token is refreshed once and saved", async () => {
  const cred = await connection("u2", { accessToken: "old", refreshToken: "refresh-me", expiresAt: Date.now() - 1000 });
  stubFetch((url) => (url.includes("oauth2.googleapis.com/token") ? { body: { access_token: "new-token", expires_in: 3600 } } : { body: {} }));
  const res = await executeNode(gmailWorkflow({ oauthAccount: cred.id, to: "a@example.com" }), "n1", [{ json: {} }], { userId: "u2" });
  assert.equal(res.status, "success", res.error);
  const tokenCall = calls.find((c) => c.url.includes("/token"));
  assert.match(String(tokenCall.init.body), /grant_type=refresh_token/);
  const send = calls.find((c) => c.url.includes("/messages/send"));
  assert.equal(new Headers(send.init.headers).get("authorization"), "Bearer new-token");
  const saved = await db.credentialGet(cred.id, "u2");
  assert.equal(saved.fields.accessToken, "new-token");
  assert.equal(saved.fields.refreshToken, "refresh-me", "Google keeps the old refresh token");
});

test("another account's connection cannot be used", async () => {
  const cred = await connection("owner", { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 });
  stubFetch(() => ({ body: {} }));
  const res = await executeNode(gmailWorkflow({ oauthAccount: cred.id, to: "a@example.com" }), "n1", [{ json: {} }], { userId: "intruder" });
  assert.equal(res.status, "error");
  assert.match(res.error, /no longer connected/);
  assert.equal(calls.length, 0, "nothing was sent");
});

test("Slack 'Send as: me' posts with the person's own token, and asks for a reconnect without one", async () => {
  const slack = (fields) =>
    db.credentialCreate({
      userId: "slacker",
      name: "Slack — Acme",
      type: "oauth:slack",
      fields: { provider: "slack", email: "Acme (Slack workspace)", scope: "chat:write chat:write.public", accessToken: "xoxb-bot", ...fields },
    });
  const run = (credId, sendAs) =>
    executeNode(
      { id: "wf", nodes: [{ id: "n1", type: "slackBotSend", data: { config: { ...NODES.slackBotSend.defaults, oauthAccount: credId, sendAs, channel: "#x", text: "hi" } } }], edges: [] },
      "n1",
      [{ json: {} }],
      { userId: "slacker" }
    );
  const auth = () => new Headers(calls.find((c) => c.url.includes("chat.postMessage")).init.headers).get("authorization");
  stubFetch(() => ({ body: { ok: true, ts: "1" } }));

  const withUser = await slack({ userToken: "xoxp-me", userScope: "chat:write" });
  assert.equal((await run(withUser.id, "bot")).status, "success");
  assert.equal(auth(), "Bearer xoxb-bot", "the bot token by default");
  stubFetch(() => ({ body: { ok: true, ts: "1" } }));
  assert.equal((await run(withUser.id, "me")).status, "success");
  assert.equal(auth(), "Bearer xoxp-me", "the person's token for Send as: me");

  const botOnly = await slack({});
  const res = await run(botOnly.id, "me");
  assert.equal(res.status, "error");
  assert.match(res.error, /Reconnect/);
});

test("a connection without the node's permission asks for a reconnect", async () => {
  const cred = await db.credentialCreate({
    userId: "u3",
    name: "Google — me@example.com",
    type: "oauth:google",
    fields: { provider: "google", email: "me@example.com", scope: "openid email", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
  });
  stubFetch(() => ({ body: {} }));
  const res = await executeNode(gmailWorkflow({ oauthAccount: cred.id, to: "a@example.com" }), "n1", [{ json: {} }], { userId: "u3" });
  assert.equal(res.status, "error");
  assert.match(res.error, /Reconnect/);
});

test("Sheets nodes use the connected account instead of an API key", async () => {
  const cred = await db.credentialCreate({
    userId: "u4",
    name: "Google — me@example.com",
    type: "oauth:google",
    fields: { provider: "google", email: "me@example.com", scope: "https://www.googleapis.com/auth/spreadsheets", accessToken: "sheet-token", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
  });
  stubFetch(() => ({ body: { updates: { updatedRows: 1 } } }));
  const wf = { id: "wf", nodes: [{ id: "n1", type: "googleSheetsAppend", data: { config: { ...NODES.googleSheetsAppend.defaults, oauthAccount: cred.id, spreadsheetId: "abc", values: '["x"]' } } }], edges: [] };
  const res = await executeNode(wf, "n1", [{ json: {} }], { userId: "u4" });
  assert.equal(res.status, "success", res.error);
  assert.ok(!calls[0].url.includes("key="), "no API key in the URL");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer sheet-token");
});

test("the cloud only lets Google nodes connect with its verified scopes", async () => {
  const { connectAllowed, providerScopes, unavailableConnectionNodes, GOOGLE_VERIFIED_SCOPES } = await import("../shared/oauth.js");
  // every verified scope is used by some node, and every node using one may connect
  for (const scope of GOOGLE_VERIFIED_SCOPES) {
    assert.ok(Object.values(OAUTH_NODES).some((s) => s.scopes.includes(scope)), `${scope} is used by a node`);
  }
  assert.equal(connectAllowed(OAUTH_NODES.gmailSend), true);
  assert.equal(connectAllowed(OAUTH_NODES.gmailListMessages), false);
  assert.equal(connectAllowed(OAUTH_NODES.gmailListMessages, { allScopes: true }), true);
  assert.equal(connectAllowed(OAUTH_NODES.slackBotSend), true, "other services are not limited");
  // the Credentials-page consent screen asks for exactly the verified scopes
  const scopes = providerScopes("google").filter((s) => s.startsWith("https://"));
  assert.deepEqual(scopes.sort(), [...GOOGLE_VERIFIED_SCOPES].sort());
  assert.ok(providerScopes("google", { allScopes: true }).includes("https://www.googleapis.com/auth/drive"));
  assert.ok(unavailableConnectionNodes().includes("googleDriveUpload"));
  assert.ok(!unavailableConnectionNodes().includes("googleSheetsAppend"));
  assert.deepEqual(unavailableConnectionNodes({ allScopes: true }), []);
});

test("a node limited to its pasted token ignores an older connection", async () => {
  const cred = await db.credentialCreate({
    userId: "u5",
    name: "Google — me@example.com",
    type: "oauth:google",
    fields: { provider: "google", email: "me@example.com", scope: "https://www.googleapis.com/auth/gmail.readonly", accessToken: "conn-token", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
  });
  stubFetch(() => ({ body: { messages: [] } }));
  const wf = (config) => ({ id: "wf", nodes: [{ id: "n1", type: "gmailListMessages", data: { config: { ...NODES.gmailListMessages.defaults, oauthAccount: cred.id, ...config } } }], edges: [] });
  const blocked = await executeNode(wf({ token: "" }), "n1", [{ json: {} }], { userId: "u5" });
  assert.equal(blocked.status, "error");
  assert.match(blocked.error, /Paste an access token/);
  assert.equal(calls.length, 0, "the connection's token is never sent");
  await executeNode(wf({ token: "pasted-token" }), "n1", [{ json: {} }], { userId: "u5" });
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer pasted-token");
});

test("every connected service has protocol details and every node a working injection", async () => {
  const { OAUTH_PROVIDERS, injectionFor } = await import("../shared/oauth.js");
  const src = fs.readFileSync(path.join(repoRoot, "server", "oauth-connections.js"), "utf8");
  for (const id of Object.keys(OAUTH_PROVIDERS)) {
    assert.match(src, new RegExp(`\\n  ${id}: \\{[\\s\\S]{0,200}?authUrl:`), `${id} has endpoints in PROTOCOLS`);
  }
  for (const [type, spec] of Object.entries(OAUTH_NODES)) {
    // an explicit `inject` names a runtime-only key its handler reads (Sheets)
    if (spec.inject) continue;
    const key = injectionFor(spec).key;
    assert.ok(NODES[type].fields.some((f) => f.key === key), `${type} reads its token from ${key}`);
  }
});

async function connectionFor(userId, provider, scope, fields = {}) {
  return db.credentialCreate({
    userId,
    name: `${provider} — me`,
    type: `oauth:${provider}`,
    fields: { provider, email: "me@example.com", scope, accessToken: "tok-" + provider, refreshToken: "", expiresAt: 0, ...fields },
  });
}

function nodeWorkflow(type, config) {
  return { id: "wf", nodes: [{ id: "n1", type, data: { config: { ...NODES[type].defaults, ...config } } }], edges: [] };
}

test("tokens without an expiry (GitHub) are used as they are", async () => {
  const cred = await connectionFor("gh", "github", "repo");
  stubFetch(() => ({ body: [] }));
  const res = await executeNode(nodeWorkflow("githubListIssues", { oauthAccount: cred.id, owner: "o", repo: "r" }), "n1", [{ json: { owner: "o", repo: "r" } }], { userId: "gh" });
  assert.equal(res.status, "success", res.error);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer tok-github");
  assert.ok(!calls.some((c) => c.url.includes("/token")), "no refresh attempted");
});

test("GitLab switches from PRIVATE-TOKEN to Bearer for a connected account", async () => {
  const cred = await connectionFor("gl", "gitlab", "api read_user");
  stubFetch(() => ({ body: { iid: 1 } }));
  const res = await executeNode(nodeWorkflow("gitlabIssue", { oauthAccount: cred.id, projectId: "1", title: "t" }), "n1", [{ json: {} }], { userId: "gl" });
  assert.equal(res.status, "success", res.error);
  const h = new Headers(calls[0].init.headers);
  assert.equal(h.get("authorization"), "Bearer tok-gitlab");
  assert.equal(h.get("private-token"), null);
});

test("Linear gets its token with the Bearer prefix", async () => {
  const cred = await connectionFor("ln", "linear", "read,write");
  stubFetch(() => ({ body: { data: { issueCreate: { success: true, issue: { id: "1" } } } } }));
  const res = await executeNode(nodeWorkflow("linearIssue", { oauthAccount: cred.id, teamId: "t", title: "x" }), "n1", [{ json: {} }], { userId: "ln" });
  assert.equal(res.status, "success", res.error);
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer tok-linear");
});

// ---- HTTP routes ----

let child;
let base = "";

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function http(method, url, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await realFetch(`${base}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* html */
  }
  const session = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => /=./.test(c)) || "";
  return { status: res.status, data, text, location: res.headers.get("location") || "", session };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: path.join(tempDir, "server.db"),
      BF_DATA_DIR: path.join(tempDir, "data"),
      DISABLE_SCHEDULER: "1",
      SMTP_HOST: "",
      AIRTABLE_CLIENT_ID: "airtable-client",
      GITHUB_CLIENT_ID: "gh-client",
      GITHUB_CLIENT_SECRET: "gh-secret",
      AIRTABLE_CLIENT_SECRET: "airtable-secret",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await realFetch(`${base}/api/auth/config`)).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start");
});

after(() => child?.kill());

async function signUp() {
  const email = `conn-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const res = await http("POST", "/api/auth/register", { body: { email, password: "correct-horse-1" } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.session;
}

test("connecting needs a login and asks Google only for the node's scopes", async () => {
  assert.equal((await http("GET", "/api/connections/google/start?node=gmailSend")).status, 401);
  const cookie = await signUp();
  const res = await http("GET", "/api/connections/google/start?node=gmailSend&scope=https://mail.google.com/", { cookie });
  assert.equal(res.status, 302);
  const url = new URL(res.location);
  assert.equal(url.host, "accounts.google.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  const scopes = url.searchParams.get("scope").split(" ");
  assert.ok(scopes.includes(GMAIL_SEND));
  assert.ok(!scopes.includes("https://mail.google.com/"), "scopes come from the catalog, not the query");
  assert.match(url.searchParams.get("redirect_uri"), /\/api\/connections\/google\/callback$/);

  const list = await http("GET", "/api/connections?provider=google", { cookie });
  assert.equal(list.data.providers.google, true);
  assert.equal(list.data.providers.microsoft, false);
  assert.ok(list.data.unavailable.includes("gmailListMessages"));
});

test("Google nodes with unverified scopes cannot start a connection on the cloud", async () => {
  const cookie = await signUp();
  const res = await http("GET", "/api/connections/google/start?node=gmailListMessages", { cookie });
  assert.notEqual(res.status, 302, "no redirect to Google's consent screen");
  const all = await http("GET", "/api/connections/google/start", { cookie });
  assert.equal(all.status, 302);
  const scopes = new URL(all.location).searchParams.get("scope").split(" ");
  assert.ok(scopes.includes(GMAIL_SEND));
  assert.ok(!scopes.some((s) => /gmail\.(readonly|modify|compose)|\/drive$|bigquery/.test(s)), scopes.join(" "));
});

test("Airtable connections use PKCE and ask only for the node's scopes", async () => {
  const cookie = await signUp();
  const res = await http("GET", "/api/connections/airtable/start?node=airtableRead", { cookie });
  assert.equal(res.status, 302);
  const url = new URL(res.location);
  assert.equal(url.host, "airtable.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge").length >= 43);
  assert.deepEqual(url.searchParams.get("scope").split(" ").sort(), ["data.records:read", "user.email:read"]);
});

test("Connect GitHub returns to exactly the login callback, so one GitHub app serves both", async () => {
  const cookie = await signUp();
  const res = await http("GET", "/api/connections/github/start?node=githubListIssues", { cookie });
  assert.equal(res.status, 302);
  const url = new URL(res.location);
  const ru = url.searchParams.get("redirect_uri");
  assert.match(ru, /\/api\/auth\/oauth\/github\/callback$/, "no sub-path: GitHub rejects it unless the app's callback is exactly the login one");
  // A connect state on the login callback is handled as a connection (not a
  // login): the exchange fails offline, but in the connect popup, not with
  // the login flow's "Invalid login state".
  const state = url.searchParams.get("state");
  const cb = await http("GET", `/api/auth/oauth/github/callback?state=${encodeURIComponent(state)}&code=x`, { cookie });
  assert.doesNotMatch(cb.text, /Invalid login state/);
  assert.match(cb.text, /GitHub/);
  // A login state (or garbage) still goes to the login flow.
  const login = await http("GET", "/api/auth/oauth/github/callback?state=forged&code=x", { cookie });
  assert.equal(login.status, 400);
  assert.match(login.text, /Invalid login state/);
  // The old sub-path still finishes a connect started before a deploy.
  const old = await http("GET", "/api/auth/oauth/github/callback/connect?state=forged&code=x", { cookie });
  assert.equal(old.status, 400);
  assert.match(old.text, /expired/);
});

test("a callback with an unknown state is refused", async () => {
  const cookie = await signUp();
  const res = await http("GET", "/api/connections/google/callback?state=forged&code=abc", { cookie });
  assert.equal(res.status, 400);
  assert.match(res.text, /expired/);
});

test("the vault API never returns a connection's tokens", async () => {
  const cookie = await signUp();
  const made = await http("POST", "/api/credentials", {
    cookie,
    body: { name: "Google — x", type: "oauth:google", fields: { provider: "google", email: "x@example.com", scope: "email", accessToken: "a", refreshToken: "r" } },
  });
  const list = await http("GET", "/api/credentials", { cookie });
  const row = list.data.find((c) => c.id === made.data.id);
  assert.equal(row.fields.email, "x@example.com");
  assert.equal(row.fields.refreshToken, undefined);
  assert.equal(row.fields.accessToken, undefined);
});

test("Sheets: an empty tab name uses the first tab, names are quoted, a wrong name gets clear advice", async () => {
  const cred = await db.credentialCreate({
    userId: "u5",
    name: "Google — me@example.com",
    type: "oauth:google",
    fields: { provider: "google", email: "me@example.com", scope: "https://www.googleapis.com/auth/spreadsheets", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
  });
  const wf = (sheetName) => ({ id: "wf", nodes: [{ id: "n1", type: "googleSheetsAppend", data: { config: { ...NODES.googleSheetsAppend.defaults, oauthAccount: cred.id, spreadsheetId: "abc", sheetName, values: '["x"]' } } }], edges: [] });

  stubFetch(() => ({ body: { updates: { updatedRows: 1 } } }));
  assert.equal((await executeNode(wf(""), "n1", [{ json: {} }], { userId: "u5" })).status, "success");
  assert.match(calls[0].url, /\/values\/A1:append/);

  stubFetch(() => ({ body: { updates: { updatedRows: 1 } } }));
  await executeNode(wf("Q1 Leads"), "n1", [{ json: {} }], { userId: "u5" });
  assert.ok(calls[0].url.includes(encodeURIComponent("'Q1 Leads'!A1")), calls[0].url);

  stubFetch(() => ({ status: 400, body: { error: { message: "Unable to parse range: Sheet1!A1" } } }));
  const bad = await executeNode(wf("Sheet1"), "n1", [{ json: {} }], { userId: "u5" });
  assert.equal(bad.status, "error");
  assert.match(bad.error, /no tab named "Sheet1".*leave “Sheet name” empty/);
});
