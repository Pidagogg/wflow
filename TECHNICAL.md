# W flow

A **self-hosted workflow builder** in the spirit of n8n, with a clean drafting aesthetic. Design automations on a node canvas, wire up triggers and
actions, call AI models with your own credentials, and build simple AI agents
with tools — all running locally, no cloud required.

**Your data, your rules.** W flow cares about your data and privacy: credentials are encrypted, workflows are private
until you share them, personal values are stripped from anything you publish, and you decide what is stored, shared and
connected — including exporting or deleting all of it.

![stack](https://img.shields.io/badge/stack-React%20%2B%20Express%20%2B%20React%20Flow-4fd1ff)
![licence](https://img.shields.io/badge/licence-Elastic%202.0-4fd1ff)

**Source-available** under the [Elastic License 2.0](LICENSE): read it, run it,
change it and self-host it for yourself or your company. Offering it to others
as a hosted service, or removing the licence-key checks, is not allowed. The
hosted version lives at [w-flow.tech](https://w-flow.tech).

---

## ✨ Features

### Workflow builder (n8n-style canvas)
- **473 node types** across seven groups, added via a searchable, centered node picker (click or drag onto the canvas) — including 244 external-service integrations and 18 ready-made feed readers (email, messaging, CRMs, cloud storage, commerce, marketing, analytics, AI providers, …) that run as real, authenticated API calls through one shared request engine
- **Triggers (28):** Manual, Webhook, Schedule (cron), **Chat**, Form, Execute-Workflow, Gmail (IMAP), Inbound Email (IMAP), Slack (Message / Reaction), GitHub, Telegram, Discord, Notion, Google Sheets, Google Drive, Teams, Outlook 365, Stripe, Jira (issue events), RSS, HubSpot, Airtable, Supabase, Error trigger, **Crypto Price Alert**, **Polymarket Odds Alert**, **Wallet Deposit**
- **Triggers wait for their input** — pressing Run on a workflow whose triggers are all non-manual never invents test data. An inbound HTTP trigger (Webhook / GitHub) waits for the real request, a **Chat Trigger** opens a chat panel, and every other trigger (Slack, Gmail, Schedule, RSS, …) shows an **input panel** in the Log console where you paste the event payload that should run the workflow. A workflow that contains a **Manual trigger** still executes immediately
- **Chat panel** — a workflow with a **Chat Trigger** gets a **Chat** tab in the Log console: type a message, the workflow runs once per message, and a **Chat Output** node posts the reply back into the panel. The conversation is mirrored into the Execution tab so chat and node log sit side by side
- **Files & Data (8):** **Extract File** (one universal node for **150+ common file types** — pick the file from base64, text, a JSON value, a URL or an upstream node, and return text / structured data / table rows / archive entries / metadata), **Read File from Disk** and **Write File to Disk** (a sandboxed `./data/files` folder), **List Files on Disk** (one item per file), **Convert to File** (TXT / JSON / CSV / HTML), **Compress to Archive** (ZIP / GZ), **Data Store** (persistent key-value store, n8n/Make style), **SQL Query** (run **read-only** parameterized SQL — SELECT / WITH / VALUES / EXPLAIN — against the built-in SQLite database, same DB as the login, with named `:params`; writes are blocked for safety since the DB holds accounts & secrets, and workflows can be triggered by public webhooks)
- **Named files between nodes:** any node that produces file content — Extract File, Word / Excel file generation, HTTP Request, Code (JS), Convert to File, Compress — has a **“Save output as file”** setting. Give the output a name (e.g. `report.pdf`), and a downstream node can request that file **by name** instead of by payload field. Extracted rows save as real CSV, structured data as JSON, Word/Excel keep their binary format; the run log shows which files each node wrote
- **Your own file folder** — every account's file nodes work in its own folder (`./data/files/users/<account>`), so no account sees another's files. **My files** on the main page lists, downloads, deletes and uploads them; files a run wrote get a **Download** link in the run log. Storage per plan: **25 MB free, 500 MB Pro** (`BF_FILES_FREE_TOTAL_MB` / `BF_FILES_PRO_TOTAL_MB`) — a full folder fails Write File with a clear message instead of a silent `written: false`
- **Picking an upstream file** — with *File comes from → A file produced by an upstream node*, the file nodes list every file the earlier nodes produce (dropdown plus clickable / draggable chips; before the first run the names they will get). *Field with the file* takes a field name (`result.price`) and also accepts a dragged-in `{{field}}`; mixed text with `{{fields}}` is written as the file's text, and a missing field is reported with the field it looked in and the ones the item has (`BF-6005`)
- **Actions (97):** HTTP Request (auth, retries, query params, response parsing), Webhook Respond, Send Email (SMTP), Slack (webhook or Bot API), Discord, Telegram, Teams Message, Outlook 365 Send Email / Create Event, Mailgun / SendGrid / Resend Email, Twilio SMS, **Vonage SMS**, **WhatsApp — Send Message (Meta Cloud API)**, **AWS SNS Publish (SigV4-signed)**, **GraphQL Request**, Stripe Payment Link, GitHub Issue / Pull Request / Release, GitLab Issue, **Linear Issue**, Jira Issue, **Todoist / ClickUp — Create Task**, Notion Page / Query DB / Update Page, Airtable Record / Read / Update / **Delete**, **Pipedrive Deal**, HubSpot Contact, Salesforce Contact, Trello Card, Asana Task, Supabase Row / Read / Update, MongoDB Find / Insert, X (Twitter) Post, Google Calendar Event, Google Drive Upload / List, Google Sheets Read / Append / **Update Row**, **Google Search (Custom Search API)**, **YouTube Search**, Dropbox Upload, **S3 Upload**, **WebDAV Upload**, OneDrive / SharePoint Upload + List Item, Planner Task, Excel Online Add Row, Excel / Word file generation, Mailchimp Subscriber, Zendesk Ticket, PagerDuty Incident, **Opsgenie Alert**, **Pushover / ntfy Notification**, **PostgreSQL — Query** / **MySQL — Query** (connect to external databases), **Shopify — Create Product**, **RSS Feed Read** (RSS / Atom), **QR Code — Generate (no key)**, **DeepL Translate**, **Wikipedia / Hacker News / Reddit search (no key)**, **TinyURL Shorten (no key)**, **Random Data (no key)**, Weather, Crypto live price (no key), **Coinbase / Binance / Kraken / Bybit / OKX / KuCoin — prices, balances and orders (test mode by default)**, **Crypto Wallet — EVM (balances, send coins and tokens) and Solana (read-only)**, **Polymarket — markets, odds, order books, positions (no key)**, **Dashboard — Add to Chart (shareable chart pages)**, IP geolocation (no key), WordPress Post, Hash / Fingerprint
- **Logic (31):** IF condition (incl. regex & not-contains), Switch (route by value to a per-case output or a default), Set/Transform (with JSON value parsing), Code (JS, async supported), Loop, Loop End, Merge, Console Log, JS Transform / Filter / Aggregate, **Split Out** (list field → one item per element), **Summarize** (group by field + sum/avg/count/min/max), **Filter** (keep items matching conditions), **Date & Time** (now / format / parse / add / subtract / difference), **Math**, **Text Aggregator** (combine a field from all items into one value), String Transform, Limit, Sort, Remove Duplicates, Extract Field, **Do Nothing** (a deliberate no-op step), **Stop and Error** (end a run on purpose with your own message), **Wait for Approval** (pause the run until a person answers in the editor — with a timeout and a "when nobody answers" setting), **JSON — Parse / Stringify**, **Base64 Encode / Decode**, **Encrypt / Decrypt** (AES-256-GCM with a passphrase you supply), **URL — Parse / Build**, Sticky Note
- **AI nodes (10):** Chat Model (with JSON mode), AI Agent, Prompt Template, Generate Image, AI Output Parser (JSON / key-value / regex), Text Embeddings, Vector Store — Save, Vector Search, Extract Structured Data (JSON schema → structured output), **Split Text into Chunks** (the model-free pre-step for embeddings / RAG / long-document summarising)
- **Centered config modals** — single-click a node to open its editor (double-click shows the shortcut), with collapsible sections and a **“+ Add optional parameters”** toggle so the form stays short. An **input section** lets you pick which node to read from (all upstreams or one specific node), what to consume (whole payload, a specific field, parsed JSON, CSV, raw text), and click an exact field from that node — with a live preview of the value it will use
- Real **webhook endpoint** per workflow: `POST /webhook/:workflowId` (optionally protected by an `X-W-Flow-Secret` header). The URL is **inert until you press Run**: Run on a webhook-only workflow registers a one-shot listener (the Log console shows **WAITING FOR WEBHOOK** with the URL), the **first** request executes it, and afterwards the URL refuses further calls (409) until you press Run again. Flick the trigger's **"Always listen (while the server runs)"** option on and the URL stays armed continuously — it runs the workflow for every request even when nobody is in the editor, as long as the server is running. The trigger's **Method** selector is enforced (a `GET` webhook only fires on GET, `POST` only on POST, etc.). A **custom URL part** (e.g. `/webhook/my-scraper`, unique per instance) can be set on the Webhook node next to the id-based URL
- **Background scheduler (cron + RSS + Telegram)** — Schedule (cron) triggers fire on their own, **RSS triggers poll their feed**, and **Telegram triggers with "Always listen" on long-poll their bot**: the server scans saved workflows every 30 s, executes any workflow whose cron expression is due, runs any RSS-trigger workflow when its feed gains new items (the first poll after a restart only records a baseline, so old items never fire), and runs Telegram-trigger workflows for each new bot message. Secrets are hydrated per workflow and each run executes as its owner. Disable with `DISABLE_SCHEDULER=1`
- **Repeat (loop) a workflow (Pro)** — Workflow settings have a **Repeat** section: the whole graph runs again after each finish, a set number of times or until you stop it. Press Run once: the first pass shows in the editor and the server runs the rest, even with the page closed (STOP on the canvas badge ends it). Up to 9 runs may follow each other directly; 10 or more runs, or an endless loop, wait at least 10 s between runs
- **Execution mode — Editor / Always on (Pro)** — Workflow settings pick how the workflow executes: **Editor** (runs when you press Run or a trigger fires while the server is up) or **Always on**, where the server keeps it running — including its repeat loop and live triggers — **even while you are signed out**. Always-on execution is the **Pro** perk: free accounts see the switch locked with an upgrade note, and the server refuses the setting (403) for them, so the gate is real and not just UI
- **Workflow storage — device or SQL database** — where saved workflows live is a toggle on the admin **Cloud servers** page. Default: on this device (`./data/workflows.json`, zero config). Turn on **"Save workflows in the SQL database"** and every workflow is stored in the `workflows` table of your database (SQLite or PostgreSQL) with an **assigned code** per workflow, so workflows live on the server/cloud and can be fetched again by code (`GET /api/workflows/by-code/:code`). Switching storage migrates existing workflows automatically — nothing is lost
- Real **execution engine** — run a workflow and inspect per-node input/output, durations, errors and console output in the resizable **Log console** (opened from the toolbar). Every error has a **code** (`BF-…`) shown next to it; the full explanations live under **Settings → Error codes** and in [ERRORS.md](./ERRORS.md)
- **Failures show on the canvas** — a node that failed turns red and shows its `BF-…` code and message right on the card (`● HALTED`, or `● FAILED` when its *On error* setting let the run continue); opening it shows the same error with fix tips at the top of its settings
- **Workflow JSON in a real code editor** — the **JSON** button (whole workflow or one node) opens a CodeMirror editor with line numbers, folding, search & replace and multiple cursors; the shared workflow validator underlines problems on their line as you type, and autocomplete offers node types, settings, allowed values, node ids, branch handles and upstream `{{fields}}`
- **Connected accounts instead of pasted tokens** — Google, Microsoft and 20+ other services connect through their own consent screen once (**Connect …** on a node or under Credentials → Connected accounts); tokens stay encrypted in the vault and are refreshed on every run. Telegram bots connect with their @BotFather token, a personal **Telegram account** logs in by **QR code** or phone number + code (the login says where Telegram sent the code), and Slack nodes can post **as you** instead of the bot
- **Execution history** — every run (editor Run, webhook, chat, schedule, Telegram) is saved per workflow in the SQL `executions` table. The Execution menu shows the recent runs with source, time, duration and errors; click one to reopen its full log, and **Replay** re-runs the workflow with exactly the input that run was started with. History is owner-scoped and removed with the workflow
- **Per-node error handling — on every node** — the **On error** section of each node's settings decides what a failure does: **Stop the workflow** (the default for triggers, logic and AI nodes), **Continue** (the default for action nodes — a flaky third-party API hands the items on with an added `_error` field — message, BF code, node — so an IF / Filter / error workflow can react, and the run is still marked successful) or **Retry, then stop** (choose the attempts and the wait between them). The Log console marks handled failures with *continued* and shows how many errors were handled instead of halting the run
- **Error Trigger — one error handler for the whole account** — a workflow that contains an **Error Trigger** becomes your error workflow: whenever one of your *other* workflows finishes with an unhandled failure, that workflow runs and receives one item describing it (workflow id/name, failing node id/name/type, the error message + BF code, and the run's source/duration/counts). Nothing else to wire up — save the workflow and it is armed. Handled errors never trigger it, a failing workflow never triggers itself, error-workflow runs never chain, and the handler runs without consuming your daily run allowance
- **Wait for Approval — human-in-the-loop** — the **Wait for Approval** node pauses a run and the Log console shows **Approve** / **Reject** buttons (with the message you configured). The run continues down the **Approved** or the **Rejected** output. Nobody answers in time? The node's *when nobody answers* setting applies — fail the run, treat it as rejected or approved — so an unattended webhook / schedule / Telegram run can never hang forever
- **AI usage & cost** — providers already report how many tokens every call used; every AI node now returns that figure, the log entry shows it per node (`🧠 150`), and the run header totals it with its estimated **cost**. The prices are **your own table** (Settings → AI usage & cost: USD per 1M tokens per model, plus a fallback, preset-filled and fully editable), so nothing is hard-coded and an unpriced model is reported as *not priced* instead of a wrong number. The Workspace page adds an **AI spend** statistic for the whole workspace
- **Workflow version history** — every save that changes the graph snapshots the state the workflow was leaving, so **Versions** in the editor toolbar lists them (time, node/connection counts, what saved it) and any one can be **restored** — including a rewrite made by the AI builder. Restoring snapshots the current state first, so it is undoable too; snapshots never contain credentials
- **Starter templates** — the Workflows page has a **Templates** button (and one in the empty state) with ready-to-run skeletons: a chat assistant on your own model, webhook → Google Sheets → Slack, an e-mail RSS digest, AI inbox triage, an hourly API health check with alerting, an account-wide error alerter, an approval-before-publish flow, free text → Notion, and a RAG ingest pipeline. Each card lists the credentials it needs; picking one creates a normal workflow you own and can edit
- **AI workflow builder — “Build with AI”** — a chat agent that writes and edits the workflow you are working on. The button sits in the **bottom-left corner of the workspace**; press it, describe what you want (“every weekday at 9, fetch the RSS feed and email me the new items”), and the agent returns a complete workflow JSON that is **imported onto your canvas automatically** — then auto-saved, so you can keep editing or press Run right away. Every user brings **their own model**: the panel asks for provider, base URL, model and API key (your credentials, stored **encrypted per account**, never sent to anyone but the provider you chose), with a live model list and a test button. Each request sends the prompt, the current workflow as JSON and generated **reference documents** — how the workflow JSON itself is written (nodes, handles, `{{placeholders}}`, the rule that the answer is a diffed whole graph) plus every node type and every AI-agent tool — and comes back as validated workflow JSON. The chat then shows **what the agent committed**: the server diffs the answer against the workflow you had (added/removed/updated nodes, renames, new and dropped connections) instead of trusting the model's own description, and node types the builder does not have are dropped and reported back to you
- **Give the AI helper a reference node** — every node's config modal has a **Use as AI reference** button: it pins that node (with its exact settings, credentials blanked) to the **Build with AI** chat as a chip above the prompt, so "change this step" means precisely the node you picked instead of whatever the model guesses. Pinned references are sent with the request and shown as chips until you unpin them
- **Switch between Workspace and Executions in the editor** — a segmented control in the toolbar flips the editor between the node canvas and this workflow's **execution history**: runs recorded with source, start time, duration, node and error counts, a **failure rate**, production failures and the **average run time**. Click any run to jump back to the canvas with that run's full log open in the Log console. The Execution menu inside the Log console now also shows the average run time of the recorded runs
- **Workspace statistics on the Workspace page** — six live numbers across all your workflows: **Prod. executions** (every run nobody started by hand — webhooks, schedules, chat, Telegram), **Failed prod. executions**, **Failure rate**, **Time saved** (an estimate: the production runs × the assumed manual handling time, minus the machine time they took; tune it with `BF_MANUAL_MINUTES_PER_RUN`, default 5 minutes), **Run time (avg.)** and **AI spend** (tokens used by every run, priced with your own cost table)
- **Evaluation menu** — define automated tests per workflow (a trigger payload plus an optional assertion on a node's output: *contains* / *equals* / *must succeed*), run them all, and see pass/fail with durations. A failing test can be opened straight in the Log console. Tests are stored on the workflow, so they travel with export/import
- **Clickable breadcrumb** at the top of the editor — every part of the workflow's folder path opens that folder on the dashboard
- **Main page and welcome page** — the top bar is **Home · User Templates · Pro**, and the logo goes to the main page. The main page (`/home`) is the workspace hub: a tool switcher with live counts — **Credentials** (store API keys, tokens and passwords, encrypted in the SQL database), **Workflows**, **AI Agents**, **Executions**, **Variables** and **Data Tables** — plus workspace statistics. The welcome page (`/`) is the public preview for visitors; signed-in accounts see their account, plan, the cloud and self-hosted entries there. The legal pages (Impressum / Datenschutz) are linked from the welcome page (top bar + footer) and the cookie banner. Everything your account owns is one click away, and nothing sits in the top bar anymore
- **Self-hosting (Pro / Team)** — **Settings → Self-hosted** downloads a one-file installer for Windows (`.bat`), macOS (`.command`) or Linux (`.sh`). It installs the app on any machine or server, asks for folder, port, role (builder / runner / both), where runs execute and where data lives, and writes the copy's own `.env` (fresh encryption key, its licence key). Afterwards the copy's **Setup** page (`/setup`) changes storage (SQLite file or your PostgreSQL) and execution (this machine or a remote runner) any time. The bundle never contains `./data` or `.env`, and the copy sends **nothing but its licence key** to w-flow.tech:
  - **Licence** — the copy checks its key every 6 h (3 days offline grace) and **locks** when the Pro / Team plan ends: no runs, a lock screen, nothing deleted (`BF-1005`)
  - **One-click update** — the copy learns the newest version at that check; the owner's **Update now** (Setup page or banner) downloads it with the licence key, keeps `.env` / `./data`, runs `npm ci` + the build and restarts; a version that does not start is rolled back automatically. Git checkouts and Docker copies are told to use `git pull` / `docker compose pull`
  - **Move to the cloud** — a one-time code from cloud **Settings → Self-hosted** pasted on the copy copies that account's workflows, agents, credentials, variables and data tables into the cloud account (the copy keeps everything)
  - **Team admin** — on a Team plan the buyer is the copy's admin: seats cap the accounts, the **Team** page (`/team`) shares a pool of the admin's credentials and variables, marks members as *restricted* (pool only), shows every outside address each account's runs sent data to or fetched from, and can limit restricted members to an allowed host list (`BF-3006`)
  - Single workflows still move as JSON (**Export JSON** / import); credentials are blanked in every export
- **Data tables — build them by hand or import a CSV** — the **Data Tables** workspace tool keeps small spreadsheets in the SQL database, one set per account. Create a table **from scratch** (pick a name and its comma-separated columns) or **import a CSV / TSV**: paste the text or choose a file, pick the delimiter (comma, tab, semicolon, pipe — or auto-detect, quoted fields with embedded separators and line breaks are handled) and whether the first row holds the column names. Importing into an existing table appends the rows and adds any column the file brings along
- **Service icons** — wherever an external service is named — the Google / GitHub login buttons, the node palette, the canvas node and the node config modal — a small brand mark appears next to it (real Google / GitHub marks, a coloured monogram for the rest), so the service is recognisable at a glance
- **Admin operations** — the admin panel adds focused tabs: **VPS & Docker** (exact fast-deploy commands plus a **Dev VPS** staging subsection), **PostgreSQL** (clear setup for the bundled Docker service, a hosted connection string, and a **Patroni** high-availability guide), **Kubernetes** (build + push + generated manifests), **Nginx & TLS** (copy-paste Nginx site + certbot), **Alerts** (server-down monitoring with an operator e-mail), **Backups** (scheduled snapshots of `./data` with one-click download / restore) and **Journal** (every database contact, batched and flushed to the `db_events` table). Every panel includes step-by-step instructions
- **Settings** (top-right gear) — default options (open config on click, auto-save, max log items) plus a searchable **error-code reference** with solve tips
- **Manual output on every node** — the **Output** section of every node's settings lets you toggle on a fixed JSON output: the node is **skipped** during the run and downstream nodes receive the manual data (great for testing a chain with fake data), with a **“Run next node”** button to step the workflow forward
- **Undo / redo on the canvas** — `Ctrl/Cmd + Z` and `Ctrl/Cmd + Y` (or `Ctrl/Cmd + Shift + Z`), plus toolbar buttons, step back and forth through your edits. Changes are coalesced, so a node drag or a burst of typing is **one** undo step rather than fifty, and while you are typing in a field the browser's own text undo wins. The history is per editor session and separate from the workflow's **Versions**, which keeps the saved states
- **Resizable sticky notes** — the sticky-notes menu (the note button under the palette toggle) adds annotations that sit **behind** the workflow, and each note can be **resized**: pick a preset (S / M / L / XL) in the menu or drag the grip in the note's bottom-right corner. The size lives on the note, so it is saved, exported and restored with the workflow
- **Delete button under every node** — hover a canvas node and remove it (and its connections) with one click, no need to open its config
- Templating with `{{field}}` placeholders between nodes
- Export/import workflows as JSON — the Workflow settings panel has **Export JSON** and **Import JSON** buttons, and you can **drag & drop** a `.json` file onto the W flow dashboard (creates a new workflow) or straight onto the canvas — on an empty canvas the file *becomes* the workflow, on a canvas that already has nodes its nodes are **merged in** automatically (your workflow stays untouched and the imported steps land next to it, keeping their own settings and connections)
- **Workflow folders** — create folders on the Workflows page, assign workflows while creating them or from each workflow card, and filter the dashboard by folder
- **Debug mode** — the **Debug** button runs the workflow step by step: it pauses before every node and shows the input it is about to get; *Next node* / *Continue* / *Stop*. After any run, each connection is labelled with the number of items it carried (hover for the first item)
- **Retry from failed node** — a failed run can be re-run from the node that failed, with the input it had; the nodes before it are not repeated (no duplicate orders, mails or charges)
- **Pin output** — one click copies a node's last real output into its Manual output, so later nodes can be built without calling the service again
- **Failure alerts** — per workflow, an e-mail and/or Telegram message when it fails unattended (schedule, trigger, webhook, background, AI tool), at most one per 15 minutes
- **Variables + Test / Live environments** — `{{$vars.NAME}}` works in every field, credentials included; a variable can carry a test value, and a workflow switched to *Test* uses those and never executes orders or transfers
- **AI spending control** — a usage dashboard (per day, workflow, model and node), token/USD budgets per day and month for the account and per workflow with a hard stop (`BF-5006`), alerts at 80 % / 100 % in the run log and optionally on Telegram, an optional cheaper-model fallback, a per-node token cap, optional reuse of identical answers, and an *AI cost* button in the editor that estimates the next run
- **Spending limits** — exchange and wallet nodes take a max amount per order and a max total per day (`BF-6011`)
- **Workflows as AI tools (MCP)** — `POST /mcp` lets Claude Code, Cursor and other MCP clients run the workflows you opt in (typed inputs, structured answers, long runs answer with a run id) and, with a *Read* or *Build* token, read the node catalog and build, change and run workflows through the `wflow_*` tools. Named tokens under Settings → AI tools, each with an access level, a workflow scope and an optional daily run limit; every call is listed in Executions
- **Workflow reference for AI agents** — `/docs/workflow-reference.md` (linked from `/llms.txt`) documents the JSON format, how data moves between nodes, what every node accepts and outputs, and complete examples; `/schema/workflow.schema.json` is the JSON Schema, referenced by `$schema` in exported files so VS Code checks them. The built-in AI builder reads the same reference and re-checks its own answer with the workflow validator before applying it
- **Sharing with roles, comments and history** — share a workflow or folder as *view*, *view & run* or *edit* (enforced on the server, read-only editor for the first two); comment on nodes with replies, resolving and @mentions (e-mailed when SMTP is set up); a *Changes* panel next to the Log console shows who changed which node and restores a single node
- **Dashboards** — the Dashboard node charts a number from each run on a shareable page at `/d/<id>` (line, bars or a big number)

The app opens with a public read-only preview. Visitors can browse the product overview and node count, but protected navigation opens the authentication modal. After login, the private Workflows, AI Agents and User Templates areas become available.

- The **public site is visible before login** — visitors see a read-only product/W flow preview and a top-right **Log in / Create account** button. Workflows, AI Agents, User Templates, editing, running and publishing remain unavailable until authentication.
- Every account is stored in the **SQL database** (`data/admin.db`, table `users`) with scrypt-hashed passwords; sessions are httpOnly cookies stored in `user_sessions`. Registering a new user inserts a row, logging in verifies it.
- **Workflows and AI agents are private per account** — each user only sees, edits and runs the workflows and agents *they* created. Other accounts' items are invisible (404), the AI Agent node can only reference your own agents, and the first account to register adopts any data that existed before logins were introduced. Webhook URLs stay public (no login) but only fire while a Run is actively waiting on them — press Run to listen for exactly one request.
- **Account settings** — in the main site's **Settings → Account** tab you can change your display name, email and password (changing the password signs out other sessions). The **admin panel's Account tab** does the same for the admin credentials (username + password). All credentials live in the SQL database, hashed with scrypt.
- The admin panel (admin.bat) has a **Users** list (delete accounts) and a **SQL console** to inspect the same database — see *SQL database setup* below.

### Login & user accounts (SQL)

- **No external service is needed.** The app uses **SQLite**, which is built into Node.js (`node:sqlite`) — zero setup, zero cost, zero accounts. The database file is `./data/admin.db` and holds the admin settings, the user accounts and their sessions.
- It also holds **`workflow_secrets`** and **`agent_secrets`** — every credential you type into a workflow node (AI model keys, HTTP auth, Slack / Telegram tokens, …) or into a saved agent, stored **encrypted at rest** and tied to the workflow / agent (and its owner). They are re-injected when you open, run or chat, but never exported and never shared via community posts.
- **Sign-in options** — email + password out of the box; optional **password reset** and **e-mail verification** (SMTP configured on the admin **Auth & e-mail** tab or via `SMTP_*` env vars — without SMTP the links are written to the server console), and optional **Google / GitHub login**. Set the OAuth client credentials on the admin **Auth & e-mail** tab (secret encrypted at rest) or via `GOOGLE_CLIENT_ID/SECRET` / `GITHUB_CLIENT_ID/SECRET` — panel values win, no restart needed. The buttons appear on the login card once a provider is configured; the panel shows the exact redirect URI to register with each provider, and the **Public URL** field there is the external origin used for those redirect URIs and the e-mail links (`BF_PUBLIC_URL` fallback)
- **Optional: sign in through Supabase** — let Supabase Auth run extra social logins (Discord, Apple, LinkedIn, Slack, …) and **passwordless e-mail links**, without giving up local accounts: Supabase only verifies the address, the account and everything it owns stay in your own database. Configure it on the admin **Auth & e-mail** tab or with `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_PROVIDERS`. Walkthrough: **[docs/supabase.md](./docs/supabase.md)**
- **Your data** — Settings → Account downloads a JSON export of everything your account owns (Art. 20 GDPR; credentials blanked) and can delete the account together with its workflows, agents, credentials, connected accounts, variables, data tables, file folder, AI settings and run history (Art. 17 GDPR)
- **Run history is kept for 30 days** and then pruned automatically (`BF_EXECUTION_RETENTION_DAYS`, `0` = forever)
- **Cookies & local storage** — a visitor sees a **cookie notice on the first visit** with *Necessary only* / *Accept all*; the choice is remembered in `localStorage` + a small cookie and can be changed any time in **Settings → General → Cookie choice**. Only technically necessary cookies are ever set without a choice.
- **Delete your published templates** — your profile lists the templates you published, each with a **Delete** button that takes it off the community feed (the author-only `DELETE /api/community/:id`)
- The admin panel's **Page setup** tab has a **Hide the subscription (Pro) page and all legal pages** switch: when on, the Pro tab, the legal footer/login links and the `Impressum / Datenschutz` URLs are removed (the URLs return 404)
- Workflows can **read** the same database with the **SQL Query** node (e.g. `SELECT * FROM users`) — it is read-only by design (SELECT / WITH / VALUES / EXPLAIN) so a workflow can never tamper with accounts, sessions or secrets; only the admin panel's SQL console can run writes.
- **Optional: move the database to the cloud** (e.g. so logins work from anywhere). The easiest free option is [**Turso**](https://index.trygravity.ai/go/15928ffb-af1e-4913-9b6c-f148a803c74d) — hosted SQLite with a free tier (no credit card). If you do, swap `node:sqlite` for the `@libsql/client` driver and point it at your Turso URL + token (env vars `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`).

### User Templates — shared workflows
- A **User Templates** tab lists templates other users on your instance have published; **search** by title, description or author and **import** any post as your own workflow in one click. Templates carry no credentials, so you enter your own after importing
- Publish from any workflow: **Workflow settings → Share with the community** — give it a title + description and post it. **API keys, passwords and webhook URLs are automatically removed** from the shared copy so credentials never leak (they are not even stored inside the workflow itself — see *Workflow credentials* below)
- You can remove your own posts at any time

### Collaboration — users, folders & shared editing
- **Share a folder, not just a workflow.** The explorer's folder rows have a share button (⇱) that opens the folder's share dialog: the other account gets **edit access to every workflow inside the folder**, exactly like sharing a single workflow. A switch decides whether **subfolders** (and the workflows inside them) are shared too.
- **Only ONE folder can be shared per account** at a time — a second folder share is refused with a clear message naming the folder to end first, so it is always obvious what is shared. The shared folder carries a `SHARED` badge; the recipient finds it in the sidebar under **SHARED WITH YOU**.
- **Save limits** — auto-saves are capped at **1 per minute** for every workflow. On a shared workflow each user additionally has **1 manual save per minute**: the toolbar shows `MANUAL SAVE READY` while it is available and `NO MANUAL SAVES LEFT · 42s` with a live countdown once spent, and the Save button is disabled until the budget is back (auto-save keeps persisting your changes). The server enforces the same limits.
- **You can see where the other person is working** — while a shared workflow is open, every editor reports which node it has open, so the node the other user is editing gets a small **“‹name› editing”** marker (and a dashed outline) on the canvas.
- **Backup & rewind (shared mode)** — because a shared workflow is ONE record, a collaborator's saves replace yours. The toolbar's **Backup** button (shown while the workflow is shared) opens **Backup & rewind**: jump back to **about a minute ago**, to **your own last save** (skipping everything the other person did), or to any of the **last 10 saves**, each labelled with who made it and when. Every save lands in a rolling buffer (the newest 50 per workflow) tagged with its author, credentials are never part of a backup, and rewinding snapshots the current state first — so a rewind can be rolled back too.

### Contact form (Settings → Contact)
- A button at the **bottom of the Settings menu** opens the **contact form page**: signed-in users enter their e-mail address and a message, which is e-mailed straight to the operator.
- The recipient address is set in the **admin panel → Auth & e-mail → *Contact form e-mail*** (falling back to the SMTP *From* address, or the `CONTACT_EMAIL` env var). Whenever a message cannot be e-mailed (no contact address, no SMTP, or a send failure) it is written to the server log instead, so nothing is lost.

### Pro subscription (Stripe + crypto)
- **Everyone starts on the free plan.** A fresh install has sales **closed** by
  default: new accounts have no subscription, so the free-plan caps
  (10 workflows / 50 runs per day) apply automatically — nothing to configure.
- **Pro is €9.99 / month, sold on the Pro tab** through Stripe Checkout
  (card details never touch this server). Connect Stripe in the **admin panel
  → Billing (Stripe) tab** (secret key, publishable key, webhook secret and a
  recurring price id — values are encrypted at rest).
- **Sales gate — “Pro opens next month”.** While the Billing tab's
  **“Accept Pro subscriptions”** toggle is off, the Pro page shows a disabled
  *“Subscriptions open next month”* card and `POST /api/billing/checkout`
  refuses with `403` — no one can subscribe. When your launch month is over,
  flip the toggle on in the admin panel and users can subscribe immediately.
- **Self-service billing:** Pro accounts manage themselves through Stripe's Billing Portal
  (`POST /api/billing/portal` — card, invoices, cancellation) and can cancel / resume
  right on the Pro page (`/api/billing/cancel`, `/api/billing/resume`); a cancellation keeps
  Pro active until the period end, then the webhook switches the account back to free.
- Stripe sends lifecycle events to `/api/billing/webhook`
  (`checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_succeeded`); an active or
  trialing subscription lifts the free-plan caps for that account.
- **Pay with crypto (NOWPayments).** A second, card-free checkout for the same
  Pro plan: switch it on in the **admin panel → Billing tab → Crypto payments**
  (API key + IPN secret, encrypted at rest) and the Pro page gains a
  *Pay with crypto* button (`POST /api/billing/crypto/checkout` → a hosted
  NOWPayments invoice for BTC / ETH / USDT / …). NOWPayments posts its IPN to
  `/api/billing/crypto/webhook` (HMAC-SHA512 verified); a finished payment
  sets the account to Pro for one month. Crypto subscriptions do **not** renew
  automatically — each period is a new payment — and IPN redeliveries are
  de-duplicated by payment id.
- **Pro can also be granted without Stripe** — the admin panel's **Users** tab
  has a role selector per account; set it to **premium** (`pro_user`) and the
  account is Pro immediately, with no subscription and no restart. Both the
  server (caps, self-hosted installer, background execution) and the UI
  (`GET /api/billing` reports `active`, `plan: "pro"` and
  `source: "role"`) honour it, so the Pro switches unlock the same way a paid
  subscription does.

### Custom Team plan
- On the Pro page the buyer chooses **how many accounts** the plan covers and sends a request (`POST /api/billing/team/request`). It is **e-mailed to the operator** (`TEAM_REQUESTS_EMAIL`, default `main@w-flow.tech`) and **cannot be bought until the operator approves it** in the admin panel → **Team plans** tab with a monthly price (or declines it — the buyer is e-mailed either way).
- An approved plan is bought by card (Stripe Checkout with that price; the webhook activates it via `metadata.team_id`) or marked **paid by hand** for some months (invoice / transfer). It lives as long as the buyer's subscription, or until `paidUntil`; **End plan** stops it at once.
- In the **cloud** the buyer lists the other accounts by e-mail and each of them is simply Pro. On the buyer's **self-hosted copy** the licence carries the seats and the buyer is its admin (see *Self-hosting* above).
- Team requests live as one JSON list in the settings table — no schema change on either database.

### AI agent builder
- Build agents with a **model provider of your choice** — you enter the credentials/API key yourself:
  OpenAI, Anthropic, Google Gemini, OpenRouter, Mistral, Groq, DeepSeek, xAI (Grok), Together AI, Perplexity, Cohere, Hugging Face, Cerebras, NVIDIA NIM, Fireworks AI, SambaNova, GitHub Models, Voyage AI and Jina AI (embeddings), LM Studio (local), Ollama (local) or any OpenAI-compatible endpoint
- **Paste your API key → the model dropdown loads live** from the provider's own `/models` endpoint (OpenAI, Anthropic, OpenRouter, Groq, …) and the **base URL is filled in automatically** from the provider default — in both the agent builder and the AI nodes in the editor. Add any other OpenAI-compatible endpoint under **Custom**
- **Auto-save** — pasting credentials into an agent (or an AI node in a workflow) is persisted automatically (Settings → auto-save), so keys are never lost. Keys for saved agents live in the **`agent_secrets`** table and keys typed on **workflow nodes** (e.g. the AI Agent node's *Configure a model here*) live in **`workflow_secrets`** — both **encrypted in the SQL database**, never in the JSON files
- System prompt, temperature, max tokens, conversation memory
- **Tools:** the agent can autonomously call an HTTP request tool and/or a current-time tool (real function/tool calling loop)
- **AI Agent node sources:** in any workflow, the **AI Agent** node can run a **saved agent**, a **model configured inline**, or a **foreign agent reached over an HTTP API** (bring your own Agent API / custom platform endpoint) — send a request body with `{{vars}}` and read a reply path from the response
- Live **chat test panel** with visible tool runs
- Agents are usable inside workflows via the **AI Agent** node

### W flow / drafting design
- **Flat dark-blue workflow-builder aesthetic (n8n-style)**: very dark navy surfaces (`#0a0f1d`–`#111a2e`), white text and a single blue accent — no gradients, no glows, no skeuomorphism. The canvas keeps a quiet drafting frame with corner brackets; the surrounding chrome is clean, flat panels with hairline borders. Typography uses **Helvetica** for readable UI text and **Courier** for code and logs
- Credentials are stored on **your own server only**, **encrypted in the SQL database** (`agent_secrets` for saved-agent keys, `workflow_secrets` for keys typed on workflow nodes) — never inside the JSON files. Exported workflows and community posts therefore never contain them

---

## 🚀 Quick start

> **Licence key needed.** Every installation except the official cloud at
> [w-flow.tech](https://w-flow.tech) is a self-hosted copy and runs with a
> **Pro or Team licence key** (Pro page on w-flow.tech). On first start the app
> shows a lock screen where you paste it, or set `WFLOW_LICENSE_KEY` in `.env`.
> Sign-in, the licence and Setup work without one; everything else waits for it.

```bash
npm install
npm run dev
```

- Frontend: **http://localhost:5173**
- API / webhooks: **http://localhost:3001**

For production-style serving (single process, serves UI + API):

```bash
npm run build
npm start          # serves the built UI + API on http://localhost:3001
```

### Double-click launchers
- **Windows:** double-click `start.bat`
- **Linux / macOS:** `./start.sh`

Both install dependencies, build the UI and start the server on **http://localhost:3001**.

### Self-host with Docker

```bash
docker compose up -d --build
# open http://localhost:3001
```

- The container runs the backend + UI on port `3001` and **persists your data** (workflows, agents, API keys) in `./data` on the host via a volume.
- `PORT=3001` is configurable in `docker-compose.yml`.
- The image is multi-stage (build → slim `node:22-alpine` runtime) with a healthcheck on `/api/nodes`.
- On a server with a public IP, put it behind a reverse proxy (Caddy / Nginx) for TLS.
- See **[docs/docker.md](./docs/docker.md)** for the operational walkthrough —
  running it locally with no VPS or domain yet, day-to-day commands, a
  troubleshooting table, and the HTTPS steps for when a domain exists.

> **Note:** most service triggers (Gmail, Slack, Notion, Sheets, Teams, Outlook,
> Stripe, Jira, …) are fully configurable (credentials, filters) and only receive
> input — pressing Run **waits** instead of inventing a payload: an inbound HTTP
> trigger (Webhook / GitHub) waits for the real request, a **Chat Trigger** opens
> the chat panel, and any other trigger opens an **input panel** where you paste
> the event payload to run with (its shape is still shown by the input overview
> in the node config). A **Manual trigger** executes immediately.
> Triggers that execute **for real**: Manual, Schedule (cron), Webhook (HTTP
> request), RSS (feed polling), the crypto price / Polymarket odds / wallet deposit
> triggers (polling) — and the **GitHub** and **Telegram** triggers
> when their **"Always listen (while the server runs)"** option is on (GitHub
> receives signed webhook deliveries at `/webhook/:workflowId`; Telegram
> long-polls the bot). Action nodes that call
> external APIs (Teams, Twilio, SendGrid, Stripe, …) make real requests with the
> credentials you enter.

---

## 🚀 Production — w-flow.tech on the STRATO VPS

The live instance runs at **https://w-flow.tech** on a STRATO VPS (Docker + Caddy, automatic HTTPS).
Everything is pre-configured in `.env.production.example` and `deploy/`. Fill in `deploy/vps.env` with the VPS IP, then run
`bash deploy/deploy.sh`. The full walkthrough (DNS, admin panel, legal details, STRATO AVV) is in
**[docs/strato-vps.md](./docs/strato-vps.md)**.

## 🚀 Deployment — VPS + Cloudflare + PostgreSQL

The app is production-ready out of the box: a single Node process serves the UI
and API, data persists in `./data`, and everything is configurable via `.env`
(see [.env.example](./.env.example)).

### 1. Get a server (VPS)
Any Linux VPS works (2 GB RAM is plenty). Install Docker and Docker Compose:

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. Run the app

```bash
git clone <your-repo-url> wflow && cd wflow
cp .env.example .env
# optional: edit .env (PORT, TRUST_PROXY, DATABASE_URL, BF_ENCRYPTION_KEY)
docker compose up -d --build
```

- The app is now reachable at `http://<server-ip>:3001`.
- Your data (workflows, agents, API keys, SQLite DB) lives in `./data` on the
  host — back it up, or use the optional PostgreSQL below.
- Set `TRUST_PROXY=1` when you put a proxy (Cloudflare, Caddy, Nginx) in front
  so rate limiting sees real client IPs.

### 3. PostgreSQL (optional but recommended)

By default accounts/sessions use **SQLite** (`./data/admin.db` — zero setup). To
use PostgreSQL instead, uncomment the `postgres` service in `docker-compose.yml`
and set `DATABASE_URL` in `.env`:

```env
DATABASE_URL=postgres://wflow:change-me@postgres:5432/wflow
```

(For a hosted database — e.g. Supabase, Neon, RDS — use its connection string
instead of the compose service.) The schema is created automatically on first
start; the `pg` driver is already in `package.json`. Everything else — accounts,
sessions, the admin panel, the **SQL Query** node — works the same against
PostgreSQL (the SQL Query node supports `:name` / `@name` parameters there — read-only there too).

**Already running on SQLite? Move your data over — nothing is lost.**

```bash
# 1. stop the app (SQLite checkpoints its WAL on shutdown)
npm run db:migrate -- --url postgres://wflow:change-me@localhost:5432/wflow
# 2. put the same URL in .env (or admin panel → Deployment), then start again
#    DATABASE_URL=postgres://wflow:change-me@localhost:5432/wflow
```

It copies every table — accounts, sessions, settings, execution history,
credentials, variables, data tables, the events journal — recreates the schema
itself, and is safe to re-run (rows already present are left alone). The old
`./data/admin.db` is opened **read-only** and never deleted, so removing
`DATABASE_URL` and restarting rolls back to SQLite. Add `--dry-run` to see what
would be copied first. Keep the `./data` folder either way: the encryption key
(`.secret`), the JSON stores and uploaded files live there, not in the database —
without `.secret` every encrypted credential becomes unreadable.

In Docker, use the *bundled* Postgres service (it has no published port, so the
command runs inside the app container and uses the service name):

```bash
docker compose up -d postgres
docker compose exec wflow npm run db:migrate -- --url postgres://wflow:change-me@postgres:5432/wflow
```

### 4. Cloudflare

- **DNS:** point a domain (e.g. `flow.example.com`) at your server's IP, proxy
  mode (orange cloud) enabled so Cloudflare terminates TLS and shields the
  origin.
- **Option A — Cloudflare Tunnel (no open ports):**
  ```bash
  cloudflared tunnel --url http://localhost:3001
  ```
  Or configure a named tunnel to route `flow.example.com` → `http://localhost:3001`.
- **Option B — classic reverse proxy:** forward port 443 → 3001 with Caddy
  (automatic TLS) or Nginx, then enable **Full (strict)** SSL mode in the
  Cloudflare dashboard.
- Set `TRUST_PROXY=1` in `.env` and recreate the container: `docker compose up -d`.

### 5. Production checklist

- [ ] `TRUST_PROXY=1` (behind Cloudflare / any proxy)
- [ ] `BF_ENCRYPTION_KEY` set and backed up (encrypts sensitive DB values)
- [ ] Strong passwords on the login accounts; set `BF_ADMIN_USERNAME` /
      `BF_ADMIN_PASSWORD`, or change the generated first admin password (printed
      once in the log) in the admin panel
- [ ] `./data` backed up (or PostgreSQL with its own backups) — and the
      encryption key copied along with the database (`./data/.secret`)
- [ ] HTTPS enforced (Cloudflare proxy or Caddy/Nginx)

### 6. Admin panel access on a hosted server

The admin panel is a **separate server on its own port (3002)** — it is never
mounted on the main site, so it cannot be reached from `flow.example.com`. To
reach it when the app runs on a server, pick one of these (or combine them):

**Option A — IP allowlist ("only from my PC").** Set `ADMIN_ALLOWED_IPS` in
`.env` to your IP(s) / subnets. Everyone else gets `403` before they even see
the login page.

```env
ADMIN_ALLOWED_IPS=203.0.113.7          # just your IP
ADMIN_ALLOWED_IPS=203.0.113.0/24,2001:db8::/32   # ranges allowed
TRUST_PROXY=1                          # set when behind Cloudflare/Caddy/Nginx
```

Then expose port 3002 (firewall / reverse proxy / Cloudflare Tunnel) and open
`http://your-server:3002` — or a subdomain, see Option C.**Option B — loopback only + SSH tunnel (strongest and the default).** The panel listens only on the server itself; reach it through an encrypted tunnel from your PC:


```env
ADMIN_HOST=127.0.0.1
```

```bash
# from your PC:
ssh -L 3002:localhost:3002 user@your-server
# then open http://localhost:3002 in your browser
```

**Option C — subdomain with its own protection.** Point `admin.yourdomain.com`
at the server's port 3002 (reverse proxy or Cloudflare Tunnel) and protect it
with **Cloudflare Access** (free — email/identity login instead of an IP) or a
Caddy `basicauth` rule. Keep `ADMIN_ALLOWED_IPS` set to your IPs as a second
defence layer.

> **Always** set `BF_ADMIN_USERNAME` / `BF_ADMIN_PASSWORD` in `.env` (or change
> the credentials in the panel's **Account** tab): the fallback credentials are
> public in this repo and are what a fresh database is seeded with. The panel
> prints a warning when they are still active.

---

## 🚀 Deploy on AWS (EC2)

The same VPS flow works on AWS. The admin panel runs as a separate server on
port **3002**, so you can use it on AWS exactly like on any other VPS — the
easiest and safest way is an SSH tunnel (no open ports, no IP guesswork).

> See [docs/workflow-builders.md](./docs/workflow-builders.md) for a survey of
> the builders W flow is modelled on — Zapier, Make, Pipedream, Activepieces,
> Langflow and Gumloop — their features worth copying and the problems worth
> avoiding.
>
> See [docs/aws.md](./docs/aws.md) for the full AWS guide — the EC2 steps, how
> to use the admin panel after deploying, how to make changes to the site once
> it is live, and the security review (SSRF guard, admin exposure, TLS, data
> durability, open registration). The same guide is interactive inside the
> admin panel under **Deploy · AWS** (paste your instance IP → it generates the
> exact SSH / deploy / admin-tunnel commands).

### 1. Launch an EC2 instance

- **AMI:** Ubuntu 24.04 (or 22.04) LTS.
- **Instance type:** `t3.small` / `t3.medium` (2 GB RAM is plenty).
- **Storage:** 20 GB gp3 (your `./data` folder — workflows, agents, SQLite DB —
  lives on this disk; back it up or attach an EBS snapshot policy).
- **Security group — inbound:** `22` (SSH, from your IP only) and `3001`
  (the app; or keep it closed and put Cloudflare Tunnel / Caddy in front).
  Do **not** open `3002` publicly unless you also set `ADMIN_ALLOWED_IPS`
  (option B below).
- **Key pair:** create one and keep the `.pem` — you need it for SSH.

### 2. Install Docker and start the app

```bash
ssh -i your-key.pem ubuntu@<instance-public-ip>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu   # log out and back in afterwards

git clone <your-repo-url> wflow && cd wflow
cp .env.example .env
# edit .env: PORT, TRUST_PROXY=1, BF_ENCRYPTION_KEY, BF_COOKIE_SECURE=1,
# BF_ADMIN_USERNAME / BF_ADMIN_PASSWORD (else a random one is printed once),
# BF_ALLOW_REGISTER=0 (private instance) and BF_BLOCK_PRIVATE_URLS=1 (blocks
# workflow calls to metadata/private addresses — see docs/aws.md)
docker compose up -d --build
```

The app is now at `http://<instance-public-ip>:3001` (put Caddy/Nginx or a
Cloudflare Tunnel in front for HTTPS and set `TRUST_PROXY=1`).

### 3. Use the admin panel on AWS

**Option A — SSH tunnel (recommended, no open ports).** Set
`ADMIN_HOST=127.0.0.1` in `.env`, restart, then from your PC:

```bash
ssh -i your-key.pem -L 3002:localhost:3002 ubuntu@<instance-public-ip>
# open http://localhost:3002 in your browser
```

**Option B — IP allowlist.** Keep the panel on `0.0.0.0`, add an inbound rule
for `3002` restricted to **your** public IP, and set `ADMIN_ALLOWED_IPS` in
`.env` to that same IP (everyone else gets `403`).

Either way, the panel uses its own admin login (seeded from
`BF_ADMIN_USERNAME` / `BF_ADMIN_PASSWORD`), CSRF protection and rate limiting.

### 4. Optional: AWS-managed PostgreSQL (RDS)

Create a small RDS PostgreSQL instance, put its connection string in `.env` as
`DATABASE_URL=postgres://wflow:…@<rds-endpoint>:5432/wflow` (the schema is
created automatically on first start), and keep `./data` for files only. The
admin panel, accounts, sessions and the SQL Query node all run against RDS the
same way they do against the built-in SQLite.

---

## 🚀 Deploying from GitHub

### Is it safe to push this repo to GitHub?

Yes — **no passwords, database, or user data is committed**. The upload
checklist is enforced by `.gitignore`:

| Path | Contents | Pushed? |
| --- | --- | --- |
| `data/` | SQLite DB with accounts/sessions, encrypted keys, workflows, agents, the `.secret` encryption key | ❌ ignored |
| `.env` | secrets for your deployment (`DATABASE_URL`, `BF_ENCRYPTION_KEY`, …) | ❌ ignored |
| `dist/`, `node_modules/` | build output & dependencies | ❌ ignored |
| `server.log` | runtime logs | ❌ ignored |
| `src/`, `server/`, `shared/`, `tests/` | the source code | ✅ committed |

Only source code and config templates go up. The only "secret" in the repo is
by design: the **default admin credentials** used to seed a fresh database —
set `BF_ADMIN_USERNAME` / `BF_ADMIN_PASSWORD` in `.env` on every public
deployment (see *Admin panel access* above). User accounts and credentials
never live in the repo: they are created at runtime in `./data` on your server.

### Can I deploy it on Vercel?

**No — Vercel is the wrong fit for this app.** It is a serverless platform
built for short request/response functions, and this app needs three things
Vercel does not provide:

1. **A persistent disk.** Accounts, sessions, workflows, agents and encrypted
   credentials all live in `./data` (SQLite + JSON files). Vercel's filesystem
   is ephemeral — the database would be wiped on every deploy and not shared
   between function instances. Registration/login would not survive a redeploy.
2. **A long-running process.** Schedule (cron) triggers and in-app background
   work need a process that stays alive; Vercel functions are short-lived and
   have execution time limits that arbitrary workflow runs would hit.
3. **A second port.** The admin panel is a separate server on port 3002.
   Vercel only exposes one HTTP entry point — the admin panel cannot run there
   at all.

Even with the database moved to a cloud Postgres, the admin server and the
file-based features (read/write files, Data Store, vectors) would not work.

### What should I use instead?

Keep the **VPS + Docker Compose** setup from above, or use a PaaS with a
**persistent disk**. This repo ships a **Render starter template** (`render.yaml`):

1. Push this repo to GitHub.
2. On [render.com](https://render.com) → **New → Blueprint** → pick the repo.
3. Render starts two services sharing one disk: the public site and the admin
   panel (set `ADMIN_ALLOWED_IPS`, `BF_ADMIN_USERNAME`, `BF_ADMIN_PASSWORD`
   and `BF_ENCRYPTION_KEY` in the dashboard before first deploy).

Railway, Fly.io and similar container platforms with volume mounts work the
same way — mount a volume at `<repo>/data` and the app persists everything.

---

## 🧭 Using it

1. **Workflows** tab → **New workflow** (or open an existing one) → you land straight in the editor
2. Click **Add node** (toolbar or the `+` on the canvas) → pick a trigger (e.g. *Webhook*) from the centered picker — it appears in the middle of the canvas
3. Connect nodes by dragging from the right handle to the left handle of the next node
4. Click a node → it opens **in the center of the screen**: set its input (whole payload / a field / parsed JSON / CSV / raw text) and its configuration
5. **Run** — the Log console at the bottom shows every node's input/output, durations and errors (drag its top/right edge to resize)
6. For webhook workflows, press **Run** first — the toolbar URL only accepts a request while that run is waiting (one request per Run) — then call it, e.g. `curl -X POST http://localhost:3001/webhook/<id> -d '{"hello":"world"}'`

### Wiring up AI
1. **AI Agents** tab → **New** → pick a provider (OpenAI, Anthropic, OpenRouter, Ollama, custom)
2. Paste your **API key** and model name → **Test connection**
3. Write a system prompt, toggle tools (HTTP request, current time), **Save**
4. In a workflow, add the **AI Agent** node and pick your saved agent (or configure inline)

### Let the AI build the workflow itself
1. Open a workflow → click **BUILD WITH AI** in the bottom-left corner of the workspace
2. Enter your **provider, base URL, model and API key** once (they are stored encrypted for your account)
3. Describe the automation — the agent reads the workflow on your canvas plus references of the workflow JSON itself, every node type and every agent tool
4. The workflow it returns **replaces the workflow you are working on** and is auto-saved, and the chat lists exactly what it changed (added / updated / removed nodes and connections)

### Example: webhook → AI → notify
```
[Webhook] → [AI Agent (your agent)] → [Slack Message]
```
While the workflow is running (Run pressed, waiting for the webhook), POST any JSON to `/webhook/<id>`; the agent answers based on the payload, then the reply is posted to Slack via an incoming webhook.

---

## 🗂 Architecture

```
├── shared/
│   ├── catalog.js         # single source of truth: every node type, its config schema & AI providers
│   ├── filetypes.js       # registry of ~150 common file types (extensions, MIME, extractor mapping)
│   └── samples.js         # sample payloads for service triggers (executor + input overview)
├── server/
│   ├── index.js           # Express app: REST API, auth (login/register), webhook endpoint (with secret check), static UI
│   ├── executor.js        # graph walker: runs nodes, input preprocessing, routes items by handle, log
│   ├── fileextract.js     # best-effort file extraction engine (text, CSV, JSON, XML, YAML, PDF, DOCX, XLSX, …)
│   ├── disk.js            # sandboxed file-system helpers (./data/files) for the read/write/list nodes
│   ├── ai.js              # OpenAI-compatible + Anthropic calls, tool-calling agent loop, image gen
│   ├── workflow-agent.js  # AI workflow builder: JSON + node + tool reference docs, prompt, reply → validated workflow JSON + change diff
│   ├── db.js              # SQLite (node:sqlite): user accounts, sessions, admin/cloud settings + SQL console
│   ├── security.js        # scrypt password hashing, AES-256-GCM encryption, session tokens
│   ├── admin.js           # isolated admin server (:3002) — page setup, cloud, DB, users, SQL console
│   ├── store.js           # JSON-file storage (./data/workflows.json, ./data/agents.json) + demo seed
│   ├── license.js         # self-hosted licence: cloud issues/answers keys, a copy checks and locks
│   ├── teams.js           # custom Team plan: request → operator approval → purchase → seats
│   ├── team-admin.js      # team admin of a copy: seats, credential pool, restricted members, data flows
│   ├── migrate.js         # move a self-hosted account to the cloud with a one-time code
│   ├── updater.js         # one-click update of a copy (+ update-restart.js, the rollback helper)
│   ├── selfhost.js        # installer scripts + versioned app bundle
│   ├── setup.js / runner.js # a copy's Setup page (.env) and remote execution on a runner
│   ├── oauth-connections.js, telegram-bots.js, telegram-accounts.js # connected accounts
│   ├── ai-budget.js, ai-usage.js, ai-cost.js # AI spending control, usage dashboard, cost table
│   ├── mcp.js             # workflows as tools for AI assistants (POST /mcp)
│   └── workflow-collab.js # node comments and change history
├── src/                   # React + TypeScript frontend
│   ├── pages/             # LoginPage, WorkflowEditor (canvas + centered modals), WorkflowsPage (dashboard), AgentsPage
│   └── components/        # NodePicker, NodeConfigModal, WorkflowModal, LogConsole, WorkflowNode, …
└── data/                  # created at runtime; contains your workflows, agents, API keys and admin.db
```

- **Workflows & agents:** plain JSON files (`./data/workflows.json`, `./data/agents.json`).
- **Accounts & sessions:** the SQL database (`./data/admin.db`, SQLite — free, built into Node). Delete `data/` to reset everything.
- **Agent API keys** are stored **encrypted** in the SQL database (`agent_secrets`) and re-injected only when the owning account opens the agent, chats with it, or runs a workflow that references it.
- **Workflow-node credentials** (API keys / passwords / tokens you type into node configs, e.g. the AI Agent node's *Configure a model here*) are **not** stored in the workflow JSON. On save they are lifted into the `workflow_secrets` table (encrypted with AES-256-GCM) and re-injected only when the owning account opens or runs the workflow — so exported JSON and community posts never carry them.
- **Vector memory** (`./data/vectors.json`) holds the embeddings saved by the Vector Store — Save node (all local — exported with the rest of `data/`).
- **File nodes** write to a sandboxed `./data/files` folder (Read / Write / List File from Disk); the **Data Store** node persists key-value records to `./data/datastore.json`.
- The frontend fetches the node catalog from `GET /api/nodes`, so adding a node type to `shared/catalog.js` (plus an executor case) makes it appear everywhere.

### API overview
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/nodes` | node catalog + providers (public) |
| GET | `/api/auth/me` | current session (logged in?) |
| POST | `/api/auth/register` | create an account (email + password) → auto-login |
| POST | `/api/auth/login` | log in → session cookie |
| POST | `/api/auth/logout` | end the session |
| GET/POST | `/api/workflows` | list / create (login required) |
| GET/PUT/DELETE | `/api/workflows/:id` | read / save / delete (login required) |
| POST | `/api/workflows/:id/run` | execute now (login required) |
| GET | `/api/workflows/:id/run/status?token=…` | live per-node progress + a pending approval (login required) |
| POST | `/api/workflows/:id/run/approval` | answer a Wait for Approval node (login required) |
| GET | `/api/workflows/:id/versions` | version history (summaries) (login required) |
| GET | `/api/workflows/:id/versions/:versionId` | one full snapshot (login required) |
| POST | `/api/workflows/:id/versions/:versionId/restore` | restore a version (login required) |
| GET | `/api/workflows/:id/backups` | recent saves + the "1 minute ago" / "my last save" targets (login required) |
| POST | `/api/workflows/:id/backups/:backupId/restore` | roll a shared workflow back to a saved state (login required) |
| GET | `/api/templates` | starter templates (public) |
| GET | `/api/templates/:id` | one template with its graph (public) |
| GET/PUT | `/api/ai/prices` | your AI cost table, USD per 1M tokens (login required) |
| POST | `/webhook/:id` | trigger workflow via HTTP (public — fires only while a Run is waiting for it) |
| GET/POST | `/api/agents` | list / create agents (login required) |
| PUT/DELETE | `/api/agents/:id` | update / delete (login required) |
| POST | `/api/agents/:id/chat` | chat with an agent (tool loop, login required) |
| POST | `/api/ai/test` | test model credentials (login required) |
| POST | `/api/ai/models` | fetch live model list from a provider (login required) |
| GET/PUT/DELETE | `/api/ai-builder` | the AI workflow builder's own model credentials (login required) |
| POST | `/api/ai-builder/models` | live model list for the builder's provider (login required) |
| POST | `/api/ai-builder/build` | prompt + current workflow → new workflow JSON + the list of changes (login required) |
| GET | `/api/stats` | workspace statistics for the Workspace hub (login required) |
| GET | `/api/community?q=…&sort=…&mine=1&saved=1&author=…&limit=50&offset=0` | list / search / rank community posts (login required) |
| GET | `/api/community/:id` | one post with its comment thread (login required) |
| POST | `/api/community` | publish the current workflow to the community, optionally `anonymous` (login required) |
| DELETE | `/api/community/:id` | remove your own post (login required) |
| POST | `/api/community/:id/import` | import a community post as your own workflow (login required) |
| POST | `/api/community/:id/like` | toggle a like (login required) |
| POST | `/api/community/:id/save` | toggle a bookmark (login required) |
| POST | `/api/community/:id/comments` | add a comment (login required) |
| DELETE | `/api/community/:id/comments/:commentId` | remove your comment / a comment on your post (login required) |
| GET | `/api/profile` | the account's own, editable profile (login required) |
| PUT | `/api/profile` | update display name, bio, location, website, avatar, anonymous default (login required) |
| GET | `/api/profile/:userId` | another user's public profile + public workflows (login required) |
| POST | `/api/billing/portal` | open a Stripe Billing Portal session — card, invoices, cancellation (login required) |
| POST | `/api/billing/cancel` | cancel at the end of the paid period (login required) |
| POST | `/api/billing/resume` | undo a scheduled cancellation (login required) |
| GET/POST/PUT | `/api/billing/team`, `/team/request`, `/team/checkout`, `/team/members` | the custom Team plan: state, request, purchase, member e-mails (login required) |
| GET/POST | `/api/selfhosted`, `/api/selfhosted/installer` | can this account / instance self-host; the installer script (Pro) |
| GET/POST | `/api/selfhosted/license`, `/license/rotate` | the account's licence key / a new one (cloud, Pro) |
| POST | `/api/license/check` | a copy asks what its key is worth — `{ key }` only (public, rate limited) |
| POST | `/api/selfhosted/update/bundle` | a copy downloads the newest version with its key (public, licence-checked) |
| GET/POST | `/api/license`, `/api/license/key`, `/api/license/refresh` | a copy's licence state, paste a key, check now |
| GET/POST | `/api/update`, `/api/update/check`, `/api/update/apply` | a copy's one-click update (apply: owner only) |
| GET/PUT | `/api/team` | a copy's Team page: accounts, data flows, pool, restrictions, allowed hosts (owner only) |
| POST | `/api/migrate/code` → `/api/migrate/import` ← `/api/migrate/send` | move a copy's account to the cloud with a one-time code |
| GET/POST | `/api/setup`, `/setup/test-db`, `/setup/test-runner` | a copy's storage and execution settings (owner only) |
| GET/POST/PUT/DELETE | `/api/credentials`, `/api/variables`, `/api/data-tables` (+ `/rows`, `/import`) | the workspace tools (login required) |
| GET/POST/DELETE | `/api/files`, `/api/files/download` | My files — the account's own folder (login required) |
| GET | `/api/connections`, `/api/connections/:provider/start` | connected accounts and their consent flow (login required) |
| GET/POST | `/api/telegram/bots`, `/api/telegram/accounts/*` | connect Telegram bots / log in a personal account (phone, code, QR) |
| GET/PUT/POST | `/api/ai/usage`, `/api/ai/budget`, `/api/ai/budget/test-alert` | AI usage dashboard and budgets (login required) |
| * | `/api/workflows/:id/(share|access|comments|history|presence|executions|run/*|loop|alerts|ai-estimate|files)` | sharing, collaboration, runs, debug steps, retries, repeat, failure alerts, cost preview, written files |
| GET | `/api/executions`, `/api/errors`, `/api/docs`, `/api/docs/pdf`, `/api/health` | all runs, the BF code list, the user guide (+ PDF), health check |

---

## 📄 Legal pages (Impressum · Datenschutz)

The instance ships a small, login-free legal site with **two** documents — legal notice
(Impressum) and privacy policy (Datenschutzerklärung) — each in **German, English and
Russian** (`?lang=de|en|ru` switcher in the header, choice remembered in a cookie). There is
**no AGB / terms page and no withdrawal notice**: this service deliberately publishes only an
imprint and a privacy policy (`/agb`, `/terms`, `/widerruf` and `/withdrawal` return 404).

- **Main site:** the documents are always served at root paths on the main site —
  `/impressum` and `/datenschutz` (plus a `/legal/*` alias) — so they work without any DNS
  setup. They are also reachable in German / English / Russian via `?lang=de|en|ru`.
- **Subdomain (optional):** the legal site can additionally live on its own subdomain, by
  default `info.<your-domain>` (derived from the SEO domain). A request whose `Host` matches
  that subdomain gets the legal site for every path. Set a different host via `BF_LEGAL_DOMAIN`
  or the admin panel (Legal pages tab).
- **Privacy policy:** the Datenschutzerklärung follows the deployment this software actually
  is, in 16 sections — **1. Verantwortlicher · 2. Hosting / VPS · 3. Cloudflare · 4. Supabase
  Auth · 5. PostgreSQL / database · 6. User registration · 7. Login/authentication ·
  8. Confirmation e-mails · 9. IP addresses / server logs · 10. Cookies / local storage ·
  11. Data deletion · 12. Storage periods · 13. Legal bases · 14. Data-subject rights ·
  15. International data transfers · 16. Supervisory authority / right to complain.**
- **Operator details:** the Impressum and the privacy policy are templates full of
  placeholders — the operator's name, address, e-mail, hosting provider, server location,
  Cloudflare/Supabase notes, log retention, session technology, supervisory authority, etc.
  Fill them in the admin panel → **Legal pages** tab, or via the `LEGAL_*` env vars. Until set,
  the pages show clearly marked placeholders — set them before publishing the site. Optional
  fields hide their line instead of printing a gap.

## 🔎 SEO & GEO (generative engine optimization)

The admin panel's **SEO & GEO** tab manages both the classic search-engine surface and the
generative-engine (AI answer engine) surface:

- **SEO:** page title, meta description, keywords, social preview image, Twitter/X handle,
  `robots` index/no-index, Google & Bing verification codes, extra `robots.txt` rules and extra
  `<head>` HTML. The managed meta tags (incl. Open Graph, Twitter card and the canonical URL)
  are injected into `index.html` and `/landing.html` at request time, so the live tags always
  match the settings.
- **GEO:** a published `/llms.txt` (title, summary, quotable key facts) for AI answer engines,
  and the AI-crawler policy written into `robots.txt` (GPTBot, ClaudeBot, PerplexityBot,
  Google-Extended, … — explicitly allowed or disallowed, since a plain `User-agent: *` rule is
  often ignored by them).
- Everything is editable in the **admin panel → SEO & GEO** tab or with the `BF_SEO_*` /
  `BF_GEO_*` env vars; the public host for canonical / `og:url` comes from the **Landing page /
  SEO domain** field on the Deploy tab (`BF_SITE_DOMAIN` fallback).

## 🛠 Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # vite build → dist/
npm run dev         # Express (:3001) + Vite (:5173) with hot reload
```

Extending the catalog: add a node to `shared/catalog.js` with `defaults` + `fields`,
then add a matching `case` in `server/executor.js` — the palette, inspector and
executor pick it up automatically. The file nodes read the type registry from
`shared/filetypes.js` and delegate extraction to `server/fileextract.js`.

## 🤝 Contributing, security and licence

- Bugs and node requests: open an issue — see [CONTRIBUTING.md](CONTRIBUTING.md).
  During the beta, a bug report that helps us fix something earns a free month
  of Pro once Pro launches.
- Security problems: e-mail main@w-flow.tech, never a public issue — see
  [SECURITY.md](SECURITY.md).
- Licence: [Elastic License 2.0](LICENSE) — source-available, not OSI open
  source. Copyright and trademark notes are in [NOTICE](NOTICE).
