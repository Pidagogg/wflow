# Deploying W flow to the STRATO VPS (w-flow.tech)

Everything is pre-configured for **w-flow.tech** on a STRATO VPS. You only need
to enter your access data and personal details. The whole setup takes about
15 minutes.

| File | What it is |
|---|---|
| `.env.production.example` | Production settings: domain, HTTPS, and placeholders for the mail account and the legal pages |
| `deploy/vps.env.example` | Your VPS access data (IP, user, port). You copy it to `deploy/vps.env`, which is git-ignored |
| `deploy/deploy.sh` | Run on your PC: uploads the project and starts it on the VPS |
| `deploy/strato-setup.sh` | Runs on the VPS: installs Docker and a firewall, writes `.env` with fresh secrets, starts the app and Caddy (HTTPS) |

## 1. Get the VPS access data

Open the STRATO customer area (**Kunden-Login**), then **Server** → your VPS.
Note three things:

- the **IPv4 address** (and IPv6, if shown)
- the **root password** (initial access data)
- the **operating system**: pick **Ubuntu 22.04/24.04** or **Debian 12** if you are asked

## 2. Point the domain at the VPS

The domain is registered at **checkdomain**. In its customer area, open `w-flow.tech`: put the VPS IPv4 under **Haupt-IP-Adresse** (with **Inklusive www: Ja**) and add `info` as an A record under **Profi-Einstellungen**. Leave the MX and SPF (TXT) entries alone, since the mailbox needs them. The result must be:

| Type | Name | Value |
|---|---|---|
| A | `@` (w-flow.tech) | VPS IPv4 |
| A | `www` | VPS IPv4 |
| A | `info` | VPS IPv4 (serves the legal pages on `info.w-flow.tech`) |
| AAAA | `@`, `www`, `info` | VPS IPv6 (only if the VPS has one) |

DNS changes can take up to a few hours. Caddy only gets the HTTPS certificates
once these records resolve to the VPS.

## 3. Enter the access data and deploy

On your PC, from the project folder (Git Bash on Windows):

```bash
cp deploy/vps.env.example deploy/vps.env
```

Put the VPS IP into `VPS_HOST` in `deploy/vps.env`, then run:

```bash
bash deploy/deploy.sh
```

You will be asked for the root password, unless you set `VPS_SSH_KEY`. The
first run prints the **admin panel password**, so write it down. It is also
stored in `/opt/wflow/.env` on the server.

Run the same command again whenever you want to ship a new version. The
server's `.env` and `data/` folder are kept.

## 4. Fill in your details on the server

Open the admin panel through an SSH tunnel:

```bash
ssh -L 3002:127.0.0.1:3002 root@<VPS-IP>
```

Then go to http://localhost:3002 and open the **Legal pages** tab. Fill in your
name, address and e-mail. Values set there override the `LEGAL_*` lines in
`.env`. The hosting provider (STRATO GmbH) is already filled in.

For e-mail (verification and password-reset mails), the domain and mailbox are
at **checkdomain**, not STRATO:

1. In the checkdomain customer area, create the mailbox `main@w-flow.tech`
   and look up the SMTP server under **E-Mails → Server-Informationen**.
2. On the server, run `nano /opt/wflow/.env`, put the SMTP server into
   `SMTP_HOST` and the mailbox password into `SMTP_PASS`. Then run
   `docker compose up -d wflow`.

Until `SMTP_PASS` is set, mail counts as not configured: new accounts can sign
up without a confirmation e-mail, and links only go to the server log.

## 5. Legal checklist

- **AVV with STRATO:** the privacy policy states that a data processing
  agreement (Art. 28 GDPR) exists with the hoster. Accept it in the STRATO
  customer area under **Verträge → Auftragsverarbeitung (AVV)**.
- **Impressum:** it needs your real name and a postal address. A P.O. box is
  not enough.
- **Check the pages:** open https://w-flow.tech/impressum and
  https://w-flow.tech/datenschutz and make sure no `[placeholder]` marks are left.

## Useful commands on the VPS

```bash
cd /opt/wflow
docker compose ps                  # status
docker compose logs -f wflow caddy # logs
docker compose up -d wflow         # after editing .env (restart does not re-read it)
```
