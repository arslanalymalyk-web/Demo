#!/usr/bin/env bash
# One-time database bootstrap. Run as a PostgreSQL superuser. Idempotent.
#   ADMIN_URL=postgres://postgres:pw@localhost:5432/postgres OWNER_PASSWORD=... APP_PASSWORD=... scripts/bootstrap-db.sh
# Creates the owner role tigeris_owner (runs migrations), the restricted runtime role tigeris_app (no ownership, no BYPASSRLS),
# the main and test databases, and the extensions. Prints the lines to put in .env.
set -euo pipefail
: "${ADMIN_URL:?set ADMIN_URL to a superuser connection string}" "${OWNER_PASSWORD:?}" "${APP_PASSWORD:?}"
P="${DB_PREFIX:-tigeris}"; HOSTPART="${ADMIN_URL#*@}"; HOSTPART="${HOSTPART%%/*}"
psql() { command psql -v ON_ERROR_STOP=1 -X -q "$@"; }
exists() { [ "$(psql "$ADMIN_URL" -Atc "$1")" = "1" ]; }

# The migrations grant to the role named tigeris_app, so the role names are fixed. DB_PREFIX only renames the databases.
exists "SELECT 1 FROM pg_roles WHERE rolname='tigeris_owner'" || psql "$ADMIN_URL" -c "CREATE ROLE tigeris_owner LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS"
exists "SELECT 1 FROM pg_roles WHERE rolname='tigeris_app'"   || psql "$ADMIN_URL" -c "CREATE ROLE tigeris_app LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
for db in "$P" "${P}_test"; do
  exists "SELECT 1 FROM pg_database WHERE datname='$db'" || psql "$ADMIN_URL" -c "CREATE DATABASE $db OWNER tigeris_owner"
  DBURL="${ADMIN_URL%/*}/$db"
  psql "$DBURL" -c "REVOKE ALL ON DATABASE $db FROM PUBLIC; GRANT CONNECT ON DATABASE $db TO tigeris_app;"
  psql "$DBURL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"   # required: the audit chain uses digest()
  for ext in postgis vector; do psql "$DBURL" -c "CREATE EXTENSION IF NOT EXISTS $ext" 2>/dev/null || echo "note: extension $ext is not installed on this server; it is not needed by the current migrations" >&2; done
done
cat <<ENV
# add to .env
DATABASE_URL_OWNER=postgres://tigeris_owner:${OWNER_PASSWORD}@${HOSTPART}/${P}
DATABASE_URL=postgres://tigeris_app:${APP_PASSWORD}@${HOSTPART}/${P}
DATABASE_URL_TEST_OWNER=postgres://tigeris_owner:${OWNER_PASSWORD}@${HOSTPART}/${P}_test
DATABASE_URL_TEST=postgres://tigeris_app:${APP_PASSWORD}@${HOSTPART}/${P}_test
ENV
