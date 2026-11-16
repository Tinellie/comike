#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")/.."
[[ "${CONFIRM_RESTORE:-}" == comike ]] || { echo "This overwrites the Comike database/files. Set CONFIRM_RESTORE=comike to confirm." >&2; exit 1; }
source_dir="$(realpath "${1:?Pass the exported bundle directory}")"
[[ -s "$source_dir/database.sql" ]] || { echo "Missing database export: $source_dir/database.sql" >&2; exit 1; }
for name in storage map ref; do
  archive="$source_dir/$name.tar.gz"
  [[ -s "$archive" ]] || { echo "Missing data archive: $archive" >&2; exit 1; }
  listing="$(tar -tzf "$archive")"
  if grep -E '(^/|(^|/)\.\.(/|$))' <<< "$listing" > /dev/null; then echo "Unsafe archive paths: $archive" >&2; exit 1; fi
  if ! tar -tvzf "$archive" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}'; then
    echo "Archive contains unsupported links or entries: $archive" >&2
    exit 1
  fi
done
if [[ -n "$(bash deploy/compose.sh ps --status running --services app)" ]]; then
  echo "Stop the app before restoring: bash deploy/compose.sh stop app" >&2
  exit 1
fi
mkdir -p data/storage data/map data/ref data/state
bash deploy/compose.sh up -d --wait --wait-timeout 180 db
bash deploy/backup.sh database
bash deploy/compose.sh exec -T db sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u "$MYSQL_USER" "$MYSQL_DATABASE"' < "$source_dir/database.sql"
for name in storage map ref; do
  tar --no-same-owner --no-same-permissions -xzf "$source_dir/$name.tar.gz" -C "data/$name"
done
echo "Data restored. Run deploy/deploy.sh with an image digest to migrate and start the application."
