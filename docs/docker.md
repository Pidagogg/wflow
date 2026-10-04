# Running W flow in Docker

This page is the practical companion to the README's *Self-host with Docker* and
*Deployment* sections. It answers two questions:

1. **Right now — no VPS, no domain.** How do I run the whole app in Docker on my
   own machine and use it like a normal installation?
2. **Later.** What changes when I rent a VPS, and what changes again when I have
   a domain?

The image is already in the repo (`Dockerfile`, `docker-compose.yml`,
`.dockerignore`) — nothing has to be created. Everything below is a command you
can copy.

> **No domain is not a problem.** A domain is only needed for HTTPS and e-mail
> links. Until then the app runs perfectly on `http://localhost:3001` (your own
> machine) or `http://<vps-ip>:3001` (a plain IP on a VPS). The reverse proxy /
> certificate part of this document is the only part a domain unlocks.

---

## 1. Run it locally

**Prerequisite: the Docker daemon has to be running.** On Windows/macOS that
means starting **Docker Desktop** and waiting until the whale icon is steady.
Check it:

```bash
docker info        # must print Server info, not "cannot connect to the Docker daemon"
```

Then, from the project folder:

```bash
cp .env.example .env           # only if .env does not exist yet
docker compose up -d --build   # first run: builds the image (a few minutes)
```

Open **http://localhost:3001**. The first build compiles the UI inside the image
(stage 1) and produces a slim runtime image (stage 2), so you do **not** need
Node.js on the host at all — only Docker.

Two containers are started:

| Container | URL | What it is |
| --- | --- | --- |
| `wflow` | http://localhost:3001 | The app itself (UI + REST API + webhooks) |
| `wflow-admin` | http://localhost:3002 | The separate admin panel, published on loopback only |

Stop the admin container for a lighter setup:

```bash
docker compose up -d wflow     # start only the app
```

### Where your data lives

`./data` on the host is mounted to `/app/data` in the container. It holds the
SQLite database (`admin.db`), the workflows / agents JSON, uploaded files, the
backups and — importantly — the **`.secret` encryption key**. Two consequences:

- Deleting `./data` resets the installation, exactly like a non-Docker install.
- **Back up `./data`** (or set `BF_ENCRYPTION_KEY` yourself). Without it, saved
  API keys and credentials in your workflows can never be decrypted again.

`.env` is mounted from the host too, so the admin panel's deployment edits
survive a restart and you can always edit it with a normal text editor.

---

## 2. Pointing the app at a database

Without `DATABASE_URL` the app uses the built-in **SQLite** file
(`./data/admin.db`) — nothing to configure. If `DATABASE_URL` *is* set, the app
must reach that server or it stops at startup with `connect ECONNREFUSED`.

### A database on the host (the usual case)

Write the connection string the way your host sees it — `127.0.0.1` — and leave
it alone:

```env
DATABASE_URL=postgres://user:password@127.0.0.1:5432/wflow
```

The same `.env` then works whether you run the app in Docker or with
`npm start`. Inside a container `127.0.0.1` would mean the container itself, so
the server notices it is containerised (`server/env.js`) and rewrites **the host
part** of the URL to `host.docker.internal`: Docker Desktop resolves that name
by itself, and the `extra_hosts: host.docker.internal:host-gateway` mapping in
`docker-compose.yml` provides it on a plain Linux VPS too. Credentials, port and
database name are never touched, and the rewrite leaves one line in the log:

```
[env] DATABASE_URL pointed at a loopback host — using host.docker.internal (we are inside a container).
```

A database in another container (`…@postgres:5432/…`) or a hosted one is left
alone — those are already reachable under their own name. Turn the rewrite off
with `BF_DB_HOST_REWRITE=0`, or send it somewhere else with
`BF_DB_HOST_REWRITE=my-db.internal`.

A host PostgreSQL still has to accept connections from the Docker network:
`listen_addresses = '*'` plus a `pg_hba.conf` line for the Docker subnet, e.g.

```
host    all    all    172.16.0.0/12    scram-sha-256
```

If your database *is* a container (the bundled Postgres service below, or a
hosted one), just use its own service name or hostname — no `extra_hosts`
needed.

### PostgreSQL in Docker instead

`docker-compose.yml` contains a commented-out `postgres` service. Uncomment it,
uncomment `depends_on` on the `wflow` service, and set:

```env
DATABASE_URL=postgres://wflow:change-me@postgres:5432/wflow
```

The schema is created automatically on first start. To move an existing SQLite
installation into it:

```bash
docker compose up -d postgres
docker compose exec wflow npm run db:migrate -- --url postgres://wflow:change-me@postgres:5432/wflow
```

To move data from a PostgreSQL that runs *outside* Docker instead, use
`pg_dump` / `pg_restore` — `npm run db:migrate` copies the SQLite file and
cannot read a second PostgreSQL database.

---

## 3. Day-to-day commands

```bash
docker compose logs -f wflow        # follow the server log
docker compose up -d wflow          # after editing .env (restart does not re-read it)
docker compose ps                   # are the containers healthy?
docker compose down                 # stop everything (data stays in ./data)

# run a command inside the running container, e.g. the SQLite → PostgreSQL move:
docker compose exec wflow npm run db:migrate -- --url postgres://user:pass@host:5432/wflow

docker compose up -d --build        # rebuild after changing the code
```

The image has a healthcheck on `/api/nodes`, so `docker compose ps` shows
`healthy` once the app is really up.

---

## 4. Verifying the image is sound

What the container build actually runs:

```bash
npm ci                 # build stage, with dev dependencies
npm run build          # vite → dist/
npm ci --omit=dev      # runtime stage, production dependencies only
node server/index.js   # the server, serving dist/ + the API
```

If `docker compose up -d --build` fails, run the same steps on the host to see
the real error message — `npm run build` is usually the culprit:

```bash
npm install && npm run build && npm run typecheck
```

---

## 5. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `failed to connect to the docker API … npipe://…` | Docker Desktop is not started. Start it and wait for the engine. |
| `env file .env not found` | `.env` is missing — `cp .env.example .env` first (both services mount it). |
| Container restarts in a loop, `connect ECONNREFUSED` | The database refused the connection. A loopback host is rewritten automatically (§2), so this usually means the database is not listening on all interfaces or rejects connections from the Docker subnet (`pg_hba.conf`). |
| `Cannot find package '@vitejs/plugin-basic-ssl'` during the build | A dev dependency used by `vite.config.ts` was not declared in `package.json` — it has to be installed inside the image, not just on your machine. `npm install --save-dev <package>`. |
| `bind: address already in use` on 3001 | Something else (often a non-Docker `npm start`) holds the port. Stop it, or change the published port in `docker-compose.yml`. |
| Browser shows the old UI after pulling new code | The UI is baked into the image — rebuild: `docker compose up -d --build`. |
| Settings → *Documentation* / *Download PDF* fails | The guide is read from `docs/guide.md` at runtime; the image copies `docs/`. Rebuild if you removed that. |
| Login does not stick, or "too many requests" behind a proxy | Set `TRUST_PROXY=1` in `.env` and `docker compose up -d`. |
| Credentials in workflows became unreadable | `./data/.secret` (or `BF_ENCRYPTION_KEY`) changed or was lost. Restore it from your backup. |

---

## 6. Later: a VPS, still no domain

Any Linux VPS with 2 GB RAM is enough. The app is reachable on the plain IP —
that is a perfectly usable staging setup while you do not own a domain yet.

```bash
ssh root@<vps-ip>
curl -fsSL https://get.docker.com | sh

git clone <your-repo-url> wflow && cd wflow
cp .env.example .env
nano .env
docker compose up -d --build
```

Open `http://<vps-ip>:3001` (make sure port 3001 is open in the firewall /
security group).

**Before you expose it, edit `.env`** — the defaults are public in the repo:

```env
BF_ENCRYPTION_KEY=<openssl rand -hex 32>
BF_ADMIN_USERNAME=myadmin
BF_ADMIN_PASSWORD=<long random password>
BF_ALLOW_REGISTER=0            # private instance: only accounts you create can log in
BF_BLOCK_PRIVATE_URLS=1        # workflows cannot probe the server / cloud metadata
```

Keep the admin panel closed: leave `ADMIN_HOST=127.0.0.1` in `.env` and reach it
through an SSH tunnel instead of opening port 3002:

```bash
ssh -L 3002:localhost:3002 root@<vps-ip>     # then open http://localhost:3002
```

Alternatively add an inbound rule for 3002 restricted to your own IP and set
`ADMIN_ALLOWED_IPS=<your-ip>`.

**No domain also means no e-mail links.** Without SMTP, password-reset and
verification links are written to the server log (`docker compose logs -f
wflow`), so you can still copy them by hand. Account sign-in itself works fine.

---

## 7. Later: you have a domain — HTTPS

> **w-flow.tech:** the production instance has a ready-made setup, see [strato-vps.md](./strato-vps.md).

Point an `A` record (`flow.example.com`) at the VPS IP, then pick one option.

**Caddy — automatic certificates, least effort.** The compose file already has
a `caddy` service (off by default, behind a profile) with a `Caddyfile` that
proxies to the app over the compose network:

```env
# .env
SITE_ADDRESS=flow.example.com
APP_BIND=127.0.0.1     # stop publishing 3001 to the internet
```

```bash
docker compose --profile proxy up -d
```

Caddy obtains and renews the certificate by itself and redirects HTTP to HTTPS.
It needs ports 80 and 443 reachable from the internet. Without `SITE_ADDRESS` it
serves `https://localhost` with its own internal certificate, which is fine for
a local test but makes the browser warn about an untrusted issuer. Watch it with
`docker compose logs -f caddy`.

**Cloudflare Tunnel — no open ports and no certificate handling at all.**

```bash
cloudflared tunnel --url http://localhost:3001
```

**Nginx + certbot** if you prefer the classic stack (the admin panel has an
*Nginx & TLS* tab that generates the site config).

Then, in `.env`:

```env
TRUST_PROXY=1              # rate limiting must see the real client IP
BF_COOKIE_SECURE=1         # session cookie only over HTTPS
BF_PUBLIC_URL=https://flow.example.com   # used for e-mail links & OAuth redirects
BF_SITE_DOMAIN=flow.example.com          # swaps YOUR-DOMAIN in landing page / SEO files
```

and `docker compose up -d`.

---

## 8. Related documentation

- [README → Self-host with Docker](../README.md#self-host-with-docker) — the short version
- [README → Deployment — VPS + Cloudflare + PostgreSQL](../README.md) — PostgreSQL move, Cloudflare
- [docs/aws.md](./aws.md) — the full EC2 walkthrough and the security review
- The admin panel's **VPS & Docker / Nginx & TLS** tabs generate these commands
  with your own IP and domain filled in.
