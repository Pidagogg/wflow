# Workflow builders — features worth stealing, problems worth avoiding

A survey of the six builders that inspired W flow's node set — **Zapier, Make,
Pipedream, Activepieces, Langflow and Gumloop** — written as a working
document: what each one is genuinely good at, what users complain about, and
which parts of it are worth copying into W flow (and which are better left out).

Pricing / limits below were checked in **September 2026** and move often — treat
them as the shape of the model (per-task, per-operation, per-credit, flat rate)
rather than exact numbers.

---

## 1. Zapier

**What it is:** the consumer-facing integration platform. 7,000+ app
integrations, trigger → action Zaps, Zapier Tables/Forms/Interfaces around it.

### Features worth having
| Feature | Why it matters |
| --- | --- |
| **Enormous app catalog** | The single biggest reason people pick Zapier. Breadth is the product. |
| **Step-by-step "which app, which event, which field" onboarding** | A non-technical user can finish a working automation without ever seeing JSON. |
| **Zapier Tables + Forms + Interfaces** | The automation platform also *owns* a bit of storage and a UI, so a workflow can have a human form in front of it. |
| **AI by Zapier** (agents, chatbots, MCP) | Model calls are one more step type, with the vendor's key. |
| **Per-app trigger polling with sensible defaults** | You pick "New row in Google Sheets" and it just works — no URL, no webhook registration. |
| **Zap history with re-run / replay** | Replay a failed run after fixing the config, using the original payload. |
| **Error notifications + auto-retry** | Failures are visible in e-mail and retried a few times. |

### Problems
- **Per-task pricing punishes good automation.** One task per *step per item*;
  a 6-step Zap over 500 rows is 3,000 tasks. Users openly admit to *"optimizing
  for Zapier's pricing instead of what's best for their business"* — they delete
  steps and split flows to save money.
- **The free plan is a demo**, not a plan: 100 tasks/month, **2-step Zaps only**
  (no multi-step logic), and a 15-minute polling interval on triggers.
- **Costs explode exactly when it works.** Success (volume) is what makes it
  expensive, which is backwards for the customer.
- **Debugging is shallow.** You see a task's input/output, but "why did this
  field arrive empty three steps later?" is guesswork; no real node-level log
  with durations and error codes.
- **No self-hosting, no data residency choice.** Payloads pass through Zapier.
- **Vendor key only for AI steps** — you cannot bring your own model.
- **Logic is bolted on**: Paths/Filters/Formatters are separate paid-ish concepts
  instead of first-class nodes.

---

## 2. Make (formerly Integromat)

**What it is:** the visual "scenario" builder — bubbles, routers, iterators,
aggregators. Strongest free tier of the classic three, and the most expressive
canvas.

### Features worth having
| Feature | Why it matters |
| --- | --- |
| **A real visual canvas with routers & filters drawn as paths** | You can *see* the branching instead of reading config. |
| **Iterators + Aggregators** | Split an array into items, process each, then fold them back — the mental model W flow copies with Split Out / Loop / Text Aggregator. |
| **Reusable "custom apps"/scenarios called from other scenarios** | Build once, call from anywhere (W flow: **Execute Sub-Workflow**). |
| **Error handlers per module** (`break`, `resume`, `rollback`, `commit`) | Fine-grained "on error do X" without a separate error workflow. |
| **Execution inspector with per-operation payloads** | Every operation's input/output is browsable, with the data flow visible. |
| **1,000 free operations/month, then ~$9 for 10k** | Cheapest way into serious automation. |
| **Scheduling with time zones, intervals and "every 15 minutes"** | Practical scheduling UX. |

### Problems
- **Per-operation billing is still a trap**, just a cheaper one: routers,
  filters, iterators and aggregators all consume operations, so the bill does not
  track business value — a single scenario can silently burn 4 operations per row.
- **"How many operations will this cost?" is unanswerable up front.** Cost
  anxiety shows up in the community constantly; the model is unpredictable.
- **Steep learning curve.** Iterators, aggregators, router paths and "bundles vs
  items" confuse beginners more than plain if/else does.
- **Error traces are hard to follow** once iterators and aggregators are
  involved — the operation that failed is often not the module that shows red.
- **Time limits and step limits on long scenarios**, plus rate-limit surcharges.
- **No self-hosting** and no bring-your-own-model for the AI modules.
- **UI density**: the canvas is powerful but cramped on small screens.

---

## 3. Pipedream

**What it is:** developer-first automation — every step can be real Node.js /
Python / Go, with an enormous integration catalog, event sources and a decent
free tier (100 credits/day, Basic from ~$29/month).

### Features worth having
| Feature | Why it matters |
| --- | --- |
| **Code steps as a first-class citizen** | Node/Python in the middle of a workflow, with npm/pip imports and stored auth. The escape hatch always exists. |
| **Event sources & reusable triggers** | A trigger can be a long-lived program (poll an API, listen to a webhook), not just a config form. |
| **Huge built-in app auth ("connect an account")** | OAuth handling done well, keys never pasted into steps. |
| **Per-step testing with the real UI of the target API** | Try a step in isolation before wiring it up. |
| **HTTP/SSE streaming endpoints per workflow** | A workflow can *be* an API endpoint, not just consume one. |
| **Deploy from CLI / version control** | Workflows as code, reviewable and repeatable. |
| **Free tier that is actually usable for developers** | 100 credits/day is enough to build and test. |

### Problems
- **The credit model is opaque.** What a credit costs varies by component, so
  planning is guesswork.
- **Not for non-developers.** You hit code fast; the no-code path is thinner than
  Zapier's.
- **Self-hosting the full builder has historically been limited** — the hosted
  platform is the product.
- **Long-running work is constrained** by execution time limits per run.
- **The canvas is secondary** to the code view; complex graphs are harder to
  understand at a glance.
- **Documentation sprawl**: many components, uneven docs and examples.

---

## 4. Activepieces

**What it is:** the open-source (MIT) Zapier alternative — self-hostable,
"pieces" as npm packages, flat-rate pricing per active workflow with unlimited
runs (free tier ~1,000 tasks/month).

### Features worth having
| Feature | Why it matters |
| --- | --- |
| **Open source + self-hostable (Docker)** | Full data ownership — W flow's whole premise. |
| **Flat-rate pricing per *active* workflow** | Predictable: a workflow costs the same whether it runs 10 or 10,000 times. Directly answers the Zapier/Make criticism. |
| **"Pieces" as a plugin framework** | Adding an integration is writing one package with a clear contract. |
| **Built-in code step (TypeScript/JavaScript)** | Escape hatch without leaving the editor. |
| **Versioned pieces & marketplace** | Community contributions keep the catalog growing. |
| **Branded/embedded builder for SaaS** | Ship the automation builder inside your own product. |
| **Human-in-the-loop approval steps** | A run can pause and wait for a person to approve. |

### Problems
- **Smaller catalog than Zapier/Make** and uneven quality per piece — some
  integrations are thin (missing triggers or pagination).
- **Fewer AI/agentic primitives** than Gumloop/Langflow; AI is mostly "call a
  model", not an agent loop with tools.
- **Younger ecosystem**: fewer tutorials, templates and StackOverflow answers.
- **Self-hosting means you own the ops**: upgrades, Postgres, backups, mail.
- **Template/visual polish** is behind Zapier's; the "first 5 minutes" are rougher.
- **Observability beyond logs is limited** (no built-in quota/analytics dashboard
  worth the name).

---

## 5. Langflow

**What it is:** a visual builder for LLM / RAG / agent applications — components
for models, retrievers, vector stores, tools, memory; exports flows, exposes
them as APIs, MCP servers. Free and self-hostable, built on LangChain-style
component contracts.

### Features worth having
| Feature | Why it matters |
| --- | --- |
| **Component graph, not "steps"** | Outputs can fan into multiple inputs; the graph is the program. |
| **First-class model/embedding/vector nodes with provider dropdowns** | Bring-your-own-model is the default, not an afterthought. |
| **Playground per component** | Test one node's prompt in isolation and keep iterating. |
| **Instant "flow as API" + MCP server export** | Ship what you built as an endpoint or a tool for other agents. |
| **Custom components in Python** | Extending the palette does not mean forking the app. |
| **RAG primitives: splitters, retrievers, rerankers, memory** | The pieces you actually need for grounded answers (W flow: **Split Text into Chunks**, embeddings, vector search). |
| **Free and self-hostable** | Same reason as Activepieces. |

### Problems
- **It is a builder, not an operations platform.** No trigger catalog, no
  scheduling/retry semantics, no run-history/quota story worth calling
  production-grade; teams move the flow to code for real workloads.
- **Python dependency hell** for custom components; version drift between
  LangChain/LLM SDKs and the app breaks flows.
- **No general automation glue** — no Gmail/Slack/sheet steps; you build the
  integration yourself, usually as code.
- **Statefulness is limited**: long-running human approval or durable
  pause/resume is not the model.
- **Auth, multi-tenancy and RBAC are thin** — self-hosting for several teams
  needs extra work in front of it.
- **Prompt/log observability is shallow** compared to dedicated LLM-ops tools.

---

## 6. Gumloop

**What it is:** the "multiplayer AI agent builder" — node-based AI workflows for
teams, with scrapers, loops/subflows and shared agents. Free tier ~1,000–5,000
credits/month, Pro from ~$37/month.

### Features worth having
| Feature | Why it matters |
| --- | --- |
| **AI-node-first palette** | Ask-an-LLM, extract, classify, summarize are the *primary* steps, not a special category. |
| **Subflows + loops over lists** | Reusable AI pipelines composed into bigger ones (W flow: Execute Sub-Workflow, Loop, Split Out). |
| **Bring-your-own-key discounts** | Use your own model key and pay near-cost — the honest version of "AI credits". |
| **Multiplayer/team sharing with IT access control** | Agents are shared assets, with permissioning. |
| **Web scraping / crawling nodes** | Practical for AI data gathering. |
| **Good starter templates** | Time-to-first-win is short. |
| **Human review steps** | AI output can be approved before it hits the outside world. |

### Problems
- **Credits are consumed fastest exactly by the AI nodes you came for** —
  advanced/expert AI nodes cost 2/20/30 credits per call, so the headline number
  shrinks fast once real prompts run.
- **No self-hosting.** Your data and prompts live in Gumloop's cloud.
- **Model choice is mediated** unless you bring your own key, and BYO-key is the
  discounted path rather than the default.
- **Thin non-AI automation surface** compared to Zapier/Make (fewer classic
  business apps, weaker trigger catalog).
- **The free tier is a trial** — 1,000–5,000 credits with no permanent free tier
  per some reviews.
- **Debugging AI steps is hard**: prompt changes, model updates and credit
  errors look alike in a run log.
- **Pricing/credit changes** have repeatedly shifted, making budgeting hard.

---

## 7. What W flow already does — the summary

| Feature | Zapier | Make | Pipedream | Activepieces | Langflow | Gumloop | **W flow** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Visual node canvas | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ |
| Triggers (webhook, cron, chat, services) | ✅ | ✅ | ✅ | ✅ | ✗ | ◐ | ✅ |
| Cron scheduling + background polling | ✅ | ✅ | ✅ | ✅ | ✗ | ◐ | ✅ |
| Per-node input/output log with error codes | ◐ | ◐ | ✅ | ◐ | ✗ | ◐ | ✅ |
| Saved execution history, reopen a past run | ✅ | ✅ | ✅ | ◐ | ✗ | ◐ | ✅ |
| Loop / split / merge / aggregate primitives | ◐ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ |
| Code step (JS) | ◐ | ◐ | ✅ | ✅ | ✅ (Python) | ◐ | ✅ |
| Reusable sub-workflows | ✅ | ✅ | ◐ | ✅ | ◐ | ✅ | ✅ |
| AI nodes with bring-your-own-model | ✗ | ✗ | ◐ | ◐ | ✅ | ◐ | ✅ |
| AI agent that writes the workflow for you | ◐ | ✗ | ✗ | ✗ | ◐ | ✅ | ✅ |
| Automated tests per workflow (Evaluation) | ✗ | ◐ | ◐ | ✗ | ✗ | ✗ | ✅ |
| Self-hostable / data stays on your server | ✗ | ✗ | ✗ | ✅ | ✅ | ✗ | ✅ |
| Flat, predictable cost | ✗ | ✗ | ✗ | ✅ | ✅ | ✗ | ✅ |
| 1,000+ app catalog | ✅ | ✅ | ✅ | ◐ | ✗ | ✗ | ✗ |

## 8. Their problems — which ones W flow must keep avoiding

1. **Metered pricing per step/operation/credit.** W flow self-hosts: the cost is
   your own server. The Pro plan caps *workflows and runs per day* — visible up
   front, not a per-step sneak.
2. **Vendor-locked AI.** Every model call uses credentials the user entered
   (`workflow_secrets`, `agent_secrets`, and now the builder's own
   `/api/ai-builder` store) — never a vendor key.
3. **Opaque failures.** Every node error carries a `BF-####` code with an
   explanation and tips, and the log keeps per-node input/output and durations.
   (The new `BF-1004` stop-on-purpose and `BF-7002` crypto codes continue that.)
4. **Cost anxiety driving design.** The Workspace page statistics deliberately show
   *production* runs and *time saved* — the useful number — rather than "tasks
   consumed".
5. **Prototype-only AI builders.** Langflow/Gumloop flows stop being useful when
   you need schedules, retries, history and quotas. W flow puts triggers,
   scheduler, history and the AI agent in one place.
6. **Deep-but-cramped canvases.** Keep the drafting aesthetic: one accent colour,
   short config forms, optional parameters collapsed.

## 9. Candidate next steps (copied from them)

Ordered by value for W flow, based on the gaps above. Items 1, 2, 4, 8 and 10
have since **shipped** (see §10); the rest are still open.

1. **Per-node error handler** — Make's `break / resume / rollback` equivalent:
   "on error → continue with this value / retry N× / run this branch". ✅ **Done**
2. **Human-in-the-loop approval step** — Activepieces/Gumloop have it; a run
   pauses and the user approves in the Log console. ✅ **Done** (`Wait for Approval`)
3. **Per-app OAuth "connect an account"** — Pipedream's strength. Today keys are
   pasted into node configs; a connected account would be reusable across nodes
   and workflows. *Still the biggest integration gap.*
4. **Zap history "replay with the original payload"** — one click to re-run an
   execution with the input it was started with. ✅ **Done**
5. **Reranker + memory nodes for RAG** — Langflow-grade retrieval without
   leaving the editor (chunking already shipped; reranking is the next gap).
6. **A test/runner panel for triggers** — Pipedream's "trigger one event with
   real data" experience (the input panel is the first step of this).
7. **Workflow-as-API export** — Langflow/Pipedream: expose a workflow as a
   documented HTTP endpoint with its own key (webhooks already do 80% of it).
8. **Template gallery** — Gumloop's time-to-first-win. ✅ **Done**
9. **Step-level cost/time budget warnings** — not to bill, but to tell the user
   "this node will call the model once per item (≈ 500 calls)" before they run it.
10. **Version history / diff for workflows** — nobody above does it well, and it
    is the natural companion to an AI agent that rewrites your workflow. ✅ **Done**

## 10. What shipped from this list

Implemented in the reliability + visibility pass:

- **On-error on every node** (`shared/catalog.js`, `server/executor.js`) — the
  three fields are appended to every runnable node definition instead of being
  repeated; the executor reads `stop` (triggers / logic / AI), `continue`
  (actions — the items carry on with an `_error` object and the run still
  counts as successful) or `retry` (attempts + delay). Handled failures show as
  `continued` in the Log console and are counted separately from halts.
- **The Error Trigger is real** (`server/error-workflows.js`) — a workflow with
  an Error Trigger node is the account's error handler; a finished run with
  *unhandled* failures executes it with one item describing the failure.
  Owner-scoped, max 5 handlers per failure, never self-triggering, never
  chaining, and it does not consume the daily run allowance.
- **Wait for Approval** (`server/approvals.js`, `server/executor.js`) — pauses a
  run and exposes Approve / Reject in the Log console; routes to the
  `approved` / `rejected` outputs; `timeoutMinutes` + `onTimeout` decide what an
  unattended run does (`BF-7003`).
- **AI tokens + cost** (`server/ai-cost.js`, `server/ai.js`) — every AI node's
  token usage is normalised, kept per node in the log, summed per run and priced
  with the account's own editable table (**Settings → AI usage & cost**, preset-
  filled); the Workspace page adds an **AI spend** card.
- **Replay** — a saved run stores the payload it started with, so the Log
  console's **Replay** button re-runs the workflow with the exact same input.
- **Version history** (`server/store.js`) — every graph-changing save snapshots
  the state it was leaving; **Versions** in the editor lists them and restores
  any one (restoring snapshots the current state first, so it is undoable too).
  This exists mostly *because* of the AI builder: a model rewriting your canvas
  is only acceptable when one click takes it back.
- **Template gallery** (`shared/templates.js`) — nine curated, runnable
  skeletons (chat assistant, webhook → Sheets → Slack, RSS digest, AI triage,
  API health check with alerting, account-wide error alerter, approval before
  publish, free text → Notion, RAG ingest).

Still open, in priority order: per-app OAuth connected accounts, RAG reranking,
workflow-as-API export, per-step cost/volume estimates before a run, and a
first-class trigger test panel with real captured events.
