// ============================================================================
// W FLOW — the inputs a workflow asks for when it runs as an AI tool (MCP)
//
// Shared by server/mcp.js (the tool's input schema) and the workflow settings
// (which show the same list), so both always agree. Inputs typed in by hand
// win. Without them the trigger decides: a Form trigger asks for its form
// fields and a Chat trigger for the message, because that is exactly what the
// trigger emits when the tool's arguments arrive as its payload. Any other
// trigger gets no named inputs; whatever the assistant sends still reaches it.
// ============================================================================

const TRIGGER_INPUTS = {
  formTrigger: (c) =>
    String(c.fields || "name, email, message")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, description: `Form field “${name}”` })),
  chatTrigger: () => [{ name: "message", description: "The chat message the workflow answers" }],
};

const toolName = (name) => String(name || "").trim().replace(/[^\w-]/g, "_").slice(0, 64);

/**
 * { params: [{ name, description, field? }], source: "manual" | "<trigger type>" | "" }
 * for a workflow (anything with `nodes` and optional `mcp`).
 */
export function toolInputsFor(wf) {
  const own = (wf?.mcp?.params || []).filter((p) => p?.name);
  if (own.length) return { params: own, source: "manual" };
  const trigger = (wf?.nodes || []).find((n) => TRIGGER_INPUTS[n?.type]);
  if (!trigger) return { params: [], source: "" };
  const seen = new Set();
  const params = TRIGGER_INPUTS[trigger.type](trigger.data?.config || {})
    // Tool names allow only [\w-]; `field` keeps the trigger's own spelling so
    // "full name" arrives as "full name" and {{full name}} still resolves.
    .map((p) => ({ ...p, name: toolName(p.name), field: p.name }))
    .filter((p) => p.name && !seen.has(p.name) && seen.add(p.name))
    .slice(0, 20);
  return { params, source: trigger.type };
}
