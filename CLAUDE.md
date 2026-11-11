# TIGERIS AI OS: project rules

AI-Native Sovereign Intelligence Operating System. Institution-owned, model-agnostic, human-authorized.
Decisions come from `docs/decisions/decision-log.md` (200 answers, 10 resolutions). Read it before changing direction.

## Wording rule (enforced by `pnpm lint:wording`)
Never write the words demo, demonstration, prototype, mock, MVP or POC in product code, UI text, tests, file names,
commit messages or docs. Exceptions: this file and `docs/decisions/**`, `docs/adr/**`, which must describe the rule.
Use these terms instead:
- institution-specific sample content: **Sample dataset**
- real public data: **Public record**
- unavailable source: **Source not connected** / **Snapshot as of <date>**
- scenarios: **Scenario simulation**
Test doubles are called fakes or stubs. Never present simulated values as live feeds or as a client's real data.

## Architecture (see docs/adr)
- Modular monolith, TypeScript services; a Python reasoning service comes later behind an internal API.
- PostgreSQL 16 with PostGIS and pgvector. Graph is relational adjacency behind a repository interface.
- Modules: identity, sources, evidence, graph, cases, reasoning, governance, memory, audit. No module reaches into another's tables.
- Row-level security on every institution table. The runtime role is not an owner and has no BYPASSRLS.
- Evidence is immutable. Every protected change writes a hash-chained audit event in the same transaction.
- Deterministic code computes every number. Models never compute or write facts.
- Every displayed number carries the six provenance fields: origin, time and scope, rights and version, transformation, confidence, data class.
- Network egress is deny-by-default with a per-connector allowlist. Never disable TLS verification.
- No execution stack. Actions leave the system only as human-authorized handoffs or adapters into the institution's own systems.
- One deployment per institution. No cross-institution data or learning.

## Working rules
- Migrations are numbered SQL in `db/migrations`, run by the owner role only. The app uses `DATABASE_URL` (restricted role).
- Never commit `.env`. Public sources only until the NDA is signed and a data processing agreement exists.
- Every change ships with tests. Run `pnpm check` before finishing.
- Respect source terms: identify the original agency, keep request rates low, honour robots.txt.

## Modules added since the first release (see docs/adr 0013 to 0026)
`core`, `connectors`, `ingest`, `graph`, `scenario`, `identity`, `cases`, `governance`, `documents`, `sectors`, `settings`, `retention`, `reasoning`, `scheduler`, `setup`, `alerts`. Each exports through its `index.ts`; the API is `apps/api`, the web app `apps/web`.

## More working rules
- A model never writes a record or a figure. Every model reply is verified by code against stored facts and rejected as a whole on any failure. Only public-record, sample and scenario data may be sent to a model.
- Uploads are scanned before they are stored and fail closed. A scan verdict is final.
- A notice sent by email carries a category, a plain reference code and a link, never figures or record content.
- Visible text goes through `t("English text")`; Arabic lives in `apps/web/src/i18n-ar.ts`. Numbers keep Western digits. `tests/web/i18n.test.ts` fails on a missing entry.
- Every environment variable the code reads is listed in `docs/handover/CONFIGURATION.md` (a test checks this). Every route needs an `ACCESS` entry.
- Text and background colours must reach 4.5:1 in both themes (`tests/web/contrast.test.ts`).
- `pnpm check` runs the wording lint, type check and all unit and integration tests; `pnpm e2e` runs the browser suite against the real API. Run both before finishing a change that touches the web app.
- Handover documents live in `docs/handover`. Update them, with the verification report and control matrix, whenever behaviour changes. Say plainly what was not verified.
