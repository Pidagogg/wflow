// ============================================================================
// mailConfigured() decides whether password sign-ups must confirm their e-mail.
// A half-filled SMTP setup (host + login, no password) can never deliver, so it
// must not switch that gate on — otherwise every new account is locked out.
// ============================================================================
import assert from "node:assert/strict";
import { test, after } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-mailcfg-"));
process.env.BF_DB_PATH = path.join(tempDir, "mail.db");
process.env.BF_DATA_DIR = path.join(tempDir, "data");
const { mailConfigured } = await import("../server/mail.js");

// ---- helpers ----
function withSmtp(vars, fn) {
  const keys = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---- tests ----
test("no host means mail is not configured", () =>
  withSmtp({}, async () => assert.equal(await mailConfigured(), false)));

test("a host with a login but no password is not configured", () =>
  withSmtp({ SMTP_HOST: "smtp.example.com", SMTP_USER: "no-reply@example.com" }, async () =>
    assert.equal(await mailConfigured(), false)));

test("a host with a full login is configured", () =>
  withSmtp({ SMTP_HOST: "smtp.example.com", SMTP_USER: "no-reply@example.com", SMTP_PASS: "x" }, async () =>
    assert.equal(await mailConfigured(), true)));

test("an open relay (host, no login) is configured", () =>
  withSmtp({ SMTP_HOST: "127.0.0.1" }, async () => assert.equal(await mailConfigured(), true)));
