#!/usr/bin/env bash
# Prepares a data directory from the backups. It never touches a running database and refuses a non-empty target.
#   restore.sh /var/lib/postgresql/16/restored                      recover to the latest archived moment
#   restore.sh /var/lib/postgresql/16/restored --time "2026-11-10 12:30:00+00"   recover to just before that time
# Then start PostgreSQL on the directory (verify-restore.sh does this on a private port and checks the audit chain).
set -euo pipefail
. "$(dirname "$0")/common.sh"
target="${1:?usage: restore.sh TARGET_DIR [--time \"YYYY-MM-DD HH:MM:SS+00\"]}"; shift || true
when=""; [ "${1:-}" = "--time" ] && when="${2:?--time needs a value}"
[ -d "$target" ] && [ -n "$(ls -A "$target")" ] && { echo "refusing: $target is not empty" >&2; exit 2; }
pick=""
if [ -n "$when" ]; then
  limit="$(date -u -d "$when" +%Y%m%dT%H%M%SZ)"
  for f in $(ls -1 "$BACKUP_DIR"/base/*.tar.gz.enc | sort); do b="$(basename "$f" .tar.gz.enc)"; [[ "$b" < "$limit" ]] && pick="$f"; done
  [ -n "$pick" ] || { echo "no base backup was taken before $when" >&2; exit 1; }
else pick="$(ls -1 "$BACKUP_DIR"/base/*.tar.gz.enc | sort | tail -1)"; fi
b="$(basename "$pick" .tar.gz.enc)"
( cd "$BACKUP_DIR/base" && sha256sum -c "$b.sha256" >/dev/null ) || { echo "the backup $b does not match its checksum; it is damaged" >&2; exit 1; }
# Decrypt and test the archive before anything is created, so a wrong key or damaged file leaves no half-made directory.
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$pick" -out "$work/base.tar.gz" 2>/dev/null || { echo "could not decrypt $b: wrong key or damaged backup" >&2; exit 1; }
tar -tzf "$work/base.tar.gz" >/dev/null 2>&1 || { echo "could not read $b after decrypting: wrong key or damaged backup" >&2; exit 1; }
mkdir -p "$target"; chmod 700 "$target"
tar -xzf "$work/base.tar.gz" -C "$target"
{
  echo "restore_command = 'TIGERIS_BACKUP_ENV=$ENV_FILE $(cd "$(dirname "$0")" && pwd)/restore-wal.sh %f %p'"
  [ -n "$when" ] && echo "recovery_target_time = '$when'"
  echo "recovery_target_action = 'promote'"
  echo "archive_mode = off"
} >> "$target/postgresql.auto.conf"
# Some installs (Debian and Ubuntu packages) keep the configuration files outside the data directory, so the backup has none.
# Write minimal private ones so the directory can start for verification. Use your own production files before serving from it.
if [ ! -f "$target/postgresql.conf" ]; then
  printf "# minimal file written by restore.sh; replace with your production configuration\nlisten_addresses = ''\n" > "$target/postgresql.conf"
  printf "local all all trust\n" > "$target/pg_hba.conf"; : > "$target/pg_ident.conf"
  echo "note: the backup held no configuration files; minimal local-only ones were written. Copy your production postgresql.conf and pg_hba.conf before serving from this directory." >&2
fi
touch "$target/recovery.signal"
echo "restored base backup $b into $target${when:+, recovering to $when}"
