// ----------------------------------------------------------------------------
// W FLOW — shared-editing presence
//
// While a workflow is shared, every open editor reports which node its user is
// editing right now (`setPresence`) and reads who else is on the canvas
// (`workflowPresence`). The editor draws a small marker on that node — "Ada is
// editing this" — so two people working on the same workflow can see where the
// other one is instead of silently overwriting each other.
//
// Entries are keyed by (workflowId, userId) and expire on their own after
// PRESENCE_TTL_MS, so a closed tab, a crashed browser or a lost connection
// clears itself without any cleanup call.
// ----------------------------------------------------------------------------

/** How long a reported position stays valid without a refresh. */
export const PRESENCE_TTL_MS = 25_000;

const entries = new Map(); // `${workflowId}:${userId}` -> entry

const key = (workflowId, userId) => `${String(workflowId)}:${String(userId)}`;

function prune() {
  const now = Date.now();
  for (const [k, entry] of entries) {
    if (now - entry.at > PRESENCE_TTL_MS) entries.delete(k);
  }
}

/**
 * Record which node a user is editing in a workflow. Passing no nodeId means
 * "this user is only looking at the canvas" — the entry stays alive (so the
 * person still counts as present) but no node is marked.
 */
export function setPresence(workflowId, user, nodeId, nodeLabel) {
  if (!workflowId || !user?.userId) return;
  entries.set(key(workflowId, user.userId), {
    workflowId: String(workflowId),
    userId: String(user.userId),
    name: user.name || user.email || "",
    email: user.email || "",
    nodeId: nodeId ? String(nodeId) : null,
    nodeLabel: nodeLabel ? String(nodeLabel).slice(0, 120) : "",
    at: Date.now(),
  });
}

/** Everyone currently editing this workflow, newest position first. */
export function workflowPresence(workflowId) {
  prune();
  return [...entries.values()]
    .filter((e) => e.workflowId === String(workflowId))
    .sort((a, b) => b.at - a.at)
    .map(({ workflowId: _wf, at, ...rest }) => rest);
}

/** Forget one user's position (used when their editor closes). */
export function clearPresence(workflowId, userId) {
  entries.delete(key(workflowId, userId));
}
