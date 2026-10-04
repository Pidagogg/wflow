// ============================================================================
// Personal values in node settings (shared/privacy.js): literal recipients,
// chat IDs, logins, hosts and wallets are removed for sharing; placeholders
// and every other setting stay.
//
// Run: node --test tests/privacy.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLiteralValue, stripPrivateFromConfig, stripPrivateFromWorkflow, PRIVATE_FIELD_NAMES } from "../shared/privacy.js";
import { NODES } from "../shared/catalog.js";

test("only literal text counts as a personal value", () => {
  assert.equal(hasLiteralValue("me@example.com"), true);
  assert.equal(hasLiteralValue("{{body.email}}"), false);
  assert.equal(hasLiteralValue("{{a}}, {{$vars.ALERT_TO}}"), false);
  assert.equal(hasLiteralValue("{{a}}, boss@example.com"), true);
  assert.equal(hasLiteralValue(""), false);
});

test("a config loses its personal values and keeps the rest", () => {
  const out = stripPrivateFromConfig({ to: "me@example.com", cc: "{{cc}}", subject: "Hi", host: "db.internal", user: "admin", port: 5432 });
  assert.deepEqual(out, { to: "", cc: "{{cc}}", subject: "Hi", host: "", user: "", port: 5432 });
});

test("a workflow's nodes are cleaned without touching the original", () => {
  const wf = { name: "x", nodes: [{ id: "a", data: { config: { chatId: "42", text: "hi" } } }, { id: "b" }] };
  const out = stripPrivateFromWorkflow(wf);
  assert.equal(out.nodes[0].data.config.chatId, "");
  assert.equal(out.nodes[0].data.config.text, "hi");
  assert.equal(wf.nodes[0].data.config.chatId, "42", "the input is not modified");
});

test("the private names cover the recipient fields of the mail and chat nodes", () => {
  for (const [type, key] of [["gmailSend", "to"], ["emailSend", "to"], ["telegramSend", "chatId"], ["twilioSms", "to"], ["outlookSend", "to"]]) {
    assert.ok(NODES[type].fields.some((f) => f.key === key), `${type}.${key} exists`);
    assert.ok(PRIVATE_FIELD_NAMES.has(key), `${key} is private`);
  }
});
