// ============================================================================
// E2E coverage for required e-mail confirmation on password sign-ups.
//
// Once SMTP is configured a password sign-up only becomes an account when the
// e-mailed link is opened — otherwise anyone could register with an address
// they do not own. The server is spawned against a tiny in-process SMTP sink
// that accepts every message except those to "bounce-…" recipients (a failed
// send), and BF_EXPOSE_RESET_LINK=1 hands the link back in the API so no real
// mailbox is needed.
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
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-verify-"));

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

let child;
let base = "";
let smtp;
const delivered = [];

// ---- helpers ----
// Just enough SMTP for nodemailer: no TLS, no auth, one message per session.
function startSmtpSink() {
  const server = net.createServer((sock) => {
    let inData = false;
    let body = "";
    let rcpt = "";
    sock.write("220 sink ESMTP\r\n");
    sock.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\r\n")) {
        if (inData) {
          if (line === ".") {
            inData = false;
            delivered.push({ to: rcpt, body });
            sock.write("250 queued\r\n");
          } else body += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (!line) continue;
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250 sink\r\n");
        else if (cmd === "MAIL") sock.write("250 ok\r\n");
        else if (cmd === "RCPT") {
          rcpt = (line.match(/<([^>]*)>/) || [])[1] || "";
          sock.write(rcpt.startsWith("bounce-") ? "550 no such mailbox\r\n" : "250 ok\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          sock.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function api(method, url, body, cookie = "") {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  const session = setCookie.map((c) => c.split(";")[0]).find((c) => /=./.test(c)) || "";
  return { status: res.status, data, session };
}

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become ready in time");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const uniqueEmail = (tag) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

// ---- lifecycle ----
before(async () => {
  const port = await freePort();
  smtp = await startSmtpSink();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: path.join(tempDir, "verify.db"),
      BF_DATA_DIR: path.join(tempDir, "data"),
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
      BF_EXPOSE_RESET_LINK: "1",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtp.address().port),
      SMTP_SECURE: "",
      SMTP_USER: "",
      SMTP_PASS: "",
      BF_REQUIRE_EMAIL_VERIFY: "",
      // short cooldown so the flow tests can send twice; the limits get their
      // own server with the production values below
      BF_MAIL_COOLDOWN_SECONDS: "1",
      BF_MAIL_IP_LIMIT: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForServer();
});

after(async () => {
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  smtp?.close();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---- tests ----
test("the public config says confirmation is required once SMTP is set", async () => {
  const res = await api("GET", "/api/auth/config");
  assert.equal(res.data.emailVerificationRequired, true);
});

test("a password sign-up only becomes an account when the e-mailed link is opened", async () => {
  const email = uniqueEmail("gate");
  const password = "correct-horse-battery";

  const reg = await api("POST", "/api/auth/register", { email, password, name: "Gate" });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.equal(reg.data.authed, false);
  assert.equal(reg.data.verifyRequired, true);
  assert.equal(reg.session, "", "no session cookie before confirmation");
  assert.ok(reg.data.verifyLink, "verify link exposed for this test instance");
  const mail = delivered.find((m) => m.to === email);
  assert.ok(mail, "the confirmation mail reached the SMTP server");
  assert.match(mail.body, /verify=/);

  const locked = await api("POST", "/api/auth/login", { email, password });
  assert.equal(locked.status, 403);
  assert.equal(locked.data.needsVerification, true);
  assert.equal(locked.session, "");

  // the wrong password does not reveal that a sign-up is pending
  const wrong = await api("POST", "/api/auth/login", { email, password: "not-the-password" });
  assert.equal(wrong.status, 401);

  // a second mail to the same address inside the cooldown is refused
  const tooSoon = await api("POST", "/api/auth/register", { email, password, name: "Gate" });
  assert.equal(tooSoon.status, 429, JSON.stringify(tooSoon.data));
  assert.ok(tooSoon.data.retryAfter >= 1);
  await sleep(1100);

  // no account exists yet, so signing up again is not "already exists" — it
  // replaces the pending sign-up and the earlier link stops working
  const again = await api("POST", "/api/auth/register", { email, password, name: "Gate" });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const stale = new URL(reg.data.verifyLink).searchParams.get("verify");
  assert.equal((await api("POST", "/api/auth/verify-email", { token: stale })).status, 400);
  reg.data.verifyLink = again.data.verifyLink;

  const token = new URL(reg.data.verifyLink).searchParams.get("verify");
  const verified = await api("POST", "/api/auth/verify-email", { token });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.authed, true);
  assert.equal(verified.data.email, email);
  assert.ok(verified.session, "opening the link signs the account in");

  const me = await api("GET", "/api/auth/me", undefined, verified.session);
  assert.equal(me.data.authed, true);
  assert.equal(me.data.emailVerified, true);

  const login = await api("POST", "/api/auth/login", { email, password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.ok(login.session);

  // a used link cannot be replayed
  const replay = await api("POST", "/api/auth/verify-email", { token });
  assert.equal(replay.status, 400);

  // now the account exists
  const dup = await api("POST", "/api/auth/register", { email, password });
  assert.equal(dup.status, 409);
});

test("when the confirmation mail cannot be sent, nothing is created", async () => {
  const email = uniqueEmail("bounce");
  const password = "correct-horse-battery";

  const reg = await api("POST", "/api/auth/register", { email, password });
  assert.equal(reg.status, 503, JSON.stringify(reg.data));
  assert.match(reg.data.error, /no account was created/);
  assert.equal(reg.session, "");

  const login = await api("POST", "/api/auth/login", { email, password });
  assert.equal(login.status, 401, "no account and no pending sign-up");
});

test("the login card can resend the link without revealing which accounts exist", async () => {
  const email = uniqueEmail("resend");
  await api("POST", "/api/auth/register", { email, password: "correct-horse-battery" });
  await sleep(1100); // past the per-address cooldown

  const known = await api("POST", "/api/auth/resend-verification-public", { email });
  assert.equal(known.status, 200);
  assert.ok(known.data.verifyLink, "a fresh link for the unconfirmed account");

  const unknown = await api("POST", "/api/auth/resend-verification-public", { email: uniqueEmail("nobody") });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.verifyLink, undefined);
  assert.equal(unknown.data.ok, true);

  // the fresh link works
  const token = new URL(known.data.verifyLink).searchParams.get("verify");
  const verified = await api("POST", "/api/auth/verify-email", { token });
  assert.equal(verified.data.authed, true);
});

test("confirmation mails are limited per address and per IP", async () => {
  // a second server with the production cooldown (60 s) and a small IP budget
  const port = await freePort();
  const limited = spawn(process.execPath, ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      BF_DB_PATH: path.join(tempDir, "limits.db"),
      BF_DATA_DIR: path.join(tempDir, "limits-data"),
      DISABLE_SCHEDULER: "1",
      NODE_ENV: "test",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtp.address().port),
      SMTP_SECURE: "",
      SMTP_USER: "",
      SMTP_PASS: "",
      BF_REQUIRE_EMAIL_VERIFY: "",
      BF_MAIL_COOLDOWN_SECONDS: "",
      BF_MAIL_IP_LIMIT: "3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  limited.stdout.on("data", () => {});
  limited.stderr.on("data", () => {});
  const mainBase = base;
  base = `http://127.0.0.1:${port}`;
  try {
    await waitForServer();
    const first = uniqueEmail("limit-a");
    assert.equal((await api("POST", "/api/auth/register", { email: first, password: "correct-horse-battery" })).status, 200);

    // the same address again right away — resend, reset and a new sign-up all wait
    const resend = await api("POST", "/api/auth/resend-verification-public", { email: first });
    assert.equal(resend.status, 429);
    assert.ok(resend.data.retryAfter > 50 && resend.data.retryAfter <= 60, String(resend.data.retryAfter));
    assert.equal((await api("POST", "/api/auth/forgot", { email: first })).status, 429);

    // other addresses still go out until the IP budget (3 incl. the first) is spent
    assert.equal((await api("POST", "/api/auth/register", { email: uniqueEmail("limit-b"), password: "correct-horse-battery" })).status, 200);
    assert.equal((await api("POST", "/api/auth/forgot", { email: uniqueEmail("limit-c") })).status, 200);
    const spent = await api("POST", "/api/auth/register", { email: uniqueEmail("limit-d"), password: "correct-horse-battery" });
    assert.equal(spent.status, 429);
    assert.match(spent.data.error, /Please wait 10 minutes/);
  } finally {
    base = mainBase;
    limited.kill("SIGTERM");
    await new Promise((resolve) => {
      limited.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
});
