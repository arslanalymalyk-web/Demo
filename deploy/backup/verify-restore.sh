#!/usr/bin/env bash
# Starts a restored data directory privately (no network listener), waits for recovery to finish, checks the audit chain and
# the table count, then stops it. Run as the postgres user.  verify-restore.sh DATA_DIR [DATABASE]
set -euo pipefail
dir="${1:?usage: verify-restore.sh DATA_DIR [DATABASE]}"; db="${2:-tigeris}"
# Debian and Ubuntu keep the PostgreSQL programs out of PATH; container images usually have them in it.
if ! command -v pg_ctl >/dev/null; then pgbin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"; [ -n "$pgbin" ] && PATH="$pgbin:$PATH"; fi
command -v pg_ctl >/dev/null || { echo "pg_ctl not found; set PATH to the PostgreSQL bin directory" >&2; exit 2; }
sock="$(mktemp -d)"; chmod 700 "$sock"; port=55432
trap 'pg_ctl -D "$dir" -m fast stop >/dev/null 2>&1 || true; rm -rf "$sock"' EXIT
pg_ctl -D "$dir" -o "-p $port -c listen_addresses='' -c unix_socket_directories=$sock -c archive_mode=off" -l "$sock/log" -w -t 120 start >/dev/null || { echo "PostgreSQL could not start on the restored directory:" >&2; tail -25 "$sock/log" >&2; exit 1; }
for i in $(seq 1 120); do [ "$(psql -h "$sock" -p $port -d postgres -Atc 'SELECT pg_is_in_recovery()' 2>/dev/null || echo t)" = "f" ] && break; sleep 1; done
[ "$(psql -h "$sock" -p $port -d postgres -Atc 'SELECT pg_is_in_recovery()')" = "f" ] || { echo "recovery did not finish; see $sock/log" >&2; tail -20 "$sock/log" >&2; exit 1; }
tables="$(psql -h "$sock" -p $port -d "$db" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
echo "recovered; $tables tables in $db"
bad=0
while IFS='|' read -r inst events ok; do echo "institution $inst: $events audit events, chain $([ "$ok" = t ] && echo intact || echo BROKEN)"; [ "$ok" = t ] || bad=1; done < <(psql -h "$sock" -p $port -d "$db" -At -F'|' -f "$(dirname "$0")/verify-audit.sql")
[ $bad -eq 0 ] || { echo "the audit chain is broken in this restore" >&2; exit 1; }
echo "restore verified"
