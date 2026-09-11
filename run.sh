#!/usr/bin/env bash
# Serve the app. ES modules need HTTP, so file:// will not work.
set -e
PORT="${1:-8080}"
cd "$(dirname "$0")"
echo "SitePlanner -> http://localhost:${PORT}/"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
else
  echo "Need python3 or npx to serve static files." >&2
  exit 1
fi
