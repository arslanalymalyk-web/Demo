/** Timing and classification rules for scheduled ingestion. Pure functions, so the rules can be tested without a clock or a database. */
export const FIRST_RETRY_MINUTES = 15;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** After a failure the next try comes sooner than the normal interval, so a short outage heals quickly, and then backs off: 15, 30, 60, 120 minutes and so on, never past the normal interval. */
export function retryDelayMs(failures: number, intervalHours: number): number {
  const f = Math.max(1, Math.floor(failures));
  return Math.min(FIRST_RETRY_MINUTES * MIN * 2 ** Math.min(f - 1, 16), intervalHours * HOUR);
}
export const nextAfterSuccess = (now: Date, intervalHours: number): Date => new Date(now.getTime() + intervalHours * HOUR);
export const nextAfterFailure = (now: Date, failures: number, intervalHours: number): Date => new Date(now.getTime() + retryDelayMs(failures, intervalHours));
export const shouldPause = (failures: number, limit: number): boolean => failures >= limit;

export type Health = "healthy" | "stale" | "failing" | "paused" | "no_data" | "not_approved";
export const FAILING_AFTER = 3;
export interface SeriesFreshness { seriesKey: string; title: string; latestPeriod: string | null; maxAgeDays: number | null; ageDays: number | null; stale: boolean }

export function freshness(s: { seriesKey: string; title: string; latestPeriod: string | null; maxAgeDays: number | null }, now: Date): SeriesFreshness {
  const age = s.latestPeriod ? Math.floor((now.getTime() - new Date(s.latestPeriod).getTime()) / DAY) : null;
  return { ...s, ageDays: age, stale: s.latestPeriod === null ? s.maxAgeDays !== null : s.maxAgeDays !== null && age! > s.maxAgeDays };
}

export interface ClassifyInput { approved: boolean; paused: boolean; failureStreak: number; series: SeriesFreshness[]; hasSuccess: boolean }
/** One word for a source, in order of what matters most, and the reasons behind it. */
export function classify(i: ClassifyInput): { health: Health; reasons: string[] } {
  if (!i.approved) return { health: "not_approved", reasons: ["The source is not approved, so nothing is fetched from it."] };
  const stale = i.series.filter(s => s.stale);
  const reasons: string[] = [];
  if (i.paused) reasons.push("Scheduled fetching is paused.");
  if (i.failureStreak >= FAILING_AFTER) reasons.push(`The last ${i.failureStreak} fetches failed.`);
  for (const s of stale) reasons.push(s.latestPeriod ? `${s.title}: latest period is ${s.ageDays} days old; this series allows ${s.maxAgeDays}.` : `${s.title}: no data is stored.`);
  if (i.paused) return { health: "paused", reasons };
  if (i.failureStreak >= FAILING_AFTER) return { health: "failing", reasons };
  if (stale.length) return { health: "stale", reasons };
  if (i.series.length === 0 && !i.hasSuccess) return { health: "no_data", reasons: ["Nothing has been fetched from this source yet."] };
  return { health: "healthy", reasons: [] };
}
