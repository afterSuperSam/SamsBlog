#!/usr/bin/env bash
set -euo pipefail
umask 077

exec "${NODE_BINARY:-node}" "$(dirname "${BASH_SOURCE[0]}")/backup.mjs" "$@"
