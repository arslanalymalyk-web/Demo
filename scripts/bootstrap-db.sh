#!/usr/bin/env bash
# One-time database bootstrap. Run as a PostgreSQL superuser. Idempotent.
#   ADMIN_URL=postgres://postgres:pw@localhost:5432/postgres OWNER_PASSWORD=... APP_PASSWORD=... scripts/bootstrap-db.sh
# Creates the owner role (runs migrations), the restricted runtime role (no ownership, no BYPASSRLS),
# the main and test databases, and the extensions. Prints the lines to put in .env.
set -euo pipefail
: "${ADMIN_URL:?set ADMIN_URL to a superuser connection string}" "${OWNER_PASSWORD:?}" "${APP_PASSWORD:?}"
P="${DB_PREFIX:-tigeris}"; HOSTPART="${ADMIN_URL#*@}"; HOSTPART="${HOSTPART%%/*}"
psql() { command psql -v ON_ERROR_STOP=1 -X -q "$@"; }
exists() { [ "$(psql "$ADMIN_URL" -Atc "$1")" = "1" ]; }

exists "SELECT 1 FROM pg_roles WHERE rolname='${P}_owner'" || psql "$ADMIN_URL" -c "CREATE ROLE ${P}_owner LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS"
exists "SELECT 1 FROM pg_roles WHERE rolname='${P}_app'"   || psql "$ADMIN_URL" -c "CREATE ROLE ${P}_app LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
for db in "$P" "${P}_test"; do
  exists "SELECT 1 FROM pg_database WHERE datname='$db'" || psql "$ADMIN_URL" -c "CREATE DATABASE $db OWNER ${P}_owner"
  DBURL="${ADMIN_URL%/*}/$db"
  psql "$DBURL" -c "REVOKE ALL ON DATABASE $db FROM PUBLIC; GRANT CONNECT ON DATABASE $db TO ${P}_app;"
  psql "$DBURL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"   # required: the audit chain uses digest()
  for ext in postgis vector; do psql "$DBURL" -c "CREATE EXTENSION IF NOT EXISTS $ext" 2>/dev/null || echo "note: extension $ext is not installed on this server; it is not needed by the current migrations" >&2; done
done
cat <<ENV
# add to .env
DATABASE_URL_OWNER=postgres://${P}_owner:${OWNER_PASSWORD}@${HOSTPART}/${P}
DATABASE_URL=postgres://${P}_app:${APP_PASSWORD}@${HOSTPART}/${P}
DATABASE_URL_TEST_OWNER=postgres://${P}_owner:${OWNER_PASSWORD}@${HOSTPART}/${P}_test
DATABASE_URL_TEST=postgres://${P}_app:${APP_PASSWORD}@${HOSTPART}/${P}_test
ENV
