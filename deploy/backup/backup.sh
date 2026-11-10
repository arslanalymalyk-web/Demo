#!/usr/bin/env bash
# Daily base backup. Run from cron or a systemd timer as a role allowed to take base backups (REPLICATION), e.g. the postgres user.
# Together with continuous log archiving (archive-wal.sh) this allows recovery to any moment since the oldest kept base backup.
set -euo pipefail
. "$(dirname "$0")/common.sh"
mkdir -p "$BACKUP_DIR/base" "$BACKUP_DIR/wal"
ts="$(date -u +%Y%m%dT%H%M%SZ)"; work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pg_basebackup -D "$work/b" -Ft -z -X none -c fast -l "tigeris-$ts"
[ -s "$work/b/base.tar.gz" ] || { echo "the base backup is empty" >&2; exit 1; }
tar -xzOf "$work/b/base.tar.gz" backup_label > "$BACKUP_DIR/base/$ts.label"
"${ENC[@]}" -in "$work/b/base.tar.gz" -out "$BACKUP_DIR/base/$ts.tar.gz.enc"
( cd "$BACKUP_DIR/base" && sha256sum "$ts.tar.gz.enc" > "$ts.sha256" )
# Prune. Keep the newest two base backups whatever their age, and the archived log segments the oldest kept backup still needs.
mapfile -t all < <(ls -1 "$BACKUP_DIR"/base/*.tar.gz.enc | sort)
cutoff="$(date -u -d "-$KEEP_DAYS days" +%Y%m%dT%H%M%SZ)"
if [ "${#all[@]}" -gt 2 ]; then for f in "${all[@]:0:$(( ${#all[@]} - 2 ))}"; do b="$(basename "$f" .tar.gz.enc)"; if [[ "$b" < "$cutoff" ]]; then rm -f "$f" "$BACKUP_DIR/base/$b.sha256" "$BACKUP_DIR/base/$b.label"; fi; done; fi
oldest="$(ls -1 "$BACKUP_DIR"/base/*.label | sort | head -1)"
keepfrom="$(sed -n 's/^START WAL LOCATION: .*(file \(.*\))$/\1/p' "$oldest")"
if [ -n "$keepfrom" ]; then for w in "$BACKUP_DIR"/wal/*.enc; do [ -e "$w" ] || continue; n="$(basename "$w" .enc)"; [[ "$n" =~ ^[0-9A-F]{24}$ && "$n" < "$keepfrom" ]] && rm -f "$w"; done; fi
echo "backup $ts done: $(du -h "$BACKUP_DIR/base/$ts.tar.gz.enc" | cut -f1), oldest kept backup $(basename "$oldest" .label)"
