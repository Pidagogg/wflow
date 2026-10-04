// ============================================================================
// "Continue with …" logins through Supabase — the pure helpers.
//
// The login flow itself (admin panel saves the project credentials → the app
// server offers the providers, bounces to the authorize endpoint with PKCE, and
// stores the verifier) is covered end-to-end in tests/admin-auth-settings.test.js.
//
// Run: node --test tests/supabase-auth.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviders, providerLabel, normalizeProjectUrl, mergeLoginProviders } from "../server/supabase-auth.js";

test("parseProviders normalises, de-duplicates and drops junk", () => {
  assert.deepEqual(parseProviders("Discord, apple ,github,,discord"), ["discord", "apple", "github"]);
  assert.deepEqual(parseProviders("google github"), ["google", "github"]);
  assert.deepEqual(parseProviders("linkedin_oidc"), ["linkedin_oidc"], "underscores survive");
  assert.deepEqual(parseProviders('"discord"'), ["discord"], "stray quotes are stripped");
  assert.deepEqual(parseProviders("   "), [], "blank means no buttons");
  assert.deepEqual(parseProviders(undefined), [], "unset means no buttons");
  assert.deepEqual(parseProviders(null), []);
});

test("normalizeProjectUrl keeps only the project origin", () => {
  // The dashboard shows the Data API URL (…/rest/v1) right next to the project
  // URL. Pasting that one sends every request to /rest/v1/auth/v1/authorize,
  // which lands on a gateway route that wants an API key — the browser then
  // shows Supabase's own {"message":"No API key found in request"}.
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/rest/v1").url, "https://abcdefgh.supabase.co");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/rest/v1").stripped, "/rest/v1", "the API path is reported");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/auth/v1").url, "https://abcdefgh.supabase.co");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/auth/v1/").stripped, "/auth/v1", "a trailing slash does not hide it");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/storage/v1").url, "https://abcdefgh.supabase.co");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/auth/v1/rest/v1").url, "https://abcdefgh.supabase.co", "every API path goes");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/rest/v1/").url, "https://abcdefgh.supabase.co");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co").url, "https://abcdefgh.supabase.co");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co").stripped, "", "a clean URL is left alone");
  assert.equal(normalizeProjectUrl("  https://abcdefgh.supabase.co/  ").url, "https://abcdefgh.supabase.co", "whitespace and slashes are trimmed");
  assert.equal(normalizeProjectUrl("https://abcdefgh.supabase.co/").stripped, "");
  // A path we do not recognise is kept: self-hosted Supabase can live under one.
  assert.equal(normalizeProjectUrl("https://supabase.example.com/team-a").url, "https://supabase.example.com/team-a");
  assert.equal(normalizeProjectUrl("http://localhost:8000/rest/v1").url, "http://localhost:8000", "self-hosted works too");
  assert.equal(normalizeProjectUrl("").url, "", "blank stays blank");
  assert.equal(normalizeProjectUrl(undefined).url, "");
  assert.equal(normalizeProjectUrl("  ").error, "");
  assert.match(normalizeProjectUrl("not a url").error, /Project Settings/, "a junk value says where the right URL is");
  assert.match(normalizeProjectUrl("projectref.supabase.co").error, /Project Settings/, "the scheme cannot be left off");
  assert.match(normalizeProjectUrl("ftp://projectref.supabase.co").error, /https/);
});

test("mergeLoginProviders hides the built-in button Supabase brokers", () => {
  const builtIn = { google: true, github: true };
  // Both brokered: the card shows the Supabase buttons only, so nobody is asked
  // to pick between two buttons that do the same thing.
  assert.deepEqual(mergeLoginProviders(builtIn, ["google", "github"]), { google: false, github: false });
  // Untouched when Supabase is off or offers something else.
  assert.deepEqual(mergeLoginProviders(builtIn, []), { google: true, github: true });
  assert.deepEqual(mergeLoginProviders(builtIn, ["discord", "apple"]), { google: true, github: true });
  // Mixed lists only drop the provider they actually cover.
  assert.deepEqual(mergeLoginProviders(builtIn, ["google", "discord"]), { google: false, github: true });
  // A provider that is not configured stays off either way, and odd inputs are safe.
  assert.deepEqual(mergeLoginProviders({ google: false, github: true }, ["github"]), { google: false, github: false });
  assert.deepEqual(mergeLoginProviders({}, ["google"]), {});
  assert.deepEqual(mergeLoginProviders(undefined, undefined), {});
});

test("providerLabel names the known providers and prettifies the rest", () => {
  assert.equal(providerLabel("google"), "Google");
  assert.equal(providerLabel("github"), "GitHub");
  assert.equal(providerLabel("linkedin_oidc"), "LinkedIn", "the _oidc suffix is dropped");
  assert.equal(providerLabel("twitter"), "X");
  assert.equal(providerLabel("some_new_one"), "Some new one", "an unknown slug still reads as a name");
  assert.equal(providerLabel("DISCORD"), "Discord", "case does not matter");
});
