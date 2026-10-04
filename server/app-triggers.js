// ============================================================================
// W FLOW — polling app triggers (e-mail and Google Sheets)
//
// Triggers the scheduler (server/scheduler.js) polls on their interval, like
// RSS and the crypto triggers:
//
//   imap          — new e-mail in any IMAP mailbox,
//   gmail         — new Gmail e-mail, read over IMAP with an app password,
//   sheetsTrigger — new rows added to a Google Sheets tab.
//
// Gmail is read over IMAP on purpose: reading mail through the Gmail API needs
// Google's "restricted" scopes (a yearly paid security assessment), which the
// cloud's OAuth client is not verified for (shared/oauth.js). An app password
// works on the cloud and on every self-hosted copy alike.
//
// Each poll compares against a cursor (the last IMAP UID / the last row
// count). The first poll after a start only records the cursor, so a restart
// never fires for mail or rows that arrived while the server was down. State
// is in memory; the readers are injectable so tests run offline.
// ============================================================================
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export const APP_TRIGGER_TYPES = new Set(["imap", "gmail", "sheetsTrigger"]);

// How many new messages / rows one fire carries at most.
const MAX_PER_FIRE = 20;

const state = new Map(); // "wfId::nodeId" → { nextPoll, cursor }

export function appTriggerNodes(wf) {
  return (wf.nodes || []).filter((n) => APP_TRIGGER_TYPES.has(n.type) && appTriggerConfigured(n.type, n.data?.config || {}));
}

// A trigger polls only once it can: a half-filled node on a draft canvas
// must not hammer a mail server with failing logins every few minutes. The
// stored workflow has its secrets stripped, so only the visible fields count.
export function appTriggerConfigured(type, c) {
  if (type === "imap") return !!String(c.host || "").trim() && !!String(c.user || "").trim();
  if (type === "gmail") return !!String(c.user || "").trim();
  if (type === "sheetsTrigger") return !!String(c.spreadsheetId || "").trim();
  return false;
}

export function pollIntervalMs(config) {
  const minutes = Number(config?.pollInterval) > 0 ? Number(config.pollInterval) : 5;
  return Math.max(60_000, minutes * 60_000);
}

// ---- e-mail ----

function mailServer(type, c) {
  if (type === "gmail") return { host: "imap.gmail.com", port: 993, secure: true };
  return { host: String(c.host || "").trim(), port: Number(c.port) || 993, secure: c.secure !== false };
}

const lower = (s) => String(s ?? "").trim().toLowerCase();

/** Whether a parsed message passes the node's From / Subject filters. */
export function mailMatches(c, msg) {
  const from = lower(c.filterFrom);
  const subject = lower(c.filterSubject);
  if (from && !lower(msg.from).includes(from)) return false;
  if (subject && !lower(msg.subject).includes(subject)) return false;
  return true;
}

function messageJson(parsed, uid) {
  return {
    id: parsed.messageId || String(uid),
    uid,
    from: parsed.from?.text || "",
    fromAddress: parsed.from?.value?.[0]?.address || "",
    to: parsed.to?.text || "",
    subject: parsed.subject || "",
    text: parsed.text || "",
    html: typeof parsed.html === "string" ? parsed.html : "",
    date: (parsed.date instanceof Date ? parsed.date : new Date()).toISOString(),
    attachments: (parsed.attachments || []).map((a) => ({ fileName: a.filename || "", mimeType: a.contentType || "", size: a.size || 0 })),
  };
}

/**
 * Read the mailbox. Without a cursor, returns only the cursor (baseline).
 * The cursor is { uidValidity, lastUid }; a changed uidValidity means the
 * server renumbered the folder, so it re-baselines instead of firing for all.
 */
export async function readMail(type, c, cursor, { assertUrl = async () => {} } = {}) {
  const server = mailServer(type, c);
  // a user-typed mail host must not reach the server's own network (SSRF)
  await assertUrl(`https://${server.host}`);
  const user = String(c.user || "").trim();
  const pass = String(c.appPassword || "").replace(/\s+/g, "");
  if (!pass) throw new Error("no app password saved");
  const client = new ImapFlow({ ...server, auth: { user, pass }, logger: false, socketTimeout: 60_000 });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(String(c.folder || "INBOX"));
    try {
      const box = client.mailbox;
      const uidValidity = String(box.uidValidity ?? "");
      const top = Number(box.uidNext || 1) - 1;
      if (!cursor || cursor.uidValidity !== uidValidity) return { cursor: { uidValidity, lastUid: top }, messages: [] };
      if (top <= cursor.lastUid) return { cursor, messages: [] };
      const messages = [];
      let lastUid = cursor.lastUid;
      for await (const m of client.fetch(`${cursor.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        // "n:*" also returns the newest message when n is past the end
        if (m.uid <= cursor.lastUid) continue;
        lastUid = Math.max(lastUid, m.uid);
        messages.push(messageJson(await simpleParser(m.source), m.uid));
      }
      return { cursor: { uidValidity, lastUid }, messages };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---- Google Sheets ----

function sheetsUrl(c) {
  const name = String(c.sheetName ?? "").trim();
  const range = name ? `'${name.replace(/'/g, "''")}'!A:Z` : "A:Z";
  const key = !c.token && c.apiKey ? `?key=${encodeURIComponent(c.apiKey)}` : "";
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(String(c.spreadsheetId).trim())}/values/${encodeURIComponent(range)}${key}`;
}

export async function readSheetRows(c) {
  if (!c.token && !c.apiKey) throw new Error("no Google account connected and no API key saved");
  const res = await fetch(sheetsUrl(c), { headers: c.token ? { Authorization: `Bearer ${c.token}` } : {}, signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets answered HTTP ${res.status} ${data?.error?.message || ""}`.trim());
  return Array.isArray(data.values) ? data.values : [];
}

/**
 * Rows added since the last poll. Row 1 is the header row and names each
 * column of the emitted row objects. When rows were deleted the count drops;
 * that re-baselines rather than firing for rows that only moved up.
 */
export function newRows(values, cursor) {
  const count = values.length;
  if (cursor === undefined || count <= cursor) return { cursor: count, rows: [], headers: values[0] || [] };
  const headers = (values[0] || []).map((h, i) => String(h || "").trim() || `column${i + 1}`);
  const fresh = values.slice(Math.max(cursor, 1)).slice(0, MAX_PER_FIRE);
  const rows = fresh.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { cursor: count, rows, values: fresh, headers, firstRow: Math.max(cursor, 1) + 1 };
}

// ---- polling ----

export const READERS = { mail: readMail, sheet: readSheetRows };

/**
 * One poll of one trigger node. `loadConfig()` returns the node's config with
 * its secrets and connected account filled in (the stored workflow has them
 * stripped). Calls `fire(payload)` when something new arrived.
 * Returns "baseline" | "fired" | "quiet" | "skipped" (not due yet).
 */
export async function pollAppTrigger(stored, node, now, fire, { loadConfig, assertUrl, readers = READERS } = {}) {
  const key = `${stored.id}::${node.id}`;
  const visible = node.data?.config || {};
  const s = state.get(key);
  if (s && now < s.nextPoll) return "skipped";
  // Advance first: a failing poll (wrong password, network) is never retried
  // in a tight loop.
  state.set(key, { ...(s || {}), nextPoll: now + pollIntervalMs(visible) });
  const c = loadConfig ? await loadConfig() : visible;
  const baseline = !s || s.cursor === undefined;

  if (node.type === "sheetsTrigger") {
    const values = await readers.sheet(c);
    const r = newRows(values, baseline ? undefined : s.cursor);
    state.set(key, { ...state.get(key), cursor: r.cursor });
    if (baseline) return "baseline";
    if (!r.rows.length) return "quiet";
    await fire({
      triggeredAt: new Date(now).toISOString(),
      spreadsheetId: String(c.spreadsheetId || "").trim(),
      sheetName: String(c.sheetName || "").trim(),
      headers: r.headers,
      firstRow: r.firstRow,
      rows: r.rows,
      values: r.values,
      count: r.rows.length,
    });
    return "fired";
  }

  const r = await readers.mail(node.type, c, baseline ? undefined : s.cursor, { assertUrl });
  state.set(key, { ...state.get(key), cursor: r.cursor });
  if (baseline) return "baseline";
  const messages = r.messages.filter((m) => mailMatches(c, m)).slice(0, MAX_PER_FIRE);
  if (!messages.length) return "quiet";
  await fire({
    triggeredAt: new Date(now).toISOString(),
    mailbox: node.type === "gmail" ? String(c.user || "").trim() : String(c.host || "").trim(),
    folder: String(c.folder || "INBOX"),
    messages,
    count: messages.length,
  });
  return "fired";
}

export function resetAppTriggerState() {
  state.clear();
}
