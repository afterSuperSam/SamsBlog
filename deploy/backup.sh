#!/usr/bin/env bash
set -euo pipefail

database_path="${DATABASE_PATH:-/srv/samsblog/shared/data/blog.sqlite}"
backup_dir="${BACKUP_DIR:-/srv/samsblog/shared/data/backups}"
retention_days="${RETENTION_DAYS:-14}"

mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
sqlite3 "$database_path" ".backup '$backup_dir/samsblog-$timestamp.db'"
find "$backup_dir" -type f -name 'samsblog-*.db' -mtime "+$retention_days" -delete
