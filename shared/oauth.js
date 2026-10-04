// ============================================================================
// Connected accounts — which nodes sign in with "Connect <service>" instead of
// asking for a password, an API key or a hand-copied access token.
//
// Pasted OAuth tokens often expire within hours, and a mailbox password or a
// personal API key hands W flow the whole account. With a connection the user
// clicks through the service's own consent screen once; the server keeps the
// token (and refresh token) encrypted and hands each run a valid access token.
//
// Shared by the catalog (adds the account picker to each node), the server
// (scopes to request, token injection — server/oauth-connections.js holds the
// endpoints) and the UI (the picker) and the admin panel (setup notes).
// ============================================================================

export const OAUTH_FIELD_KEY = "oauthAccount";

// label       — shown on the button ("Connect GitHub") and in the picker
// baseScopes  — asked for on every connection (identity, offline access)
// console     — where the operator registers the OAuth app
// setup       — one-line hint for the admin panel
export const OAUTH_PROVIDERS = {
  google: {
    label: "Google",
    baseScopes: ["openid", "email", "profile"],
    console: "https://console.cloud.google.com/auth/clients",
    setup: "Uses the Google login client. Add the connect redirect URI to it and enable the APIs (Gmail, Drive, Sheets, …).",
  },
  microsoft: {
    label: "Microsoft",
    baseScopes: ["openid", "email", "profile", "offline_access", "User.Read"],
    console: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    setup: "Entra → App registrations → New registration (any organisation + personal accounts), Web redirect URI, then Certificates & secrets.",
  },
  github: {
    label: "GitHub",
    baseScopes: [],
    console: "https://github.com/settings/developers",
    setup: "Uses the GitHub login OAuth app. Its Authorization callback URL must be exactly <your site>/api/auth/oauth/github/callback — login and Connect GitHub both return there.",
  },
  gitlab: {
    label: "GitLab",
    baseScopes: ["read_user"],
    console: "https://gitlab.com/-/user_settings/applications",
    setup: "User settings → Applications → Add new application, confidential, scopes api + read_user.",
  },
  slack: {
    label: "Slack",
    baseScopes: [],
    console: "https://api.slack.com/apps",
    setup: "Create New App → OAuth & Permissions: add the redirect URL, the bot scopes chat:write, chat:write.public, users:read, users:read.email, and the user scope chat:write (for \"Send as: me\"). Enable public distribution for other workspaces.",
  },
  notion: {
    label: "Notion",
    baseScopes: [],
    console: "https://www.notion.so/profile/integrations",
    setup: "New integration → type Public → add the redirect URI; copy the OAuth client ID and secret.",
  },
  dropbox: {
    label: "Dropbox",
    baseScopes: ["account_info.read"],
    console: "https://www.dropbox.com/developers/apps",
    setup: "Create app (Scoped access, Full Dropbox) → Permissions: files.content.write, account_info.read → add the redirect URI.",
  },
  hubspot: {
    label: "HubSpot",
    baseScopes: ["oauth"],
    console: "https://developers.hubspot.com/",
    setup: "Developer account → Apps → Create app → Auth: redirect URL and scopes crm.objects.contacts.read/write.",
  },
  airtable: {
    label: "Airtable",
    baseScopes: ["user.email:read"],
    console: "https://airtable.com/create/oauth",
    setup: "Register an OAuth integration with the redirect URI and scopes data.records:read, data.records:write, user.email:read; generate a client secret.",
  },
  asana: {
    label: "Asana",
    baseScopes: [],
    console: "https://app.asana.com/0/my-apps",
    setup: "My apps → Create new app → OAuth: add the redirect URL; enable “Full permissions”.",
  },
  linear: {
    label: "Linear",
    baseScopes: ["read"],
    console: "https://linear.app/settings/api/applications/new",
    setup: "Settings → API → OAuth applications → New, with the callback URL; enable public if other workspaces should connect.",
  },
  todoist: {
    label: "Todoist",
    baseScopes: [],
    console: "https://developer.todoist.com/appconsole.html",
    setup: "App Management → Create a new app → set the OAuth redirect URL.",
  },
  zoom: {
    label: "Zoom",
    baseScopes: [],
    console: "https://marketplace.zoom.us/develop/create",
    setup: "Develop → Build App → General App (user-managed) → redirect URL + scope meeting:write:meeting.",
  },
  linkedin: {
    label: "LinkedIn",
    baseScopes: ["openid", "profile", "email"],
    console: "https://www.linkedin.com/developers/apps",
    setup: "Create app → Products: “Sign In with LinkedIn using OpenID Connect” and “Share on LinkedIn” → Auth: redirect URL.",
  },
  x: {
    label: "X (Twitter)",
    baseScopes: ["users.read", "offline.access"],
    console: "https://developer.x.com/en/portal/dashboard",
    setup: "Project → App → User authentication settings: OAuth 2.0, type Web App (confidential), callback URL, read + write.",
  },
  box: {
    label: "Box",
    baseScopes: [],
    console: "https://app.box.com/developers/console",
    setup: "Create Platform App → Custom App → User Authentication (OAuth 2.0) → redirect URI, scope “Write all files”.",
  },
  calendly: {
    label: "Calendly",
    baseScopes: [],
    console: "https://developer.calendly.com/",
    setup: "Developer portal → Create new app (web) → redirect URI.",
  },
  typeform: {
    label: "Typeform",
    baseScopes: ["accounts:read", "offline"],
    console: "https://admin.typeform.com/account#/section/apps",
    setup: "Account → Developer apps → Register a new app → redirect URI.",
  },
  webflow: {
    label: "Webflow",
    baseScopes: ["authorized_user:read"],
    console: "https://developers.webflow.com/data/docs/register-an-app",
    setup: "Workspace settings → Apps & Integrations → Develop → Create an App → Data client with the redirect URI and CMS read/write.",
  },
  pinterest: {
    label: "Pinterest",
    baseScopes: ["user_accounts:read"],
    console: "https://developers.pinterest.com/apps/",
    setup: "Connect app → redirect URI; request standard access for pins:write.",
  },
  intercom: {
    label: "Intercom",
    baseScopes: [],
    console: "https://app.intercom.com/a/apps/_/developer-hub",
    setup: "Developer Hub → New app → Authentication: enable OAuth, add the redirect URL.",
  },
  salesforce: {
    label: "Salesforce",
    baseScopes: ["refresh_token", "id"],
    console: "https://login.salesforce.com/lightning/setup/ConnectedApplication/home",
    setup: "Setup → App Manager → New Connected App → Enable OAuth, callback URL, scopes api + refresh_token + openid.",
  },
  surveymonkey: {
    label: "SurveyMonkey",
    baseScopes: [],
    console: "https://developer.surveymonkey.com/apps/",
    setup: "Add a new app (public) → OAuth redirect URL → scopes View Surveys + View Responses.",
  },
  xero: {
    label: "Xero",
    baseScopes: ["openid", "profile", "email", "offline_access"],
    console: "https://developer.xero.com/app/manage",
    setup: "New app → Web app → redirect URI. Nodes still need the organisation's xero-tenant-id header.",
  },
  quickbooks: {
    label: "QuickBooks",
    baseScopes: ["openid", "email"],
    console: "https://developer.intuit.com/app/developer/dashboard",
    setup: "Create an app (QuickBooks Online Accounting) → Keys & credentials → redirect URI. The company id (realmId) is shown on the connection.",
  },
};

const G = "https://www.googleapis.com/auth/";
const GOOGLE = {
  gmailRead: [`${G}gmail.readonly`],
  gmailSend: [`${G}gmail.send`],
  gmailCompose: [`${G}gmail.compose`],
  gmailModify: [`${G}gmail.modify`],
  calendar: [`${G}calendar.events`],
  drive: [`${G}drive`],
  sheets: [`${G}spreadsheets`],
  docs: [`${G}documents`],
  slides: [`${G}presentations`],
  forms: [`${G}forms.body.readonly`],
  contacts: [`${G}contacts`],
  tasks: [`${G}tasks`],
  chat: [`${G}chat.messages.create`],
  bigquery: [`${G}bigquery`],
  storage: [`${G}devstorage.read_write`],
  analytics: [`${G}analytics.readonly`],
  business: [`${G}business.manage`],
  datastore: [`${G}datastore`],
  pubsub: [`${G}pubsub`],
};

// The Google scopes the cloud's OAuth client is verified for — kept in exact
// step with the Cloud Console's Data Access list. Google's review rejects an
// app whose consent screen asks for anything not on that list, and the Gmail
// read/modify/compose scopes are "restricted" (a yearly security assessment),
// so the cloud only ever asks for these. Self-hosted copies register their own
// client and may use every Google node (allScopes below).
export const GOOGLE_VERIFIED_SCOPES = Object.freeze([
  `${G}gmail.send`,
  `${G}spreadsheets`,
  `${G}documents`,
  `${G}calendar.events`,
]);

const MS = {
  mailSend: ["Mail.Send"],
  calendar: ["Calendars.ReadWrite"],
  files: ["Files.ReadWrite"],
  sites: ["Sites.ReadWrite.All"],
  tasks: ["Tasks.ReadWrite"],
  notes: ["Notes.ReadWrite"],
};

// node type → provider + scopes. Fields:
//   credField — the hand-entered credential the picker sits above and the
//               connection's token is injected into (default `token`)
//   prefix    — text put before the token (Linear's handler sends the key
//               as the whole Authorization header)
//   bearer    — the node normally authenticates differently (GitLab's
//               PRIVATE-TOKEN header); with a connection it sends Bearer
// Left out on purpose: services whose API address depends on the account
// (Pipedrive, Mailchimp, Zoho, Jira/Confluence, Shopify, DocuSign), OAuth 1
// (Trello), non-standard refresh (Basecamp), and API-key-only services.
export const OAUTH_NODES = {
  gmailSend: { provider: "google", scopes: GOOGLE.gmailSend },
  gmailCreateDraft: { provider: "google", scopes: GOOGLE.gmailCompose },
  gmailListMessages: { provider: "google", scopes: GOOGLE.gmailRead },
  gmailGetMessage: { provider: "google", scopes: GOOGLE.gmailRead },
  gmailModifyMessage: { provider: "google", scopes: GOOGLE.gmailModify },
  googleCalendar: { provider: "google", scopes: GOOGLE.calendar },
  googleCalendarListEvents: { provider: "google", scopes: GOOGLE.calendar },
  googleDriveUpload: { provider: "google", scopes: GOOGLE.drive },
  googleDriveList: { provider: "google", scopes: GOOGLE.drive },
  googleDriveCopyFile: { provider: "google", scopes: GOOGLE.drive },
  googleDriveCreateFolder: { provider: "google", scopes: GOOGLE.drive },
  googleDriveDownloadFile: { provider: "google", scopes: GOOGLE.drive },
  googleDriveMoveFile: { provider: "google", scopes: GOOGLE.drive },
  googleSheetsRead: { provider: "google", scopes: GOOGLE.sheets, credField: "apiKey", inject: "token" },
  sheetsTrigger: { provider: "google", scopes: GOOGLE.sheets, credField: "apiKey", inject: "token" },
  googleSheetsAppend: { provider: "google", scopes: GOOGLE.sheets, credField: "apiKey", inject: "token" },
  sheetsUpdate: { provider: "google", scopes: GOOGLE.sheets, credField: "apiKey", inject: "token" },
  googleDocsCreate: { provider: "google", scopes: GOOGLE.docs },
  googleDocsAppend: { provider: "google", scopes: GOOGLE.docs },
  googleSlidesCreate: { provider: "google", scopes: GOOGLE.slides },
  googleFormsGet: { provider: "google", scopes: GOOGLE.forms },
  googleContactsCreate: { provider: "google", scopes: GOOGLE.contacts },
  googleTasksCreate: { provider: "google", scopes: GOOGLE.tasks },
  googleChatSend: { provider: "google", scopes: GOOGLE.chat },
  bigqueryQuery: { provider: "google", scopes: GOOGLE.bigquery },
  gcsUpload: { provider: "google", scopes: GOOGLE.storage },
  googleAnalyticsReport: { provider: "google", scopes: GOOGLE.analytics },
  googleBusinessPost: { provider: "google", scopes: GOOGLE.business },
  firestoreSet: { provider: "google", scopes: GOOGLE.datastore },
  pubsubPublish: { provider: "google", scopes: GOOGLE.pubsub },

  outlookSend: { provider: "microsoft", scopes: MS.mailSend },
  m365Calendar: { provider: "microsoft", scopes: MS.calendar },
  onedriveUpload: { provider: "microsoft", scopes: MS.files },
  excelCreate: { provider: "microsoft", scopes: MS.files },
  excelAddRow: { provider: "microsoft", scopes: MS.files },
  wordCreate: { provider: "microsoft", scopes: MS.files },
  sharepointUpload: { provider: "microsoft", scopes: MS.sites },
  sharepointListItem: { provider: "microsoft", scopes: MS.sites },
  plannerTask: { provider: "microsoft", scopes: MS.tasks },
  msTodoCreate: { provider: "microsoft", scopes: MS.tasks },
  oneNoteCreate: { provider: "microsoft", scopes: MS.notes },

  githubIssue: { provider: "github", scopes: ["repo"] },
  githubCreatePr: { provider: "github", scopes: ["repo"] },
  githubCreateRelease: { provider: "github", scopes: ["repo"] },
  githubCommentIssue: { provider: "github", scopes: ["repo"] },
  githubListIssues: { provider: "github", scopes: ["repo"] },
  githubGetRepository: { provider: "github", scopes: ["repo"] },
  githubListCommits: { provider: "github", scopes: ["repo"] },
  githubCreateBranch: { provider: "github", scopes: ["repo"] },
  githubMergePullRequest: { provider: "github", scopes: ["repo"] },
  githubTriggerWorkflow: { provider: "github", scopes: ["repo"] },

  gitlabIssue: { provider: "gitlab", scopes: ["api"], bearer: true },
  gitlabCreateMergeRequest: { provider: "gitlab", scopes: ["api"], bearer: true },
  gitlabTriggerPipeline: { provider: "gitlab", scopes: ["api"], bearer: true },

  // asUser: the node offers "Send as: bot / me" (the Slack user token)
  slackBotSend: { provider: "slack", scopes: ["chat:write", "chat:write.public"], asUser: true },
  slackUpdateMessage: { provider: "slack", scopes: ["chat:write"], asUser: true },
  slackLookupUser: { provider: "slack", scopes: ["users:read", "users:read.email"] },

  notionPage: { provider: "notion", scopes: [] },
  notionQueryDb: { provider: "notion", scopes: [] },
  notionUpdatePage: { provider: "notion", scopes: [] },
  notionGetPage: { provider: "notion", scopes: [] },
  notionAppendBlocks: { provider: "notion", scopes: [] },
  notionArchivePage: { provider: "notion", scopes: [] },

  dropboxUpload: { provider: "dropbox", scopes: ["files.content.write"] },

  hubspotContact: { provider: "hubspot", scopes: ["crm.objects.contacts.write"], credField: "apiKey" },

  airtableRow: { provider: "airtable", scopes: ["data.records:write"], credField: "apiKey" },
  airtableRead: { provider: "airtable", scopes: ["data.records:read"], credField: "apiKey" },
  airtableUpdate: { provider: "airtable", scopes: ["data.records:write"], credField: "apiKey" },
  airtableDelete: { provider: "airtable", scopes: ["data.records:write"], credField: "apiKey" },

  asanaTask: { provider: "asana", scopes: [] },
  linearIssue: { provider: "linear", scopes: ["write"], credField: "apiKey", prefix: "Bearer " },
  todoistTask: { provider: "todoist", scopes: ["data:read_write"] },
  zoomMeeting: { provider: "zoom", scopes: [] },
  linkedinPost: { provider: "linkedin", scopes: ["w_member_social"] },
  twitterPost: { provider: "x", scopes: ["tweet.read", "tweet.write"], credField: "bearerToken" },
  boxUpload: { provider: "box", scopes: [] },
  calendlyEvent: { provider: "calendly", scopes: [] },
  typeformResponses: { provider: "typeform", scopes: ["forms:read", "responses:read"] },
  webflowItem: { provider: "webflow", scopes: ["cms:read", "cms:write"] },
  pinterestPin: { provider: "pinterest", scopes: ["boards:read", "pins:read", "pins:write"] },
  intercomMessage: { provider: "intercom", scopes: [] },
  salesforceContact: { provider: "salesforce", scopes: ["api"] },
  surveymonkeyResponses: { provider: "surveymonkey", scopes: [] },
  xeroInvoice: { provider: "xero", scopes: ["accounting.transactions"] },
  quickbooksInvoice: { provider: "quickbooks", scopes: ["com.intuit.quickbooks.accounting"] },
};

export function oauthSpecFor(type) {
  return OAUTH_NODES[type] || null;
}

/** Every scope a connection for `spec` must hold, base scopes included. */
export function scopesFor(spec) {
  const base = OAUTH_PROVIDERS[spec?.provider]?.baseScopes || [];
  return [...new Set([...base, ...(spec?.scopes || [])])];
}

// Scopes that only identify the user or keep the connection alive; services
// often leave them out of the granted list, so they never count as missing.
const IDENTITY_SCOPES = new Set(["openid", "email", "profile", "offline_access", "offline", "refresh_token", "id"]);

/**
 * Scopes from `needed` the connection was not granted. Case-insensitive
 * (Microsoft lowercases some) and tolerant of comma-separated lists (Slack,
 * GitHub, LinkedIn and Pinterest report scopes that way).
 */
export function missingScopes(granted, needed) {
  const raw = Array.isArray(granted) ? granted.join(" ") : String(granted || "");
  const have = new Set(raw.toLowerCase().split(/[\s,]+/).filter(Boolean));
  return (needed || []).filter((s) => !have.has(String(s).toLowerCase()) && !IDENTITY_SCOPES.has(String(s).toLowerCase()));
}

/**
 * Add the account picker to every node in OAUTH_NODES and demote its
 * credential field to an advanced fallback. Runs once while the catalog is
 * assembled.
 */
export function applyOAuthFields(nodes) {
  for (const [type, spec] of Object.entries(OAUTH_NODES)) {
    const def = nodes[type];
    if (!def) continue;
    const fields = def.fields || [];
    if (fields.some((f) => f.key === OAUTH_FIELD_KEY)) continue;
    const label = OAUTH_PROVIDERS[spec.provider].label;
    const tokenKey = spec.credField || "token";
    const tokenIdx = fields.findIndex((f) => f.key === tokenKey);
    const section = tokenIdx >= 0 ? fields[tokenIdx].section : "Credentials";
    const picker = {
      key: OAUTH_FIELD_KEY,
      label: `${label} account`,
      type: "oauth",
      provider: spec.provider,
      providerLabel: label,
      scopes: spec.scopes,
      ...(section ? { section } : {}),
      help: `Press “Connect ${label}” and approve access once — W flow keeps the connection encrypted and renews it, no token to copy. Button greyed out? Sorry, connecting ${label} isn't available yet.`,
    };
    const next = [...fields];
    if (tokenIdx >= 0) {
      const original = next[tokenIdx];
      next[tokenIdx] = {
        ...original,
        label: `${original.label} (advanced — instead of connecting)`,
        optional: true,
        help: `Only needed when no ${label} account is connected above.`,
        // While the operator has not set the service up, the editor hides the
        // picker and puts this field back the way the node defined it.
        oauthFallback: {
          provider: spec.provider,
          label: original.label,
          optional: !!original.optional,
          ...(original.help ? { help: original.help } : {}),
        },
      };
      next.splice(tokenIdx, 0, picker);
    } else {
      next.push(picker);
    }
    // Post as the workspace bot or as the person who connected the account.
    if (spec.asUser) {
      next.splice(next.indexOf(picker) + 1, 0, {
        key: "sendAs",
        label: "Send as",
        // "Me" needs a connected account, so it goes away with the picker.
        oauthOnly: spec.provider,
        type: "select",
        options: [
          { value: "bot", label: "The bot" },
          { value: "me", label: "Me (my own account)" },
        ],
        ...(section ? { section } : {}),
        help: `“Me” posts under your own ${label} name and picture instead of the bot's. It needs a connected account — accounts connected before this option existed need one Reconnect.`,
      });
    }
    def.fields = next;
    def.defaults = { ...def.defaults, [OAUTH_FIELD_KEY]: "", ...(spec.asUser ? { sendAs: "bot" } : {}) };
  }
}

/** Where the connection's token goes in the node config, and in what form. */
export function injectionFor(spec) {
  return { key: spec.inject || spec.credField || "token", prefix: spec.prefix || "", bearer: !!spec.bearer };
}

// ---- verified scopes ----

/**
 * Whether a node may connect an account on this instance. Only Google is
 * limited: without `allScopes` (the cloud) a Google node needs every one of its
 * scopes on GOOGLE_VERIFIED_SCOPES, otherwise it keeps its pasted-token field.
 */
export function connectAllowed(spec, { allScopes = false } = {}) {
  if (!spec) return false;
  if (allScopes || spec.provider !== "google") return true;
  return (spec.scopes || []).every((s) => GOOGLE_VERIFIED_SCOPES.includes(s));
}

/** Node types whose "Connect" button is switched off on this instance. */
export function unavailableConnectionNodes(opts) {
  return Object.entries(OAUTH_NODES)
    .filter(([, spec]) => !connectAllowed(spec, opts))
    .map(([type]) => type);
}

/**
 * Every scope any node of `provider` needs — used when an account is connected
 * from the Credentials page instead of from one node, so that one connection
 * then works for all of the service's nodes. Nodes switched off by
 * connectAllowed add nothing, so that consent screen never shows a scope the
 * cloud is not verified for.
 */
export function providerScopes(provider, opts) {
  const specs = Object.values(OAUTH_NODES).filter((s) => s.provider === provider && connectAllowed(s, opts));
  return [...new Set(specs.flatMap((s) => scopesFor(s)))];
}
