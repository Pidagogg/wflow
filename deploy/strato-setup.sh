#!/usr/bin/env bash
# ============================================================================
# W FLOW — one-time setup of a fresh STRATO VPS (Ubuntu / Debian) for w-flow.tech
#
# Run ON THE SERVER as root, from the uploaded project folder:
#   cd /opt/wflow && bash deploy/strato-setup.sh
# (deploy/deploy.sh uploads the project and runs this for you.)
#
# It is safe to run again: an existing .env is kept, only the app is rebuilt.
#   1. installs Docker + the compose plugin, 7-day log retention and a
#      firewall (SSH, HTTP, HTTPS)
#   2. creates .env from .env.production.example with fresh secrets
#   3. builds and starts the app + Caddy (automatic HTTPS for w-flow.tech)
# ============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo bash deploy/strato-setup.sh)." >&2
  exit 1
fi

echo "==> W flow setup in $APP_DIR"

# --- 1. Docker + firewall ----------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  apt-get update -y
  apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Log rotation. Caddy logs every request with the visitor's IP, and Docker's
# default json-file logs grow forever — but the privacy policy promises server
# logs are kept for 7 days. json-file can only rotate by size, so container
# logs go to journald instead, which deletes by age. `docker compose logs`
# keeps working with the journald driver.
RECREATE=""
mkdir -p /etc/systemd/journald.conf.d
if [ ! -f /etc/systemd/journald.conf.d/wflow.conf ]; then
  echo "==> Log retention: 7 days (journald)"
  printf '[Journal]\nMaxRetentionSec=7day\nSystemMaxUse=1G\n' > /etc/systemd/journald.conf.d/wflow.conf
  systemctl restart systemd-journald
fi
if [ ! -f /etc/docker/daemon.json ]; then
  echo "==> Docker logs → journald"
  mkdir -p /etc/docker
  printf '{\n  "log-driver": "journald"\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
  RECREATE="--force-recreate" # the log driver is fixed when a container is created
elif ! grep -q '"log-driver"' /etc/docker/daemon.json; then
  echo "    ! /etc/docker/daemon.json exists without a log-driver — add \"log-driver\": \"journald\" by hand." >&2
fi

if command -v ufw >/dev/null 2>&1 || apt-get install -y ufw >/dev/null 2>&1; then
  echo "==> Firewall: allow SSH, HTTP, HTTPS"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

# --- 2. .env -----------------------------------------------------------------
if [ -f .env ]; then
  echo "==> Keeping the existing .env"
else
  echo "==> Writing .env from .env.production.example"
  cp .env.production.example .env
  KEY="$(openssl rand -hex 32)"
  PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  sed -i "s|^BF_ENCRYPTION_KEY=.*|BF_ENCRYPTION_KEY=$KEY|" .env
  sed -i "s|^BF_ADMIN_PASSWORD=.*|BF_ADMIN_PASSWORD=$PASS|" .env
  chmod 600 .env
  echo
  echo "    Admin panel login:  admin / $PASS"
  echo "    (stored in $APP_DIR/.env — write it down now)"
  echo
fi
mkdir -p data

# --- 3. Build + start ---------------------------------------------------------
echo "==> Building and starting W flow + Caddy"
docker compose --profile proxy up -d --build $RECREATE
# The upload replaces the Caddyfile with a new file, but a running Caddy keeps
# the old one bind-mounted — restart it so Caddyfile changes take effect.
[ -z "$RECREATE" ] && docker compose --profile proxy restart caddy

echo
echo "==> Done. Once the DNS records point at this server, open:"
echo "      https://w-flow.tech"
echo "    Admin panel (from your computer):"
echo "      ssh -L 3002:127.0.0.1:3002 root@<this-server>   then  http://localhost:3002"
echo "    Logs:  docker compose logs -f wflow caddy"
