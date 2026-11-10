import type pg from "pg";
import { audit } from "../../ingest/src/store.js";
import { getPrincipal } from "../../identity/src/index.js";
import { openCaseFromSignal } from "../../cases/src/index.js";
import { effectiveSchedule } from "../../settings/src/index.js";
import { sourceHealth, type SourceHealth } from "./health.js";
import { nextAfterFailure, nextAfterSuccess, shouldPause } from "./plan.js";

export class SchedulerError extends Error { constructor(message: string, readonly code: "not_found" | "conflict" | "invalid") { super(message); } }
export interface Claimed { sourceId: string; sourceKey: string; mode: "catalog" | "series"; intervalHours: number }
const DOMAINS: Record<string, string> = { energy: "energy", sovereign_capital: "sovereign capital" };

/** Brings the running state in line with the active schedule: schedules new sources, updates intervals and stops what was removed or is no longer approved. */
export async function syncSchedule(c: pg.PoolClient, inst: string, now: Date): Promise<void> {
  const { schedule } = await effectiveSchedule(c);
  const keys = Object.keys(schedule.sources);
  const rows = (await c.query("SELECT id, source_key FROM sources WHERE source_key = ANY($1) AND status = 'approved'", [keys])).rows as { id: string; source_key: string }[];
  for (const r of rows) {
    const s = schedule.sources[r.source_key]!;
    await c.query(
      `INSERT INTO source_schedule (institution_id, source_id, mode, interval_hours, enabled, next_run_at) VALUES ($1,$2,$3,$4,true,$5)
       ON CONFLICT (institution_id, source_id) DO UPDATE SET mode = EXCLUDED.mode, interval_hours = EXCLUDED.interval_hours, enabled = true, updated_at = now(),
         next_run_at = CASE WHEN source_schedule.paused THEN NULL WHEN source_schedule.enabled = false THEN EXCLUDED.next_run_at ELSE source_schedule.next_run_at END
       WHERE (source_schedule.mode, source_schedule.interval_hours, source_schedule.enabled) IS DISTINCT FROM (EXCLUDED.mode, EXCLUDED.interval_hours, true)`,
      [inst, r.id, s.mode, s.intervalHours, now.toISOString()]);
  }
  await c.query("UPDATE source_schedule SET enabled = false, next_run_at = NULL, updated_at = now() WHERE enabled AND source_id <> ALL($1::uuid[])", [rows.map(r => r.id)]);
}

/** Takes the next due source, if any. The claim is one atomic update, so two schedulers could never run the same source. */
export async function claimDue(c: pg.PoolClient, now: Date, claimMs: number): Promise<Claimed | null> {
  const r = await c.query(
    `WITH due AS (SELECT institution_id, source_id FROM source_schedule WHERE enabled AND NOT paused AND next_run_at <= $1 AND (claimed_until IS NULL OR claimed_until < $1) ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     UPDATE source_schedule s SET claimed_until = $2, last_attempt_at = $1 FROM due, sources src
     WHERE s.institution_id = due.institution_id AND s.source_id = due.source_id AND src.id = s.source_id
     RETURNING s.source_id, src.source_key, s.mode, s.interval_hours`, [now.toISOString(), new Date(now.getTime() + claimMs).toISOString()]);
  const x = r.rows[0];
  return x ? { sourceId: x.source_id, sourceKey: x.source_key, mode: x.mode, intervalHours: x.interval_hours } : null;
}

export async function recordOutcome(c: pg.PoolClient, inst: string, k: Claimed, o: { ok: true } | { ok: false; error: string }, pauseAfter: number, now: Date): Promise<{ paused: boolean }> {
  if (o.ok) {
    await c.query("UPDATE source_schedule SET consecutive_failures = 0, last_success_at = $2, next_run_at = $3, claimed_until = NULL, last_error = NULL, updated_at = now() WHERE source_id = $1", [k.sourceId, now.toISOString(), nextAfterSuccess(now, k.intervalHours).toISOString()]);
    await audit(c, inst, { actorType: "system", action: "scheduler.run_succeeded", objectType: "source", objectId: k.sourceId, payload: { source: k.sourceKey } });
    return { paused: false };
  }
  const n = ((await c.query("SELECT consecutive_failures AS n FROM source_schedule WHERE source_id = $1", [k.sourceId])).rows[0]?.n as number ?? 0) + 1, pause = shouldPause(n, pauseAfter), error = o.error.slice(0, 500);
  if (pause) await c.query("UPDATE source_schedule SET consecutive_failures = $2, last_error = $3, claimed_until = NULL, next_run_at = NULL, paused = true, paused_reason = $4, paused_at = $5, paused_by = NULL, updated_at = now() WHERE source_id = $1", [k.sourceId, n, error, `Stopped automatically after ${n} failed fetches in a row. A person must resume it.`, now.toISOString()]);
  else await c.query("UPDATE source_schedule SET consecutive_failures = $2, last_error = $3, claimed_until = NULL, next_run_at = $4, updated_at = now() WHERE source_id = $1", [k.sourceId, n, error, nextAfterFailure(now, n, k.intervalHours).toISOString()]);
  await audit(c, inst, { actorType: "system", action: pause ? "scheduler.auto_paused" : "scheduler.run_failed", objectType: "source", objectId: k.sourceId, payload: { source: k.sourceKey, failures: n, error } });
  return { paused: pause };
}

async function scheduled(c: pg.PoolClient, sourceKey: string): Promise<{ id: string; paused: boolean }> {
  const r = (await c.query("SELECT s.id, sc.enabled, sc.paused FROM sources s LEFT JOIN source_schedule sc ON sc.source_id = s.id WHERE s.source_key = $1", [sourceKey])).rows[0];
  if (!r) throw new SchedulerError("source not found", "not_found");
  if (r.enabled !== true) throw new SchedulerError("this source is not in the active ingestion schedule", "conflict");
  return { id: r.id, paused: r.paused === true };
}
export async function requestRun(c: pg.PoolClient, inst: string, actorId: string, sourceKey: string, now: Date): Promise<void> {
  const s = await scheduled(c, sourceKey);
  if (s.paused) throw new SchedulerError("this source is paused; resume it first", "conflict");
  await c.query("UPDATE source_schedule SET next_run_at = $2, claimed_until = NULL, updated_at = now() WHERE source_id = $1 AND (claimed_until IS NULL OR claimed_until < $2)", [s.id, now.toISOString()]);
  await audit(c, inst, { actorType: "principal", actorId, action: "scheduler.run_requested", objectType: "source", objectId: s.id, payload: { source: sourceKey } });
}
export async function pauseSource(c: pg.PoolClient, inst: string, actorId: string, sourceKey: string, reason: string, now: Date): Promise<void> {
  if (reason.trim().length < 10) throw new SchedulerError("say why, in at least 10 characters", "invalid");
  const s = await scheduled(c, sourceKey);
  if (s.paused) throw new SchedulerError("this source is already paused", "conflict");
  await c.query("UPDATE source_schedule SET paused = true, paused_reason = $2, paused_at = $3, paused_by = $4, next_run_at = NULL, updated_at = now() WHERE source_id = $1", [s.id, reason.trim(), now.toISOString(), actorId]);
  await audit(c, inst, { actorType: "principal", actorId, action: "scheduler.paused", objectType: "source", objectId: s.id, payload: { source: sourceKey, reason: reason.trim() } });
}
export async function resumeSource(c: pg.PoolClient, inst: string, actorId: string, sourceKey: string, reason: string, now: Date): Promise<void> {
  if (reason.trim().length < 10) throw new SchedulerError("say why, in at least 10 characters", "invalid");
  const s = await scheduled(c, sourceKey);
  if (!s.paused) throw new SchedulerError("this source is not paused", "conflict");
  await c.query("UPDATE source_schedule SET paused = false, paused_reason = NULL, paused_at = NULL, paused_by = NULL, consecutive_failures = 0, next_run_at = $2, updated_at = now() WHERE source_id = $1", [s.id, now.toISOString()]);
  await audit(c, inst, { actorType: "principal", actorId, action: "scheduler.resumed", objectType: "source", objectId: s.id, payload: { source: sourceKey, reason: reason.trim() } });
}

/** Opens one case per scheduled source that is stale or failing, owned by the steward the schedule names. A case already open for the same condition is reused, and a closed one is not reopened for the same condition. */
export async function raiseHealthCases(c: pg.PoolClient, inst: string, now: Date, health?: SourceHealth[]): Promise<string[]> {
  const { schedule, version } = await effectiveSchedule(c);
  if (!schedule.steward) return [];
  const steward = await getPrincipal(c, schedule.steward);
  if (!steward || steward.disabled) return [];
  const opened: string[] = [];
  for (const h of health ?? await sourceHealth(c, now)) {
    if (!h.scheduled || !["stale", "failing", "paused"].includes(h.health) || h.openCase) continue;
    const stale = h.series.filter(s => s.stale).sort((a, b) => (a.latestPeriod ?? "").localeCompare(b.latestPeriod ?? ""))[0];
    const failing = h.health !== "stale";
    const sid = failing ? `SRC2:${h.sourceKey}:${(h.lastSuccessAt ?? "never").slice(0, 10)}` : `SRC1:${h.sourceKey}:${(stale?.latestPeriod ?? "none").slice(0, 10)}`;
    const r = await openCaseFromSignal(c, inst, { id: steward.id, roles: steward.roles }, {
      signalId: sid, ruleId: failing ? "SRC2" : "SRC1", rulesVersion: "source-health/1", settingsVersion: version,
      title: failing ? `${h.name}: fetching keeps failing` : `${h.name}: data is out of date`,
      objective: `${h.reasons.join(" ")} Decide whether to fix the connection, change the schedule, or accept the gap, and record the reason.`,
      domain: DOMAINS[h.packs[0] ?? ""] ?? "data operations", observedAt: now.toISOString(),
      evidenceIds: [], values: { source: h.sourceKey, health: h.health, failures: h.consecutiveFailures },
    });
    if (!r.existing) { opened.push(r.caseKey); await audit(c, inst, { actorType: "system", action: "scheduler.case_opened", objectType: "case", objectId: r.id, payload: { source: h.sourceKey, signal: sid } }); }
  }
  return opened;
}
