# Node audit — every node checked from a user's perspective

> Snapshot audit of the 398 nodes that existed at the time. The 47 nodes added
> later (18 *Feeds & Sources*, 29 *More Integrations*) reuse the audited RSS
> Read and service-request engines and are covered by `tests/nodes-feeds.test.js`
> and `tests/nodes-integrations.test.js`; see `docs/node-test-report.md`.

Date: September 2026. Scope: all **398 node types** in `shared/catalog.js`
(25 triggers · 302 actions · 12 AI nodes · 51 logic · 8 files & data).

"From the user's perspective" here means the three things a user actually
experiences with a node:

1. **Can I find it and understand what it is?** — the palette entry (name +
   description + icon) and the search.
2. **Can I configure it?** — the config modal fields (labels, types, options,
   conditional fields, help text).
3. **Does it work when I press Run?** — the node actually executing in a real
   workflow.

## How each node was verified

- **Functionality** — `tests/all-nodes.test.js` builds a workflow for **every**
  catalog node and runs it through the real executor **twice**: once with the
  node's actual handler executing against a rich payload, once with manual
  output set (node skipped, fixed data passed on). Network calls are stubbed so
  the tests are offline-deterministic, but the executor's real request building
  / response parsing still runs. Outcome: all nodes produce a classified result
  (success, or a `BF-…` error code such as "credentials missing" when a real
  external key is required).
- **UI contract** — `tests/node-ux.test.js` holds every node to the minimum the
  UI needs: a name and description (palette + search), an icon that exists in
  the icon map, labelled fields with known types, no duplicate field keys, and
  `visibleWhen` conditions that always reference a real sibling field.
- **URL safety** — `tests/url-safety.test.js` verifies the new SSRF guard.
- **Live RSS polling** — `tests/rss-trigger.test.js` drives the scheduler with
  an injected clock + stubbed feed to prove baseline-then-fire semantics.
- **Live webhook / GitHub / Telegram** — `tests/github-trigger.test.js` drives
  the real HTTP server with signed GitHub deliveries (signature verification,
  filters, one-shot-vs-always arming) and `tests/telegram-trigger.test.js`
  drives the Bot API poller with a fake HTTP layer (dedupe, offsets, chat
  filter, quota).

## What the audit found — and what was fixed

### 1. Seven nodes had no real icon (generic box instead) — fixed
`Airtable — New Record/Read/Update`, `Airtable Trigger`, `Resend — Send Email`,
`Summarize` and `Webhook Respond` referenced icon names that did not exist in
`src/components/icons.tsx`, so they rendered a generic fallback box in the
palette and on the canvas. The icon map now resolves `table`, `send` and
`reply` properly.

### 2. Service triggers over-promised — clarified; RSS / GitHub / Telegram made real — fixed
Until recently the Gmail, Slack, GitHub, Telegram, IMAP, Notion, Sheets,
Teams, Outlook, Stripe, Jira, Discord, Google Drive, RSS, HubSpot, Airtable,
Supabase and Slack-reaction triggers **did not ingest live events** — pressing
Run fired a realistic *sample* payload so you could build the flow. Their
palette descriptions implied they were watching your inbox/feed/channel for
real. Fixes:
- **RSS is now real.** The background scheduler polls every saved workflow's
  RSS trigger on its poll interval and runs the workflow when **new** items
  appear (first poll after a restart records a baseline, so old items never
  fire; each fire counts toward the owner's daily run cap like cron).
- **GitHub is now real (opt-in).** With **"Always listen"** on, the server
  accepts GitHub webhook deliveries at `/webhook/:workflowId` — it verifies
  each delivery's `X-Hub-Signature-256` (when a webhook secret is set), routes
  by `X-GitHub-Event`, honours owner / repo / label filters, and runs the
  workflow per matching delivery. Manual Run still fires a sample event.
- **Telegram is now real (opt-in).** With **"Always listen"** on, the server
  long-polls the bot (`getUpdates`) and runs the workflow for each new text
  message — deduped by `update_id`, offset-acknowledged, optionally filtered
  to one chat. Manual Run still fires a sample update.
- **Webhook gained an "Always listen" toggle** — off (default) keeps the
  classic one-shot behaviour (URL fires for exactly one request after Run,
  then turns off); on, the URL stays armed while the server runs.
- The remaining **16 sample-only triggers** state in their palette description
  that Run fires a sample and live delivery is not connected yet, and each
  shows an **"About this trigger"** note at the top of its config explaining
  the same and pointing to Webhook / Schedule / Manual for real runs.

**Triggers that execute for real today:** Manual (run by hand), Webhook (HTTP
request — run waits for one call, or "Always listen" keeps it armed), Schedule
(cron — fired by the background scheduler), **RSS** (live feed polling) and —
with their "Always listen" option on — **GitHub** (signed webhook deliveries)
and **Telegram** (Bot API polling). All other triggers are sample-only by
design until their live eventing is wired in.

### 3. Everything structural already checked out clean
- every node has a name, description, icon and category;
- no duplicate node names (picker search stays unambiguous);
- every field has a label, a known type, and unique keys;
- every conditional (`visibleWhen`) field can actually be shown;
- all `select` fields ship options;
- no node type is missing from the executor's handling.

## What still needs a real account/credentials (expected, not a bug)

Action nodes that call external services (Slack, GitHub, Twilio, Stripe, AI
providers, SMTP, …) perform **real** requests with the credentials you type in,
so "does it work" for them means "works when you paste valid credentials". A
few nodes additionally need a reachable server (PostgreSQL / MySQL query nodes,
SMTP). Free / no-key nodes you can try immediately: the whole Logic group, the
local Files & Data nodes, HTTP Request, RSS — Read Feed, QR Code, Crypto price,
IP geolocation, Wikipedia / Hacker News / Reddit search, TinyURL, Random Data,
Webhook Respond, and the data-store / disk / SQL-Query nodes.

## How to re-run this audit

```bash
npm test                 # 382 assertions — every node + UX contracts + RSS + webhook/GitHub/Telegram live paths + API e2e
npm run typecheck        # frontend types (icons map etc.)
```

For help using any node, open its config → Settings → Error codes in the app,
or read `docs/guide.md` / `ERRORS.md`.
