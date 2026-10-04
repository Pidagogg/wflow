// ============================================================================
// W FLOW — personal data in node settings
//
// Credentials are one kind of private value (SECRET_FIELD_NAMES in
// server/store.js). The other kind is who a workflow talks to: the e-mail
// address in a Gmail node's "To", a Telegram chat ID, a phone number, a
// database login, a server host, a wallet address. The owner keeps them —
// they are not secrets to the owner — but they must not travel with a
// workflow that is published to User Templates or exported as a file, or
// every importer sees (and might e-mail) the owner's contacts.
//
// A value is removed only when it contains literal text. A value made only of
// placeholders — "{{body.email}}", "{{$vars.ALERT_TO}}" — carries no personal
// data and is exactly what makes a template reusable, so it stays.
//
// Shared by the server (publish, import, account export) and the browser
// (Export JSON, the "private" marker on these fields).
// ============================================================================

export const PRIVATE_FIELD_NAMES = new Set([
  // e-mail addressing
  "to",
  "cc",
  "bcc",
  "from",
  "fromEmail",
  "replyTo",
  "email",
  "attendees",
  // chats and phones
  "chatId",
  "phoneNumber",
  "phoneNumberId",
  "toNumber",
  "fromNumber",
  "recipient",
  "recipients",
  // logins and servers
  "user",
  "username",
  "host",
  // wallets
  "address",
  "wallet",
]);

/** True when `value` holds more than {{placeholders}} and separators. */
export function hasLiteralValue(value) {
  if (typeof value !== "string") return value !== undefined && value !== null && value !== "" && typeof value !== "boolean";
  return value.replace(/\{\{[^}]*\}\}/g, "").replace(/[\s,;]+/g, "") !== "";
}

/** A node config with its personal values blanked (placeholders kept). */
export function stripPrivateFromConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = PRIVATE_FIELD_NAMES.has(k) && hasLiteralValue(v) ? "" : v;
  }
  return out;
}

/** A workflow (or post) whose nodes carry no personal values. */
export function stripPrivateFromWorkflow(wf) {
  if (!wf || !Array.isArray(wf.nodes)) return wf;
  return {
    ...wf,
    nodes: wf.nodes.map((n) => (n?.data?.config ? { ...n, data: { ...n.data, config: stripPrivateFromConfig(n.data.config) } } : n)),
  };
}
