#!/usr/bin/env bash
# PostgreSQL archive_command: archive_command = '/opt/tigeris/backup/archive-wal.sh %p %f'
# Copies one finished log segment, encrypted, and never overwrites an archived one.
set -euo pipefail
. "$(dirname "$0")/common.sh"
src="$1"; name="$2"; dest="$BACKUP_DIR/wal/$name.enc"
mkdir -p "$BACKUP_DIR/wal"
[ -f "$dest" ] && exit 0
"${ENC[@]}" -in "$src" -out "$dest.part"
sync "$dest.part" 2>/dev/null || true
mv "$dest.part" "$dest"
