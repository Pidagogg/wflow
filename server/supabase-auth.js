// ============================================================================
// W FLOW — "Continue with …" logins through Supabase Auth (optional)
//
// Supabase is used purely as an IDENTITY BROKER: it runs the social providers
// (Google, GitHub, Discord, Apple, LinkedIn, Slack, …) and the passwordless
// e-mail links, and hands this app one verified e-mail address. Accounts,
// sessions, workflow ownership, quotas and encrypted credentials all stay where
// they are — the local `users` table is still the system of record, exactly as
// with the built-in Google / GitHub login.
//
// Entry points (wired up in server/index.js):
//   GET  /api/auth/oauth/supabase/start?provider=discord  → redirect to Supabase
//   POST /api/auth/supabase/magic                         → e-mail a sign-in link
//   GET  /api/auth/oauth/supabase/callback?code=…         → PKCE exchange
//   GET  /api/auth/oauth/supabase/callback?token_hash=…   → magic link, any device
//
// The official @supabase/supabase-js client does the HTTP work — that is the
// part which has to match the Auth server exactly (the PKCE challenge, the
// token exchange, the OTP verification), and hand-rolling it is how these
// integrations break on the next server release. Only the storage adapter
// below is ours: a request has no localStorage, so the PKCE verifier is kept in
// a short-lived cookie instead. Nothing else is persisted — the session that
// Supabase returns is used once to read the e-mail and is then dropped in
// favour of the app's own session cookie.
// ============================================================================
import { createClient } from "@supabase/supabase-js";

/** Cookie holding the PKCE verifier between the redirect out and back. */
export const PKCE_COOKIE = "bf_sb_pkce";
/** Cookie holding the login-CSRF nonce for the social flow. */
export const STATE_COOKIE = "bf_sb_state";
/** How long those two cookies stay valid (seconds). */
const FLOW_TTL = 600;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Split a `SUPABASE_PROVIDERS` style value ("discord, apple ,github") into
 * provider slugs. Anything Supabase supports is accepted, so enabling a new
 * provider needs no code change — the slug is only validated as a slug.
 */
export function parseProviders(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value || "").split(/[,\s]+/)) {
    const slug = raw.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project URL
// ---------------------------------------------------------------------------

/**
 * API paths the Supabase dashboard shows right next to the project URL. Pasting
 * one of them (`https://xyz.supabase.co/rest/v1`, the Data API URL) makes every
 * request land on a gateway route that wants an API key, and the first thing
 * anyone sees is Supabase answering
 * `{"message":"No API key found in request"}` — because the real path becomes
 * `/rest/v1/auth/v1/authorize`. Strip them, so the mistake cannot happen.
 */
const API_SUFFIXES = ["/auth/v1", "/rest/v1", "/storage/v1", "/functions/v1", "/realtime/v1", "/graphql/v1"];

/**
 * Reduce a pasted value to the bare project URL.
 *
 * Returns `{ url, stripped, error }`. `stripped` is the API suffix that was
 * removed ("" when the value was already clean), so callers can tell the
 * operator what happened instead of silently changing their input. `error` is
 * set only when the value cannot be used at all.
 */
export function normalizeProjectUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { url: "", stripped: "", error: "" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      url: raw,
      stripped: "",
      error: `"${raw}" is not a URL — paste the Project URL from Project Settings → API, e.g. https://abcdefgh.supabase.co`,
    };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { url: raw, stripped: "", error: "The Supabase project URL must start with https://" };
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  const stripped = [];
  for (;;) {
    const lower = path.toLowerCase();
    const hit = API_SUFFIXES.find((suffix) => lower.endsWith(suffix));
    if (!hit) break;
    stripped.unshift(path.slice(path.length - hit.length));
    path = path.slice(0, path.length - hit.length);
  }
  // A path we do not recognise is kept: self-hosted Supabase can live under a
  // sub-path, and that is a legitimate project URL.
  return { url: `${parsed.origin}${path}`, stripped: stripped.join(""), error: "" };
}

/** Providers Supabase ships with, so the button can say "Discord", not "discord". */
const PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  discord: "Discord",
  apple: "Apple",
  azure: "Microsoft",
  facebook: "Facebook",
  linkedin_oidc: "LinkedIn",
  notion: "Notion",
  slack_oidc: "Slack",
  spotify: "Spotify",
  twitch: "Twitch",
  twitter: "X",
  workos: "WorkOS",
  zoom: "Zoom",
  figma: "Figma",
  bitbucket: "Bitbucket",
  keycloak: "Keycloak",
  kakao: "Kakao",
  line: "LINE",
  naver: "Naver",
  salesforce: "Salesforce",
  fly: "Fly.io",
  vercel: "Vercel",
  web3: "Web3 wallet",
  email: "E-mail",
};

/** "linkedin_oidc" → "LinkedIn", "some_new_one" → "Some new one". */
export function providerLabel(slug) {
  const key = String(slug || "").toLowerCase();
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key];
  const words = key.replace(/_oidc$|_oauth$|_$/, "").replace(/[_.-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

// ---------------------------------------------------------------------------
// Which buttons the login card shows
// ---------------------------------------------------------------------------

/**
 * Drop a built-in button when Supabase brokers the same provider.
 *
 * Supabase runs Google and GitHub as well, so an instance with both the built-in
 * credentials and a Supabase project would draw two buttons for one login — and
 * the one the user picks would decide which client id gets used, for no reason
 * they can see. Supabase wins: naming a provider in the Supabase list is how you
 * ask for the brokered one, and leaving it out brings the built-in button back.
 * Nothing is switched off server-side — the built-in start endpoints keep
 * working, they are just no longer advertised to the card.
 */
export function mergeLoginProviders(builtIn, brokered) {
  const names = new Set(brokered || []);
  return Object.fromEntries(Object.entries(builtIn || {}).map(([name, on]) => [name, !!on && !names.has(name)]));
}

// ---------------------------------------------------------------------------
// Per-request client
// ---------------------------------------------------------------------------

/**
 * Storage backed by one short-lived cookie.
 *
 * supabase-js asks for the PKCE verifier (`<storageKey>-code-verifier`) on the
 * way back from Supabase and would also like to keep the resulting session.
 * Only the verifier is persisted (a cookie survives the cross-site redirect, an
 * in-memory map does not); everything else lives for the duration of the
 * request — the app issues its own session cookie and never needs the Supabase
 * one again.
 */
function flowStorage(req, res, secure) {
  const store = new Map();
  const cookiePath = "/api/auth/oauth/supabase";

  // The client keeps several entries (the PKCE verifier and a flow id), and
  // their values differ — one cookie per key would need one name per key, so
  // the whole set travels in a single JSON cookie instead. It is a few hundred
  // bytes and is dropped as soon as the flow ends.
  const raw = req.cookies?.[PKCE_COOKIE];
  if (raw) {
    try {
      const parsed = JSON.parse(raw); // cookie-parser already URI-decoded it
      if (parsed && typeof parsed === "object") for (const [k, v] of Object.entries(parsed)) store.set(k, v);
    } catch {
      /* an unreadable cookie just means no flow is in progress */
    }
  }
  const flush = () => {
    // URI-encoded: raw JSON quotes would not survive a Set-Cookie header.
    const value = store.size ? encodeURIComponent(JSON.stringify(Object.fromEntries(store))) : "";
    res.append(
      "Set-Cookie",
      `${PKCE_COOKIE}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${store.size ? FLOW_TTL : 0}${secure ? "; Secure" : ""}`
    );
  };

  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, value);
      flush();
    },
    removeItem: (key) => {
      store.delete(key);
      flush();
    },
  };
}

/** A Supabase client scoped to one request, with PKCE and cookie storage. */
export function supabaseClient({ url, anonKey, req, res, secure = false }) {
  return createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "wflow-supabase",
      storage: flowStorage(req, res, secure),
    },
  });
}

/** Turn any supabase-js failure into a plain message for the login card. */
function messageOf(error, fallback) {
  const text = String(error?.message || error || "").trim();
  return text || fallback;
}

// ---------------------------------------------------------------------------
// Social sign-in
// ---------------------------------------------------------------------------

/**
 * The URL to send the browser to. `nonce` rides along in the redirect so the
 * callback can verify the flow is the one this browser started — the same
 * login-CSRF protection the built-in providers use.
 */
export async function authorizeUrl({ client, provider, redirectTo, nonce }) {
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      queryParams: nonce ? { bf_state: nonce } : undefined,
    },
  });
  if (error || !data?.url) throw new Error(messageOf(error, `Could not start the ${provider} login.`));
  return data.url;
}

// ---------------------------------------------------------------------------
// Magic link (passwordless e-mail)
// ---------------------------------------------------------------------------

/**
 * Ask Supabase to mail a sign-in link for `email`. `redirectTo` is this app's
 * callback, so the link lands here — the mail is sent by Supabase (its own
 * mailer, or the SMTP configured on the project).
 */
export async function sendMagicLink({ client, email, redirectTo, createUser = true }) {
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: createUser },
  });
  if (error) throw new Error(messageOf(error, "Could not send the sign-in link."));
}

// ---------------------------------------------------------------------------
// Callback: turn a redirect back into a verified e-mail
// ---------------------------------------------------------------------------

/**
 * Exchange the `?code=` Supabase sent (PKCE flow — the verifier is read from
 * the cookie the start request wrote) for the signed-in account.
 */
export async function completeWithCode({ client, code }) {
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data?.user) throw new Error(messageOf(error, "The sign-in link is no longer valid — please try again."));
  return profileOf(data.user);
}

/**
 * Verify a `?token_hash=` link. This is the form that works when the e-mail is
 * opened on a different device than the one the login was started on (no PKCE
 * verifier needed) — see docs/supabase.md for the one-line e-mail template
 * change that produces it.
 */
export async function completeWithTokenHash({ client, tokenHash, type }) {
  const { data, error } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: String(type || "magiclink"),
  });
  if (error || !data?.user) throw new Error(messageOf(error, "The sign-in link has expired — please request a new one."));
  return profileOf(data.user);
}

/** The one thing we want from a Supabase user: a trusted e-mail address. */
function profileOf(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) throw new Error("Supabase did not return an e-mail address for this account.");
  const meta = user?.user_metadata || {};
  const name = meta.full_name || meta.name || meta.user_name || meta.preferred_username || "";
  return { email, name: String(name || "").slice(0, 120) };
}
