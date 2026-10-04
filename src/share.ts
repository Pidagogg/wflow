// Client-side credential scrubber — used when a workflow is EXPORTED as JSON
// (and conceptually mirrors server/store.js stripSecretsFromWorkflow, which
// scrubs community posts). The saved copy in ./data keeps the credentials; the
// exported file does not, so anyone who imports the file has to enter their own
// API keys / passwords / webhook URLs.
const SECRET_KEYS = new Set([
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
]);

export interface ExportableNode {
  data?: { config?: Record<string, unknown> };
}

/**
 * Blank the secret-looking values of one node's config. Used when a node is
 * pinned as a reference for the AI builder: the agent needs the step and its
 * settings, never the credentials.
 */
export function stripSecretsFromConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!config || typeof config !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = "";
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = stripSecretsFromConfig(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? stripSecretsFromConfig(item as Record<string, unknown>) : item));
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function stripSecretsFromWorkflow<T extends { nodes?: ExportableNode[] }>(wf: T): T {
  const scrub = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.has(k)) {
        out[k] = "";
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = scrub(v as Record<string, unknown>);
      } else if (Array.isArray(v)) {
        out[k] = v.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? scrub(item) : item));
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  const nodes = (wf.nodes || []).map((n) => {
    const config = scrub((n.data?.config || {}) as Record<string, unknown>);
    return { ...n, data: { ...(n.data || {}), config } };
  });
  return { ...wf, nodes };
}
