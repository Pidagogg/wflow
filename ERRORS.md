# W flow — Error Code Reference

Every execution error emitted by the workflow engine has a **code** shown in the
Log console as `BF-<code> · <short description>`. Use the code to look up the
full description and solve tips below — they are also available inside the app
under **Settings → Error codes**.

---

## 1 · Generic / unexpected

### BF-1001 — Unexpected error
An unexpected error occurred while executing the node; the exact cause is not known.

**Troubleshooting**
1. Re-run the workflow and read the exact error message on the node.
2. Make sure the nodes feeding this one ran successfully first.

### BF-1002 — Unsupported node type
The node has a type the executor does not implement, so it cannot run.

**Troubleshooting**
1. This node type was probably imported from a different/older workflow.
2. Replace the node with a supported one, or re-add it from the palette.

### BF-1003 — Node received no input
The node started with no data on its input.

**Troubleshooting**
1. Connect a trigger or action upstream of this node.
2. Verify the upstream node ran and produced output.

### BF-1004 — Workflow stopped on purpose
A **Stop and Error** node was reached, so the run halted deliberately with the message set on that node.

**Troubleshooting**
1. This is expected when the run reaches a Stop and Error node — the message explains why.
2. If it fires unexpectedly, check the IF / Filter conditions on the branch leading to it.
3. Delete the Stop and Error node (or move it) while you are still building the flow.

### BF-1005 — Self-hosted licence not active
This self-hosted copy has no active licence — the Pro or Team subscription behind it has ended, or the copy could not confirm it for several days — so it runs no workflows.

**Troubleshooting**
1. Renew the Pro or Team subscription on w-flow.tech — the copy unlocks at its next check, or right away with “Check again” on its lock screen.
2. If the subscription is active, connect the copy to the internet so it can confirm the licence, or paste the current key from Settings → Self-hosted.
3. Nothing is deleted while the copy is locked; you can also move everything to the cloud from the lock screen.

---

## 2 · Configuration

### BF-2001 — Missing configuration
A required value in the node's configuration is empty.

**Troubleshooting**
1. Open the node and fill in the required fields (they appear without the "+" optional toggle).
2. For AI nodes, confirm provider, base URL, API key and model are set.

### BF-2002 — Invalid JSON value
A JSON field (headers, body, rows, fields, …) could not be parsed.

**Troubleshooting**
1. Check for a trailing comma, missing quotes, or unescaped characters.
2. Keep `{}` / `[]` while testing if unsure.

### BF-2003 — Invalid regular expression
A `matches regex` operator or regex field uses a pattern the JS engine cannot compile.

**Troubleshooting**
1. Simplify or fix the pattern.
2. Test it in an online regex tester first.

### BF-2004 — Empty / blank expression
A JavaScript / formula expression is empty.

**Troubleshooting**
1. Write at least a minimal expression, e.g. `return item;` or a condition.

---

## 3 · Network / HTTP

### BF-3001 — HTTP request failed
The outbound HTTP request could not be completed.

**Troubleshooting**
1. Confirm the URL starts with `http://` or `https://`.
2. Check the target is reachable from this machine.
3. Enable retries on the HTTP node for transient errors.

### BF-3002 — HTTP request timed out
The request exceeded the node's timeout and was aborted.

**Troubleshooting**
1. Increase the node's **Timeout** value.
2. Check whether the endpoint is slow or unresponsive.

### BF-3003 — HTTP request returned an error status
The server responded with a non-2xx status.

**Troubleshooting**
1. Inspect the returned status in the node's OUTPUT tab.
2. 4xx → usually credentials/payload; 5xx → remote service problem, retry later.

### BF-3004 — Could not resolve host
The host in the URL could not be resolved.

**Troubleshooting**
1. Check the domain spelling.
2. Confirm the machine has working DNS / internet.

### BF-3005 — Private / internal URL blocked
The node tried to call a private / link-local / loopback / cloud-metadata
address, which this instance blocks for safety.

This is enabled on public deployments so that a workflow can never probe the
server itself (`127.0.0.1`), its local network, or the cloud instance-metadata
service (`169.254.169.254` on AWS / GCP — which can hand out IAM credentials).

**Troubleshooting**
1. Point the node at a public address instead of an internal one.
2. On a private, single-operator deployment you may allow internal addresses
   again by setting `BF_BLOCK_PRIVATE_URLS=0` in `.env` and restarting.

### BF-3006 — Address not allowed by your team admin
The admin of this self-hosted copy limits which addresses your workflows may send data to or fetch data from, and this node called one that is not on the list.

**Troubleshooting**
1. Ask the admin of this copy to add the address to the allowed list (Team → Data flows).
2. Or use one of the services and credentials the admin shared with the team.

---

## 4 · External services

### BF-4001 — Authentication failed
The credentials or token were rejected (401 / invalid key).

**Troubleshooting**
1. Re-enter the API key/token on the node.
2. Verify the credential has the required scope/permission.

### BF-4002 — External service returned an error
The service returned a business/logic error (4xx/5xx with error body).

**Troubleshooting**
1. Read the error body in the node's OUTPUT tab for the reason.

### BF-4003 — Rate limited by the service
The service limited the number of requests (429).

**Troubleshooting**
1. Wait for the rate-limit window, or add a Wait node before retrying.

---

## 5 · AI

### BF-5001 — AI credentials missing
A chat/agent/image node is missing provider, base URL, API key or model.

**Troubleshooting**
1. Set Provider, Base URL, API key and Model on the node.
2. Or save an agent and select it.

### BF-5002 — AI provider error
The AI provider returned an error.

**Troubleshooting**
1. Confirm the model name is valid for the provider.
2. Verify credits/access. 3. Shorten very long prompts.

### BF-5003 — Saved agent not found
The AI Agent node references an agent that does not exist.

**Troubleshooting**
1. Re-select a saved agent on the node.
2. Recreate the agent in the AI Agent Builder if it was deleted.

### BF-5004 — AI returned no usable reply
The model returned empty/unusable content.

**Troubleshooting**
1. Make the prompt more specific.
2. Disable JSON mode if the provider returns empty content.

### BF-5005 — Image generation failed
The image request was rejected or returned nothing usable.

**Troubleshooting**
1. Check the API key and model access.
2. Use a supported size.

### BF-5006 — AI budget reached
An AI token or cost limit was reached — the account's or this workflow's daily or monthly budget, or the node's own token cap for the run — so the model was not called.

**Troubleshooting**
1. Check how much was used under **Settings → AI usage & cost**.
2. Raise or remove the limit there (account) or in **Workflow settings → AI budget** (workflow), or raise the node's token cap.
3. Or switch on the cheaper-model fallback so runs continue on a cheaper model before the limit is hit.

---

## 6 · Data & logic

### BF-6001 — Failed to parse the data
The incoming data could not be converted as expected.

**Troubleshooting**
1. Match the input format to the node's expectation (JSON vs CSV).
2. Inspect the upstream output to feed the right shape.

### BF-6002 — Unsortable value
The Sort node found values it cannot compare.

**Troubleshooting**
1. Make sure the sort field holds the same type across all items.

### BF-6003 — Referenced field is missing
A field path used by the node was absent from the payload.

**Troubleshooting**
1. Verify the field path spelling against the payload.
2. Use the input overview to see available fields.

### BF-6004 — Could not write the file
The file output node could not write/append to the local outputs directory.

**Troubleshooting**
1. Use a plain filename (no `..` path segments).
2. Ensure the server process can write to `./data/outputs`.

### BF-6005 — No file content found
A file node (Extract File, Extract Text, …) found no content in the field it was told to read.

**Troubleshooting**
1. Confirm the node's **Field with the file** points at a payload field that actually contains data.
2. Check the upstream node's OUTPUT tab — the field may be named differently (`data`, `content`, `file`, `body` …).

### BF-6006 — Could not detect the file type
The file's type could not be detected from its name, MIME type or magic bytes.

**Troubleshooting**
1. Provide a file name with a known extension (node's **File name** field) so the type can be detected.
2. For binary files, pass the content as base64 and set **Content is → Base64**.

### BF-6007 — Could not extract the file content
The file type was recognized but its content could not be extracted (corrupt file, unsupported variant, or a format outside the built-in best-effort extractors).

**Troubleshooting**
1. Verify the file is not corrupt or truncated — try opening it in a normal application.
2. Some variants (PDFs with unusual encodings, Excel files with external links) need dedicated parsers.
3. Use the generic **Extract File** node with **Return → Everything** to see the raw text and detected metadata.

### BF-6008 — File not found on disk
The **Read File from Disk** node could not find the requested path under `./data/files` on the server.

**Troubleshooting**
1. Check the path — files live under `./data/files` relative to the project root.
2. Write a file first (**Write File to Disk**) or place one in `./data/files` manually.

### BF-6009 — Invalid file path
A file node was given a path that escapes `./data/files` (absolute path or `..`), or a malformed path.

**Troubleshooting**
1. Use a relative path without `..` segments — all file nodes are sandboxed inside `./data/files`.

### BF-6010 — Database query failed
A **database** node (SQL Query, PostgreSQL / MySQL / MariaDB / SQL Server / TimescaleDB / CrateDB / QuestDB) could not run its query — the connection was refused, the credentials were rejected, or the database returned a SQL error.

**Troubleshooting**
1. Read the database error in the node's message — it usually names the table, column or syntax problem.
2. Check host, port, database, user and password on the node.
3. Confirm the query uses the placeholders the node expects (`$1` / `:name` for PostgreSQL, `?` for MySQL / SQL Server).
4. The built-in **SQL Query** node is read-only — `SELECT` / `WITH` / `VALUES` / `EXPLAIN` only.

### BF-6011 — Spending limit reached
A node that moves money (an **exchange order** or a **wallet transfer**) was stopped because the amount is above its per-order limit, or would take today's total above its daily limit. Nothing was sent.

**Troubleshooting**
1. Check the amount the node tried to send — it is in the error message, next to the limit it hit.
2. Raise **Max amount per order** or **Max total per day** on the node if the amount is intended.
3. Daily totals reset at midnight UTC; only real (non-test) orders and transfers count toward them.

---

## 7 · User code

### BF-7001 — Error in user code
An exception was thrown inside user-authored JavaScript.

**Troubleshooting**
1. Open the node; the message points at the offending line.
2. Test the code in a scratch file first, then paste it in.
3. Remember user code runs with `'use strict'` — declare variables with `let`/`const`.

### BF-7002 — Encryption / decryption failed
The **Encrypt / Decrypt** node could not encrypt or decrypt the value.

**Troubleshooting**
1. Fill in the passphrase field (it is stored encrypted, not in the workflow JSON).
2. Decrypting needs exactly the same passphrase that encrypted the value — a different one cannot recover it.
3. Make sure the value you decrypt is the full base64 blob the Encrypt direction produced (nothing trimmed).

---

## 8 · Human-in-the-loop

### BF-7003 — Nobody answered the approval
A **Wait for Approval** node reached its time limit with nobody answering, and the node is set to **fail the run** when that happens. Runs started outside the editor (webhook, schedule, Telegram) have nobody watching, so they always fall back to that setting.

**Troubleshooting**
1. Increase the node's **give up after** minutes, or leave the run waiting and press **Approve** / **Reject** in the editor's Log console.
2. Switch **when nobody answers** to *Treat it as rejected* (or *approved*) so an unattended run continues instead of failing.
3. Scheduled / webhook / Telegram runs have nobody watching — pair the approval with a notification node so a person can answer before the limit.
