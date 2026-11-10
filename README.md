# TIGERIS AI OS

Institution-owned intelligence platform. See `CLAUDE.md` for rules and `docs/decisions` for the decision record.

## Commands
- `pnpm install`
- `pnpm migrate` apply database migrations (owner role)
- `pnpm ingest -- --source <key>` pull one registered source
- `pnpm dev` start the API
- `pnpm check` wording check, type check and tests

## Run the whole thing locally
1. `pnpm migrate`, then `pnpm setup apply --name "Local" --jurisdiction SA --admin admin1 --admin admin2` (it prints the institution id for `.env`; it also seeds the policy and the source registry)
2. `pnpm dev-idp` (development identity provider only) and `pnpm dev` (API; needs the `OIDC_*` variables)
3. Sign in as one of those administrators; add other people under Administration, and open Readiness to see what is still open
4. `pnpm web` and open http://127.0.0.1:5173

OCR needs Tesseract with English and Arabic language data and poppler-utils on the host.
