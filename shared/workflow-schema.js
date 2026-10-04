// ============================================================================
// W FLOW — JSON Schema of a workflow file
//
// Served at /schema/workflow.schema.json and referenced by "$schema" in every
// exported workflow, so VS Code (and any other JSON-Schema-aware editor or
// agent) checks a workflow while it is being written: known node types, each
// type's settings with their allowed values, and the edge shape.
//
// Generated from the catalog so it never drifts. One `if type == X then …`
// rule per node type: editors report "unknown property" / "not one of" against
// that type instead of the unreadable "matches none of 470 alternatives" a
// oneOf would give. Settings stay open (additionalProperties: true) because
// the engine ignores unknown keys — the in-app validator warns about them.
// ============================================================================

const FIELD_TYPES = {
  number: { type: ["number", "string"] }, // "{{placeholder}}" strings are allowed too
  boolean: { type: ["boolean", "string"] },
  keyvalue: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: {} } } },
};

function fieldSchema(field) {
  const out = { ...(FIELD_TYPES[field.type] || {}) };
  const opts = Array.isArray(field.options) ? field.options.map((o) => (typeof o === "string" ? o : o?.value)).filter((v) => v !== undefined) : [];
  if (field.type === "select" && opts.length) out.enum = opts;
  if (field.type === "json") out.type = ["string", "object", "array"];
  const desc = [field.label, field.help].filter(Boolean).join(" — ");
  if (desc) out.description = desc.slice(0, 400);
  return out;
}

/** The schema for `nodes` (type → catalog definition). `baseUrl` sets $id. */
export function buildWorkflowSchema(nodes, { baseUrl = "" } = {}) {
  const types = Object.keys(nodes).sort();
  const rules = types.map((type) => {
    const def = nodes[type];
    const properties = {};
    for (const f of def.fields || []) {
      if (f.type === "note") continue;
      properties[f.key] = fieldSchema(f);
    }
    return {
      if: { properties: { type: { const: type } }, required: ["type"] },
      then: {
        description: `${def.name} — ${def.description || ""}`.slice(0, 400),
        properties: { data: { properties: { config: { type: "object", properties } } } },
      },
    };
  });

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...(baseUrl ? { $id: `${baseUrl}/schema/workflow.schema.json` } : {}),
    title: "W flow workflow",
    description: "A W flow workflow: nodes (steps) and edges (connections). Full reference for AI agents: /docs/workflow-reference.md",
    type: "object",
    required: ["nodes"],
    properties: {
      $schema: { type: "string" },
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      nodes: { type: "array", items: { $ref: "#/definitions/node" } },
      edges: { type: "array", items: { $ref: "#/definitions/edge" } },
    },
    definitions: {
      node: {
        type: "object",
        required: ["id", "type"],
        properties: {
          id: { type: "string", description: "Unique inside the workflow." },
          type: { enum: types, description: "The node type — see the node catalog." },
          position: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
          },
          data: {
            type: "object",
            properties: {
              label: { type: "string", description: "The name shown on the canvas." },
              config: { type: "object", description: "The node's settings — keys from its field list." },
            },
          },
        },
        allOf: rules,
      },
      edge: {
        type: "object",
        required: ["source", "target"],
        properties: {
          id: { type: "string" },
          source: { type: "string", description: "id of the node the data leaves." },
          target: { type: "string", description: "id of the node the data enters." },
          sourceHandle: { type: "string", description: "\"out\", or a branch: \"true\"/\"false\" (IF), \"case-0\"… \"default\" (Switch), \"case-0\"… \"fallback\" (Router), \"approved\"/\"rejected\", \"same\"/\"different\"/\"onlyA\"/\"onlyB\"." },
          targetHandle: { const: "in" },
        },
      },
    },
  };
}
