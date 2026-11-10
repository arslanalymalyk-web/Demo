#!/usr/bin/env bash
# PostgreSQL restore_command during recovery: restore_command = '/opt/tigeris/backup/restore-wal.sh %f %p'
set -euo pipefail
. "$(dirname "$0")/common.sh"
name="$1"; dest="$2"; src="$BACKUP_DIR/wal/$name.enc"
[ -f "$src" ] || exit 1
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$src" -out "$dest"
