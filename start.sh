#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DISCORD_TOKEN:-}" ]]; then
  echo "ERROR: DISCORD_TOKEN is not configured." >&2
  exit 1
fi

exec node src/index.js
