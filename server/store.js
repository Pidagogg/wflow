// ----------------------------------------------------------------------------
// W FLOW — file-backed storage (self-hosted, no database required)
// Data lives in ./data as JSON files.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { db } from "./dbx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Allow overriding the JSON data directory (used by the test suite so tests
// never touch the real ./data folder — same idea as BF_DB_PATH).
const DATA_DIR = process.env.BF_DATA_DIR || path.join(__dirname, "..", "data");

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read(name, fallback) {
  ensureDir();
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) {
    write(name, fallback);
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    write(name, fallback);
    return fallback;
  }
}

function write(name, data) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}

function makeCrud(name, fallback) {
  return {
    all() {
      return read(name, fallback);
    },
    get(id) {
      return this.all().find((x) => x.id === id) || null;
    },
    // --- per-user ownership -------------------------------------------------
    // Workflows and agents are private to the account that created them:
    // listOwned / getOwned / removeOwned only touch entries whose ownerId
    // matches, so one user can never see or modify another user's data.
    listOwned(ownerId) {
      return this.all().filter((x) => x.ownerId === ownerId);
    },
    getOwned(id, ownerId) {
      const x = this.get(id);
      return x && x.ownerId === ownerId ? x : null;
    },
    removeOwned(id, ownerId) {
      const x = this.get(id);
      if (x && x.ownerId === ownerId) {
        this.remove(id);
        return true;
      }
      return false;
    },
    // Adopt any entries saved before ownership existed (no ownerId yet) — used
    // when the first account registers, so existing data is not lost.
    claimUnowned(ownerId) {
      const list = this.all();
      let claimed = 0;
      for (const x of list) {
        if (!x.ownerId) {
          x.ownerId = ownerId;
          claimed++;
        }
      }
      if (claimed) write(name, list);
      return claimed;
    },
    save(entry) {
      const list = this.all();
      const i = list.findIndex((x) => x.id === entry.id);
      if (i >= 0) list[i] = entry;
      else list.push(entry);
      write(name, list);
      return entry;
    },
    remove(id) {
      write(name, this.all().filter((x) => x.id !== id));
    },
  };
}

// ----------------------------------------------------------------------------
// Workflow storage mode — where saved workflows live:
//   "local"    (default) — ./data/workflows.json on this device
//   "database"           — the SQL `workflows` table (SQLite or PostgreSQL),
//                          each workflow gets an assigned `code` stored in the
//                          table so it can be found again on the server/cloud
//                          (GET /api/workflows/by-code/:code).
// Toggled from the admin panel → Cloud servers → "Workflow storage". The
// toggle migrates data so nothing is lost when switching direction.
// ----------------------------------------------------------------------------
const WORKFLOW_STORAGE_KEY = "storage.workflows";
const WORKFLOWS_FILE = "workflows.json";

export async function workflowStorageMode() {
  try {
    return (await db.storeGet(WORKFLOW_STORAGE_KEY)) === "database" ? "database" : "local";
  } catch {
    return "local";
  }
}

// Switch where workflows are stored. Migrates existing data first so toggling
// never loses workflows: local → database copies the JSON file into the SQL
// table (assigning each workflow its code); database → local copies the table
// back into the JSON file (preserving assigned codes).
export async function setWorkflowStorageMode(mode) {
  const next = mode === "database" ? "database" : "local";
  if ((await workflowStorageMode()) !== next) {
    if (next === "database") await migrateLocalWorkflowsToDb();
    else await migrateDbWorkflowsToLocal();
  }
  await db.storeSet(WORKFLOW_STORAGE_KEY, next);
  return next;
}

// Number of workflows currently in the local JSON file / SQL table (used by
// the admin panel to show what lives where before toggling).
export function countLocalWorkflows() {
  return read(WORKFLOWS_FILE, []).length;
}

export async function countDbWorkflows() {
  return Number(await db.workflowsCount());
}

// Copy every workflow from the local JSON file into the SQL workflows table.
// The table assigns each entry its code on first insert (re-saving keeps it).
export async function migrateLocalWorkflowsToDb() {
  let moved = 0;
  for (const wf of read(WORKFLOWS_FILE, [])) {
    await db.workflowsSave(wf);
    moved++;
  }
  return moved;
}

// Copy every workflow from the SQL workflows table back into the local JSON
// file, upserting by id and preserving any assigned codes.
export async function migrateDbWorkflowsToLocal() {
  const byId = new Map(read(WORKFLOWS_FILE, []).map((x) => [x.id, x]));
  let moved = 0;
  for (const wf of await db.workflowsAll()) {
    byId.set(wf.id, { ...(byId.get(wf.id) || {}), ...wf });
    moved++;
  }
  write(WORKFLOWS_FILE, [...byId.values()]);
  return moved;
}

// Workflows facade — same interface as before, but reads/writes either the
// local JSON file or the SQL workflows table depending on the storage mode.
// Every method is async (the SQLite backend is synchronous under the hood, so
// awaiting is a no-op there; PostgreSQL is truly async).
export const workflows = {
  async all() {
    if ((await workflowStorageMode()) === "database") return db.workflowsAll();
    return read(WORKFLOWS_FILE, []);
  },
  async get(id) {
    if ((await workflowStorageMode()) === "database") return db.workflowsGet(id);
    return read(WORKFLOWS_FILE, []).find((x) => x.id === id) || null;
  },
  async listOwned(ownerId) {
    if ((await workflowStorageMode()) === "database") return db.workflowsListByOwner(ownerId);
    return read(WORKFLOWS_FILE, []).filter((x) => x.ownerId === ownerId);
  },
  // Workflows another account shared with this user (collaboration). The
  // owner keeps the record; the collaborator sees the same workflow in their
  // list and every save updates the single shared copy.
  async listSharedWith(userId) {
    const list = await this.all();
    return list.filter(
      (x) =>
        String(x.ownerId) !== String(userId) &&
        Array.isArray(x.collaborators) &&
        x.collaborators.some((c) => String(c?.userId) === String(userId))
    );
  },
  async getOwned(id, ownerId) {
    const x = await this.get(id);
    return x && x.ownerId === ownerId ? x : null;
  },
  async removeOwned(id, ownerId) {
    if ((await workflowStorageMode()) === "database") return db.workflowsRemoveByOwner(id, ownerId);
    const x = await this.get(id);
    if (x && x.ownerId === ownerId) {
      await this.remove(id);
      return true;
    }
    return false;
  },
  // Adopt any entries saved before ownership existed (no ownerId yet) — used
  // when an account registers or logs in, so pre-ownership data is not lost.
  async claimUnowned(ownerId) {
    if ((await workflowStorageMode()) === "database") {
      let claimed = 0;
      for (const wf of await db.workflowsAll()) {
        if (!wf.ownerId) {
          await db.workflowsSave({ ...wf, ownerId });
          claimed++;
        }
      }
      return claimed;
    }
    const list = read(WORKFLOWS_FILE, []);
    let claimed = 0;
    for (const x of list) {
      if (!x.ownerId) {
        x.ownerId = ownerId;
        claimed++;
      }
    }
    if (claimed) write(WORKFLOWS_FILE, list);
    return claimed;
  },
  async save(entry) {
    if ((await workflowStorageMode()) === "database") return db.workflowsSave(entry);
    const list = read(WORKFLOWS_FILE, []);
    const i = list.findIndex((x) => x.id === entry.id);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    write(WORKFLOWS_FILE, list);
    return entry;
  },
  async remove(id) {
    if ((await workflowStorageMode()) === "database") return db.workflowsRemove(id);
    write(WORKFLOWS_FILE, read(WORKFLOWS_FILE, []).filter((x) => x.id !== id));
  },
  // Look a workflow up by its assigned code (stored in the SQL table). The
  // lookup is owner-scoped: only the owning account can retrieve it by code.
  async getByCode(code, ownerId) {
    const norm = String(code || "").trim().toUpperCase();
    if (!norm) return null;
    const fromDb = await db.workflowsGetByCode(norm);
    if (fromDb && fromDb.ownerId === ownerId) return fromDb;
    // codes survive a database → local migration, so also scan the file
    const local = read(WORKFLOWS_FILE, []).find(
      (x) => String(x.code || "").trim().toUpperCase() === norm
    );
    return local && local.ownerId === ownerId ? local : null;
  },
};

export const agents = makeCrud("agents.json", []);

// ----------------------------------------------------------------------------
// Community — workflows users chose to publish for everyone on the instance to
// browse, search and import. Public-facing fields (title, description, owner)
// plus the workflow's nodes/edges (secrets scrubbed at publish time).
// ----------------------------------------------------------------------------
export const community = makeCrud("community.json", []);

// Config keys that hold credentials — scrubbed (emptied) when a workflow is
// published to the community so API keys / passwords never leak with a post.
// The same list drives the workflow-secrets store: these fields are lifted out
// of the saved workflow JSON into the (encrypted) workflow_secrets table, and
// re-injected when the owner opens or runs the workflow.
export const SECRET_FIELD_NAMES = new Set([
  "apiKey",
  "appPassword",
  "token",
  "authToken",
  "authPass",
  "secret",
  "botToken",
  "accountSid",
  "routingKey",
  "accessToken",
  "apiToken",
  "anonKey",
  "password",
  "passphrase",
  "privateKey",
  "oauthToken",
  "clientSecret",
  "refreshToken",
  "webhookUrl",
  // GitHub / Stripe trigger signing secrets — whoever holds one can forge
  // deliveries that run the workflow
  "webhookSecret",
  // the picked connected account (shared/oauth.js) — only an id, but it points
  // at the owner's mailbox, so it must not travel with a shared template
  "oauthAccount",
  // the picked connected Telegram bot (server/telegram-bots.js)
  "telegramBot",
  // the picked connected Telegram account (server/telegram-accounts.js)
  "telegramAccount",
]);

// ----------------------------------------------------------------------------
// Workflow secrets — credentials entered on nodes (AI Agent inline model key,
// HTTP auth, Slack / Telegram tokens, …) are stored in the encrypted
// workflow_secrets table instead of inside the workflow JSON, so exported
// files and community posts can never leak them. The helpers below collect the
// secrets out of a workflow's node configs, blank them for disk storage, and
// re-inject them when the owner opens / runs the workflow.
// ----------------------------------------------------------------------------

// Walk any object and collect every secret field (recursively, including nested
// objects and key-value rows) that holds a non-empty string. `id` is attached
// to each hit so callers know which entity it belongs to; `field` is the
// dot/index path used to re-inject the value later, e.g. "apiKey" or
// "auth.token" or "headers.0.value".
function collectSecretsFromObject(obj, id, path = "") {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const keyPath = path ? `${path}.${k}` : k;
    if (SECRET_FIELD_NAMES.has(k)) {
      if (typeof v === "string" && v.trim() !== "") out.push({ id, field: keyPath, value: v });
      continue;
    }
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        v.forEach((item, i) => {
          if (item && typeof item === "object" && !Array.isArray(item)) out.push(...collectSecretsFromObject(item, id, `${keyPath}.${i}`));
        });
      } else {
        out.push(...collectSecretsFromObject(v, id, keyPath));
      }
    }
  }
  return out;
}

// Collect every credential in a workflow's node configs.
export function collectSecrets(wf) {
  const out = [];
  for (const node of wf.nodes || []) {
    for (const s of collectSecretsFromObject(node.data?.config || {}, node.id)) {
      out.push({ nodeId: s.id, field: s.field, value: s.value });
    }
  }
  return out;
}

// Every secret FIELD PATH present in a workflow's node configs, whatever its
// value (including blanked ""). Used when saving to tell "this field is still
// here but came back blank" (keep the stored secret) from "this field is gone"
// (drop it) — so a save from someone who was never shown the secret, or who
// left it blank, does not wipe the owner's stored credential.
export function secretFieldPaths(wf) {
  const walk = (obj, nodeId, base, out) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const keyPath = base ? `${base}.${k}` : k;
      if (SECRET_FIELD_NAMES.has(k)) {
        if (typeof v === "string") out.push({ nodeId, field: keyPath });
        continue;
      }
      if (Array.isArray(v)) {
        v.forEach((item, i) => walk(item, nodeId, `${keyPath}.${i}`, out));
      } else if (v && typeof v === "object") {
        walk(v, nodeId, keyPath, out);
      }
    }
  };
  const out = [];
  for (const node of wf.nodes || []) walk(node.data?.config || {}, node.id, "", out);
  return out;
}

// Collect every credential stored on a saved agent (model API key).
export function collectAgentSecrets(agent) {
  return collectSecretsFromObject(agent || {}, agent?.id || "").map((s) => ({ field: s.field, value: s.value }));
}

function getByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

// Deep-copy a workflow with every collected secret blanked (""), leaving the
// config structure intact so the values can be re-injected later.
export function blankSecretsInWorkflow(wf) {
  const copy = JSON.parse(JSON.stringify(wf));
  const secrets = collectSecrets(copy);
  for (const s of secrets) {
    const node = (copy.nodes || []).find((n) => n.id === s.nodeId);
    if (node) setByPath(node.data?.config || {}, s.field, "");
  }
  return copy;
}

// Deep-copy a workflow and re-inject stored secrets into the matching node
// configs. Missing nodes/paths are skipped (they were removed after the secrets
// were saved — the next save drops those rows).
export function hydrateSecretsInWorkflow(wf, secrets) {
  const copy = JSON.parse(JSON.stringify(wf));
  for (const s of secrets || []) {
    const node = (copy.nodes || []).find((n) => n.id === s.nodeId);
    if (node && getByPath(node.data?.config || {}, s.field) !== undefined) {
      setByPath(node.data?.config || {}, s.field, s.value);
    }
  }
  return copy;
}

// Deep-copy a saved agent with its credentials blanked ("").
export function blankAgentSecrets(agent) {
  const copy = JSON.parse(JSON.stringify(agent || {}));
  for (const s of collectAgentSecrets(copy)) {
    if (getByPath(copy, s.field) !== undefined) setByPath(copy, s.field, "");
  }
  return copy;
}

// Deep-copy a saved agent and re-inject its stored credentials.
export function hydrateAgentSecrets(agent, secrets) {
  const copy = JSON.parse(JSON.stringify(agent || {}));
  for (const s of secrets || []) {
    if (getByPath(copy, s.field) !== undefined) setByPath(copy, s.field, s.value);
  }
  return copy;
}

// Startup migration: move any credentials still sitting in saved workflow JSON
// (from before the secrets store existed, or a field newly added to
// SECRET_FIELD_NAMES) into the encrypted workflow_secrets table and blank them
// in the file. The rows already stored are kept: the JSON holds only the newly
// found secrets, so replacing would wipe every other credential of the
// workflow. Returns the number of secrets moved.
export async function migrateWorkflowSecretsToDb() {
  let moved = 0;
  for (const wf of await workflows.all()) {
    const secrets = collectSecrets(wf);
    if (!secrets.length) continue;
    const found = new Set(secrets.map((s) => `${s.nodeId}::${s.field}`));
    const kept = (await db.getWorkflowSecrets(wf.id)).filter((s) => !found.has(`${s.nodeId}::${s.field}`));
    await db.replaceWorkflowSecrets(wf.id, wf.ownerId, [...kept, ...secrets]);
    await workflows.save(blankSecretsInWorkflow(wf));
    moved += secrets.length;
  }
  return moved;
}

// One-time migration: move saved-agent credentials (model API keys) sitting in
// agents.json into the encrypted agent_secrets table and blank them there.
export async function migrateAgentSecretsToDb() {
  let moved = 0;
  for (const agent of agents.all()) {
    const secrets = collectAgentSecrets(agent);
    if (!secrets.length) continue;
    await db.replaceAgentSecrets(agent.id, agent.ownerId, secrets);
    agents.save(blankAgentSecrets(agent));
    moved += secrets.length;
  }
  return moved;
}

// Remove every credential field from a workflow's node configs (recursively,
// including inside key-value rows and nested objects), so publishing a workflow
// never shares API keys, app passwords or webhook secrets with the community.
export function stripSecretsFromWorkflow(wf) {
  const scrub = (obj, out) => {
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_FIELD_NAMES.has(k)) {
        out[k] = "";
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = {};
        scrub(v, out[k]);
      } else if (Array.isArray(v)) {
        out[k] = v.map((item) => {
          if (item && typeof item === "object") {
            const o = {};
            scrub(item, o);
            return o;
          }
          return item;
        });
      } else {
        out[k] = v;
      }
    }
  };
  const nodes = (wf.nodes || []).map((n) => {
    const config = {};
    scrub(n.data?.config || {}, config);
    return { ...n, data: { ...(n.data || {}), config } };
  });
  return { ...wf, nodes };
}

// ----------------------------------------------------------------------------
// Vector memory — a tiny self-hosted store for text embeddings.
// Persisted to ./data/vectors.json. Entries are keyed by (namespace, key)
// so the Vector Store — Save node can upsert (re-save replaces the old vector).
// ----------------------------------------------------------------------------
const VECTORS_FILE = "vectors.json";

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const vectors = {
  all() {
    return read(VECTORS_FILE, []);
  },
  get(namespace, key) {
    return this.all().find((v) => v.namespace === namespace && v.key === key) || null;
  },
  // Insert or replace the vector for (namespace, key).
  upsert({ namespace, key, vector, text, meta }) {
    const list = this.all();
    const i = list.findIndex((v) => v.namespace === namespace && v.key === key);
    const entry = { namespace, key, vector, text: text ?? "", meta: meta ?? {}, dimensions: Array.isArray(vector) ? vector.length : 0, updatedAt: new Date().toISOString() };
    if (i >= 0) list[i] = entry;
    else list.push(entry);
    write(VECTORS_FILE, list);
    return entry;
  },
  remove(namespace, key) {
    write(VECTORS_FILE, this.all().filter((v) => !(v.namespace === namespace && v.key === key)));
  },
};

// Return the top K most similar entries in a namespace, cosine-similarity.
export function searchVectors(namespace, vector, k = 5) {
  const list = vectors.all().filter((v) => v.namespace === namespace && Array.isArray(v.vector));
  const scored = list
    .map((v) => ({ key: v.key, text: v.text, meta: v.meta, score: cosine(vector, v.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.filter((s) => s.score > 0);
}

// ----------------------------------------------------------------------------
// Data store — a tiny key-value store (n8n / Make Data Store style).
// Persisted to ./data/datastore.json as { namespace: { key: value } }.
// ----------------------------------------------------------------------------
const DATASTORE_FILE = "datastore.json";

export const datastore = {
  all() {
    return read(DATASTORE_FILE, {});
  },
  get(namespace, key) {
    const ns = this.all()[namespace];
    return ns && Object.prototype.hasOwnProperty.call(ns, key) ? ns[key] : null;
  },
  set(namespace, key, value) {
    const all = this.all();
    if (!all[namespace] || typeof all[namespace] !== "object") all[namespace] = {};
    all[namespace][key] = value;
    write(DATASTORE_FILE, all);
    return value;
  },
  remove(namespace, key) {
    const all = this.all();
    if (all[namespace] && typeof all[namespace] === "object") {
      delete all[namespace][key];
      write(DATASTORE_FILE, all);
    }
  },
  list(namespace) {
    const ns = this.all()[namespace] || {};
    return Object.entries(ns).map(([key, value]) => ({ key, value }));
  },
};

// ----------------------------------------------------------------------------
// Boot — new installs (and new accounts) start with a clean, empty workspace:
// no demo workflows or agents are created. Anyone who wants an example uses the
// user guide (Settings → Download PDF / docs/guide.md), which has step-by-step
// example workflows to build or import.
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// Workflow versions — an undo history for a workflow.
//
// Every save that actually changes the graph first snapshots the state the
// workflow is LEAVING, so "Versions" lists what the workflow used to be and any
// entry can be restored. That makes an accidental rewrite — by hand, or by the
// AI builder agent — fully reversible. Snapshots are owner-scoped, pruned to
// MAX_WORKFLOW_VERSIONS per workflow and stored without credentials (the
// workflow is saved with its secrets blanked, and the snapshot is stripped
// again for good measure).
// ----------------------------------------------------------------------------
const WORKFLOW_VERSIONS_FILE = "workflow-versions.json";
export const MAX_WORKFLOW_VERSIONS = 20;

function versionSummary(v) {
  const { nodes, edges, ...meta } = v;
  return {
    ...meta,
    nodeCount: (nodes || []).length,
    edgeCount: (edges || []).length,
  };
}

export const workflowVersions = {
  all() {
    return read(WORKFLOW_VERSIONS_FILE, []);
  },

  /** Versions of one workflow, newest first (summaries only — no graph). */
  list(workflowId, limit = MAX_WORKFLOW_VERSIONS) {
    return this.all()
      .filter((v) => v.workflowId === workflowId)
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
      .slice(0, Math.max(1, limit))
      .map(versionSummary);
  },

  /** One full snapshot (with nodes + edges). */
  get(workflowId, versionId) {
    return this.all().find((v) => v.workflowId === workflowId && v.id === versionId) || null;
  },

  /**
   * Snapshot a workflow state. Returns the stored version, or null when this
   * exact graph is already kept — saves that only rename or re-describe a
   * workflow must not fill the history, and neither must a save made right
   * after a restore (the restored state is already one of the snapshots).
   */
  add(workflow, { reason = "manual" } = {}) {
    if (!workflow?.id) return null;
    const all = this.all();
    const graph = JSON.stringify({ nodes: workflow.nodes || [], edges: workflow.edges || [] });
    const alreadyStored = all
      .filter((v) => v.workflowId === workflow.id)
      .some((v) => JSON.stringify({ nodes: v.nodes || [], edges: v.edges || [] }) === graph);
    if (alreadyStored) return null;

    const clean = stripSecretsFromWorkflow(workflow);
    const version = {
      id: `v-${randomUUID().slice(0, 8)}`,
      workflowId: workflow.id,
      ownerId: workflow.ownerId || "",
      savedAt: new Date().toISOString(),
      reason,
      name: clean.name || "",
      description: clean.description || "",
      webhookSlug: clean.webhookSlug || "",
      nodes: clean.nodes || [],
      edges: clean.edges || [],
    };

    // Keep this workflow's newest MAX_WORKFLOW_VERSIONS snapshots (the new one
    // first) and leave every other workflow's history untouched.
    const mine = [version, ...all.filter((v) => v.workflowId === workflow.id)].slice(0, MAX_WORKFLOW_VERSIONS);
    const others = all.filter((v) => v.workflowId !== workflow.id);
    write(WORKFLOW_VERSIONS_FILE, [...mine, ...others]);
    return version;
  },

  /** Forget a workflow's history (used when the workflow is deleted). */
  removeByWorkflow(workflowId) {
    const all = this.all();
    const kept = all.filter((v) => v.workflowId !== workflowId);
    if (kept.length !== all.length) write(WORKFLOW_VERSIONS_FILE, kept);
    return all.length - kept.length;
  },
};

// ----------------------------------------------------------------------------
// Workflow backups — a rolling buffer of recently SAVED states.
//
// The version history above is a coarse undo list (20 entries, owner-only, only
// on a graph change). A SHARED workflow needs something finer: two people write
// the same record, so someone who stepped away must be able to rewind to the
// state ~1 minute ago, to any of the last saves, or to the last save THEY made.
// Every successful save therefore appends the state it wrote here, tagged with
// the account that pressed save, and the newest MAX_WORKFLOW_BACKUPS entries per
// workflow are kept. Credentials never end up in a backup (the stored copy is
// stripped, and the snapshot is stripped again for good measure).
// ----------------------------------------------------------------------------
const WORKFLOW_BACKUPS_FILE = "workflow-backups.json";
export const MAX_WORKFLOW_BACKUPS = 50;

function backupSummary(b) {
  const { nodes, edges, ...meta } = b;
  return {
    ...meta,
    nodeCount: (nodes || []).length,
    edgeCount: (edges || []).length,
  };
}

export const workflowBackups = {
  all() {
    return read(WORKFLOW_BACKUPS_FILE, []);
  },

  /** Saved states of one workflow, newest first (summaries — no graph). */
  list(workflowId, limit = MAX_WORKFLOW_BACKUPS) {
    return this.all()
      .filter((b) => b.workflowId === workflowId)
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
      .slice(0, Math.max(1, limit))
      .map(backupSummary);
  },

  /** One full backup (with nodes + edges). */
  get(workflowId, backupId) {
    return this.all().find((b) => b.workflowId === workflowId && b.id === backupId) || null;
  },

  /**
   * Keep the state a workflow was just saved as. `userId` is whoever caused the
   * save (autosave or a manual Save click), so "the last save I made" can be
   * found again later even after a collaborator saved ten times. Consecutive
   * identical states are not stored twice.
   */
  add(workflow, { userId = "", userName = "", reason = "save" } = {}) {
    if (!workflow?.id) return null;
    const all = this.all();
    const graph = JSON.stringify({ nodes: workflow.nodes || [], edges: workflow.edges || [] });
    const newest = all
      .filter((b) => b.workflowId === workflow.id)
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))[0];
    if (newest && JSON.stringify({ nodes: newest.nodes || [], edges: newest.edges || [] }) === graph) return null;

    const clean = stripSecretsFromWorkflow(workflow);
    const backup = {
      id: `b-${randomUUID().slice(0, 8)}`,
      workflowId: workflow.id,
      ownerId: workflow.ownerId || "",
      savedAt: new Date().toISOString(),
      userId: String(userId || ""),
      userName: String(userName || ""),
      reason,
      name: clean.name || "",
      description: clean.description || "",
      webhookSlug: clean.webhookSlug || "",
      nodes: clean.nodes || [],
      edges: clean.edges || [],
    };

    // Newest MAX_WORKFLOW_BACKUPS of THIS workflow; every other workflow's
    // buffer is left untouched.
    const mine = [backup, ...all.filter((b) => b.workflowId === workflow.id)]
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
      .slice(0, MAX_WORKFLOW_BACKUPS);
    const others = all.filter((b) => b.workflowId !== workflow.id);
    write(WORKFLOW_BACKUPS_FILE, [...mine, ...others]);
    return backup;
  },

  /**
   * The newest saved state that is at least `ageMs` old — the "rewind one
   * minute" target. When every kept state is younger than that, the OLDEST one
   * is returned (the furthest back we can go is still the honest answer); null
   * when there is nothing to rewind to.
   */
  rewindPoint(workflowId, ageMs = 60_000, now = Date.now()) {
    const all = this.all()
      .filter((b) => b.workflowId === workflowId)
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    if (!all.length) return null;
    const old = all.find((b) => now - Date.parse(b.savedAt) >= ageMs);
    if (old) return old;
    return all.length > 1 ? all[all.length - 1] : null;
  },

  /** Forget a workflow's backups (used when the workflow is deleted). */
  removeByWorkflow(workflowId) {
    const all = this.all();
    const kept = all.filter((b) => b.workflowId !== workflowId);
    if (kept.length !== all.length) write(WORKFLOW_BACKUPS_FILE, kept);
    return all.length - kept.length;
  },
};

export function seed() {
  ensureDir();
}

// ----------------------------------------------------------------------------
// Workflow assignment registry — keep the SQL users.workflow_ids column in sync
// with the actual JSON workflows file. Called on boot (migrates existing data)
// and after login/register, so the database always lists the workflows assigned
// to each account. Pass a userId to sync just that account.
// ----------------------------------------------------------------------------
export async function syncUserWorkflowAssignments(userId) {
  const users = userId ? [{ id: userId }] : await db.listUsers();
  for (const u of users) {
    await db.setUserWorkflows(u.id, (await workflows.listOwned(u.id)).map((w) => w.id));
  }
}
