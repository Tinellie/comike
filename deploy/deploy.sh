#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")/.."
image="${1:-}"
[[ "$image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || { echo "Pass an immutable ghcr.io image digest." >&2; exit 1; }
[[ -f .env ]] || { echo "Missing .env; copy .env.example and configure it first." >&2; exit 1; }
if grep -q 'CHANGE_ME' .env; then echo "Replace all .env placeholders first." >&2; exit 1; fi
exec 9>.deploy.lock
flock -n 9 || { echo "Another deployment is running." >&2; exit 1; }
docker network inspect gateway > /dev/null
for file in data/map/final.json data/map/result.json; do
  [[ -s "$file" ]] || { echo "Missing map data: $file. Restore the local export first." >&2; exit 1; }
done
previous=""
if [[ -f .release.env ]]; then previous="$(sed -n 's/^COMIKE_IMAGE=//p' .release.env)"; fi
compose() { COMIKE_IMAGE="$image" docker compose --env-file .env "$@"; }
compose config --quiet
compose pull app db
compose up -d --wait --wait-timeout 180 db
stopped=false
recover() {
  status=$?
  trap - EXIT
  if [[ "$status" != 0 && "$stopped" == true ]]; then
    echo "Deployment failed. Database migrations are NOT automatically rolled back." >&2
    if ! compose logs --tail=80 app; then echo "Could not read app logs." >&2; fi
    if [[ -n "$previous" ]]; then
      echo "Attempting to restart the previous application image." >&2
      if ! COMIKE_IMAGE="$previous" docker compose --env-file .env up -d --no-deps --wait --wait-timeout 180 app; then
        echo "Previous image could not start; inspect logs and the database backup." >&2
      fi
    fi
  fi
  exit "$status"
}
trap recover EXIT
stopped=true
compose stop app
bash deploy/backup.sh database
compose run --rm --no-deps app seed
compose run --rm --no-deps app migrate
compose run --rm --no-deps app browser-check
compose up -d --no-deps --wait --wait-timeout 180 app
printf 'COMIKE_IMAGE=%s\n' "$image" > .release.env.tmp
if [[ -f .release.env ]]; then cp .release.env .release.env.previous; fi
mv .release.env.tmp .release.env
stopped=false
compose ps
echo "Comike deployed: $image"
