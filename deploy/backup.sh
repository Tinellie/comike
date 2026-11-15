#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")/.."
mode="${1:-database}"
[[ "$mode" == database || "$mode" == full ]] || { echo "Usage: backup.sh [database|full]" >&2; exit 1; }
mkdir -p backups
base="backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
bash deploy/compose.sh exec -T db sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -u "$MYSQL_USER" --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF --hex-blob "$MYSQL_DATABASE"' \
  | gzip > "$base.sql.gz.partial"
mv "$base.sql.gz.partial" "$base.sql.gz"
if [[ "$mode" == full ]]; then
  tar -czf "$base.files.tar.gz.partial" data/storage data/map data/ref data/state
  mv "$base.files.tar.gz.partial" "$base.files.tar.gz"
fi
echo "Backup saved: $base"
