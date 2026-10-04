// ============================================================================
// W FLOW — execution error codes
// Single source of truth for every error code the executor can emit.
// Each code maps to a short description (shown inline in the Log console) and
// a full description + solve tips (shown in the Settings → Error codes panel
// and documented in ERRORS.md at the project root).
//
// The Log console shows:   BF-<code> · <short description>
// The Settings panel + ERRORS.md show:   full description + tips for each code.
// ============================================================================

// A categorical name for each code, used to keep the registry readable.
export const ERROR_CODES = {
  // ---- generic / unexpected -------------------------------------------------
  UNKNOWN: { code: 1001, short: "Unexpected error" },
  UNSUPPORTED_NODE: { code: 1002, short: "Unsupported node type" },
  NO_INPUT: { code: 1003, short: "Node received no input" },
  STOPPED_ON_PURPOSE: { code: 1004, short: "Workflow stopped on purpose" },
  LICENSE_INACTIVE: { code: 1005, short: "Self-hosted licence not active" },

  // ---- configuration --------------------------------------------------------
  MISSING_CONFIG: { code: 2001, short: "Missing configuration" },
  INVALID_JSON: { code: 2002, short: "Invalid JSON value" },
  INVALID_REGEX: { code: 2003, short: "Invalid regular expression" },
  EMPTY_EXPRESSION: { code: 2004, short: "Empty / blank expression" },

  // ---- network / HTTP -------------------------------------------------------
  HTTP_REQUEST_FAILED: { code: 3001, short: "HTTP request failed" },
  HTTP_TIMEOUT: { code: 3002, short: "HTTP request timed out" },
  HTTP_BAD_STATUS: { code: 3003, short: "HTTP request returned an error status" },
  DNS_RESOLUTION: { code: 3004, short: "Could not resolve host" },
  URL_BLOCKED: { code: 3005, short: "Private / internal URL blocked" },
  HOST_NOT_ALLOWED: { code: 3006, short: "Address not allowed by your team admin" },

  // ---- external services ----------------------------------------------------
  AUTH_FAILED: { code: 4001, short: "Authentication failed" },
  SERVICE_ERROR: { code: 4002, short: "External service returned an error" },
  RATE_LIMITED: { code: 4003, short: "Rate limited by the service" },

  // ---- AI -------------------------------------------------------------------
  AI_CONFIG_MISSING: { code: 5001, short: "AI credentials missing" },
  AI_PROVIDER_ERROR: { code: 5002, short: "AI provider error" },
  AGENT_NOT_FOUND: { code: 5003, short: "Saved agent not found" },
  AI_NO_REPLY: { code: 5004, short: "AI returned no usable reply" },
  IMAGE_GEN_FAILED: { code: 5005, short: "Image generation failed" },
  AI_BUDGET_EXCEEDED: { code: 5006, short: "AI budget reached" },

  // ---- data / logic ---------------------------------------------------------
  PARSE_FAILED: { code: 6001, short: "Failed to parse the data" },
  SORT_INVALID_VALUE: { code: 6002, short: "Unsortable value" },
  FIELD_MISSING: { code: 6003, short: "Referenced field is missing" },
  FILE_WRITE_FAILED: { code: 6004, short: "Could not write the file" },
  FILE_CONTENT_MISSING: { code: 6005, short: "No file content found" },
  UNKNOWN_FILE_TYPE: { code: 6006, short: "Could not detect the file type" },
  FILE_EXTRACT_FAILED: { code: 6007, short: "Could not extract the file content" },
  FILE_NOT_FOUND: { code: 6008, short: "File not found on disk" },
  FILE_PATH_INVALID: { code: 6009, short: "Invalid file path" },
  QUERY_FAILED: { code: 6010, short: "Database query failed" },
  SPENDING_LIMIT: { code: 6011, short: "Spending limit reached" },

  // ---- code / user expressions ----------------------------------------------
  CODE_ERROR: { code: 7001, short: "Error in user code" },
  CRYPTO_FAILED: { code: 7002, short: "Encryption / decryption failed" },

  // ---- human-in-the-loop ----------------------------------------------------
  APPROVAL_TIMEOUT: { code: 7003, short: "Nobody answered the approval" },
};

// Ordered list of code entries: { code, key, short, description, tips[] }
export function errorCatalog() {
  return Object.entries(ERROR_CODES).map(([key, def]) => ({
    key,
    ...def,
    description: FULL_DESCRIPTIONS[key] || "",
    tips: SOLVE_TIPS[key] || [],
  }));
}

const FULL_DESCRIPTIONS = {
  UNKNOWN: "An unexpected error occurred while executing the node. The exact cause is not known.",
  UNSUPPORTED_NODE: "The node has a type the executor does not implement, so it cannot run.",
  NO_INPUT: "The node started with no data on its input. Workflow logic that expects upstream data found none.",
  STOPPED_ON_PURPOSE: "A Stop and Error node was reached, so the run was halted deliberately with the message you set on that node.",
  LICENSE_INACTIVE: "This self-hosted copy has no active licence — the Pro or Team subscription behind it has ended, or the copy could not confirm it for several days — so it runs no workflows.",
  MISSING_CONFIG: "A required value in the node's configuration is empty. The node cannot run without it.",
  INVALID_JSON: "A JSON field on the node (headers, body, rows, fields, …) could not be parsed.",
  INVALID_REGEX: "A 'matches regex' operator or a regex field (AI Output Parser) uses a pattern the JS engine cannot compile.",
  EMPTY_EXPRESSION: "A JavaScript / formula expression is empty. The node needs at least a valid expression to run.",
  HTTP_REQUEST_FAILED: "The outbound HTTP request could not be completed (network error, invalid URL scheme, malformed request).",
  HTTP_TIMEOUT: "The request exceeded the node's timeout setting and was aborted before a response arrived.",
  HTTP_BAD_STATUS: "The server responded, but with a non-2xx status that the node treats as a failure.",
  DNS_RESOLUTION: "The host in the URL could not be resolved to an IP address.",
  URL_BLOCKED: "The node tried to call a private / link-local / loopback / cloud-metadata address, which this instance blocks for safety (see BF_BLOCK_PRIVATE_URLS).",
  HOST_NOT_ALLOWED: "The admin of this self-hosted copy limits which addresses your workflows may send data to or fetch data from, and this node called one that is not on the list.",
  AUTH_FAILED: "The credentials or token supplied to an external service were rejected (401 / invalid key).",
  SERVICE_ERROR: "An external service returned a business/logic error (4xx/5xx with an error body).",
  RATE_LIMITED: "The external service limited the number of requests (429). Try retrying after a pause.",
  AI_CONFIG_MISSING: "The chat / agent / image node is missing a provider, base URL, API key or model.",
  AI_PROVIDER_ERROR: "The AI provider itself returned an error (billing, model name, content filter, internal error).",
  AGENT_NOT_FOUND: "The AI Agent node references a saved agent ID that does not exist (it may have been deleted).",
  AI_NO_REPLY: "The model returned an empty or unusable reply for the given prompt.",
  IMAGE_GEN_FAILED: "The image generation request was rejected or returned nothing usable.",
  AI_BUDGET_EXCEEDED: "An AI token or cost limit was reached — the account's or this workflow's daily or monthly budget, or the node's own token cap for the run — so the model was not called.",
  PARSE_FAILED: "The incoming data could not be converted / parsed as expected for this node.",
  SORT_INVALID_VALUE: "The Sort node found values it cannot compare (mixed types, invalid numbers).",
  FIELD_MISSING: "A field path used by the node (sort key, extract field, template) was absent from the payload.",
  FILE_WRITE_FAILED: "The file output node could not write to the local files directory (./data/files).",
  FILE_CONTENT_MISSING: "A file node found no content in the referenced field — the payload field was empty or absent.",
  UNKNOWN_FILE_TYPE: "The file's type could not be detected from its name, MIME type or magic bytes, so no extractor matched.",
  FILE_EXTRACT_FAILED: "The file type was recognized but its content could not be extracted (corrupt file, unsupported variant, or a format outside the built-in best-effort extractors).",
  FILE_NOT_FOUND: "The Read File from Disk node could not find the requested path under ./data/files on the server.",
  FILE_PATH_INVALID: "A file node was given a path that escapes ./data/files (absolute path or '..'), or a malformed path.",
  SPENDING_LIMIT: "A node that moves money (an exchange order or a wallet transfer) was stopped because the amount is above its per-order limit, or would take today's total above its daily limit. Nothing was sent.",
  QUERY_FAILED: "A database node could not run its query — the connection was refused, the credentials were rejected, or the database returned a SQL error.",
  CODE_ERROR: "An exception was thrown inside user-authored JavaScript in a Code / Transform / Filter / Aggregate node.",
  CRYPTO_FAILED: "The Encrypt / Decrypt node could not encrypt or decrypt the value — usually a missing passphrase, or a value decrypted with a different passphrase than it was encrypted with.",
  APPROVAL_TIMEOUT: "A Wait for Approval node reached its time limit with nobody answering, and the node is set to fail the run when that happens. Runs started outside the editor (webhook, schedule, Telegram) have nobody watching, so they always fall back to this setting.",
};

const SOLVE_TIPS = {
  UNKNOWN: [
    "Re-run the workflow and check the exact error message on the node.",
    "Make sure the upstream nodes that feed this node ran successfully first.",
  ],
  UNSUPPORTED_NODE: [
    "This node type was probably imported from a different/older workflow.",
    "Replace the node with a supported one, or re-add it from the palette.",
  ],
  NO_INPUT: [
    "Connect a trigger or action upstream of this node.",
    "Make sure the upstream node executed successfully and produced output.",
  ],
  STOPPED_ON_PURPOSE: [
    "This is expected when the run reaches a Stop and Error node — the message on that node explains why.",
    "If it fires unexpectedly, check the IF / Filter conditions on the branch leading to it.",
    "Delete the Stop and Error node (or move it) while you are still building the flow.",
  ],
  LICENSE_INACTIVE: [
    "Renew the Pro or Team subscription on w-flow.tech — the copy unlocks at its next check, or right away with “Check again” on its lock screen.",
    "If the subscription is active, connect the copy to the internet so it can confirm the licence, or paste the current key from Settings → Self-hosted.",
    "Nothing is deleted while the copy is locked; you can also move everything to the cloud from the lock screen.",
  ],
  MISSING_CONFIG: [
    "Open the node and fill in the highlighted / required fields.",
    "For AI nodes, confirm provider, base URL, API key and model are set.",
  ],
  INVALID_JSON: [
    "Open the node and check the JSON field for a trailing comma, missing quotes, or unescaped characters.",
    "Tip: use an online JSON validator, or keep the empty `{}` / `[]` default while testing.",
  ],
  INVALID_REGEX: [
    "Open the node and simplify or fix the regular expression.",
    "Test the pattern separately (e.g. with an online regex tester) before using it.",
  ],
  EMPTY_EXPRESSION: [
    "Open the node and write at least a minimal expression, e.g. `return item;` or a condition.",
  ],
  HTTP_REQUEST_FAILED: [
    "Check the URL starts with http:// or https://.",
    "Verify the target is reachable from this machine (no firewall / proxy blocking).",
    "Enable retries on the HTTP node for transient network errors.",
  ],
  HTTP_TIMEOUT: [
    "Increase the 'Timeout' value on the HTTP node.",
    "Check whether the target endpoint is slow or unresponsive.",
  ],
  HTTP_BAD_STATUS: [
    "Look at the returned status code in the node's OUTPUT tab.",
    "4xx usually means bad credentials / payload — check headers and body.",
    "5xx usually means the remote service is having problems — retry later.",
  ],
  DNS_RESOLUTION: [
    "Check the domain spelling in the URL.",
    "Confirm the machine has working DNS / internet access.",
  ],
  URL_BLOCKED: [
    "The URL points at an address that only exists inside the server's own network (127.0.0.1, 10.x, 172.16–31.x, 192.168.x, 169.254.x — including the AWS/GCP instance-metadata service).",
    "On a public deployment this protects the server and its cloud account from being probed through workflows.",
    "Self-hosted operators who genuinely need to call internal services can set BF_BLOCK_PRIVATE_URLS=0 in .env and restart.",
  ],
  HOST_NOT_ALLOWED: [
    "Ask the admin of this copy to add the address to the allowed list (Team → Data flows).",
    "Or use one of the services and credentials the admin shared with the team.",
  ],
  AUTH_FAILED: [
    "Re-check the API key or token on the node.",
    "Verify the credential has the required scopes/permissions for the action.",
  ],
  SERVICE_ERROR: [
    "Read the service error body in the node's OUTPUT tab for the reason.",
  ],
  RATE_LIMITED: [
    "Wait for the rate-limit window to reset, or add a Wait node before retrying.",
    "Reduce request frequency to stay within the service's free tier.",
  ],
  AI_CONFIG_MISSING: [
    "Open the node and set Provider, Base URL, API key and Model.",
    "Save an agent in the AI Agent Builder and select it, or configure inline.",
  ],
  AI_PROVIDER_ERROR: [
    "Check that the model name is valid for the selected provider.",
    "Verify your account has credits/access for the chosen model.",
    "Simplify the system prompt (very long prompts can hit context limits).",
  ],
  AGENT_NOT_FOUND: [
    "Open the AI Agent node and re-select a saved agent from the list.",
    "If the agent was deleted, create it again in the AI Agent Builder.",
  ],
  AI_NO_REPLY: [
    "Make the prompt more specific so the model has something to answer.",
    "Disable JSON mode if the provider returns empty content in strict mode.",
  ],
  IMAGE_GEN_FAILED: [
    "Check the API key and that your account can generate images with the chosen model.",
    "Try a supported size from the dropdown.",
  ],
  AI_BUDGET_EXCEEDED: [
    "Check how much was used under Settings → AI usage & cost.",
    "Raise or remove the limit there (account) or in Workflow settings → AI budget (workflow), or raise the node's token cap.",
    "Or switch on the cheaper-model fallback so runs continue on a cheaper model before the limit is hit.",
  ],
  PARSE_FAILED: [
    "Check the input format matches the node's expectation (JSON vs CSV).",
    "Inspect the upstream output so you feed the node the right shape.",
  ],
  FILE_CONTENT_MISSING: [
    "Open the node and confirm the 'Field with the file' points at a payload field that actually contains data.",
    "Check the upstream node's OUTPUT tab — the field may be named differently (data, content, file, body …).",
  ],
  UNKNOWN_FILE_TYPE: [
    "Provide a file name with a known extension ('File name' field), or set a MIME type / content type upstream.",
    "For binary files make sure the content is passed as base64 and the node's 'Content is' is set to Base64.",
  ],
  FILE_EXTRACT_FAILED: [
    "Verify the file is not corrupt or truncated — try opening it in a normal application.",
    "Some variants (e.g. PDFs with unusual encodings, Excel files with external links) need dedicated parsers.",
    "Use the generic Extract File node's 'Return → Everything' to see the raw text and detected metadata.",
  ],
  FILE_NOT_FOUND: [
    "Check the path on the Read File from Disk node — files live under ./data/files relative to the project root.",
    "Write a file first (Write File to Disk) or place one in ./data/files manually.",
  ],
  FILE_PATH_INVALID: [
    "Use a relative path without '..' segments — all file nodes are sandboxed inside ./data/files.",
  ],
  SPENDING_LIMIT: [
    "Check the amount the node tried to send — it is in the error message, next to the limit it hit.",
    "Raise “Max amount per order” or “Max total per day” on the node if the amount is intended.",
    "Daily totals reset at midnight UTC; only real (non-test) orders and transfers count toward them.",
  ],
  QUERY_FAILED: [
    "Read the database error in the node's message — it usually names the table, column or syntax problem.",
    "Check host, port, database, user and password on the node.",
    "Confirm the query uses the placeholders the node expects ($1 / :name for PostgreSQL, ? for MySQL / SQL Server).",
    "The built-in SQL Query node is read-only — SELECT / WITH / VALUES / EXPLAIN only.",
  ],
  SORT_INVALID_VALUE: [
    "Make sure the sort field holds the same type across all items (all numbers or all strings).",
  ],
  FIELD_MISSING: [
    "Verify the field path is spelled exactly as it appears in the payload.",
    "Use the input overview to see which fields are actually available.",
  ],
  FILE_WRITE_FAILED: [
    "Check that the filename is a plain name (no '..' path segments).",
    "Make sure the process running the server can write to ./data/files.",
  ],
  CODE_ERROR: [
    "Open the node and review the code; the error message points at the line.",
    "Test the code in a scratch file first, then paste it in.",
    "Remember user code runs with 'use strict' — declare variables with let/const.",
  ],
  CRYPTO_FAILED: [
    "Fill in the passphrase field on the Encrypt / Decrypt node (it is stored encrypted, not in the workflow JSON).",
    "Decrypting needs exactly the same passphrase that encrypted the value — a different passphrase cannot recover it.",
    "Make sure the value you decrypt is the full base64 blob the Encrypt direction produced (nothing trimmed).",
  ],
  APPROVAL_TIMEOUT: [
    "Increase the node's \"give up after\" minutes, or answer the run from the editor's Log console while it is waiting.",
    "Switch \"when nobody answers\" to 'Treat it as rejected' (or approved) so an unattended run continues instead of failing.",
    "Scheduled, webhook and Telegram runs have nobody watching — pair them with a notification node so a person can answer in time.",
  ],
};

// ----------------------------------------------------------------------------
// Lookup helpers
// ----------------------------------------------------------------------------

// Map a thrown Error / string to the closest error code entry.
export function codeForError(err) {
  // Errors already tagged with a code (e.g. attachCode()) keep their own code
  // instead of being re-classified from the message text.
  if (err && typeof err === "object" && err._bfCode) {
    return { code: err._bfCode, short: err._bfShort || "Error" };
  }
  const msg = String(err?.message || err || "");
  const lower = msg.toLowerCase();

  if (lower.includes("agent") && lower.includes("not found")) return ERROR_CODES.AGENT_NOT_FOUND;
  if (lower.includes("node type")) return ERROR_CODES.UNSUPPORTED_NODE;
  if (lower.includes("unsupported node")) return ERROR_CODES.UNSUPPORTED_NODE;
  if (/invalid json|unexpected token|unexpected end|json\.parse/.test(lower)) return ERROR_CODES.INVALID_JSON;
  if (/invalid .*regexp|invalid regular expression|regexp syntax/.test(lower)) return ERROR_CODES.INVALID_REGEX;
  if (/timed out|timeout|abort/.test(lower)) return ERROR_CODES.HTTP_TIMEOUT;
  if (/getaddrinfo|enotfound|dns|no address|eai_again/.test(lower)) return ERROR_CODES.DNS_RESOLUTION;
  if (/fetch failed|network|socket hang up|econnreset|econnrefused|ecdh/.test(lower)) return ERROR_CODES.HTTP_REQUEST_FAILED;
  // 401 / 403 / invalid-token messages are authentication problems, not "missing config".
  if (/unauthorized|401|403|forbidden|invalid api[ _]?key|incorrect api[ _]?key|api[ _]?key.{0,20}invalid|invalid[ _-]?token/.test(lower)) return ERROR_CODES.AUTH_FAILED;
  if (/too many requests|429|rate limit/.test(lower)) return ERROR_CODES.RATE_LIMITED;
  if (/no file content|file content is missing|no content found/.test(lower)) return ERROR_CODES.FILE_CONTENT_MISSING;
  if (/could not detect the file type|unknown file type|not a (valid )?zip|not a valid zip/.test(lower)) return ERROR_CODES.UNKNOWN_FILE_TYPE;
  if (/(extract|parse|decompress|read).*(file|archive|pdf|docx|xlsx|yaml)|no extractor|not a (table|structured|archive)/.test(lower)) return ERROR_CODES.FILE_EXTRACT_FAILED;
  if (/file not found on disk|not found on disk/.test(lower)) return ERROR_CODES.FILE_NOT_FOUND;
  if (/invalid path|must stay inside|escapes the files directory/.test(lower)) return ERROR_CODES.FILE_PATH_INVALID;
  if (/could not write the file/.test(lower)) return ERROR_CODES.FILE_WRITE_FAILED;
  // Missing-credential messages only (a real key that fails is handled above as auth).
  if (
    /no (api[ _]?key|credentials)/.test(lower) ||
    /(didn't|did not) provide.*api[ _]?key/.test(lower) ||
    /missing (api[ _]?key|credentials)/.test(lower) ||
    /api[ _]?key.{0,25}not configured/.test(lower)
  )
    return ERROR_CODES.AI_CONFIG_MISSING;
  if (lower.includes("agent")) return ERROR_CODES.AGENT_NOT_FOUND;

  return ERROR_CODES.UNKNOWN;
}

// Build the public marker shown in the Log console: "BF-1001 · Short description"
export function codeMarker(def, shortOverride) {
  if (!def) return null;
  return `BF-${def.code} · ${shortOverride || def.short}`;
}

// Attach { code, marker, description, tips } to an error object for a specific error kind.
export function attachCode(err, codeKey) {
  const def = ERROR_CODES[codeKey] || ERROR_CODES.UNKNOWN;
  if (err && typeof err === "object") {
    if (!err._bfCode) {
      err._bfCode = def.code;
      err._bfShort = def.short;
      err._bfMarker = codeMarker(def);
    }
  }
  return err;
}