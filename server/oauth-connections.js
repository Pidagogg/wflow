// ============================================================================
// Connected accounts — "Connect Google / GitHub / Slack / …" for workflow nodes.
//
// The user signs in on the service's consent screen once; the token (and the
// refresh token, where the service issues one) is stored in the per-user
// credential vault (user_credentials, AES-256-GCM) with type "oauth:<id>",
// and every run asks for a valid access token. Nodes never see a password.
//
// Client ids and secrets are the operator's, from the admin panel (Auth &
// e-mail → Connected accounts) or <ID>_CLIENT_ID / <ID>_CLIENT_SECRET env
// vars. Google and GitHub share the login clients. Which nodes use which
// scopes lives in shared/oauth.js; the per-service protocol details live in
// PROTOCOLS below.
// ============================================================================
import crypto from "node:crypto";
import { db } from "./dbx.js";
import { credentialOwner, withPooledCredentials } from "./team-admin.js";
import { attachCode } from "../shared/errors.js";
import { OAUTH_PROVIDERS, missingScopes } from "../shared/oauth.js";
import { standaloneMode } from "./setup.js";

// ---- per-service protocol ----
// authUrl / tokenUrl — the OAuth 2.0 endpoints
// tokenAuth   "basic" sends the client id + secret as HTTP Basic auth (some
//             services require it), otherwise they go in the form body
// tokenJson   the token endpoint wants a JSON body (Notion)
// pkce        the service requires PKCE even for confidential clients
// sep         how scopes are joined in the authorize URL
// authParams  extra authorize parameters
// identity    (accessToken, tokenResponse) → { email, name, extra } for the picker

const json = async (url, token, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": "W-flow", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  return res.json().catch(() => ({}));
};

// The id_token's payload, for display only (it came straight from the token
// endpoint over TLS, so the signature is not what protects anything here).
function idTokenClaims(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken || "").split(".")[1] || "", "base64url").toString("utf8")) || {};
  } catch {
    return {};
  }
}

const PROTOCOLS = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // offline + consent: Google only hands out a refresh token on a fresh
    // consent, and without one the connection would die after an hour.
    authParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    identity: async (t) => {
      const i = await json("https://www.googleapis.com/oauth2/v3/userinfo", t);
      return { email: i.email, name: i.name };
    },
  },
  microsoft: {
    // tenant filled in by providerConfig()
    authUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    authParams: { prompt: "select_account" },
    // Microsoft issues the token for the scopes named on refresh
    refreshScope: true,
    identity: async (t) => {
      const i = await json("https://graph.microsoft.com/v1.0/me", t);
      return { email: i.mail || i.userPrincipalName, name: i.displayName };
    },
  },
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    sep: " ",
    identity: async (t) => {
      const i = await json("https://api.github.com/user", t);
      return { email: i.email || i.login, name: i.login };
    },
  },
  gitlab: {
    authUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    identity: async (t) => {
      const i = await json("https://gitlab.com/api/v4/user", t);
      return { email: i.email || i.username, name: i.username };
    },
  },
  slack: {
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    sep: ",",
    // Also ask for the signed-in person's own permission to post, so a node
    // can send "as me" instead of as the bot (the user token comes back in
    // authed_user next to the bot token).
    authParams: { user_scope: "chat:write" },
    userToken: (r) => ({ token: r.authed_user?.access_token || "", scope: r.authed_user?.scope || "" }),
    // the bot token belongs to the workspace, so the workspace names it
    identity: async (_t, r) => ({ email: r.team?.name ? `${r.team.name} (Slack workspace)` : "", name: r.team?.name }),
  },
  notion: {
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    authParams: { owner: "user" },
    tokenAuth: "basic",
    tokenJson: true,
    identity: async (_t, r) => ({
      email: r.owner?.user?.person?.email || r.workspace_name || "",
      name: r.workspace_name ? `${r.workspace_name} workspace` : "",
    }),
  },
  dropbox: {
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    authParams: { token_access_type: "offline" },
    identity: async (t) => {
      // this endpoint takes a POST with no body at all
      const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST", headers: { Authorization: `Bearer ${t}` } });
      const i = await res.json().catch(() => ({}));
      return { email: i.email, name: i.name?.display_name };
    },
  },
  hubspot: {
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    identity: async (t) => {
      const res = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(t)}`);
      const i = await res.json().catch(() => ({}));
      return { email: i.user, name: i.hub_domain };
    },
  },
  airtable: {
    authUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    tokenAuth: "basic",
    pkce: true,
    identity: async (t) => {
      const i = await json("https://api.airtable.com/v0/meta/whoami", t);
      return { email: i.email, name: i.email };
    },
  },
  asana: {
    authUrl: "https://app.asana.com/-/oauth_authorize",
    tokenUrl: "https://app.asana.com/-/oauth_token",
    identity: async (t, r) => {
      if (r.data?.email) return { email: r.data.email, name: r.data.name };
      const i = await json("https://app.asana.com/api/1.0/users/me", t);
      return { email: i.data?.email, name: i.data?.name };
    },
  },
  linear: {
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    sep: ",",
    authParams: { prompt: "consent" },
    identity: async (t) => {
      const i = await json("https://api.linear.app/graphql", t, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { email name } }" }),
      });
      return { email: i.data?.viewer?.email, name: i.data?.viewer?.name };
    },
  },
  todoist: {
    authUrl: "https://todoist.com/oauth/authorize",
    tokenUrl: "https://todoist.com/oauth/access_token",
    sep: ",",
    identity: async () => ({ email: "", name: "Todoist account" }),
  },
  zoom: {
    authUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    tokenAuth: "basic",
    identity: async (t) => {
      const i = await json("https://api.zoom.us/v2/users/me", t);
      return { email: i.email, name: [i.first_name, i.last_name].filter(Boolean).join(" ") };
    },
  },
  linkedin: {
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    identity: async (t) => {
      const i = await json("https://api.linkedin.com/v2/userinfo", t);
      // the member URN is what LinkedIn posts need as `author`
      return { email: i.email, name: i.name, extra: i.sub ? { memberUrn: `urn:li:person:${i.sub}` } : {} };
    },
  },
  x: {
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    tokenAuth: "basic",
    pkce: true,
    identity: async (t) => {
      const i = await json("https://api.x.com/2/users/me", t);
      return { email: i.data?.username ? `@${i.data.username}` : "", name: i.data?.name };
    },
  },
  box: {
    authUrl: "https://account.box.com/api/oauth2/authorize",
    tokenUrl: "https://api.box.com/oauth2/token",
    noScope: true,
    identity: async (t) => {
      const i = await json("https://api.box.com/2.0/users/me", t);
      return { email: i.login, name: i.name };
    },
  },
  calendly: {
    authUrl: "https://auth.calendly.com/oauth/authorize",
    tokenUrl: "https://auth.calendly.com/oauth/token",
    noScope: true,
    identity: async (t) => {
      const i = await json("https://api.calendly.com/users/me", t);
      return { email: i.resource?.email, name: i.resource?.name };
    },
  },
  typeform: {
    authUrl: "https://api.typeform.com/oauth/authorize",
    tokenUrl: "https://api.typeform.com/oauth/token",
    identity: async (t) => {
      const i = await json("https://api.typeform.com/me", t);
      return { email: i.email, name: i.alias };
    },
  },
  webflow: {
    authUrl: "https://webflow.com/oauth/authorize",
    tokenUrl: "https://api.webflow.com/oauth/access_token",
    identity: async (t) => {
      const i = await json("https://api.webflow.com/v2/token/authorized_by", t);
      return { email: i.email, name: [i.firstName, i.lastName].filter(Boolean).join(" ") };
    },
  },
  pinterest: {
    authUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    tokenAuth: "basic",
    sep: ",",
    identity: async (t) => {
      const i = await json("https://api.pinterest.com/v5/user_account", t);
      return { email: i.username, name: i.username };
    },
  },
  intercom: {
    authUrl: "https://app.intercom.com/oauth",
    tokenUrl: "https://api.intercom.io/auth/eagle/token",
    noScope: true,
    identity: async (t) => {
      const i = await json("https://api.intercom.io/me", t);
      return { email: i.email, name: i.app?.name || i.name };
    },
  },
  salesforce: {
    authUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    identity: async (t, r) => {
      const i = r.id ? await json(r.id, t) : {};
      // the org's API address — the Salesforce node's “Instance URL”
      return { email: i.email, name: i.display_name, extra: r.instance_url ? { instanceUrl: r.instance_url } : {} };
    },
  },
  surveymonkey: {
    authUrl: "https://api.surveymonkey.com/oauth/authorize",
    tokenUrl: "https://api.surveymonkey.com/oauth/token",
    noScope: true,
    identity: async (t) => {
      const i = await json("https://api.surveymonkey.com/v3/users/me", t);
      return { email: i.email, name: i.username };
    },
  },
  xero: {
    authUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    tokenAuth: "basic",
    identity: async (_t, r) => {
      const c = idTokenClaims(r.id_token);
      return { email: c.email, name: [c.given_name, c.family_name].filter(Boolean).join(" ") };
    },
  },
  quickbooks: {
    authUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    tokenAuth: "basic",
    identity: async (t, _r, query) => {
      const i = await json("https://accounts.platform.intuit.com/v1/openid_connect/userinfo", t);
      // the company id arrives on the callback URL, not in the token
      return { email: i.email, name: i.givenName, extra: query?.realmId ? { realmId: String(query.realmId) } : {} };
    },
  },
};

// ---- provider settings ----

/** Settings keys / env vars of a provider's OAuth client. */
export function clientSettingKeys(id) {
  const env = id.toUpperCase();
  return { idKey: `oauth.${id}.clientId`, secretKey: `oauth.${id}.clientSecret`, idEnv: `${env}_CLIENT_ID`, secretEnv: `${env}_CLIENT_SECRET` };
}

async function setting(key, envKey) {
  try {
    const stored = await db.storeGet(key);
    if (stored) return String(stored);
  } catch {
    /* store hiccup — fall back to env */
  }
  return String(process.env[envKey] || "");
}

async function microsoftTenant() {
  const t = (await setting("oauth.microsoft.tenant", "MICROSOFT_TENANT")).trim();
  // a tenant id or domain only — it is pasted into the authority URL
  return /^[A-Za-z0-9.-]{1,100}$/.test(t) ? t : "common";
}

export async function providerConfig(provider) {
  const proto = PROTOCOLS[provider];
  if (!proto || !OAUTH_PROVIDERS[provider]) return null;
  const k = clientSettingKeys(provider);
  const [id, secret] = await Promise.all([setting(k.idKey, k.idEnv), setting(k.secretKey, k.secretEnv)]);
  if (!id || !secret) return null;
  const tenant = provider === "microsoft" ? await microsoftTenant() : "";
  return {
    ...proto,
    id,
    secret,
    authUrl: proto.authUrl.replace("{tenant}", tenant),
    tokenUrl: proto.tokenUrl.replace("{tenant}", tenant),
  };
}

/** { google: bool, github: bool, … } — which "Connect" buttons can work. */
export async function connectionProviders() {
  const out = {};
  for (const name of Object.keys(OAUTH_PROVIDERS)) out[name] = !!(await providerConfig(name));
  return out;
}

/**
 * Options for connectAllowed (shared/oauth.js). The cloud asks Google only for
 * its verified scopes; a self-hosted copy uses its own OAuth client, and
 * GOOGLE_ALL_SCOPES=1 lifts the limit for an operator whose client is verified
 * (or in testing) for the rest.
 */
export function scopePolicy() {
  return { allScopes: standaloneMode() || /^(1|true|yes|on)$/i.test(String(process.env.GOOGLE_ALL_SCOPES || "").trim()) };
}

// ---- consent round trip ----

// state → who started it (and the PKCE verifier). Kept in memory: the round
// trip takes seconds and a restart in between only means clicking again.
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweep(now = Date.now()) {
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}

export function createState({ userId, provider, scopes }) {
  sweep();
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  pending.set(state, { userId: String(userId), provider, scopes, verifier, expires: Date.now() + STATE_TTL_MS });
  return state;
}

/** One use only; null when unknown, expired or started for another provider. */
export function takeState(state, provider) {
  sweep();
  const entry = pending.get(String(state || ""));
  if (!entry) return null;
  pending.delete(String(state));
  return entry.provider === provider ? entry : null;
}

/** Peek at a state without using it up (the authorize URL needs the verifier). */
function peekState(state) {
  return pending.get(String(state || "")) || null;
}

/** True when `state` was issued by a Connect flow (not the login flow) and is still pending. */
export function isConnectionState(state, provider) {
  const entry = peekState(state);
  return !!entry && entry.provider === provider && entry.expires > Date.now();
}

export function authorizeUrl(provider, cfg, { redirectUri, state, scopes }) {
  const url = new URL(cfg.authUrl);
  url.searchParams.set("client_id", cfg.id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  if (!cfg.noScope && scopes.length) url.searchParams.set("scope", scopes.join(cfg.sep || " "));
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(cfg.authParams || {})) url.searchParams.set(k, v);
  if (cfg.pkce) {
    const verifier = peekState(state)?.verifier || "";
    url.searchParams.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

async function tokenRequest(cfg, params) {
  const headers = { Accept: "application/json" };
  const body = { ...params };
  if (cfg.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.id}:${cfg.secret}`).toString("base64")}`;
    // PKCE services still want to know which client is asking
    if (cfg.pkce) body.client_id = cfg.id;
  } else {
    body.client_id = cfg.id;
    body.client_secret = cfg.secret;
  }
  let payload;
  if (cfg.tokenJson) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(body);
  }
  const res = await fetch(cfg.tokenUrl, { method: "POST", headers, body: payload });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    // a few services still answer the old form-encoded way
    data = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || !data.access_token || data.ok === false) {
    const reason = data.error_description || data.error || data.message || `HTTP ${res.status}`;
    const err = attachCode(new Error(String(reason)), "AUTH_FAILED");
    err.oauthError = data.error || "";
    throw err;
  }
  return data;
}

const expiryFrom = (data) => (Number(data.expires_in) > 0 ? Date.now() + Number(data.expires_in) * 1000 : 0);

/** Swap the callback's code for tokens and store them as a connection. Returns the saved connection. */
export async function completeConnection({ provider, cfg, code, redirectUri, userId, entry, query }) {
  const data = await tokenRequest(cfg, {
    grant_type: "authorization_code",
    code: String(code),
    redirect_uri: redirectUri,
    ...(cfg.pkce ? { code_verifier: entry?.verifier || "" } : {}),
  });
  let who = {};
  try {
    who = (await cfg.identity(data.access_token, data, query)) || {};
  } catch {
    /* identity is cosmetic — the connection still works without it */
  }
  return saveConnection(userId, provider, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresAt: expiryFrom(data),
    // Services that do not report the granted scopes granted what we asked for.
    scope: String(data.scope || (entry?.scopes || []).join(" ")),
    email: String(who.email || ""),
    name: String(who.name || ""),
    extra: who.extra || {},
    ...(cfg.userToken ? { user: cfg.userToken(data) } : {}),
  });
}

// ---- storage (the credential vault) ----

const typeFor = (provider) => `oauth:${provider}`;

function publicView(cred) {
  const f = cred.fields || {};
  return {
    id: cred.id,
    provider: String(f.provider || ""),
    email: String(f.email || ""),
    name: cred.name,
    scopes: String(f.scope || "").split(/[\s,]+/).filter(Boolean),
    extra: f.extra && typeof f.extra === "object" ? f.extra : {},
    updatedAt: cred.updatedAt,
  };
}

async function saveConnection(userId, provider, t) {
  const label = OAUTH_PROVIDERS[provider]?.label || provider;
  const all = await db.credentialsList(userId);
  const same = all.find((c) => c.type === typeFor(provider) && t.email && String(c.fields?.email || "").toLowerCase() === t.email.toLowerCase());
  const prev = same?.fields || {};
  const fields = {
    provider,
    email: t.email,
    // Scopes add up: connecting Gmail after Drive must not drop Drive.
    scope: [...new Set(`${prev.scope || ""} ${t.scope}`.split(/[\s,]+/).filter(Boolean))].join(" "),
    accessToken: t.accessToken,
    // Google omits the refresh token when the account had already consented —
    // keep the one we have rather than losing offline access.
    refreshToken: t.refreshToken || prev.refreshToken || "",
    expiresAt: t.expiresAt,
    extra: { ...(prev.extra || {}), ...(t.extra || {}) },
    // the person's own token (Slack "send as me"), when the service issues one
    userToken: t.user?.token || prev.userToken || "",
    userScope: t.user?.token ? String(t.user.scope || "") : prev.userScope || "",
  };
  const name = `${label} — ${t.email || t.name || "account"}`;
  const saved = same
    ? await db.credentialUpdate(same.id, userId, { name, type: typeFor(provider), fields })
    : await db.credentialCreate({ userId, name, type: typeFor(provider), fields });
  return publicView(saved);
}

/** The account's connections (no tokens), optionally for one provider. */
export async function listConnections(userId, provider) {
  const all = await db.credentialsList(userId);
  const matches = (c) => String(c.type || "").startsWith("oauth:") && (!provider || c.type === typeFor(provider));
  // a self-hosted team copy adds the admin's shared connections
  return withPooledCredentials(userId, all.filter(matches).map(publicView), matches, publicView);
}

export function isConnectionType(type) {
  return String(type || "").startsWith("oauth:");
}

// ---- access tokens for runs ----

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
// one refresh per connection at a time — parallel nodes share the result
const refreshing = new Map();

/**
 * A usable access token for connection `id` owned by `userId`, refreshed when
 * it is (nearly) expired. Tokens without an expiry (GitHub, Slack, Notion, …)
 * are used as they are. Throws a classified error the run log can explain.
 */
export async function accessTokenFor({ id, userId, provider, scopes, asUser = false }) {
  if (!userId) throw attachCode(new Error("This node uses a connected account, which only works in a signed-in workspace."), "AUTH_FAILED");
  // A pooled connection (self-hosted team copy) is read — and refreshed — as its owner's.
  const credOwner = await credentialOwner(id, userId);
  const cred = await db.credentialGet(String(id), credOwner);
  const label = OAUTH_PROVIDERS[provider]?.label || provider;
  if (!cred || cred.type !== typeFor(provider)) {
    throw attachCode(new Error(`The ${label} account picked on this node is no longer connected. Pick or connect it again.`), "MISSING_CONFIG");
  }
  const f = cred.fields || {};
  // "Send as me": the person's own token (Slack user token). Connections made
  // before this existed have none — a Reconnect adds it.
  if (asUser) {
    if (!f.userToken) {
      throw attachCode(new Error(`${cred.name} can only post as the bot so far. Open the node and click "Reconnect" to also allow posting as you.`), "AUTH_FAILED");
    }
    return f.userToken;
  }
  const lacking = missingScopes(f.scope, scopes);
  if (lacking.length) {
    throw attachCode(
      new Error(`${cred.name} has not allowed this yet (${lacking.join(", ")}). Open the node and click "Reconnect" to grant it.`),
      "AUTH_FAILED"
    );
  }
  const expiresAt = Number(f.expiresAt) || 0;
  if (f.accessToken && (!expiresAt || expiresAt - REFRESH_MARGIN_MS > Date.now())) return f.accessToken;
  if (!f.refreshToken) {
    throw attachCode(new Error(`${cred.name} needs to be reconnected — its sign-in has expired.`), "AUTH_FAILED");
  }
  const key = `${credOwner}:${cred.id}`;
  if (!refreshing.has(key)) {
    refreshing.set(
      key,
      (async () => {
        const cfg = await providerConfig(provider);
        if (!cfg) throw attachCode(new Error(`Sorry, connecting ${label} isn’t available yet.`), "MISSING_CONFIG");
        let data;
        try {
          data = await tokenRequest(cfg, {
            grant_type: "refresh_token",
            refresh_token: f.refreshToken,
            // Microsoft issues the token for the scopes named here (it must
            // be a subset of what was consented); the others ignore it.
            ...(cfg.refreshScope ? { scope: [...new Set(`${f.scope || ""} offline_access`.split(/[\s,]+/).filter(Boolean))].join(" ") } : {}),
          });
        } catch (err) {
          if (err.oauthError === "invalid_grant") {
            throw attachCode(new Error(`${cred.name} was disconnected or its access was revoked. Reconnect it on the node.`), "AUTH_FAILED");
          }
          throw err;
        }
        await db.credentialUpdate(cred.id, credOwner, {
          name: cred.name,
          type: cred.type,
          fields: {
            ...f,
            accessToken: data.access_token,
            // several services rotate refresh tokens; the others keep the old one valid
            refreshToken: data.refresh_token || f.refreshToken,
            expiresAt: expiryFrom(data),
          },
        });
        return data.access_token;
      })().finally(() => refreshing.delete(key))
    );
  }
  return refreshing.get(key);
}
