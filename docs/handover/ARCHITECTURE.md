# Architecture

_Confidential. Property of Tiger Capital AI. Prepared for Tiger Capital AI engineers._

## Shape

A TypeScript modular monolith (Node 22, pnpm workspace). One Fastify API (`apps/api`), one React web app (`apps/web`), one PostgreSQL 16 database. Modules live in `packages/*` and talk through typed functions, not network calls.

| Module | Responsibility |
|---|---|
| `core` | Shared types, canonical JSON, provenance fields, secrets from files |
| `connectors` | Polite HTTP client and one connector per source platform; egress allowlist |
| `ingest` | Pipeline (accepted, warned, quarantined, rejected), evidence, series, observations, lineage, audit reads |
| `graph` | Entities and links with link classes, depth-limited traversal, hashed snapshots |
| `scenario` | Six deterministic templates, sensitivity, confidence bands, manifest and results hashes, replay |
| `identity` | Token verification, provisioned principals, roles, permissions, separation of duty |
| `cases` | Case lifecycle, evidence attachment, history |
| `governance` | Policy gate (PASS, HOLD, BLOCK), decisions, handoffs, institutional memory |
| `documents` | Type sniffing, PDF and image text, OCR, queue |
| `sectors` | Versioned signal rules over stored series; signal to case |
| `settings` | Governed settings: draft, active, retired; two-person activation |
| `retention` | Ten-year report, legal holds, case exports with integrity hash |
| `scheduler` | Scheduled ingestion with back-off and auto-pause, source health, cases for stale or failing sources (ADR 0022) |
| `reasoning` | Model-agnostic drafting. A model proposes cited text from stored facts, fixed code verifies every figure and citation, every call is logged (ADR 0021) |

## Data model

Migrations `db/migrations/0001` to `0010`, run only by the owner role. 39 tables. Every institution table has `institution_id`, row-level security enabled and forced, and a policy keyed to `app.institution_id`, which the API sets per transaction through `withTenant`.

Two roles: `tigeris_owner` (owns objects, runs migrations) and `tigeris_app` (runtime; owns nothing, no BYPASSRLS, no DELETE except on `principal_roles`, no TRUNCATE). At start-up the API checks this and refuses to run otherwise (`apps/api/src/startup.ts`).

## Integrity

- **Evidence** is immutable. Changes create new versions. Triggers reject UPDATE and DELETE even from the application role.
- **Audit chain:** a BEFORE INSERT trigger computes a per-institution hash that includes the previous hash. The audit event is written in the same transaction as the change it records. `deploy/backup/verify-audit.sql` re-checks the chain after a restore.
- **Graph links:** database constraints require a rationale for assumed, inferred and sample links, and a deferred trigger requires supporting evidence for observed and sourced links at commit.
- **Scenario runs** store the manifest (inputs, formula version, settings version, graph snapshot) and a results hash. Replay recomputes and compares.
- **Settings** payloads are immutable. Activation needs a second administrator. Hormuz exposure activation writes graph links with the stated link class.

## Request flow

1. nginx terminates TLS, applies rate-limit zones and body limits, serves the web app, and forwards `/api` to the API.
2. The API assigns a request id, applies the in-process rate limiter and security headers.
3. The route's access rule is checked. Every route must have a rule in the `ACCESS` map or the server will not start.
4. The bearer token is verified (signature, issuer, audience, expiry, multi-factor claim). The principal must already be provisioned.
5. The handler opens `withTenant`, runs queries, writes any audit event in the same transaction, and returns.
6. Errors go through a global handler that returns a generic message and the request id.

## Authentication

OIDC bearer tokens. The web app uses the authorization-code flow with PKCE and keeps the token in memory only. Roles map to permissions in `packages/identity/src/permissions.ts`. Decisions, settings activation and policy changes enforce separation of duty.

## Documents

Uploads are sniffed by content, size and page limited, and processed by Poppler and Tesseract through `execFile` with no shell, a clean environment and a temporary directory. An in-process queue resumes after restart. Institution documents are gated by `TIGERIS_CLIENT_DATA_ENABLED`, and production also needs `TIGERIS_CLIENT_DATA_REVIEW_DONE`.

## Malware scanning

Uploads are scanned before they are stored (`packages/documents/src/scan.ts`, ADR 0023). The ClamAV adapter streams the bytes to a daemon on the internal network with the INSTREAM protocol and accepts only an exact clean answer. A flagged file is recorded without its bytes and quarantined; a file with no verdict yet is stored as waiting, unopened, and retried with back-off. A trigger makes a scan verdict final. Institution documents need a configured scanner.

## Web

Ivory design, navy theme, right-to-left aware. Runtime configuration comes from `/config.js` (`window.TIGERIS_CONFIG`), so one image serves any environment. The map uses pre-projected Natural Earth paths built by `scripts/build-geo.mjs`.

## Decisions

`docs/adr` holds twenty architecture decision records. `docs/decisions` holds the 200-answer decision log and the resolutions. Decision 11 (independent penetration test and client review before client data) governs go-live.

## Scheduled ingestion

`packages/scheduler`: the active `ingestion_schedule` setting is synced into `source_schedule` (running state only). Each pass claims one due source atomically, runs the normal ingestion pipeline with the source's connector, and records the outcome (success resets failures; failure backs off; the configured limit pauses the source). `sourceHealth` reads stored facts to classify every source. For scheduled sources that are stale or failing, one case is opened through signal-to-case and owned by the named steward. Every transition writes an audit event.

## Reasoning

`packages/reasoning`: facts are gathered in a transaction (briefing, case evidence, or retrieval over stored facts), numbered F1..Fn and filtered to sendable data classes. The model call happens outside any transaction through an adapter (Claude API, OpenAI-compatible, or the local extractive adapter). `judge` accepts the reply only if every item cites supplied facts and every number matches them. The call, verdict and verified output go to `reasoning_calls` (immutable) with an audit event. The model has no database access and writes nothing.

## Deliberate limits

No execution stack. No cross-institution learning. No high availability in the first release (one node, fast restore). No vessel data until written terms exist.
