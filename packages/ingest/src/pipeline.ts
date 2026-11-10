import type pg from "pg";
import { hashPayload, type RawRecord } from "../../core/src/index.js";
import type { Connector, PoliteHttp } from "../../connectors/src/index.js";
import { audit, withTenant } from "./store.js";
import { RULES_VERSION, validateRecord, type SourceView } from "./validate.js";

export class SourceNotApprovedError extends Error {}
export interface IngestStats { seen: number; inserted: number; duplicates: number; accepted: number; warned: number; quarantined: number; newVersions: number; facts: number }
export interface IngestDeps { pool: pg.Pool; institutionId: string; sourceKey: string; connector: Connector; http: PoliteHttp; limit?: number; seriesKey?: string; localFile?: string; now?: () => Date; batchSize?: number }

interface SourceRow extends SourceView { id: string; publisher: string; data_class: string; licence_name: string | null; original_agency: string | null }

export async function runIngestion(d: IngestDeps): Promise<IngestStats & { jobId: string }> {
  const now = d.now ?? (() => new Date());
  const batchSize = d.batchSize ?? 50;

  const { source, jobId } = await withTenant(d.pool, d.institutionId, async c => {
    const r = await c.query(`SELECT id, status, licence_verified, base_url, publisher, data_class, licence_name, original_agency, EXTRACT(EPOCH FROM freshness_limit)*1000 AS freshness_limit_ms FROM sources WHERE source_key = $1`, [d.sourceKey]);
    const row = r.rows[0];
    if (!row) throw new Error(`unknown source ${d.sourceKey}`);
    if (row.status !== "approved") {
      await audit(c, d.institutionId, { actorType: "system", action: "ingestion.refused", objectType: "source", objectId: row.id, payload: { source: d.sourceKey, status: row.status } });
      return { source: row as SourceRow, jobId: null as string | null };
    }
    const job = await c.query("INSERT INTO ingestion_jobs (institution_id, source_id) VALUES ($1,$2) RETURNING id", [d.institutionId, row.id]);
    await audit(c, d.institutionId, { actorType: "system", action: "ingestion.started", objectType: "ingestion_job", objectId: job.rows[0].id, payload: { source: d.sourceKey, limit: d.limit ?? null } });
    return { source: { ...row, freshness_limit_ms: Number(row.freshness_limit_ms) } as SourceRow, jobId: job.rows[0].id as string };
  });
  if (!jobId) throw new SourceNotApprovedError(`source ${d.sourceKey} is ${source.status}; ingestion refused`);

  const stats: IngestStats = { seen: 0, inserted: 0, duplicates: 0, accepted: 0, warned: 0, quarantined: 0, newVersions: 0, facts: 0 };
  let batch: RawRecord[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const records = batch; batch = [];
    await withTenant(d.pool, d.institutionId, async c => {
      for (const rec of records) {
        const hash = hashPayload(rec.payload);
        const v = validateRecord(rec, source, now());
        const prev = await c.query("SELECT COALESCE(MAX(version),0) AS v FROM evidence_objects WHERE source_id=$1 AND external_key=$2", [source.id, rec.externalKey]);
        const version = Number(prev.rows[0].v) + 1;
        const ins = await c.query(
          `INSERT INTO evidence_objects (institution_id, source_id, job_id, external_key, original_agency, source_url, event_time, retrieved_at, raw_hash, version, data_class, licence_name, transformation, payload, validation_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::data_class,$12,$13,$14,$15::validation_outcome)
           ON CONFLICT (institution_id, source_id, external_key, raw_hash) DO NOTHING RETURNING id`,
          [d.institutionId, source.id, jobId, rec.externalKey, rec.originalAgency ?? source.original_agency, rec.sourceUrl ?? null, rec.eventTime ?? null, now().toISOString(), hash, version, source.data_class, source.licence_name, rec.transformation ?? "none", JSON.stringify(rec.payload), v.outcome],
        );
        stats.seen++;
        if (ins.rowCount === 0) { stats.duplicates++; continue; }
        stats.inserted++; if (version > 1) stats.newVersions++;
        stats[v.outcome === "accepted" ? "accepted" : v.outcome === "warned" ? "warned" : "quarantined"]++;
        const evId = ins.rows[0].id as string;
        await c.query("INSERT INTO validation_runs (institution_id, evidence_id, rules_version, checks, outcome, reason) VALUES ($1,$2,$3,$4,$5::validation_outcome,$6)", [d.institutionId, evId, RULES_VERSION, JSON.stringify(v.checks), v.outcome, v.reason]);
        if (v.outcome !== "quarantined" && rec.facts?.length) {
          let seriesId: string | null = null;
          if (rec.series) {
            const sr = await c.query(
              `INSERT INTO series (institution_id, source_id, series_key, title, description, frequency, packs, max_age_days, query) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (institution_id, series_key) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, frequency=EXCLUDED.frequency, packs=EXCLUDED.packs, max_age_days=EXCLUDED.max_age_days, query=EXCLUDED.query RETURNING id`,
              [d.institutionId, source.id, rec.series.key, rec.series.title, rec.series.description ?? null, rec.series.frequency, rec.series.packs, rec.series.maxAgeDays ?? null, JSON.stringify(rec.series.query)]);
            seriesId = sr.rows[0].id as string;
          }
          for (let i = 0; i < rec.facts.length; i += 1500) {
            const chunk = rec.facts.slice(i, i + 1500).map(f => ({ subject: f.subject, predicate: f.predicate, value: f.value, unit: f.unit ?? null, unit_stated: f.unitStated ?? true, valid_time: f.validTime ?? null, dims: f.dims ?? {} }));
            await c.query(
              `INSERT INTO evidence_facts (institution_id, evidence_id, series_id, subject, predicate, value, unit, unit_stated, valid_time, dims, claim_class, confidence_basis, extraction_version)
               SELECT $1,$2,$3,x.subject,x.predicate,x.value,x.unit,x.unit_stated,x.valid_time,x.dims,'observed',$4::jsonb,$5
               FROM jsonb_to_recordset($6::jsonb) AS x(subject text, predicate text, value jsonb, unit text, unit_stated boolean, valid_time timestamptz, dims jsonb)`,
              [d.institutionId, evId, seriesId, JSON.stringify({ origin: "publisher series", validation: v.outcome }), "observations/1", JSON.stringify(chunk)]);
          }
          stats.facts += rec.facts.length;
        }
        const count = rec.payload.records_count;
        if (v.outcome !== "quarantined" && typeof count === "number") {
          await c.query("INSERT INTO evidence_facts (institution_id, evidence_id, subject, predicate, value, unit, valid_time, claim_class, confidence_basis, extraction_version) VALUES ($1,$2,$3,'catalog.records_count',$4,'records',$5,'observed',$6,'catalog-facts/1')",
            [d.institutionId, evId, rec.externalKey, JSON.stringify(count), rec.eventTime ?? null, JSON.stringify({ origin: "publisher metadata" })]);
        }
      }
    });
  };

  try {
    for await (const rec of d.connector.fetchRecords({ baseUrl: source.base_url, http: d.http, ...(d.limit !== undefined ? { limit: d.limit } : {}), ...(d.seriesKey ? { seriesKey: d.seriesKey } : {}), ...(d.localFile ? { localFile: d.localFile } : {}) })) {
      batch.push(rec);
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    await withTenant(d.pool, d.institutionId, async c => {
      await c.query("UPDATE ingestion_jobs SET status='completed', finished_at=now(), stats=$2 WHERE id=$1", [jobId, JSON.stringify(stats)]);
      await audit(c, d.institutionId, { actorType: "system", action: "ingestion.completed", objectType: "ingestion_job", objectId: jobId, payload: { source: d.sourceKey, ...stats } });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await withTenant(d.pool, d.institutionId, async c => {
      await c.query("UPDATE ingestion_jobs SET status='failed', finished_at=now(), stats=$2, error=$3 WHERE id=$1", [jobId, JSON.stringify(stats), msg]);
      await audit(c, d.institutionId, { actorType: "system", action: "ingestion.failed", objectType: "ingestion_job", objectId: jobId, payload: { source: d.sourceKey, error: msg, ...stats } });
    });
    throw e;
  }
  return { ...stats, jobId };
}
