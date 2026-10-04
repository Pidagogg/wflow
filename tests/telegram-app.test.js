// ============================================================================
// The site-wide Telegram app — with an API ID + hash configured by the
// operator, users connect a personal Telegram account with only a phone
// number. The admin-panel value wins over the TELEGRAM_API_* env fallback, and
// a malformed pair counts as "not configured".
//
// Run: node --test tests/telegram-app.test.js
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-tgapp-"));
process.env.BF_DB_PATH = path.join(dir, "t.db");
process.env.BF_DATA_DIR = dir;
delete process.env.DATABASE_URL;
delete process.env.TELEGRAM_API_ID;
delete process.env.TELEGRAM_API_HASH;

const { db } = await import("../server/dbx.js");
const { appCredentials, startLogin, startQrLogin, describeSentCode, TELEGRAM_APP_KEYS } = await import("../server/telegram-accounts.js");

after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the open SQLite file locked until the process exits */
  }
});

const HASH = "0123456789abcdef0123456789abcdef";

test("no app configured → null, and the login still asks for the user's own pair", async () => {
  assert.equal(await appCredentials(), null);
  await assert.rejects(startLogin("u1", { phone: "+491701234567" }), /API ID/);
});

test("a QR login also needs an app (site-wide or the user's own)", async () => {
  await assert.rejects(startQrLogin("u1", {}), /API ID/);
});

test("env vars are the fallback", async () => {
  process.env.TELEGRAM_API_ID = "1234567";
  process.env.TELEGRAM_API_HASH = HASH;
  try {
    assert.deepEqual(await appCredentials(), { apiId: "1234567", apiHash: HASH });
  } finally {
    delete process.env.TELEGRAM_API_ID;
    delete process.env.TELEGRAM_API_HASH;
  }
});

test("the admin-panel value wins, and a malformed pair is ignored", async () => {
  process.env.TELEGRAM_API_ID = "7654321";
  process.env.TELEGRAM_API_HASH = HASH;
  try {
    await db.storeSet(TELEGRAM_APP_KEYS.apiId, "1111111");
    await db.storeSet(TELEGRAM_APP_KEYS.apiHash, HASH, { encrypted: true });
    assert.deepEqual(await appCredentials(), { apiId: "1111111", apiHash: HASH });
    await db.storeSet(TELEGRAM_APP_KEYS.apiHash, "not-a-hash", { encrypted: true });
    assert.equal(await appCredentials(), null);
  } finally {
    delete process.env.TELEGRAM_API_ID;
    delete process.env.TELEGRAM_API_HASH;
    await db.storeDelete(TELEGRAM_APP_KEYS.apiId);
    await db.storeDelete(TELEGRAM_APP_KEYS.apiHash);
  }
});

test("the form is told where Telegram really sent the code", async () => {
  const { Api } = await import("telegram");
  const sent = (type, nextType) => new Api.auth.SentCode({ type, phoneCodeHash: "h", nextType });

  const app = describeSentCode(sent(new Api.auth.SentCodeTypeApp({ length: 5 }), new Api.auth.CodeTypeSms()));
  assert.equal(app.kind, "app");
  assert.equal(app.canResend, true);
  assert.equal(app.nextWay, "by SMS");

  const mail = describeSentCode(sent(new Api.auth.SentCodeTypeEmailCode({ emailPattern: "j***@gmail.com", length: 6 })));
  assert.equal(mail.kind, "email");
  assert.match(mail.message, /j\*\*\*@gmail\.com/);
  assert.equal(mail.canResend, false);

  assert.equal(describeSentCode(sent(new Api.auth.SentCodeTypeSetUpEmailRequired({}))).kind, "setupEmail");
  assert.equal(describeSentCode(sent(new Api.auth.SentCodeTypeSms({ length: 5 }))).kind, "sms");
  assert.equal(describeSentCode(sent(new Api.auth.SentCodeTypeCall({ length: 5 }))).kind, "call");
  const frag = describeSentCode(sent(new Api.auth.SentCodeTypeFragmentSms({ url: "https://fragment.com/x", length: 5 })));
  assert.equal(frag.kind, "fragment");
  assert.equal(frag.url, "https://fragment.com/x");
});

test("with an app configured, a bad phone number is the only thing checked", async () => {
  await db.storeSet(TELEGRAM_APP_KEYS.apiId, "1111111");
  await db.storeSet(TELEGRAM_APP_KEYS.apiHash, HASH, { encrypted: true });
  try {
    // no API ID / hash sent — the error is about the phone, not the keys
    await assert.rejects(startLogin("u1", { phone: "abc" }), /phone number/);
  } finally {
    await db.storeDelete(TELEGRAM_APP_KEYS.apiId);
    await db.storeDelete(TELEGRAM_APP_KEYS.apiHash);
  }
});
