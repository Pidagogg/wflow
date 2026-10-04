#!/usr/bin/env bash
# W FLOW — one-click launcher (Linux / macOS)
# Starts the server and opens http://localhost:3001 in your default browser.
set -e
cd "$(dirname "$0")"

echo
echo "   ============================================"
echo "    W FLOW - self-hosted workflow builder"
echo "   ============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "   [ERROR] Node.js is not installed. Install it from https://nodejs.org"
  exit 1
fi

# Already running? Just open the browser.
if curl -s -o /dev/null http://localhost:3001/api/nodes 2>/dev/null; then
  echo "   The app is already running. Opening browser..."
  open_browser
  exit 0
fi

[ -d node_modules ] || { echo "   First run: installing dependencies..."; npm install; }
[ -d dist ] || { echo "   First run: building the website..."; npm run build; }

echo "   Starting the server..."
npm start &
SERVER_PID=$!

tries=0
until curl -s -o /dev/null http://localhost:3001/api/nodes 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -ge 25 ] && { echo "   [WARN] Server did not answer in time - opening browser anyway."; break; }
  sleep 1
done

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:3001
  elif command -v open >/dev/null 2>&1; then open http://localhost:3001
  else echo "   Open http://localhost:3001 in your browser."
  fi
}
open_browser

echo
echo "   Server is running. Press Ctrl+C here to stop it."
wait "$SERVER_PID"
