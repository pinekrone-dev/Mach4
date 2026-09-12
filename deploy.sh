#!/usr/bin/env bash
# One-command deploy from a machine that can read keys.conf.
#
#   ./deploy.sh                      # finds keys.conf by walking up from here
#   KEYS_CONF=/path/to/keys.conf ./deploy.sh
#   CLOUDFLARE_API_TOKEN=... ./deploy.sh
#
# Credential values are read straight into the environment and never printed.

set -euo pipefail
cd "$(dirname "$0")"

# Pull a value out of keys.conf. Tolerates KEY=value, KEY: value, KEY = value,
# optional quotes, and ignores comments.
read_key() {
  local file=$1 name=$2
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*[=:][[:space:]]*[\"']?([^\"'#]*[^\"'# ])[\"']?[[:space:]]*$/\2/p" \
    "$file" | head -1
}

find_keys_conf() {
  [ -n "${KEYS_CONF:-}" ] && { echo "$KEYS_CONF"; return; }
  local dir="$PWD"
  for _ in 1 2 3 4 5 6; do
    [ -f "$dir/keys.conf" ] && { echo "$dir/keys.conf"; return; }
    dir=$(dirname "$dir")
  done
}

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  conf=$(find_keys_conf)
  if [ -n "$conf" ] && [ -f "$conf" ]; then
    echo "reading credentials from $conf"
    for name in CLOUDFLARE_API_TOKEN CF_API_TOKEN CLOUDFLARE_TOKEN; do
      v=$(read_key "$conf" "$name") || true
      [ -n "$v" ] && { export CLOUDFLARE_API_TOKEN="$v"; break; }
    done
    for name in CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID CLOUDFLARE_ACCOUNT; do
      v=$(read_key "$conf" "$name") || true
      [ -n "$v" ] && { export CLOUDFLARE_ACCOUNT_ID="$v"; break; }
    done
  fi
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat >&2 <<'MSG'
No Cloudflare API token found.

Point at the file explicitly:
    KEYS_CONF=/path/to/keys.conf ./deploy.sh

or export it for this shell:
    export CLOUDFLARE_API_TOKEN=...   # Workers Scripts:Edit
    ./deploy.sh

The token is expected under one of: CLOUDFLARE_API_TOKEN, CF_API_TOKEN,
CLOUDFLARE_TOKEN. See docs/DEPLOY.md.
MSG
  exit 1
fi

# A 32-hex string is an account id, not a token. Used as a credential it
# answers error 6111, which reads like a broken token and is not one.
if [[ "${CLOUDFLARE_API_TOKEN}" =~ ^[0-9a-fA-F]{32}$ ]]; then
  echo "That value is 32 hex chars — an account id, not an API token." >&2
  exit 1
fi

echo "verifying the token value itself (a listing can say ACTIVE while the value is dead)"
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  # Account-owned tokens verify at the account endpoint; /user/tokens/verify
  # answers "Invalid API Token" for a perfectly good account token.
  ok=$(curl -s "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/verify" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | grep -o '"success":[a-z]*' | head -1)
  echo "  ${ok:-no response}"
fi

./stage.sh
npx --yes wrangler@latest deploy

BASE="https://missfits.shiny-butterfly-2b90.workers.dev"
echo
echo "waiting for the edge to settle, then verifying by status and content type"
sleep 15
fail=0
check() {
  out=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 20 "$BASE$1")
  echo "  $1 -> $out"
  case "$out" in $2*) ;; *) fail=1 ;; esac
}
check /            200
check /styles.css  200
check /src/main.js 200
check /no-such-page 404

echo
if [ "$fail" = 0 ]; then
  echo "live: $BASE"
  echo "next: attach planning.realestateaistudio.com in the dashboard"
  echo "      Workers & Pages -> missfits -> Settings -> Domains & Routes"
else
  echo "deployed, but a check did not match — see the lines above" >&2
  exit 1
fi
