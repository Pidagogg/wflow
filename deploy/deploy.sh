#!/usr/bin/env bash
# ============================================================================
# W FLOW — upload this project to the STRATO VPS and (re)start it.
#
# Run from the project folder on YOUR computer (Git Bash on Windows works):
#   bash deploy/deploy.sh
#
# Needs deploy/vps.env (copy deploy/vps.env.example and fill in the VPS IP).
# The server's .env and data/ folder are never overwritten — only the code.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f deploy/vps.env ]; then
  echo "Missing deploy/vps.env — copy deploy/vps.env.example and fill in VPS_HOST." >&2
  exit 1
fi
# shellcheck disable=SC1091
source deploy/vps.env
: "${VPS_HOST:?Set VPS_HOST in deploy/vps.env}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
VPS_DIR="${VPS_DIR:-/opt/wflow}"

SSH_OPTS=(-p "$VPS_PORT" -o StrictHostKeyChecking=accept-new)
[ -n "${VPS_SSH_KEY:-}" ] && SSH_OPTS+=(-i "$VPS_SSH_KEY")
TARGET="$VPS_USER@$VPS_HOST"

echo "==> Packing the project"
ARCHIVE="$(mktemp -t wflow-XXXXXX).tar.gz"
tar -czf "$ARCHIVE" \
  --exclude=./node_modules --exclude=./dist --exclude=./data \
  --exclude=./.git --exclude=./.env --exclude=./deploy/vps.env \
  --exclude=./.check --exclude=./TESTWORKFLOW --exclude='./bug screens' \
  --exclude='*.log' --exclude=./.public-mirror \
  --exclude=./docs/marketing --exclude='./docs/vertrag checkdomain' \
  .

echo "==> Uploading to $TARGET:$VPS_DIR"
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$VPS_DIR'"
scp -P "$VPS_PORT" ${VPS_SSH_KEY:+-i "$VPS_SSH_KEY"} -o StrictHostKeyChecking=accept-new "$ARCHIVE" "$TARGET:$VPS_DIR/release.tar.gz"
rm -f "$ARCHIVE"

echo "==> Unpacking and starting on the server"
ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$VPS_DIR' && tar -xzf release.tar.gz && rm release.tar.gz && bash deploy/strato-setup.sh"
