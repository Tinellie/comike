#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "Missing .env; copy .env.example and configure it first." >&2; exit 1; }
if [[ -f .release.env ]]; then
  exec docker compose --env-file .env --env-file .release.env "$@"
fi
exec docker compose --env-file .env "$@"
