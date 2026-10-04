#!/usr/bin/env bash
# W FLOW — ADMIN panel launcher (Linux / macOS)
# Starts the isolated admin server on http://localhost:3002 and opens it in
# your default browser. The panel requires login and is NOT reachable from the
# main self-hosted site.
set -e
cd "$(dirname "$0")"

echo
echo "   ============================================"
echo "    W FLOW - ADMIN PANEL"
echo "    Restricted area - login required"
echo "   ============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "   [ERROR] Node.js is not installed. Install it from https://nodejs.org"
  exit 1
fi

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:3002
  elif command -v open >/dev/null 2>&1; then open http://localhost:3002
  else echo "   Open http://localhost:3002 in your browser."
  fi
}

# Already running? Just open the browser.
if curl -s -o /dev/null http://localhost:3002/ 2>/dev/null; then
  echo "   The admin panel is already running. Opening browser..."
  open_browser
  exit 0
fi

[ -d node_modules ] || { echo "   First run: installing dependencies..."; npm install; }

echo "   Starting the admin server..."
node server/admin.js &
SERVER_PID=$!

tries=0
until curl -s -o /dev/null http://localhost:3002/ 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -ge 25 ] && { echo "   [WARN] Admin server did not answer in time - opening browser anyway."; break; }
  sleep 1
done

open_browser

echo
echo "   Log in with your admin credentials to reach the panel."
echo "   Press Ctrl+C here to stop the admin server."
wait "$SERVER_PID"