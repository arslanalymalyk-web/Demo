import type pg from "pg";
import { classify, freshness, type Health, type SeriesFreshness } from "./plan.js";

export interface RunRow { id: string; status: string; trigger: string; startedAt: string; finishedAt: string | null; error: string | null; stats: Record<string, number> }
export interface SourceHealth {
  sourceKey: string; name: string; publisher: string; platform: string; approval: string;
  scheduled: boolean; mode: string | null; intervalHours: number | null; nextRunAt: string | null; paused: boolean; pausedReason: string | null; consecutiveFailures: number; lastError: string | null;
  health: Health; reasons: string[]; series: SeriesFreshness[]; packs: string[];
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastSuccessAgeHours: number | null;
  evidence: { total: number; quarantined: number }; lastRuns: RunRow[]; openCase: { id: string; caseKey: string } | null;
}
const iso = (d: unknown): string | null => d ? new Date(d as string).toISOString() : null;

/** The health of every source, read from stored facts: approval, schedule state, recent runs, series age and quarantine. */
export async function sourceHealth(c: pg.PoolClient, now: Date = new Date()): Promise<SourceHealth[]> {
  const src = (await c.query(
    `SELECT s.id, s.source_key, s.name, s.publisher, s.platform_type, s.status, sc.mode, sc.interval_hours, sc.enabled, sc.next_run_at, sc.paused, sc.paused_reason, sc.consecutive_failures, sc.last_error
     FROM sources s LEFT JOIN source_schedule sc ON sc.source_id = s.id ORDER BY s.source_key`)).rows;
  const jobs = (await c.query(
    `SELECT * FROM (SELECT j.source_id, j.id, j.status, j.trigger, j.started_at, j.finished_at, j.error, j.stats, row_number() OVER (PARTITION BY j.source_id ORDER BY j.started_at DESC) AS rn FROM ingestion_jobs j) q WHERE rn <= 10 ORDER BY source_id, rn`)).rows;
  const lastOk = new Map((await c.query("SELECT source_id, max(finished_at) AS t FROM ingestion_jobs WHERE status = 'completed' GROUP BY source_id")).rows.map(r => [r.source_id as string, r.t as Date]));
  const series = (await c.query(
    `SELECT s.source_id, s.series_key, s.title, s.max_age_days, s.packs, (SELECT max(f.valid_time) FROM evidence_facts f WHERE f.series_id = s.id) AS latest FROM series s ORDER BY s.series_key`)).rows;
  const ev = new Map((await c.query("SELECT source_id, count(*)::int AS total, count(*) FILTER (WHERE validation_status = 'quarantined')::int AS quarantined FROM evidence_objects GROUP BY source_id")).rows.map(r => [r.source_id as string, { total: r.total as number, quarantined: r.quarantined as number }]));
  const cases = (await c.query("SELECT id, case_key, signal->>'id' AS sid FROM cases WHERE state <> 'closed' AND signal->>'id' LIKE 'SRC%'")).rows as { id: string; case_key: string; sid: string }[];

  return src.map(r => {
    const mine = jobs.filter(j => j.source_id === r.id);
    let streak = 0; for (const j of mine) { if (j.status === "failed") streak++; else if (j.status === "completed") break; }
    const sr = series.filter(s => s.source_id === r.id).map(s => freshness({ seriesKey: s.series_key, title: s.title, latestPeriod: iso(s.latest), maxAgeDays: s.max_age_days }, now));
    const scheduled = r.enabled === true, failures = scheduled ? (r.consecutive_failures as number) : streak;
    const ok = lastOk.get(r.id) ?? null, c = classify({ approved: r.status === "approved", paused: scheduled && r.paused === true, failureStreak: failures, series: sr, hasSuccess: ok !== null });
    const oc = cases.find(k => k.sid.startsWith(`SRC1:${r.source_key}:`) || k.sid.startsWith(`SRC2:${r.source_key}:`));
    return {
      sourceKey: r.source_key, name: r.name, publisher: r.publisher, platform: r.platform_type, approval: r.status,
      scheduled, mode: scheduled ? r.mode : null, intervalHours: scheduled ? r.interval_hours : null, nextRunAt: scheduled ? iso(r.next_run_at) : null, paused: scheduled && r.paused === true, pausedReason: scheduled ? r.paused_reason ?? null : null, consecutiveFailures: failures, lastError: scheduled ? r.last_error ?? null : (mine.find(j => j.status === "failed")?.error ?? null),
      health: c.health, reasons: c.reasons, series: sr, packs: [...new Set(series.filter(s => s.source_id === r.id).flatMap(s => s.packs as string[]))].sort(),
      lastAttemptAt: iso(mine[0]?.started_at), lastSuccessAt: iso(ok), lastSuccessAgeHours: ok ? Math.round((now.getTime() - new Date(ok).getTime()) / 3_600_000 * 10) / 10 : null,
      evidence: ev.get(r.id) ?? { total: 0, quarantined: 0 }, openCase: oc ? { id: oc.id, caseKey: oc.case_key } : null,
      lastRuns: mine.map(j => ({ id: j.id, status: j.status, trigger: j.trigger, startedAt: iso(j.started_at)!, finishedAt: iso(j.finished_at), error: j.error ?? null, stats: j.stats ?? {} })),
    };
  });
}
