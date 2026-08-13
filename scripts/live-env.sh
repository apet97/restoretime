#!/usr/bin/env bash
# Runs a command with one exact Railway deployment's installation token. The Railway container
# decrypts its own row and returns only a one-use encrypted envelope.
#
#   scripts/live-env.sh https://restoretime.example.up.railway.app npm run test:live:trigger
#   scripts/live-env.sh https://restoretime.example.up.railway.app npm run test:live:release
#
# Sets both suites' variables, because both describe the same installation:
#   CK_LIVE_TARGET / CK_LIVE_API_KEY / CK_LIVE_API_USER_ID / CK_LIVE_WS / CK_LIVE_API_BASE — from `.env.live`
#   CK_LIVE_ADDON_ID / CK_LIVE_ADDON_KEY              — exact installation identity
#   CK_LIVE_CANDIDATE_ID / receipt paths / LV-02 source ID — from `.env.live` for release
#   CK_RAILWAY_*                                     — exact project/environment/service/deployment
#   CK_LIVE_ADDON_TOKEN, CK_DEV_ADDON_TOKEN          — handed off encrypted from Railway
#   CK_DEV_WORKSPACE_ID, CK_DEV_ADDON_ID             — the remote record's ids
#   CK_LIVE_ADDON_BASE_URL                           — the first argument
#
# Requires: Railway CLI login and SSH key access to the exact deployed service.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -lt 2 ]; then
  echo "usage: scripts/live-env.sh <addon-base-url> <command> [args...]" >&2
  exit 2
fi
addon_base_url="$1"
shift

[ -f "$repo/.env.live" ] || { echo "missing $repo/.env.live — copy .env.live.example and fill it in" >&2; exit 1; }

# A caller can invoke this script from a traced shell. Disable xtrace before `.env.live` or the
# encryption key enters a command or variable assignment.
set +x
set -a
# shellcheck disable=SC1091
. "$repo/.env.live"
set +a

required=(
  CK_LIVE_TARGET CK_LIVE_API_KEY CK_LIVE_API_USER_ID CK_LIVE_WS CK_LIVE_ADDON_ID
  CK_LIVE_ADDON_KEY CK_LIVE_API_BASE CK_LIVE_CANDIDATE_ID CK_RAILWAY_PROJECT_ID
  CK_RAILWAY_ENVIRONMENT_ID CK_RAILWAY_SERVICE_ID CK_RAILWAY_DEPLOYMENT_ID
  CK_RAILWAY_DEPLOYMENT_INSTANCE_ID
)
for name in "${required[@]}"; do
  [ -n "${!name:-}" ] || { echo "missing $name in $repo/.env.live" >&2; exit 1; }
done
[ "$CK_LIVE_TARGET" = "developer" ] || {
  echo "CK_LIVE_TARGET must be developer; this mutating suite does not accept an implicit production target" >&2
  exit 1
}
normalized_api_base="${CK_LIVE_API_BASE%/}"
[ "$normalized_api_base" = "https://developer.clockify.me/api" ] || {
  echo "CK_LIVE_API_BASE must be https://developer.clockify.me/api when CK_LIVE_TARGET=developer" >&2
  exit 1
}
export CK_LIVE_API_BASE="$normalized_api_base"

export CK_LIVE_ADDON_BASE_URL="$addon_base_url"

# The handoff targets Railway by explicit IDs. The remote container verifies its Railway system
# variables, candidate ID, public origin, volume path, and exact installation row before it
# encrypts the token to an ephemeral local public key.
exec node "$repo/scripts/railway-live-handoff.mjs" "$@"
