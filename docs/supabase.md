# Signing in through Supabase (optional)

W flow has its own accounts: e-mail + password, plus optional Google / GitHub
login. **Supabase is an optional extra front door to those same accounts.** It
runs the social providers and the passwordless e-mail links for you, and hands
this app one verified e-mail address.

What it does **not** change: users, sessions, workflow ownership, folders,
sharing, quotas, the admin panel and every encrypted credential stay in this
app's own database (`server/supabase-auth.js` only calls Supabase Auth). You can
switch Supabase off again at any time and every account still works with its
password — exactly like the built-in Google / GitHub buttons.

Two ways in, both optional and independent:

| Login card element | How it works |
| --- | --- |
| **"Continue with …"** buttons | Supabase shows its consent screen for the provider (Google, Discord, Apple, LinkedIn, Slack, …) and comes back with a verified address. |
| **"E-mail me a sign-in link"** | Passwordless: no password at all. Supabase mails a one-time link. |

---

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and create a project (the
   free tier is enough).
2. Open **Project Settings → API** and copy two values:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon / publishable key** — looks like `sb_publishable_…` (or a long
     `eyJ…` JWT on older projects)

   The anon key is *designed* to be public. This app keeps it on the server
   anyway and never sends it to the browser.

---

## 2. Tell Supabase where to come back to

**Authentication → URL Configuration**:

- **Site URL** — the origin of your W flow instance, e.g.
  `https://flow.example.com`, or `http://localhost:3001` while you test locally.
- **Redirect URLs** — add the callback **exactly** (no trailing slash, no
  wildcard):

  ```
  http://localhost:3001/api/auth/oauth/supabase/callback
  https://flow.example.com/api/auth/oauth/supabase/callback
  ```

Add both if you develop locally and deploy on a domain: Supabase only redirects
to an address on this list. The admin panel's **Auth & e-mail** tab prints the
exact URL for your configured Public URL, so you can copy it from there.

W flow asks Supabase to come back to **the address you are browsing on**: behind
a domain that is the configured Public URL, and while you test on
`http://localhost:3001` it is that localhost address — so a stale Public URL
left over from planning (`https://flow.example.com`, when you have no domain
yet) does not send you to a host that does not answer.

---

## 3. Enable the providers you want

**Authentication → Providers** — enable each one and paste the client id /
secret from that provider's own developer console (Google Cloud, the Discord
developer portal, …). Supabase handles the OAuth dance from then on.

For that to work, **the app whose client id you pasted must allow Supabase's own
callback** as a redirect URI — Supabase is the OAuth client here, so the provider
refuses the sign-in with `redirect_uri_mismatch` until its console lists it:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

- **Google** — Google Cloud Console → **APIs & Services → Credentials** → your
  OAuth client (**Web application**) → **Authorized redirect URIs** → add it
  (and keep your own `/api/auth/oauth/google/callback` there if you still use the
  built-in button).
- **GitHub** — the OAuth App's **Authorization callback URL** → set it to this
  address (GitHub allows only one, so switching a GitHub app over to Supabase
  means the built-in GitHub button can no longer use it).
- **Discord / Apple / the rest** — same idea, in their own app settings.

The admin panel prints this exact address under **Auth & e-mail → Supabase**
(and after **Test connection**), so you can copy it from there.

- Leave **"Allow new users to sign up"** enabled, otherwise a first-time login
  is rejected. The account is still created by *this* app, after the address has
  been verified — see step 4.
- Providers you enable here that W flow also has built-in buttons for (**Google**,
  **GitHub**) are drawn **once**: the Supabase button is shown and the built-in
  one steps aside, so nobody has to choose between two buttons for the same
  login. Leave the provider out of the *Login providers* field in step 4 to keep
  using the built-in button instead.
- Nothing can be enabled here for the passwordless option: e-mail works out of
  the box. Supabase's default mailer is rate-limited (a handful of mails per
  hour); configure **Project Settings → Auth → SMTP** when you use it for real.

---

## 4. Enter the values in W flow

**Admin panel → Auth & e-mail → Supabase**:

| Field | Value |
| --- | --- |
| Project URL | the **Project URL** itself, e.g. `https://abcdefgh.supabase.co` — copy it from **Project Settings → API** |
| Anon / publishable key | the key from step 2 (stored encrypted; leave the field empty later to keep it) |
| Login providers | the buttons to show, comma-separated: `google, discord, apple`, or the `linkedin_oidc` / `slack_oidc` slugs |
| "e-mail me a sign-in link" | uncheck to hide the passwordless form |

A URL that ends in an API path (`/rest/v1`, `/auth/v1`, `/storage/v1`, …) is
corrected on save — those are the URLs the dashboard lists *next to* the project
URL, and pasting one makes every request go to the wrong place, where the
gateway answers `{"message":"No API key found in request"}`. The panel says so
when it happens, and the correction is applied to values that were already saved
too.

Press **Test connection** to ask the project directly: it reports whether the
URL and key work, which providers are actually enabled there, and whether the
E-mail provider (needed for sign-in links) is on. The values in the fields are
tested, so a URL can be checked before saving.

Save, then open the login page — the buttons and the e-mail form appear
immediately, no restart. The same values as env vars (used when the panel field
is empty):

```env
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_ANON_KEY=sb_publishable_…
SUPABASE_PROVIDERS=google,discord,apple
SUPABASE_MAGIC_LINK=0          # 0 hides the e-mail form
```

> The provider slugs come straight from Supabase's provider list, so a provider
> Supabase adds tomorrow works without a code change — just add its slug.

---

## 5. Test it

1. Open `http://localhost:3001`, pick **Continue with Discord** (or whatever you
   enabled), approve on Supabase's screen and you land back in the workspace.
2. For the e-mail option: type an address, press **E-MAIL ME A SIGN-IN LINK**
   and open the mail. You are signed in — no password needed.

The first login creates the local account for that address (if it did not exist
yet) and marks it verified. Later logins match it by e-mail, so a user who
signed up with a password can also use the Supabase button, and vice versa.

---

## E-mail links opened on another device (optional)

By default the emailed link is exchanged in the browser that requested it (the
PKCE verifier is a cookie in that browser). That is fine for the usual "request
on my phone, open on my phone" case, but a link opened in a different browser or
device cannot complete the exchange.

To make the links device-independent, point the **Magic Link** e-mail template
at this app's callback (**Authentication → Email Templates → Magic Link**)
instead of `{{ .ConfirmationURL }}`:

```html
<h2>Sign in to W flow</h2>
<p><a href="{{ .SiteURL }}/api/auth/oauth/supabase/callback?token_hash={{ .TokenHash }}&type=magiclink">Sign in</a></p>
```

`.SiteURL` is the value from step 2, so this only needs the Site URL to point at
your instance. With this template the link carries a one-time hash that the
server verifies directly — no cookie, any device.

---

## Notes & troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| The browser shows `{"message":"No API key found in request","hint":"No `apikey` request header or url param was found."}` after clicking a button | The **Project URL** has an API path in it (`…/rest/v1`). Save the field again — the path is stripped — or correct it to `https://<ref>.supabase.co`. **Test connection** reports this in words instead. |
| After approving on the provider's screen you end up on a page that does not load | The redirect address is not the one you are browsing on. Add the callback for **both** origins to **Redirect URLs** (step 2) — `localhost` for local testing and your domain once it exists. |
| `redirect_uri mismatch` / "Invalid redirect URL" on Supabase's page | The callback is missing from **Redirect URLs** (step 2). It must match exactly, including `http://` vs `https://` and the port. |
| Only some of the buttons appear | A provider listed here is switched off in **Authentication → Providers**. **Test connection** names them. |
| `400: redirect_uri_mismatch` on Google's page, or "**The redirect_uri is not associated with this application**" on GitHub's | The client id pasted into Supabase belongs to an app that does not allow Supabase's callback. Add `https://<project-ref>.supabase.co/auth/v1/callback` to that app's allowed redirect URIs (step 3). |
| The sign-in mail never arrives, but the form says it was sent | The **E-mail** provider is off in the Supabase project (see **Test connection**), or the address has no account and "Allow new users to sign up" is disabled. |
| The login card shows no Supabase buttons | Either Project URL or anon key is empty in the admin panel, or the *Login providers* field is empty. The admin **Auth & e-mail** tab shows `Supabase: configured / not configured`. |
| "E-mail sign-in links are not enabled" | The passwordless switch is off (`SUPABASE_MAGIC_LINK=0` or the checkbox). |
| The mail never arrives | Supabase's default mailer is rate-limited; configure project SMTP (see below). Check the spam folder. |
| Nothing is sent at all after setting custom SMTP | The provider refuses the login or the sender. Supabase → **Logs → Auth** shows the SMTP error. See the checklist below. |
| Sign-in succeeds on Supabase but the app says "Login with Supabase failed" | Check the server log (`docker compose logs -f wflow`) — usually a wrong Project URL or anon key. |
| Costs | Users who sign in count toward the project's Monthly Active Users. The free tier covers a lot; check the current Supabase pricing page before a public launch. |

Related: [docs/docker.md](./docker.md) for running the app, [README](../README.md)
for the built-in password / Google / GitHub login.

---

## Mail from your own domain (two mail paths)

W flow sends mail through **two separate paths**. Both need your SMTP details if every mail should come from e.g. `main@w-flow.tech`:

| Mail | Sent by | Configure in |
|---|---|---|
| "E-mail me a sign-in link" (passwordless) | Supabase | Supabase → Project Settings → Auth → **SMTP Settings** |
| Sign-up confirmation, password reset | W flow itself (`server/mail.js`) | Admin panel → **Auth & e-mail** (or `SMTP_*` / `MAIL_FROM`) |

Once W flow's own SMTP is set, a password sign-up **must open the confirmation link before it can log in** (`BF_REQUIRE_EMAIL_VERIFY=0` turns that off). Use **Send test e-mail** on the Auth & e-mail tab to check the settings. It shows the SMTP server's own error.

SMTP checklist (the same values go in both places):

1. **Host / port.** Use your mail provider's SMTP server (STRATO: `smtp.strato.de`, IONOS: `smtp.ionos.de`). Port **465** means implicit TLS ("secure" on). Port **587** means STARTTLS ("secure" off).
2. **Username.** This is the full mailbox address (`main@w-flow.tech`). The **password** is the mailbox password, not the hosting-account login.
3. **Sender address.** It must be exactly that mailbox. Most providers reject a different From with `553 sender not allowed`. In the W flow admin you can write `W flow <main@w-flow.tech>`.
4. **Rate limit.** Supabase starts custom SMTP at a low e-mail rate limit (Auth → Rate limits). Raise it if sign-ups are frequent.
5. **DNS.** Add the SPF (and DKIM, if offered) records your provider documents for the domain, or mail lands in spam.
