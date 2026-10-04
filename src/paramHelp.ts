import type { FieldDef } from "./types";

/**
 * Inline parameter help — the single source for what the little "?" next to a
 * node parameter shows.
 *
 * The "?" answers the questions people actually get stuck on: *where do I find
 * this value* (which settings page issues the token, which part of the URL is
 * the ID) and *how do I fill it* (fixed text vs. a field dragged in from an
 * earlier step). Restating the label ("Text value for Owner") helps nobody, so
 * a field with nothing useful to say gets no "?" at all.
 *
 * Hand-written catalog `help` wins, except for the handful of sentences the
 * catalog stamps onto hundreds of fields — those are replaced by the specific
 * text derived here.
 */

export interface ParamDescription {
  /** what the parameter does / how to fill it (may be empty when `where` says it all) */
  text: string;
  /** where the value comes from (settings page, part of a URL, …) */
  where?: string;
  /** page that issues the value, opened from the tooltip */
  link?: string;
  /** a small, concrete, valid value or format */
  example?: string;
}

/** The node the field belongs to — its name carries the service ("GitHub — Create Issue"). */
export interface ParamNode {
  name?: string;
  fields?: FieldDef[];
}

// ---- where credentials come from ----
// Keyed by the service part of the node name (lower case). Paths name the
// menus as the services label them; keep them short enough for a tooltip.
interface Where {
  where: string;
  link?: string;
  example?: string;
}

const MS_GRAPH: Where = {
  where: "For a quick test, Graph Explorer → sign in → Access token tab gives a token that lasts about an hour.",
  link: "https://developer.microsoft.com/graph/graph-explorer",
};
const GOOGLE_TOKEN: Where = {
  where: "For a quick test, the OAuth 2.0 Playground issues a token (valid one hour): pick the API, Authorize, then Exchange code for tokens.",
  link: "https://developers.google.com/oauthplayground",
};
const GOOGLE_KEY = (api: string): Where => ({
  where: `Google Cloud console → APIs & Services → Credentials → Create credentials → API key. Enable the ${api} under Library first.`,
  link: "https://console.cloud.google.com/apis/credentials",
  example: "AIzaSy…",
});
const AWS: Where = {
  where: "AWS console → IAM → Users → your user → Security credentials → Create access key. Give that user only the permissions this node needs.",
  link: "https://console.aws.amazon.com/iam/home#/users",
};
const ATLASSIAN: Where = {
  where: "Atlassian account → Security → Create and manage API tokens. It is used together with your account e-mail.",
  link: "https://id.atlassian.com/manage-profile/security/api-tokens",
};
const GITEA: Where = { where: "Your instance → Settings → Applications → Generate new token, with repository read/write." };

const CREDENTIALS: Record<string, Where> = {
  github: {
    where: "GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Pick the repository and grant the permissions this node needs (e.g. Issues: read and write).",
    link: "https://github.com/settings/personal-access-tokens/new",
    example: "github_pat_11A…",
  },
  gitlab: {
    where: "GitLab → avatar → Edit profile → Access tokens → Add new token, scope api.",
    link: "https://gitlab.com/-/user_settings/personal_access_tokens",
    example: "glpat-…",
  },
  gitea: GITEA,
  codeberg: GITEA,
  notion: {
    where: "Notion → Settings → Connections → Develop or manage integrations → New integration → copy the Internal Integration Secret. Then open your page or database → ••• → Connections → add the integration, or it can't see it.",
    link: "https://www.notion.so/profile/integrations",
    example: "ntn_…",
  },
  slack: {
    where: "api.slack.com/apps → your app → OAuth & Permissions → Install to workspace → copy the Bot User OAuth Token. Invite the bot to the channel (/invite @yourbot).",
    link: "https://api.slack.com/apps",
    example: "xoxb-…",
  },
  airtable: {
    where: "Airtable → Builder hub → Personal access tokens → Create token. Add the scopes data.records:read / write and the base it may use.",
    link: "https://airtable.com/create/tokens",
    example: "pat…",
  },
  stripe: {
    where: "Stripe dashboard → Developers → API keys → Secret key. Use the sk_test_ key while you try things out.",
    link: "https://dashboard.stripe.com/apikeys",
    example: "sk_test_…",
  },
  telegram: {
    where: "Open @BotFather in Telegram → /newbot → it replies with the bot token.",
    link: "https://t.me/BotFather",
    example: "123456789:AAH…",
  },
  supabase: {
    where: "Supabase dashboard → Project settings → API Keys. The anon key respects row-level security; the service_role key bypasses it.",
    link: "https://supabase.com/dashboard/project/_/settings/api-keys",
  },
  jira: ATLASSIAN,
  confluence: ATLASSIAN,
  hubspot: {
    where: "HubSpot → Settings → Integrations → Private apps → Create a private app, choose the CRM scopes, then copy its access token.",
    example: "pat-eu1-…",
  },
  trello: {
    where: "trello.com/power-ups/admin → your Power-Up → API key. The token is generated from the link next to the key.",
    link: "https://trello.com/power-ups/admin",
  },
  twilio: { where: "Twilio console → the dashboard's Account Info box shows the Account SID and Auth token.", link: "https://console.twilio.com" },
  sendgrid: {
    where: "SendGrid → Settings → API Keys → Create API Key (Mail Send access is enough).",
    link: "https://app.sendgrid.com/settings/api_keys",
    example: "SG.…",
  },
  mailgun: { where: "Mailgun → account menu (top right) → API Security → Add new key.", link: "https://app.mailgun.com" },
  resend: { where: "Resend → API Keys → Create API key.", link: "https://resend.com/api-keys", example: "re_…" },
  postmark: { where: "Postmark → your server → API Tokens → Server API token.", link: "https://account.postmarkapp.com/servers" },
  "brevo (sendinblue)": { where: "Brevo → your name (top right) → SMTP & API → API keys → Generate a new API key.", example: "xkeysib-…" },
  mailchimp: { where: "Mailchimp → Profile → Extras → API keys → Create A Key. The ending after the dash (e.g. us21) is your data centre." },
  klaviyo: { where: "Klaviyo → Settings → API keys → Create Private API Key.", example: "pk_…" },
  linear: { where: "Linear → Settings → API → Personal API keys → New API key.", link: "https://linear.app/settings/api", example: "lin_api_…" },
  todoist: { where: "Todoist → Settings → Integrations → Developer → API token.", link: "https://app.todoist.com/app/settings/integrations/developer" },
  asana: { where: "Asana developer console → Personal access tokens → Create new token.", link: "https://app.asana.com/0/my-apps" },
  clickup: { where: "ClickUp → avatar → Settings → Apps → API Token → Generate.", example: "pk_…" },
  "monday.com": { where: "monday.com → avatar → Developers → My access tokens → Show." },
  shopify: {
    where: "Shopify admin → Settings → Apps and sales channels → Develop apps → Create an app → set Admin API scopes → Install app → Admin API access token (shown once).",
    example: "shpat_…",
  },
  wordpress: { where: "WordPress admin → Users → Profile → Application Passwords → Add New. Use it with your username, not your login password." },
  zendesk: { where: "Zendesk Admin Center → Apps and integrations → APIs → Zendesk API → Add API token." },
  pipedrive: { where: "Pipedrive → avatar → Personal preferences → API → Your personal API token." },
  mastodon: { where: "Your instance → Preferences → Development → New application → open it and copy Your access token." },
  sentry: { where: "Sentry → Settings → Auth Tokens → Create New Token.", link: "https://sentry.io/settings/account/api/auth-tokens/" },
  vercel: { where: "Vercel → Account Settings → Tokens → Create.", link: "https://vercel.com/account/tokens" },
  netlify: { where: "Netlify → User settings → Applications → Personal access tokens → New access token.", link: "https://app.netlify.com/user/applications" },
  cloudflare: { where: "Cloudflare → My Profile → API Tokens → Create Token.", link: "https://dash.cloudflare.com/profile/api-tokens" },
  pagerduty: { where: "PagerDuty → your service → Integrations → Add integration → Events API v2 → Integration Key." },
  whatsapp: {
    where: "Meta developer portal → your app → WhatsApp → API Setup shows a 24-hour token. For a permanent one, create a System User in Business Settings and generate its token.",
    link: "https://developers.facebook.com/apps",
  },
  pushover: { where: "pushover.net: your User Key is on the dashboard; the application token comes from Create an Application/API Token.", link: "https://pushover.net" },
  dropbox: { where: "Dropbox App Console → your app → Settings → Generated access token (short-lived).", link: "https://www.dropbox.com/developers/apps" },
  typeform: { where: "Typeform → Settings → Personal tokens → Generate a new token.", link: "https://admin.typeform.com/user/tokens" },
  calendly: { where: "Calendly → Integrations → API & Webhooks → Generate new token." },
  intercom: { where: "Intercom Developer Hub → your app → Configure → Authentication → Access token." },
  webflow: { where: "Webflow → Site settings → Apps & integrations → API access → Generate API token." },
  bitly: { where: "Bitly → Settings → API → Generate token." },
  "hugging face": { where: "Hugging Face → Settings → Access Tokens → Create new token.", link: "https://huggingface.co/settings/tokens", example: "hf_…" },
  cohere: { where: "Cohere dashboard → API keys.", link: "https://dashboard.cohere.com/api-keys" },
  perplexity: { where: "Perplexity → Settings → API → Generate API key.", link: "https://www.perplexity.ai/settings/api", example: "pplx-…" },
  elevenlabs: { where: "ElevenLabs → Developers → API Keys → Create API key.", link: "https://elevenlabs.io/app/settings/api-keys" },
  deepl: { where: "DeepL → Account → API Keys. Free keys end in :fx.", link: "https://www.deepl.com/your-account/keys" },
  pinecone: { where: "Pinecone console → API Keys → Create API key.", link: "https://app.pinecone.io" },
  groq: { where: "GroqCloud console → API Keys → Create API Key.", link: "https://console.groq.com/keys", example: "gsk_…" },
  "mistral ai": { where: "Mistral console → API Keys → Create new key.", link: "https://console.mistral.ai/api-keys" },
  openrouter: { where: "OpenRouter → Settings → Keys → Create Key.", link: "https://openrouter.ai/settings/keys", example: "sk-or-v1-…" },
  deepseek: { where: "DeepSeek platform → API keys → Create new API key.", link: "https://platform.deepseek.com/api_keys", example: "sk-…" },
  "together ai": { where: "Together AI → Settings → API keys.", link: "https://api.together.ai/settings/api-keys" },
  "xai grok": { where: "xAI console → API Keys → Create API key.", link: "https://console.x.ai", example: "xai-…" },
  tavily: { where: "Tavily dashboard → API Keys.", link: "https://app.tavily.com", example: "tvly-…" },
  "brave search": { where: "Brave Search API dashboard → API Keys.", link: "https://api-search.brave.com/app/keys" },
  serpapi: { where: "SerpApi → Your Account → Api Key.", link: "https://serpapi.com/manage-api-key" },
  exa: { where: "Exa dashboard → API Keys.", link: "https://dashboard.exa.ai/api-keys" },
  youtube: GOOGLE_KEY("YouTube Data API v3"),
  "google maps": GOOGLE_KEY("APIs your request uses (e.g. Geocoding API)"),
  "google translate": GOOGLE_KEY("Cloud Translation API"),
  google: GOOGLE_KEY("API this node calls"),
  "azure openai": { where: "Azure portal → your Azure OpenAI resource → Keys and Endpoint → KEY 1." },
};

// Families whose credentials come from the same place, matched by prefix.
const MS_SERVICES = new Set(["outlook 365", "sharepoint", "onedrive", "excel", "excel online", "word", "planner", "onenote", "microsoft to do", "power bi", "dynamics 365", "teams"]);

function credentialWhere(service: string, nodeName: string, label: string, display: string): Where | undefined {
  if (/api key/i.test(label) && /^google /.test(service)) return GOOGLE_KEY(`${display} API`);
  if (CREDENTIALS[service]) return CREDENTIALS[service];
  // hand-written nodes are named "Telegram Bot", not "Telegram — …"
  const byName = Object.keys(CREDENTIALS)
    .filter((k) => nodeName === k || nodeName.startsWith(k + " "))
    .sort((a, b) => b.length - a.length)[0];
  if (byName) return CREDENTIALS[byName];
  if (/^(aws|amazon)\b/.test(service) || ["s3", "dynamodb", "minio"].includes(service)) return AWS;
  if (MS_SERVICES.has(service)) return MS_GRAPH;
  if (service.startsWith("google") || service.startsWith("gmail") || service.startsWith("firebase")) return GOOGLE_TOKEN;
  return undefined;
}

// ---- where IDs and names live ----
// Chosen by key. `svc` narrows an entry to the services it is true for.
interface KeyWhere {
  where: string;
  text?: string;
  example?: string;
  svc?: RegExp;
}

const KEY_WHERE: Record<string, KeyWhere[]> = {
  owner: [{ where: "The user or organisation in the repository URL: github.com/<owner>/<repo>.", example: "octocat" }],
  repo: [{ where: "The repository name — the part after the owner in the URL: github.com/<owner>/<repo>.", example: "hello-world" }],
  spreadsheetId: [{ where: "In the sheet's address: docs.google.com/spreadsheets/d/<this part>/edit.", example: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms" }],
  sheetName: [{ where: "The tab name at the bottom of the spreadsheet.", example: "Sheet1" }],
  range: [{ where: "Sheet tab plus cells in A1 notation. Leave the end row open to read everything.", example: "Sheet1!A1:D", svc: /sheets/ }],
  documentId: [{ where: "In the document's address: docs.google.com/document/d/<this part>/edit.", svc: /google/ }],
  presentationId: [{ where: "In the presentation's address: docs.google.com/presentation/d/<this part>/edit." }],
  formId: [{ where: "In the form's edit address: docs.google.com/forms/d/<this part>/edit.", svc: /google/ }],
  folderId: [
    { where: "Open the folder in Drive: drive.google.com/drive/folders/<this part>. Empty means My Drive.", svc: /google drive/ },
  ],
  fileId: [{ where: "Drive → the file → Share → Copy link: drive.google.com/file/d/<this part>/view.", svc: /google drive/ }],
  calendarId: [
    { where: "Google Calendar → Settings → your calendar → Integrate calendar → Calendar ID. primary is your main calendar.", example: "primary", svc: /google/ },
  ],
  parentDatabaseId: [
    { where: "Open the database as a full page; the 32-character ID sits in the URL before ?v=. Share it with your integration (••• → Connections) too." },
  ],
  databaseId: [
    { where: "Open the database as a full page; the 32-character ID sits in the URL before ?v=. Share it with your integration (••• → Connections) too.", svc: /notion/ },
  ],
  pageId: [{ where: "The last 32 characters of the page's URL. The integration needs access to the page (••• → Connections).", svc: /notion/ }],
  baseId: [{ where: "In the base's address: airtable.com/<app…>/… — it starts with app.", example: "appXXXXXXXXXXXXXX" }],
  tableId: [{ where: "The table's name as shown on its tab, or its tbl… ID from the address bar.", svc: /airtable/ }],
  tableName: [{ where: "The table's name as shown on its tab, or its tbl… ID from the address bar.", svc: /airtable/ }],
  chatId: [
    {
      where: "Send your bot a message, then open api.telegram.org/bot<token>/getUpdates — the number under message.chat.id. Group IDs are negative.",
      svc: /telegram/,
    },
  ],
  channel: [
    { where: "#channel-name, or the ID from the channel's name → About (bottom). Invite the bot first: /invite @yourbot.", example: "#general", svc: /slack/ },
  ],
  channelId: [
    { where: "Discord: turn on User settings → Advanced → Developer Mode, then right-click the channel → Copy Channel ID.", svc: /discord/ },
    { where: "#channel-name, or the ID from the channel's name → About (bottom). Invite the bot first: /invite @yourbot.", svc: /slack/ },
  ],
  projectKey: [{ where: "The letters in front of every issue number — PROJ in PROJ-123.", example: "PROJ" }],
  region: [{ where: "Shown at the top right of the AWS console, next to your account name.", example: "eu-central-1", svc: /^(aws|amazon|s3|dynamodb)/ }],
  accessKey: [{ where: AWS.where, example: "AKIA…" }],
  host: [{ where: "Your provider's connection details page, e.g. Supabase → Connect, Neon → Connection details, or your mail provider's IMAP/SMTP help page." }],
  database: [{ where: "The database name from your provider's connection details (often postgres by default)." }],
};

// ---- per-key text ----
// Short, practical descriptions for keys that recur across many nodes.
const KEY_HELP: Record<string, { text: string; example?: string }> = {
  storeIn: { text: "The name this node's result is saved under. Later steps read it as {{name}}, e.g. {{data.id}}.", example: "data" },
  outputField: { text: "The name this node's result is saved under. Later steps read it as {{name}}.", example: "answer" },
  url: { text: "Full address, including https://. Drag a field from INPUT to use an address from an earlier step.", example: "https://api.example.com/v1/items" },
  to: { text: "Recipient. Several are separated by commas; drag an e-mail field from INPUT to send to each incoming person.", example: "someone@example.com" },
  cc: { text: "Addresses to copy, separated by commas.", example: "team@example.com, ops@example.com" },
  bcc: { text: "Addresses to blind-copy, separated by commas.", example: "archive@example.com" },
  topic: { text: "Anyone who knows the topic can read it — pick something hard to guess.", example: "wflow-alerts-7f3k" },
  port: { text: "Leave empty for the usual port of this protocol.", example: "993" },
  folder: { text: "Mailbox or folder name exactly as your mail provider shows it.", example: "INBOX" },
  timeout: { text: "How long to wait for an answer before the node fails.", example: "30" },
  timeoutMinutes: { text: "How long the run waits for an answer before giving up, in minutes. 0 waits forever.", example: "15" },
  model: { text: "The model name exactly as the provider lists it in its docs or dashboard.", example: "gpt-4o-mini" },
  systemPrompt: { text: "Standing instructions for every call: role, tone, rules, output format.", example: "You are a terse support agent. Answer in one paragraph." },
  prompt: { text: "What the model should do with this item. Drag fields from INPUT to include their values.", example: "Summarise: {{text}}" },
  temperature: { text: "0 gives the same answer every time; around 1 is more varied. Use 0–0.3 for extraction and classification.", example: "0.2" },
  maxTokens: { text: "Caps the length of the answer (roughly ¾ of a word per token) and so the cost.", example: "500" },
  sql: { text: "Named parameters are bound safely from the params field — don't paste values into the SQL.", example: "SELECT * FROM users WHERE id = :id" },
  cron: { text: "minute hour day-of-month month weekday. crontab.guru explains any expression.", example: "0 9 * * 1-5" },
  timezone: { text: "IANA zone name the times are read in.", example: "Europe/Berlin" },
  timeZone: { text: "IANA zone name the times are read in.", example: "Europe/Berlin" },
  start: { text: "ISO date and time; add the offset or Z so the time zone is clear.", example: "2026-10-01T09:00:00+02:00" },
  end: { text: "ISO date and time; add the offset or Z so the time zone is clear.", example: "2026-10-01T10:00:00+02:00" },
  field: { text: "Name of a field in the incoming data. Open INPUT and drag the field here instead of typing it.", example: "body.message" },
  sourceField: { text: "Name of a field in the incoming data. Open INPUT and drag the field here instead of typing it.", example: "text" },
  amount: { text: "Most payment APIs expect the smallest unit — 10.00 EUR is 1000.", example: "1000" },
  currency: { text: "Three-letter ISO code.", example: "EUR" },
};

/** Common keys are matched case-insensitively and without separators. */
function keyIndex(key: string) {
  return key.toLowerCase().replace(/[_-]/g, "");
}

const INDEXED_KEY_HELP = Object.fromEntries(Object.entries(KEY_HELP).map(([k, v]) => [keyIndex(k), v]));
const INDEXED_KEY_WHERE = Object.fromEntries(Object.entries(KEY_WHERE).map(([k, v]) => [keyIndex(k), v]));

// Sentences the catalog stamps on hundreds of fields. They say nothing a user
// can act on, so the field is described as if it had no help of its own.
const BOILERPLATE = [
  /^Supports \{\{vars\}\} from the incoming item\.$/,
  /^Only needed when no .+ account is connected above\.$/,
  /^Override the service's API base/,
  /^Relative to the base URL\./,
];

const CREDENTIAL_KEYS = new Set(["token", "apikey", "accesstoken", "bearertoken", "servertoken", "authkey", "authtoken", "secretkey", "apptoken", "bottoken", "apppassword"]);

function serviceOf(node?: ParamNode) {
  const name = node?.name || "";
  return name.includes(" — ") ? name.split(" — ")[0].trim() : "";
}

// Generated service nodes (shared/services.js buildAction) carry a prefilled
// request; they are the only ones whose base URL has this help.
function isServiceNode(node?: ParamNode) {
  return !!node?.fields?.some((f) => f.key === "baseUrl" && /^Override the service's API base/.test(f.help || ""));
}

function isCredential(field: FieldDef) {
  return field.type === "secret" || CREDENTIAL_KEYS.has(keyIndex(field.key || ""));
}

function describeCredential(field: FieldDef, node: ParamNode | undefined, service: string): ParamDescription | null {
  const svc = service.toLowerCase();
  const found = credentialWhere(svc, (node?.name || "").toLowerCase(), field.label || "", service);
  const oauth = node?.fields?.find((f) => f.type === "oauth");
  const connect = oauth ? `Easier: press “Connect ${oauth.providerLabel}” above and leave this empty.` : "";
  // Webhook secrets, private keys and the like are the user's own choice, not
  // something a settings page hands out — only describe issued credentials.
  if (/webhook secret|private key|password$/i.test(field.label) && !found) return null;
  if (found) {
    return {
      text: connect,
      where: found.where,
      link: found.link,
      example: found.example,
    };
  }
  if (!service) return null;
  return {
    text: connect,
    where: `In your ${service} account, usually under Settings → API, Developers or Integrations. ${service}'s API documentation names the exact page.`,
  };
}

function describeRequestField(key: string, service: string): ParamDescription | null {
  const svc = service || "the service";
  switch (key) {
    case "baseUrl":
      return { text: `Prefilled for ${svc}. Change it only for a proxy, a self-hosted server or another region.` };
    case "path":
      return { text: `Prefilled with the endpoint this node calls. Swap in a different endpoint from ${svc}'s API reference to do something else; {{field}} placeholders work.` };
    case "method":
      return { text: `Prefilled for this endpoint — ${svc}'s API reference says which method each endpoint expects.` };
    case "query":
      return { text: `Added to the address as ?name=value. ${svc}'s API reference lists the names this endpoint accepts.`, example: '{"limit": 20}' };
    case "headers":
      return { text: "Only needed for headers the service asks for beyond authentication — the credential is added for you.", example: '{"X-Custom-Header": "value"}' };
    case "body":
      return { text: "Prefilled with what the service expects. Replace the {{placeholders}} with fields dragged from INPUT, or with fixed text." };
    default:
      return null;
  }
}

function describeGenericId(field: FieldDef, service: string): ParamDescription | null {
  if (!/(Id|ID|_id)$/.test(field.key || "") && !/\bID\b/.test(field.label || "")) return null;
  const where = service
    ? `Open the item in ${service}: the ID is usually in the browser's address bar, or in the item's settings or share menu.`
    : "Usually in the address bar when you open the item, or in its settings or share menu.";
  return { text: "", where };
}

/**
 * Everything the "?" tooltip needs for one parameter, or null when there is
 * nothing more useful to say than the label and control already do.
 */
export function describeParam(field: FieldDef, node?: ParamNode): ParamDescription | null {
  if (field.type === "note" || field.type === "oauth" || field.type === "telegramBot" || field.type === "telegramAccount") return field.type !== "note" && field.help ? { text: field.help } : null;

  const key = field.key || "";
  const ki = keyIndex(key);
  const service = serviceOf(node);
  const svc = service.toLowerCase();
  // svc narrows KEY_WHERE entries; the full name also catches "Telegram Bot"
  const scope = `${svc} ${(node?.name || "").toLowerCase()}`;
  const ownHelp = field.help && !BOILERPLATE.some((re) => re.test(field.help!)) ? field.help : "";

  if (isCredential(field)) {
    const cred = describeCredential(field, node, service);
    if (!ownHelp) return cred;
    return { text: ownHelp, where: cred?.where, link: cred?.link, example: field.example || cred?.example };
  }

  const whereEntry = (INDEXED_KEY_WHERE[ki] || []).find((w) => !w.svc || w.svc.test(scope));
  const known = INDEXED_KEY_HELP[ki];
  const example = field.example || field.placeholder || whereEntry?.example || known?.example || undefined;

  if (ownHelp) return { text: ownHelp, example };
  if (whereEntry) return { text: whereEntry.text || "", where: whereEntry.where, example };
  if (known) return { text: known.text, example };

  if (["baseUrl", "path", "method", "query", "headers", "body"].includes(key) && isServiceNode(node)) {
    const req = describeRequestField(key, service);
    if (req) return req;
  }

  const id = describeGenericId(field, service);
  if (id) return { ...id, example };

  switch (field.type) {
    case "json":
      return { text: "Must be valid JSON. Put {{field}} placeholders inside strings to insert data from earlier steps.", example: example || '{"name": "{{name}}"}' };
    case "code":
      return { text: "The incoming item is available as $json — e.g. {{ $json.field }}.", example: example || "{{ $json.total }} > 100" };
    default:
      // plain text, selects, toggles, numbers: the label and the INPUT
      // panel's drag hint already say it all
      return null;
  }
}
