#!/usr/bin/env bash
# Runs a command with the live environment already assembled, so a live run is one line instead of
# six exports and a decryption step.
#
#   scripts/live-env.sh https://<tunnel>.trycloudflare.com npm run test:live
#   scripts/live-env.sh https://<tunnel>.trycloudflare.com npm run test:dev-smoke
#
# Sets both suites' variables, because both describe the same installation:
#   CK_LIVE_API_KEY / CK_LIVE_WS / CK_LIVE_API_BASE  — from `.env.live` (gitignored)
#   CK_LIVE_ADDON_TOKEN, CK_DEV_ADDON_TOKEN          — decrypted from the installation record
#   CK_DEV_WORKSPACE_ID, CK_DEV_ADDON_ID             — the same record's ids
#   CK_LIVE_ADDON_BASE_URL                           — the first argument
#
# The base URL is an argument rather than a stored value because a cloudflared quick tunnel gets a
# new hostname on every start, so there is nothing stable to store.
#
# Requires: `npm run build`, an installed addon on the workspace, and `var/key.hex`.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$#" -lt 2 ]; then
  echo "usage: scripts/live-env.sh <addon-base-url> <command> [args...]" >&2
  exit 2
fi
addon_base_url="$1"
shift

[ -f "$repo/.env.live" ] || { echo "missing $repo/.env.live — copy .env.live.example and fill it in" >&2; exit 1; }
[ -f "$repo/var/key.hex" ] || { echo "missing $repo/var/key.hex — every stored token is undecryptable without it" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. "$repo/.env.live"
set +a

export TOKEN_ENCRYPTION_KEY="$(cat "$repo/var/key.hex")"
export CK_LIVE_ADDON_BASE_URL="$addon_base_url"

# Command substitution into shell variables, never a temp file: the token does not touch disk.
{
  IFS= read -r workspace_id
  IFS= read -r addon_id
  IFS= read -r addon_token
} < <(node "$repo/scripts/read-installation.mjs")

export CK_LIVE_ADDON_TOKEN="$addon_token"
export CK_DEV_WORKSPACE_ID="$workspace_id"
export CK_DEV_ADDON_ID="$addon_id"
export CK_DEV_ADDON_TOKEN="$addon_token"

exec "$@"
