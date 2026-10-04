# TESTWORKFLOW

Automated test assets for the **reworked workflow builder**. Everything here is for
testing the new execution model (webhook receive/respond, strict sequencing, manual
stepping). It does **not** touch your real `data/workflows.json`.

## The new model

1. **Webhook trigger = receive only.** The Webhook node gets the incoming request and
   passes the payload on to the next node. It does **not** respond by itself.
2. **Webhook Respond node** — an action node that, when reached, sends the HTTP response
   back to the caller. Its body supports `{{var}}` placeholders. Use one at the end.
   - `contentType: "json"` (default) returns the response body as JSON.
   - Legacy workflows with no Respond node still work (the trigger's old `responseMode`
     is used), so this is backwards compatible.
3. **Strict sequencing / halt-on-error.** A node only runs after its upstream actually
   produced input for it — an untaken branch never executes its downstream, and if a node
   errors the chain stops there. Downstream never runs before (or without) its input.
4. **Manual output + "Run next node".** If a node fails and you set its **Manual output**,
   open its config and press **▶ Run next node**. That executes the downstream node using
   your manually-set data as its input, skipping the halted node. No tokens / bad AI key?
   Set a manual output on the AI node (see workflow 3).
5. **Manual trigger with manual output** lets you start a chain from fixed data and step
   through it node-by-node.

## Folder layout

- `workflows/` — 10 importable workflow JSON files (one object each; import via the
  builder's Import button).
- `web/` — browser test pages.
- `build-test-workflows.mjs` — regenerates the 10 workflows (run `node build-test-workflows.mjs`).
- `run-tests.mjs` — runs every workflow through the executor directly (no server,
  no auth). Verifies sequencing, branching, stepping.
- `http-test.mjs` — registers the webhook workflows into the server store, POSTs real
  requests, checks the Respond-node reply over HTTP, then restores `data/workflows.json`.

## The 10 workflows

| # | id | What it tests |
|---|---|---|
| 1 | `test-wf-echo` | Webhook receive → Set → Webhook Respond echoes `{{body.message}}` |
| 2 | `test-wf-respondonly` | Webhook trigger forwards straight to Respond (no auto-response) |
| 3 | `test-wf-pdfai` | Webhook → Extract PDF → AI Agent → Respond. Agent uses **manual output** (tokens-save) |
| 4 | `test-wf-seq` | Three-step chain proving strict sequential order (`one|1` → `two|2`) |
| 5 | `test-wf-haltstep` | Manual trigger → IF → branch; verified stepping via `run-node` |
| 6 | `test-wf-template` | Prompt Template + `{{body.name}}` interpolation in the Respond body |
| 7 | `test-wf-branch` | IF branching → **only the reached branch's Respond node replies** |
| 8 | `test-wf-http` | HTTP request midway, then Respond |
| 9 | `test-wf-secret` | Secret-protected webhook: 401 without `X-W-Flow-Secret`, 200 with it |
| 10 | `test-wf-manual` | Manual chain (`Hello Ada` → uppercase → `!`), plus run-node stepping |

## How to test from the browser

Start the server (`start.bat` or `npm start`, port 3001), then:

- **Import a workflow first** so it lives in the server store and gets a webhook URL
  (the builder creates the webhook when there's a Webhook trigger). For the webhook
  workflows, import `workflows/test-wf-echo.json` etc.
- **Webhook tester:** open `web/test-webhook.html` — pick a preset, edit the payload,
  send, see the Respond node's reply.
- **PDF analyzer:** open `web/test-pdf.html` — drop in a PDF, see the analysis.
  (Requires workflow 3 imported.)

> Note: web projects and webhooks need the workflows to be *imported/created* in the app
> first (that is where their persistent `id` comes from), which also assigns them to your
> account. The `run-tests.mjs` / `http-test.mjs` scripts do this registration temporarily.

## Quick automated checks

```
node build-test-workflows.mjs   # regenerate the 10 JSON files
node run-tests.mjs              # executor-level tests (42 assertions)
node http-test.mjs              # live HTTP webhook tests (17 assertions; server must be up)
```