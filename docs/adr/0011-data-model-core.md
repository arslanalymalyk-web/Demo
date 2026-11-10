# ADR 0011: Core data model and audit

Status: Accepted

## Decision

PostgreSQL 16 with PostGIS and pgvector. Row-level security on every institution table, forced, with a runtime role that is not an owner and has no BYPASSRLS. Evidence and validation results are immutable. Audit events are hash-chained per institution, written in the same transaction as the change.

## Why

Implements the TRD invariants: fail closed, append-only, replayable.
