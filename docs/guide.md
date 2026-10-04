# W flow — User Guide

Welcome! W flow is a **self-hosted workflow builder** in the spirit of
n8n. You place **nodes** on a canvas, connect them, and the data from one node
flows into the next — turning "when this happens, do that, then that" into an
automation you can run again and again. Everything runs on **your** machine and
**your** AI keys: no cloud account, no vendor lock-in.

This guide teaches the mental model first, then walks you through real
workflows, node-by-node references, debugging, webhooks and troubleshooting.
It is also available inside the app: **Settings → Tutorial**, and as a download from Settings.

## What can I build?

- **Webhooks** — receive HTTP calls (from other apps, scripts, Zapier-style
  services) and answer them with the result.
- **Scheduled jobs** — cron triggers that run a workflow by themselves at 09:00
  weekdays, every hour, etc.
- **AI pipelines** — feed a document, chat history or web result to an AI agent
  or chat model and act on its reply.
- **Notifiers & CRUD** — send email/Slack/Telegram/Teams messages, create
  GitHub issues, Notion pages, Stripe payment links, Google/Outlook calendar
  events, database rows and more (80+ action integrations).
- **Data plumbing** — extract text from 150+ file types, convert/compress
  files, query a database, transform JSON, branch, loop and dedupe.

## 1. Concepts at a glance

| Term | What it means |
| --- | --- |
| **Workflow** | One automation: a set of nodes connected by edges. Lives in your W flow (`Workflows` tab). |
| **Node** | A single step. It receives data, does one job, and hands data on. |
| **Trigger** | A special node that **starts** a run (manual, webhook, schedule, a service event…). |
| **Action / Logic / AI node** | Steps that do the work in the middle and at the end of a chain. |
| **Connection** | An arrow from one node's right handle to the next node's left handle. Data flows along arrows. |
| **Item** | One piece of data travelling through the workflow — a JSON object. A node can receive or emit many items (e.g. one per webhook payload, per loop iteration). |
| **Payload** | The JSON object(s) a trigger puts on the wire; downstream nodes read fields out of it. |
| **Run** | One execution of the whole workflow, from trigger to the last node. |
| **Log console** | The panel at the bottom of the editor that shows exactly what happened during a run. |
| **Manual output** | A per-node toggle that *skips* the node and feeds it fixed JSON instead — ideal for testing. |

**How a run works:**

- Every **trigger** node in the workflow fires first.
- Nodes run one at a time, **in order of the connections**: a node only runs
  when everything upstream of it has produced data for it.
- Each node can read the incoming item(s), and its output becomes the input of
  the node(s) connected to its output handle.
- **Branching nodes** (IF, Switch, Loop, JS Filter…) send items only down the
  branch they belong to — an un-taken branch simply never runs.
- If a node **errors**, the run stops there (`HALTED`): downstream nodes are
  dimmed as not reached, and the log shows a `BF-…` error code with fix tips.

> **Note:** "Item" ≈ "one JSON object". You will often see items shown as
> pretty-printed JSON in the editor (input previews, log entries) — that is the
> exact data your nodes are working with.

## 2. A tour of the editor

Open any workflow to see the editor:

- **Left — node palette.** Groups of draggable nodes: *Triggers*, *Files &
  Data*, *Actions*, *AI & Agents*, *Logic*, *Feeds & Sources* (ready-made
  RSS/Atom readers for YouTube, Reddit, GitHub releases, podcasts …) and *More
  Integrations* (Gitea, Mastodon, Groq, Brave Search …). Click a node to add it to the
  canvas, or drag it onto the canvas to drop it at that spot.
- **Canvas.** Click a node to configure it, drag between handles to connect,
  drag nodes to arrange them. A `+` on an empty canvas also opens the palette.
- **Top toolbar.** Back, the **Workspace / Executions switch**, the workflow path (`Workflows / folder / workflow`) and editable workflow name, the **webhook URL**
  (blue, when the workflow has a Webhook trigger — click the copy icon), and
  buttons: Help, Guide, Settings, Export, Import, Log, Save, **Run / Stop**.
- **Workspace ↔ Executions.** The switch in the toolbar flips the editor between
  the node canvas and this workflow's **execution history** — every recorded run
  with its source, start time, duration and errors, plus the average run time,
  failure rate and production failures. Click a run to return to the canvas with
  that run's log open in the Log console.
- **BUILD WITH AI.** The button in the **bottom-left corner of the workspace**
  opens the workflow builder agent: give it your own model credentials once
  (provider, base URL, model, API key — stored encrypted for your account), then
  describe the workflow you want. The agent receives your prompt, the workflow
  as JSON, a reference of how that JSON is written and a reference of every node
  type and agent tool, and answers with the complete new workflow, which
  **replaces the workflow you are working on** and is saved automatically. The
  answer comes with a **committed changes** list right under it — what was
  added, updated, renamed, reconnected or removed — computed by the server from
  the two versions, so you can see what the agent did before you keep working
  (and undo it from **Versions** if you disagree).
- **Node settings.** The setup opens with **Output on the left** and **Input & setup on the right**. The output side shows the node name/type, captured payload, and generated file metadata (filename, source node, path, type and size).
- **Bottom — Log console.** Appears when you press Run (or click *Log*). Shows
  every node's input/output, timing, console output and errors.
- **Workflow folders.** On the Workflows page, create a folder, choose it when creating a workflow, move existing workflows with the folder selector, or filter the dashboard by folder.
- **Roles.** When you share a workflow (Share) or a folder, you choose per person what they may do: **Can view** (open the workflow, its runs and comments), **Can view & run** (also Run, Debug and chat) or **Can edit** (change and save it, like you). You can change it any time next to their e-mail. Viewers and runners get a read-only editor: nothing can be moved, connected, deleted or saved, and a *View only* / *View & run* badge says why. Shares made before roles existed stay *Can edit*.
- **Sharing a folder.** Every folder row has a share button (⇱): the other account gets the role you pick for **every workflow inside that folder**, and a switch decides whether **subfolders are included** too. **Only one folder can be shared per account at a time** — end the current share before starting another. A shared folder is badged `SHARED` for you and appears under **SHARED WITH YOU** in the sidebar for the other user.
- **Working together.** On a shared workflow auto-saves are limited to **1 per minute** and each user has **1 manual save per minute** — the toolbar shows *MANUAL SAVE READY*, or *NO MANUAL SAVES LEFT · 42s* when it is spent (the Save button stays disabled until then, auto-save keeps saving). The node the other person is editing right now gets a small **“‹name› editing”** marker on the canvas.
- **Comments.** Open a node and press **Comments**, or click a node's 💬 badge, to discuss that step: comment, reply, **Resolve** a thread when it is done. Type **@** to mention someone who can open the workflow — they are e-mailed when the instance can send mail. Everyone with access, viewers included, can comment.
- **Changes — who changed what.** In the Log console header, **Changes** lists every save that changed the workflow, newest first, with who made it and which nodes and settings changed. **Restore** puts a single node back the way it was before that change (or removes a node that was added) — nothing else moves; save to keep it.
- **Backup & rewind.** While a workflow is shared, the toolbar has a **Backup** button. Because the shared workflow is one record, the other person's saves replace yours — open Backup to jump back to the state **about a minute ago**, to **your own last save**, or to any of the **last 10 saves** (each shows who made it and how long ago). Every save is kept in a rolling buffer tagged with its author, backups never contain credentials, and a rewind snapshots the current state first, so it can be undone the same way.
- **Repeat a workflow (Pro).** Workflow settings (gear) has a **Repeat (loop)** section: it runs the workflow again after each finish — a fixed number of times, or until you stop it. Press Run once: you see the first run in the editor and the server does the rest, even after you close the page. Up to 9 runs may follow each other directly; 10 or more runs (or a loop that keeps running) wait at least **10 seconds** between runs. Stop a running loop with **STOP** on the canvas badge, or by switching the loop off.
- **Execution mode.** The same settings panel picks how the workflow executes: **Editor** (runs when you press Run, or when a trigger fires while the server is up) or **Always on**, where the server keeps it running — loop and live triggers included — even while you are signed out. Always-on is a **Pro** feature; the switch is locked on the free plan.
- **Edit as JSON.** The **JSON** button (toolbar for the whole workflow, or in a
  node's header for one node) opens a real code editor: line numbers, folding,
  search & replace (`Ctrl/Cmd + F` / `H`), multiple cursors. Problems are
  underlined on their line while you type — an unknown node type, a missing
  setting, a value that is not allowed, a connection to a node that does not
  exist — and autocomplete (`Ctrl + Space`, or just typing) offers node types,
  settings, allowed values, node ids, branch handles and the `{{fields}}`
  earlier steps output. The same checker validates what **Build with AI**
  returns.
- **Undo / redo.** `Ctrl/Cmd + Z` and `Ctrl/Cmd + Y` (or `Ctrl/Cmd + Shift + Z`), or the toolbar arrows, step through your canvas edits. A drag or a burst of typing counts as one step, and typing inside a field keeps the browser's own text undo. For saved states use **Versions**.
- **Reference a node for the AI helper.** Open a node and press **Use as AI reference** — the node (with its settings, credentials blanked) is pinned as a chip in the **Build with AI** panel, so a request like “change this step” points at exactly that node.
- **Sticky notes.** The note button under the palette toggle opens the sticky-notes menu: add a note to label a section or leave instructions, and it stays **behind** the nodes. Each note has a colour, and a **size** — pick S / M / L / XL in the menu, or drag the grip in the note's bottom-right corner to size it freely. The size is part of the note, so it is saved/exported with the workflow.
- **Contact us.** The button at the bottom of **Settings** opens the contact form: enter your e-mail address and a message and it is sent to the operator (who can reply to your address).

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + S | Save workflow |
| Ctrl/Cmd + Z | Undo the last canvas edit |
| Ctrl/Cmd + Y (or Ctrl/Cmd + Shift + Z) | Redo |
| Delete / Backspace | Delete the selected node or connection |
| ? | Toggle the shortcuts help |
| Ctrl/Cmd + H | Open this guide |

Workflows **auto-save** shortly after every change (Settings → Defaults lets
you turn this off). Closing the tab never loses your latest edit.

## 3. Your first workflow (about 3 minutes)

1. **Workflows → New workflow**, name it (e.g. *Hello flow*).
2. Click **Add node → Triggers → Manual Trigger**. It appears in the middle of
   the canvas.
3. Add a **Logic → Set / Transform** node and connect the trigger to it: drag
   from the trigger's right handle to the Set node's left handle.
4. Click the Set node. In its fields, add one row: key `greeting`, value
   `Hello from W flow!`.
5. Add a **Logic → Console Log** node, connect the Set node to it, and set
   *Message* to `{{greeting}}`.
6. Press **Run**.

Watch the canvas: each node lights up with a spinning ring while it executes,
then gets a ✓. The Log console opens and shows what flowed through every node.
That is the whole mental model — a trigger starts a run, each node transforms
the payload, and `{{field}}` placeholders pull values out of the data.

> **Tip:** stuck or curious about a node's output? In any node's settings the
> **Input** section lists everything upstream produced, and you can click a
> field to use it directly.

## 4. Configuring a node

Open a node by **clicking it** (single click by default; switch to double-click
in Settings → Defaults if you prefer).

| Section | What it does |
| --- | --- |
| **Node name** | A label for the canvas (rename freely — it also shows in the log). |
| **Input** | (non-trigger nodes) What the node consumes and where it comes from. |
| **…grouped fields** | The node's own settings, grouped into sections (Request, Options, Credentials…). Required fields first; optional ones hide behind **+ Add optional parameters**. |
| **Output** | **Manual output** — see below. Some nodes also offer **Save output as file**. |

**Choosing what a node reads (Input section):**

| Mode | Effect |
| --- | --- |
| Everything (default) | The whole upstream payload is passed in. |
| A specific field | Only one field (e.g. `body.message`) is used — handy to feed one value to a Code or Set node. |
| Parse as JSON | The incoming text is parsed into objects first. |
| Parse as CSV | The incoming text becomes rows (`row`, `record`, `index`). |
| Raw text | Everything is flattened into a single `text` field. |
| **From which node** | Restrict input to one specific upstream node only. |

The **live preview** under the field picker shows the actual value a field will
contain before you run — no more guessing about names. The **Upstream output**
section shows the real output of every node behind the one you are configuring
(click to expand).

**Secret fields 🔒** (API keys, passwords, tokens): stored *encrypted in the
server database*, never inside the workflow JSON, never in exports or community
posts. Anyone who imports your workflow enters their own credentials.

## 5. Data, items and `{{expressions}}`

### Where the data comes from

- **Manual Trigger** — you can give it *manual output* (fixed JSON) or let the
  workflow start empty.
- **Webhook** — the incoming request becomes `body` (the JSON payload),
  `headers` and `query`. See *Webhooks* below.
- **Schedule** — `triggeredAt`, `cron` and `timezone`.
- **Service triggers** (Slack, GitHub, Gmail…) — when you press **Run** they
  emit a realistic **sample payload** so you can build and test the downstream
  logic without needing the real service.
- **Every other node** — its output object. For example the HTTP Request node
  produces `status`, `headers` and `data`; the AI agent produces `reply`.

### Reading values: `{{path}}`

Any text field that accepts data can interpolate values with double braces:

| Expression | Value |
| --- | --- |
| `{{body.message}}` | The `message` field of a webhook payload. |
| `{{headers.content-type}}` | A webhook request header. |
| `{{query.id}}` | A query-string value on a GET webhook. |
| `{{reply}}` | The AI agent / chat model's text reply. |
| `{{data.temp}}` | Nested output, e.g. the weather node's temperature. |
| `{{text}}` | The text field of an Extract File / conversion node. |

Expressions work inside JSON too: `{"comment": "Got {{body.name}}"}`. If a
field is missing or empty, it renders as nothing — no crash.

**Short names work too.** Many nodes save their answer under a field such as
`result` or `data`, so the exact path is `{{result.price}}` — but `{{price}}`
finds it as well: when the exact path is empty, the nearest field with that
name anywhere in the item is used (also inside tables / lists). The exact path
always wins when it exists.

**Drag instead of typing.** In a node's INPUT column, open an upstream node's
output and drag any field — its name or its value — onto a text setting in
NODE SETUP. It is inserted as `{{result.price}}` (the full path) where you drop
it.

> **Tip:** placeholders are plain text search-and-replace. To build JSON from
> data, put `{{...}}` inside the JSON string, as in the HTTP Request node's
> default body.

**Service nodes show their inputs as fields.** Every value a service node's
request needs (the text for Google Docs — Append Text, a document ID, a
channel, a title …) has its own box under **Parameters**. Type the value or
drag/write `{{placeholders}}` into it. Left empty, the node reads the incoming
item's field of the same name, so `text` from an earlier node still works.
The raw **Request** section (path, query, body) stays editable for advanced use.

### Fixed test data (Manual output)

Every node's **Output** section can enable **Manual output**. When on:

- the node is **skipped** during a run, and
- downstream nodes receive exactly the JSON you typed.

This is the fastest way to test a chain with known data (for example, simulate
a webhook payload) without waiting for real events — and to step past a node
that errored (see *Run next node* below).

**📌 Pin the last run's output.** After a run, the same section offers a
**Pin** button: it copies the node's real output from that run into Manual
output. Later nodes can then be built and re-run as often as you like without
calling the service again — no repeated API costs, e-mails or orders. Turn
Manual output off to run the node for real again. (The log keeps up to
*Maximum log items per node* items, so a pin holds at most that many.)

### Variables and the Test / Live environment

Values you keep under **Variables** (Main page) can be used in **any** node
field — credential fields included — as `{{$vars.NAME}}`; `{{$env}}` gives
`live` or `test`.

A variable can have a **test value** next to its normal value. A workflow set
to the **Test** environment (Workflow settings → *Environment*) uses the test
values, so one switch moves a workflow from testnet keys to real ones:

| Variable | Value | Test value |
| --- | --- | --- |
| `BINANCE_KEY` | your live API key | your testnet key |

In the Test environment, exchange orders and wallet transfers also **never
execute** — they run in test mode whatever the node says. The editor toolbar
shows a **TEST** badge while a workflow is in the Test environment.

## 6. Triggers

| Trigger | Fires when… | Testing from the editor |
| --- | --- | --- |
| **Manual Trigger** | You press Run | Always runs. |
| **Webhook** | An HTTP request hits `/webhook/<workflow-id>` | Pressing Run **waits for a real request** — see Webhooks. |
| **Schedule (Cron)** | The cron expression is due (server checks every 30 s, no Run needed) | Press Run to execute once immediately with `triggeredAt` = now. |
| **Gmail — New Email** | New mail arrives in the inbox or label and matches the filters (server checks every few minutes, **live**) | Run emits a sample message. Needs the Gmail address and an **app password** — see below. |
| **Inbound Email (IMAP)** | New mail arrives in any IMAP mailbox — GMX, web.de, iCloud, Yahoo, your own domain (**live**; Outlook.com / Microsoft 365 no longer accept passwords over IMAP) | Run emits a sample message. |
| **Slack — Message / Reacted** *(Demo)* | New message or reaction (Events API) | Run emits a sample event. |
| **GitHub — New Issue** | Issue/PR/push events (**live** via a GitHub webhook) | Run waits for a delivery; **Always listen** runs it for every event. |
| **Telegram — New Message** | Message, /command or button press sent to your bot | Run emits a sample update; **Always listen** runs it for real updates, even with the page closed. |
| **Notion — Database Update** *(Demo)* | Page added/changed in a database | Run emits a sample page. |
| **Google Sheets — New Row** | Rows are added to a tab (server checks every few minutes, **live**) | Run emits a sample row. Connect a Google account (or an API key for a public sheet); row 1 names the columns. |
| **Teams / Outlook 365** *(Demo)* | New Teams message / new Outlook mail | Run emits a sample. |
| **Stripe — Payment Event** | Checkout, invoice, payment, subscription or refund events (**live** via a Stripe webhook endpoint) | Run waits for an event — Stripe's "Send test event" works; **Always listen** runs it for every event. |
| **Jira — Issue Event** *(Demo)* | Issue created/updated | Run emits a sample issue. |
| **Discord — New Message** *(Demo)* | New message in a channel | Run emits a sample message. |
| **Google Drive — New File** *(Demo)* | A file appears in the folder | Run emits a sample file entry. |
| **RSS — New Item** | A new item appears in the feed (no key, **live**) | Run emits a sample item. |
| **HubSpot / Airtable / Supabase** *(Demo)* | New contact / record / row | Run emits a sample. |
| **Error Trigger** | Another workflow errors | Add it to a "watchdog" workflow; run emits a sample error. |
| **Crypto Price Alert** | A coin's price on an exchange rises above / falls below a level, or moves by a % (server checks every minute or more) | Run emits a sample alert. |
| **Polymarket Odds Alert** | An outcome's chance rises above / falls below a level, or moves by some points | Run emits a sample alert. |
| **Wallet Deposit** | Coins or tokens arrive in an EVM wallet (no key needed) | Run emits a sample deposit. |

Triggers marked **Demo** in the palette only fire their sample when you press
Run — they do not start a workflow by themselves yet. Use a Schedule trigger
followed by the service's "List …" node for those in the meantime.

**Gmail without handing over your password.** Reading mail through Google's
Gmail API needs "restricted" permissions that cost a yearly security audit, so
W flow reads Gmail over IMAP with an **app password** instead: turn on
2-Step Verification, create a 16-letter app password at
<https://myaccount.google.com/apppasswords>, and paste it into the trigger. It
is not your Google password, it can only be used for mail, it is stored
encrypted, and you can revoke it there at any time. IMAP must be enabled in
Gmail → Settings → Forwarding and POP/IMAP.

**Polling triggers** (Gmail, IMAP, Google Sheets, RSS, crypto) start working as
soon as the workflow is saved with its credentials — no Run needed. The first
check only remembers what is already there, so old mail or rows never fire.
Each run they start counts toward the daily run cap; checking itself is free.

The three crypto triggers fire **once per event** — crossing a level, not every
check while the price stays past it — and the first check after a restart only
records the current value.

> **Note:** pressing Run never polls the real service — the editor uses a
> sample payload (or, for Webhook, GitHub and Stripe, waits for a real
> delivery) so you can develop without external accounts or rate limits. Real
> events arrive on their own: from the background checks (Schedule, Gmail,
> IMAP, Sheets, RSS, crypto) or from the service's webhook (GitHub, Stripe,
> Telegram).

## 7. Webhooks, in depth

Webhooks let anything on the internet start a workflow and — optionally — get a
reply. The model is *receive → process → respond*:

1. A **Webhook** trigger node *receives* the request.
2. Regular nodes do the work (extract a PDF, call an AI, look things up…).
3. A **Webhook Respond** node sends the HTTP response back to the caller.

### The URL and the method

When a workflow contains a Webhook trigger, the editor's toolbar shows its URL:
`http://<your-host>/webhook/<workflow-id>`. Requests are **public** — no login
needed — but the URL only fires **while a run is waiting for it**. Press **Run**
(no test payload) on a webhook-only workflow: the toolbar pill turns green
("LISTENING") and the Log console shows **WAITING FOR WEBHOOK**. The **first**
request to arrive executes the run; afterwards the URL turns off again — a
request before Run, after the request fired, or after the wait expired
(15 minutes) gets a `409` — until you press **Run** again. Each Run listens for
exactly **one** request.

**A readable URL.** Open the Webhook node: under the URL you can set a
**custom URL part**, e.g. `my-scraper`, and the workflow then also answers on
`http://<your-host>/webhook/my-scraper`. It may contain letters, digits and
dashes, and must be unique on the instance — the editor tells you when another
workflow already uses it.

> **Note:** only a workflow whose *only* trigger is the Webhook node can listen
> this way — that is what pressing Run waits on. If the workflow has additional
> triggers (Manual, Schedule…), its URL cannot be armed; keep Webhook as the
> only trigger when you need webhook entry, or run it from the editor.

The trigger's **Method** field decides which HTTP methods are accepted. The
selector is enforced: a webhook set to `GET` only fires on GET requests, `POST`
only on POST, etc. Anything else gets a clear `405` that tells you exactly what
to send, e.g.:

```
This webhook only accepts POST requests, but you sent GET. To call it, send a
POST request with a JSON body, e.g. curl -X POST "http://localhost:3001/webhook/…"
-H "Content-Type: application/json" -d '{"message":"hello"}'. Alternatively, open
the Webhook trigger node and change its Method to GET if that is the request you
want to accept.
```

**What the trigger puts on the wire:**

| Method | Input to the workflow |
| --- | --- |
| POST / PUT / PATCH | The JSON body becomes `body`; request headers become `headers`. |
| GET | There is no body — the **query string** becomes `query` (plus `headers`). |
| DELETE | Same as GET: query string as input. |

Example — call a POST webhook:

```
curl -X POST http://localhost:3001/webhook/<workflow-id> \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","status":"success"}'
```

The workflow then reads `{{body.message}}` and `{{body.status}}`.

### Answering the caller

Add a **Webhook Respond** action node anywhere downstream of the Webhook
trigger. When the run reaches it:

- **HTTP status** — e.g. `200`, `201`, `404`.
- **Respond with** — *JSON (execution result)* wraps your body in the full
  result; *Raw response body only* sends exactly your JSON/text.
- **Response body** — supports `{{vars}}`, e.g.
  `{"analysis": "{{reply}}"}`.

The first Webhook Respond node that runs wins; if the run fails before it is
reached, the caller gets a `500` with the execution log instead of a silent
"ok" — so failures are never hidden.

### Securing a webhook

Open the Webhook trigger → **Security** → set a **Secret header value**. From
then on every request must include the header `X-W-Flow-Secret: <your
value>`, otherwise it is rejected with `401`.

### Testing a webhook workflow without external tools

1. Press **Run**. The editor switches to **WAITING FOR WEBHOOK** and shows the
   URL — it does *not* invent test data.
2. Send a real request with the correct method (see the curl examples above),
   or open the test page shipped in the project root (`pdf-analyzer.html` for
   the PDF Analyzer template — set its Method dropdown to match your trigger).
3. The run completes with your payload and the Log console shows every node.

> **Tip:** to develop the *downstream* logic before any webhook ever fires,
> open the Webhook node, enable **Manual output** and paste a sample JSON like
> `{"body": {"message": "hello"}}`. The trigger is skipped and the rest of the
> chain runs with exactly that data.

### Webhook troubleshooting

- **409 “not listening right now”** — no Run is currently waiting on this
  webhook: either nobody pressed **Run**, an earlier request already consumed
  the wait, or it expired (15 minutes). Open the workflow and press **Run** to
  re-arm the URL for one request.
- **405 “only accepts POST but I sent GET”** — browsers and address bars send
  GET. Use a real HTTP client with the right method, or set the trigger's
  Method to GET if that is what you want to accept.
- **“Workflow not found”** — the workflow id in the URL is wrong or the
  workflow was deleted. Copy the URL from the workflow's toolbar instead of
  typing it.
- **401 invalid secret** — the request is missing the `X-W-Flow-Secret`
  header (or has the wrong value).
- **No reply from the AI agent** — the agent errored (missing API key, model
  not reachable). The run stops at the agent node: open the Log console and
  read the `BF-…` error.
- **The caller got `{"ok": true}` and nothing else** — the workflow has no
  Webhook Respond node and the trigger is in *Simple 200 OK* mode. Add a
  Webhook Respond node with the body you want to return.

## 8. Logic & data nodes

| Node | What it does | Typical use |
| --- | --- | --- |
| **IF Condition** | Compares two values (equals, contains, greater than…) and routes down **true** or **false**. | Branch on `{{body.status}} = success`. |
| **Switch** | Routes to one of many cases (or default) by value. | Route by `{{type}}` to different handlers. |
| **Set / Transform** | Add, overwrite or remove fields (supports `{{vars}}`). | Enrich data, rename fields, add `processed: true`. |
| **Code (JS)** | Run JavaScript over the items (`items.map(...)`). | Anything custom. |
| **JS — Transform / Filter / Aggregate** | Point-and-click JS helpers for the same jobs. | Filter only items where `amount > 10`, etc. |
| **Loop Over Items / Loop End** | Run the nodes in between once per input item; Loop End collects the results. | Process each file / row / order. |
| **Merge** | Combine items from two branches (append/combine). | Join HTTP results with extracted data. |
| **Execute Sub-Workflow** | Run another of your workflows as a building block: each incoming item is its input, and what its end nodes output comes back here. | Build "clean up an address" once and call it from five workflows. |
| **Split Out** | Turn one item's array field into many items. | One webhook with 10 orders → 10 items. |
| **Filter** | Keep only items matching a rule. | Skip empty or already-processed items. |
| **Limit** | Keep the first N items. | Only the top 5 results. |
| **Sort** | Sort by a field (numeric/date/text). | Cheapest first. |
| **Remove Duplicates** | Dedupe by a field. | One item per customer. |
| **Extract Field** | Pull a single field out of each item. | Feed `name` into a template. |
| **Text Aggregator** | Join a field across items into one text. | Build a summary list. |
| **String Transform** | Upper/lower case, trim, replace, etc. | Normalize input. |
| **Date & Time** | Current time, format, add/subtract durations. | Timestamps for logs. |
| **Math** | Add, multiply, round… on fields. | Totals, percentages. |
| **Hash / Fingerprint** | Hash a value (md5/sha1/sha256). | Idempotency keys. |
| **Console Log** | Print a message into the Log console. | Debugging. |
| **Sticky Note** | A note on the canvas — never runs. | Documentation inside the workflow. |
| **Summarize** | Group items and aggregate per group (count/sum/avg…). | Reports. |
| **JSON — Parse / Stringify** | Turn a JSON string field into real data, or data back into a string. | Parse an API response body. |
| **Base64 Encode / Decode** | Encode text to Base64 or decode it back. | Auth headers, file payloads. |
| **Encrypt / Decrypt** | Encrypt a value with a passphrase (AES-256-GCM) or decrypt it again. | Park a secret in a sheet, read it back later. |
| **URL — Parse / Build** | Split a URL into protocol/host/path/query, or assemble one from parts. | Extract a domain, build an API URL. |
| **Do Nothing** | Pass items straight through. | Deliberately close a branch. |
| **Stop and Error** | Halt the run and mark it failed with your own message. | Reject bad input, make a test fail loudly. |
| **Wait for Approval** | Pause the run until a person approves or rejects it in the Log console. Outputs **approved** and **rejected**. | Publish / pay / delete only after a human says yes. |

## 9. Files & data nodes

| Node | What it does |
| --- | --- |
| **Extract File** | Read a file (field or named upstream file) and extract content: PDFs, Office docs, CSV/TSV, JSON, images (OCR where available), archives and 150+ types. Outputs `text`/`rows`/`structured`. |
| **Read / Write File to Disk** | Read or write files in your account's own folder on the server (`./data/files/users/<account>`; other accounts cannot see it). Files a run wrote have a **Download** link in the run log; **My files** on the main page lists all of them, and you can upload files there for Read File. |
| **List Files on Disk** | List the sandbox directory. |
| **Convert to File** | Convert text/JSON/CSV into a named output file. |
| **Compress to Archive** | Zip/gzip the files produced upstream ("Save output as file"). |
| **Data Store** | A tiny built-in key-value store (get/set/list/delete per namespace). |
| **SQL Query** | Run **read-only** SQL (SELECT / WITH / VALUES / EXPLAIN) against the built-in database — writes are blocked for safety since this DB stores accounts & secrets (the admin SQL console can write). PostgreSQL / MySQL query actions target external databases instead. |

**Storage per plan.** Your file folder (My files + Write File) holds up to
**25 MB on the free plan** and **500 MB on Pro** (the operator can change both
with `BF_FILES_FREE_TOTAL_MB` / `BF_FILES_PRO_TOTAL_MB`). When it is full, Write
File fails with a clear message and uploads on **My files** are refused —
delete files there to make room.

**Files in a chain:** nodes that produce file content (Excel/Word generation,
Convert, HTTP responses, QR Code…) offer **Save output as file** in their
Output section — give the output a name like `report.pdf`. A downstream
**Extract File** or **Write File** node can then pick that file **by name**:
with *File comes from → A file produced by an upstream node*, choose it from
the list (or click / drag one of the file chips into the box). Before the first
run the list shows the names the files will get. You can also pass files to
**Compress to Archive**. In *Field with the file* type the field's name
(`result.price`) — dragging a field in from INPUT works too. Every node's log entry lists the files it
wrote.

> **Note:** the sandbox disk and SQL store are shared across workflows on this
> instance and persist between runs. Data Store namespaces keep different
> workflows' data apart.

## 10. AI & agents

| Node | What it does |
| --- | --- |
| **AI Agent** | A full agent conversation (uses a saved agent, or an inline model + system prompt), with optional tools (HTTP, time). Outputs `reply`. |
| **Chat Model** | One-off chat completion — great for classifying or summarizing a field. |
| **Prompt Template** | Render a template with `{{vars}}` into a field. |
| **AI Output Parser** | Force the model's reply into JSON. |
| **Extract Structured Data** | Pull fields out of text into a JSON schema. |
| **Generate Image** | Text → image via your image model. |
| **Text Embeddings** | Turn text into a vector (for search). |
| **Split Text into Chunks** | Break a long text field into overlapping chunks (one item per chunk or one array). | The pre-step for embeddings / RAG. |
| **Vector Store — Save / Vector Search** | Store and search embeddings (self-hosted, in `./data/vectors.json`). |

**What a run costs:** every AI node reports how many tokens the model saw and
returned (shown per node in the log as `🧠 1 250`), and the run header adds them
up with an estimated **cost**. The prices are your own table — **Settings → AI
usage & cost** holds USD per 1M tokens per model plus a fallback (preset-filled,
fully editable); a model you have not priced is reported as *not priced*
instead of a made-up number. The Workspace page shows the workspace's total **AI
spend**.

**Keeping AI spending under control** (Settings → AI usage & cost):

- **Usage** — tokens and estimated cost per day, per workflow and per model, and
  the most expensive nodes, for the last 7, 30 or 90 days.
- **Budgets & alerts** — token and/or USD limits per day and per month for the
  whole account. When one is used up, model calls stop with `BF-5006` until the
  day or month is over, and a call never gets more output tokens than a token
  budget has left. A workflow can have its own, stricter budget under
  **Workflow settings → AI budget**. At 80 % and 100 % a warning is written into
  the run's log; switch on Telegram to also get it through a bot connected under
  Credentials. Optionally, from a percentage you choose, calls switch to a
  **cheaper model** (same provider and key) — the stop at 100 % stays.
- **In the editor**, the **AI cost** button shows what the next run will
  probably use (the average of recent runs, per AI node), what today and this
  month used, and the budgets that apply.
- **On an AI node** (section *Spending*): a **token cap per run** for that node
  across all its items, and **Reuse identical answers** — the same request
  (model, settings and messages) within a number of hours answers from the saved
  reply and spends no tokens.

**Prompting tips:**

- Be concrete about the output format — ask for a JSON object, bullet points or
  a one-line answer.
- Send **small, relevant context**: pull the field with *Input → a specific
  field* (e.g. extracted PDF `text`) instead of the whole payload.
- Click **TEST CONNECTION** under the node to verify provider/model/key before
  running the workflow.
- The provider model list is fetched live when you paste an API key — pick from
  the dropdown or type a custom model name.
- No API key? The agent errors with a clear message (see *Troubleshooting*).

## 11. Running, stopping and debugging

- **Run** executes the workflow. A **webhook-only** workflow instead switches
  to *WAITING FOR WEBHOOK* (it never invents test data).
- **Stop** replaces the Run button while a run is executing. The run halts
  after the node currently in flight: the console shows *STOPPED*, nodes that
  ran keep their ✓, everything downstream is dimmed.
- While a run executes, the **current node pulses with a loading ring** — you
  can see exactly where the workflow is, even on slow AI calls.
- The **Log console** shows, per node: duration, input items, output items,
  console output and any files written. Click an entry to expand it; drag its
  top or right edge to resize. Entries auto-scroll as the run progresses.
- **Errors**: a failed node turns red, is marked `● HALTED` (or `● FAILED`
  when its *On error* setting let the run continue) and shows the `BF-…` code
  and the error message right on the card; downstream nodes show *SKIPPED*.
  Open the node and the same error sits at the top of its settings with tips
  to fix it. The codes are listed under **Settings → Error codes** (a
  searchable list with fix tips, also in `ERRORS.md` on disk).
- **Run next node** — after a halt, set *Manual output* on the failed node and
  press *▶ Run next node* in its Output section to continue the chain from the
  next node with that fixed data (the halted node is skipped).
- **On error (every node)** — the *On error* section of each node's settings
  decides what its failure does: **Stop the workflow** (the default for
  triggers, logic and AI nodes), **Continue — pass the items on** (the default
  for action nodes: a flaky third-party API hands the items to the next node
  with an added `_error` field — message, BF code, node — so an IF / Filter can
  react, and the run is still recorded as successful) or **Retry, then stop**
  (with *attempts* and *wait between attempts*). Handled failures are marked
  `continued` in the log and counted separately from halts.
- **Replay** — every saved run remembers the input it was started with, so the
  **↻ Replay** button in the Log console header runs the workflow again with
  exactly the same payload.
- **Retry from failed node** — on a failed run, this Log console button runs
  the failed node again **with the input it had**, then everything after it.
  The nodes before it are *not* repeated, so an order, e-mail or payment they
  already made does not happen twice. (If the run had more items than the log
  keeps, use Replay or raise *Maximum log items per node*.)
- **Debug** — the button next to Run starts a step-by-step run: it pauses
  **before every node** and shows the input that node is about to receive.
  **Next node** runs it and pauses again, **Continue** runs the rest without
  pausing, **Stop** ends the run.
- **Item counts on connections** — after a run every connection shows how many
  items passed through it; hover the label to see the first item.
- **Failure alerts** — Workflow settings → *Failure alerts* sends you an e-mail
  and/or a Telegram message when the workflow fails with an unhandled error.
  By default only runs nobody was watching alert (schedules, triggers,
  webhooks, background loops, AI tools), at most once per 15 minutes per
  workflow. *Send test alert* checks the channels.
- **Wait for Approval** — a run that reaches this node pauses, and the Log
  console shows **Approve** / **Reject** buttons with your message. The run
  continues down the *approved* or the *rejected* output. If nobody answers
  within the node's *give up after* minutes, the *when nobody answers* setting
  applies (fail the run, or treat it as rejected / approved) — so an unattended
  webhook, schedule or Telegram run never hangs forever. A timeout that fails
  the run is reported as `BF-7003`.
- **Versions** — the editor toolbar's **Versions** button lists every earlier
  state of this workflow (a snapshot is taken whenever a save changes the
  nodes or connections). Restore any one — restoring snapshots the current
  state first, so it is undoable too. Snapshots never contain credentials.
- **Export / Import** — export a workflow as JSON (credentials are stripped),
  share the file, import it from the W flow or by dropping the `.json` onto
  the dashboard (that creates a new workflow).
  **Dropping a `.json` onto the canvas merges it in:** on an empty canvas the
  file becomes the workflow; on a canvas that already has nodes your workflow
  stays exactly as it is and the imported nodes are placed **next to it**, with
  their own settings and connections, so you can combine two workflows into one
  without rebuilding either of them. The same applies to the toolbar's
  **Import** button and the settings panel's import.
- **User Templates** — publish a workflow as a template so anyone on this
  instance can browse and import it (a template carries no credentials, so the
  importer enters their own). Credentials and secrets are removed automatically
  on publish — and so are **personal values**: recipients (To / Cc / Bcc /
  From / Reply-To), chat IDs, phone numbers, logins, server hosts and wallet
  addresses, marked **PRIVATE** in the node settings. A value made only of
  placeholders such as `{{body.email}}` stays, so templates keep working.
  The same applies to **Export JSON**; your own saved workflow keeps everything.
- **Settings → Defaults** lets you change log verbosity (items per node),
  auto-save and click-to-open behaviour.

## 12. Credentials, privacy and where data lives

- Workflows and agents are **private per account**: other accounts cannot see,
  edit or run them (they get 404).
- Webhook URLs stay **public** so external services can trigger them.
- **Run history is kept for 30 days**, then deleted automatically (the operator
  can change this with `BF_EXECUTION_RETENTION_DAYS`; `0` keeps it forever).
- **Your data, your call.** **Settings → Account → Export** downloads everything
  your account owns as one JSON file (workflows without their credentials,
  agents, runs). **Delete account** (asks for your password) erases the account
  with all of its workflows, agents, credentials, variables, data tables, files,
  run history and sessions — nothing is kept.
- Node credentials are encrypted in the database (`workflow_secrets` /
  `agent_secrets` tables, AES-256-GCM). The workflow JSON on disk never
  contains them; exports and community posts scrub them.
- **Google and Microsoft nodes sign in with your account, not a password.**
  Gmail, Google Drive / Sheets / Calendar / Docs …, Outlook, OneDrive,
  SharePoint, Planner and the other Microsoft 365 nodes show a
  **Connect Google** / **Connect Microsoft** button. It opens the provider's
  own consent screen once; W flow keeps the connection encrypted in your
  credential vault and renews its access on every run, so nothing expires
  overnight. Several nodes can share one connection, a node that needs an extra
  permission shows **Reconnect**, and deleting the connection under
  **Credentials** disconnects it. Pasting an access token by hand still works
  as an advanced fallback.
- **On w-flow.tech, Connect Google covers Gmail — Send, Google Sheets, Google
  Docs and Google Calendar.** Those are the only Google permissions the
  cloud's sign-in is verified for. The other Google nodes (reading or labelling
  Gmail, drafts, Drive, Slides, Contacts, BigQuery, …) take a pasted access
  token there. A self-hosted copy uses its own Google client, so every Google
  node can connect on it.
- **Connected accounts** (top of **Credentials**) lists every service the
  operator has set up — Slack, GitHub, Notion, Dropbox and the rest — with a
  **Connect** button, so you can sign in once without opening a node first.
  One connection then works on all of that service's nodes.
- **Telegram bots** are connected with the token from **@BotFather** (Telegram
  has no sign-in screen for bots): **Connect Telegram** on any Telegram node or
  under Connected accounts. To link your own Telegram account, send the bot a
  message and press **Find my chat** on the node; it fills in the chat ID.
  **Or use your own Telegram account:** set **Connect as** to *My Telegram
  account* and press **Log in to Telegram**. Either **scan the QR code** with
  the Telegram app on your phone (Settings → Devices → Link Desktop Device) —
  no code needed — or enter your phone number, the code Telegram sends and
  your 2-step password if you have one. The login shows **where Telegram sent
  the code** (the Telegram app, SMS, a call or e-mail) and offers another way
  when Telegram allows it. (On a self-hosted
  instance the operator sets up one Telegram app under admin panel → Auth &
  e-mail → Telegram; until then each user is also asked for their own API ID
  and hash from my.telegram.org → API development tools.) Messages are
  then sent and received as you — use it for your own chats, not bulk messages,
  or Telegram may ban the account. Disconnecting logs W flow out of it.
- **Slack as yourself:** Slack send / update nodes have **Send as: The bot /
  Me**. "Me" posts under your own name (accounts connected earlier need one
  Reconnect to allow it).
  With the Telegram nodes (send text, photos, files, audio / video, polls and
  locations, buttons and reply keyboards, edit / delete / pin, answer button
  presses, set the bot's command menu, download files) and the trigger's
  **Listen for** choice (messages, /commands, button presses), you can build a
  complete bot.
- Files/vectors/data-store live in `./data/`; the SQLite database (accounts,
  sessions, settings, secrets, subscriptions) is `./data/admin.db`. Delete
  `data/` to reset everything.
- Admins can run the whole database on **PostgreSQL** instead of SQLite by
  setting `DATABASE_URL` (admin panel → Deployment, or `.env`). An existing
  SQLite installation is moved over with one command — stop the app, then
  `npm run db:migrate -- --url postgres://user:pass@host:5432/wflow` (add
  `--dry-run` to preview). Every table is copied, the target schema is created
  for you, and the old `admin.db` is opened read-only and left in place, so
  deleting `DATABASE_URL` and restarting is a full rollback. Your `./data`
  folder — encryption key, JSON stores, uploads — stays where it is on either
  engine, so never throw it away when you migrate.
- Admins can switch workflow storage to the SQL database (admin panel → Cloud
  servers → Workflow storage) — each workflow then gets a code and survives on
  the server/cloud; the toggle migrates existing workflows both ways.
- **Setting up a self-hosted copy.** Download the installer under **Settings →
  Self-hosted** (Windows `.bat`, macOS `.command`, Linux `.sh`). It asks where
  the copy lives, which port it uses and where data is stored, and writes the
  copy's own `.env` with a fresh encryption key. Afterwards the copy's
  **Setup** page (`/setup`, only for the account that set it up) changes it
  any time without editing files: **Storage** — a database file on that
  machine or a PostgreSQL server you run; **Execution** — run workflows on that
  machine or send them to a *runner* (the same app on another server, joined
  with a shared token). Changes are written to `.env` and apply after a
  restart.
- **Self-hosted licence.** Running a copy on your own machine or server is part
  of Pro (one account) and the Team plan (as many accounts as you bought). The
  installer writes your licence key into the copy's `.env`; you can also paste
  it on the copy's **Setup** page (key from **Settings → Self-hosted** on
  w-flow.tech). The copy checks the key every few hours — it sends **only the
  key**, never accounts, workflows or credentials — and keeps working for three
  days without a connection. When the plan ends the copy locks: it runs no
  workflows and shows a lock screen, but deletes nothing.
- **Updates for a self-hosted copy.** The copy learns about a new version at
  its regular licence check. Its owner sees a banner and an **Updates** card on
  the **Setup** page: **Update now** downloads the new version with the licence
  key, keeps `.env` and `./data` exactly as they are, installs and restarts
  (about a minute). If the new version does not start, the previous one is put
  back automatically (details in `.wflow-update/`). A copy run from a git
  checkout updates with `git pull`, a Docker copy with
  `docker compose pull && docker compose up -d`. A copy installed before
  one-click updates existed needs one manual reinstall with a fresh installer.
- **Team plan.** On the Pro page choose how many accounts you need and send a
  request; it is confirmed by hand with a price, then you can buy it. In the
  cloud every account you list is Pro. On your self-hosted copy you are its
  admin: **Setup** picks the server, database and runner for everyone, and
  **Team** lists every account, lets you share some of your credentials and
  variables (members use them without seeing the secret), mark members as
  *restricted* (only shared credentials, no own ones) and see where each
  account's runs send and fetch data — with an optional list of allowed
  addresses for restricted members (calls elsewhere fail with `BF-3006`).
- **Move a copy to the cloud.** On w-flow.tech open **Settings → Self-hosted →
  Create a move code**, then paste it on the copy's **Setup** page (or its lock
  screen) under **Move to the cloud**. Your workflows, agents, credentials,
  variables and data tables are copied once, over HTTPS, into that cloud
  account; the copy keeps everything. Each account on a team copy moves with
  its own code.
- **Moving single workflows by hand.** The two installs keep
  their own `./data` folder, so nothing is shared automatically — you can carry
  workflows across as JSON. On the source install open a workflow and use
  **Export JSON** (Workflow settings), then on the target import it from the
  dashboard or drag the `.json` onto the canvas (**Settings → Account** also
  exports *all* your workflows as one file — take the entries of its
  `workflows` array). Credentials never travel: every export blanks them, so
  enter each node's API key once on the new install and it is encrypted there.
  The same steps move data in either direction (cloud → self-hosted or back).
- The background **cron scheduler** fires Schedule triggers on their own
  (disable with `DISABLE_SCHEDULER=1`).

## 13. Troubleshooting (FAQ)

- **My webhook returns 405.** The request method does not match the trigger's
  Method. Read the error — it includes the exact curl command to send.
- **The webhook runs but the AI agent didn't answer.** Open the Log console:
  the agent node usually failed (missing API key, provider unreachable, model
  name wrong). Fix the node config, or enable *Manual output* on it to test the
  rest of the chain.
- **Extract File says “no file found”.** The node cannot see a file at the
  configured path/field. Check *Input → Upstream output* to see what the
  upstream node actually produced, and that `sourceField` matches (e.g. the
  webhook sends `body.pdf` → use `body.pdf`).
- **A node never runs.** Either it is not connected to the workflow (when the
  canvas has a trigger, only nodes reachable from a trigger run — anything left
  lying around is skipped), the run halted at an upstream error (look for
  HALTED), or its branch got no items (an IF/switch case that didn't match).
- **My scheduled workflow doesn't fire.** Check the cron expression
  (`min hour day month weekday`), the timezone field, that the server is
  running with the scheduler enabled, and see the workflow's `triggeredAt` when
  it does run.
- **Where did my API key go after I exported / shared?** Nowhere — keys are
  encrypted server-side and intentionally left out of exports and community
  posts. Re-enter them after importing on a new instance.
- **Why does the Pro page say “opens next month”?** Every account starts on
  the free plan and the operator keeps Pro sales **closed** until they decide
  to open them. When the Pro page shows the “Subscriptions open next month”
  card, no one can subscribe yet — the operator flips the **“Accept Pro
  subscriptions”** toggle in the admin panel (Billing tab) and users can buy
  from the Pro tab immediately. Your free account is unaffected either way.
- **Write File fails with BF-6005.** *Field with the file* needs the **name**
  of the field holding the content (`result.price`), not a value. A dragged-in
  `{{result.price}}` works too; text with several `{{fields}}` is written as
  the file's text. The error names the field it looked in and the fields the
  item actually has.
- **Where do I see why a run failed?** On the canvas: the failed node turns red
  and shows its `BF-…` code and message. Open it — the error and how to fix
  it are at the top of its settings.
- **My self-hosted copy says it is locked.** Its Pro / Team plan ended, or it
  could not confirm the licence for three days. Renew on w-flow.tech and press
  **Check again** on the lock screen, or paste the current key from
  **Settings → Self-hosted**. Nothing on the copy was deleted.
- **Sign-up on my self-hosted copy says it is full.** The plan covers a fixed
  number of accounts (Pro: one). Buy a Team plan with more accounts.
- **The app says BF-…** — every code has a full explanation + fix tips under
  **Settings → Error codes**.

## 14. Templates, errors and the account-wide error handler

**Templates.** The Workflows page has a **Templates** button (and one on the
empty state). Each card is a ready-to-run skeleton — a chat assistant on your
own model, webhook → Google Sheets → Slack, a daily RSS digest by e-mail, AI
inbox triage, an hourly API health check with alerting, an account-wide error
alerter, an approval-before-publish flow, free text → Notion and a RAG ingest
pipeline. Picking one creates a normal workflow of your own (in the folder you
are viewing) with empty credentials and the required keys listed on the card —
edit it like anything else.

**One error handler for the whole account.** Put an **Error Trigger** in a
workflow and it becomes your error workflow: whenever one of your *other*
workflows finishes with an **unhandled** failure, that workflow runs and gets
one item describing the failure — the workflow (id, name), the failing node
(id, name, type), the error (message + `BF-…` marker) and the run (source,
timing, node/error counts). Nothing else to configure: save it and it is armed.
A failure that a node already handled with *Continue on error* does not trigger
it, a failing workflow never triggers itself, and the handler does not consume
your daily run allowance — so `⚠ {{workflow.name}} failed in
“{{error.nodeName}}” ({{error.marker}}): {{error.message}}` is all you need in a
Slack or e-mail node.

**Not the same thing:** *Wait for Approval* is for a run **you want** to pause
for a decision; the *Error Trigger* is for runs that already broke.

## 15. Crypto, AI tools and dashboards

**Exchanges.** Coinbase, Binance, Kraken, Bybit, OKX and KuCoin nodes read
prices without a key and, with an API key, read balances and open orders and
place, check or cancel market and limit orders. **Wallet** nodes read any EVM
address's coins and tokens (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB
Chain) and send them with the wallet's private key; the Solana wallet node is
read-only. **Polymarket** searches markets and reads odds, order books, price
history and a wallet's positions.

Everything that moves money has three guards:

1. **Test mode** is on by default — the order or transfer is checked, not sent.
2. **Spending limits** — *Max amount per order* and *Max total per day* (in the
   node's own amount unit, resetting at midnight UTC). An order above a limit
   stops with `BF-6011` before anything is sent.
3. The **Test environment** (section 5) forces test mode for the whole workflow.

Use API keys without withdrawal rights, and a separate wallet that holds only
what the workflow needs.

**AI tools (MCP).** Switch *Offer this workflow as a tool to AI assistants* on
in a workflow's settings and describe what it does. Inputs are optional:
without them a Form trigger's fields (or a Chat trigger's message) become the
tool's inputs, and any other trigger simply receives whatever the assistant
sends. Name inputs yourself to ask for something specific — each can be text,
a number, yes/no or one of a list, marked required and given an example.
Numbers and yes/no values are converted, and a call without a required input
is refused before anything runs. *Answer fields* optionally describe what the
tool returns.

Then create a token under **Settings → AI tools** and add the server URL
(`https://<your W flow>/mcp`) with the header `Authorization: Bearer <token>`
to an MCP client such as Claude Code or Cursor. Create one token per assistant
or machine; each has a name and:

- an **access level** — *Run offered tools* (only the workflows you offer),
  *Read* (also read your workflows, the node catalog and the workflow
  reference, and check workflow JSON) or *Build* (also create, change and run
  any workflow — for coding agents that build workflows for you),
- a **scope** — all workflows, or only the ones you pick,
- an optional number of **runs per day**.

The assistant sees each offered workflow as a tool; calling it runs the
workflow with the inputs (like a webhook body) and returns a Webhook Respond
node's body, or the last node's output, as text and as JSON. With a Read or
Build token it also gets the `wflow_*` builder tools. A run that takes longer
than about 25 seconds answers with a run id, and `wflow_get_run` fetches the
result later. Every call shows up in **Executions** as *AI tool*, with the
tool, the token, the arguments and the answer. Tool runs count toward the
daily run allowance.

**Dashboards.** The **Dashboard — Add to Chart** node saves a number from each
run to a chart (line, bars or a big number) on a dashboard page. The first run
creates the page; its link is in the node's output as `dashboardUrl`. Anyone
with the link can view it — the link is long and random. **Settings →
Dashboards** lists your dashboards and deletes them (which disables the link).

**Crypto templates.** *Crypto price alert to Telegram*, *Weekly DCA buy (test
mode)*, *Polymarket odds tracker dashboard* and *Wallet deposit notification*
are under **Templates → Crypto**.

## 16. Next steps

- Try the example flows in this guide, then publish your own to **User
  Templates**.
- Open the workflow settings (gear) to rename, export, import and publish.
- Deployment, environment variables and the admin panel are covered in the
  `README.md` at the project root.
- Full error-code reference: `ERRORS.md` on disk or **Settings → Error codes**
  in the app.
