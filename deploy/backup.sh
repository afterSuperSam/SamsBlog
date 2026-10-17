#!/usr/bin/env bash
set -euo pipefail
umask 077

database_path="${BLOG_DATA_DIR:-/srv/samsblog/shared/data}/blog.sqlite"
backup_dir="${BACKUP_DIR:-${BLOG_DATA_DIR:-/srv/samsblog/shared/data}/backups}"
retention_days="${RETENTION_DAYS:-14}"

if [[ ! "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' 'Invalid backup retention days' >&2
  exit 1
fi
if [[ ! -f "$database_path" ]]; then
  printf '%s\n' 'Backup source database does not exist' >&2
  exit 1
fi

database_path="$(realpath "$database_path")"
mkdir -p "$backup_dir"
cd "$backup_dir"
temporary_path="$(mktemp samsblog-backup-XXXXXXXX.partial)"
trap 'rm -f -- "$temporary_path"' EXIT
sqlite3 -readonly "$database_path" ".backup '$temporary_path'"
if [[ "$(sqlite3 -readonly "$temporary_path" 'PRAGMA quick_check;')" != 'ok' ]]; then
  printf '%s\n' 'Backup database integrity check failed' >&2
  exit 1
fi
timestamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
mv -- "$temporary_path" "samsblog-$timestamp.db"
find . -maxdepth 1 -type f -name 'samsblog-*.db' -mtime "+$retention_days" -delete
