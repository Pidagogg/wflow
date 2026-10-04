// ============================================================================
// Live app triggers — Gmail / IMAP new mail, Google Sheets new row and Stripe
// events used to fire only their sample on Run. They now run for real:
// e-mail and Sheets are polled by the scheduler (server/app-triggers.js), and
// Stripe posts signed events to the workflow's webhook URL.
//
// Run: node --test tests/app-triggers.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { createHmac } from "node:crypto";
import "./helpers/node-harness.js";

const { pollAppTrigger, resetAppTriggerState, appTriggerNodes, newRows, mailMatches, pollIntervalMs } = await import("../server/app-triggers.js");
const { stripeEventMatches, stripeTriggerPayload } = await import("../server/stripe-trigger.js");
const { verifyStripeSignature } = await import("../server/billing.js");
const { SECRET_FIELD_NAMES, stripSecretsFromWorkflow } = await import("../server/store.js");
const { NODES, DEMO_TRIGGERS } = await import("../shared/catalog.js");

beforeEach(() => resetAppTriggerState());

const wf = { id: "wf1" };
const mailNode = (type = "gmail", config = {}) => ({ id: "t1", type, data: { config: { user: "me@gmail.com", folder: "INBOX", pollInterval: 5, ...config } } });
const MIN = 60_000;

function fakeMail(batches) {
  const calls = [];
  return {
    calls,
    mail: async (type, c, cursor) => {
      calls.push({ type, cursor });
      const next = batches.shift() || [];
      if (!cursor) return { cursor: { uidValidity: "7", lastUid: 100 }, messages: [] };
      const lastUid = next.reduce((m, x) => Math.max(m, x.uid), cursor.lastUid);
      return { cursor: { uidValidity: "7", lastUid }, messages: next };
    },
  };
}

test("mail: the first poll only records the cursor, later polls fire for new mail", async () => {
  const fired = [];
  const r = fakeMail([[], [{ uid: 101, from: "Ada <ada@x.io>", subject: "Hello", text: "hi" }]]);
  const opts = { readers: { mail: r.mail } };
  const node = mailNode();
  assert.equal(await pollAppTrigger(wf, node, 0, (p) => fired.push(p), opts), "baseline");
  assert.equal(await pollAppTrigger(wf, node, 1 * MIN, (p) => fired.push(p), opts), "skipped", "not due before the interval");
  assert.equal(await pollAppTrigger(wf, node, 5 * MIN, (p) => fired.push(p), opts), "fired");
  assert.equal(fired.length, 1);
  assert.equal(fired[0].mailbox, "me@gmail.com");
  assert.equal(fired[0].count, 1);
  assert.equal(fired[0].messages[0].subject, "Hello");
  assert.deepEqual(r.calls.map((c) => c.cursor?.lastUid ?? null), [null, 100]);
  assert.equal(await pollAppTrigger(wf, node, 10 * MIN, (p) => fired.push(p), opts), "quiet");
});

test("mail: From / Subject filters drop non-matching mail", async () => {
  const fired = [];
  const r = fakeMail([[], [{ uid: 101, from: "spam@x.io", subject: "Offer" }, { uid: 102, from: "boss@co.com", subject: "Invoice 7" }]]);
  const node = mailNode("imap", { host: "imap.example.com", filterFrom: "boss@", filterSubject: "invoice" });
  await pollAppTrigger(wf, node, 0, () => {}, { readers: { mail: r.mail } });
  await pollAppTrigger(wf, node, 10 * MIN, (p) => fired.push(p), { readers: { mail: r.mail } });
  assert.equal(fired[0].messages.length, 1);
  assert.equal(fired[0].messages[0].from, "boss@co.com");
  assert.equal(fired[0].mailbox, "imap.example.com");
  assert.equal(mailMatches({ filterFrom: "x" }, { from: "", subject: "" }), false);
});

test("mail: the config with secrets is loaded only when a poll is due", async () => {
  let loads = 0;
  const r = fakeMail([]);
  const opts = { readers: { mail: r.mail }, loadConfig: async () => (loads++, { user: "me@gmail.com", appPassword: "secret" }) };
  await pollAppTrigger(wf, mailNode(), 0, () => {}, opts);
  await pollAppTrigger(wf, mailNode(), 1 * MIN, () => {}, opts);
  assert.equal(loads, 1);
});

test("a half-filled trigger is not polled, and the interval is at least a minute", () => {
  const nodes = [
    mailNode("gmail", { user: "" }),
    mailNode("imap", { host: "" }),
    { id: "s", type: "sheetsTrigger", data: { config: { spreadsheetId: "" } } },
    mailNode("gmail"),
  ];
  assert.deepEqual(appTriggerNodes({ nodes }).map((n) => n.type), ["gmail"]);
  assert.equal(pollIntervalMs({ pollInterval: 0.1 }), MIN);
  assert.equal(pollIntervalMs({}), 5 * MIN);
});

test("sheets: rows added since the last poll become objects named by the header row", () => {
  const values = [["Name", "Email"], ["Ada", "ada@x.io"], ["Lin", "lin@x.io"]];
  assert.deepEqual(newRows(values, undefined).rows, [], "baseline");
  const r = newRows(values, 2);
  assert.deepEqual(r.rows, [{ Name: "Lin", Email: "lin@x.io" }]);
  assert.equal(r.firstRow, 3);
  assert.deepEqual(newRows(values.slice(0, 2), 3).rows, [], "deleted rows re-baseline instead of firing");
  assert.deepEqual(newRows([["Name"], ["Ada"]], 0).rows, [{ Name: "Ada" }], "an empty sheet never fires its header row");
});

test("sheets: a poll fires the new rows", async () => {
  const fired = [];
  const sheets = [[["Name"], ["Ada"]], [["Name"], ["Ada"], ["Lin"]]];
  const node = { id: "s1", type: "sheetsTrigger", data: { config: { spreadsheetId: "abc", pollInterval: 1 } } };
  const opts = { readers: { sheet: async () => sheets.shift() } };
  assert.equal(await pollAppTrigger(wf, node, 0, () => {}, opts), "baseline");
  assert.equal(await pollAppTrigger(wf, node, MIN, (p) => fired.push(p), opts), "fired");
  assert.deepEqual(fired[0].rows, [{ Name: "Lin" }]);
  assert.equal(fired[0].spreadsheetId, "abc");
});

test("stripe: event filter, payload shape and the signature check", () => {
  assert.equal(stripeEventMatches("invoice.paid", "invoice.paid"), true);
  assert.equal(stripeEventMatches("invoice.paid", "charge.refunded"), false);
  assert.equal(stripeEventMatches("*", "charge.refunded"), true);
  const p = stripeTriggerPayload({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", customer_details: { email: "a@x.io", name: "Ada" }, amount_total: 900 } } });
  assert.equal(p.event, "checkout.session.completed");
  assert.equal(p.customer.email, "a@x.io");
  assert.equal(p.session.amount_total, 900);

  const body = Buffer.from(JSON.stringify({ id: "evt_1" }));
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
  assert.equal(verifyStripeSignature(`t=${t},v1=${sig}`, body, "whsec_test"), true);
  assert.equal(verifyStripeSignature(`t=${t},v1=${sig}`, body, "whsec_other"), false);
});

test("webhook signing secrets are stored encrypted and never published", () => {
  assert.ok(SECRET_FIELD_NAMES.has("webhookSecret"));
  const shared = stripSecretsFromWorkflow({ nodes: [{ id: "g", type: "githubTrigger", data: { config: { webhookSecret: "s3cret", event: "issues" } } }] });
  assert.equal(shared.nodes[0].data.config.webhookSecret, "");
});

test("the catalog marks only the remaining sample-only triggers as Demo", () => {
  for (const type of ["gmail", "imap", "sheetsTrigger", "stripeTrigger", "githubTrigger", "telegramTrigger", "rssTrigger"]) {
    assert.ok(!NODES[type].demo, `${type} is live`);
  }
  for (const type of DEMO_TRIGGERS) assert.equal(NODES[type]?.demo, true, type);
  assert.ok(NODES.gmail.fields.some((f) => f.key === "appPassword" && f.type === "secret"));
});

test("stripe: a redelivered or replayed event runs once per workflow, for a day", async () => {
  const { firstDelivery } = await import("../server/stripe-trigger.js");
  const t0 = 1_000_000_000_000;
  assert.equal(firstDelivery("wfA", "evt_9", t0), true);
  assert.equal(firstDelivery("wfA", "evt_9", t0 + 60_000), false, "Stripe's retry is ignored");
  assert.equal(firstDelivery("wfB", "evt_9", t0 + 60_000), true, "another workflow still gets it");
  assert.equal(firstDelivery("wfA", "evt_9", t0 + 25 * 3600_000), true, "forgotten after a day");
  assert.equal(firstDelivery("wfA", "", t0), true, "no id, no dedupe");
});
