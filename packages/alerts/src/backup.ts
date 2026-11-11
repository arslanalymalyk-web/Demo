import type pg from "pg";

export type BackupState = "off" | "ok" | "overdue" | "failing" | "never";
export interface BackupStatus { state: BackupState; maxAgeHours: number; lastOkAt: string | null; lastOkAgeHours: number | null; lastFailedAt: string | null; failedLast24h: number }

/** Whether base backups are happening, read from the record the backup script writes. 0 hours turns monitoring off.
 *  failing: the newest run failed. overdue: the newest good run is older than the limit. never: none was ever recorded and the deployment is older than the limit. */
export async function backupStatus(c: pg.PoolClient, now: Date, maxAgeHours: number): Promise<BackupStatus> {
  const empty = { maxAgeHours, lastOkAt: null, lastOkAgeHours: null, lastFailedAt: null, failedLast24h: 0 };
  if (!maxAgeHours) return { state: "off", ...empty };
  const r = (await c.query(
    `SELECT (SELECT max(finished_at) FROM backup_runs WHERE status = 'ok') AS ok_at,
            (SELECT max(finished_at) FROM backup_runs WHERE status = 'failed') AS failed_at,
            (SELECT count(*)::int FROM backup_runs WHERE status = 'failed' AND finished_at > $1) AS failed_24h,
            (SELECT min(created_at) FROM institutions) AS since`, [new Date(now.getTime() - 86_400_000).toISOString()])).rows[0];
  const ok = r.ok_at ? new Date(r.ok_at) : null, failed = r.failed_at ? new Date(r.failed_at) : null;
  const age = ok ? Math.round((now.getTime() - ok.getTime()) / 360_000) / 10 : null;
  const base = { maxAgeHours, lastOkAt: ok?.toISOString() ?? null, lastOkAgeHours: age, lastFailedAt: failed?.toISOString() ?? null, failedLast24h: r.failed_24h as number };
  if (failed && (!ok || failed > ok)) return { state: "failing", ...base };
  if (ok) return { state: age! > maxAgeHours ? "overdue" : "ok", ...base };
  const since = r.since ? new Date(r.since) : now;
  return { state: now.getTime() - since.getTime() > maxAgeHours * 3_600_000 ? "never" : "ok", ...base };
}
