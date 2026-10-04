// ============================================================================
// W FLOW — move a self-hosted account to the cloud
//
// The one deliberate exception to "a copy sends nothing to w-flow.tech": the
// account asks for it. On the cloud they create a one-time move code
// (Settings → Self-hosted → "Move a self-hosted copy here"), paste it into the
// copy (Setup or the lock screen → "Move to the cloud"), and the copy sends
// that account's own data, once, over HTTPS:
//
//   workflows   with their credentials (each gets a new id in the cloud;
//               a taken webhook URL part is dropped)
//   agents      with their model keys
//   variables   values and test values
//   credentials vault entries and connected accounts, decrypted on the copy
//               and encrypted again with the cloud's own key
//   data tables columns and rows
//
// Run history, files and other accounts on the copy are not moved — each
// member of a team copy moves their own account with their own code. The copy
// keeps everything it had; moving is a copy, not a cut.
// ============================================================================
import { createHash, randomBytes } from "node:crypto";
import { db } from "./dbx.js";

export const CODE_TTL_MS = 60 * 60 * 1000;
const codeKey = (hash) => `migrate.code.${hash}`;
const digest = (code) => createHash("sha256").update(String(code || "").trim()).digest("hex");

// ---- cloud: one-time move codes ----

export async function newMigrationCode(userId) {
  const code = `wfm_${randomBytes(24).toString("base64url")}`;
  await db.storeSet(codeKey(digest(code)), JSON.stringify({ userId: String(userId), expires: Date.now() + CODE_TTL_MS }));
  return { code, expiresAt: Date.now() + CODE_TTL_MS };
}

/** The account a code moves data into; the code is used up either way. */
export async function consumeMigrationCode(code) {
  if (!/^wfm_[A-Za-z0-9_-]{20,64}$/.test(String(code || "").trim())) return "";
  const key = codeKey(digest(code));
  let rec = null;
  try {
    rec = JSON.parse((await db.storeGet(key)) || "null");
  } catch {
    rec = null;
  }
  await db.storeDelete(key);
  if (!rec || Number(rec.expires) < Date.now()) return "";
  return String(rec.userId || "");
}

// ---- copy: what gets sent ----

/**
 * Everything one account owns on this copy, secrets included (the request is
 * made over HTTPS straight to the cloud). `deps` comes from server/index.js,
 * which owns the secret-hydration helpers.
 */
export async function buildMigrationPayload(userId, { listWorkflows, hydrateWorkflow, listAgents, hydrateAgent }) {
  const workflows = [];
  for (const wf of await listWorkflows(userId)) workflows.push(await hydrateWorkflow(wf));
  const agents = [];
  for (const a of await listAgents(userId)) agents.push(await hydrateAgent(a));
  const variables = ((await db.variablesList(userId)) || []).map((v) => ({ name: v.name, value: v.value, testValue: v.testValue ?? "", secret: !!v.secret }));
  const credentials = ((await db.credentialsList(userId)) || []).map((c) => ({ name: c.name, type: c.type, fields: c.fields || {} }));
  const dataTables = [];
  for (const t of (await db.dataTablesList(userId)) || []) {
    const rows = ((await db.dataTableRowsList(t.id, userId)) || []).map((r) => r.data);
    dataTables.push({ name: t.name, columns: t.columns, rows });
  }
  return { format: "wflow-move", version: 1, exportedAt: new Date().toISOString(), workflows, agents, variables, credentials, dataTables };
}

/** Send this account's data to the cloud with a move code. */
export async function sendToCloud({ cloudUrl, code, payload, fetchImpl = globalThis.fetch }) {
  const url = `${String(cloudUrl).replace(/\/+$/, "")}/api/migrate/import`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(code).trim()}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `The cloud answered ${res.status}.`);
  return body;
}

// ---- cloud: receiving ----

const cap = (v, n) => String(v ?? "").slice(0, n);

/**
 * Store a moved account's data under `userId`. Nothing that is already there
 * is overwritten: variables whose name exists keep the cloud's value.
 */
export async function importMigrationPayload(userId, payload, { createWorkflow, saveAgent }) {
  if (!payload || payload.format !== "wflow-move") throw new Error("This is not a W flow move package.");
  const counts = { workflows: 0, agents: 0, variables: 0, credentials: 0, dataTables: 0, skipped: [] };

  for (const wf of Array.isArray(payload.workflows) ? payload.workflows : []) {
    const body = { ...wf };
    delete body.id; // a fresh id — never touch a workflow that already exists here
    delete body.ownerId;
    delete body.collaborators;
    delete body.folderId;
    delete body.code;
    const r = await createWorkflow(userId, body);
    if (r.status === 409 && body.webhookSlug) {
      delete body.webhookSlug;
      const again = await createWorkflow(userId, body);
      if (again.status === 200) counts.workflows++;
      else counts.skipped.push(`${cap(wf.name, 80)}: ${again.json?.error || again.status}`);
    } else if (r.status === 200) counts.workflows++;
    else counts.skipped.push(`${cap(wf.name, 80)}: ${r.json?.error || r.status}`);
  }

  for (const a of Array.isArray(payload.agents) ? payload.agents : []) {
    const agent = { ...a };
    delete agent.id;
    await saveAgent(userId, agent);
    counts.agents++;
  }

  const haveVars = new Set(((await db.variablesList(userId)) || []).map((v) => v.name));
  for (const v of Array.isArray(payload.variables) ? payload.variables : []) {
    const name = cap(v?.name, 120);
    if (!name || haveVars.has(name)) continue;
    await db.variableCreate({ userId, name, value: cap(v.value, 100_000), testValue: cap(v.testValue, 100_000), secret: !!v.secret });
    haveVars.add(name);
    counts.variables++;
  }

  for (const c of Array.isArray(payload.credentials) ? payload.credentials : []) {
    const name = cap(c?.name, 120);
    if (!name) continue;
    const fields = c.fields && typeof c.fields === "object" && !Array.isArray(c.fields) ? c.fields : {};
    await db.credentialCreate({ userId, name, type: cap(c.type || "custom", 60), fields });
    counts.credentials++;
  }

  for (const t of Array.isArray(payload.dataTables) ? payload.dataTables : []) {
    const name = cap(t?.name, 120);
    if (!name) continue;
    const table = await db.dataTableCreate({ userId, name, columns: Array.isArray(t.columns) ? t.columns : [] });
    const rows = (Array.isArray(t.rows) ? t.rows : []).filter((r) => r && typeof r === "object");
    if (rows.length) await db.dataTableRowCreateMany({ tableId: table.id, userId, rows });
    counts.dataTables++;
  }
  return counts;
}
