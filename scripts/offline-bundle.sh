#!/usr/bin/env bash
# Builds a bundle a client can install with no internet: the source at the current commit, every npm package the lockfile needs,
# the built web app, the SBOM and checksums. Run from a clean checkout on a connected machine.
#   scripts/offline-bundle.sh            writes dist-offline/tigeris-<commit>-offline.tar.gz
# On the client's side:  tar xzf ...; cd tigeris-*/; pnpm install --offline --frozen-lockfile --store-dir ../pnpm-store
# Container images are moved separately: docker save tigeris-app tigeris-web | gzip > images.tar.gz   and   docker load < images.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
git diff --quiet && git diff --cached --quiet || { echo "refusing: the working tree has uncommitted changes, so the bundle would not match a commit" >&2; exit 1; }
commit="$(git rev-parse --short HEAD)"; name="tigeris-$commit"; out="dist-offline"; work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$out" "$work/$name"
git archive HEAD | tar -x -C "$work/$name"
pnpm fetch --store-dir "$work/pnpm-store"
pnpm -s sbom >/dev/null && cp -r docs/handover/sbom "$work/$name/sbom"
pnpm -s web:build >/dev/null && cp -r apps/web/dist "$work/$name/web-dist"
mv "$work/pnpm-store" "$work/$name/../pnpm-store" 2>/dev/null || true
( cd "$work" && tar -czf "$OLDPWD/$out/$name-offline.tar.gz" "$name" pnpm-store )
( cd "$out" && sha256sum "$name-offline.tar.gz" > "$name-offline.sha256" )
echo "wrote $out/$name-offline.tar.gz ($(du -h "$out/$name-offline.tar.gz" | cut -f1)); checksum in $out/$name-offline.sha256"
