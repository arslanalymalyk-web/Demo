#!/bin/bash
# Runs once, when the database volume is first created (docker-entrypoint-initdb.d). Creates the two roles and the database.
# The owner role runs migrations. The runtime role owns nothing and cannot bypass row-level security.
set -euo pipefail
OWNER_PW="$(cat "${OWNER_PASSWORD_FILE:?}")"; APP_PW="$(cat "${APP_PASSWORD_FILE:?}")"
[ "${#OWNER_PW}" -ge 16 ] && [ "${#APP_PW}" -ge 16 ] || { echo "database passwords must be at least 16 characters" >&2; exit 1; }
psql -v ON_ERROR_STOP=1 -X --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE tigeris_owner LOGIN PASSWORD '$OWNER_PW' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE tigeris_app LOGIN PASSWORD '$APP_PW' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE tigeris OWNER tigeris_owner;
REVOKE ALL ON DATABASE tigeris FROM PUBLIC;
GRANT CONNECT ON DATABASE tigeris TO tigeris_app;
SQL
psql -v ON_ERROR_STOP=1 -X --username "$POSTGRES_USER" --dbname tigeris -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
for ext in postgis vector; do psql -X --username "$POSTGRES_USER" --dbname tigeris -c "CREATE EXTENSION IF NOT EXISTS $ext" 2>/dev/null || echo "note: extension $ext is not available in this image"; done
