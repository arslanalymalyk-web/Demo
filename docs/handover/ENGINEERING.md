# Engineering guide

_Confidential. Property of Tiger Capital AI. Prepared for Tiger Capital AI engineers._

## Set up

Requirements: Node 22, pnpm 10.28.0, PostgreSQL 16 with PostGIS and pgcrypto (pgvector optional), Poppler and Tesseract (with `eng` and `ara`) for document intake.

```bash
pnpm install
cp .env.example .env   # never commit .env
./scripts/bootstrap-db.sh
```

`bootstrap-db.sh` always creates the roles `tigeris_owner` and `tigeris_app` (migrations rely on those names), the databases `tigeris` and `tigeris_test`, and the extensions. Then run migrations as the owner role and seed. See the scripts in `package.json` and `.env.example` for exact variable names.

## Run

Use the scripts in `package.json` (`web`, `web:build`, `dev-idp` for a development identity provider, and the module scripts). The API reads configuration through `apps/api/src/config.ts`, which reports every problem at once and supports `*_FILE` for secrets.

## Check

```bash
pnpm check
```

Runs the wording lint, the type check and all tests. Database tests need `DATABASE_URL_TEST_OWNER` and `DATABASE_URL_TEST`; without them those suites are skipped, so set them before trusting a pass. Also run `pnpm audit` and `pnpm sbom:check` before release.

## Conventions

- Every number is computed by deterministic code and carries the six provenance fields.
- Every protected write is one transaction that also writes the audit event.
- Never build SQL by string concatenation. Parameterise.
- Never add a DELETE or TRUNCATE grant. A test reads the grants.
- Every route gets an entry in the `ACCESS` map. The server will not start without it.
- Every change ships with tests. Tests for tenancy create two institutions and look for leaks.
- Test doubles are called fakes or stubs.

## Wording rule

`pnpm lint:wording` forbids the words that frame the product as unfinished or as an exhibit. It scans code, UI text, tests, file names and docs, except `CLAUDE.md`, `docs/decisions/**` and `docs/adr/**`. Use **Scenario simulation**, **Sample dataset**, **Public record**, **Source not connected** and **Snapshot as of <date>**.

## How to add things

- **A migration:** add the next numbered file in `db/migrations`. Enable and force row-level security on any institution table, add the policy, grant only what the runtime role needs, and add triggers for immutability. Add a test for isolation and grants.
- **A source:** insert a `sources` row with publisher, original agency, platform, licence name and `licence_verified`. Respect the source's terms and robots.txt. Do not set `licence_verified` without evidence.
- **A connector:** implement the `Connector` interface (`platform`, `fetchRecords`) in `packages/connectors`, use `PoliteHttp`, and add the host to the egress allowlist. Test with a fake.
- **A scenario template:** add it in `packages/scenario` with a formula version, defaults, sensitivity and confidence components. Never change a published formula in place; add a new version so old runs replay.
- **A signal rule:** add it in `packages/sectors` under a rule-set version. Thresholds are governed settings, not constants.
- **A route:** add the handler in `apps/api/src/server.ts`, add its permission in `permissions.ts`, add its `ACCESS` entry, and test allow and deny.
- **A governed setting scope:** extend `packages/settings`, with a validator and a consumer that records the version used.

## Releasing

Run `pnpm check`, `pnpm audit`, `pnpm sbom` and `pnpm sbom:check`. Build the offline bundle with `scripts/offline-bundle.sh` when the client has no internet. CI (`.github/workflows/ci.yml`) has a `check` job and an `images` job. Neither has run on GitHub yet; run them and fix what they find.
