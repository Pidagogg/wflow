// ============================================================================
// W FLOW — starter templates
//
// Curated, ready-to-run skeletons offered on the Workflows page ("Start from a
// template") and whenever an account has no workflows yet. They are plain
// workflow payloads (nodes + edges) so creating one is a normal
// POST /api/workflows — no special import path, and every account keeps its own
// copy that it can edit freely.
//
// Rules for a template in here:
//   - it must RUN: every node type exists in the catalog and the configs use
//     real field names with sensible placeholder values,
//   - credentials stay EMPTY (apiKey/token/appPassword/webhookUrl "") — the user
//     fills in their own, which is also what keeps them out of the repo,
//   - ids look like "<slug>-1" so nothing collides when two templates are mixed,
//   - positions flow left to right, ~300 px apart, ~160 px per branch.
// ============================================================================

export const TEMPLATE_CATEGORIES = ["Marketing", "Sales", "IT & Monitoring", "AI", "Support", "Crypto"];

// Small builders for the crypto templates below, which chain 2–3 nodes.
const node = (id, type, x, label, config, y = 160) => ({ id, type, position: { x, y }, data: { label, config } });
const chain = (prefix, ids) => ids.slice(1).map((id, i) => ({ id: `${prefix}-e${i + 1}`, source: ids[i], target: id, sourceHandle: "out", targetHandle: "in" }));
const TELEGRAM = { botToken: "", chatId: "", onError: "continue" };

export const TEMPLATES = [
  {
    id: "chat-assistant",
    name: "Chat assistant with your own model",
    description: "A Chat Trigger answers every message with an AI model, and the reply is posted back into the chat panel. The simplest way to try the Chat tab.",
    category: "AI",
    level: "starter",
    requires: ["Your own model credentials on the Chat Model node"],
    nodes: [
      {
        id: "chat-1",
        type: "chatTrigger",
        position: { x: 80, y: 160 },
        data: {
          label: "Chat message",
          config: { welcome: "Hi! Ask me anything — this workflow answers with your own model.", onError: "stop" },
        },
      },
      {
        id: "chat-2",
        type: "aiChat",
        position: { x: 400, y: 160 },
        data: {
          label: "Answer it",
          config: {
            provider: "openai",
            baseUrl: "",
            apiKey: "",
            model: "gpt-4o-mini",
            temperature: 0.7,
            maxTokens: 1024,
            systemPrompt: "You are a friendly, concise assistant inside a self-hosted automation platform.",
            prompt: "{{message}}",
            memory: true,
            jsonMode: false,
            onError: "stop",
          },
        },
      },
      {
        id: "chat-3",
        type: "chatOutput",
        position: { x: 720, y: 160 },
        data: { label: "Reply in chat", config: { text: "{{reply}}", role: "assistant", onError: "continue" } },
      },
    ],
    edges: [
      { id: "chat-e1", source: "chat-1", target: "chat-2", sourceHandle: "out", targetHandle: "in" },
      { id: "chat-e2", source: "chat-2", target: "chat-3", sourceHandle: "out", targetHandle: "in" },
    ],
  },

  {
    id: "webhook-to-sheets",
    name: "Webhook → Google Sheets → Slack",
    description: "Take a JSON body from a webhook, append it as a row to a spreadsheet and ping a Slack channel. The classic form/lead-capture shape.",
    category: "Sales",
    level: "starter",
    requires: ["A connected Google account + spreadsheet id", "Slack incoming webhook URL"],
    nodes: [
      {
        id: "sheets-1",
        type: "webhook",
        position: { x: 80, y: 160 },
        data: {
          label: "Incoming lead",
          config: { method: "POST", responseMode: "ok", customResponse: '{"ok":true}', secret: "", live: false, onError: "stop" },
        },
      },
      {
        id: "sheets-2",
        type: "googleSheetsAppend",
        position: { x: 400, y: 160 },
        data: {
          label: "Append the row",
          config: {
            apiKey: "",
            spreadsheetId: "",
            sheetName: "",
            values: '[\n  ["{{name}}", "{{email}}", "{{message}}"]\n]',
            onError: "continue",
          },
        },
      },
      {
        id: "sheets-3",
        type: "slackSend",
        position: { x: 720, y: 160 },
        data: {
          label: "Notify the team",
          config: { webhookUrl: "", channel: "#leads", text: "New lead: {{name}} ({{email}})", blocks: "", onError: "continue" },
        },
      },
    ],
    edges: [
      { id: "sheets-e1", source: "sheets-1", target: "sheets-2", sourceHandle: "out", targetHandle: "in" },
      { id: "sheets-e2", source: "sheets-2", target: "sheets-3", sourceHandle: "out", targetHandle: "in" },
    ],
  },

  {
    id: "rss-digest",
    name: "Daily RSS digest by e-mail",
    description: "Every weekday morning, read a feed, combine the new items into one message and mail it to yourself. Runs on the built-in scheduler.",
    category: "Marketing",
    level: "starter",
    requires: ["A connected Google account (Gmail)"],
    nodes: [
      {
        id: "rss-1",
        type: "schedule",
        position: { x: 80, y: 160 },
        data: { label: "Every weekday 8:00", config: { cron: "0 8 * * 1-5", timezone: "", onError: "stop" } },
      },
      {
        id: "rss-2",
        type: "rssRead",
        position: { x: 400, y: 160 },
        data: { label: "Read the feed", config: { url: "https://hnrss.org/newest", limit: 15, storeIn: "items", onError: "continue" } },
      },
      {
        id: "rss-3",
        type: "code",
        position: { x: 720, y: 160 },
        data: {
          label: "Build the digest",
          config: {
            code: 'const feed = items[0]?.json || {};\nconst list = (feed.items || [])\n  .map((it, i) => `${i + 1}. ${it.title}\\n   ${it.link}`)\n  .join("\\n");\nreturn [{ json: { subject: `Feed digest — ${list.split("\\n").filter(l => /^\\d+\\./.test(l)).length} new items`, digest: list || "No new items today." } }];',
            outputFile: "",
            onError: "stop",
          },
        },
      },
      {
        id: "rss-4",
        type: "gmailSend",
        position: { x: 1040, y: 160 },
        data: {
          label: "Mail the digest",
          config: {
            oauthAccount: "",
            token: "",
            to: "",
            cc: "",
            subject: "{{subject}}",
            message: "{{digest}}\n\n— sent by W flow",
            html: false,
            baseUrl: "https://gmail.googleapis.com",
            method: "POST",
            path: "/gmail/v1/users/me/messages/send",
            query: "",
            headers: "",
            body: '{"raw":"{{raw}}"}',
            storeIn: "data",
            onError: "continue",
          },
        },
      },
    ],
    edges: [
      { id: "rss-e1", source: "rss-1", target: "rss-2", sourceHandle: "out", targetHandle: "in" },
      { id: "rss-e2", source: "rss-2", target: "rss-3", sourceHandle: "out", targetHandle: "in" },
      { id: "rss-e3", source: "rss-3", target: "rss-4", sourceHandle: "out", targetHandle: "in" },
    ],
  },

  {
    id: "ai-triage-inbox",
    name: "Triage incoming mail with AI",
    description: "Read a mailbox, let a model rate the urgency, and only ping Slack for the important ones. Shows the AI + IF + notification pattern.",
    category: "Support",
    level: "intermediate",
    requires: ["your own model credentials"],
    nodes: [
      {
        id: "triage-1",
        type: "gmail",
        position: { x: 80, y: 160 },
        data: {
          label: "New e-mail",
          config: {
            folder: "INBOX",
            filterFrom: "",
            filterSubject: "",
            onError: "stop",
          },
        },
      },
      {
        id: "triage-2",
        type: "aiExtract",
        position: { x: 400, y: 160 },
        data: {
          label: "Rate the e-mail",
          config: {
            provider: "openai",
            baseUrl: "",
            apiKey: "",
            model: "gpt-4o-mini",
            temperature: 0,
            maxTokens: 512,
            sourceField: "body",
            targetType: "object",
            schema:
              '{\n  "type": "object",\n  "properties": {\n    "urgency": { "type": "string", "description": "high, normal or low" },\n    "summary": { "type": "string" },\n    "needsReply": { "type": "boolean" }\n  },\n  "required": ["urgency", "summary"]\n}',
            storeIn: "parsed",
            jsonMode: true,
            onError: "stop",
          },
        },
      },
      {
        id: "triage-3",
        type: "if",
        position: { x: 720, y: 160 },
        data: {
          label: "Urgent?",
          config: { valueA: "{{parsed.urgency}}", operator: "equals", valueB: "high", caseSensitive: false, onError: "stop" },
        },
      },
      {
        id: "triage-4",
        type: "slackSend",
        position: { x: 1040, y: 80 },
        data: {
          label: "Ping the channel",
          config: { webhookUrl: "", channel: "#support", text: "🔴 Urgent mail: {{parsed.summary}}\nFrom: {{from}}", blocks: "", onError: "continue" },
        },
      },
      {
        id: "triage-5",
        type: "log",
        position: { x: 1040, y: 300 },
        data: { label: "Just log it", config: { message: "Normal mail: {{parsed.summary}}", onError: "stop" } },
      },
    ],
    edges: [
      { id: "triage-e1", source: "triage-1", target: "triage-2", sourceHandle: "out", targetHandle: "in" },
      { id: "triage-e2", source: "triage-2", target: "triage-3", sourceHandle: "out", targetHandle: "in" },
      { id: "triage-e3", source: "triage-3", target: "triage-4", sourceHandle: "true", targetHandle: "in" },
      { id: "triage-e4", source: "triage-3", target: "triage-5", sourceHandle: "false", targetHandle: "in" },
    ],
  },

  {
    id: "api-health-check",
    name: "Hourly API health check",
    description: "Call an endpoint on a schedule and alert only when it is down. Uses a retry + continue-on-error setup so a single blip does not page anyone.",
    category: "IT & Monitoring",
    level: "starter",
    requires: ["Slack incoming webhook URL (or swap in e-mail)"],
    nodes: [
      {
        id: "health-1",
        type: "schedule",
        position: { x: 80, y: 160 },
        data: { label: "Every hour", config: { cron: "0 * * * *", timezone: "", onError: "stop" } },
      },
      {
        id: "health-2",
        type: "http",
        position: { x: 400, y: 160 },
        data: {
          label: "Ping the API",
          config: {
            method: "GET",
            url: "https://api.example.com/health",
            headers: '{\n  "Accept": "application/json"\n}',
            query: [],
            body: "{}",
            timeout: 10,
            authType: "none",
            authToken: "",
            authUser: "",
            authPass: "",
            retries: 2,
            parseAs: "auto",
            followRedirects: true,
            outputFile: "",
            onError: "continue",
          },
        },
      },
      {
        id: "health-3",
        type: "if",
        position: { x: 720, y: 160 },
        data: {
          label: "Did it fail?",
          config: { valueA: "{{ok}}", operator: "equals", valueB: "false", caseSensitive: false, onError: "stop" },
        },
      },
      {
        id: "health-4",
        type: "slackSend",
        position: { x: 1040, y: 80 },
        data: {
          label: "Alert the team",
          config: { webhookUrl: "", channel: "#alerts", text: "🔴 API check failed (status {{status}})", blocks: "", onError: "continue" },
        },
      },
      {
        id: "health-5",
        type: "noop",
        position: { x: 1040, y: 300 },
        data: { label: "All good", config: { onError: "stop" } },
      },
    ],
    edges: [
      { id: "health-e1", source: "health-1", target: "health-2", sourceHandle: "out", targetHandle: "in" },
      { id: "health-e2", source: "health-2", target: "health-3", sourceHandle: "out", targetHandle: "in" },
      { id: "health-e3", source: "health-3", target: "health-4", sourceHandle: "true", targetHandle: "in" },
      { id: "health-e4", source: "health-3", target: "health-5", sourceHandle: "false", targetHandle: "in" },
    ],
  },

  {
    id: "error-alerting",
    name: "Alert me when any workflow fails",
    description: "The account-wide error handler: put an Error Trigger in this workflow and every failed run of your OTHER workflows lands here with the workflow, the node and the error message.",
    category: "IT & Monitoring",
    level: "starter",
    requires: ["Slack incoming webhook URL (or replace with e-mail)"],
    nodes: [
      {
        id: "err-1",
        type: "errorTrigger",
        position: { x: 80, y: 160 },
        data: { label: "Any workflow failed", config: { onError: "stop" } },
      },
      {
        id: "err-2",
        type: "set",
        position: { x: 400, y: 160 },
        data: {
          label: "Write the message",
          config: {
            mode: "set",
            parseValues: false,
            fields: [
              { key: "alert", value: "⚠ {{workflow.name}} failed in “{{error.nodeName}}” ({{error.marker}}): {{error.message}}" },
            ],
            onError: "stop",
          },
        },
      },
      {
        id: "err-3",
        type: "slackSend",
        position: { x: 720, y: 160 },
        data: {
          label: "Tell the team",
          config: { webhookUrl: "", channel: "#alerts", text: "{{alert}}", blocks: "", onError: "continue" },
        },
      },
    ],
    edges: [
      { id: "err-e1", source: "err-1", target: "err-2", sourceHandle: "out", targetHandle: "in" },
      { id: "err-e2", source: "err-2", target: "err-3", sourceHandle: "out", targetHandle: "in" },
    ],
  },

  {
    id: "approval-before-post",
    name: "Approve before it goes out",
    description: "A webhook drops work into the run, a person approves it in the editor, and only then does the workflow call the real endpoint. Shows the Wait for Approval node.",
    category: "IT & Monitoring",
    level: "intermediate",
    requires: ["An endpoint to call after approval"],
    nodes: [
      {
        id: "approve-1",
        type: "webhook",
        position: { x: 80, y: 160 },
        data: {
          label: "Incoming request",
          config: { method: "POST", responseMode: "ok", customResponse: '{"ok":true}', secret: "", live: false, onError: "stop" },
        },
      },
      {
        id: "approve-2",
        type: "approval",
        position: { x: 400, y: 160 },
        data: {
          label: "Wait for a human",
          config: {
            message: "Approve this publish? {{message}}",
            approveLabel: "Publish",
            rejectLabel: "Discard",
            timeoutMinutes: 30,
            onTimeout: "fail",
            approvedItem: "",
            onError: "stop",
          },
        },
      },
      {
        id: "approve-3",
        type: "http",
        position: { x: 780, y: 80 },
        data: {
          label: "Do the thing",
          config: {
            method: "POST",
            url: "https://api.example.com/publish",
            headers: '{\n  "Content-Type": "application/json"\n}',
            query: [],
            body: '{\n  "message": "{{message}}"\n}',
            timeout: 20,
            authType: "none",
            authToken: "",
            authUser: "",
            authPass: "",
            retries: 1,
            parseAs: "auto",
            followRedirects: true,
            outputFile: "",
            onError: "continue",
          },
        },
      },
      {
        id: "approve-4",
        type: "log",
        position: { x: 780, y: 320 },
        data: { label: "Rejected — log and stop", config: { message: "Rejected ({{approval.by}}): {{message}}", onError: "stop" } },
      },
    ],
    edges: [
      { id: "approve-e1", source: "approve-1", target: "approve-2", sourceHandle: "out", targetHandle: "in" },
      { id: "approve-e2", source: "approve-2", target: "approve-3", sourceHandle: "approved", targetHandle: "in" },
      { id: "approve-e3", source: "approve-2", target: "approve-4", sourceHandle: "rejected", targetHandle: "in" },
    ],
  },

  {
    id: "text-to-notion",
    name: "Turn free text into a Notion page",
    description: "Any text arriving on a webhook is structured by a model (title, summary, category, tags) and written into a Notion database.",
    category: "AI",
    level: "intermediate",
    requires: ["Notion integration token + database id", "your own model credentials"],
    nodes: [
      {
        id: "notion-1",
        type: "webhook",
        position: { x: 80, y: 160 },
        data: {
          label: "Raw text in",
          config: { method: "POST", responseMode: "ok", customResponse: '{"ok":true}', secret: "", live: false, onError: "stop" },
        },
      },
      {
        id: "notion-2",
        type: "aiExtract",
        position: { x: 400, y: 160 },
        data: {
          label: "Structure it",
          config: {
            provider: "openai",
            baseUrl: "",
            apiKey: "",
            model: "gpt-4o-mini",
            temperature: 0,
            maxTokens: 1024,
            sourceField: "text",
            targetType: "object",
            schema:
              '{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" },\n    "summary": { "type": "string" },\n    "category": { "type": "string" },\n    "tags": { "type": "array", "items": { "type": "string" } }\n  },\n  "required": ["title", "summary"]\n}',
            storeIn: "parsed",
            jsonMode: true,
            onError: "stop",
          },
        },
      },
      {
        id: "notion-3",
        type: "notionPage",
        position: { x: 720, y: 160 },
        data: {
          label: "Create the page",
          config: {
            token: "",
            parentDatabaseId: "",
            title: "{{parsed.title}}",
            content: "{{parsed.summary}}\n\nCategory: {{parsed.category}}",
            onError: "continue",
          },
        },
      },
    ],
    edges: [
      { id: "notion-e1", source: "notion-1", target: "notion-2", sourceHandle: "out", targetHandle: "in" },
      { id: "notion-e2", source: "notion-2", target: "notion-3", sourceHandle: "out", targetHandle: "in" },
    ],
  },

  {
    id: "rag-ingest",
    name: "Make a document searchable (RAG ingest)",
    description: "Split a long text into overlapping chunks, embed each one and store the vectors — the ingest half of a “ask my documents” workflow. Search them later with Vector Search + Chat Model.",
    category: "AI",
    level: "advanced",
    requires: ["your own embedding model credentials"],
    nodes: [
      {
        id: "rag-1",
        type: "webhook",
        position: { x: 80, y: 160 },
        data: {
          label: "Document in",
          config: { method: "POST", responseMode: "ok", customResponse: '{"ok":true}', secret: "", live: false, onError: "stop" },
        },
      },
      {
        id: "rag-2",
        type: "chunkText",
        position: { x: 400, y: 160 },
        data: {
          label: "Chunk it",
          config: { field: "text", chunkSize: 1200, overlap: 200, mode: "items", storeIn: "chunk", onError: "stop" },
        },
      },
      {
        id: "rag-3",
        type: "aiEmbeddings",
        position: { x: 720, y: 160 },
        data: {
          label: "Embed each chunk",
          config: {
            provider: "openai",
            baseUrl: "",
            apiKey: "",
            model: "text-embedding-3-small",
            text: "{{chunk}}",
            storeIn: "vector",
            onError: "stop",
          },
        },
      },
      {
        id: "rag-4",
        type: "vectorStore",
        position: { x: 1040, y: 160 },
        data: {
          label: "Store the vectors",
          config: {
            provider: "openai",
            baseUrl: "",
            apiKey: "",
            model: "text-embedding-3-small",
            namespace: "documents",
            key: "{{chunkIndex}}",
            text: "{{chunk}}",
            meta: '{"source": "{{source}}"}',
            onError: "continue",
          },
        },
      },
    ],
    edges: [
      { id: "rag-e1", source: "rag-1", target: "rag-2", sourceHandle: "out", targetHandle: "in" },
      { id: "rag-e2", source: "rag-2", target: "rag-3", sourceHandle: "out", targetHandle: "in" },
      { id: "rag-e3", source: "rag-3", target: "rag-4", sourceHandle: "out", targetHandle: "in" },
    ],
  },

  // ---- crypto ----
  {
    id: "crypto-price-alert",
    name: "Crypto price alert to Telegram",
    description: "Checks the Bitcoin price on Binance every minute and sends a Telegram message the moment it crosses your level. Change the pair, the level or the exchange on the trigger.",
    category: "Crypto",
    level: "starter",
    requires: ["A Telegram bot token and chat ID on the Telegram node"],
    nodes: [
      node("cpa-1", "cryptoPriceTrigger", 80, "BTC above 100k", { exchange: "binance", symbol: "BTCUSDT", condition: "above", threshold: 100000, pollInterval: 1, onError: "stop" }),
      node("cpa-2", "telegramSend", 400, "Tell me", { ...TELEGRAM, text: "🚀 {{symbol}} is now {{price}} (crossed {{threshold}}) on {{exchange}}." }),
    ],
    edges: chain("cpa", ["cpa-1", "cpa-2"]),
  },
  {
    id: "crypto-dca-buy",
    name: "Weekly DCA buy (test mode)",
    description: "Buys a fixed amount of Bitcoin every Monday on Binance and reports the result to Telegram — dollar-cost averaging on autopilot. It ships in test mode with a 50 USDT per-order and per-day limit; switch test mode off on the Binance node when you are ready.",
    category: "Crypto",
    level: "intermediate",
    requires: ["A Binance API key with Spot Trading (never withdrawals)", "A Telegram bot token and chat ID"],
    nodes: [
      node("dca-1", "schedule", 80, "Every Monday 9:00", { cron: "0 9 * * 1", timezone: "UTC", onError: "stop" }),
      node("dca-2", "binanceExchange", 400, "Buy 25 USDT of BTC", {
        operation: "marketOrder",
        symbol: "BTCUSDT",
        side: "buy",
        amount: "25",
        amountIn: "quote",
        limitPrice: "",
        testMode: true,
        maxAmount: 50,
        maxDaily: 50,
        orderId: "",
        apiKey: "",
        secret: "",
        baseUrl: "https://api.binance.com",
        storeIn: "result",
        onError: "stop",
      }),
      node("dca-3", "telegramSend", 720, "Report", { ...TELEGRAM, text: "DCA: bought 25 USDT of BTC (test: {{result.test}}). Order: {{result.orderId}}" }),
    ],
    edges: chain("dca", ["dca-1", "dca-2", "dca-3"]),
  },
  {
    id: "polymarket-odds-tracker",
    name: "Polymarket odds tracker dashboard",
    description: "Reads a Polymarket market's chance every hour and charts it on a shareable dashboard page. Paste any market link into the Polymarket node; the dashboard link appears in the run output.",
    category: "Crypto",
    level: "starter",
    requires: ["A Polymarket market link (no account or key needed)"],
    nodes: [
      node("pmt-1", "schedule", 80, "Every hour", { cron: "0 * * * *", timezone: "UTC", onError: "stop" }),
      node("pmt-2", "polymarket", 400, "Current odds", { operation: "price", query: "", market: "will-bitcoin-reach-100k-in-september-2026", outcome: "Yes", wallet: "", interval: "1d", limit: 10, storeIn: "result", onError: "stop" }),
      node("pmt-3", "dashboard", 720, "Chart it", { dashboard: "Prediction markets", series: "BTC 100k — chance of Yes (0–1)", value: "{{result.price}}", label: "", chart: "line", mode: "append", keep: 500, onError: "continue" }),
    ],
    edges: chain("pmt", ["pmt-1", "pmt-2", "pmt-3"]),
  },
  {
    id: "wallet-deposit-notify",
    name: "Wallet deposit notification",
    description: "Watches an Ethereum or Base wallet (no key needed) and sends a Telegram message whenever coins arrive, with the amount and the new balance.",
    category: "Crypto",
    level: "starter",
    requires: ["The wallet address to watch", "A Telegram bot token and chat ID"],
    nodes: [
      node("wdn-1", "walletDepositTrigger", 80, "Deposit arrived", { network: "base", address: "", tokenAddress: "", minAmount: 0, rpcUrl: "", pollInterval: 2, onError: "stop" }),
      node("wdn-2", "telegramSend", 400, "Tell me", { ...TELEGRAM, text: "💰 Received {{amount}} {{asset}} on {{network}}. New balance: {{balance}}." }),
    ],
    edges: chain("wdn", ["wdn-1", "wdn-2"]),
  },
];

/** Public shape: everything but the graph lives in the list view. */
export function templateSummaries() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    level: t.level,
    requires: t.requires || [],
    nodeCount: (t.nodes || []).length,
    edgeCount: (t.edges || []).length,
  }));
}

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}
