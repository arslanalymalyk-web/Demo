import type pg from "pg";
import type { Provenance, ValidationOutcome } from "../../core/src/index.js";

export interface Lineage { evidenceId: string; provenance: Provenance; validationRuns: unknown[]; facts: unknown[]; job: unknown; payload: unknown }

/** Everything needed to open a figure to its source: the six provenance fields plus checks, facts and the ingestion job. */
export async function getLineage(c: pg.PoolClient, evidenceId: string): Promise<Lineage | null> {
  const r = await c.query(
    `SELECT e.*, s.publisher, s.licence_verified, s.original_agency AS source_agency FROM evidence_objects e JOIN sources s ON s.id = e.source_id WHERE e.id = $1`, [evidenceId]);
  const e = r.rows[0]; if (!e) return null;
  const runs = (await c.query("SELECT rules_version, checks, outcome, reason, created_at FROM validation_runs WHERE evidence_id=$1 ORDER BY created_at", [evidenceId])).rows;
  const facts = (await c.query("SELECT subject, predicate, value, unit, valid_time, claim_class, confidence_basis, extraction_version FROM evidence_facts WHERE evidence_id=$1", [evidenceId])).rows;
  const job = (await c.query("SELECT id, status, started_at, finished_at, stats FROM ingestion_jobs WHERE id=$1", [e.job_id])).rows[0] ?? null;
  const provenance: Provenance = {
    origin: { publisher: e.publisher, originalAgency: e.original_agency ?? e.source_agency ?? null, sourceUrl: e.source_url ?? null, recordKey: e.external_key },
    timeAndScope: { eventTime: e.event_time ? new Date(e.event_time).toISOString() : null, retrievedAt: new Date(e.retrieved_at).toISOString() },
    rightsAndVersion: { licence: e.licence_name ?? null, licenceVerified: e.licence_verified, rawHash: e.raw_hash, version: e.version },
    transformation: e.transformation,
    confidence: { validation: e.validation_status as ValidationOutcome, checks: runs.at(-1)?.checks ?? [] },
    dataClass: e.data_class,
  };
  return { evidenceId, provenance, validationRuns: runs, facts, job, payload: e.payload };
}

/** Recomputes the audit hash chain for the institution in scope. */
export async function verifyAuditChain(c: pg.PoolClient): Promise<{ ok: boolean; events: number; firstBadSeq: number | null }> {
  const r = await c.query(`
    SELECT seq,
      (prev_hash = COALESCE(lag(hash) OVER (ORDER BY seq), repeat('0', 64))) AS linked,
      (hash = encode(digest(prev_hash || institution_id::text || seq::text || actor_type || COALESCE(actor_id,'') || action || COALESCE(object_type,'') || COALESCE(object_id,'') || payload::text, 'sha256'), 'hex')) AS intact
    FROM audit_events ORDER BY seq`);
  const bad = r.rows.find(x => !x.linked || !x.intact);
  return { ok: !bad, events: r.rowCount ?? 0, firstBadSeq: bad ? Number(bad.seq) : null };
}
