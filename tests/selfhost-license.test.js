// ============================================================================
// Self-hosted licence, custom Team plan, team admin of a copy and the move to
// the cloud (server/license.js, teams.js, team-admin.js, migrate.js).
//
// One in-process database plays both sides: with WFLOW_STANDALONE unset it is
// the cloud (issues keys, answers checks, holds Team plans); with it set it is
// a copy (checks its key through a stubbed fetch, locks, limits seats).
//
// Run: node --test tests/selfhost-license.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test, after, beforeEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-license-"));
process.env.BF_DB_PATH = path.join(tempDir, "license.db");
process.env.BF_ENV_PATH = path.join(tempDir, "copy.env");
fs.writeFileSync(process.env.BF_ENV_PATH, "# test copy\n");
delete process.env.WFLOW_STANDALONE;
delete process.env.WFLOW_LICENSE_KEY;

const { db } = await import("../server/dbx.js");
const lic = await import("../server/license.js");
const teams = await import("../server/teams.js");
const admin = await import("../server/team-admin.js");
const { isProUser, runQuota } = await import("../server/quota.js");
const { newMigrationCode, consumeMigrationCode, buildMigrationPayload, importMigrationPayload } = await import("../server/migrate.js");
const { withRunContext, currentRunContext } = await import("../server/run-context.js");
const { ERROR_CODES } = await import("../shared/errors.js");

after(() => {
  delete process.env.WFLOW_STANDALONE;
  try {
    db.closeDb?.();
  } catch {
    /* ignore */
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const asCloud = () => {
  delete process.env.WFLOW_STANDALONE;
  lic.resetLicenseCache();
  admin.resetTeamAdminCache();
};
const asCopy = () => {
  process.env.WFLOW_STANDALONE = "1";
  lic.resetLicenseCache();
  admin.resetTeamAdminCache();
};
beforeEach(asCloud);

let n = 0;
async function newUser(prefix = "u") {
  n++;
  return db.createUser({ email: `${prefix}${n}-${process.pid}@example.com`, name: `${prefix} ${n}`, passwordHash: "x" });
}
async function makePro(user) {
  await db.setSubscription(user.id, { subscriptionId: `sub_${user.id}`, status: "active" });
}
const entitlement = async (userId) => {
  const user = await db.getUserById(userId);
  const team = await teams.teamEntitlement(user);
  if (team?.plan === "team") return team;
  return (await isProUser(userId)) ? { pro: true, plan: "pro", seats: 1 } : { pro: false };
};

// ---- cloud: keys ----

test("a licence key is only worth something while its account is Pro", async () => {
  const u = await newUser();
  const key = await lic.licenseKeyFor(u.id);
  assert.match(key, /^wfl_/);
  assert.equal(await lic.licenseKeyFor(u.id), key, "the same key is shown again");

  const free = await lic.checkLicenseKey(key, entitlement);
  assert.equal(free.valid, false);
  assert.match(free.reason, /subscription .* has ended/);

  await makePro(u);
  const pro = await lic.checkLicenseKey(key, entitlement);
  assert.equal(pro.valid, true);
  assert.equal(pro.plan, "pro");
  assert.equal(pro.seats, 1);
  assert.ok(pro.validUntil > Date.now());

  assert.equal((await lic.checkLicenseKey("wfl_unknownunknownunknownunknown", entitlement)).valid, false);
});

test("rotating a key retires the old one", async () => {
  const u = await newUser();
  await makePro(u);
  const old = await lic.licenseKeyFor(u.id);
  const fresh = await lic.rotateLicenseKey(u.id);
  assert.notEqual(old, fresh);
  assert.equal((await lic.checkLicenseKey(old, entitlement)).valid, false);
  assert.equal((await lic.checkLicenseKey(fresh, entitlement)).valid, true);
});

// ---- cloud: Team plan ----

test("a Team plan is requested, approved with a price, paid and then covers its members", async () => {
  const owner = await newUser("owner");
  const member = await newUser("member");
  const r = await teams.requestTeam({ userId: owner.id, email: owner.email, name: owner.name }, { seats: 3, company: "ACME", message: "hi" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.team.status, "pending");
  assert.equal(r.team.active, false);

  const again = await teams.requestTeam({ userId: owner.id, email: owner.email }, { seats: 3 });
  assert.equal(again.ok, false, "one open request per account");

  // cannot be bought before approval
  const pending = await teams.teamOwnedBy(owner.id);
  assert.equal(pending.status, "pending");

  const noPrice = await teams.decideTeam(pending.id, { approve: true });
  assert.equal(noPrice.ok, false, "approval needs a price");
  const ok = await teams.decideTeam(pending.id, { approve: true, priceMonthly: 25 });
  assert.equal(ok.ok, true);
  assert.equal(ok.team.status, "approved");
  assert.equal(ok.team.priceMonthly, 25);
  assert.equal(await isProUser(owner.id), false, "approved is not paid");

  await teams.markTeamPaid(pending.id, { months: 1 });
  assert.equal(await isProUser(owner.id), true);
  const ent = await teams.teamEntitlement(await db.getUserById(owner.id));
  assert.deepEqual(ent, { pro: true, plan: "team", seats: 3 });

  // members: the owner holds one seat, so 2 more fit
  const tooMany = await teams.setTeamMembers(owner.id, ["a@x.io", "b@x.io", "c@x.io"]);
  assert.equal(tooMany.ok, false);
  const set = await teams.setTeamMembers(owner.id, [member.email, "other@x.io"]);
  assert.equal(set.ok, true, set.error);
  assert.equal(await isProUser(member.id), true, "a listed member is Pro in the cloud");

  // the owner's licence carries the seats
  await lic.licenseKeyFor(owner.id);
  const check = await lic.checkLicenseKey(await lic.licenseKeyFor(owner.id), entitlement);
  assert.equal(check.plan, "team");
  assert.equal(check.seats, 3);

  await teams.endTeam(pending.id);
  assert.equal(await isProUser(member.id), false);
  assert.equal(await isProUser(owner.id), false);
});

test("a Stripe-paid team lives exactly as long as the owner's subscription", async () => {
  const owner = await newUser("stripe");
  await teams.requestTeam({ userId: owner.id, email: owner.email }, { seats: 2 });
  const t = await teams.teamOwnedBy(owner.id);
  await teams.decideTeam(t.id, { approve: true, priceMonthly: 19.98 });
  await db.setSubscription(owner.id, { subscriptionId: "sub_team_1", status: "active" });
  await teams.activateTeamFromCheckout(t.id, "sub_team_1");
  assert.equal(await teams.teamActive(await teams.getTeam(t.id)), true);
  await db.setSubscription(owner.id, { subscriptionId: "sub_team_1", status: "canceled" });
  assert.equal(await teams.teamActive(await teams.getTeam(t.id)), false);
});

// ---- copy: checking and locking ----

const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test("a copy without a key is locked; a valid answer unlocks it; a refusal locks it again", async () => {
  asCopy();
  const owner = await newUser("copy");
  delete process.env.WFLOW_LICENSE_KEY;
  assert.equal(lic.licenseRequired(), true);
  await lic.refreshLicense({ fetchImpl: okFetch({ valid: true }) });
  assert.equal(await lic.licenseActive(), false, "no key, no licence");
  assert.equal(await isProUser(owner.id), false);
  assert.equal((await runQuota(owner.id)).allowed, false);

  process.env.WFLOW_LICENSE_KEY = "wfl_" + "k".repeat(32);
  let sent = null;
  await lic.refreshLicense({
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ valid: true, plan: "team", seats: 4, validUntil: Date.now() + 1e9 }) };
    },
  });
  assert.deepEqual(Object.keys(sent.body), ["key"], "only the key leaves the copy");
  assert.match(sent.url, /\/api\/license\/check$/);
  const s = await lic.licenseStatus();
  assert.equal(s.active, true);
  assert.equal(s.seats, 4);
  assert.ok(s.validUntil <= Date.now() + lic.GRACE_MS + 1000, "grace is capped on the copy");
  assert.equal(await isProUser(owner.id), true, "every account on an active copy is Pro");

  await lic.refreshLicense({ fetchImpl: async () => ({ ok: false, status: 200, json: async () => ({ valid: false, reason: "ended" }) }) });
  assert.equal(await lic.licenseActive(), false);
  assert.equal((await lic.licenseStatus()).reason, "ended");
});

test("an offline copy keeps its last good answer until the grace period runs out", async () => {
  asCopy();
  process.env.WFLOW_LICENSE_KEY = "wfl_" + "o".repeat(32);
  await lic.refreshLicense({ fetchImpl: okFetch({ valid: true, plan: "pro", seats: 1, validUntil: Date.now() + 1e9 }) });
  await lic.refreshLicense({
    fetchImpl: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(await lic.licenseActive(), true, "a network blip does not lock");
  const s = await lic.licenseStatus();
  assert.ok(s.offlineSince > 0);
});

test("the licence gate lets a locked copy serve only sign-in, licence, setup and the move", async () => {
  asCopy();
  process.env.WFLOW_LICENSE_KEY = "wfl_" + "g".repeat(32);
  await lic.refreshLicense({ fetchImpl: okFetch({ valid: false, reason: "nope" }) });
  const call = async (url) => {
    let status = 200;
    let body = null;
    let passed = false;
    const res = { status: (c) => ((status = c), res), json: (b) => ((body = b), res) };
    await lic.licenseGate({ originalUrl: url }, res, () => (passed = true));
    return { passed, status, body };
  };
  for (const open of ["/api/auth/login", "/api/license", "/api/license/key", "/api/setup", "/api/migrate/send"]) {
    assert.equal((await call(open)).passed, true, `${open} stays open`);
  }
  const blocked = await call("/api/workflows");
  assert.equal(blocked.passed, false);
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.code, "LICENSE_INACTIVE");
  assert.equal((await call("/webhook/abc")).passed, false);
});

test("a pasted key is written to the copy's .env and checked at once", async () => {
  asCopy();
  const bad = await lic.setLocalLicenseKey("nonsense");
  assert.equal(bad.ok, false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = okFetch({ valid: true, plan: "pro", seats: 1, validUntil: Date.now() + 1e9 });
  try {
    const r = await lic.setLocalLicenseKey("wfl_" + "p".repeat(32));
    assert.equal(r.ok, true, r.error);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(fs.readFileSync(process.env.BF_ENV_PATH, "utf8"), /WFLOW_LICENSE_KEY=wfl_p{32}/);
});

// ---- copy: team admin ----

test("seats cap the accounts on a copy", async () => {
  asCopy();
  process.env.WFLOW_LICENSE_KEY = "wfl_" + "s".repeat(32);
  const used = Number(await db.countUsers());
  await lic.refreshLicense({ fetchImpl: okFetch({ valid: true, plan: "team", seats: used + 1, validUntil: Date.now() + 1e9 }) });
  assert.equal((await admin.seatAvailable()).ok, true);
  await newUser("seat");
  const full = await admin.seatAvailable();
  assert.equal(full.ok, false);
  assert.equal(full.seats, used + 1);
});

test("restricted members only reach the credential pool and the allowed hosts", async () => {
  asCopy();
  process.env.WFLOW_LICENSE_KEY = "wfl_" + "t".repeat(32);
  await lic.refreshLicense({ fetchImpl: okFetch({ valid: true, plan: "team", seats: 99, validUntil: Date.now() + 1e9 }) });
  const ownerId = await admin.instanceOwnerId();
  const member = await newUser("member");
  const shared = await db.credentialCreate({ userId: ownerId, name: "Team OpenAI", type: "custom", fields: { apiKey: "sk-team" } });
  const privateOne = await db.credentialCreate({ userId: ownerId, name: "Admin only", type: "custom", fields: { apiKey: "sk-admin" } });
  const own = await db.credentialCreate({ userId: member.id, name: "Mine", type: "custom", fields: { apiKey: "sk-mine" } });
  await db.variableCreate({ userId: ownerId, name: "TEAM_URL", value: "https://api.example.com", secret: false });
  const vars = await db.variablesList(ownerId);

  const r = await admin.updateTeamSettings({
    poolCredentials: [shared.id, own.id], // the member's own id is ignored: only the admin's can be pooled
    poolVariables: vars.map((v) => v.id),
    restrict: { [member.id]: true, [ownerId]: true }, // the admin can never be restricted
    allowedHosts: ["api.example.com", "*.googleapis.com"],
  });
  assert.equal(r.ok, true, r.error);
  const s = await admin.teamSettings();
  assert.deepEqual(s.pool.credentials.map((p) => p.id), [shared.id]);
  assert.equal(s.restricted[ownerId], undefined);

  assert.equal(await admin.credentialOwner(shared.id, member.id), ownerId, "pooled credential is read as the admin's");
  await assert.rejects(() => admin.credentialOwner(privateOne.id, member.id), /shared credentials/);
  await assert.rejects(() => admin.credentialOwner(own.id, member.id), /shared credentials/, "restricted: not even their own");

  const list = await admin.withPooledCredentials(member.id, [{ id: own.id, name: "Mine" }], () => true, (c) => ({ id: c.id, name: c.name }));
  assert.deepEqual(list.map((c) => c.name), ["Team OpenAI"]);
  assert.equal(list[0].shared, true);

  const seen = await admin.withPooledVariables(member.id, []);
  assert.deepEqual(seen.map((v) => v.name), ["TEAM_URL"]);

  // un-restricted: own credential works again, pool still available
  await admin.updateTeamSettings({ restrict: { [member.id]: false } });
  assert.equal(await admin.credentialOwner(own.id, member.id), member.id);
  assert.equal(await admin.credentialOwner(shared.id, member.id), ownerId);

  assert.equal(admin.normalizeHost("https://API.Example.com:443/v1?x"), "api.example.com");
  assert.equal(admin.normalizeHost("not a host"), "");
  assert.equal(admin.hostAllowed("www.googleapis.com", ["*.googleapis.com"]), true);
  assert.equal(admin.hostAllowed("evil.com", ["*.googleapis.com"]), false);
});

test("the outbound guard records where runs send data and blocks restricted members", async () => {
  asCopy();
  process.env.WFLOW_LICENSE_KEY = "wfl_" + "f".repeat(32);
  await lic.refreshLicense({ fetchImpl: okFetch({ valid: true, plan: "team", seats: 99, validUntil: Date.now() + 1e9 }) });
  const member = await newUser("flow");
  await admin.updateTeamSettings({ restrict: { [member.id]: true }, allowedHosts: ["api.example.com"] });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    admin.installOutboundGuard(currentRunContext);
    const ctx = { vars: {}, environment: "live", ai: { ownerId: member.id, workflow: { id: "wf-1", name: "Prices" } }, filesOwner: member.id };
    await withRunContext(ctx, async () => {
      await fetch("https://api.example.com/v1", { method: "POST" });
      await assert.rejects(
        () => fetch("https://evil.example.org/steal"),
        (err) => err.code === ERROR_CODES.HOST_NOT_ALLOWED.code || /does not allow/.test(err.message)
      );
    });
    // outside any run nothing is checked or recorded
    await fetch("https://evil.example.org/fine");
  } finally {
    globalThis.fetch = realFetch;
  }
  const flows = await admin.readFlows();
  assert.equal(flows[member.id]["api.example.com"].send, 1);
  assert.deepEqual(flows[member.id]["api.example.com"].workflows, { "wf-1": "Prices" });
  assert.equal(flows[member.id]["evil.example.org"], undefined, "a blocked call is not recorded as sent");
});

// ---- move to the cloud ----

test("an account moves from a copy into a cloud account with a one-time code", async () => {
  const from = await newUser("from");
  const to = await newUser("to");
  await db.variableCreate({ userId: from.id, name: "TOKEN", value: "v1", testValue: "t1", secret: true });
  await db.credentialCreate({ userId: from.id, name: "Slack", type: "custom", fields: { token: "xoxb-1" } });
  const table = await db.dataTableCreate({ userId: from.id, name: "Prices", columns: ["day", "price"] });
  await db.dataTableRowCreateMany({ tableId: table.id, userId: from.id, rows: [{ day: "mon", price: 1 }, { day: "tue", price: 2 }] });

  const wf = { id: "wf-src", name: "BTC check", nodes: [{ id: "n1", type: "manualTrigger", data: { config: {} } }], edges: [], webhookSlug: "taken" };
  const payload = await buildMigrationPayload(from.id, {
    listWorkflows: async () => [wf],
    hydrateWorkflow: async (w) => w,
    listAgents: async () => [{ id: "ag-1", name: "Helper", model: { apiKey: "sk" } }],
    hydrateAgent: async (a) => a,
  });
  assert.equal(payload.format, "wflow-move");
  assert.equal(payload.credentials[0].fields.token, "xoxb-1", "secrets travel decrypted, to be re-encrypted by the cloud");

  const { code } = await newMigrationCode(to.id);
  assert.equal(await consumeMigrationCode(code), to.id);
  assert.equal(await consumeMigrationCode(code), "", "a code works once");

  const created = [];
  const agentsSaved = [];
  const counts = await importMigrationPayload(to.id, payload, {
    createWorkflow: async (userId, body) => {
      if (body.webhookSlug) return { status: 409, json: { error: "taken" } };
      created.push({ userId, body });
      return { status: 200, json: body };
    },
    saveAgent: async (userId, agent) => agentsSaved.push({ userId, agent }),
  });
  assert.equal(counts.workflows, 1);
  assert.equal(created[0].body.id, undefined, "a moved workflow gets a fresh id");
  assert.equal(created[0].userId, to.id);
  assert.equal(agentsSaved[0].agent.id, undefined);
  assert.equal(counts.credentials, 1);
  assert.equal(counts.variables, 1);
  assert.equal(counts.dataTables, 1);
  const vars = await db.variablesList(to.id);
  assert.equal(vars.find((v) => v.name === "TOKEN").value, "v1");
  const tables = await db.dataTablesList(to.id);
  assert.equal((await db.dataTableRowsList(tables[0].id, to.id)).length, 2);

  await assert.rejects(() => importMigrationPayload(to.id, { format: "other" }, {}), /not a W flow move package/);
});

test("the installer writes the downloader's licence into the copy's .env", async () => {
  const { installerScript, licenseLines } = await import("../server/selfhost.js");
  const key = "wfl_" + "i".repeat(32);
  for (const os of ["linux", "mac", "windows"]) {
    const script = installerScript({ os, baseUrl: "https://w-flow.tech", token: "t", licenseKey: key, licenseServer: "https://w-flow.tech" });
    const text = os === "windows" ? Buffer.from(script.match(/FromBase64String\('([^']+)'/)[1], "base64").toString("utf8") : script;
    assert.ok(text.includes(`WFLOW_LICENSE_KEY=${key}`), `${os} installer carries the key`);
    assert.ok(text.includes("WFLOW_LICENSE_SERVER=https://w-flow.tech"), `${os} installer carries the licence server`);
  }
  // values are pasted into shell source, so anything odd is dropped
  assert.deepEqual(licenseLines({ licenseKey: "wfl_x'; rm -rf /", licenseServer: "https://a.b/$(id)" }), []);
});
