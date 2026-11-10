import type pg from "pg";

export interface ObservedFact { subject: string; predicate: string; value: number; unit: string | null; validTime: string; evidenceId: string; version: number; validation: string }

/** Latest evidence version of each point of a series, read inside a tenant transaction. Non-numeric and quarantined values are skipped. */
export async function readObservations(c: pg.PoolClient, seriesKey: string, opts: { subjects?: string[]; from?: string; to?: string } = {}): Promise<ObservedFact[]> {
  const r = await c.query(
    `SELECT * FROM (SELECT DISTINCT ON (f.subject, f.predicate, f.valid_time) f.subject, f.predicate, f.value, f.unit, f.valid_time, f.evidence_id, e.version, e.validation_status
       FROM evidence_facts f JOIN series s ON s.id = f.series_id JOIN evidence_objects e ON e.id = f.evidence_id
       WHERE s.series_key = $1 AND e.validation_status <> 'quarantined' AND ($2::text[] IS NULL OR f.subject = ANY($2)) AND ($3::timestamptz IS NULL OR f.valid_time >= $3) AND ($4::timestamptz IS NULL OR f.valid_time <= $4)
       ORDER BY f.subject, f.predicate, f.valid_time, e.version DESC) t ORDER BY subject, predicate, valid_time`,
    [seriesKey, opts.subjects ?? null, opts.from ?? null, opts.to ?? null]);
  return r.rows.filter(x => typeof x.value === "number").map(x => ({ subject: x.subject, predicate: x.predicate, value: x.value as number, unit: x.unit, validTime: new Date(x.valid_time).toISOString(), evidenceId: x.evidence_id, version: x.version, validation: x.validation_status }));
}

export interface EvidenceBrief { id: string; sourceKey: string; sourceName: string; sourceStatus: string; validation: string; dataClass: string; externalKey: string; title: string | null; eventTime: string | null; retrievedAt: string; version: number }

/** Validation, class and source approval for a set of evidence records. Other modules use this instead of reading evidence tables. */
export async function evidenceBriefs(c: pg.PoolClient, ids: string[]): Promise<EvidenceBrief[]> {
  if (ids.length === 0) return [];
  const r = await c.query(
    `SELECT e.id, s.source_key, s.name AS source_name, s.status AS source_status, e.validation_status, e.data_class, e.external_key, e.payload->>'title' AS title, e.event_time, e.retrieved_at, e.version
     FROM evidence_objects e JOIN sources s ON s.id = e.source_id WHERE e.id = ANY($1::uuid[])`, [ids]);
  return r.rows.map(x => ({ id: x.id, sourceKey: x.source_key, sourceName: x.source_name, sourceStatus: x.source_status, validation: x.validation_status, dataClass: x.data_class, externalKey: x.external_key, title: x.title ?? null, eventTime: x.event_time ? new Date(x.event_time).toISOString() : null, retrievedAt: new Date(x.retrieved_at).toISOString(), version: x.version }));
}

export interface SeriesStatus { seriesKey: string; title: string; frequency: string; maxAgeDays: number | null; latestPeriod: string | null; validation: string | null; evidenceId: string | null; sourceKey: string }
/** The series tagged for a pack, with the age of their latest period. */
export async function seriesStatusForPack(c: pg.PoolClient, pack: string): Promise<SeriesStatus[]> {
  const r = await c.query(
    `SELECT s.series_key, s.title, s.frequency, s.max_age_days, src.source_key, MAX(f.valid_time) AS latest, le.validation_status, le.id AS evidence_id
     FROM series s JOIN sources src ON src.id = s.source_id LEFT JOIN evidence_facts f ON f.series_id = s.id
     LEFT JOIN LATERAL (SELECT e.id, e.validation_status FROM evidence_objects e WHERE e.id IN (SELECT evidence_id FROM evidence_facts WHERE series_id = s.id) ORDER BY e.retrieved_at DESC, e.version DESC LIMIT 1) le ON true
     WHERE $1 = ANY(s.packs) GROUP BY s.id, src.source_key, le.validation_status, le.id ORDER BY s.series_key`, [pack]);
  return r.rows.map(x => ({ seriesKey: x.series_key, title: x.title, frequency: x.frequency, maxAgeDays: x.max_age_days, latestPeriod: x.latest ? new Date(x.latest).toISOString() : null, validation: x.validation_status, evidenceId: x.evidence_id, sourceKey: x.source_key }));
}

export interface StoredFact { evidenceId: string; dataClass: string; subject: string; predicate: string; value: unknown; unit: string | null; validTime: string | null }
const toFact = (x: { evidence_id: string; data_class: string; subject: string; predicate: string; value: unknown; unit: string | null; valid_time: Date | null }): StoredFact =>
  ({ evidenceId: x.evidence_id, dataClass: x.data_class, subject: x.subject, predicate: x.predicate, value: x.value, unit: x.unit, validTime: x.valid_time ? new Date(x.valid_time).toISOString() : null });

/** The stored facts behind a set of evidence records, newest first. Quarantined and rejected records are never returned. */
export async function factsForEvidence(c: pg.PoolClient, ids: string[], perEvidence = 12): Promise<StoredFact[]> {
  if (ids.length === 0) return [];
  const r = await c.query(
    `SELECT * FROM (SELECT f.evidence_id, e.data_class, f.subject, f.predicate, f.value, f.unit, f.valid_time, row_number() OVER (PARTITION BY f.evidence_id ORDER BY f.valid_time DESC NULLS LAST, f.subject, f.predicate) AS rn
       FROM evidence_facts f JOIN evidence_objects e ON e.id = f.evidence_id WHERE f.evidence_id = ANY($1::uuid[]) AND e.validation_status IN ('accepted','warned')) q
     WHERE rn <= $2 ORDER BY evidence_id, rn`, [ids, perEvidence]);
  return r.rows.map(toFact);
}

/** The newest stored facts whose subject or predicate contains any of the words. Used to ground a free-text question. */
export async function searchFacts(c: pg.PoolClient, words: string[], limit = 20): Promise<StoredFact[]> {
  const ws = words.map(w => w.replace(/[%_\\]/g, "").toLowerCase()).filter(w => w.length >= 3).slice(0, 6);
  if (ws.length === 0) return [];
  const r = await c.query(
    `SELECT f.evidence_id, e.data_class, f.subject, f.predicate, f.value, f.unit, f.valid_time
     FROM evidence_facts f JOIN evidence_objects e ON e.id = f.evidence_id
     WHERE e.validation_status IN ('accepted','warned') AND EXISTS (SELECT 1 FROM unnest($1::text[]) w WHERE lower(f.subject) LIKE '%' || w || '%' OR lower(f.predicate) LIKE '%' || w || '%')
     ORDER BY f.valid_time DESC NULLS LAST LIMIT $2`, [ws, limit]);
  return r.rows.map(toFact);
}
