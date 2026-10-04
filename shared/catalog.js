// ============================================================================
// W FLOW — shared node catalog
// Single source of truth for every node type available in the builder.
// Used by the frontend (palette + inspector) and the backend (executor).
// ============================================================================
// Extra node types (missing core/logic nodes + external service integrations)
// live in ./services.js and are merged into NODES below.
import { EXTRA_NODES } from "./services.js";
import { applyOAuthFields } from "./oauth.js";
import { applyAiControlFields } from "./ai-controls.js";

export const CATEGORIES = {
  triggers: { label: "Triggers", color: "#8fb0d8" },
  files: { label: "Files & Data", color: "#6f95c4" },
  actions: { label: "Actions", color: "#5a80b8" },
  ai: { label: "AI & Agents", color: "#7fa8e0" },
  logic: { label: "Logic", color: "#4a6fa8" },
  // Presets that reuse existing engines, shown as their own palette groups
  feeds: { label: "Feeds & Sources", color: "#4fb3a9" },
  integrations: { label: "More Integrations", color: "#c9a25a" },
};

export const NODE_KINDS = {
  trigger: "trigger",
  action: "action",
  ai: "ai",
  logic: "logic",
};

// "Save output as file" — added to nodes that can produce file content. When
// filled in, the node's output is written into the run as a named file that
// downstream Extract File nodes can request by name.
const outputFileFields = [
  {
    key: "outputFile",
    label: "Save output as file",
    type: "text",
    placeholder: "report.pdf",
    help: "Give this node's output a file name (extension sets the type). A downstream Extract File node can then pick this file by name.",
    section: "Output file",
    optional: true,
  },
];

// ---- Telegram ----
// Every Telegram node picks a connected bot ("Connect Telegram",
// server/telegram-bots.js) and keeps the pasted token only as an advanced
// fallback, so a bot token does not have to live in every node.
const TG_BOT_FIELDS = [
  {
    key: "telegramBot",
    label: "Telegram bot",
    type: "telegramBot",
    section: "Bot",
    help: "Connect your bot once (paste its token from @BotFather) and pick it here. Then message the bot from your own Telegram account and press “Find my chat” to link that chat.",
  },
  {
    key: "botToken",
    label: "Bot token (advanced — instead of connecting)",
    type: "secret",
    section: "Bot",
    optional: true,
    help: "Only needed when no bot is connected above. @BotFather → /newbot (or /token) gives you one.",
  },
];
// Nodes that can also run as the person's own Telegram account
// (server/telegram-accounts.js) put a "Connect as" choice in front. The bot
// fields stay visible for older workflows that have no choice saved yet.
const NOT_ACCOUNT = { key: "connectAs", value: "account", not: true };
const TG_CONNECT_FIELDS = [
  {
    key: "connectAs",
    label: "Connect as",
    type: "select",
    options: [
      { value: "bot", label: "A bot" },
      { value: "account", label: "My Telegram account" },
    ],
    section: "Telegram",
    help: "A bot is a separate Telegram user you create with @BotFather. “My Telegram account” sends and receives as you — people see your name. Don't use it for bulk messages: Telegram bans personal accounts that behave like bots.",
  },
  { ...TG_BOT_FIELDS[0], section: "Telegram", visibleWhen: NOT_ACCOUNT },
  {
    key: "telegramAccount",
    label: "Telegram account",
    type: "telegramAccount",
    section: "Telegram",
    visibleWhen: { key: "connectAs", value: "account" },
    help: "Log in once with your phone number and the code Telegram sends you. You need your own API ID from my.telegram.org — the login form explains the two clicks.",
  },
  { ...TG_BOT_FIELDS[1], section: "Telegram", visibleWhen: NOT_ACCOUNT },
];
const TG_CHAT_HELP ="Where to send it. Reply to whoever triggered the workflow with {{message.chat.id}}, or use the chat ID “Find my chat” filled in. Channels also accept @channelname.";
const TG_CHAT = { key: "chatId", label: "Chat ID", type: "text", section: "Message", help: TG_CHAT_HELP, example: "123456789" };
const TG_PARSE_MODE = { key: "parseMode", label: "Formatting", type: "select", options: ["none", "HTML", "MarkdownV2"], section: "Message", optional: true, help: "How Telegram reads *bold* / <b>bold</b> in the text. none sends it exactly as written." };
const TG_FILE_FIELD = {
  key: "fileField",
  label: "Upload from field",
  type: "text",
  section: "Message",
  optional: true,
  help: "Name of an incoming field holding the file as base64 (e.g. base64 from Telegram — Download File, or an AI image). Used instead of the URL above.",
  example: "base64",
};
const TG_SILENT = { key: "silent", label: "Send silently", type: "boolean", section: "Message", optional: true, help: "Deliver without a notification sound." };
const TG_BUTTONS = {
  key: "buttons",
  label: "Buttons (inline keyboard JSON)",
  type: "json",
  section: "Message",
  optional: true,
  help: "Rows of buttons under the message. A press fires a Telegram trigger set to “button presses” with callback_query.data.",
  example: '[[{"text":"Yes","callback_data":"yes"},{"text":"Open site","url":"https://w-flow.tech"}]]',
};

// `account: true` — the node also runs as the person's own account.
function tgNode(type, name, description, defaults, fields, { account = false } = {}) {
  return {
    kind: NODE_KINDS.action,
    category: "actions",
    sources: ["out"],
    type,
    name,
    description,
    icon: "telegram",
    defaults: { ...(account ? { connectAs: "bot", telegramAccount: "" } : {}), telegramBot: "", botToken: "", ...defaults },
    fields: [...(account ? TG_CONNECT_FIELDS : TG_BOT_FIELDS), ...fields],
  };
}

// ----------------------------------------------------------------------------
// TRIGGERS
// ----------------------------------------------------------------------------
// Trigger nodes start a workflow. "manual", "webhook" and "schedule" are fully
// wired: manual runs on demand, webhook receives real HTTP requests at
// /webhook/:workflowId, schedule defines a cron expression (execution happens
// when the workflow is run). Service triggers (Gmail, Slack, …) are modelled
// with realistic credential + filter config; on manual run they emit a
// representative sample payload so the downstream logic can be exercised.
// ----------------------------------------------------------------------------

const triggerBase = {
  kind: NODE_KINDS.trigger,
  category: "triggers",
  sources: ["out"],
};

const T = {
  manual: {
    ...triggerBase,
    type: "manual",
    name: "Manual Trigger",
    description: "Run the workflow by hand from the editor.",
    icon: "hand",
    defaults: {},
    fields: [],
  },

  webhook: {
    ...triggerBase,
    type: "webhook",
    name: "Webhook",
    description: "Start the workflow when an HTTP request hits /webhook/:id. Pressing Run waits for a real request — it never invents test data.",
    icon: "webhook",
    defaults: { method: "POST", responseMode: "json", customResponse: '{"ok":true}', secret: "", live: false },
    fields: [
      {
        key: "method",
        label: "Method",
        type: "select",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        help: "Only requests with this method trigger the workflow (others get a 405). For GET the query string is the input.",
        section: "Request",
      },
      {
        key: "responseMode",
        label: "Respond with",
        type: "select",
        options: [
          { value: "json", label: "Execution result (JSON)" },
          { value: "ok", label: "Simple 200 OK" },
          { value: "custom", label: "Custom response" },
        ],
        section: "Request",
      },
      { key: "customResponse", label: "Custom response body", type: "textarea", placeholder: '{"ok": true}', section: "Request" },
      {
        key: "secret",
        label: "Secret header value (optional)",
        type: "secret",
        placeholder: "my-secret",
        help: "If set, incoming requests must include the X-W-Flow-Secret header with this value, otherwise the webhook is rejected (401).",
        section: "Security",
      },
      {
        key: "live",
        label: "Always listen (while the server runs)",
        type: "boolean",
        section: "Security",
        help: "Off (default): the webhook only listens while a Run is waiting for a request — the run is one-shot and you press Run again to re-arm it. On: the server keeps this webhook armed continuously, so requests run the workflow even when nobody is in the editor (each request counts toward the owner's daily run cap).",
      },
    ],
  },

  schedule: {
    ...triggerBase,
    type: "schedule",
    name: "Schedule (Cron)",
    description: "Trigger on a time schedule using a cron expression.",
    icon: "clock",
    defaults: { cron: "0 9 * * 1-5", timezone: "" },
    fields: [
      { key: "cron", label: "Cron expression", type: "text", placeholder: "0 9 * * 1-5", help: "min hour day month weekday" },
      { key: "timezone", label: "Timezone (optional)", type: "text", placeholder: "Europe/Berlin" },
    ],
  },

  gmail: {
    ...triggerBase,
    type: "gmail",
    name: "Gmail — New Email",
    description: "Runs the workflow when new mail arrives in a Gmail inbox (checked every few minutes) — Run fires a sample message for building the flow.",
    icon: "mail",
    // Read over IMAP with an app password, not the Gmail API: reading mail
    // through the API needs Google's restricted scopes, which the cloud is not
    // verified for (shared/oauth.js). An app password is revocable and is
    // never the Google account password. Polled by server/app-triggers.js.
    defaults: {
      user: "",
      appPassword: "",
      folder: "INBOX",
      pollInterval: 5,
      filterFrom: "",
      filterSubject: "",
    },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Live: once the Gmail address and app password are saved, the server checks the inbox every few minutes and runs the workflow with the new messages ({{messages}}, each with from, subject, text, html, date). Mail that was already there when you saved never fires. Pressing Run fires a sample message so you can build the flow first." },
      { key: "user", label: "Gmail address", type: "text", placeholder: "you@gmail.com", section: "Mailbox" },
      {
        key: "appPassword",
        label: "App password",
        type: "secret",
        placeholder: "abcd efgh ijkl mnop",
        section: "Mailbox",
        help: "NOT your Google password. Turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords (16 letters). It only lets W flow read mail, you can revoke it there any time, and it is stored encrypted. IMAP must be on in Gmail → Settings → Forwarding and POP/IMAP.",
      },
      { key: "folder", label: "Folder / label", type: "text", placeholder: "INBOX", section: "Mailbox", help: "INBOX, or a label such as Invoices. Gmail's own folders are named like [Gmail]/Sent Mail." },
      { key: "pollInterval", label: "Check every (minutes)", type: "number", placeholder: "5", help: "How often the server looks for new mail (at least 1 minute). Each workflow run it starts counts toward the daily run cap; checking itself is free." },
      { key: "filterFrom", label: "Only from (optional)", type: "text", placeholder: "boss@company.com", help: "Only mail whose sender contains this text fires the workflow." },
      { key: "filterSubject", label: "Subject contains (optional)", type: "text", placeholder: "Invoice", help: "Only mail whose subject contains this text fires the workflow." },
    ],
  },

  slackTrigger: {
    ...triggerBase,
    type: "slackTrigger",
    name: "Slack — New Message",
    description: "Fires when you press Run with a realistic sample Slack message — live Events API delivery is not connected yet.",
    icon: "slack",
    defaults: { channel: "", token: "", filterKeyword: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Slack message so you can design and test the flow. Live Events API delivery is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "channel", label: "Channel", type: "text", placeholder: "#general" },
      { key: "token", label: "Bot token (xoxb-…)", type: "secret" },
      { key: "filterKeyword", label: "Keyword filter (optional)", type: "text" },
    ],
  },

  githubTrigger: {
    ...triggerBase,
    type: "githubTrigger",
    name: "GitHub — New Issue",
    description: "Runs the workflow for real GitHub webhook deliveries when live listening is on — Run fires a sample event for building the flow.",
    icon: "github",
    defaults: { owner: "", repo: "", token: "", event: "issues", filterLabel: "", webhookSecret: "", live: false },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample GitHub event so you can build the flow. To receive REAL events: enable 'Always listen' below, copy this workflow's id (it is in the editor URL), then in the repo go to Settings → Webhooks → Add webhook with Payload URL <your-server>/webhook/<workflow-id>, Content type application/json, the Secret you set below, and the event type selected here. The server verifies each delivery's X-Hub-Signature-256 and runs the workflow for every matching event." },
      { key: "owner", label: "Owner (filter)", type: "text", placeholder: "octocat", help: "When set, only deliveries for this owner fire the workflow.", section: "Webhook filters" },
      { key: "repo", label: "Repository (filter)", type: "text", placeholder: "Hello-World", help: "When set, only deliveries for this repository fire the workflow.", section: "Webhook filters" },
      { key: "token", label: "Personal access token", type: "secret", section: "Webhook filters" },
      {
        key: "event",
        label: "Event",
        type: "select",
        options: [
          { value: "issues", label: "Issues" },
          { value: "pull_request", label: "Pull requests" },
          { value: "push", label: "Push" },
        ],
        section: "Webhook filters",
      },
      { key: "filterLabel", label: "Label filter (optional)", type: "text", section: "Webhook filters", help: "Only fire when the issue / pull request carries this label." },
      {
        key: "webhookSecret",
        label: "Webhook secret (optional)",
        type: "secret",
        section: "Live GitHub",
        placeholder: "configure in GitHub → Settings → Webhooks",
        help: "GitHub signs every delivery with this secret (X-Hub-Signature-256). When set, only requests with a valid signature are accepted — always set it on a public server.",
      },
      {
        key: "live",
        label: "Always listen (while the server runs)",
        type: "boolean",
        section: "Live GitHub",
        help: "Off (default): like a webhook, Run listens for exactly one delivery. On: the server accepts GitHub deliveries for this workflow continuously, even when nobody is in the editor (each run counts toward the owner's daily run cap).",
      },
    ],
  },

  telegramTrigger: {
    ...triggerBase,
    type: "telegramTrigger",
    name: "Telegram — New Message",
    description: "Runs the workflow for new bot messages, commands or button presses while live polling is on — Run fires a sample update for building the flow.",
    icon: "telegram",
    defaults: { connectAs: "bot", telegramAccount: "", telegramBot: "", botToken: "", updates: "text messages", command: "", chatId: "", live: false },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample update so you can build the flow. Enable 'Always listen' below and the server listens to this bot while it is running — each matching update then runs the workflow, even with the page closed." },
      ...TG_CONNECT_FIELDS,
      {
        key: "updates",
        label: "Listen for",
        type: "select",
        options: ["text messages", "all messages", "commands", "button presses", "everything"],
        section: "Filter",
        help: "text messages: messages with text or a caption. all messages: also photos, files, stickers, voice. commands: only /commands. button presses: taps on inline buttons (callback_query). everything: all of that plus edits and channel posts.",
      },
      { key: "command", label: "Command", type: "text", section: "Filter", placeholder: "/start", visibleWhen: { key: "updates", value: "commands" }, help: "Only fire for this command. Leave empty to fire for every /command." },
      { key: "chatId", label: "Chat ID (optional)", type: "text", section: "Filter", help: "Only fire for updates from this chat (e.g. the numeric id of your chat/group). Leave empty to fire for every chat the bot is in." },
      {
        key: "live",
        label: "Always listen (while the server runs)",
        type: "boolean",
        help: "Off (default): Run fires a sample update for building the flow. On: the server keeps one open connection to Telegram for this bot and runs the workflow for each matching update, even with the page closed (each run counts toward the owner's daily run cap).",
      },
    ],
  },

  imap: {
    ...triggerBase,
    type: "imap",
    name: "Inbound Email (IMAP)",
    description: "Runs the workflow when new mail arrives in any IMAP mailbox (GMX, web.de, iCloud, Yahoo, your own domain …) — Run fires a sample message for building the flow.",
    icon: "inbox",
    defaults: { host: "", port: 993, secure: true, user: "", appPassword: "", folder: "INBOX", pollInterval: 10, filterFrom: "", filterSubject: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Live: once host, username and password are saved, the server checks the folder every few minutes and runs the workflow with the new messages ({{messages}}, each with from, subject, text, html, date). Mail that was already there when you saved never fires. Pressing Run fires a sample message so you can build the flow first. For Gmail use the Gmail — New Email trigger." },
      { key: "host", label: "IMAP host", type: "text", placeholder: "imap.example.com", section: "Mailbox", help: "Your provider's IMAP server, e.g. imap.gmx.net, imap.web.de, imap.mail.me.com, imap.mail.yahoo.com. Outlook.com and Microsoft 365 no longer accept passwords over IMAP." },
      { key: "port", label: "Port", type: "number", section: "Mailbox" },
      { key: "secure", label: "Use TLS", type: "boolean", section: "Mailbox" },
      { key: "user", label: "Username", type: "text", placeholder: "you@example.com", section: "Mailbox" },
      { key: "appPassword", label: "Password / app password", type: "secret", section: "Mailbox", help: "Use an app password when your provider offers one. Stored encrypted." },
      { key: "folder", label: "Folder", type: "text", placeholder: "INBOX", section: "Mailbox" },
      { key: "pollInterval", label: "Check every (minutes)", type: "number", placeholder: "5", help: "How often the server looks for new mail (at least 1 minute). Each workflow run it starts counts toward the daily run cap; checking itself is free." },
      { key: "filterFrom", label: "Only from (optional)", type: "text", help: "Only mail whose sender contains this text fires the workflow." },
      { key: "filterSubject", label: "Subject contains (optional)", type: "text", help: "Only mail whose subject contains this text fires the workflow." },
    ],
  },

  notionTrigger: {
    ...triggerBase,
    type: "notionTrigger",
    name: "Notion — Database Update",
    description: "Fires when you press Run with a realistic sample Notion event — live database watching is not connected yet.",
    icon: "notion",
    defaults: { token: "", databaseId: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Notion event so you can design and test the flow. Live database watching is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "token", label: "Integration token", type: "secret" },
      { key: "databaseId", label: "Database ID", type: "text" },
    ],
  },

  sheetsTrigger: {
    ...triggerBase,
    type: "sheetsTrigger",
    name: "Google Sheets — New Row",
    description: "Runs the workflow when rows are added to a Google Sheets tab (checked every few minutes) — Run fires a sample row for building the flow.",
    icon: "sheet",
    defaults: { spreadsheetId: "", sheetName: "", apiKey: "", pollInterval: 5 },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Live: once the spreadsheet is set and a Google account is connected (or an API key for a public sheet), the server checks the tab every few minutes and runs the workflow with the rows added since ({{rows}} — each row an object named by the header row — plus {{values}} and {{firstRow}}). Rows already there when you saved never fire. Pressing Run fires a sample row so you can build the flow first." },
      { key: "spreadsheetId", label: "Spreadsheet ID", type: "text", help: "The long id in the sheet's URL: docs.google.com/spreadsheets/d/<this part>/edit." },
      { key: "sheetName", label: "Sheet name", type: "text", placeholder: "first tab", help: "The tab name at the bottom of the spreadsheet. Leave empty to use the first tab. Row 1 is read as the column names." },
      { key: "apiKey", label: "API key (public sheets only)", type: "secret" },
      { key: "pollInterval", label: "Check every (minutes)", type: "number", placeholder: "5", help: "How often the server looks for new rows (at least 1 minute). Each workflow run it starts counts toward the daily run cap; checking itself is free." },
    ],
  },

  teamsTrigger: {
    ...triggerBase,
    type: "teamsTrigger",
    name: "Teams — New Message",
    description: "Fires when you press Run with a realistic sample Teams message — live eventing is not connected yet.",
    icon: "users",
    defaults: { channel: "General", filterKeyword: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Teams message so you can design and test the flow. Live channel eventing is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "channel", label: "Channel", type: "text" },
      { key: "filterKeyword", label: "Keyword filter (optional)", type: "text" },
    ],
  },

  outlookTrigger: {
    ...triggerBase,
    type: "outlookTrigger",
    name: "Outlook 365 — New Email",
    description: "Fires when you press Run with a realistic sample email — live mailbox polling is not connected yet.",
    icon: "mail",
    defaults: { token: "", mailbox: "", folder: "Inbox", filterFrom: "", filterSubject: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample email so you can design and test the flow. Live Microsoft 365 mailbox polling is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "token", label: "Graph API token", type: "secret" },
      { key: "mailbox", label: "Mailbox (email)", type: "text" },
      { key: "folder", label: "Folder", type: "text" },
      { key: "filterFrom", label: "Only from (optional)", type: "text" },
      { key: "filterSubject", label: "Subject contains (optional)", type: "text" },
    ],
  },

  stripeTrigger: {
    ...triggerBase,
    type: "stripeTrigger",
    name: "Stripe — Payment Event",
    description: "Runs the workflow for real Stripe webhook events (payments, checkouts, invoices) — Run fires a sample event for building the flow.",
    icon: "creditCard",
    defaults: { mode: "checkout.session.completed", webhookSecret: "", live: false },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run with no test data waits for a real Stripe event. To receive events: in Stripe go to Developers → Webhooks → Add endpoint, use <your-server>/webhook/<workflow-id> as the URL (the id is in the editor URL), select the event chosen below, then paste the endpoint's signing secret here. Stripe's \"Send test event\" button works for trying it. Turn on Always listen to run for every event, even with the editor closed." },
      {
        key: "mode",
        label: "Event",
        type: "select",
        options: [
          { value: "checkout.session.completed", label: "Checkout completed" },
          { value: "invoice.paid", label: "Invoice paid" },
          { value: "payment_intent.succeeded", label: "Payment succeeded" },
          { value: "payment_intent.payment_failed", label: "Payment failed" },
          { value: "customer.subscription.created", label: "Subscription created" },
          { value: "customer.subscription.deleted", label: "Subscription cancelled" },
          { value: "charge.refunded", label: "Charge refunded" },
          { value: "*", label: "Any event" },
        ],
      },
      {
        key: "webhookSecret",
        label: "Signing secret",
        type: "secret",
        placeholder: "whsec_…",
        section: "Live Stripe",
        help: "Shown on the webhook endpoint in Stripe (Reveal signing secret). Required: every delivery is checked against it, so nobody can fake a payment by posting to the URL.",
      },
      {
        key: "live",
        label: "Always listen (while the server runs)",
        type: "boolean",
        section: "Live Stripe",
        help: "Off (default): like a webhook, Run listens for exactly one event. On: the server accepts Stripe events for this workflow continuously, even when nobody is in the editor (each run counts toward the owner's daily run cap).",
      },
    ],
  },

  jiraTrigger: {
    ...triggerBase,
    type: "jiraTrigger",
    name: "Jira — Issue Event",
    description: "Fires when you press Run with a realistic sample Jira issue event — live webhooks are not connected yet.",
    icon: "ticket",
    defaults: { baseUrl: "", email: "", apiToken: "", projectKey: "", event: "issue_created" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Jira issue event so you can design and test the flow. Live Jira webhook delivery is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "baseUrl", label: "Jira base URL", type: "text", placeholder: "https://your.atlassian.net", section: "Credentials" },
      { key: "email", label: "Email", type: "text", section: "Credentials" },
      { key: "apiToken", label: "API token", type: "secret", section: "Credentials" },
      { key: "projectKey", label: "Project key", type: "text", placeholder: "PROJ", section: "Credentials" },
      {
        key: "event",
        label: "Event",
        type: "select",
        options: [
          { value: "issue_created", label: "Issue created" },
          { value: "issue_updated", label: "Issue updated" },
        ],
        section: "Event",
      },
    ],
  },

  // Removed duplicate triggers — merged into their sibling triggers so the
  // palette stays clean: notionDbTrigger → notionTrigger, sheetsAppendTrigger
  // → sheetsTrigger, jiraIssueUpdateTrigger → jiraTrigger (now "Jira — Issue
  // Event" with an event selector). Workflows saved with the old types still
  // run: the executor aliases them (see server/executor.js).

  discordTrigger: {
    ...triggerBase,
    type: "discordTrigger",
    name: "Discord — New Message",
    description: "Fires when you press Run with a realistic sample Discord message — live message delivery is not connected yet.",
    icon: "discord",
    defaults: { channel: "", filterKeyword: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Discord message so you can design and test the flow. Live channel delivery is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "channel", label: "Channel name", type: "text" },
      { key: "filterKeyword", label: "Keyword filter (optional)", type: "text" },
    ],
  },

  googleDriveTrigger: {
    ...triggerBase,
    type: "googleDriveTrigger",
    name: "Google Drive — New File",
    description: "Fires when you press Run with a realistic sample Drive file event — live folder watching is not connected yet.",
    icon: "folder",
    defaults: { token: "", folderId: "", pollInterval: 5 },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Drive file event so you can design and test the flow. Live folder watching is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "token", label: "OAuth2 access token", type: "secret" },
      { key: "folderId", label: "Folder ID (empty = root)", type: "text" },
      { key: "pollInterval", label: "Poll interval (min)", type: "number" },
    ],
  },

  rssTrigger: {
    ...triggerBase,
    type: "rssTrigger",
    name: "RSS Feed — New Item",
    description: "Runs the workflow when a new item appears in an RSS / Atom feed — the server polls the feed on the interval you set.",
    icon: "list",
    defaults: { url: "", pollInterval: 5 },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "When this workflow is saved, the server polls the feed on the interval set below and runs the workflow when new items appear (each fire counts toward the owner's daily run cap, like cron). The first poll after a restart only records the current feed, so existing items never fire. Pressing Run from the editor fires a sample entry so you can design the downstream steps." },
      { key: "url", label: "Feed URL", type: "text", placeholder: "https://example.com/feed.xml" },
      { key: "pollInterval", label: "Poll interval (min)", type: "number" },
    ],
  },

  // Crypto triggers: polled by the scheduler (server/crypto-triggers.js) and
  // fired once per event — crossing a level, not every poll above it.
  cryptoPriceTrigger: {
    ...triggerBase,
    type: "cryptoPriceTrigger",
    name: "Crypto Price Alert",
    description: "Runs the workflow when a coin's price on an exchange rises above or falls below a level, or moves by a percentage.",
    icon: "candlestick",
    defaults: { exchange: "binance", symbol: "BTCUSDT", condition: "above", threshold: 100000, pollInterval: 1 },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Once saved, the server checks the price on the interval below and runs the workflow once each time the condition happens — crossing the level, not every check while the price stays past it. The first check after a restart only records the current price. Each run counts toward the owner's daily run cap. Pressing Run in the editor fires a sample alert." },
      {
        key: "exchange",
        label: "Exchange",
        type: "select",
        options: [
          { value: "binance", label: "Binance" },
          { value: "coinbase", label: "Coinbase" },
          { value: "kraken", label: "Kraken" },
          { value: "bybit", label: "Bybit" },
          { value: "okx", label: "OKX" },
          { value: "kucoin", label: "KuCoin" },
        ],
      },
      { key: "symbol", label: "Trading pair", type: "text", placeholder: "BTCUSDT", help: "In the exchange's own format: BTCUSDT (Binance, Bybit), BTC-USD (Coinbase), BTC-USDT (OKX, KuCoin), XBTUSD (Kraken)." },
      {
        key: "condition",
        label: "Run when the price",
        type: "select",
        options: [
          { value: "above", label: "rises above" },
          { value: "below", label: "falls below" },
          { value: "change", label: "moves by at least (%)" },
        ],
      },
      { key: "threshold", label: "Level / percent", type: "number", help: "A price in the quote coin for “rises above” / “falls below”, or a percentage for “moves by”. A move is measured from the price at the last alert." },
      { key: "pollInterval", label: "Check every (min)", type: "number", help: "At least 1 minute." },
    ],
  },

  polymarketTrigger: {
    ...triggerBase,
    type: "polymarketTrigger",
    name: "Polymarket Odds Alert",
    description: "Runs the workflow when a Polymarket outcome's chance rises above or falls below a level, or moves by some points.",
    icon: "prediction",
    defaults: { market: "", outcome: "Yes", condition: "above", threshold: 50, pollInterval: 5 },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Once saved, the server checks the market on the interval below and runs the workflow once each time the condition happens. The first check after a restart only records the current chance. Each run counts toward the owner's daily run cap. Pressing Run in the editor fires a sample alert." },
      { key: "market", label: "Market", type: "text", placeholder: "will-bitcoin-reach-100k-in-september-2026", help: "Paste the market's polymarket.com link, or its slug or ID." },
      { key: "outcome", label: "Outcome", type: "text", placeholder: "Yes" },
      {
        key: "condition",
        label: "Run when the chance",
        type: "select",
        options: [
          { value: "above", label: "rises above (%)" },
          { value: "below", label: "falls below (%)" },
          { value: "change", label: "moves by at least (points)" },
        ],
      },
      { key: "threshold", label: "Level / points", type: "number", help: "A chance in percent (62 = 62 %), or for “moves by” a number of percentage points measured from the last alert." },
      { key: "pollInterval", label: "Check every (min)", type: "number", help: "At least 1 minute." },
    ],
  },

  walletDepositTrigger: {
    ...triggerBase,
    type: "walletDepositTrigger",
    name: "Wallet Deposit",
    description: "Runs the workflow when coins or tokens arrive in an EVM wallet (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain).",
    icon: "wallet",
    defaults: { network: "ethereum", address: "", tokenAddress: "", minAmount: 0, rpcUrl: "", pollInterval: 2 },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Once saved, the server checks the wallet's balance on the interval below and runs the workflow when it went up, with the amount received. The first check after a restart only records the current balance. Deposits and a withdrawal inside the same interval net out. Each run counts toward the owner's daily run cap. Pressing Run in the editor fires a sample deposit." },
      {
        key: "network",
        label: "Network",
        type: "select",
        options: [
          { value: "ethereum", label: "Ethereum" },
          { value: "base", label: "Base" },
          { value: "arbitrum", label: "Arbitrum One" },
          { value: "optimism", label: "Optimism" },
          { value: "polygon", label: "Polygon" },
          { value: "bsc", label: "BNB Smart Chain" },
        ],
      },
      { key: "address", label: "Wallet address", type: "text", placeholder: "0x…", help: "Any address — no key needed, the balance is public." },
      { key: "tokenAddress", label: "Token contract (optional)", type: "text", placeholder: "0x…", help: "Watch an ERC-20 token such as USDC instead of the network's coin." },
      { key: "minAmount", label: "Minimum amount", type: "number", help: "Ignore deposits smaller than this (dust). 0 = any." },
      { key: "rpcUrl", label: "RPC URL (optional)", type: "text", placeholder: "https://…", help: "Leave empty for a free public node." },
      { key: "pollInterval", label: "Check every (min)", type: "number", help: "At least 1 minute." },
    ],
  },

  errorTrigger: {
    ...triggerBase,
    type: "errorTrigger",
    name: "Error Trigger",
    description: "Runs this workflow whenever one of your OTHER workflows fails — the account-wide error handler. Press Run with the input panel to test it with an error payload.",
    icon: "siren",
    defaults: {},
    fields: [
      {
        key: "sampleInfo",
        label: "How it works",
        type: "note",
        help: "This node is the account-wide error handler: whenever any of your other workflows finishes with a failed node, the server runs THIS workflow and hands it one item with everything about the failure — the workflow (id, name), the failing node (id, name, type), the error (message, code, marker) and the run (source, started at, duration, node/error counts). Use it to alert yourself, open a ticket or write to a log. Pressing Run opens the input panel so you can paste a payload and design the flow; live routing needs no further setup — save the workflow and it is armed.",
      },
    ],
  },

  hubspotTrigger: {
    ...triggerBase,
    type: "hubspotTrigger",
    name: "HubSpot — New Contact",
    description: "Fires when you press Run with a realistic sample HubSpot contact event — live webhooks are not connected yet.",
    icon: "users",
    defaults: { apiKey: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample HubSpot contact event so you can design and test the flow. Live webhook delivery is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "apiKey", label: "API key (private app token)", type: "secret" },
    ],
  },

  airtableTrigger: {
    ...triggerBase,
    type: "airtableTrigger",
    name: "Airtable — New Record",
    description: "Fires when you press Run with a realistic sample Airtable record — live table watching is not connected yet.",
    icon: "table",
    defaults: { apiKey: "", baseId: "", tableName: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Airtable record so you can design and test the flow. Live table watching is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "apiKey", label: "API key (pat)", type: "secret" },
      { key: "baseId", label: "Base ID", type: "text" },
      { key: "tableName", label: "Table name", type: "text" },
    ],
  },

  supabaseTrigger: {
    ...triggerBase,
    type: "supabaseTrigger",
    name: "Supabase — New Row",
    description: "Fires when you press Run with a realistic sample Supabase row event — live database watching is not connected yet.",
    icon: "database",
    defaults: { url: "", anonKey: "", tableName: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Supabase row event so you can design and test the flow. Live database watching is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "url", label: "Project URL", type: "text", placeholder: "https://xyzcompany.supabase.co" },
      { key: "anonKey", label: "anon / service key", type: "secret" },
      { key: "tableName", label: "Table name", type: "text" },
    ],
  },

  slackReactionTrigger: {
    ...triggerBase,
    type: "slackReactionTrigger",
    name: "Slack — Message Reacted",
    description: "Fires when you press Run with a realistic sample Slack reaction event — live delivery is not connected yet.",
    icon: "slack",
    defaults: { token: "", filterEmoji: "" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a realistic sample Slack reaction event so you can design and test the flow. Live Events API delivery is not connected yet — Webhook, Schedule and Manual triggers execute for real." },
      { key: "token", label: "Bot token (xoxb-…)", type: "secret" },
      { key: "filterEmoji", label: "Filter by emoji (optional)", type: "text" },
    ],
  },

  // Chat trigger — pressing Run opens a chat panel (in the Log console) instead
  // of inventing input: every message you send becomes the trigger payload, and
  // a downstream Chat Output node posts the reply back into the same panel.
  chatTrigger: {
    ...triggerBase,
    type: "chatTrigger",
    name: "Chat Trigger",
    description: "Start the workflow with a chat message. Pressing Run opens a chat panel — nothing executes until you send a message.",
    icon: "messageCircle",
    defaults: { welcome: "Hi! Ask me anything and this workflow will answer." },
    fields: [
      { key: "chatInfo", label: "About this trigger", type: "note", help: "Pressing Run opens a chat panel in the Log console and waits for a message — no sample input is invented. Each message you send runs the workflow with { message, text, history } as the input. Use a Chat Output node to send the reply back into the panel." },
      { key: "welcome", label: "Welcome message", type: "text", placeholder: "Hi! Ask me anything…", help: "Shown in the chat panel before the first message.", section: "Chat", optional: true },
    ],
  },
};

// ----------------------------------------------------------------------------
// ACTIONS
// ----------------------------------------------------------------------------

const actionBase = { kind: NODE_KINDS.action, category: "actions", sources: ["out"] };

// ---- crypto exchanges ----
// Every exchange node shares one field layout so a workflow can swap
// exchanges without relearning the node; server/crypto-exchanges.js does the
// per-exchange signing. Orders default to test mode because they move real money.
const ORDER_OPS = ["marketOrder", "limitOrder"];

// Spending guards for nodes that move money (server/spend-limits.js).
function spendLimitFields(visibleWhen, unitHelp) {
  return [
    { key: "maxAmount", label: "Max amount per order", type: "number", help: `Refuse any single order or transfer above this amount (${unitHelp}). 0 = no limit.`, section: "Limits", visibleWhen },
    { key: "maxDaily", label: "Max total per day", type: "number", help: `Refuse once today's real orders or transfers would add up to more than this (${unitHelp}; resets at midnight UTC). 0 = no limit.`, section: "Limits", visibleWhen },
  ];
}
function exchangeNode({ type, name, description, symbol, symbolHelp, keyHelp, secretHelp, testHelp, quote = false, passphrase = false, baseUrl = null }) {
  const order = { key: "operation", in: ORDER_OPS };
  return {
    ...actionBase,
    type,
    name,
    description,
    icon: "candlestick",
    defaults: {
      operation: "price",
      symbol,
      side: "buy",
      amount: "",
      ...(quote ? { amountIn: "base" } : {}),
      limitPrice: "",
      testMode: true,
      maxAmount: 0,
      maxDaily: 0,
      orderId: "",
      apiKey: "",
      secret: "",
      ...(passphrase ? { passphrase: "" } : {}),
      ...(baseUrl ? { baseUrl: baseUrl.url } : {}),
      storeIn: "result",
    },
    fields: [
      {
        key: "operation",
        label: "Operation",
        type: "select",
        options: [
          { value: "price", label: "Get price (no API key needed)" },
          { value: "balances", label: "Get balances" },
          { value: "openOrders", label: "List open orders" },
          { value: "marketOrder", label: "Place market order" },
          { value: "limitOrder", label: "Place limit order" },
          { value: "getOrder", label: "Get order status" },
          { value: "cancelOrder", label: "Cancel order" },
        ],
        section: "Operation",
      },
      { key: "symbol", label: "Trading pair (supports {{vars}})", type: "text", placeholder: symbol, help: `${symbolHelp} Leave empty under “List open orders” to list every pair.`, section: "Operation", visibleWhen: { key: "operation", value: "balances", not: true } },
      { key: "side", label: "Side", type: "select", options: [{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }], section: "Order", visibleWhen: order },
      { key: "amount", label: "Amount (supports {{vars}})", type: "text", placeholder: "0.001", help: "How much to buy or sell, in the base coin (the first one in the pair) unless set otherwise below.", section: "Order", visibleWhen: order },
      ...(quote
        ? [{ key: "amountIn", label: "Amount is in", type: "select", options: [{ value: "base", label: "Base coin (e.g. BTC)" }, { value: "quote", label: "Quote coin (e.g. USD to spend)" }], section: "Order", visibleWhen: { key: "operation", value: "marketOrder" } }]
        : []),
      { key: "limitPrice", label: "Limit price (supports {{vars}})", type: "text", placeholder: "60000", help: "Price per base coin, in the quote coin. The order stays open until it fills or you cancel it.", section: "Order", visibleWhen: { key: "operation", value: "limitOrder" } },
      { key: "testMode", label: "Test mode: check the order without placing it", type: "boolean", help: testHelp || "On: the exchange validates the order but nothing is bought or sold. Turn off to trade with real money.", section: "Order", visibleWhen: order },
      ...spendLimitFields(order, "in the same unit as Amount"),
      { key: "orderId", label: "Order ID (supports {{vars}})", type: "text", placeholder: "{{result.orderId}}", section: "Order", visibleWhen: { key: "operation", in: ["getOrder", "cancelOrder"] } },
      { key: "apiKey", label: "API key", type: "secret", help: `${keyHelp} Not needed for “Get price”.`, section: "Credentials" },
      { key: "secret", label: "API secret", type: "secret", help: secretHelp, section: "Credentials" },
      ...(passphrase ? [{ key: "passphrase", label: "API passphrase", type: "secret", help: "The passphrase you chose when creating the API key.", section: "Credentials" }] : []),
      ...(baseUrl ? [{ key: "baseUrl", label: "API address", type: "text", placeholder: baseUrl.url, help: baseUrl.help, section: "Credentials" }] : []),
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "result", section: "Output" },
    ],
  };
}

const A = {
  http: {
    ...actionBase,
    type: "http",
    name: "HTTP Request",
    description: "Call any REST API.",
    icon: "globe",
    defaults: { method: "GET", url: "https://api.example.com", headers: '{\n  "Content-Type": "application/json"\n}', query: [], body: '{\n  "message": "{{message}}"\n}', timeout: 15, authType: "none", authToken: "", authUser: "", authPass: "", retries: 0, parseAs: "auto", followRedirects: true, outputFile: "" },
    fields: [
      { key: "method", label: "Method", type: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], section: "Request" },
      { key: "url", label: "URL", type: "text", placeholder: "https://…", section: "Request" },
      { key: "query", label: "Query parameters (key → value, supports {{vars}})", type: "keyvalue", placeholderField: "param", placeholderValue: "value", section: "Request" },
      {
        key: "parseAs",
        label: "Parse response as",
        type: "select",
        options: [
          { value: "auto", label: "Auto (JSON if possible)" },
          { value: "json", label: "JSON" },
          { value: "text", label: "Raw text" },
        ],
        section: "Options",
      },
      { key: "followRedirects", label: "Follow redirects", type: "boolean", section: "Options" },
      {
        key: "authType",
        label: "Authentication",
        type: "select",
        options: [
          { value: "none", label: "None" },
          { value: "bearer", label: "Bearer token" },
          { value: "basic", label: "Basic (user + password)" },
        ],
        section: "Authentication",
      },
      { key: "authToken", label: "Bearer token", type: "secret", section: "Authentication", visibleWhen: { key: "authType", value: "bearer" } },
      { key: "authUser", label: "Username", type: "text", section: "Authentication", visibleWhen: { key: "authType", value: "basic" } },
      { key: "authPass", label: "Password", type: "secret", section: "Authentication", visibleWhen: { key: "authType", value: "basic" } },
      { key: "headers", label: "Headers (JSON)", type: "json", section: "Options" },
      { key: "body", label: "Body (JSON, supports {{vars}})", type: "json", section: "Options" },
      { key: "timeout", label: "Timeout (s)", type: "number", section: "Options" },
      { key: "retries", label: "Retries on failure", type: "number", help: "Retry the request up to this many times with a short backoff.", section: "Options" },
      ...outputFileFields,
    ],
  },

  emailSend: {
    ...actionBase,
    type: "emailSend",
    name: "Send Email (SMTP)",
    description: "Send an email through your own SMTP mail server. For Gmail or Outlook use their own nodes — they sign in without a password.",
    icon: "mailSend",
    defaults: { host: "", port: 465, secure: true, user: "", appPassword: "", from: "", to: "", cc: "", replyTo: "", subject: "Workflow notification", body: "Hello!\n\n{{body}}\n\n— W flow" },
    fields: [
      { key: "sendWithAccountNote", label: "Gmail or Outlook?", type: "note", section: "Mail server", help: "Use Gmail — Send Email or Outlook 365 — Send Email instead: you connect the account with one click and never type its password here." },
      { key: "host", label: "SMTP host", type: "text", placeholder: "mail.example.com", section: "Mail server" },
      { key: "port", label: "Port", type: "number", section: "Mail server" },
      { key: "secure", label: "Use TLS/SSL", type: "boolean", section: "Mail server" },
      { key: "user", label: "Username", type: "text", section: "Mail server" },
      { key: "appPassword", label: "Password / app password", type: "secret", section: "Mail server", help: "The SMTP password of this mail server. Stored encrypted; never shared with templates." },
      { key: "from", label: "From", type: "text", section: "Message" },
      { key: "to", label: "To (comma separated)", type: "text", section: "Message" },
      { key: "cc", label: "CC (comma separated)", type: "text", section: "Message" },
      { key: "replyTo", label: "Reply-To (optional)", type: "text", section: "Message" },
      { key: "subject", label: "Subject", type: "text", section: "Message" },
      { key: "body", label: "Body", type: "textarea", section: "Message" },
    ],
  },

  slackSend: {
    ...actionBase,
    type: "slackSend",
    name: "Slack Message",
    description: "Post a message to Slack via an incoming webhook.",
    icon: "slack",
    defaults: { webhookUrl: "", channel: "", text: "Hello from W flow!", blocks: "" },
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", type: "secret" },
      { key: "channel", label: "Channel (optional)", type: "text" },
      { key: "text", label: "Message text", type: "textarea" },
      { key: "blocks", label: "Blocks (JSON, optional, supports {{vars}})", type: "json", placeholder: '[{\n  "type": "section",\n  "text": { "type": "mrkdwn", "text": "Hello *there*" }\n}]', help: "Send a rich Slack message with blocks. Overrides the plain text when present.", optional: true },
    ],
  },

  discordSend: {
    ...actionBase,
    type: "discordSend",
    name: "Discord Webhook",
    description: "Post a message to a Discord channel via webhook.",
    icon: "discord",
    defaults: { webhookUrl: "", content: "Hello from W flow!" },
    fields: [
      { key: "webhookUrl", label: "Webhook URL", type: "secret" },
      { key: "content", label: "Message content", type: "textarea" },
    ],
  },

  telegramSend: tgNode("telegramSend", "Telegram — Send Message", "Send a text message through a Telegram bot, optionally with buttons.", { chatId: "", text: "Hello from W flow!", parseMode: "none", buttons: "", replyTo: "", silent: false, disablePreview: false }, [
    TG_CHAT,
    { key: "text", label: "Message text", type: "textarea", section: "Message" },
    TG_PARSE_MODE,
    TG_BUTTONS,
    {
      key: "keyboard",
      label: "Reply keyboard (one row per line)",
      type: "textarea",
      section: "Message",
      optional: true,
      help: "Big buttons that replace the phone keyboard; a tap sends its label as a normal message. Separate buttons in a row with |.",
      example: "📋 Menu | ❓ Help\n📞 Contact",
    },
    { key: "removeKeyboard", label: "Remove reply keyboard", type: "boolean", section: "Message", optional: true, help: "Hide a reply keyboard an earlier message showed." },
    { key: "replyTo", label: "Reply to message ID", type: "text", section: "Message", optional: true, help: "Quote a message, e.g. {{message.message_id}} to answer the message that triggered the run." },
    TG_SILENT,
    { key: "disablePreview", label: "No link preview", type: "boolean", section: "Message", optional: true, help: "Do not unfurl the first link in the text." },
  ], { account: true }),

  telegramSendPhoto: tgNode("telegramSendPhoto", "Telegram — Send Photo", "Send a photo (a URL, a Telegram file_id or a file from an earlier node) with an optional caption.", { chatId: "", photo: "", fileField: "", caption: "", parseMode: "none", buttons: "", silent: false }, [
    TG_CHAT,
    { key: "photo", label: "Photo (URL or file_id)", type: "text", section: "Message", example: "https://w-flow.tech/og.png", help: "Leave empty when uploading from a field below." },
    TG_FILE_FIELD,
    { key: "caption", label: "Caption", type: "textarea", section: "Message", optional: true },
    TG_PARSE_MODE,
    TG_BUTTONS,
    TG_SILENT,
  ], { account: true }),

  telegramSendDocument: tgNode("telegramSendDocument", "Telegram — Send Document", "Send a file (a URL, a Telegram file_id or a file from an earlier node) with an optional caption.", { chatId: "", document: "", fileField: "", caption: "", parseMode: "none", buttons: "", silent: false }, [
    TG_CHAT,
    { key: "document", label: "File (URL or file_id)", type: "text", section: "Message", example: "https://example.com/report.pdf", help: "Leave empty when uploading from a field below." },
    TG_FILE_FIELD,
    { key: "caption", label: "Caption", type: "textarea", section: "Message", optional: true },
    TG_PARSE_MODE,
    TG_BUTTONS,
    TG_SILENT,
  ], { account: true }),

  telegramSendMedia: tgNode("telegramSendMedia", "Telegram — Send Audio / Video / Voice", "Send audio, video, a voice note, a GIF or a sticker (URL, file_id or a file from an earlier node).", { chatId: "", kind: "video", media: "", fileField: "", caption: "", parseMode: "none", silent: false }, [
    TG_CHAT,
    { key: "kind", label: "Type", type: "select", options: ["video", "audio", "voice", "animation", "sticker", "video_note"], section: "Message", help: "voice needs OGG/Opus; animation is a GIF or silent MP4; video_note is a round video." },
    { key: "media", label: "Media (URL or file_id)", type: "text", section: "Message", help: "Leave empty when uploading from a field below." },
    TG_FILE_FIELD,
    { key: "caption", label: "Caption", type: "textarea", section: "Message", optional: true, help: "Not shown for stickers and round videos." },
    TG_PARSE_MODE,
    TG_SILENT,
  ], { account: true }),

  telegramSetCommands: tgNode("telegramSetCommands", "Telegram — Set Bot Commands", "Set the command menu users see when they type / in the bot chat.", { commands: "/start - Start the bot\n/help - What I can do" }, [
    { key: "commands", label: "Commands (one per line: /command - description)", type: "textarea", section: "Commands", help: "Run this once (e.g. from a Manual trigger). Lowercase letters, digits and _ only, up to 32 characters per command." },
  ]),

  telegramSendLocation: tgNode("telegramSendLocation", "Telegram — Send Location", "Send a map pin for a latitude / longitude pair.", { chatId: "", latitude: "", longitude: "" }, [
    TG_CHAT,
    { key: "latitude", label: "Latitude", type: "text", section: "Message", example: "52.52" },
    { key: "longitude", label: "Longitude", type: "text", section: "Message", example: "13.405" },
  ], { account: true }),

  telegramSendPoll: tgNode("telegramSendPoll", "Telegram — Send Poll", "Post a poll with one answer option per line.", { chatId: "", question: "", options: "Yes\nNo", anonymous: true, multiple: false }, [
    TG_CHAT,
    { key: "question", label: "Question", type: "text", section: "Message" },
    { key: "options", label: "Answers (one per line)", type: "textarea", section: "Message", help: "2 to 10 answers." },
    { key: "anonymous", label: "Anonymous", type: "boolean", section: "Message", optional: true, help: "Hide who voted for what." },
    { key: "multiple", label: "Allow several answers", type: "boolean", section: "Message", optional: true, help: "Voters may tick more than one answer." },
  ]),

  telegramEditMessage: tgNode("telegramEditMessage", "Telegram — Edit Message", "Change the text (and buttons) of a message the bot sent.", { chatId: "", messageId: "", text: "", parseMode: "none", buttons: "" }, [
    TG_CHAT,
    { key: "messageId", label: "Message ID", type: "text", section: "Message", help: "message_id from the Send Message output, or {{callback_query.message.message_id}} after a button press." },
    { key: "text", label: "New text", type: "textarea", section: "Message" },
    TG_PARSE_MODE,
    TG_BUTTONS,
  ], { account: true }),

  telegramDeleteMessage: tgNode("telegramDeleteMessage", "Telegram — Delete Message", "Delete a message the bot sent, or any message in a group it moderates.", { chatId: "", messageId: "" }, [
    TG_CHAT,
    { key: "messageId", label: "Message ID", type: "text", section: "Message", help: "message_id of the message to delete." },
  ], { account: true }),

  telegramForward: tgNode("telegramForward", "Telegram — Forward Message", "Forward a message from one chat to another.", { chatId: "", fromChatId: "", messageId: "" }, [
    { ...TG_CHAT, label: "To chat ID" },
    { key: "fromChatId", label: "From chat ID", type: "text", section: "Message", example: "{{message.chat.id}}" },
    { key: "messageId", label: "Message ID", type: "text", section: "Message", example: "{{message.message_id}}" },
  ], { account: true }),

  telegramPin: tgNode("telegramPin", "Telegram — Pin Message", "Pin a message in a chat where the bot is an admin.", { chatId: "", messageId: "", silent: true }, [
    TG_CHAT,
    { key: "messageId", label: "Message ID", type: "text", section: "Message", help: "message_id of the message to pin." },
    { ...TG_SILENT, label: "Pin silently", help: "Do not notify the chat about the pin." },
  ], { account: true }),

  telegramChatAction: tgNode("telegramChatAction", "Telegram — Show Typing", "Show “typing…” (or uploading) in the chat while the workflow prepares a reply.", { chatId: "", action: "typing" }, [
    TG_CHAT,
    { key: "action", label: "Status", type: "select", options: ["typing", "upload_photo", "upload_document", "record_voice", "find_location"], section: "Message", help: "Telegram shows it for about 5 seconds or until the bot sends something." },
  ], { account: true }),

  telegramAnswerCallback: tgNode("telegramAnswerCallback", "Telegram — Answer Button Press", "Confirm an inline-button press with a short toast or alert.", { callbackQueryId: "{{callback_query.id}}", text: "", showAlert: false }, [
    { key: "callbackQueryId", label: "Button press ID", type: "text", section: "Answer", help: "callback_query.id from a Telegram trigger set to “button presses”." },
    { key: "text", label: "Text", type: "text", section: "Answer", optional: true, help: "Up to 200 characters. Empty just stops the loading spinner on the button." },
    { key: "showAlert", label: "Show as alert", type: "boolean", section: "Answer", optional: true, help: "A dialog the user must close instead of a toast." },
  ]),

  telegramGetChat: tgNode("telegramGetChat", "Telegram — Get Chat", "Read a chat's title, type, description and member count.", { chatId: "" }, [
    { ...TG_CHAT, section: "Chat" },
  ], { account: true }),

  telegramGetFile: tgNode("telegramGetFile", "Telegram — Download File", "Download a photo, voice note or document a user sent the bot (up to 20 MB) as base64.", { fileId: "" }, [
    { key: "fileId", label: "File ID", type: "text", section: "File", help: "file_id from the trigger, e.g. {{message.document.file_id}} or {{message.voice.file_id}}.", example: "{{message.document.file_id}}" },
  ]),

  telegramApi: tgNode("telegramApi", "Telegram — Bot API Call", "Call any Telegram Bot API method with JSON parameters.", { method: "getMe", params: "" }, [
    { key: "method", label: "Method", type: "text", section: "Request", help: "Any method from core.telegram.org/bots/api, e.g. sendSticker, setMyCommands, banChatMember.", example: "sendDice" },
    { key: "params", label: "Parameters (JSON, {{vars}} allowed)", type: "json", section: "Request", optional: true, example: '{"chat_id":"{{message.chat.id}}","emoji":"🎲"}' },
  ]),

  githubIssue: {
    ...actionBase,
    type: "githubIssue",
    name: "GitHub — Create Issue",
    description: "Open an issue in a repository.",
    icon: "github",
    defaults: { token: "", owner: "", repo: "", title: "Issue from W flow", body: "{{body}}", labels: "" },
    fields: [
      { key: "token", label: "Personal access token", type: "secret" },
      { key: "owner", label: "Owner", type: "text" },
      { key: "repo", label: "Repository", type: "text" },
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "textarea" },
      { key: "labels", label: "Labels (comma separated)", type: "text", optional: true },
    ],
  },

  notionPage: {
    ...actionBase,
    type: "notionPage",
    name: "Notion — Create Page",
    description: "Create a page in a Notion database.",
    icon: "notion",
    defaults: { token: "", parentDatabaseId: "", title: "New page", content: "{{body}}" },
    fields: [
      { key: "token", label: "Integration token", type: "secret" },
      { key: "parentDatabaseId", label: "Parent database ID", type: "text" },
      { key: "title", label: "Page title", type: "text" },
      { key: "content", label: "Page content", type: "textarea" },
    ],
  },

  webhookRespond: {
    ...actionBase,
    type: "webhookRespond",
    name: "Webhook Respond",
    description: "Send the HTTP response back to the caller of the webhook that triggered this workflow. Use a Webhook trigger to receive, then this node to answer.",
    icon: "reply",
    defaults: { status: 200, contentType: "json", body: "{\n  \"ok\": true\n}" },
    fields: [
      { key: "status", label: "HTTP status", type: "number", section: "Response" },
      {
        key: "contentType",
        label: "Respond with",
        type: "select",
        options: [
          { value: "json", label: "JSON (execution result — includes this message)" },
          { value: "body", label: "Raw response body only" },
        ],
        section: "Response",
      },
      { key: "body", label: "Response body (supports {{vars}})", type: "textarea", placeholder: '{\n  "ok": true\n}', help: "What is sent back to the caller. Supports {{var}} placeholders from the payload.", section: "Response" },
    ],
  },

  wait: {
    ...actionBase,
    type: "wait",
    name: "Wait / Delay",
    description: "Pause the workflow for a given amount of time.",
    icon: "hourglass",
    defaults: { duration: 5, unit: "seconds" },
    fields: [
      { key: "duration", label: "Duration", type: "number" },
      { key: "unit", label: "Unit", type: "select", options: ["seconds", "minutes", "hours"] },
    ],
  },

  teamsSend: {
    ...actionBase,
    type: "teamsSend",
    name: "Microsoft Teams — Send Message",
    description: "Post a message to a Teams channel via an incoming webhook.",
    icon: "users",
    defaults: { webhookUrl: "", text: "Hello from W flow!" },
    fields: [
      { key: "webhookUrl", label: "Incoming webhook URL", type: "secret", help: "Create it in Teams → channel → Connectors → Incoming Webhook.", section: "Credentials" },
      { key: "text", label: "Message text", type: "textarea", section: "Message" },
    ],
  },

  outlookSend: {
    ...actionBase,
    type: "outlookSend",
    name: "Outlook 365 — Send Email",
    description: "Send an email through Microsoft 365 using the Graph API.",
    icon: "mailSend",
    defaults: { token: "", to: "", subject: "Workflow notification", body: "Hello from W flow!" },
    fields: [
      { key: "token", label: "Graph API token", type: "secret", section: "Credentials" },
      { key: "to", label: "To (comma separated)", type: "text", section: "Message" },
      { key: "subject", label: "Subject", type: "text", section: "Message" },
      { key: "body", label: "Body", type: "textarea", section: "Message" },
    ],
  },

  m365Calendar: {
    ...actionBase,
    type: "m365Calendar",
    name: "Outlook 365 — Create Event",
    description: "Add a calendar event via the Microsoft Graph API.",
    icon: "calendar",
    defaults: { token: "", subject: "Meeting", start: "", end: "", timeZone: "UTC", attendees: "" },
    fields: [
      { key: "token", label: "Graph API token", type: "secret", section: "Credentials" },
      { key: "subject", label: "Subject", type: "text", section: "Event" },
      { key: "start", label: "Start (ISO datetime or date)", type: "text", placeholder: "2026-01-01T10:00:00", help: "Leave empty for now. A plain date like 2026-01-01 makes an all-day event. Without an offset the time is read in the Time zone below.", section: "Event" },
      { key: "end", label: "End (ISO datetime or date)", type: "text", placeholder: "2026-01-01T11:00:00", help: "Leave empty for one hour after the start (the next day for an all-day event).", section: "Event" },
      { key: "timeZone", label: "Time zone", type: "text", placeholder: "UTC", section: "Event" },
      { key: "attendees", label: "Attendees (comma separated emails)", type: "text", section: "Event" },
    ],
  },

  onedriveUpload: {
    ...actionBase,
    type: "onedriveUpload",
    name: "OneDrive — Upload File",
    description: "Upload a text file to OneDrive via the Graph API.",
    icon: "cloudUpload",
    defaults: { token: "", path: "Documents/report.txt", content: "{{body}}" },
    fields: [
      { key: "token", label: "Graph API token", type: "secret", section: "Credentials" },
      { key: "path", label: "File path", type: "text", placeholder: "Documents/report.txt", section: "File" },
      { key: "content", label: "File content", type: "textarea", section: "File" },
    ],
  },

  excelCreate: {
    ...actionBase,
    type: "excelCreate",
    name: "Excel — Create Spreadsheet",
    description: "Build a real .xlsx from rows, JSON or a pasted CSV table — and optionally upload it to OneDrive.",
    icon: "sheet",
    defaults: {
      token: "",
      uploadTo: "",
      fileName: "workbook.xlsx",
      sheetName: "Sheet1",
      inputParse: "none",
      mode: "custom",
      rows: '[\n  ["Name", "Score"],\n  ["Ada", 9],\n  ["Lin", 7]\n]',
      outputFile: "",
    },
    fields: [
      { key: "token", label: "Graph API token (optional)", type: "secret", section: "OneDrive upload (optional)" },
      { key: "uploadTo", label: "Upload to path", type: "text", placeholder: "Documents/report.xlsx", section: "OneDrive upload (optional)" },
      {
        key: "inputParse",
        label: "Rework incoming data",
        type: "select",
        help: "If the incoming data is not already a table, parse it first. JSON becomes rows; CSV text becomes a table.",
        options: [
          { value: "none", label: "No — use the rows config below" },
          { value: "json", label: "Parse input as JSON → rows" },
          { value: "csv", label: "Parse input as CSV table → rows" },
        ],
        section: "Input",
      },
      { key: "fileName", label: "File name", type: "text", section: "Content" },
      { key: "sheetName", label: "Sheet name", type: "text", section: "Content" },
      {
        key: "mode",
        label: "Rows from",
        type: "select",
        options: [
          { value: "custom", label: "Custom rows (JSON)" },
          { value: "items", label: "One row per incoming item" },
        ],
        section: "Content",
        visibleWhen: { key: "inputParse", value: "none" },
      },
      {
        key: "rows",
        label: "Rows (JSON array of arrays)",
        type: "json",
        section: "Content",
        visibleWhen: { key: "mode", value: "custom" },
      },
      ...outputFileFields,
    ],
  },

  wordCreate: {
    ...actionBase,
    type: "wordCreate",
    name: "Word — Create Document",
    description: "Generate a real .docx with a title and paragraphs or a bulleted / numbered list.",
    icon: "file",
    defaults: { token: "", uploadTo: "", fileName: "document.docx", title: "Report", style: "paragraphs", paragraphs: "First paragraph.\n\nSecond paragraph with {{body}}.", items: "First bullet\nSecond bullet", outputFile: "" },
    fields: [
      { key: "token", label: "Graph API token (optional)", type: "secret", section: "OneDrive upload (optional)" },
      { key: "uploadTo", label: "Upload to path", type: "text", placeholder: "Documents/report.docx", section: "OneDrive upload (optional)" },
      { key: "fileName", label: "File name", type: "text", section: "Content" },
      { key: "title", label: "Document title", type: "text", section: "Content" },
      {
        key: "style",
        label: "Content style",
        type: "select",
        options: [
          { value: "paragraphs", label: "Paragraphs" },
          { value: "bullets", label: "Bullet list" },
          { value: "numbered", label: "Numbered list" },
        ],
        section: "Content",
      },
      { key: "paragraphs", label: "Paragraphs (blank line separates)", type: "textarea", section: "Content", visibleWhen: { key: "style", value: "paragraphs" } },
      { key: "items", label: "List items (one per line)", type: "textarea", section: "Content", visibleWhen: { key: "style", value: "bullets", not: true } },
      ...outputFileFields,
    ],
  },

  sharepointUpload: {
    ...actionBase,
    type: "sharepointUpload",
    name: "SharePoint — Upload File",
    description: "Upload a text file to a SharePoint document library via the Graph API.",
    icon: "cloudUpload",
    defaults: { token: "", siteId: "", path: "Shared Documents/report.txt", content: "{{body}}" },
    fields: [
      { key: "token", label: "Graph API token", type: "secret", section: "Credentials" },
      { key: "siteId", label: "Site ID", type: "text", placeholder: "tenant.sharepoint.com,guid,guid", section: "Credentials" },
      { key: "path", label: "File path in library", type: "text", placeholder: "Shared Documents/report.txt", section: "File" },
      { key: "content", label: "File content", type: "textarea", section: "File" },
    ],
  },

  sharepointListItem: {
    ...actionBase,
    type: "sharepointListItem",
    name: "SharePoint — Create List Item",
    description: "Add an item to a SharePoint list via the Graph API.",
    icon: "list",
    defaults: { token: "", siteId: "", listId: "", fields: '{\n  "Title": "New item from W flow"\n}' },
    fields: [
      { key: "token", label: "Graph API token", type: "secret", section: "Credentials" },
      { key: "siteId", label: "Site ID", type: "text", placeholder: "tenant.sharepoint.com,guid,guid", section: "Credentials" },
      { key: "listId", label: "List ID", type: "text", section: "Credentials" },
      { key: "fields", label: "Fields (JSON, supports {{vars}})", type: "json", section: "Item" },
    ],
  },

  plannerTask: {
    ...actionBase,
    type: "plannerTask",
    name: "Planner — Create Task",
    description: "Create a Microsoft Planner task via the Graph API.",
    icon: "checkSquare",
    defaults: { token: "", planId: "", title: "New task", bucketId: "", dueDateTime: "" },
    fields: [
      { key: "token", label: "Graph API token", type: "secret", section: "Credentials" },
      { key: "planId", label: "Plan ID", type: "text", section: "Task" },
      { key: "title", label: "Title", type: "text", section: "Task" },
      { key: "bucketId", label: "Bucket ID (optional)", type: "text", section: "Task" },
      { key: "dueDateTime", label: "Due (ISO datetime, optional)", type: "text", placeholder: "2026-01-31T17:00:00Z", section: "Task" },
    ],
  },

  excelAddRow: {
    ...actionBase,
    type: "excelAddRow",
    name: "Excel Online — Add Row",
    description: "Append a row to a table in an existing Excel workbook (Graph API).",
    icon: "sheet",
    defaults: { token: "", path: "Documents/book.xlsx", tableName: "Table1", values: '[\n  ["Ada", 9]\n]' },
    fields: [
      { key: "token", label: "Graph API token", type: "secret", section: "Credentials" },
      { key: "path", label: "Workbook path", type: "text", placeholder: "Documents/book.xlsx", section: "Table" },
      { key: "tableName", label: "Table name or ID", type: "text", section: "Table" },
      { key: "values", label: "Row values (JSON array, supports {{vars}})", type: "json", section: "Table" },
    ],
  },

  twilioSms: {
    ...actionBase,
    type: "twilioSms",
    name: "Twilio — Send SMS",
    description: "Send a text message through Twilio.",
    icon: "messageSquare",
    defaults: { accountSid: "", authToken: "", from: "", to: "", body: "Hello from W flow!" },
    fields: [
      { key: "accountSid", label: "Account SID", type: "secret", section: "Credentials" },
      { key: "authToken", label: "Auth token", type: "secret", section: "Credentials" },
      { key: "from", label: "From number", type: "text", placeholder: "+1234567890", section: "Credentials" },
      { key: "to", label: "To number", type: "text", placeholder: "+1234567890", section: "Message" },
      { key: "body", label: "Message text", type: "textarea", section: "Message" },
    ],
  },

  sendgridEmail: {
    ...actionBase,
    type: "sendgridEmail",
    name: "SendGrid — Send Email",
    description: "Send an email through the SendGrid v3 API.",
    icon: "mailSend",
    defaults: { apiKey: "", fromEmail: "", fromName: "", to: "", subject: "Workflow notification", content: "Hello from W flow!" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "fromEmail", label: "From email", type: "text", section: "Message" },
      { key: "fromName", label: "From name", type: "text", section: "Message" },
      { key: "to", label: "To (comma separated)", type: "text", section: "Message" },
      { key: "subject", label: "Subject", type: "text", section: "Message" },
      { key: "content", label: "Content", type: "textarea", section: "Message" },
    ],
  },

  stripePaymentLink: {
    ...actionBase,
    type: "stripePaymentLink",
    name: "Stripe — Create Payment Link",
    description: "Create a reusable Stripe payment link for a fixed amount.",
    icon: "creditCard",
    defaults: { apiKey: "", amount: 1000, currency: "usd", description: "Payment from W flow", quantity: 1 },
    fields: [
      { key: "apiKey", label: "Secret API key (sk_…)", type: "secret", section: "Credentials" },
      { key: "amount", label: "Amount (smallest unit, e.g. cents)", type: "number", section: "Payment" },
      { key: "currency", label: "Currency", type: "text", placeholder: "usd", section: "Payment" },
      { key: "description", label: "Description", type: "text", section: "Payment" },
      { key: "quantity", label: "Quantity", type: "number", section: "Payment" },
    ],
  },

  hubspotContact: {
    ...actionBase,
    type: "hubspotContact",
    name: "HubSpot — Create Contact",
    description: "Create or update a contact in HubSpot CRM.",
    icon: "users",
    defaults: { apiKey: "", properties: '{\n  "email": "test@example.com",\n  "firstname": "Ada"\n}' },
    fields: [
      { key: "apiKey", label: "Private app token", type: "secret", section: "Credentials" },
      { key: "properties", label: "Properties (JSON, supports {{vars}})", type: "json", section: "Contact" },
    ],
  },

  airtableRow: {
    ...actionBase,
    type: "airtableRow",
    name: "Airtable — Create Record",
    description: "Add a record to an Airtable base.",
    icon: "table",
    defaults: { apiKey: "", baseId: "", tableName: "Table 1", fields: '{\n  "Name": "Ada"\n}' },
    fields: [
      { key: "apiKey", label: "Personal access token", type: "secret", section: "Credentials" },
      { key: "baseId", label: "Base ID", type: "text", section: "Credentials" },
      { key: "tableName", label: "Table name", type: "text", section: "Credentials" },
      { key: "fields", label: "Fields (JSON, supports {{vars}})", type: "json", section: "Record" },
    ],
  },

  gitlabIssue: {
    ...actionBase,
    type: "gitlabIssue",
    name: "GitLab — Create Issue",
    description: "Open an issue in a GitLab project.",
    icon: "gitlab",
    defaults: { token: "", projectId: "", title: "Issue from W flow", description: "{{body}}" },
    fields: [
      { key: "token", label: "Personal access token", type: "secret", section: "Credentials" },
      { key: "projectId", label: "Project ID or URL-encoded path", type: "text", section: "Credentials" },
      { key: "title", label: "Title", type: "text", section: "Issue" },
      { key: "description", label: "Description", type: "textarea", section: "Issue" },
    ],
  },

  trelloCard: {
    ...actionBase,
    type: "trelloCard",
    name: "Trello — Create Card",
    description: "Create a card in a Trello list.",
    icon: "trello",
    defaults: { apiKey: "", token: "", listId: "", name: "Card from W flow", description: "{{body}}" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "token", label: "API token", type: "secret", section: "Credentials" },
      { key: "listId", label: "List ID", type: "text", section: "Credentials" },
      { key: "name", label: "Card name", type: "text", section: "Card" },
      { key: "description", label: "Description", type: "textarea", section: "Card" },
    ],
  },

  asanaTask: {
    ...actionBase,
    type: "asanaTask",
    name: "Asana — Create Task",
    description: "Create a task in an Asana project.",
    icon: "checkSquare",
    defaults: { token: "", projectId: "", name: "Task from W flow", notes: "{{body}}" },
    fields: [
      { key: "token", label: "Personal access token", type: "secret", section: "Credentials" },
      { key: "projectId", label: "Project ID (GID)", type: "text", section: "Credentials" },
      { key: "name", label: "Task name", type: "text", section: "Task" },
      { key: "notes", label: "Notes", type: "textarea", section: "Task" },
    ],
  },

  supabaseInsert: {
    ...actionBase,
    type: "supabaseInsert",
    name: "Supabase — Insert Row",
    description: "Insert a row into a Supabase Postgres table via the REST API.",
    icon: "database",
    defaults: { url: "https://xyzcompany.supabase.co", anonKey: "", tableName: "items", row: '{\n  "name": "Ada"\n}' },
    fields: [
      { key: "url", label: "Project URL", type: "text", placeholder: "https://xyz.supabase.co", section: "Credentials" },
      { key: "anonKey", label: "Anon / service key", type: "secret", section: "Credentials" },
      { key: "tableName", label: "Table name", type: "text", section: "Credentials" },
      { key: "row", label: "Row (JSON, supports {{vars}})", type: "json", section: "Row" },
    ],
  },

  jiraIssue: {
    ...actionBase,
    type: "jiraIssue",
    name: "Jira — Create Issue",
    description: "Create an issue in a Jira project (REST API v2).",
    icon: "ticket",
    defaults: { baseUrl: "https://your.atlassian.net", email: "", apiToken: "", projectKey: "PROJ", issueType: "Task", summary: "Issue from W flow", description: "{{body}}" },
    fields: [
      { key: "baseUrl", label: "Jira base URL", type: "text", placeholder: "https://your.atlassian.net", section: "Credentials" },
      { key: "email", label: "Email", type: "text", section: "Credentials" },
      { key: "apiToken", label: "API token", type: "secret", section: "Credentials" },
      { key: "projectKey", label: "Project key", type: "text", placeholder: "PROJ", section: "Issue" },
      { key: "issueType", label: "Issue type", type: "text", placeholder: "Task", section: "Issue" },
      { key: "summary", label: "Summary", type: "text", section: "Issue" },
      { key: "description", label: "Description", type: "textarea", section: "Issue" },
    ],
  },

  hash: {
    ...actionBase,
    type: "hash",
    name: "Hash / Fingerprint",
    description: "Compute an MD5, SHA-1 or SHA-256 fingerprint of a text value.",
    icon: "hash",
    defaults: { value: "{{json}}", algorithm: "sha256", storeIn: "hash" },
    fields: [
      { key: "value", label: "Value to hash (supports {{vars}})", type: "textarea", section: "Input" },
      {
        key: "algorithm",
        label: "Algorithm",
        type: "select",
        options: [{ value: "md5", label: "MD5" }, { value: "sha1", label: "SHA-1" }, { value: "sha256", label: "SHA-256" }],
        section: "Input",
      },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "hash", section: "Output" },
    ],
  },

  // --- additional services ---------------------------------------------------
  weather: {
    ...actionBase,
    type: "weather",
    name: "Weather — Current Conditions",
    description: "Get the current weather for a city from OpenWeatherMap (free tier).",
    icon: "weather",
    defaults: { apiKey: "", city: "Berlin", units: "metric" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", placeholder: "…", help: "Free key from openweathermap.org/api (Current Weather Data).", section: "Credentials" },
      { key: "city", label: "City (supports {{vars}})", type: "text", placeholder: "Berlin", section: "Location" },
      {
        key: "units",
        label: "Units",
        type: "select",
        options: [{ value: "metric", label: "Celsius" }, { value: "imperial", label: "Fahrenheit" }, { value: "standard", label: "Kelvin" }],
        section: "Location",
      },
    ],
  },

  cryptoPrice: {
    ...actionBase,
    type: "cryptoPrice",
    name: "Crypto — Live Price",
    description: "Get the current price of any coin from CoinGecko — no API key needed.",
    icon: "coins",
    defaults: { coinId: "bitcoin", vsCurrency: "usd", include24h: true, storeIn: "price" },
    fields: [
      { key: "coinId", label: "Coin ID (supports {{vars}})", type: "text", placeholder: "bitcoin", help: "e.g. bitcoin, ethereum, dogecoin — see coingecko.com/en/coins", section: "Coin" },
      { key: "vsCurrency", label: "Compare with", type: "text", placeholder: "usd", section: "Coin" },
      { key: "include24h", label: "Include 24h change", type: "boolean", section: "Coin" },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "price", section: "Output" },
    ],
  },

  coinbaseExchange: exchangeNode({
    type: "coinbaseExchange",
    name: "Coinbase",
    description: "Get prices, balances and orders on Coinbase Advanced Trade, and place or cancel orders.",
    symbol: "BTC-USD",
    symbolHelp: "Coinbase product ID: base and quote coin joined by a dash, e.g. BTC-USD, ETH-EUR, SOL-USDC.",
    keyHelp: "The API key name from portal.cdp.coinbase.com → API keys, e.g. organizations/…/apiKeys/…. Give it View permission, plus Trade for orders.",
    secretHelp: "The private key shown once when the key is created: the whole -----BEGIN EC PRIVATE KEY----- block, or the base64 Ed25519 key.",
    quote: true,
  }),

  binanceExchange: exchangeNode({
    type: "binanceExchange",
    name: "Binance",
    description: "Get prices, balances and orders on Binance spot, and place or cancel orders.",
    symbol: "BTCUSDT",
    symbolHelp: "Binance symbol: base and quote coin without a separator, e.g. BTCUSDT, ETHEUR. Needed to check or cancel an order too.",
    keyHelp: "From binance.com → Profile → API Management. Enable Reading, plus Spot Trading for orders. Never enable withdrawals.",
    secretHelp: "The secret key shown once when the API key is created.",
    quote: true,
    baseUrl: { url: "https://api.binance.com", help: "https://api.binance.us for Binance.US, https://testnet.binance.vision for the spot test network." },
  }),

  bybitExchange: exchangeNode({
    type: "bybitExchange",
    name: "Bybit",
    description: "Get prices, balances and orders on Bybit spot, and place or cancel orders.",
    symbol: "BTCUSDT",
    symbolHelp: "Bybit spot symbol without a separator, e.g. BTCUSDT, ETHUSDC. Needed to check or cancel an order too.",
    keyHelp: "From bybit.com → Account → API → Create New Key (system-generated, HMAC). Read-Only for balances; Spot Trade for orders. Never enable withdrawals.",
    secretHelp: "The API secret shown once when the key is created.",
    testHelp: "On: Bybit has no dry-run for orders, so the node checks your key with a balance read and shows the order it would send, without sending it. Turn off to trade with real money.",
    quote: true,
    baseUrl: { url: "https://api.bybit.com", help: "https://api-testnet.bybit.com for the Bybit test network (needs a testnet key)." },
  }),

  okxExchange: exchangeNode({
    type: "okxExchange",
    name: "OKX",
    description: "Get prices, balances and orders on OKX spot, and place or cancel orders.",
    symbol: "BTC-USDT",
    symbolHelp: "OKX instrument ID with a dash, e.g. BTC-USDT, ETH-EUR. Needed to check or cancel an order too.",
    keyHelp: "From okx.com → Profile → API keys → Create. Read permission for balances; Trade for orders. Never enable withdrawals.",
    secretHelp: "The secret key shown once when the API key is created.",
    testHelp: "On: OKX has no dry-run for orders, so the node checks your key with a balance read and shows the order it would send, without sending it. Turn off to trade with real money.",
    quote: true,
    passphrase: true,
  }),

  kucoinExchange: exchangeNode({
    type: "kucoinExchange",
    name: "KuCoin",
    description: "Get prices, balances and orders on KuCoin spot, and place or cancel orders.",
    symbol: "BTC-USDT",
    symbolHelp: "KuCoin symbol with a dash, e.g. BTC-USDT, ETH-USDC. KuCoin needs it for every order operation, including listing open orders.",
    keyHelp: "From kucoin.com → Account → API Management → Create API. General permission for balances; Spot Trading for orders. Never enable withdrawals.",
    secretHelp: "The API secret shown once when the key is created.",
    quote: true,
    passphrase: true,
  }),

  krakenExchange: exchangeNode({
    type: "krakenExchange",
    name: "Kraken",
    description: "Get prices, balances and orders on Kraken spot, and place or cancel orders.",
    symbol: "XBTUSD",
    symbolHelp: "Kraken pair, e.g. XBTUSD (Kraken calls Bitcoin XBT), ETHEUR, SOLUSD.",
    keyHelp: "From kraken.com → Settings → API. Allow Query Funds and Query Open Orders & Trades, plus Create & Modify Orders and Cancel Orders for trading.",
    secretHelp: "The private key (base64) shown once when the API key is created.",
  }),

  evmWallet: {
    ...actionBase,
    type: "evmWallet",
    name: "Crypto Wallet — EVM",
    description: "Read balances or send coins and tokens from your own wallet on Ethereum, Base, Arbitrum, Optimism, Polygon or BNB Chain.",
    icon: "wallet",
    defaults: { operation: "balance", network: "ethereum", address: "", tokenAddress: "", to: "", amount: "", txHash: "", testMode: true, maxAmount: 0, maxDaily: 0, privateKey: "", rpcUrl: "", coinSymbol: "", storeIn: "result" },
    fields: [
      {
        key: "operation",
        label: "Operation",
        type: "select",
        options: [
          { value: "balance", label: "Get coin balance (ETH, POL, BNB…)" },
          { value: "tokenBalance", label: "Get token balance (USDC, USDT…)" },
          { value: "send", label: "Send coins" },
          { value: "sendToken", label: "Send tokens" },
          { value: "txStatus", label: "Check a transaction" },
        ],
        section: "Operation",
      },
      {
        key: "network",
        label: "Network",
        type: "select",
        options: [
          { value: "ethereum", label: "Ethereum" },
          { value: "base", label: "Base" },
          { value: "arbitrum", label: "Arbitrum One" },
          { value: "optimism", label: "Optimism" },
          { value: "polygon", label: "Polygon" },
          { value: "bsc", label: "BNB Smart Chain" },
          { value: "custom", label: "Other (own RPC URL)" },
        ],
        section: "Operation",
      },
      { key: "address", label: "Wallet address (supports {{vars}})", type: "text", placeholder: "0x…", help: "Any address can be read. Leave empty to read the wallet of the private key below.", section: "Operation", visibleWhen: { key: "operation", in: ["balance", "tokenBalance"] } },
      { key: "tokenAddress", label: "Token contract (supports {{vars}})", type: "text", placeholder: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", help: "The ERC-20 contract on the chosen network, e.g. USDC on Ethereum is 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48. Look it up on the network's block explorer.", section: "Operation", visibleWhen: { key: "operation", in: ["tokenBalance", "sendToken"] } },
      { key: "to", label: "Send to address (supports {{vars}})", type: "text", placeholder: "0x…", help: "Double-check it: blockchain transfers cannot be reversed.", section: "Transfer", visibleWhen: { key: "operation", in: ["send", "sendToken"] } },
      { key: "amount", label: "Amount (supports {{vars}})", type: "text", placeholder: "0.01", help: "In whole coins or tokens, e.g. 0.01 ETH or 25 USDC. The network fee is paid in the network's coin on top.", section: "Transfer", visibleWhen: { key: "operation", in: ["send", "sendToken"] } },
      { key: "testMode", label: "Test mode: check the transfer without sending it", type: "boolean", help: "On: the node builds the transaction, estimates the fee and checks the balance, but sends nothing. Turn off to send for real.", section: "Transfer", visibleWhen: { key: "operation", in: ["send", "sendToken"] } },
      ...spendLimitFields({ key: "operation", in: ["send", "sendToken"] }, "in whole coins or tokens, like Amount"),
      { key: "txHash", label: "Transaction hash (supports {{vars}})", type: "text", placeholder: "{{result.hash}}", section: "Operation", visibleWhen: { key: "operation", value: "txStatus" } },
      {
        key: "privateKey",
        label: "Wallet private key",
        type: "secret",
        help: "Only needed to send. Stored encrypted and never shared with templates, but anyone who can run this workflow can move these funds: use a separate wallet that holds only what the workflow needs.",
        section: "Credentials",
      },
      { key: "rpcUrl", label: "RPC URL (optional)", type: "text", placeholder: "https://…", help: "Leave empty to use a free public node. Set your own (Alchemy, Infura, QuickNode…) for reliability, or for “Other” networks.", section: "Credentials" },
      { key: "coinSymbol", label: "Coin symbol", type: "text", placeholder: "ETH", help: "The network's coin, shown in results. Only used for “Other” networks.", section: "Credentials", visibleWhen: { key: "network", value: "custom" } },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "result", section: "Output" },
    ],
  },

  solanaWallet: {
    ...actionBase,
    type: "solanaWallet",
    name: "Crypto Wallet — Solana",
    description: "Read the SOL and token balances of any Solana wallet, or check a transaction. Read-only, no key needed.",
    icon: "wallet",
    defaults: { operation: "balance", address: "", txHash: "", rpcUrl: "", storeIn: "result" },
    fields: [
      {
        key: "operation",
        label: "Operation",
        type: "select",
        options: [
          { value: "balance", label: "Get SOL balance" },
          { value: "tokenBalances", label: "Get token balances (SPL)" },
          { value: "txStatus", label: "Check a transaction" },
        ],
        section: "Operation",
      },
      { key: "address", label: "Wallet address (supports {{vars}})", type: "text", placeholder: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", section: "Operation", visibleWhen: { key: "operation", value: "txStatus", not: true } },
      { key: "txHash", label: "Transaction signature (supports {{vars}})", type: "text", placeholder: "5VERv8NMvzbJ…", section: "Operation", visibleWhen: { key: "operation", value: "txStatus" } },
      { key: "rpcUrl", label: "RPC URL (optional)", type: "text", placeholder: "https://…", help: "Leave empty to use a free public node. Set your own (Helius, QuickNode…) for reliability.", section: "Connection" },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "result", section: "Output" },
    ],
  },

  polymarket: {
    ...actionBase,
    type: "polymarket",
    name: "Polymarket",
    description: "Search prediction markets and read live odds, order books, price history and a wallet's positions. No key needed.",
    icon: "prediction",
    defaults: { operation: "search", query: "bitcoin", market: "", outcome: "Yes", wallet: "", interval: "1d", limit: 10, storeIn: "result" },
    fields: [
      {
        key: "operation",
        label: "Operation",
        type: "select",
        options: [
          { value: "search", label: "Search markets" },
          { value: "topMarkets", label: "Top markets by 24h volume" },
          { value: "getMarket", label: "Get a market" },
          { value: "price", label: "Get live price of an outcome" },
          { value: "orderBook", label: "Get order book of an outcome" },
          { value: "priceHistory", label: "Get price history of an outcome" },
          { value: "positions", label: "Get a wallet's positions" },
        ],
        section: "Operation",
      },
      { key: "query", label: "Search text (supports {{vars}})", type: "text", placeholder: "bitcoin", section: "Operation", visibleWhen: { key: "operation", value: "search" } },
      {
        key: "market",
        label: "Market (supports {{vars}})",
        type: "text",
        placeholder: "will-bitcoin-reach-100k-in-september-2026",
        help: "Paste the market's polymarket.com link, or its slug (the last part of the link) or ID. Search results carry both.",
        section: "Operation",
        visibleWhen: { key: "operation", in: ["getMarket", "price", "orderBook", "priceHistory"] },
      },
      { key: "outcome", label: "Outcome", type: "text", placeholder: "Yes", help: "Usually Yes or No; multi-outcome markets use their own names. A price of 0.35 means a 35 % chance.", section: "Operation", visibleWhen: { key: "operation", in: ["price", "orderBook", "priceHistory"] } },
      {
        key: "interval",
        label: "Period",
        type: "select",
        options: [
          { value: "1h", label: "Last hour" },
          { value: "6h", label: "Last 6 hours" },
          { value: "1d", label: "Last day" },
          { value: "1w", label: "Last week" },
          { value: "1m", label: "Last month" },
          { value: "max", label: "All time" },
        ],
        section: "Operation",
        visibleWhen: { key: "operation", value: "priceHistory" },
      },
      { key: "wallet", label: "Wallet address (supports {{vars}})", type: "text", placeholder: "0x…", help: "The Polymarket wallet (proxy) address shown on the user's profile.", section: "Operation", visibleWhen: { key: "operation", value: "positions" } },
      { key: "limit", label: "Max results", type: "number", section: "Operation", visibleWhen: { key: "operation", in: ["search", "topMarkets", "orderBook", "positions"] } },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "result", section: "Output" },
    ],
  },

  dashboard: {
    ...actionBase,
    type: "dashboard",
    name: "Dashboard — Add to Chart",
    description: "Save a number from each run to a chart on a shareable dashboard page, e.g. a portfolio value over time.",
    icon: "chart",
    defaults: { dashboard: "My dashboard", series: "Value", value: "{{result.price}}", label: "", chart: "line", mode: "append", keep: 200 },
    fields: [
      { key: "dashboard", label: "Dashboard name", type: "text", placeholder: "Portfolio", help: "Nodes that use the same name write to the same page; the first run creates it. The link is in the output as dashboardUrl.", section: "Dashboard" },
      { key: "series", label: "Chart name", type: "text", placeholder: "BTC price", help: "One chart per name on the dashboard.", section: "Dashboard" },
      {
        key: "chart",
        label: "Chart type",
        type: "select",
        options: [
          { value: "line", label: "Line (values over time)" },
          { value: "bar", label: "Bars (latest 30 values)" },
          { value: "number", label: "Big number (latest value)" },
        ],
        section: "Dashboard",
      },
      { key: "value", label: "Value (supports {{vars}})", type: "text", placeholder: "{{result.price}}", help: "Must come out as a number.", section: "Data" },
      { key: "label", label: "Label (optional, supports {{vars}})", type: "text", placeholder: "{{symbol}}", help: "Names the point in bar charts and tooltips. Empty = the time it was added.", section: "Data" },
      {
        key: "mode",
        label: "Each run",
        type: "select",
        options: [
          { value: "append", label: "adds its values to the chart" },
          { value: "replace", label: "replaces the chart with its values" },
        ],
        section: "Data",
      },
      { key: "keep", label: "Keep last N values", type: "number", help: "Older values drop off (max 1000).", section: "Data" },
      { key: "shareInfo", label: "Who can see it", type: "note", help: "Anyone with the dashboard link can view the charts (the link is long and random, like an unlisted document). Delete a dashboard to disable its link.", section: "Dashboard" },
    ],
  },

  ipGeo: {
    ...actionBase,
    type: "ipGeo",
    name: "IP Geolocation",
    description: "Look up the location of an IP address (or your own server's IP) — free, no key needed.",
    icon: "mapPin",
    defaults: { ip: "", storeIn: "geo" },
    fields: [
      { key: "ip", label: "IP address (empty = your server)", type: "text", placeholder: "8.8.8.8", help: "Leave empty to geolocate the server itself.", section: "Lookup" },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "geo", section: "Output" },
    ],
  },

  wordpressPost: {
    ...actionBase,
    type: "wordpressPost",
    name: "WordPress — Create Post",
    description: "Publish a post on a self-hosted WordPress site via the REST API.",
    icon: "rocket",
    defaults: { baseUrl: "https://example.com", user: "", appPassword: "", title: "New post", content: "{{body}}", status: "publish" },
    fields: [
      { key: "baseUrl", label: "Site URL", type: "text", placeholder: "https://example.com", section: "Credentials" },
      { key: "user", label: "Username", type: "text", section: "Credentials" },
      { key: "appPassword", label: "Application password", type: "secret", help: "WP admin → Users → Application Passwords.", section: "Credentials" },
      { key: "title", label: "Title (supports {{vars}})", type: "text", section: "Post" },
      { key: "content", label: "Content (supports {{vars}})", type: "textarea", section: "Post" },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [{ value: "publish", label: "Published" }, { value: "draft", label: "Draft" }, { value: "pending", label: "Pending review" }],
        section: "Post",
      },
    ],
  },

  googleCalendar: {
    ...actionBase,
    type: "googleCalendar",
    name: "Google Calendar — Create Event",
    description: "Add an event to a Google Calendar (OAuth access token).",
    icon: "calendar",
    defaults: { token: "", calendarId: "primary", summary: "Meeting", description: "", start: "", end: "", timeZone: "UTC" },
    fields: [
      { key: "token", label: "OAuth access token", type: "secret", section: "Credentials" },
      { key: "calendarId", label: "Calendar ID", type: "text", placeholder: "primary", section: "Credentials" },
      { key: "summary", label: "Event title (supports {{vars}})", type: "text", section: "Event" },
      { key: "description", label: "Description (supports {{vars}})", type: "textarea", section: "Event" },
      { key: "start", label: "Start (ISO datetime or date)", type: "text", placeholder: "2026-01-01T10:00:00", help: "Leave empty for now. A plain date like 2026-01-01 makes an all-day event. Without an offset the time is read in the Time zone below.", section: "Event" },
      { key: "end", label: "End (ISO datetime or date)", type: "text", placeholder: "2026-01-01T11:00:00", help: "Leave empty for one hour after the start (the next day for an all-day event).", section: "Event" },
      { key: "timeZone", label: "Time zone", type: "text", placeholder: "UTC", section: "Event" },
    ],
  },

  dropboxUpload: {
    ...actionBase,
    type: "dropboxUpload",
    name: "Dropbox — Upload File",
    description: "Upload a text file to Dropbox via the content API.",
    icon: "cloudUpload",
    defaults: { token: "", path: "/reports/report.txt", content: "{{body}}", mode: "overwrite" },
    fields: [
      { key: "token", label: "Access token", type: "secret", help: "Create one at dropbox.com → Developer → App console.", section: "Credentials" },
      { key: "path", label: "Dropbox path (supports {{vars}})", type: "text", placeholder: "/reports/report.txt", section: "File" },
      { key: "content", label: "File content (supports {{vars}})", type: "textarea", section: "File" },
      {
        key: "mode",
        label: "Write mode",
        type: "select",
        options: [{ value: "add", label: "Add (fail if exists)" }, { value: "overwrite", label: "Overwrite" }],
        section: "File",
      },
    ],
  },

  mailchimpSub: {
    ...actionBase,
    type: "mailchimpSub",
    name: "Mailchimp — Add Subscriber",
    description: "Add or update a subscriber in a Mailchimp audience (list).",
    icon: "mail",
    defaults: { apiKey: "", listId: "", email: "{{email}}", firstName: "", lastName: "", status: "subscribed" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", placeholder: "…-us1", help: "Mailchimp → Account → Extras → API keys. The suffix after '-' is your server.", section: "Credentials" },
      { key: "listId", label: "Audience / list ID", type: "text", section: "Credentials" },
      { key: "email", label: "Email (supports {{vars}})", type: "text", section: "Subscriber" },
      { key: "firstName", label: "First name", type: "text", section: "Subscriber" },
      { key: "lastName", label: "Last name", type: "text", section: "Subscriber" },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [{ value: "subscribed", label: "Subscribed" }, { value: "pending", label: "Pending (double opt-in)" }, { value: "unsubscribed", label: "Unsubscribed" }],
        section: "Subscriber",
      },
    ],
  },

  resendEmail: {
    ...actionBase,
    type: "resendEmail",
    name: "Resend — Send Email",
    description: "Send an email through Resend's API (free tier).",
    icon: "send",
    defaults: { apiKey: "", from: "Acme <onboarding@resend.dev>", to: "{{email}}", subject: "Workflow notification", html: "<p>Hello from W flow!</p>", text: "" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "from", label: "From", type: "text", placeholder: "Acme <onboarding@resend.dev>", section: "Message" },
      { key: "to", label: "To (comma separated)", type: "text", section: "Message" },
      { key: "subject", label: "Subject (supports {{vars}})", type: "text", section: "Message" },
      { key: "html", label: "HTML body (supports {{vars}})", type: "textarea", section: "Message" },
      { key: "text", label: "Plain text body (optional)", type: "textarea", section: "Message" },
    ],
  },

  zendeskTicket: {
    ...actionBase,
    type: "zendeskTicket",
    name: "Zendesk — Create Ticket",
    description: "Open a support ticket in Zendesk (subdomain + API token).",
    icon: "headset",
    defaults: { subdomain: "your-subdomain", email: "", token: "", subject: "Ticket from W flow", comment: "{{body}}", priority: "normal", type: "question" },
    fields: [
      { key: "subdomain", label: "Subdomain", type: "text", placeholder: "your-subdomain", section: "Credentials" },
      { key: "email", label: "Email (agent)", type: "text", section: "Credentials" },
      { key: "token", label: "API token", type: "secret", section: "Credentials" },
      { key: "subject", label: "Subject (supports {{vars}})", type: "text", section: "Ticket" },
      { key: "comment", label: "Comment (supports {{vars}})", type: "textarea", section: "Ticket" },
      {
        key: "priority",
        label: "Priority",
        type: "select",
        options: [{ value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }, { value: "urgent", label: "Urgent" }],
        section: "Ticket",
      },
      {
        key: "type",
        label: "Type",
        type: "select",
        options: [{ value: "question", label: "Question" }, { value: "incident", label: "Incident" }, { value: "problem", label: "Problem" }, { value: "task", label: "Task" }],
        section: "Ticket",
      },
    ],
  },

  pagerdutyIncident: {
    ...actionBase,
    type: "pagerdutyIncident",
    name: "PagerDuty — Trigger Incident",
    description: "Trigger an incident via the PagerDuty Events API v2.",
    icon: "siren",
    defaults: { routingKey: "", summary: "Workflow alert", severity: "critical", source: "wflow", dedupKey: "" },
    fields: [
      { key: "routingKey", label: "Integration / routing key", type: "secret", section: "Credentials" },
      { key: "summary", label: "Summary (supports {{vars}})", type: "text", section: "Incident" },
      {
        key: "severity",
        label: "Severity",
        type: "select",
        options: [{ value: "critical", label: "Critical" }, { value: "error", label: "Error" }, { value: "warning", label: "Warning" }, { value: "info", label: "Info" }],
        section: "Incident",
      },
      { key: "source", label: "Source", type: "text", section: "Incident" },
      { key: "dedupKey", label: "Dedup key (optional)", type: "text", section: "Incident" },
    ],
  },

  redditSearch: {
    ...actionBase,
    type: "redditSearch",
    name: "Reddit — Search Posts",
    description: "Search Reddit posts (public JSON API, no key needed).",
    icon: "messageCircle",
    defaults: { query: "workflow automation", subreddit: "", limit: 10, sort: "relevance", storeIn: "posts" },
    fields: [
      { key: "query", label: "Search query (supports {{vars}})", type: "text", section: "Search" },
      { key: "subreddit", label: "Subreddit (optional, restrict search)", type: "text", placeholder: "automation", section: "Search" },
      {
        key: "sort",
        label: "Sort",
        type: "select",
        options: [{ value: "relevance", label: "Relevance" }, { value: "new", label: "New" }, { value: "top", label: "Top" }, { value: "comments", label: "Comments" }],
        section: "Search",
      },
      { key: "limit", label: "Max results", type: "number", section: "Search" },
      { key: "storeIn", label: "Save results under field", type: "text", placeholder: "posts", section: "Output" },
    ],
  },

  // --- Google Drive -----------------------------------------------------------
  googleDriveUpload: {
    ...actionBase,
    type: "googleDriveUpload",
    name: "Google Drive — Upload",
    description: "Upload a file to Google Drive.",
    icon: "cloudUpload",
    defaults: { token: "", folderId: "", content: "{{body}}", fileName: "report.txt", contentType: "text/plain" },
    fields: [
      { key: "token", label: "OAuth2 access token", type: "secret", section: "Credentials" },
      { key: "folderId", label: "Folder ID (empty = root)", type: "text", section: "Destination" },
      { key: "content", label: "File content (text, supports {{vars}})", type: "textarea", section: "File" },
      { key: "fileName", label: "File name", type: "text", section: "File" },
      { key: "contentType", label: "Content type", type: "text", placeholder: "text/plain", section: "File" },
    ],
  },

  googleDriveList: {
    ...actionBase,
    type: "googleDriveList",
    name: "Google Drive — List Files",
    description: "List files in a Google Drive folder.",
    icon: "list",
    defaults: { token: "", folderId: "", maxResults: 100 },
    fields: [
      { key: "token", label: "OAuth2 access token", type: "secret", section: "Credentials" },
      { key: "folderId", label: "Folder ID (empty = root)", type: "text", section: "Search" },
      { key: "maxResults", label: "Max results", type: "number", section: "Search" },
    ],
  },

  // GraphQL — unlike a REST call the whole request is one POST whose body holds
  // the query plus its variables; the answer arrives under `data`. This is the
  // Pipedream/n8n-style way to talk to Shopify Admin, GitHub v4, Hasura, …
  graphqlRequest: {
    ...actionBase,
    type: "graphqlRequest",
    name: "GraphQL Request",
    description: "Run a GraphQL query or mutation against an endpoint and read the data object it returns.",
    icon: "globe",
    defaults: {
      endpoint: "https://api.example.com/graphql",
      token: "",
      headers: '{\n  "Content-Type": "application/json"\n}',
      query: "query ($id: ID!) {\n  item(id: $id) {\n    id\n    name\n  }\n}",
      variables: '{\n  "id": "{{id}}"\n}',
      storeIn: "data",
    },
    fields: [
      { key: "endpoint", label: "GraphQL endpoint", type: "text", placeholder: "https://api.example.com/graphql", section: "Request" },
      { key: "token", label: "Bearer token (optional)", type: "secret", section: "Request", optional: true },
      { key: "headers", label: "Extra headers (JSON)", type: "json", section: "Request", optional: true },
      { key: "query", label: "Query / mutation", type: "code", section: "Query" },
      { key: "variables", label: "Variables (JSON, supports {{vars}})", type: "json", section: "Query", optional: true },
      { key: "storeIn", label: "Save the returned data under field", type: "text", placeholder: "data", section: "Output" },
    ],
  },

  // --- Google Sheets Actions ---------------------------------------------------
  googleSheetsRead: {
    ...actionBase,
    type: "googleSheetsRead",
    name: "Google Sheets — Read Rows",
    description: "Read rows from a Google Sheets spreadsheet.",
    icon: "sheet",
    defaults: { apiKey: "", spreadsheetId: "", sheetName: "", range: "A:Z", maxRows: 100 },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "spreadsheetId", label: "Spreadsheet ID", type: "text", section: "Source" },
      { key: "sheetName", label: "Sheet name", type: "text", section: "Source", placeholder: "first tab", help: "The tab name at the bottom of the spreadsheet. Leave empty to use the first tab (its name depends on the account's language, e.g. Sheet1 or Tabellenblatt1)." },
      { key: "range", label: "Cell range (e.g. A:Z)", type: "text", section: "Source" },
      { key: "maxRows", label: "Max rows", type: "number", section: "Source" },
    ],
  },

  googleSheetsAppend: {
    ...actionBase,
    type: "googleSheetsAppend",
    name: "Google Sheets — Append Row",
    description: "Append a row to a Google Sheets spreadsheet.",
    icon: "sheet",
    defaults: { apiKey: "", spreadsheetId: "", sheetName: "", values: '[\n  ["{{name}}", "{{email}}"]\n]' },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "spreadsheetId", label: "Spreadsheet ID", type: "text", section: "Target" },
      { key: "sheetName", label: "Sheet name", type: "text", section: "Target", placeholder: "first tab", help: "The tab name at the bottom of the spreadsheet. Leave empty to use the first tab (its name depends on the account's language, e.g. Sheet1 or Tabellenblatt1)." },
      { key: "values", label: "Row values (JSON 2D array, supports {{vars}})", type: "json", section: "Data" },
    ],
  },

  sheetsUpdate: {
    ...actionBase,
    type: "sheetsUpdate",
    name: "Google Sheets — Update Row",
    description: "Overwrite existing cells in a Google Sheets spreadsheet (a range you point at).",
    icon: "sheet",
    defaults: { apiKey: "", spreadsheetId: "", sheetName: "", range: "A2", values: '[\n  ["{{name}}", "{{email}}"]\n]' },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "spreadsheetId", label: "Spreadsheet ID", type: "text", section: "Target" },
      { key: "sheetName", label: "Sheet name", type: "text", section: "Target", placeholder: "first tab", help: "The tab name at the bottom of the spreadsheet. Leave empty to use the first tab (its name depends on the account's language, e.g. Sheet1 or Tabellenblatt1)." },
      {
        key: "range",
        label: "Start cell (e.g. A2 or B2)",
        type: "text",
        help: "The update starts at this cell and grows with the values you send. Existing cells in that range are overwritten.",
        section: "Target",
      },
      { key: "values", label: "Row values (JSON 2D array, supports {{vars}})", type: "json", section: "Data" },
    ],
  },

  // --- Notion Actions ----------------------------------------------------------
  notionQueryDb: {
    ...actionBase,
    type: "notionQueryDb",
    name: "Notion — Query Database",
    description: "Query a Notion database with optional filters and sorts.",
    icon: "notion",
    defaults: { token: "", databaseId: "", filter: '', sorts: '', maxResults: 100 },
    fields: [
      { key: "token", label: "Integration token", type: "secret", section: "Credentials" },
      { key: "databaseId", label: "Database ID", type: "text", section: "Source" },
      { key: "filter", label: "Filter (JSON, optional)", type: "json", section: "Query", optional: true },
      { key: "sorts", label: "Sorts (JSON array, optional)", type: "json", section: "Query", optional: true },
      { key: "maxResults", label: "Max results", type: "number", section: "Query" },
    ],
  },

  notionUpdatePage: {
    ...actionBase,
    type: "notionUpdatePage",
    name: "Notion — Update Page",
    description: "Update properties or content of an existing Notion page.",
    icon: "notion",
    defaults: { token: "", pageId: "", properties: '{\n  "Name": {\n    "title": [{\n      "text": { "content": "{{message}}" }\n    }]\n  }\n}' },
    fields: [
      { key: "token", label: "Integration token", type: "secret", section: "Credentials" },
      { key: "pageId", label: "Page ID", type: "text", section: "Page" },
      { key: "properties", label: "Properties to update (JSON, supports {{vars}})", type: "json", section: "Data" },
    ],
  },

  // --- MongoDB ----------------------------------------------------------------
  mongoFind: {
    ...actionBase,
    type: "mongoFind",
    name: "MongoDB — Find",
    description: "Find documents in a MongoDB collection.",
    icon: "database",
    defaults: { apiUrl: 'https://data.mongodb-api.com/app/xxx/endpoint/data/v1/action/find', apiKey: "", database: "", collection: "", filter: '{\n  "_status": "active"\n}', sort: '', limit: 100, dataSource: "cluster0" },
    fields: [
      { key: "apiUrl", label: "MongoDB Data API URL", type: "text", section: "Credentials" },
      { key: "apiKey", label: "Data API key", type: "secret", section: "Credentials" },
      { key: "dataSource", label: "Data source (cluster name)", type: "text", placeholder: "cluster0", section: "Credentials", optional: true },
      { key: "database", label: "Database", type: "text", section: "Query" },
      { key: "collection", label: "Collection", type: "text", section: "Query" },
      { key: "filter", label: "Filter (JSON)", type: "json", section: "Query" },
      { key: "sort", label: "Sort (JSON, optional)", type: "json", section: "Query", optional: true },
      { key: "limit", label: "Limit", type: "number", section: "Query" },
    ],
  },

  mongoInsert: {
    ...actionBase,
    type: "mongoInsert",
    name: "MongoDB — Insert",
    description: "Insert one or more documents into a MongoDB collection.",
    icon: "database",
    defaults: { apiUrl: 'https://data.mongodb-api.com/app/xxx/endpoint/data/v1/action/insertOne', apiKey: "", database: "", collection: "", document: '{\n  "name": "{{name}}",\n  "email": "{{email}}"\n}', dataSource: "cluster0" },
    fields: [
      { key: "apiUrl", label: "MongoDB Data API URL", type: "text", section: "Credentials" },
      { key: "apiKey", label: "Data API key", type: "secret", section: "Credentials" },
      { key: "dataSource", label: "Data source (cluster name)", type: "text", placeholder: "cluster0", section: "Credentials", optional: true },
      { key: "database", label: "Database", type: "text", section: "Target" },
      { key: "collection", label: "Collection", type: "text", section: "Target" },
      { key: "document", label: "Document (JSON, supports {{vars}})", type: "json", section: "Data" },
    ],
  },

  // --- Airtable Read/Update ----------------------------------------------------
  airtableRead: {
    ...actionBase,
    type: "airtableRead",
    name: "Airtable — Read Records",
    description: "Read records from an Airtable table with optional filter and sort.",
    icon: "table",
    defaults: { apiKey: "", baseId: "", tableName: "Table 1", filter: '', sort: '', maxRecords: 100 },
    fields: [
      { key: "apiKey", label: "API key (personal access token)", type: "secret", section: "Credentials" },
      { key: "baseId", label: "Base ID", type: "text", section: "Source" },
      { key: "tableName", label: "Table name", type: "text", section: "Source" },
      { key: "filter", label: "Filter formula (optional)", type: "text", placeholder: "SEARCH(\"active\",{Status})", section: "Filter", optional: true },
      { key: "sort", label: "Sort by field (optional)", type: "text", section: "Filter", optional: true },
      { key: "maxRecords", label: "Max records", type: "number", section: "Filter" },
    ],
  },

  airtableUpdate: {
    ...actionBase,
    type: "airtableUpdate",
    name: "Airtable — Update Record",
    description: "Update an existing Airtable record by its ID.",
    icon: "table",
    defaults: { apiKey: "", baseId: "", tableName: "Table 1", recordId: '{{id}}', fields: '{\n  "Name": "{{name}}"\n}' },
    fields: [
      { key: "apiKey", label: "API key (personal access token)", type: "secret", section: "Credentials" },
      { key: "baseId", label: "Base ID", type: "text", section: "Target" },
      { key: "tableName", label: "Table name", type: "text", section: "Target" },
      { key: "recordId", label: "Record ID (supports {{vars}})", type: "text", section: "Target" },
      { key: "fields", label: "Fields to update (JSON, supports {{vars}})", type: "json", section: "Data" },
    ],
  },

  airtableDelete: {
    ...actionBase,
    type: "airtableDelete",
    name: "Airtable — Delete Record",
    description: "Delete an Airtable record by its ID.",
    icon: "table",
    defaults: { apiKey: "", baseId: "", tableName: "Table 1", recordId: "{{id}}" },
    fields: [
      { key: "apiKey", label: "API key (personal access token)", type: "secret", section: "Credentials" },
      { key: "baseId", label: "Base ID", type: "text", section: "Target" },
      { key: "tableName", label: "Table name", type: "text", section: "Target" },
      { key: "recordId", label: "Record ID (supports {{vars}})", type: "text", section: "Target" },
    ],
  },

  // --- Supabase Read/Update ----------------------------------------------------
  supabaseRead: {
    ...actionBase,
    type: "supabaseRead",
    name: "Supabase — Read Rows",
    description: "Read rows from a Supabase table.",
    icon: "database",
    defaults: { url: "https://xyzcompany.supabase.co", anonKey: "", tableName: "items", select: '*', filter: '', limit: 100 },
    fields: [
      { key: "url", label: "Project URL", type: "text", section: "Credentials" },
      { key: "anonKey", label: "anon / service key", type: "secret", section: "Credentials" },
      { key: "tableName", label: "Table name", type: "text", section: "Source" },
      { key: "select", label: "Columns to select", type: "text", placeholder: '*', section: "Source" },
      { key: "filter", label: "Filter (postgrest, optional)", type: "text", placeholder: 'status=eq.active', section: "Source", optional: true },
      { key: "limit", label: "Limit", type: "number", section: "Source" },
    ],
  },

  supabaseUpdate: {
    ...actionBase,
    type: "supabaseUpdate",
    name: "Supabase — Update Rows",
    description: "Update rows in a Supabase table matching a filter.",
    icon: "database",
    defaults: { url: "https://xyzcompany.supabase.co", anonKey: "", tableName: "items", match: '{\n  "id": "{{id}}"\n}', update: '{\n  "status": "done"\n}' },
    fields: [
      { key: "url", label: "Project URL", type: "text", section: "Credentials" },
      { key: "anonKey", label: "anon / service key", type: "secret", section: "Credentials" },
      { key: "tableName", label: "Table name", type: "text", section: "Target" },
      { key: "match", label: "Match filter (JSON, supports {{vars}})", type: "json", help: 'Which rows to update, e.g. {"id": "{{id}}"}', section: "Filter" },
      { key: "update", label: "Update data (JSON, supports {{vars}})", type: "json", section: "Data" },
    ],
  },

  // --- Twitter / X -------------------------------------------------------------
  twitterPost: {
    ...actionBase,
    type: "twitterPost",
    name: "X (Twitter) — Post Tweet",
    description: "Post a tweet via the X API v2.",
    icon: "messageCircle",
    defaults: { bearerToken: "", text: "Hello from W flow!" },
    fields: [
      { key: "bearerToken", label: "Bearer token", type: "secret", section: "Credentials" },
      { key: "text", label: "Tweet text (max 280 chars, supports {{vars}})", type: "textarea", section: "Tweet" },
    ],
  },

  // --- Salesforce --------------------------------------------------------------
  salesforceContact: {
    ...actionBase,
    type: "salesforceContact",
    name: "Salesforce — Create Contact",
    description: "Create a new contact in Salesforce.",
    icon: "users",
    defaults: { instanceUrl: 'https://yourinstance.my.salesforce.com', token: "", firstName: "{{name}}", lastName: "Unknown", email: '{{email}}' },
    fields: [
      { key: "instanceUrl", label: "Salesforce instance URL", type: "text", section: "Credentials" },
      { key: "token", label: "Access token", type: "secret", section: "Credentials" },
      { key: "firstName", label: "First name (supports {{vars}})", type: "text", section: "Contact" },
      { key: "lastName", label: "Last name (supports {{vars}})", type: "text", section: "Contact" },
      { key: "email", label: "Email (supports {{vars}})", type: "text", section: "Contact" },
    ],
  },

  // --- Slack (Bot API send) ----------------------------------------------------
  slackBotSend: {
    ...actionBase,
    type: "slackBotSend",
    name: "Slack — Bot Message",
    description: "Send a message to Slack using the Bot API (supports threads, formatting).",
    icon: "slack",
    defaults: { token: "", channel: "#general", text: "Hello from W flow!", threadTs: "" },
    fields: [
      { key: "token", label: "Bot token (xoxb-…)", type: "secret", section: "Credentials" },
      { key: "channel", label: "Channel", type: "text", placeholder: "#general", section: "Message" },
      { key: "text", label: "Message text (supports {{vars}})", type: "textarea", section: "Message" },
      { key: "threadTs", label: "Thread timestamp (optional — reply in thread)", type: "text", section: "Options", optional: true },
    ],
  },

  // --- GitHub extras -----------------------------------------------------------
  githubCreatePr: {
    ...actionBase,
    type: "githubCreatePr",
    name: "GitHub — Create Pull Request",
    description: "Create a pull request in a GitHub repository.",
    icon: "github",
    defaults: { token: "", owner: "", repo: "", title: "PR from W flow", head: "feature-branch", base: "main", body: "Created by W flow" },
    fields: [
      { key: "token", label: "Personal access token", type: "secret", section: "Credentials" },
      { key: "owner", label: "Repository owner", type: "text", section: "Repository" },
      { key: "repo", label: "Repository name", type: "text", section: "Repository" },
      { key: "title", label: "Title (supports {{vars}})", type: "text", section: "Pull Request" },
      { key: "head", label: "Head branch", type: "text", section: "Branches" },
      { key: "base", label: "Base branch", type: "text", section: "Branches" },
      { key: "body", label: "Description (supports {{vars}})", type: "textarea", section: "Pull Request" },
    ],
  },

  githubCreateRelease: {
    ...actionBase,
    type: "githubCreateRelease",
    name: "GitHub — Create Release",
    description: "Create a release in a GitHub repository.",
    icon: "github",
    defaults: { token: "", owner: "", repo: "", tagName: "v1.0.0", name: "Release", body: "Release notes here" },
    fields: [
      { key: "token", label: "Personal access token", type: "secret", section: "Credentials" },
      { key: "owner", label: "Repository owner", type: "text", section: "Repository" },
      { key: "repo", label: "Repository name", type: "text", section: "Repository" },
      { key: "tagName", label: "Tag name (supports {{vars}})", type: "text", section: "Release" },
      { key: "name", label: "Release name (supports {{vars}})", type: "text", section: "Release" },
      { key: "body", label: "Description (supports {{vars}})", type: "textarea", section: "Release" },
    ],
  },

  // --- n8n-inspired service nodes -------------------------------------------
  // Email family — parallels to SendGrid / Resend: Mailgun.
  mailgunSend: {
    ...actionBase,
    type: "mailgunSend",
    name: "Mailgun — Send Email",
    description: "Send an email through Mailgun's API (parallel to SendGrid / Resend).",
    icon: "mailSend",
    defaults: { apiKey: "", domain: "mg.example.com", from: "Workflow <workflow@mg.example.com>", to: "{{email}}", subject: "Workflow notification", text: "Hello from W flow!", html: "" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "domain", label: "Domain", type: "text", placeholder: "mg.example.com", section: "Credentials" },
      { key: "from", label: "From", type: "text", placeholder: "Workflow <workflow@mg.example.com>", section: "Message" },
      { key: "to", label: "To (comma separated)", type: "text", section: "Message" },
      { key: "subject", label: "Subject (supports {{vars}})", type: "text", section: "Message" },
      { key: "text", label: "Plain text body", type: "textarea", section: "Message" },
      { key: "html", label: "HTML body (optional, supports {{vars}})", type: "textarea", section: "Message", optional: true },
    ],
  },

  // SMS family — parallel to Twilio: Vonage (Nexmo).
  vonageSms: {
    ...actionBase,
    type: "vonageSms",
    name: "Vonage — Send SMS",
    description: "Send a text message through Vonage (Nexmo), the Twilio alternative.",
    icon: "messageSquare",
    defaults: { apiKey: "", apiSecret: "", from: "", to: "", text: "Hello from W flow!" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", section: "Credentials" },
      { key: "apiSecret", label: "API secret", type: "secret", section: "Credentials" },
      { key: "from", label: "From number / name", type: "text", placeholder: "+1234567890", section: "Credentials" },
      { key: "to", label: "To number", type: "text", placeholder: "+1234567890", section: "Message" },
      { key: "text", label: "Message text (supports {{vars}})", type: "textarea", section: "Message" },
    ],
  },

  // Incident family — parallel to PagerDuty: Opsgenie (Atlassian).
  opsgenieAlert: {
    ...actionBase,
    type: "opsgenieAlert",
    name: "Opsgenie — Create Alert",
    description: "Create an alert in Opsgenie (Atlassian), the PagerDuty alternative.",
    icon: "siren",
    defaults: { apiKey: "", message: "Workflow alert", description: "{{body}}", priority: "P3", tags: "" },
    fields: [
      { key: "apiKey", label: "API key (GenieKey)", type: "secret", section: "Credentials" },
      { key: "message", label: "Alert message (supports {{vars}})", type: "text", section: "Alert" },
      { key: "description", label: "Description (supports {{vars}})", type: "textarea", section: "Alert" },
      {
        key: "priority",
        label: "Priority",
        type: "select",
        options: [{ value: "P1", label: "P1 — Critical" }, { value: "P2", label: "P2 — High" }, { value: "P3", label: "P3 — Moderate" }, { value: "P4", label: "P4 — Low" }, { value: "P5", label: "P5 — Info" }],
        section: "Alert",
      },
      { key: "tags", label: "Tags (comma separated, optional)", type: "text", section: "Alert", optional: true },
    ],
  },

  // Push notification family — Pushover (tiny, popular) and ntfy.sh (no key).
  pushoverSend: {
    ...actionBase,
    type: "pushoverSend",
    name: "Pushover — Send Notification",
    description: "Send a push notification to your phone / desktop via Pushover.",
    icon: "bell",
    defaults: { token: "", user: "", title: "W flow", message: "{{message}}", priority: 0, sound: "" },
    fields: [
      { key: "token", label: "Application token", type: "secret", help: "pushover.net → Your Application → create one.", section: "Credentials" },
      { key: "user", label: "User / group key", type: "secret", help: "Your personal user key on pushover.net.", section: "Credentials" },
      { key: "title", label: "Title (supports {{vars}})", type: "text", section: "Notification" },
      { key: "message", label: "Message (supports {{vars}})", type: "textarea", section: "Notification" },
      {
        key: "priority",
        label: "Priority",
        type: "select",
        options: [
          { value: -2, label: "Lowest (no notification)" },
          { value: -1, label: "Low (no sound)" },
          { value: 0, label: "Normal" },
          { value: 1, label: "High (bypass quiet hours)" },
          { value: 2, label: "Emergency (repeat until ack)" },
        ],
        section: "Notification",
      },
      { key: "sound", label: "Sound (optional)", type: "text", placeholder: "pushover", section: "Notification", optional: true },
    ],
  },

  ntfySend: {
    ...actionBase,
    type: "ntfySend",
    name: "ntfy — Send Notification",
    description: "Send a push notification to any device via ntfy.sh — free, no API key needed.",
    icon: "bell",
    defaults: { server: "https://ntfy.sh", topic: "wflow-alerts", title: "W flow", message: "{{message}}", priority: "default", tags: "" },
    fields: [
      { key: "server", label: "Server", type: "text", placeholder: "https://ntfy.sh", section: "Credentials", optional: true },
      { key: "topic", label: "Topic", type: "text", placeholder: "wflow-alerts", help: "Subscribers get everything published to this topic — choose something unguessable.", section: "Notification" },
      { key: "title", label: "Title (supports {{vars}})", type: "text", section: "Notification" },
      { key: "message", label: "Message (supports {{vars}})", type: "textarea", section: "Notification" },
      {
        key: "priority",
        label: "Priority",
        type: "select",
        options: [
          { value: "min", label: "Min" },
          { value: "low", label: "Low" },
          { value: "default", label: "Default" },
          { value: "high", label: "High" },
          { value: "urgent", label: "Urgent" },
        ],
        section: "Notification",
      },
      { key: "tags", label: "Tags / emojis (optional)", type: "text", placeholder: "warning,rotating_light", section: "Notification", optional: true },
    ],
  },

  // Storage family — parallels to Dropbox / OneDrive / SharePoint: S3 + WebDAV.
  s3Upload: {
    ...actionBase,
    type: "s3Upload",
    name: "S3 — Upload File",
    description: "Upload a text file to an AWS S3 bucket (SigV4 signing).",
    icon: "cloudUpload",
    defaults: { accessKeyId: "", secretAccessKey: "", region: "us-east-1", bucket: "my-bucket", key: "reports/report.txt", content: "{{body}}", contentType: "text/plain" },
    fields: [
      { key: "accessKeyId", label: "Access key ID", type: "secret", section: "Credentials" },
      { key: "secretAccessKey", label: "Secret access key", type: "secret", section: "Credentials" },
      { key: "region", label: "Region", type: "text", placeholder: "us-east-1", section: "Credentials" },
      { key: "bucket", label: "Bucket", type: "text", section: "Destination" },
      { key: "key", label: "Object key / path (supports {{vars}})", type: "text", placeholder: "reports/report.txt", section: "Destination" },
      { key: "content", label: "File content (supports {{vars}})", type: "textarea", section: "File" },
      { key: "contentType", label: "Content type", type: "text", placeholder: "text/plain", section: "File" },
    ],
  },

  webdavUpload: {
    ...actionBase,
    type: "webdavUpload",
    name: "WebDAV — Upload File",
    description: "Upload a text file to any WebDAV server (Nextcloud, ownCloud, Synology, …).",
    icon: "hardDrive",
    defaults: { url: "https://nextcloud.example.com/remote.php/dav/files/username", username: "", password: "", path: "reports/report.txt", content: "{{body}}" },
    fields: [
      { key: "url", label: "WebDAV base URL", type: "text", placeholder: "https://nextcloud.example.com/remote.php/dav/files/username", section: "Credentials" },
      { key: "username", label: "Username", type: "text", section: "Credentials" },
      { key: "password", label: "Password / app password", type: "secret", section: "Credentials" },
      { key: "path", label: "File path (supports {{vars}})", type: "text", placeholder: "reports/report.txt", section: "File" },
      { key: "content", label: "File content (supports {{vars}})", type: "textarea", section: "File" },
    ],
  },

  // CRM family — parallel to HubSpot / Salesforce: Pipedrive.
  pipedriveDeal: {
    ...actionBase,
    type: "pipedriveDeal",
    name: "Pipedrive — Create Deal",
    description: "Create a deal in Pipedrive (CRM), the HubSpot / Salesforce alternative.",
    icon: "briefcase",
    defaults: { apiToken: "", title: "Deal from W flow", value: "", currency: "USD", note: "{{body}}" },
    fields: [
      { key: "apiToken", label: "API token", type: "secret", section: "Credentials" },
      { key: "title", label: "Deal title (supports {{vars}})", type: "text", section: "Deal" },
      { key: "value", label: "Value (optional)", type: "number", section: "Deal", optional: true },
      { key: "currency", label: "Currency", type: "text", placeholder: "USD", section: "Deal", optional: true },
      { key: "note", label: "Note (supports {{vars}})", type: "textarea", section: "Deal", optional: true },
    ],
  },

  // Project management family — parallel to Jira / Asana / Trello: Linear.
  linearIssue: {
    ...actionBase,
    type: "linearIssue",
    name: "Linear — Create Issue",
    description: "Create an issue in Linear via the GraphQL API.",
    icon: "ticket",
    defaults: { apiKey: "", teamId: "", title: "Issue from W flow", description: "{{body}}" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", help: "linear.app → Settings → API → Personal API keys.", section: "Credentials" },
      { key: "teamId", label: "Team ID", type: "text", section: "Credentials" },
      { key: "title", label: "Title (supports {{vars}})", type: "text", section: "Issue" },
      { key: "description", label: "Description (supports {{vars}})", type: "textarea", section: "Issue" },
    ],
  },

  // Translation family — DeepL (the popular one) with a free-tier key.
  deeplTranslate: {
    ...actionBase,
    type: "deeplTranslate",
    name: "DeepL — Translate Text",
    description: "Translate text into another language via DeepL's API.",
    icon: "languages",
    defaults: { apiKey: "", text: "{{text}}", sourceLang: "", targetLang: "EN", storeIn: "translation" },
    fields: [
      { key: "apiKey", label: "DeepL API key", type: "secret", help: "deepl.com → Account → API keys. Free tier: api-free.deepl.com.", section: "Credentials" },
      { key: "text", label: "Text to translate (supports {{vars}})", type: "textarea", section: "Translate" },
      { key: "sourceLang", label: "Source language (optional, e.g. DE)", type: "text", placeholder: "DE", section: "Translate", optional: true },
      { key: "targetLang", label: "Target language", type: "text", placeholder: "EN", section: "Translate" },
      { key: "storeIn", label: "Save translation under field", type: "text", placeholder: "translation", section: "Output" },
    ],
  },

  // Knowledge / search family — no API key needed, like the Reddit node.
  wikipediaSearch: {
    ...actionBase,
    type: "wikipediaSearch",
    name: "Wikipedia — Search Articles",
    description: "Search Wikipedia articles — free, no API key needed.",
    icon: "book",
    defaults: { query: "workflow automation", language: "en", limit: 10, storeIn: "results" },
    fields: [
      { key: "query", label: "Search query (supports {{vars}})", type: "text", section: "Search" },
      { key: "language", label: "Language code", type: "text", placeholder: "en", section: "Search" },
      { key: "limit", label: "Max results", type: "number", section: "Search" },
      { key: "storeIn", label: "Save results under field", type: "text", placeholder: "results", section: "Output" },
    ],
  },

  hackernewsSearch: {
    ...actionBase,
    type: "hackernewsSearch",
    name: "Hacker News — Search Stories",
    description: "Search Hacker News stories and comments — free, no API key needed.",
    icon: "newspaper",
    defaults: { query: "n8n", limit: 10, storeIn: "stories" },
    fields: [
      { key: "query", label: "Search query (supports {{vars}})", type: "text", section: "Search" },
      { key: "limit", label: "Max results", type: "number", section: "Search" },
      { key: "storeIn", label: "Save results under field", type: "text", placeholder: "stories", section: "Output" },
    ],
  },

  // URL utilities — TinyURL works without any key.
  tinyurlShorten: {
    ...actionBase,
    type: "tinyurlShorten",
    name: "TinyURL — Shorten URL",
    description: "Shorten any URL with TinyURL — free, no API key needed.",
    icon: "link",
    defaults: { url: "{{url}}", storeIn: "shortUrl" },
    fields: [
      { key: "url", label: "URL to shorten (supports {{vars}})", type: "text", placeholder: "https://example.com/very/long/path", section: "URL" },
      { key: "storeIn", label: "Save short URL under field", type: "text", placeholder: "shortUrl", section: "Output" },
    ],
  },

  // Feeds — read any RSS / Atom feed, like n8n's "RSS Read" node.
  rssRead: {
    ...actionBase,
    type: "rssRead",
    name: "RSS — Read Feed",
    description: "Fetch an RSS or Atom feed and get the latest items (title, link, description, date).",
    icon: "newspaper",
    defaults: { url: "https://hnrss.org/newest", limit: 20, storeIn: "items" },
    fields: [
      { key: "url", label: "Feed URL (supports {{vars}})", type: "text", placeholder: "https://example.com/feed.xml", section: "Feed" },
      { key: "limit", label: "Max items", type: "number", section: "Feed" },
      { key: "storeIn", label: "Save items under field", type: "text", placeholder: "items", section: "Output" },
    ],
  },

  // AWS — SNS publish (SigV4-signed, same pattern as the S3 node).
  snsPublish: {
    ...actionBase,
    type: "snsPublish",
    name: "AWS SNS — Publish Message",
    description: "Publish a message to an Amazon SNS topic (or phone number) using your AWS access keys.",
    icon: "bell",
    defaults: { accessKeyId: "", secretAccessKey: "", region: "us-east-1", topicArn: "", phoneNumber: "", subject: "", message: "Hello from W flow", storeIn: "snsResult" },
    fields: [
      { key: "accessKeyId", label: "AWS Access Key ID", type: "secret", section: "AWS" },
      { key: "secretAccessKey", label: "AWS Secret Access Key", type: "secret", section: "AWS" },
      { key: "region", label: "Region", type: "text", placeholder: "us-east-1", section: "AWS" },
      { key: "topicArn", label: "Topic ARN (supports {{vars}})", type: "text", placeholder: "arn:aws:sns:us-east-1:123456789012:my-topic", section: "Publish" },
      { key: "phoneNumber", label: "Or SMS phone number (E.164, supports {{vars}})", type: "text", placeholder: "+15551234567", section: "Publish", optional: true },
      { key: "subject", label: "Subject (email subscriptions only)", type: "text", section: "Publish", optional: true },
      { key: "message", label: "Message (supports {{vars}})", type: "textarea", section: "Publish" },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "snsResult", section: "Output" },
    ],
  },

  // Random data — n8n's "Random Data" node: generate fake values for testing.
  randomData: {
    ...actionBase,
    type: "randomData",
    name: "Random Data — Generate",
    description: "Generate fake data (names, emails, numbers, UUIDs, …) to test workflows — no API key needed.",
    icon: "sparkles",
    defaults: { count: 3, fieldName: "value", type: "name" },
    fields: [
      { key: "count", label: "How many items", type: "number", section: "Data" },
      { key: "fieldName", label: "Field name", type: "text", placeholder: "value", section: "Data" },
      { key: "type", label: "Type of value", type: "select", options: [
        { value: "name", label: "Person name" },
        { value: "email", label: "Email address" },
        { value: "phone", label: "Phone number" },
        { value: "string", label: "Random text string" },
        { value: "word", label: "Single word" },
        { value: "sentence", label: "Sentence" },
        { value: "number", label: "Number" },
        { value: "boolean", label: "True / false" },
        { value: "date", label: "Date" },
        { value: "uuid", label: "UUID" },
        { value: "color", label: "Color hex" },
        { value: "ip", label: "IP address" },
      ], section: "Data" },
    ],
  },

  // YouTube — search videos with the free Google Custom/Data API.
  youtubeSearch: {
    ...actionBase,
    type: "youtubeSearch",
    name: "YouTube — Search Videos",
    description: "Search YouTube videos and get titles, channels, URLs and publish dates.",
    icon: "search",
    defaults: { apiKey: "", query: "n8n", maxResults: 10, storeIn: "videos" },
    fields: [
      { key: "apiKey", label: "YouTube Data API key", type: "secret", section: "YouTube" },
      { key: "query", label: "Search query (supports {{vars}})", type: "text", section: "Search" },
      { key: "maxResults", label: "Max results", type: "number", section: "Search" },
      { key: "storeIn", label: "Save videos under field", type: "text", placeholder: "videos", section: "Output" },
    ],
  },

  // Messaging / task / utility family — more classic n8n nodes.
  whatsappSend: {
    ...actionBase,
    type: "whatsappSend",
    name: "WhatsApp — Send Message",
    description: "Send a WhatsApp message via the Meta Cloud API (no on-prem gateway needed).",
    icon: "messageSquare",
    defaults: { accessToken: "", phoneNumberId: "", to: "", text: "Hello from W flow!" },
    fields: [
      { key: "accessToken", label: "Permanent access token", type: "secret", help: "Meta for Developers → WhatsApp → API Setup. Use a System User token so it never expires.", section: "Credentials" },
      { key: "phoneNumberId", label: "Phone number ID", type: "text", placeholder: "123456789012345", section: "Credentials" },
      { key: "to", label: "Recipient (supports {{vars}})", type: "text", placeholder: "+15551234567", section: "Message" },
      { key: "text", label: "Message text (supports {{vars}})", type: "textarea", section: "Message" },
    ],
  },

  todoistTask: {
    ...actionBase,
    type: "todoistTask",
    name: "Todoist — Create Task",
    description: "Create a task in Todoist.",
    icon: "checkSquare",
    defaults: { token: "", content: "Task from W flow", projectId: "", dueString: "", priority: 1 },
    fields: [
      { key: "token", label: "API token", type: "secret", section: "Credentials" },
      { key: "content", label: "Task content (supports {{vars}})", type: "text", section: "Task" },
      { key: "projectId", label: "Project ID (optional)", type: "text", section: "Task" },
      { key: "dueString", label: "Due date (optional)", type: "text", placeholder: "tomorrow at 12:00", help: "Natural language due date, e.g. \"tomorrow at 12:00\".", section: "Task" },
      { key: "priority", label: "Priority (1–4)", type: "number", section: "Task" },
    ],
  },

  clickupTask: {
    ...actionBase,
    type: "clickupTask",
    name: "ClickUp — Create Task",
    description: "Create a task in a ClickUp list.",
    icon: "checkSquare",
    defaults: { token: "", listId: "", name: "Task from W flow", description: "", priority: 0 },
    fields: [
      { key: "token", label: "Personal API token", type: "secret", section: "Credentials" },
      { key: "listId", label: "List ID", type: "text", placeholder: "123456789", section: "Task" },
      { key: "name", label: "Task name (supports {{vars}})", type: "text", section: "Task" },
      { key: "description", label: "Description (supports {{vars}})", type: "textarea", section: "Task" },
      { key: "priority", label: "Priority (0–4)", type: "number", help: "0 none · 1 urgent · 2 high · 3 normal · 4 low.", section: "Task" },
    ],
  },

  qrcode: {
    ...actionBase,
    type: "qrcode",
    name: "QR Code — Generate",
    description: "Generate a QR code PNG from any text or URL (no key needed).",
    icon: "qrcode",
    defaults: { text: "https://example.com", size: 256, outputFile: "qrcode.png" },
    fields: [
      { key: "text", label: "Content (supports {{vars}})", type: "textarea", placeholder: "https://example.com", section: "Content" },
      { key: "size", label: "Size (px)", type: "number", section: "Content" },
      { key: "outputFile", label: "File name", type: "text", placeholder: "qrcode.png", help: "The PNG is registered under this name so a downstream Extract File / Write File node can pick it up.", section: "Output file" },
    ],
  },

  // Database family — connect to real external databases, like n8n's Postgres
  // / MySQL nodes (the built-in SQL Query node targets the local SQLite DB).
  sqlPostgres: {
    ...actionBase,
    type: "sqlPostgres",
    name: "PostgreSQL — Query",
    description: "Run a query against any PostgreSQL database and get the rows back.",
    icon: "database",
    defaults: { host: "localhost", port: 5432, database: "postgres", user: "postgres", password: "", ssl: false, query: "SELECT NOW() AS now;", params: "{}", storeIn: "rows", connectTimeoutMs: 10000 },
    fields: [
      { key: "host", label: "Host", type: "text", placeholder: "localhost", section: "Connection" },
      { key: "port", label: "Port", type: "number", section: "Connection" },
      { key: "database", label: "Database", type: "text", section: "Connection" },
      { key: "user", label: "User", type: "text", section: "Connection" },
      { key: "password", label: "Password", type: "secret", section: "Connection" },
      { key: "ssl", label: "Use TLS (SSL)", type: "boolean", section: "Connection" },
      { key: "query", label: "SQL (supports {{vars}} and :name params)", type: "code", placeholder: "SELECT * FROM users WHERE id = :id;", help: "Named parameters like :name are bound safely from the params field below. PostgreSQL casts like ::text still work.", section: "Query" },
      { key: "params", label: "Named params (JSON, supports {{vars}})", type: "json", placeholder: '{\n  ":id": "{{id}}"\n}', help: "Optional map of :name → value to bind safely into the query.", section: "Query", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "rows", section: "Output" },
    ],
  },

  sqlMysql: {
    ...actionBase,
    type: "sqlMysql",
    name: "MySQL — Query",
    description: "Run a query against any MySQL / MariaDB database and get the rows back.",
    icon: "database",
    defaults: { host: "localhost", port: 3306, database: "", user: "root", password: "", query: "SELECT NOW() AS now;", params: "{}", storeIn: "rows", connectTimeoutMs: 10000 },
    fields: [
      { key: "host", label: "Host", type: "text", placeholder: "localhost", section: "Connection" },
      { key: "port", label: "Port", type: "number", section: "Connection" },
      { key: "database", label: "Database", type: "text", section: "Connection" },
      { key: "user", label: "User", type: "text", section: "Connection" },
      { key: "password", label: "Password", type: "secret", section: "Connection" },
      { key: "query", label: "SQL (supports {{vars}} and :name params)", type: "code", placeholder: "SELECT * FROM users WHERE id = :id;", help: "Named parameters like :name are bound safely from the params field below.", section: "Query" },
      { key: "params", label: "Named params (JSON, supports {{vars}})", type: "json", placeholder: '{\n  ":id": "{{id}}"\n}', help: "Optional map of :name → value to bind safely into the query.", section: "Query", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "rows", section: "Output" },
    ],
  },

  // Commerce family — the classic n8n Shopify node.
  shopifyProduct: {
    ...actionBase,
    type: "shopifyProduct",
    name: "Shopify — Create Product",
    description: "Create a product in a Shopify store (Admin API).",
    icon: "shoppingBag",
    defaults: { shop: "your-shop.myshopify.com", accessToken: "", title: "New product", bodyHtml: "", vendor: "", productType: "", price: "", status: "draft" },
    fields: [
      { key: "shop", label: "Shop domain", type: "text", placeholder: "your-shop.myshopify.com", section: "Credentials" },
      { key: "accessToken", label: "Admin API access token", type: "secret", help: "Shopify admin → Settings → Apps → develop an app → Admin API access token.", section: "Credentials" },
      { key: "title", label: "Title (supports {{vars}})", type: "text", section: "Product" },
      { key: "bodyHtml", label: "Description (HTML, supports {{vars}})", type: "textarea", section: "Product" },
      { key: "vendor", label: "Vendor", type: "text", section: "Product", optional: true },
      { key: "productType", label: "Product type", type: "text", section: "Product", optional: true },
      { key: "price", label: "Price (optional)", type: "text", placeholder: "19.99", section: "Product", optional: true },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [{ value: "draft", label: "Draft" }, { value: "active", label: "Active" }, { value: "archived", label: "Archived" }],
        section: "Product",
      },
    ],
  },

  // Knowledge / search family — the n8n Google Search node (Custom Search API).
  googleSearch: {
    ...actionBase,
    type: "googleSearch",
    name: "Google — Search",
    description: "Search the web with Google Custom Search JSON API.",
    icon: "search",
    defaults: { apiKey: "", searchEngineId: "", query: "", num: 10, storeIn: "results" },
    fields: [
      { key: "apiKey", label: "API key", type: "secret", help: "Google Cloud Console → APIs & Services → Custom Search API.", section: "Credentials" },
      { key: "searchEngineId", label: "Search engine ID (cx)", type: "text", help: "programmablesearchengine.google.com → your engine's Search engine ID.", section: "Credentials" },
      { key: "query", label: "Search query (supports {{vars}})", type: "text", section: "Search" },
      { key: "num", label: "Max results (1-10)", type: "number", section: "Search" },
      { key: "storeIn", label: "Save results under field", type: "text", placeholder: "results", section: "Output" },
    ],
  },

  // Chat output — posts a message back into the chat panel that a Chat Trigger
  // opened (and into the Execution tab's chat section).
  chatOutput: {
    ...actionBase,
    type: "chatOutput",
    name: "Chat Output",
    description: "Send a reply back into the chat panel (use with a Chat Trigger).",
    icon: "reply",
    defaults: { text: "{{message}}", role: "assistant" },
    fields: [
      { key: "text", label: "Message (supports {{vars}})", type: "textarea", placeholder: "{{message}}", help: "The text the user sees in the chat panel. Typically the reply of an upstream AI node, e.g. {{reply}}.", section: "Message" },
      { key: "role", label: "Sender", type: "select", options: [{ value: "assistant", label: "Assistant (the bot)" }, { value: "user", label: "User" }], section: "Message" },
      { key: "storeIn", label: "Also save the reply under field", type: "text", placeholder: "reply", help: "Optional — makes the chat reply available to downstream nodes.", section: "Output", optional: true },
    ],
  },
};

// ----------------------------------------------------------------------------
// FILES & DATA — extraction nodes for the ~150 most common file types
// (registry: shared/filetypes.js, engine: server/fileextract.js)
// ----------------------------------------------------------------------------

const fileBase = { kind: NODE_KINDS.action, category: "files", sources: ["out"] };

// Shared input fields for every file node: which payload field holds the file,
// what it looks like (base64 / text / URL / JSON) and how to detect its type.
// The whole group is hidden when the user picks "a file produced upstream"
// (visibleWhen with not:true → visible unless fileSource is exactly "named").
const fileSourceFields = [
  {
    key: "sourceField",
    label: "Field with the file",
    type: "text",
    placeholder: "data",
    help: "The payload field holding the file: base64 or text content, a URL, or a JSON value.",
    section: "Input",
    fieldPath: true,
    visibleWhen: { key: "fileSource", value: "named", not: true },
  },
  {
    key: "contentMode",
    label: "Content is",
    type: "select",
    options: [
      { value: "auto", label: "Auto — base64 or text" },
      { value: "base64", label: "Base64 (binary file)" },
      { value: "text", label: "Plain text" },
      { value: "url", label: "A URL to download" },
      { value: "json", label: "JSON value (stringified)" },
    ],
    section: "Input",
    visibleWhen: { key: "fileSource", value: "named", not: true },
  },
  {
    key: "fileNameField",
    label: "Field with the file name (optional)",
    type: "text",
    placeholder: "fileName",
    help: "Used to detect the file type. Falls back to the file name below.",
    section: "Input",
    optional: true,
    visibleWhen: { key: "fileSource", value: "named", not: true },
  },
  {
    key: "fileName",
    label: "File name (fallback)",
    type: "text",
    placeholder: "report.pdf",
    help: "The file name / extension used to detect the type when no name field is set.",
    section: "Input",
    optional: true,
    visibleWhen: { key: "fileSource", value: "named", not: true },
  },
];

// "File comes from" selector — shared by every node that can read a file either
// from a payload field or from a named file produced by an upstream node.
const fileSourceSelectField = {
  key: "fileSource",
  label: "File comes from",
  type: "select",
  options: [
    { value: "field", label: "A payload field (base64 / text / URL)" },
    { value: "named", label: "A file produced by an upstream node" },
  ],
  section: "Input",
};
const namedSourceField = {
  key: "sourceFile",
  label: "Which upstream file",
  type: "upstreamFile",
  placeholder: "report.pdf",
  help: "Pick one of the files the nodes before this one produce. A node's file is named by its 'Save output as file' setting, or gets an automatic name.",
  section: "Input",
  visibleWhen: { key: "fileSource", value: "named" },
};

// Field branch of the source selector (hidden when a named file is chosen).
const fieldSourceFields = [
  {
    key: "sourceField",
    label: "Field with the file",
    type: "text",
    placeholder: "data",
    help: "The payload field holding the file: base64 or text content, a URL, or a JSON value.",
    section: "Input",
    fieldPath: true,
    visibleWhen: { key: "fileSource", value: "named", not: true },
  },
  {
    key: "contentMode",
    label: "Content is",
    type: "select",
    options: [
      { value: "auto", label: "Auto — base64 or text" },
      { value: "base64", label: "Base64 (binary file)" },
      { value: "text", label: "Plain text" },
      { value: "url", label: "A URL to download" },
      { value: "json", label: "JSON value (stringified)" },
    ],
    section: "Input",
    visibleWhen: { key: "fileSource", value: "named", not: true },
  },
];

// Shared extraction options — used by Extract File and Read File from Disk.
const returnModeField = {
  key: "outputMode",
  label: "Return",
  type: "select",
  options: [
    { value: "auto", label: "Everything the type supports" },
    { value: "text", label: "Text" },
    { value: "structured", label: "Structured data" },
    { value: "rows", label: "Table rows" },
    { value: "entries", label: "Archive entries" },
    { value: "metadata", label: "Metadata" },
  ],
  section: "Output",
};
const structuredFormatField = {
  key: "format",
  label: "Format (for structured)",
  type: "select",
  options: [
    { value: "auto", label: "Auto (by file extension)" },
    { value: "json", label: "JSON" },
    { value: "jsonl", label: "JSON Lines" },
    { value: "xml", label: "XML" },
    { value: "yaml", label: "YAML" },
    { value: "toml", label: "TOML" },
    { value: "ini", label: "INI / .env / properties" },
    { value: "ics", label: "iCalendar (.ics)" },
    { value: "vcf", label: "vCard (.vcf)" },
    { value: "srt", label: "Subtitles (.srt / .vtt)" },
  ],
  section: "Output",
  visibleWhen: { key: "outputMode", value: "structured" },
};
const rowsOptionFields = [
  {
    key: "delimiter",
    label: "Delimiter",
    type: "select",
    options: [{ value: "auto", label: "Auto (by extension)" }, { value: ",", label: "Comma" }, { value: "\t", label: "Tab" }, { value: ";", label: "Semicolon" }, { value: "|", label: "Pipe" }],
    section: "Rows",
    visibleWhen: { key: "outputMode", value: "rows" },
  },
  { key: "headerRow", label: "First row is a header", type: "boolean", section: "Rows", visibleWhen: { key: "outputMode", value: "rows" } },
  { key: "sheetIndex", label: "Worksheet (1-based)", type: "number", help: "Which sheet to read for .xlsx / .ods files.", section: "Rows", visibleWhen: { key: "outputMode", value: "rows" } },
  { key: "maxRows", label: "Max rows", type: "number", section: "Rows", visibleWhen: { key: "outputMode", value: "rows" } },
];
const entriesOptionFields = [
  {
    key: "entryPattern",
    label: "Entry to extract (regex, optional)",
    type: "text",
    placeholder: "readme\\.txt",
    help: "For archives: the first entry whose name matches is returned as selectedText (textual) or selectedBase64 (binary).",
    section: "Entries",
    visibleWhen: { key: "outputMode", value: "entries" },
    optional: true,
  },
  { key: "maxEntries", label: "Max entries to list", type: "number", section: "Entries", visibleWhen: { key: "outputMode", value: "entries" } },
];
const textOptionFields = [
  { key: "encoding", label: "Text encoding", type: "select", options: [{ value: "utf-8", label: "UTF-8" }, { value: "latin1", label: "Latin-1 / ISO-8859-1" }, { value: "utf-16le", label: "UTF-16 LE" }], section: "Options" },
  { key: "maxTextLength", label: "Max text length", type: "number", section: "Options" },
];

const F = {
  // One universal file node: pick the file (field / base64 / text / URL / a
  // named file from upstream) and choose what to do with it via the "Return"
  // selector — text, structured data, table rows, archive entries or metadata.
  extractFile: {
    ...fileBase,
    type: "extractFile",
    name: "Extract File",
    description: "Work with any of 150+ common file types: detect the type, then return text, structured data, table rows, archive entries or metadata.",
    icon: "fileSearch",
    defaults: {
      fileSource: "field",
      sourceField: "data",
      sourceFile: "",
      contentMode: "auto",
      fileNameField: "",
      fileName: "",
      outputMode: "auto",
      format: "auto",
      delimiter: "auto",
      headerRow: true,
      sheetIndex: 1,
      encoding: "utf-8",
      maxTextLength: 100000,
      maxRows: 1000,
      entryPattern: "",
      maxEntries: 500,
      outputFile: "",
    },
    fields: [
      fileSourceSelectField,
      namedSourceField,
      ...fieldSourceFields,
      { key: "fileNameField", label: "Field with the file name (optional)", type: "text", placeholder: "fileName", help: "Used to detect the file type. Falls back to the file name below.", section: "Input", optional: true, visibleWhen: { key: "fileSource", value: "named", not: true } },
      { key: "fileName", label: "File name (fallback)", type: "text", placeholder: "report.pdf", help: "The file name / extension used to detect the type when no name field is set.", section: "Input", optional: true, visibleWhen: { key: "fileSource", value: "named", not: true } },
      returnModeField,
      structuredFormatField,
      ...rowsOptionFields,
      ...entriesOptionFields,
      ...textOptionFields,
      ...outputFileFields,
    ],
  },

  readFile: {
    ...fileBase,
    type: "readFile",
    name: "Read File from Disk",
    description: "Read a file from the server's ./data/files folder and extract its content — text, structured data, rows, entries or metadata.",
    icon: "folderOpen",
    defaults: {
      path: "example.txt",
      outputMode: "auto",
      format: "auto",
      delimiter: "auto",
      headerRow: true,
      sheetIndex: 1,
      encoding: "utf-8",
      maxTextLength: 100000,
      maxRows: 1000,
      entryPattern: "",
      maxEntries: 500,
      outputFile: "",
    },
    fields: [
      { key: "path", label: "Path (relative to data/files)", type: "text", placeholder: "folder/report.csv", help: "Files live in ./data/files on the server. Subfolders are fine; paths may not escape it.", section: "File" },
      returnModeField,
      structuredFormatField,
      ...rowsOptionFields,
      ...entriesOptionFields,
      ...textOptionFields,
      ...outputFileFields,
    ],
  },

  writeFile: {
    ...fileBase,
    type: "writeFile",
    name: "Write File to Disk",
    description: "Save a file into your account's file folder on the server — from an upstream named file or a payload field. Read File / List Files see it there, and the run log has a Download link for it.",
    icon: "save",
    defaults: { fileSource: "named", sourceFile: "", sourceField: "data", contentMode: "auto", fileName: "output.txt" },
    fields: [
      fileSourceSelectField,
      namedSourceField,
      ...fieldSourceFields,
      { key: "fileName", label: "Save as (relative to data/files)", type: "text", placeholder: "output.txt", help: "Where to write the file inside ./data/files. Subfolders are created automatically; '..' is not allowed.", section: "File" },
    ],
  },

  listFiles: {
    ...fileBase,
    type: "listFiles",
    name: "List Files on Disk",
    description: "List files in a folder under ./data/files — one item per file, so downstream nodes can iterate or filter them.",
    icon: "folder",
    defaults: { path: "", pattern: "", recursive: false },
    fields: [
      { key: "path", label: "Folder (relative to data/files, empty = root)", type: "text", placeholder: "reports", section: "Folder" },
      { key: "pattern", label: "Filter (regex on path, optional)", type: "text", placeholder: "\\.csv$", section: "Folder" },
      { key: "recursive", label: "Include subfolders", type: "boolean", section: "Folder" },
    ],
  },

  convertToFile: {
    ...fileBase,
    type: "convertToFile",
    name: "Convert to File",
    description: "Convert a payload field or an upstream file to another format — TXT, JSON, CSV or HTML — and hand it on as a named file.",
    icon: "fileOutput",
    defaults: { fileSource: "field", sourceField: "data", sourceFile: "", contentMode: "auto", format: "auto", delimiter: "auto", headerRow: true, outputFile: "output.txt" },
    fields: [
      fileSourceSelectField,
      namedSourceField,
      ...fieldSourceFields,
      {
        key: "format",
        label: "Convert to",
        type: "select",
        options: [
          { value: "auto", label: "Auto (by source type)" },
          { value: "txt", label: "Plain text (.txt)" },
          { value: "json", label: "JSON" },
          { value: "csv", label: "CSV" },
          { value: "html", label: "HTML table" },
        ],
        section: "Output",
      },
      {
        key: "delimiter",
        label: "Delimiter",
        type: "select",
        options: [{ value: "auto", label: "Auto (by extension)" }, { value: ",", label: "Comma" }, { value: "\t", label: "Tab" }, { value: ";", label: "Semicolon" }, { value: "|", label: "Pipe" }],
        section: "Output",
        visibleWhen: { key: "format", value: "csv" },
      },
      { key: "headerRow", label: "First row is a header", type: "boolean", section: "Output", visibleWhen: { key: "format", value: "csv" } },
      ...outputFileFields,
    ],
  },

  compress: {
    ...fileBase,
    type: "compress",
    name: "Compress to Archive",
    description: "Pack named files from upstream nodes into a ZIP or GZ archive.",
    icon: "fileArchive",
    defaults: { sources: "*", format: "zip", outputFile: "bundle.zip" },
    fields: [
      { key: "sources", label: "Files to include", type: "text", placeholder: "* (all named files), or names separated by commas", help: "Names of files produced by upstream 'Save output as file' settings. Use * for every named file in the run.", section: "Archive" },
      { key: "format", label: "Format", type: "select", options: [{ value: "zip", label: "ZIP" }, { value: "gz", label: "GZip (.gz)" }], section: "Archive" },
      ...outputFileFields,
    ],
  },

  dataStore: {
    ...fileBase,
    type: "dataStore",
    name: "Data Store",
    description: "Save and load JSON values by key in a persistent store (like the n8n / Make Data Store) — survives across runs in ./data.",
    icon: "database",
    defaults: { operation: "get", namespace: "default", key: "{{id}}", value: "{{json}}", storeIn: "value" },
    fields: [
      {
        key: "operation",
        label: "Operation",
        type: "select",
        options: [
          { value: "get", label: "Get value by key" },
          { value: "set", label: "Set value by key" },
          { value: "delete", label: "Delete key" },
          { value: "list", label: "List all keys" },
        ],
        section: "Operation",
      },
      { key: "namespace", label: "Namespace", type: "text", placeholder: "default", section: "Operation" },
      { key: "key", label: "Key (supports {{vars}})", type: "text", placeholder: "user-{{id}}", section: "Operation", visibleWhen: { key: "operation", value: "list", not: true } },
      { key: "value", label: "Value (JSON or text, supports {{vars}})", type: "textarea", placeholder: "{{json}}", section: "Operation", visibleWhen: { key: "operation", value: "set" } },
      { key: "storeIn", label: "Save loaded value under field", type: "text", placeholder: "value", section: "Output", visibleWhen: { key: "operation", value: "get" } },
    ],
  },

  // Run SQL against the built-in SQLite database (data/admin.db) — the same DB
  // that backs the admin panel and the user accounts. Free, no external service.
  sqlQuery: {
    ...fileBase,
    type: "sqlQuery",
    name: "SQL Query",
    description: "Run a read-only query (SELECT / WITH / VALUES / EXPLAIN) against the built-in SQLite database (data/admin.db) — free, no external service. SELECT returns rows; writes are blocked for safety because this database also stores accounts and secrets.",
    icon: "database",
    defaults: { sql: "SELECT id, email, name, created_at FROM users ORDER BY id DESC LIMIT 10;", params: "{}", storeIn: "rows" },
    fields: [
      { key: "sql", label: "SQL (supports {{vars}})", type: "code", placeholder: "SELECT …", help: "Runs against the local SQLite database (data/admin.db). Read-only: only SELECT / WITH / VALUES / EXPLAIN queries are allowed — the database also stores accounts and secrets, so writes are blocked (use the admin panel's SQL console for that). Named parameters like :name bind values from the params field below.", section: "Query" },
      { key: "params", label: "Named params (JSON, supports {{vars}})", type: "json", placeholder: '{\n  ":name": "{{name}}"\n}', help: "Optional map of :name → value to bind safely into the query.", section: "Query", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "rows", section: "Output" },
    ],
  },
};

// ----------------------------------------------------------------------------
// LOGIC
// ----------------------------------------------------------------------------

const logicBase = { kind: NODE_KINDS.logic, category: "logic", sources: ["out"] };

const L = {
  if: {
    ...logicBase,
    type: "if",
    name: "IF Condition",
    description: "Branch the workflow: true → top handle, false → bottom handle.",
    icon: "branch",
    defaults: { valueA: "{{status}}", operator: "equals", valueB: "success", caseSensitive: false },
    sources: ["true", "false"],
    fields: [
      { key: "valueA", label: "Value A (supports {{vars}})", type: "text" },
      {
        key: "operator",
        label: "Operator",
        type: "select",
        options: [
          { value: "equals", label: "equals" },
          { value: "notEquals", label: "not equals" },
          { value: "contains", label: "contains" },
          { value: "notContains", label: "not contains" },
          { value: "startsWith", label: "starts with" },
          { value: "regex", label: "matches regex" },
          { value: "gt", label: "greater than" },
          { value: "lt", label: "less than" },
          { value: "exists", label: "exists / not empty" },
          { value: "notExists", label: "not exists / empty" },
        ],
      },
      { key: "valueB", label: "Value B (regex pattern for 'matches regex')", type: "text" },
      { key: "caseSensitive", label: "Case sensitive", type: "boolean" },
    ],
  },

  set: {
    ...logicBase,
    type: "set",
    name: "Set / Transform",
    description: "Set or remove fields on the payload.",
    icon: "edit",
    defaults: { mode: "set", parseValues: false, fields: [{ key: "processed", value: "true" }] },
    fields: [
      { key: "mode", label: "Mode", type: "select", options: [{ value: "set", label: "Set fields" }, { value: "delete", label: "Delete fields" }], section: "Mode" },
      { key: "fields", label: "Fields (key → value, value supports {{vars}})", type: "keyvalue", section: "Fields" },
      {
        key: "parseValues",
        label: "Parse values as JSON / numbers",
        type: "boolean",
        help: "ON: '42' becomes a number and '{\"a\":1}' becomes an object instead of a string.",
        section: "Options",
      },
    ],
  },

  code: {
    ...logicBase,
    type: "code",
    name: "Code (JS)",
    description: "Run JavaScript (async supported). Input: items. Return: modified items array.",
    icon: "code",
    defaults: {
      code: `// items = [ { json: { ... } }, ... ]\n// return the (possibly modified) items\nreturn items.map(item => {\n  item.json.processedBy = "code node";\n  return item;\n});`,
      outputFile: "",
    },
    fields: [
      {
        key: "code",
        label: "JavaScript (async supported — you can await fetch etc.)",
        type: "code",
        section: "Code",
      },
      ...outputFileFields,
    ],
  },

  subworkflow: {
    ...logicBase,
    type: "subworkflow",
    name: "Execute Sub-Workflow",
    description: "Run one of your other workflows as a building block: the incoming item(s) are handed to it, it runs top to bottom, and the outputs of its last (end) nodes come back as the result.",
    icon: "workflow",
    defaults: { workflowId: "", storeIn: "result" },
    fields: [
      { key: "workflowId", label: "Workflow to execute", type: "workflowSelect", section: "Sub-workflow" },
      {
        key: "note",
        label: "How it works",
        type: "note",
        section: "Sub-workflow",
        help: "Each item arriving here is passed into the chosen workflow as its input. That workflow runs start to finish; what its end nodes output comes back here under the field below. One output item → that item's data; several → an object with an outputs array. A single output item is enough — build reusable logic once and call it from anywhere.",
      },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "result", section: "Output", optional: true },
    ],
  },

  loop: {
    ...logicBase,
    type: "loop",
    name: "Loop Over Items",
    description: "Iterate over incoming items, adding index metadata. Loop End collects results.",
    icon: "repeat",
    defaults: {},
    fields: [{ key: "note", label: "Note", type: "note", help: "Each incoming item is emitted with index/total metadata. Add a Loop End node to collect outputs." }],
  },

  loopEnd: {
    ...logicBase,
    type: "loopEnd",
    name: "Loop End",
    description: "Collects items from a loop into a single batch.",
    icon: "flag",
    defaults: {},
    sources: [],
    fields: [],
  },

  merge: {
    ...logicBase,
    type: "merge",
    name: "Merge",
    description: "Combine items from multiple incoming branches.",
    icon: "merge",
    defaults: { mode: "combine" },
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: [
          { value: "combine", label: "Combine all items" },
          { value: "first", label: "First branch only" },
          { value: "last", label: "Last branch only" },
        ],
      },
    ],
  },

  log: {
    ...logicBase,
    type: "log",
    name: "Console Log",
    description: "Write a message to the execution log.",
    icon: "terminal",
    defaults: { message: "{{message}}" },
    fields: [{ key: "message", label: "Message (supports {{vars}})", type: "textarea" }],
  },

  jsTransform: {
    ...logicBase,
    type: "jsTransform",
    name: "JS — Transform Item",
    description: "Map each item with a JavaScript function (runs once per item).",
    icon: "code",
    defaults: {
      code: "// item = the payload of one item\n// return the (possibly modified) payload\nitem.upper = String(item.name || \"\").toUpperCase();\nreturn item;",
    },
    fields: [{ key: "code", label: "Function body (item → item)", type: "code", section: "Code" }],
  },

  jsFilter: {
    ...logicBase,
    type: "jsFilter",
    name: "JS — Filter Items",
    description: "Keep only the items where the JavaScript condition is true.",
    icon: "code",
    defaults: { code: 'item.status === "success"' },
    fields: [{ key: "code", label: "Condition (return true to keep)", type: "code", section: "Code" }],
  },

  jsAggregate: {
    ...logicBase,
    type: "jsAggregate",
    name: "JS — Aggregate Items",
    description: "Fold all items into one result with a reducer (acc, item).",
    icon: "code",
    defaults: {
      code: "acc.total = (acc.total || 0) + (item.amount || 0);\nacc.count = (acc.count || 0) + 1;\nreturn acc;",
    },
    fields: [{ key: "code", label: "Reducer body (acc, item → acc)", type: "code", section: "Code" }],
  },

  textAggregate: {
    ...logicBase,
    type: "textAggregate",
    name: "Text Aggregator",
    description: "Combine a field from all incoming items into one text value (like Make's Text aggregator).",
    icon: "alignLeft",
    defaults: { field: "text", separator: "\n", prefix: "", suffix: "", storeIn: "aggregated" },
    fields: [
      { key: "field", label: "Field to combine", type: "text", placeholder: "text", section: "Input" },
      { key: "separator", label: "Separator", type: "text", placeholder: "\\n", section: "Input" },
      { key: "prefix", label: "Prefix", type: "text", section: "Input" },
      { key: "suffix", label: "Suffix", type: "text", section: "Input" },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "aggregated", section: "Output" },
    ],
  },

  stringTransform: {
    ...logicBase,
    type: "stringTransform",
    name: "String Transform",
    description: "Modify a text field: uppercase, lowercase, trim, replace or title-case.",
    icon: "text",
    defaults: { field: "{{value}}", operation: "upper", target: "", replacement: "" },
    fields: [
      { key: "field", label: "Field to transform", type: "text", placeholder: "name", section: "Input" },
      {
        key: "operation",
        label: "Operation",
        type: "select",
        options: [
          { value: "upper", label: "Uppercase" },
          { value: "lower", label: "Lowercase" },
          { value: "trim", label: "Trim whitespace" },
          { value: "title", label: "Title Case" },
          { value: "replace", label: "Find & replace" },
        ],
        section: "Operation",
      },
      { key: "target", label: "Find (for replace)", type: "text", placeholder: "foo", section: "Operation", visibleWhen: { key: "operation", value: "replace" } },
      { key: "replacement", label: "Replace with", type: "text", placeholder: "bar", section: "Operation", visibleWhen: { key: "operation", value: "replace" } },
      {
        key: "storeIn",
        label: "Save result under field",
        type: "text",
        placeholder: "name (leave empty to overwrite source)",
        help: "Leave empty to overwrite the source field with the transformed value.",
        section: "Output",
        optional: true,
      },
    ],
  },

  limit: {
    ...logicBase,
    type: "limit",
    name: "Limit",
    description: "Keep only the first N incoming items.",
    icon: "filter",
    defaults: { maxItems: 10 },
    fields: [{ key: "maxItems", label: "Maximum items to keep", type: "number", section: "Limit" }],
  },

  sort: {
    ...logicBase,
    type: "sort",
    name: "Sort",
    description: "Sort items by a field, ascending or descending, numeric or text.",
    icon: "sort",
    defaults: { field: "name", order: "asc", numeric: false },
    fields: [
      { key: "field", label: "Sort by field", type: "text", placeholder: "name", section: "Sort" },
      { key: "order", label: "Order", type: "select", options: [{ value: "asc", label: "Ascending" }, { value: "desc", label: "Descending" }], section: "Sort" },
      { key: "numeric", label: "Numeric sort", type: "boolean", help: "ON: compares numbers instead of strings, so 10 sorts after 2.", section: "Sort" },
    ],
  },

  dedupe: {
    ...logicBase,
    type: "dedupe",
    name: "Remove Duplicates",
    description: "Drop items that repeat the same value for a field, keeping the first occurrence.",
    icon: "filter",
    defaults: { field: "id" },
    fields: [{ key: "field", label: "Field to check for duplicates", type: "text", placeholder: "id", section: "Dedupe" }],
  },

  splitOut: {
    ...logicBase,
    type: "splitOut",
    name: "Split Out",
    description: "Turn a list field into one output item per element.",
    icon: "list",
    defaults: { field: "items", includeOtherFields: false },
    fields: [
      { key: "field", label: "Field to split", type: "text", placeholder: "items", section: "Split" },
      { key: "includeOtherFields", label: "Include other fields with each item", type: "boolean", section: "Options" },
    ],
  },

  dateAndTime: {
    ...logicBase,
    type: "dateAndTime",
    name: "Date & Time",
    description: "Get the current time, format a timestamp, or add/subtract time from a date.",
    icon: "calendar",
    defaults: { operation: "now", inputField: "", format: "ISO", outputField: "timestamp", amount: 0, unit: "days" },
    fields: [
      { key: "operation", label: "Operation", type: "select", options: [
        { value: "now", label: "Get current time" },
        { value: "format", label: "Format a date" },
        { value: "parse", label: "Parse a string to date" },
        { value: "add", label: "Add time" },
        { value: "subtract", label: "Subtract time" },
        { value: "diff", label: "Difference between dates" },
      ], section: "Operation" },
      { key: "inputField", label: "Date field (supports {{vars}})", type: "text", section: "Date", visibleWhen: { key: "operation", value: "now", not: true } },
      { key: "inputField2", label: "Second date field (for difference)", type: "text", help: "Only used by 'Difference between dates' — the result is the first date minus this one, in milliseconds.", section: "Date", visibleWhen: { key: "operation", value: "diff" } },
      { key: "format", label: "Format", type: "select", options: [
        { value: "ISO", label: "ISO 8601" },
        { value: "unix", label: "Unix timestamp (seconds)" },
        { value: "unixMs", label: "Unix timestamp (milliseconds)" },
        { value: "dateOnly", label: "YYYY-MM-DD" },
        { value: "dateTime", label: "YYYY-MM-DD HH:mm:ss" },
        { value: "readable", label: "Human readable" },
        { value: "custom", label: "Custom format" },
      ], section: "Format" },
      { key: "customFormat", label: "Custom format string", type: "text", placeholder: "YYYY-MM-DD HH:mm", section: "Format", visibleWhen: { key: "format", value: "custom" } },
      { key: "amount", label: "Amount", type: "number", section: "Offset", visibleWhen: { key: "operation", value: "diff", not: true } },
      { key: "unit", label: "Unit", type: "select", options: [
        { value: "seconds", label: "Seconds" }, { value: "minutes", label: "Minutes" }, { value: "hours", label: "Hours" },
        { value: "days", label: "Days" }, { value: "weeks", label: "Weeks" }, { value: "months", label: "Months" }, { value: "years", label: "Years" },
      ], section: "Offset", visibleWhen: { key: "operation", value: "diff", not: true } },
      { key: "outputField", label: "Save result under field", type: "text", placeholder: "timestamp", section: "Output" },
    ],
  },

  math: {
    ...logicBase,
    type: "math",
    name: "Math",
    description: "Perform arithmetic on a numeric field.",
    icon: "hash",
    defaults: { operation: "add", field: "amount", number: 1, outputField: "amount" },
    fields: [
      { key: "operation", label: "Operation", type: "select", options: [
        { value: "add", label: "Add (+)" }, { value: "subtract", label: "Subtract (−)" },
        { value: "multiply", label: "Multiply (×)" }, { value: "divide", label: "Divide (÷)" },
        { value: "round", label: "Round" }, { value: "floor", label: "Floor" }, { value: "ceil", label: "Ceil" },
        { value: "abs", label: "Absolute value" }, { value: "modulo", label: "Modulo (%)" },
        { value: "power", label: "Power (^)" },
      ], section: "Operation" },
      { key: "field", label: "Field (supports {{vars}})", type: "text", placeholder: "amount", section: "Values" },
      { key: "number", label: "Number", type: "number", section: "Values", visibleWhen: { key: "operation", value: "abs", not: true } },
      { key: "outputField", label: "Save result under field", type: "text", placeholder: "amount", section: "Output" },
    ],
  },

  stickyNote: {
    ...logicBase,
    type: "stickyNote",
    name: "Sticky Note",
    description: "Add a note / annotation on the canvas. Does not execute.",
    icon: "file",
    defaults: { content: "Write notes, links, or instructions here." },
    fields: [{ key: "content", label: "Note content", type: "textarea", section: "Note" }],
  },

  summarize: {
    ...logicBase,
    type: "summarize",
    name: "Summarize",
    description: "Group items by a field and compute aggregates (sum, avg, count, min, max).",
    icon: "table",
    defaults: { groupBy: "", operations: '[\n  { "field": "amount", "operation": "sum" }\n]' },
    fields: [
      { key: "groupBy", label: "Group by field", type: "text", placeholder: "category", section: "Group" },
      { key: "operations", label: "Aggregations (JSON array: [{ field, operation }])", type: "json", help: "Operations: sum, avg, count, min, max, first, last", section: "Aggregate" },
    ],
  },

  filter: {
    ...logicBase,
    type: "filter",
    name: "Filter",
    description: "Keep only items that match all conditions. Items that fail are dropped (no false branch).",
    icon: "filter",
    defaults: { conditions: '[\n  { "field": "status", "operator": "equals", "value": "success" }\n]' },
    fields: [
      { key: "conditions", label: "Conditions (JSON array)", type: "json", help: 'Each condition: { field, operator, value, caseSensitive? }. Operators: equals, notEquals, contains, notContains, startsWith, gt, lt, exists, regex.', section: "Conditions" },
    ],
  },

  pluck: {
    ...logicBase,
    type: "pluck",
    name: "Extract Field",
    description: "Pull a field out of each item so later nodes see it as the whole payload.",
    icon: "list",
    defaults: { field: "name", keep: false, storeIn: "value" },
    fields: [
      { key: "field", label: "Field to extract", type: "text", placeholder: "name", section: "Extract" },
      {
        key: "keep",
        label: "Keep the rest of the item",
        type: "boolean",
        help: "OFF: the item becomes just the extracted value. ON: adds the value back under 'storeIn'.",
        section: "Extract",
      },
      { key: "storeIn", label: "Store under field", type: "text", placeholder: "value", section: "Extract", visibleWhen: { key: "keep", value: true } },
    ],
  },

  // Wait for Approval — human-in-the-loop. The run pauses at this node; the
  // editor's Log console shows Approve / Reject buttons for the stalled run.
  // Nobody answering applies the "when nobody answers" setting, so an
  // unattended (webhook / schedule / Telegram) run can never hang forever.
  approval: {
    ...logicBase,
    type: "approval",
    name: "Wait for Approval",
    description: "Pause the run until a person approves or rejects it in the editor.",
    icon: "userCheck",
    defaults: { message: "Approve this run?", timeoutMinutes: 5, onTimeout: "fail", approveLabel: "Approve", rejectLabel: "Reject" },
    sources: ["approved", "rejected"],
    fields: [
      { key: "message", label: "What should be approved? (supports {{vars}})", type: "textarea", section: "Request", help: "Shown in the Log console next to the Approve / Reject buttons." },
      { key: "approveLabel", label: "Approve button text", type: "text", section: "Request", optional: true },
      { key: "rejectLabel", label: "Reject button text", type: "text", section: "Request", optional: true },
      { key: "timeoutMinutes", label: "Give up after (minutes)", type: "number", section: "Timeout", help: "How long the run waits for an answer before applying the setting below. 0 waits forever (not recommended for scheduled or webhook runs)." },
      {
        key: "onTimeout",
        label: "When nobody answers",
        type: "select",
        options: [
          { value: "fail", label: "Fail the run" },
          { value: "reject", label: "Treat it as rejected" },
          { value: "approve", label: "Treat it as approved" },
        ],
        section: "Timeout",
        help: "Runs started outside the editor (webhook, schedule, Telegram) have nobody watching, so this is what they use once the time is up.",
      },
      { key: "approvedItem", label: "Extra fields for the Approved output (JSON)", type: "textarea", section: "Edit", help: "Optional: extra JSON merged into the item handed to the Approved output. Use {{vars}} to reference the incoming data.", optional: true },
    ],
  },

  // Do Nothing — a deliberate no-op you can hang off a branch (Make/Pipedream
  // call it "No-op"). It passes its input straight through, so a branch that
  // should visibly stop somewhere has an end node instead of a dead wire.
  noop: {
    ...logicBase,
    type: "noop",
    name: "Do Nothing",
    description: "Pass the items straight through — a deliberate end/no-op step for a branch.",
    icon: "flag",
    defaults: {},
    fields: [{ key: "note", label: "Note", type: "note", help: "Nothing happens here; the incoming items are handed to the next node unchanged. Useful to close a branch deliberately." }],
  },

  // Stop and Error — end the run on purpose with a readable message (the
  // counterpart of n8n's "Stop and Error" / Make's "Throw error").
  stopError: {
    ...logicBase,
    type: "stopError",
    name: "Stop and Error",
    description: "Stop the whole run immediately and report this node as failed with your own message.",
    icon: "alert",
    defaults: { message: "Stopped on purpose: {{reason}}" },
    sources: [],
    fields: [
      { key: "message", label: "Error message (supports {{vars}})", type: "textarea", section: "Error" },
      {
        key: "note",
        label: "How it works",
        type: "note",
        section: "Error",
        help: "Reached? The run halts right here and is recorded as failed with this message, so nothing downstream executes. Use it to reject bad input, guard a branch, or make a test fail loudly.",
      },
    ],
  },

  // Parse / Stringify JSON — turn a JSON string inside the payload into real
  // data (or the other way round) without writing JavaScript.
  jsonParse: {
    ...logicBase,
    type: "jsonParse",
    name: "JSON — Parse / Stringify",
    description: "Turn a JSON string field into real data, or turn data back into a JSON string.",
    icon: "braces",
    defaults: { mode: "parse", field: "body", storeIn: "parsed", keepRest: true },
    fields: [
      {
        key: "mode",
        label: "Direction",
        type: "select",
        options: [{ value: "parse", label: "Parse a JSON string → data" }, { value: "stringify", label: "Data → JSON string" }],
        section: "Mode",
      },
      { key: "field", label: "Field to read (supports {{vars}})", type: "text", placeholder: "body", section: "Input" },
      { key: "keepRest", label: "Keep the rest of the item", type: "boolean", section: "Options" },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "parsed", section: "Output" },
    ],
  },

  // Base64 Encode / Decode — the formatter step every builder ships with.
  base64: {
    ...logicBase,
    type: "base64",
    name: "Base64 Encode / Decode",
    description: "Encode text to Base64 or decode Base64 back to text (useful for API auth headers and file payloads).",
    icon: "code",
    defaults: { mode: "encode", value: "{{text}}", storeIn: "base64" },
    fields: [
      {
        key: "mode",
        label: "Direction",
        type: "select",
        options: [{ value: "encode", label: "Encode → Base64" }, { value: "decode", label: "Decode Base64 → text" }],
        section: "Mode",
      },
      { key: "value", label: "Value (supports {{vars}})", type: "textarea", section: "Input" },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "base64", section: "Output" },
    ],
  },

  // Encrypt / Decrypt — symmetric AES-256-GCM with a passphrase you supply.
  // Handy for "store this secret in a Data Store / sheet, read it back later".
  encrypt: {
    ...logicBase,
    type: "encrypt",
    name: "Encrypt / Decrypt",
    description: "Encrypt a value with a passphrase (AES-256-GCM) or decrypt a value this node encrypted before.",
    icon: "key",
    defaults: { mode: "encrypt", value: "{{secret}}", passphrase: "", storeIn: "ciphertext" },
    fields: [
      {
        key: "mode",
        label: "Direction",
        type: "select",
        options: [{ value: "encrypt", label: "Encrypt" }, { value: "decrypt", label: "Decrypt" }],
        section: "Mode",
      },
      { key: "value", label: "Value (supports {{vars}})", type: "textarea", section: "Input" },
      {
        key: "passphrase",
        label: "Passphrase",
        type: "secret",
        help: "Kept out of the workflow JSON (stored encrypted in the credentials table). The same passphrase must be used to decrypt again.",
        section: "Security",
      },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "ciphertext", section: "Output" },
    ],
  },

  // URL — Parse / Build: split a URL into parts, or assemble one from parts.
  urlParse: {
    ...logicBase,
    type: "urlParse",
    name: "URL — Parse / Build",
    description: "Split a URL into protocol / host / path / query, or build a URL from parts.",
    icon: "link",
    defaults: { mode: "parse", url: "{{url}}", base: "https://api.example.com", path: "/items", query: [{ key: "q", value: "{{search}}" }], storeIn: "url" },
    fields: [
      {
        key: "mode",
        label: "Direction",
        type: "select",
        options: [{ value: "parse", label: "Parse a URL into parts" }, { value: "build", label: "Build a URL from parts" }],
        section: "Mode",
      },
      { key: "url", label: "URL to parse (supports {{vars}})", type: "text", placeholder: "{{url}}", section: "Input", visibleWhen: { key: "mode", value: "parse" } },
      { key: "base", label: "Base (e.g. https://api.example.com)", type: "text", section: "Input", visibleWhen: { key: "mode", value: "build" } },
      { key: "path", label: "Path", type: "text", section: "Input", visibleWhen: { key: "mode", value: "build" } },
      { key: "query", label: "Query parameters", type: "keyvalue", placeholderField: "name", placeholderValue: "value", section: "Input", visibleWhen: { key: "mode", value: "build" }, optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "url", section: "Output" },
    ],
  },

  switch: {
    ...logicBase,
    type: "switch",
    name: "Switch",
    description: "Route each item to the output that matches its value — one handle per case, plus a default.",
    icon: "shuffle",
    defaults: { value: "{{status}}", matchMode: "equals", caseSensitive: false, cases: [{ key: "success", value: "Success" }, { key: "failed", value: "Failed" }] },
    fields: [
      { key: "value", label: "Value to switch on (supports {{vars}})", type: "text", placeholder: "{{status}}", section: "Input" },
      {
        key: "matchMode",
        label: "Match",
        type: "select",
        options: [{ value: "equals", label: "Equals" }, { value: "contains", label: "Contains" }, { value: "startsWith", label: "Starts with" }],
        section: "Input",
      },
      { key: "caseSensitive", label: "Case sensitive", type: "boolean", section: "Input", optional: true },
      {
        key: "cases",
        label: "Cases (value → label). Items matching none go to default.",
        type: "keyvalue",
        placeholderField: "value to match",
        placeholderValue: "output label (optional)",
        section: "Cases",
      },
    ],
  },
};

// ----------------------------------------------------------------------------
// AI & AGENTS
// ----------------------------------------------------------------------------

const aiBase = { kind: NODE_KINDS.ai, category: "ai", sources: ["out"] };

// The providers the app can talk to, with the models each one is KNOWN to
// expose. The `models` list is what the pickers suggest (the node inspector, the
// saved-agent editor and the builder's setup): with an API key entered the panel
// replaces it with the provider's own live list, so this is the offline /
// no-key-yet set and it may never be complete. Each list holds the provider's
// current families (newest first) plus the older generations users still run,
// and the default model always appears in it. Chat, reasoning, image and
// embedding models are all listed where the provider has them, because the same
// dropdown serves every AI node — the embedding entries sit at the end of the
// longer lists so picking a chat model stays the easy case.
export const AI_PROVIDERS = [
  {
    value: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    models: [
      // GPT-5 family, newest first
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-pro",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      // reasoning models
      "o4",
      "o4-mini",
      "o3",
      "o3-pro",
      "o3-mini",
      "o1",
      "o1-pro",
      "o1-mini",
      // GPT-4 family, still widely used
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-4",
      "gpt-3.5-turbo",
      // Generate Image / Text Embeddings nodes
      "gpt-image-1",
      "gpt-image-1-mini",
      "text-embedding-3-large",
      "text-embedding-3-small",
      "text-embedding-ada-002",
    ],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-5",
    models: [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4-1",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-latest",
      "claude-3-5-sonnet-latest",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-latest",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-latest",
    ],
  },
  {
    value: "google",
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    models: [
      "gemini-3-pro",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-pro",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3-flash",
      "gemini-3-pro-preview",
      "gemini-2.5-pro",
      "gemini-2.5-pro-preview-06-05",
      "gemini-2.5-flash",
      "gemini-2.5-flash-preview-05-20",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      // Text Embeddings node
      "gemini-embedding-001",
      "gemini-embedding-exp-03-07",
      "text-embedding-004",
    ],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5-mini",
    models: [
      "openai/gpt-5.6-sol",
      "openai/gpt-5.5",
      "openai/gpt-5-mini",
      "openai/gpt-5-nano",
      "openai/gpt-4o-mini",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-3-5-sonnet-latest",
      "google/gemini-3-pro",
      "google/gemini-3.7-flash",
      "google/gemini-2.5-flash",
      "meta-llama/llama-4-maverick",
      "meta-llama/llama-4-scout",
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-r1",
      "qwen/qwen3-235b-a22b",
      "qwen/qwen3-coder",
      "qwen/qwen3-32b",
      "x-ai/grok-4",
      "x-ai/grok-3-mini",
      "mistralai/mistral-large-latest",
      "mistralai/mistral-small-latest",
      "mistralai/codestral-latest",
      "moonshotai/kimi-k2",
      "cohere/command-a",
      "amazon/nova-pro-v1",
      "perplexity/sonar-pro",
      "openai/gpt-oss-120b",
      "x-ai/grok-4-fast",
      "qwen/qwen3-coder-480b-a35b-instruct",
      "z-ai/glm-4.6",
      "moonshotai/kimi-k2-instruct",
      "meta-llama/llama-3.3-70b-instruct:free",
    ],
  },
  {
    value: "mistral",
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    models: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "mistral-nemo",
      "open-mistral-nemo",
      "magistral-medium-latest",
      "magistral-small-latest",
      "devstral-medium-latest",
      "ministral-8b-latest",
      "ministral-3b-latest",
      "codestral-latest",
      "pixtral-large-latest",
      "pixtral-12b-2409",
      "mistral-medium-2508",
      // Text Embeddings node
      "mistral-embed",
      "codestral-embed",
    ],
  },
  {
    value: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      "llama-4-maverick",
      "llama-4-scout",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "llama-3.2-3b-preview",
      "llama-3.2-1b-preview",
      "deepseek-r1-distill-llama-70b",
      "qwen-2.5-coder-32b",
      "qwen/qwen3-32b",
      "gemma2-9b-it",
      "gpt-oss-120b",
      "gpt-oss-20b",
      "moonshotai/kimi-k2-instruct",
      "mistral-saba-24b",
      "llama-3.1-70b-versatile",
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "openai/gpt-oss-safeguard-20b",
      "openai/gpt-oss-120b",
    ],
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4", "deepseek-chat", "deepseek-reasoner", "deepseek-v3.2", "deepseek-v3.1", "deepseek-v3", "deepseek-r1", "deepseek-coder"],
  },
  {
    value: "grok",
    label: "xAI (Grok)",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    models: [
      "grok-4",
      "grok-4-fast",
      "grok-4-fast-reasoning",
      "grok-4-fast-non-reasoning",
      "grok-code-fast-1",
      "grok-3",
      "grok-3-fast",
      "grok-3-mini",
      "grok-3-mini-fast",
      "grok-2-latest",
      "grok-2-1212",
      "grok-4-0709",
      "grok-2-vision-1212",
    ],
  },
  {
    value: "together",
    label: "Together AI",
    defaultBaseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "meta-llama/Llama-4-Maverick",
      "meta-llama/Llama-4-Scout",
      "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
      "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen3-235B-A22B-Instruct-Turbo",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
      "google/gemma-3-27b-it",
      "mistralai/Mixtral-8x22B-Instruct-v0.1",
      "openai/gpt-oss-120b",
      "moonshotai/Kimi-K2-Instruct",
      "zai-org/GLM-4.5-Air",
      // Text Embeddings node
      "BAAI/bge-large-en-v1.5",
      "BAAI/bge-m3",
    ],
  },
  {
    value: "lmstudio",
    label: "LM Studio (local)",
    defaultBaseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    models: [
      "local-model",
      "llama-3.1-8b-instruct",
      "llama-3.2-3b-instruct",
      "llama-3.3-70b-instruct",
      "qwen2.5-7b-instruct",
      "qwen2.5-coder-14b-instruct",
      "qwen3-14b",
      "qwen3-30b-a3b",
      "mistral-nemo-12b",
      "mistral-small-24b-instruct",
      "phi-4",
      "phi-4-mini-instruct",
      "gemma-2-9b-it",
      "gemma-3-12b-it",
      "deepseek-r1-distill-llama-8b",
      "deepseek-r1-distill-qwen-7b",
      "gpt-oss-20b",
      "qwen3-4b",
      "granite-3.1-8b-instruct",
      "llama-3.2-1b-instruct",
      // Text Embeddings node
      "nomic-embed-text-v1.5",
      "jina-embeddings-v3",
    ],
  },
  {
    value: "ollama",
    label: "Ollama (local)",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
    models: [
      "llama3.3",
      "llama3.2",
      "llama3.2:1b",
      "llama3.1",
      "qwen3",
      "qwen3-coder",
      "qwen2.5",
      "qwen2.5-coder",
      "mistral",
      "mistral-nemo",
      "phi4",
      "phi4-mini",
      "gemma2",
      "gemma3",
      "gemma3:12b",
      "deepseek-r1",
      "deepseek-coder-v2",
      "granite3.1-dense",
      "command-r",
      "smollm2",
      "qwen3:14b",
      "gemma3:4b",
      "gpt-oss:20b",
      "deepseek-v3.1",
      "llama3.2-vision",
      // Text Embeddings node
      "nomic-embed-text",
      "mxbai-embed-large",
    ],
  },
  // Hosted providers with an OpenAI-compatible chat endpoint, so they plug
  // into the same request path as OpenAI itself (just a different base URL).
  {
    value: "perplexity",
    label: "Perplexity",
    defaultBaseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar-pro",
    models: [
      "sonar-pro",
      "sonar",
      "sonar-reasoning-pro",
      "sonar-reasoning",
      "sonar-deep-research",
      "r1-1776",
    ],
  },
  {
    value: "cohere",
    label: "Cohere",
    defaultBaseUrl: "https://api.cohere.ai/compatibility/v1",
    defaultModel: "command-a-03-2025",
    models: [
      "command-a-03-2025",
      "command-r-plus",
      "command-r-plus-08-2024",
      "command-r",
      "command-r-08-2024",
      "command-r7b-12-2024",
      // Text Embeddings node
      "embed-v4.0",
    ],
  },
  {
    value: "huggingface",
    label: "Hugging Face",
    defaultBaseUrl: "https://router.huggingface.co/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct",
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct",
      "deepseek-ai/DeepSeek-V3.1",
      "Qwen/Qwen3-235B-A22B-Instruct-2507",
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "moonshotai/Kimi-K2-Instruct",
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
      "openai/gpt-oss-120b",
    ],
  },
  {
    value: "cerebras",
    label: "Cerebras",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
    models: [
      "llama-3.3-70b",
      "llama3.1-8b",
      "llama-4-scout-17b-16e-instruct",
      "qwen-3-32b",
      "qwen-3-235b-a22b-instruct-2507",
      "gpt-oss-120b",
      "zai-glm-4.6",
    ],
  },
  {
    value: "nvidia",
    label: "NVIDIA NIM",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    models: [
      "meta/llama-3.3-70b-instruct",
      "meta/llama-4-maverick-17b-128e-instruct",
      "nvidia/llama-3.3-nemotron-super-49b-v1",
      "deepseek-ai/deepseek-r1",
      "qwen/qwen3-235b-a22b",
      "mistralai/mistral-nemo-12b-instruct",
      // Text Embeddings node
      "nvidia/nv-embedqa-e5-v5",
    ],
  },
  {
    value: "fireworks",
    label: "Fireworks AI",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama4-maverick-instruct-basic",
    models: [
      "accounts/fireworks/models/llama4-maverick-instruct-basic",
      "accounts/fireworks/models/llama4-scout-instruct-basic",
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/qwen3-235b-a22b",
      "accounts/fireworks/models/kimi-k2-instruct",
      "accounts/fireworks/models/gpt-oss-120b",
      "accounts/fireworks/models/mixtral-8x22b-instruct",
    ],
  },
  {
    value: "sambanova",
    label: "SambaNova",
    defaultBaseUrl: "https://api.sambanova.ai/v1",
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    models: [
      "Meta-Llama-3.3-70B-Instruct",
      "Meta-Llama-3.1-405B-Instruct",
      "Llama-4-Maverick-17B-128E-Instruct",
      "DeepSeek-V3-0324",
      "DeepSeek-R1",
      "Qwen3-235B",
      "gpt-oss-120b",
    ],
  },
  {
    value: "github",
    label: "GitHub Models",
    defaultBaseUrl: "https://models.github.ai/inference",
    defaultModel: "openai/gpt-4o-mini",
    models: [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "openai/gpt-5-mini",
      "openai/o4-mini",
      "meta/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "deepseek/DeepSeek-V3-0324",
      "microsoft/Phi-4",
      "cohere/Cohere-command-r-plus",
    ],
  },
  // Embedding-only providers: pick one of these on the Text Embeddings node.
  {
    value: "voyage",
    label: "Voyage AI (embeddings)",
    defaultBaseUrl: "https://api.voyageai.com/v1",
    defaultModel: "voyage-3-large",
    models: [
      "voyage-3-large",
      "voyage-3.5",
      "voyage-3.5-lite",
      "voyage-3",
      "voyage-code-3",
      "voyage-finance-2",
      "voyage-law-2",
      "voyage-multilingual-2",
    ],
  },
  {
    value: "jina",
    label: "Jina AI (embeddings)",
    defaultBaseUrl: "https://api.jina.ai/v1",
    defaultModel: "jina-embeddings-v4",
    models: [
      "jina-embeddings-v4",
      "jina-embeddings-v3",
      "jina-embeddings-v2-base-en",
      "jina-embeddings-v2-base-code",
      "jina-clip-v2",
      "jina-colbert-v2",
    ],
  },
  { value: "custom", label: "Custom (OpenAI-compatible)", defaultBaseUrl: "", defaultModel: "", models: [] },
];

const modelFields = [
  {
    key: "provider",
    label: "Provider",
    type: "select",
    options: AI_PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
    section: "Model",
  },
  { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://api.openai.com/v1", section: "Model" },
  { key: "apiKey", label: "API key", type: "secret", placeholder: "sk-…", section: "Model" },
  { key: "model", label: "Model", type: "text", placeholder: "gpt-4o-mini", section: "Model" },
  { key: "temperature", label: "Temperature", type: "number", section: "Model" },
  { key: "maxTokens", label: "Max tokens", type: "number", section: "Model" },
];

const N = {
  aiChat: {
    ...aiBase,
    type: "aiChat",
    name: "Chat Model",
    description: "Send the payload to a chat model and get an answer.",
    icon: "sparkles",
    defaults: {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: "You are a helpful assistant inside a workflow automation. Answer using the data provided.",
      prompt: "Here is the workflow data:\n{{json}}\n\nRespond to it appropriately.",
      memory: false,
      jsonMode: false,
    },
    fields: [
      ...modelFields,
      { key: "systemPrompt", label: "System prompt", type: "textarea", section: "Prompt" },
      { key: "prompt", label: "User prompt (supports {{vars}})", type: "textarea", section: "Prompt" },
      { key: "memory", label: "Keep conversation memory", type: "boolean", section: "Prompt" },
      {
        key: "jsonMode",
        label: "JSON mode (structured output)",
        type: "boolean",
        help: "Ask the model to reply with valid JSON only (OpenAI-compatible providers).",
        section: "Prompt",
      },
    ],
  },

  // LangChain — LLM Chain (the n8n "Basic LLM Chain"): one prompt template goes
  // to the model and comes back as an answer, with an optional SECOND step that
  // takes that answer ({{chain}}) and refines it — so a single node runs a small
  // sequential chain instead of two Chat Model nodes wired together.
  langchainChain: {
    ...aiBase,
    type: "langchainChain",
    name: "LangChain — LLM Chain",
    description: "Run the classic prompt → model → answer chain in one node, optionally refined by a second step.",
    icon: "workflow",
    defaults: {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: "You are a helpful assistant inside a workflow automation. Answer using the data provided.",
      template: "Here is the workflow data:\n{{json}}\n\nAnswer the request in it.",
      refine: false,
      refineTemplate: "Here is the answer you gave:\n{{chain}}\n\nOriginal data:\n{{json}}\n\nRewrite the answer so it is clear, concrete and concise.",
      outputField: "text",
    },
    fields: [
      ...modelFields,
      { key: "systemPrompt", label: "System prompt", type: "textarea", section: "Chain" },
      { key: "template", label: "Prompt template (supports {{vars}})", type: "textarea", help: "The first step of the chain: this text (with {{placeholders}} filled from the payload) is sent to the model.", section: "Chain" },
      {
        key: "refine",
        label: "Add a second chain step",
        type: "boolean",
        help: "On: the first answer is fed into the second template below and the refined answer becomes the node's output. Off: the first answer is the output.",
        section: "Chain",
      },
      {
        key: "refineTemplate",
        label: "Second step template ({{chain}} = first answer)",
        type: "textarea",
        section: "Chain",
        visibleWhen: { key: "refine", value: true },
      },
      { key: "outputField", label: "Save answer under field", type: "text", placeholder: "text", section: "Output" },
    ],
  },

  aiAgent: {
    ...aiBase,
    type: "aiAgent",
    name: "AI Agent",
    description: "Run a saved AI agent (with tools), an inline model, or a foreign agent reached over an HTTP API.",
    icon: "bot",
    defaults: {
      agentSource: "saved",
      agentId: "",
      useInline: false,
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 1024,
      systemPrompt: "You are an AI agent. Use your tools when they help.",
      prompt: "Here is the workflow data:\n{{json}}\n\nComplete the task.",
      useHttpTool: true,
      httpMethod: "GET",
      httpUrl: "https://api.example.com/data",
      httpHeaders: '{\n  "Content-Type": "application/json"\n}',
      httpBody: '{}',
      useTimeTool: true,
      apiUrl: "",
      apiMethod: "POST",
      apiHeaders: '{\n  "Content-Type": "application/json"\n}',
      apiBody: '{\n  "message": "{{json}}"\n}',
      apiReplyPath: "",
      apiTimeout: 30,
    },
    fields: [
      {
        key: "agentSource",
        label: "Agent source",
        type: "select",
        options: [
          { value: "saved", label: "Use a saved agent" },
          { value: "inline", label: "Configure a model here" },
          { value: "api", label: "Call a foreign agent via API" },
        ],
        section: "Agent",
      },
      { key: "agentId", label: "Use saved agent", type: "agentSelect", help: "Pick an agent built in the AI Agent Builder.", section: "Agent", visibleWhen: { key: "agentSource", value: "saved" } },
      ...modelFields.map((f) => ({ ...f, visibleWhen: { key: "agentSource", value: "inline" } })),
      { key: "systemPrompt", label: "System prompt", type: "textarea", section: "Prompt", visibleWhen: { key: "agentSource", value: "api", not: true } },
      { key: "prompt", label: "User prompt (supports {{vars}})", type: "textarea", section: "Prompt", visibleWhen: { key: "agentSource", value: "api", not: true } },
      { key: "useHttpTool", label: "Enable HTTP request tool", type: "boolean", section: "Tools", visibleWhen: { key: "agentSource", value: "inline" } },
      { key: "httpMethod", label: "HTTP tool — method", type: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], section: "Tools", visibleWhen: { key: "agentSource", value: "inline" } },
      { key: "httpUrl", label: "HTTP tool — URL", type: "text", section: "Tools", visibleWhen: { key: "agentSource", value: "inline" } },
      { key: "httpHeaders", label: "HTTP tool — headers (JSON)", type: "json", section: "Tools", visibleWhen: { key: "agentSource", value: "inline" } },
      { key: "httpBody", label: "HTTP tool — body (JSON)", type: "json", section: "Tools", visibleWhen: { key: "agentSource", value: "inline" } },
      { key: "useTimeTool", label: "Enable current-time tool", type: "boolean", section: "Tools", visibleWhen: { key: "agentSource", value: "inline" } },
      { key: "apiUrl", label: "Agent endpoint URL", type: "text", placeholder: "https://api.agent.example.com/run", section: "Foreign API", visibleWhen: { key: "agentSource", value: "api" } },
      { key: "apiMethod", label: "Method", type: "select", options: ["POST", "GET"], section: "Foreign API", visibleWhen: { key: "agentSource", value: "api" } },
      { key: "apiHeaders", label: "Headers (JSON, supports {{vars}})", type: "json", section: "Foreign API", visibleWhen: { key: "agentSource", value: "api" } },
      { key: "apiBody", label: "Request body (JSON, supports {{vars}})", type: "json", placeholder: '{\n  "message": "{{json}}"\n}', section: "Foreign API", visibleWhen: { key: "agentSource", value: "api" } },
      { key: "apiReplyPath", label: "Path to the reply in the response", type: "text", placeholder: "data.output", help: "Dot-path into the response JSON. Leave empty to use the whole body as the reply.", section: "Foreign API", visibleWhen: { key: "agentSource", value: "api" }, optional: true },
      { key: "apiTimeout", label: "Timeout (s)", type: "number", section: "Foreign API", visibleWhen: { key: "agentSource", value: "api" }, optional: true },
    ],
  },

  prompt: {
    ...aiBase,
    type: "prompt",
    name: "Prompt Template",
    description: "Render a template with values from the payload.",
    icon: "template",
    defaults: { template: "Hello {{name}}, your status is {{status}}.", outputField: "prompt" },
    fields: [
      { key: "template", label: "Template ({{var}} placeholders)", type: "textarea", section: "Template" },
      { key: "outputField", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  aiImage: {
    ...aiBase,
    type: "aiImage",
    name: "Generate Image",
    description: "Generate an image from a prompt (OpenAI images API).",
    icon: "image",
    defaults: { apiKey: "", model: "gpt-image-1", size: "1024x1024", prompt: "A W flow-style illustration of a workflow" },
    fields: [
      { key: "apiKey", label: "OpenAI API key", type: "secret", section: "Credentials" },
      { key: "model", label: "Model", type: "text", section: "Image" },
      { key: "size", label: "Size", type: "select", options: ["256x256", "512x512", "1024x1024", "1536x1024", "1024x1536"], section: "Image" },
      { key: "prompt", label: "Prompt (supports {{vars}})", type: "textarea", section: "Image" },
    ],
  },

  aiParser: {
    ...aiBase,
    type: "aiParser",
    name: "AI Output Parser",
    description: "Turn the agent's text reply into structured data: JSON, key-value lines or regex.",
    icon: "sparkles",
    defaults: { sourceField: "reply", mode: "json", pattern: "", fieldNames: "" },
    fields: [
      { key: "sourceField", label: "Field with the reply text", type: "text", section: "Input" },
      {
        key: "mode",
        label: "Parse as",
        type: "select",
        options: [
          { value: "json", label: "JSON (auto-extracted from text)" },
          { value: "keyvalue", label: "Key: value lines" },
          { value: "regex", label: "Regular expression" },
        ],
        section: "Mode",
      },
      { key: "pattern", label: "Regex pattern", type: "text", placeholder: "(\\w+):\\s*(\\w+)", section: "Mode", visibleWhen: { key: "mode", value: "regex" } },
      { key: "fieldNames", label: "Group names (comma separated)", type: "text", placeholder: "key,value", section: "Mode", visibleWhen: { key: "mode", value: "regex" } },
    ],
  },

  aiEmbeddings: {
    ...aiBase,
    type: "aiEmbeddings",
    name: "Text Embeddings",
    description: "Turn text into a numerical vector for similarity work.",
    icon: "brain",
    defaults: {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "text-embedding-3-small",
      text: "{{text}}",
      storeIn: "vector",
    },
    fields: [
      ...modelFields,
      { key: "text", label: "Text to embed (supports {{vars}})", type: "textarea", section: "Input" },
      { key: "storeIn", label: "Save vector under field", type: "text", placeholder: "vector", section: "Output" },
    ],
  },

  vectorStore: {
    ...aiBase,
    type: "vectorStore",
    name: "Vector Store — Save",
    description: "Embed text and save it to the local vector memory under a named namespace, ready for semantic search.",
    icon: "database",
    defaults: {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "text-embedding-3-small",
      namespace: "default",
      key: "{{id}}",
      text: "{{text}}",
      meta: "",
    },
    fields: [
      ...modelFields,
      { key: "namespace", label: "Namespace", type: "text", placeholder: "default", section: "Store" },
      { key: "key", label: "Record key (supports {{vars}})", type: "text", placeholder: "{{id}}", section: "Store" },
      { key: "text", label: "Text to embed & store (supports {{vars}})", type: "textarea", section: "Store" },
      { key: "meta", label: "Extra JSON metadata (optional)", type: "json", placeholder: "{}", section: "Store", optional: true },
    ],
  },

  vectorSearch: {
    ...aiBase,
    type: "vectorSearch",
    name: "Vector Search",
    description: "Embed a query and return the most similar items saved by the Vector Store — Save node.",
    icon: "database",
    defaults: {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "text-embedding-3-small",
      namespace: "default",
      query: "{{text}}",
      topK: 5,
      storeIn: "matches",
    },
    fields: [
      ...modelFields,
      { key: "namespace", label: "Namespace", type: "text", placeholder: "default", section: "Search" },
      { key: "query", label: "Query text (supports {{vars}})", type: "textarea", section: "Search" },
      { key: "topK", label: "Top results", type: "number", section: "Search" },
      { key: "storeIn", label: "Save results under field", type: "text", placeholder: "matches", section: "Output" },
    ],
  },

  // Split Text into Chunks — the pre-step for embeddings / RAG / long-document
  // summarising (the Langflow/Gumloop "text splitter" idea, kept model-free).
  chunkText: {
    ...aiBase,
    type: "chunkText",
    name: "Split Text into Chunks",
    description: "Break a long text field into overlapping chunks — the classic pre-step for embeddings, RAG and summarising.",
    icon: "alignLeft",
    defaults: { field: "text", chunkSize: 1000, overlap: 100, mode: "items", storeIn: "chunk" },
    fields: [
      { key: "field", label: "Text field to split", type: "text", placeholder: "text", section: "Input" },
      { key: "chunkSize", label: "Characters per chunk", type: "number", section: "Chunking" },
      { key: "overlap", label: "Overlap (characters)", type: "number", help: "Each chunk repeats this many characters from the previous one, so a sentence split across the boundary is still complete in one of them.", section: "Chunking" },
      {
        key: "mode",
        label: "Output",
        type: "select",
        options: [
          { value: "items", label: "One item per chunk (run the next node per chunk)" },
          { value: "array", label: "One item holding an array of chunks" },
        ],
        section: "Output",
      },
      { key: "storeIn", label: "Save each chunk under field", type: "text", placeholder: "chunk", section: "Output" },
    ],
  },

  aiExtract: {
    ...aiBase,
    type: "aiExtract",
    name: "Extract Structured Data",
    description: "Use a chat model to pull structured JSON out of free text, following a schema you define.",
    icon: "sparkles",
    defaults: {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0,
      maxTokens: 1024,
      sourceField: "body",
      targetType: "object",
      schema: '{\n  "type": "object",\n  "properties": {\n    "name": { "type": "string" },\n    "status": { "type": "string" }\n  },\n  "required": ["name"]\n}',
      storeIn: "parsed",
      jsonMode: true,
    },
    fields: [
      ...modelFields,
      { key: "sourceField", label: "Field with the text to analyze", type: "text", placeholder: "body", section: "Input" },
      {
        key: "targetType",
        label: "Result shape",
        type: "select",
        options: [{ value: "object", label: "A single object" }, { value: "list", label: "A list of objects" }],
        section: "Schema",
      },
      {
        key: "schema",
        label: "JSON schema (describe one item)",
        type: "json",
        help: "Describe the shape of one object. For a single object it is returned directly; for a list the model returns an array of such objects.",
        section: "Schema",
      },
      { key: "storeIn", label: "Save result under field", type: "text", placeholder: "parsed", section: "Output" },
    ],
  },
};

// ----------------------------------------------------------------------------

export const NODES = {
  ...T,
  ...F,
  ...A,
  ...L,
  ...N,
  ...EXTRA_NODES,
};

// Triggers that only fire their sample when Run is pressed — no live delivery
// or polling yet. The palette and canvas badge them "Demo", so nobody builds
// an automation on one and waits for it to start by itself.
export const DEMO_TRIGGERS = new Set([
  "slackTrigger",
  "slackReactionTrigger",
  "notionTrigger",
  "teamsTrigger",
  "outlookTrigger",
  "jiraTrigger",
  "discordTrigger",
  "googleDriveTrigger",
  "hubspotTrigger",
  "airtableTrigger",
  "supabaseTrigger",
]);
for (const type of DEMO_TRIGGERS) if (NODES[type]) NODES[type].demo = true;

// Google / Microsoft nodes sign in through a connected account (see
// ./oauth.js) — added before the error-handling fields so the picker sits with
// the other credentials.
applyOAuthFields(NODES);
// Token cap and answer reuse on every node that calls a model (./ai-controls.js).
applyAiControlFields(NODES);

// ----------------------------------------------------------------------------
// Per-node error handling
//
// Instead of repeating the same three fields in ~160 node definitions they are
// appended here, once. Every node decides for itself what happens when its
// handler throws:
//
//   stop     — halt the run (the behaviour logic / AI / trigger nodes keep)
//   continue — hand the incoming items to the next node with an `_error` field
//              (the default for ACTION nodes: a flaky third-party API should
//              not kill an automation that has other work to do)
//   retry    — try again a few times, then stop
//
// Sticky notes are annotations, not steps — they never run, so they stay clean.
const ERROR_HANDLING_FIELDS = [
  {
    key: "onError",
    label: "If this node fails",
    type: "select",
    options: [
      { value: "stop", label: "Stop the workflow" },
      { value: "continue", label: "Continue — pass the items on" },
      { value: "retry", label: "Retry, then stop" },
    ],
    section: "On error",
    help: "Continue keeps the run alive: the incoming items are handed to the next node with an added `_error` field (message, code, node) and the failure is still recorded in the log. Retry repeats this node before giving up.",
  },
  {
    key: "retryCount",
    label: "Attempts",
    type: "number",
    section: "On error",
    help: "How many extra times this node is tried before the run gives up and stops.",
    example: "3",
    visibleWhen: { key: "onError", value: "retry" },
  },
  {
    key: "retryDelay",
    label: "Wait between attempts (seconds)",
    type: "number",
    section: "On error",
    help: "Pause between those attempts, in seconds. Useful when the other side throttles.",
    example: "5",
    visibleWhen: { key: "onError", value: "retry" },
  },
];

export const DEFAULT_ON_ERROR = { action: "continue", trigger: "stop", ai: "stop", logic: "stop" };

export function defaultOnErrorFor(type) {
  const kind = NODES[type]?.kind || "logic";
  return DEFAULT_ON_ERROR[kind] || "stop";
}

for (const def of Object.values(NODES)) {
  if (def.type === "stickyNote") continue;
  if ((def.fields || []).some((f) => f.key === "onError")) continue;
  def.fields = [...(def.fields || []), ...ERROR_HANDLING_FIELDS];
  // Only the mode goes into the saved config — the retry numbers fall back to
  // the executor's defaults so existing workflows stay small.
  def.defaults = { ...def.defaults, onError: defaultOnErrorFor(def.type) };
}

export const CATALOG = {
  categories: CATEGORIES,
  nodes: NODES,
  providers: AI_PROVIDERS,
  // Groups are derived from each node's `category` so nodes added in
  // ./services.js land in the right palette section automatically.
  groups: Object.entries(CATEGORIES).map(([id, category]) => ({
    id,
    label: category.label,
    nodes: Object.values(NODES).filter((n) => n.category === id).map((n) => n.type),
  })),
};

export function getNodeDef(type) {
  return NODES[type] || null;
}

export function isTriggerType(type) {
  return NODES[type]?.kind === NODE_KINDS.trigger;
}
