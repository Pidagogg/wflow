# Deploying W flow on AWS (EC2)

The app is a normal long-running Node process with a persistent `./data` folder,
so it runs on EC2 exactly like on any VPS. The admin panel is a **separate
process on its own port (3002)** and stays usable after deployment. This page
collects the deployment steps, answers what happens to the admin panel and how
to make changes afterwards, and lists the security review done for an AWS
deployment.

> The same content is interactive in the **admin panel → Deploy · AWS** tab
> (type your instance IP and it generates the exact commands). Open the admin
> panel locally with `./admin.sh` (Linux/macOS) or `admin.bat` (Windows).

---

## 1. One-time setup

1. **Launch an EC2 instance** — Ubuntu 24.04 LTS, `t3.small` / `t3.medium`
   (2 GB RAM is plenty), 20 GB gp3 root volume, and a key pair (keep the `.pem`).
2. **Security group (inbound) — only open what you use:**
   - `22` (SSH) from **your** IP only;
   - `80`/`443` if a reverse proxy will terminate TLS;
   - `3001` only if you want a direct `http://<ip>:3001` URL (skip when using a
     Cloudflare Tunnel);
   - `3002` **never** — the admin panel is reached via an SSH tunnel or
     `ADMIN_ALLOWED_IPS`.
3. **Install Docker and deploy:**
   ```bash
   ssh -i your-key.pem ubuntu@<instance-public-ip>
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker ubuntu          # then log out and back in

   git clone <your-repo-url> wflow && cd wflow
   cp .env.example .env
   nano .env                                # see the checklist below
   docker compose up -d --build
   ```
4. **Env checklist for a public AWS instance:**
   ```env
   PORT=3001
   TRUST_PROXY=1                # behind Caddy / Cloudflare / Nginx
   BF_COOKIE_SECURE=1           # HTTPS-only login cookie
   BF_ENCRYPTION_KEY=<64 hex>   # generate with: openssl rand -hex 32
   BF_ADMIN_USERNAME=myadmin    # never keep the public defaults
   BF_ADMIN_PASSWORD=<long random password>
   BF_ALLOW_REGISTER=0          # private instance: stop strangers signing up
   BF_BLOCK_PRIVATE_URLS=1      # block SSRF to metadata/internal addresses
   # DATABASE_URL=postgres://wflow:<pw>@<rds-endpoint>:5432/wflow   # optional RDS
   ```
5. **HTTPS** — run Caddy in front (automatic TLS) or use a Cloudflare Tunnel
   (see the admin panel's Deploy tab for both):
   ```bash
   docker run -d -p 80:80 -p 443:443 -v caddy-data:/data caddy \
     caddy reverse-proxy --from flow.example.com --to localhost:3001
   ```
   `TRUST_PROXY=1` (above) keeps rate limiting on real client IPs.

---

## 2. Can I still use the admin panel after deploying on AWS?

**Yes.** The admin panel runs as its own server on port **3002** on the same
instance and manages the same `./data` database. Pick one access method:

- **SSH tunnel (recommended — no open ports, nothing exposed):** run this from
  your PC and open `http://localhost:3002` in your browser:
  ```bash
  ssh -i your-key.pem -L 3002:localhost:3002 ubuntu@<instance-public-ip>
  ```
- **IP allowlist:** keep the panel reachable only from your IP — add a security
  group rule for port `3002` from your IP, and set `ADMIN_ALLOWED_IPS=<your-ip>`
  in `.env` (everyone else gets 403 before the login page).
- **Protected subdomain:** point `admin.example.com` at port 3002 behind
  Cloudflare Access or Caddy basic-auth — while keeping `ADMIN_ALLOWED_IPS` set
  as a second layer.

In all cases the panel keeps its own login (seeded from
`BF_ADMIN_USERNAME`/`BF_ADMIN_PASSWORD` or the Account tab), CSRF protection,
rate limiting and optional IP allowlist — the exact same panel you use locally.

## 3. How do I change the website after it is deployed?

| What you want to change | How |
| --- | --- |
| Site name, tagline, banner | Admin panel → **Page setup** |
| Landing-page / SEO domain, env values, Postgres, Cloudflare commands | Admin panel → **Deploy** tab |
| Where workflows are stored (device vs SQL DB), cloud connection | Admin panel → **Cloud servers** |
| Stripe / Pro subscriptions | Admin panel → **Billing (Stripe)** |
| Users, tables, ad-hoc SQL | Admin panel → **Database** |
| Workflows / AI agents themselves | In the app, by the owning account, from any browser (auto-saved) |
| Runtime config (`PORT`, `DATABASE_URL`, `BF_*` …) | Edit `.env` on the server (or the Deploy tab), then `docker compose up -d` |
| **Code / UI / new node types** | Edit source in your repo → commit & push → on the server: `git pull && docker compose up -d --build` |
| Backups | Snapshot the EBS volume (all of `./data` lives on it), or use RDS |

The login page, marketing page and admin panel all serve whatever code is in
the repo, so content edits that exist in code (new pages, changed copy in the
React UI) are shipped the same way as any other code change — there is no
separate CMS. Everything data-driven (users, workflows, site name/tagline,
billing, SEO domain) is editable from the admin panel or the app itself.

---

## 4. Security review — what to know before you go live on AWS

The review looked at the whole server (auth, sessions, cookies, CSRF,
rate limiting, admin panel, webhook endpoint, file sandboxing, outbound HTTP)
through the lens of "this now runs on a public EC2 instance". Findings, from
most to least important:

1. **Instance-metadata exposure via workflows (SSRF) — fixed in this release.**
   The `HTTP Request`, `RSS Read` and webhook-sender nodes call arbitrary URLs.
   On EC2, `http://169.254.169.254/latest/meta-data/...` can hand out **IAM
   credentials** — so any account that can run a workflow could read them.
   - Added `BF_BLOCK_PRIVATE_URLS=1`: the nodes above now refuse loopback /
     private / link-local / metadata addresses (error `BF-3005`) before any
     network I/O, and refuse hostnames that resolve to them (DNS-rebinding
     safe). Off by default so local/internal use keeps working — **turn it on
     for AWS**.
   - AWS-side: do **not** attach an IAM instance role unless the app needs one;
     if you do, enable **IMDSv2 with hop limit 1**.

2. **Admin panel on the public internet — high risk if misconfigured.**
   Without `BF_ADMIN_USERNAME`/`BF_ADMIN_PASSWORD` a fresh database gets the
   admin `admin` with a random password that is printed once in the log.
   Port 3002 must not be open to `0.0.0.0/0`. Mitigations: set
   `BF_ADMIN_USERNAME`/`BF_ADMIN_PASSWORD`, keep the port behind the SSH tunnel
   or `ADMIN_ALLOWED_IPS` (both described in §2). The panel itself already has
   httpOnly+SameSite=Strict session cookies, CSRF tokens, login rate limiting
   and an IP allowlist.

3. **Open self-registration — medium.**
   By default anyone can create an account on the login page. On a public
   instance that lets strangers store data and burn your compute/outbound
   quota (workflows are capped, but still). Set `BF_ALLOW_REGISTER=0` for a
   private instance; there is no invite flow, so accounts are then created via
   the admin panel's SQL console or by enabling registration briefly.

4. **No TLS by default — high if you expose port 3001 directly.**
   Login and session cookies travel in plaintext over `http://`. Put Caddy /
   Cloudflare in front and set `BF_COOKIE_SECURE=1` + `TRUST_PROXY=1`. The
   login/register endpoints are also rate limited per IP + email.

5. **Data lives on the instance disk — durability risk.**
   `./data` holds the SQLite DB (accounts, sessions, encrypted keys),
   workflows, agents and files. Terminating the instance loses it. Snapshot the
   EBS volume, or point `DATABASE_URL` at RDS. Back up `BF_ENCRYPTION_KEY` —
   losing it makes the stored API keys unreadable.

6. **Security group too wide — medium.**
   A default "launch wizard" group often opens SSH to the world. Restrict
   inbound to what §1 lists; never open `3002`; use a Cloudflare Tunnel or
   Caddy so `3001`/`3002` don't need public rules at all.

7. **Public webhook endpoint — low.**
   `POST /webhook/:id` is public by design, but only fires while a Run is
   actively waiting (one request per Run), is rate limited per IP
   (`BF_WEBHOOK_RATE_LIMIT`, default 60/min), and can be protected with an
   `X-W-Flow-Secret` header per workflow. If the workflow is public-facing,
   add a secret or a WAF rule in front.

8. **Already safe (verified, no change needed):** session cookies are
   httpOnly + SameSite; all SQL is parameterized; passwords are scrypt-hashed;
   credentials stored at rest are AES-256-GCM encrypted (key from
   `BF_ENCRYPTION_KEY`); the file-system nodes are sandboxed to `./data/files`
   (path traversal rejected); the SQL Query node is read-only; community
   sharing strips secrets; the main API sets `Cache-Control: no-store` on
   `/api` and `/webhook`; Express bodies are size-limited; admin login brute
   force is rate limited.

---

## 5. What changed in this session

- **Admin panel → Deploy · AWS tab** (in `server/admin.html` + `server/admin.js`):
  a full EC2 guide with copyable commands, a persisted instance-address field
  that generates your exact SSH / deploy / admin-tunnel / update commands, and
  an "after you deploy" panel covering admin access and how to make changes.
- **SSRF guard**: `BF_BLOCK_PRIVATE_URLS` + `BF-3005` error code
  (`shared/errors.js`, `ERRORS.md`, `server/executor.js`, `.env.example`).
- **Node audit** (see `docs/node-audit.md`): every one of the 445 catalog nodes
  is exercised end-to-end by the test suite; fixed 7 nodes that had no real UI
  icon; made the 18 sample-only service triggers honest about what Run does
  (palette description + an in-config note) and wired **live RSS polling** for
  the RSS trigger (the background scheduler now runs a workflow when its feed
  gains new items — see `server/scheduler.js`); added catalog/UX contract
  tests (`tests/node-ux.test.js`), URL-safety tests (`tests/url-safety.test.js`)
  and RSS scheduler tests (`tests/rss-trigger.test.js`).
