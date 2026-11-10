#!/bin/sh
# Sourced by the nginx image entrypoint before it renders the templates (hence the 15- prefix and no executable bit),
# so the variables exported here reach the templates. Writes the web app's runtime settings and fails fast on a missing one.
set -eu
: "${OIDC_AUTHORITY:?OIDC_AUTHORITY is required}" "${OIDC_CLIENT_ID:?OIDC_CLIENT_ID is required}" "${SERVER_NAME:?SERVER_NAME is required}"
case "$OIDC_AUTHORITY" in https://*) ;; *) echo "OIDC_AUTHORITY must start with https://" >&2; exit 1;; esac
OIDC_AUTHORITY_ORIGIN="$(echo "$OIDC_AUTHORITY" | sed -E 's#^(https://[^/]+).*#\1#')"
export OIDC_AUTHORITY_ORIGIN API_UPSTREAM="${API_UPSTREAM:-http://app:3000}"
# json-escape by refusing characters that would need it
case "$OIDC_AUTHORITY$OIDC_CLIENT_ID" in *\"*|*\\*|*\'*|*"<"*) echo "illegal character in OIDC settings" >&2; exit 1;; esac
printf 'window.TIGERIS_CONFIG = { oidcAuthority: "%s", oidcClientId: "%s" };\n' "$OIDC_AUTHORITY" "$OIDC_CLIENT_ID" > /usr/share/nginx/html/config.js
