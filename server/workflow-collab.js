// ============================================================================
// W FLOW — working on a workflow together: node comments and change history
//
// Comments are pinned to a node (or to the workflow as a whole). Anyone with
// access — viewers included — can comment; replies form a thread; a thread can
// be resolved. @mentions are picked from the people who can open the
// workflow: they are stored as user ids (never parsed out of the text) and the
// mentioned people get an e-mail when the instance can send mail.
//
// The change history answers "who changed what": every save that changes the
// graph appends an entry with the author and, per changed node, the node as it
// was before and after. That is what "restore this node" puts back — one node,
// without rolling the rest of the workflow back. Saves by the same person
// within a few minutes fold into one entry (auto-save writes every few
// seconds), keeping the earliest "before" and the latest "after".
//
// Both live in the key-value store per workflow, capped, credentials stripped.
// ============================================================================
import { randomUUID } from "node:crypto";
import { db } from "./dbx.js";
import { stripSecretsFromWorkflow } from "./store.js";
import { sendMail, mailConfigured } from "./mail.js";

const commentsKey = (wfId) => `wf.comments.${wfId}`;
const historyKey = (wfId) => `wf.history.${wfId}`;
const MAX_COMMENTS = 500;
const MAX_HISTORY = 100;
const MAX_TEXT = 4000;
const FOLD_MS = 5 * 60_000;

async function readList(key) {
  try {
    const parsed = JSON.parse((await db.storeGet(key)) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
const writeList = (key, list) => db.storeSet(key, JSON.stringify(list));

// ---- change history ----
const nodeJson = (n) => JSON.stringify({ type: n.type, position: n.position, data: n.data });
const nodeLabel = (n) => n?.data?.label || n?.type || n?.id;

/** Node-level differences between two versions of a workflow. */
export function graphChanges(before, after) {
  const clean = (wf) => stripSecretsFromWorkflow({ nodes: wf?.nodes || [], edges: wf?.edges || [] });
  const b = clean(before);
  const a = clean(after);
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const nodes = [];
  for (const [id, n] of aNodes) {
    const old = bNodes.get(id);
    if (!old) nodes.push({ nodeId: id, label: nodeLabel(n), kind: "added", before: null, after: n });
    else if (nodeJson(old) !== nodeJson(n)) {
      // Moving a node around is noise in "who changed what".
      const moved = JSON.stringify({ ...old, position: null }) === JSON.stringify({ ...n, position: null });
      if (moved) continue;
      const fields = [...new Set([...Object.keys(old.data?.config || {}), ...Object.keys(n.data?.config || {})])].filter(
        (k) => JSON.stringify(old.data?.config?.[k]) !== JSON.stringify(n.data?.config?.[k])
      );
      if (old.data?.label !== n.data?.label) fields.unshift("label");
      if (old.type !== n.type) fields.unshift("type");
      nodes.push({ nodeId: id, label: nodeLabel(n), kind: "changed", fields, before: old, after: n });
    }
  }
  for (const [id, n] of bNodes) if (!aNodes.has(id)) nodes.push({ nodeId: id, label: nodeLabel(n), kind: "removed", before: n, after: null });
  const edgeKey = (e) => `${e.source}|${e.sourceHandle || "out"}|${e.target}`;
  const bEdges = new Set(b.edges.map(edgeKey));
  const aEdges = new Set(a.edges.map(edgeKey));
  const edges = { added: [...aEdges].filter((k) => !bEdges.has(k)).length, removed: [...bEdges].filter((k) => !aEdges.has(k)).length };
  return { nodes, edges };
}

/** Append (or fold into the last) history entry for a save. */
export async function recordChange(before, after, author) {
  if (!after?.id) return null;
  const { nodes, edges } = graphChanges(before, after);
  const renamed = (before?.name || "") !== (after?.name || "");
  if (!nodes.length && !edges.added && !edges.removed && !renamed) return null;
  const list = await readList(historyKey(after.id));
  const now = new Date().toISOString();
  const last = list[list.length - 1];
  if (last && last.userId === author.userId && Date.now() - Date.parse(last.at) < FOLD_MS) {
    // Same person, a moment later: one entry, earliest "before", latest "after".
    for (const change of nodes) {
      const prev = last.nodes.find((n) => n.nodeId === change.nodeId);
      if (!prev) last.nodes.push(change);
      else {
        prev.after = change.after;
        prev.label = change.label;
        prev.fields = [...new Set([...(prev.fields || []), ...(change.fields || [])])];
        if (prev.kind === "added" && !change.after) prev.remove = true; // added then removed again
        else if (prev.kind === "removed" && change.after) prev.kind = "changed";
      }
    }
    last.nodes = last.nodes.filter((n) => !n.remove);
    last.edges = { added: last.edges.added + edges.added, removed: last.edges.removed + edges.removed };
    if (renamed) last.renamed = { from: last.renamed?.from ?? before?.name, to: after.name };
    last.at = now;
    await writeList(historyKey(after.id), list);
    return last;
  }
  const entry = {
    id: randomUUID().slice(0, 12),
    at: now,
    userId: String(author.userId),
    author: author.name || author.email || "someone",
    nodes,
    edges,
    ...(renamed ? { renamed: { from: before?.name || "", to: after.name } } : {}),
  };
  await writeList(historyKey(after.id), [...list, entry].slice(-MAX_HISTORY));
  return entry;
}

export async function listHistory(workflowId) {
  return (await readList(historyKey(workflowId))).slice().reverse();
}

// ---- comments ----
function commentView(c) {
  return { id: c.id, nodeId: c.nodeId || null, parentId: c.parentId || null, userId: c.userId, author: c.author, text: c.text, mentions: c.mentions || [], createdAt: c.createdAt, editedAt: c.editedAt || null, resolved: !!c.resolved };
}

export async function listComments(workflowId) {
  return (await readList(commentsKey(workflowId))).map(commentView);
}

/**
 * Add a comment. `people` is who can open the workflow ([{ userId, name, email }]);
 * mentions outside it are dropped. Returns the comment.
 */
export async function addComment(workflow, author, { nodeId, parentId, text, mentions = [] }, { people = [], appUrl = "" } = {}) {
  const body = String(text || "").trim().slice(0, MAX_TEXT);
  if (!body) throw Object.assign(new Error("Write something first."), { status: 400 });
  const list = await readList(commentsKey(workflow.id));
  const parent = parentId ? list.find((c) => c.id === parentId) : null;
  if (parentId && !parent) throw Object.assign(new Error("The comment you reply to was deleted."), { status: 404 });
  const allowed = new Map(people.map((p) => [String(p.userId), p]));
  const mentioned = [...new Set((Array.isArray(mentions) ? mentions : []).map(String))].filter((id) => allowed.has(id) && id !== String(author.userId));
  const comment = {
    id: randomUUID().slice(0, 12),
    nodeId: parent ? parent.nodeId || null : nodeId ? String(nodeId) : null,
    parentId: parent ? parent.parentId || parent.id : null,
    userId: String(author.userId),
    author: author.name || author.email || "someone",
    text: body,
    mentions: mentioned,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
  await writeList(commentsKey(workflow.id), [...list, comment].slice(-MAX_COMMENTS));
  // Tell the mentioned people — best-effort, never fails the comment.
  if (mentioned.length) {
    notifyMentions(workflow, comment, mentioned.map((id) => allowed.get(id)), appUrl).catch(() => {});
  }
  return commentView(comment);
}

async function notifyMentions(workflow, comment, people, appUrl) {
  if (!(await mailConfigured())) return;
  const node = comment.nodeId ? (workflow.nodes || []).find((n) => n.id === comment.nodeId) : null;
  const where = node ? `on the step “${nodeLabel(node)}” of “${workflow.name}”` : `on “${workflow.name}”`;
  for (const p of people) {
    if (!p?.email) continue;
    await sendMail({
      to: p.email,
      subject: `${comment.author} mentioned you ${where}`,
      text: `${comment.author} mentioned you ${where}:\n\n${comment.text}\n\n${appUrl ? `Open it: ${appUrl}` : ""}`,
    });
  }
}

/** Edit text (author only) or resolve / reopen a thread (anyone who can edit, or the author). */
export async function updateComment(workflowId, commentId, actor, patch, { canModerate = false } = {}) {
  const list = await readList(commentsKey(workflowId));
  const c = list.find((x) => x.id === commentId);
  if (!c) throw Object.assign(new Error("Comment not found."), { status: 404 });
  const own = c.userId === String(actor.userId);
  if (patch.text !== undefined) {
    if (!own) throw Object.assign(new Error("Only the author can edit a comment."), { status: 403 });
    const text = String(patch.text || "").trim().slice(0, MAX_TEXT);
    if (!text) throw Object.assign(new Error("A comment cannot be empty."), { status: 400 });
    c.text = text;
    c.editedAt = new Date().toISOString();
  }
  if (patch.resolved !== undefined) {
    if (!own && !canModerate) throw Object.assign(new Error("Only the author or an editor can resolve a thread."), { status: 403 });
    // Resolving works on the thread: the first comment carries the flag.
    const root = c.parentId ? list.find((x) => x.id === c.parentId) || c : c;
    root.resolved = !!patch.resolved;
  }
  await writeList(commentsKey(workflowId), list);
  return commentView(c);
}

/** Delete a comment (author, or the workflow's owner); a thread's replies go with it. */
export async function deleteComment(workflowId, commentId, actor, { isOwner = false } = {}) {
  const list = await readList(commentsKey(workflowId));
  const c = list.find((x) => x.id === commentId);
  if (!c) throw Object.assign(new Error("Comment not found."), { status: 404 });
  if (c.userId !== String(actor.userId) && !isOwner) throw Object.assign(new Error("Only the author or the owner can delete a comment."), { status: 403 });
  await writeList(
    commentsKey(workflowId),
    list.filter((x) => x.id !== commentId && x.parentId !== commentId)
  );
  return true;
}

/** Remove everything of a deleted workflow. */
export async function forgetWorkflow(workflowId) {
  await db.storeSet(commentsKey(workflowId), "");
  await db.storeSet(historyKey(workflowId), "");
}
