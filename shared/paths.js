// ============================================================================
// W FLOW — resolving {{path}} placeholders against an item
//
// `{{result.price}}` is the exact path. But users write what they see in the
// input panel — `{{price}}` — and many nodes save their answer under a field
// (storeIn: "result", "data", …), so the exact path is often one level down.
// An empty value there silently broke IF conditions and e-mails, so:
//
//   1. the exact path always wins (nothing that worked before changes),
//   2. otherwise the FIRST segment is looked up anywhere in the item,
//      shallowest match first (breadth-first, objects and array elements),
//      and the rest of the path continues from there exactly.
//   3. `{{json}}` is the whole item and `{{json.a.b}}` a path inside it, unless
//      the item really has a field called "json". The AI nodes' default
//      prompts say "Here is the workflow data: {{json}}" — before this rule
//      that rendered as an empty string and the model saw no data at all.
//
// Shared by the executor's template renderers and the service engine.
// ============================================================================

const MAX_DEPTH = 8;
const MAX_VISITS = 5000;

function exact(json, parts) {
  let acc = json;
  for (const key of parts) {
    if (acc == null) return undefined;
    acc = acc[key];
  }
  return acc;
}

/** Find `key` in nested objects / arrays, shallowest first. */
function findKey(json, key) {
  let level = [json];
  let visits = 0;
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
    const next = [];
    for (const node of level) {
      if (!node || typeof node !== "object") continue;
      if (++visits > MAX_VISITS) return undefined;
      if (depth > 0 && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, key) && node[key] !== undefined) return { found: node[key] };
      for (const child of Array.isArray(node) ? node : Object.values(node)) {
        if (child && typeof child === "object") next.push(child);
      }
    }
    level = next;
  }
  return undefined;
}

/** The value at `path` in `json` (see the header for the lookup rules). */
export function resolvePath(json, path) {
  const parts = String(path).split(".");
  const direct = exact(json, parts);
  if (direct !== undefined && direct !== null) return direct;
  if (!json || typeof json !== "object") return direct;
  if (parts[0] === "json" && json.json === undefined) return parts.length === 1 ? json : resolvePath(json, parts.slice(1).join("."));
  const hit = findKey(json, parts[0]);
  if (!hit) return direct;
  const rest = exact(hit.found, parts.slice(1));
  return rest !== undefined ? rest : direct;
}
