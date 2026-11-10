# TIGERIS AI OS: handover pack

_Confidential. Property of Tiger Capital AI. Prepared for the named recipients only._

TIGERIS AI OS is an institution-owned, model-agnostic intelligence system where every figure opens to its source and every protected change is recorded in a tamper-evident trail. This pack hands the build over to four audiences.

| If you are… | Start here | Then |
|---|---|---|
| **An executive or investor** | [EXECUTIVE-SUMMARY.md](EXECUTIVE-SUMMARY.md) | [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md), [OPEN-ITEMS.md](OPEN-ITEMS.md) |
| **A Tiger Capital AI engineer** | [ARCHITECTURE.md](ARCHITECTURE.md) | [ENGINEERING.md](ENGINEERING.md), `docs/adr/`, `docs/decisions/` |
| **The client's IT or security team** | [DEPLOYMENT.md](DEPLOYMENT.md) | [SECURITY.md](SECURITY.md), [DATA-FLOWS.md](DATA-FLOWS.md), [CONTROL-MATRIX.md](CONTROL-MATRIX.md), [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) |
| **An operator who runs it daily** | [RUNBOOK.md](RUNBOOK.md) | [BACKUP-RESTORE.md](BACKUP-RESTORE.md) |

## What is in the repository

| Path | Contents |
|---|---|
| `apps/api` | The HTTP API (Fastify). Every route has an access rule. |
| `apps/web` | The web interface (React, Vite). Ivory design, navy theme, right-to-left layout. |
| `packages/*` | The modules: `core`, `connectors`, `ingest`, `graph`, `scenario`, `identity`, `cases`, `governance`, `documents`, `sectors`, `settings`, `retention`, `reasoning`, `scheduler` |
| `db/migrations` | Thirteen numbered SQL migrations, run by the owner role only |
| `deploy/` | Container, proxy, database and backup files |
| `docs/adr`, `docs/decisions` | Twenty-three architecture decision records and the 200-answer decision log with its resolutions |
| `tests/` | 264 tests |
| `scripts/` | Database bootstrap, SBOM and licence check, offline bundle, geography build |

## Rules that bind everyone (from `CLAUDE.md`)

- Deterministic code computes every number. Models never compute or write facts.
- Every displayed number carries six provenance fields: origin, time and scope, rights and version, transformation, confidence, data class.
- Evidence is immutable. Every protected change writes a hash-chained audit event in the same transaction.
- Row-level security on every institution table; the runtime role owns nothing and cannot bypass it.
- Network egress is deny-by-default. Never disable TLS verification.
- No execution stack. Actions leave the system only as human-authorized handoffs into the institution's own systems.
- One deployment per institution. No cross-institution data or learning.
- Wording: simulated content is labelled **Scenario simulation**, institution-specific sample content **Sample dataset**, real public data **Public record**, unavailable sources **Source not connected** or **Snapshot as of <date>**. `pnpm lint:wording` enforces this.

## Status in one paragraph

The core and two packs (Energy and Oil, Sovereign Capital and Treasury, three scenario templates each) are built and tested on real public data. Client data is not connected and institution documents are switched off until the client's security review. Read [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md) for what was proved and what was not, and [OPEN-ITEMS.md](OPEN-ITEMS.md) for what is needed from people.
