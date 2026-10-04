// ---------------------------------------------------------------------------
// Importing one workflow's JSON into another.
//
// "Import" in the editor means two different things:
//
//   replace — the file lands on an EMPTY canvas: its graph becomes the canvas.
//   merge   — the file lands on a canvas that already has nodes: the workflow
//             the user is working on is left completely alone and the imported
//             nodes are placed NEXT TO it, with their own settings and
//             connections. No dialog, no guessing — the canvas decides.
//
// A merge must never lose work, so it only ever APPENDS: incoming node and edge
// ids are replaced with fresh ones (the host may already use them), the imported
// graph keeps its internal layout but is shifted to the right of the host graph
// instead of landing on top of it, and edges pointing at a node the file does
// not contain are dropped.
//
// Deliberately pure (no DOM, no React) so the same code runs in the editor and
// in the node test suite — see tests/workflow-merge.test.js.
// ---------------------------------------------------------------------------

/** Horizontal space kept between the host graph and the imported one. */
export const MERGE_GAP_X = 360;

function randomToken() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

/** A fresh id that the host graph does not use yet. `taken` is mutated. */
function freshId(prefix, taken) {
  let id;
  do {
    id = `${prefix}-${randomToken()}`;
  } while (taken.has(id));
  taken.add(id);
  return id;
}

function isNode(value) {
  return !!value && typeof value === "object" && typeof value.type === "string" && value.type !== "";
}

const posX = (node) => {
  const v = Number(node?.position?.x);
  return Number.isFinite(v) ? v : 0;
};
const posY = (node) => {
  const v = Number(node?.position?.y);
  return Number.isFinite(v) ? v : 0;
};

/**
 * Merge `incoming` into `host`, returning ONLY the nodes/edges to append.
 *
 * @param {{nodes?: Array, edges?: Array}} host     the workflow on the canvas
 * @param {{nodes?: Array, edges?: Array}} incoming the imported workflow JSON
 * @returns {{nodes: Array, edges: Array, stats: {nodes: number, edges: number}}}
 */
export function mergeWorkflows(host, incoming) {
  const hostNodes = (Array.isArray(host?.nodes) ? host.nodes : []).filter(isNode);
  const hostEdges = Array.isArray(host?.edges) ? host.edges : [];
  const incomingNodes = (Array.isArray(incoming?.nodes) ? incoming.nodes : []).filter(isNode);
  const incomingEdges = Array.isArray(incoming?.edges) ? incoming.edges : [];
  if (!incomingNodes.length) throw new Error("The imported workflow has no nodes.");

  const takenNodeIds = new Set(hostNodes.map((n) => String(n.id)));
  const takenEdgeIds = new Set(hostEdges.map((e) => String(e?.id)));
  // One fresh id per imported node — assigned by INDEX, so even a file with
  // duplicate ids cannot produce duplicate nodes. `renamed` then maps the old
  // id to the new one for the imported edges.
  const newIds = incomingNodes.map(() => freshId("n", takenNodeIds));
  const renamed = new Map();
  incomingNodes.forEach((node, i) => {
    if (!renamed.has(String(node.id))) renamed.set(String(node.id), newIds[i]);
  });

  // Keep the imported layout exactly as it is, but slide the whole graph to the
  // right of the host graph, top-aligned with it.
  let dx = 0;
  let dy = 0;
  if (hostNodes.length) {
    const hostRight = Math.max(...hostNodes.map(posX));
    const hostTop = Math.min(...hostNodes.map(posY));
    dx = hostRight + MERGE_GAP_X - Math.min(...incomingNodes.map(posX));
    dy = hostTop - Math.min(...incomingNodes.map(posY));
  }

  const nodes = incomingNodes.map((node, i) => ({
    // type, label, config (and anything else the file carries) stay untouched.
    ...node,
    id: newIds[i],
    position: { x: posX(node) + dx, y: posY(node) + dy },
  }));

  const edges = [];
  for (const edge of incomingEdges) {
    if (!edge || typeof edge !== "object") continue;
    const source = renamed.get(String(edge.source));
    const target = renamed.get(String(edge.target));
    if (!source || !target || source === target) continue; // points outside the imported file
    edges.push({ ...edge, id: freshId("e", takenEdgeIds), source, target });
  }

  return { nodes, edges, stats: { nodes: nodes.length, edges: edges.length } };
}
