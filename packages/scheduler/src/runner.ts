import type pg from "pg";
import { connectorFor, PoliteHttp } from "../../connectors/src/index.js";
import { runIngestion } from "../../ingest/src/pipeline.js";
import { withTenant } from "../../ingest/src/store.js";
import { effectiveSchedule } from "../../settings/src/index.js";
import { claimDue, raiseHealthCases, recordOutcome, syncSchedule, type Claimed } from "./service.js";

export type RunJob = (k: { sourceKey: string; mode: "catalog" | "series" }) => Promise<void>;
export interface SchedulerOptions { pool: pg.Pool; institutionId: string; run: RunJob; tickMs?: number; claimMs?: number; runTimeoutMs?: number; maxRunsPerTick?: number; now?: () => Date; log?: (msg: string, o?: object) => void }
export interface TickResult { ran: { source: string; ok: boolean; error?: string }[]; casesOpened: string[] }

/** Runs one scheduled source ingestion at a time, in this process. One deployment is one node; the atomic claim in the database also keeps a second instance from running the same source. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<TickResult> | null = null;
  lastTickAt: Date | null = null;
  constructor(private o: SchedulerOptions) {}
  get running(): boolean { return this.current !== null; }
  get tickSeconds(): number { return Math.round((this.o.tickMs ?? 60_000) / 1000); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(e => this.o.log?.("scheduler tick failed", { error: (e as Error).message })); }, this.o.tickMs ?? 60_000);
    this.timer.unref();
    void this.tick().catch(e => this.o.log?.("scheduler tick failed", { error: (e as Error).message }));
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.idle(); }
  async idle(): Promise<void> { while (this.current) await this.current.catch(() => undefined); }

  /** One pass: sync the schedule, run everything that is due, then raise cases for sources that are stale or failing. Overlapping calls share the pass in progress. */
  tick(): Promise<TickResult> {
    if (this.current) return this.current;
    const p = this.pass().finally(() => { if (this.current === p) this.current = null; });
    this.current = p; return p;
  }

  private async pass(): Promise<TickResult> {
    const o = this.o, now = o.now ?? (() => new Date()), inst = o.institutionId, out: TickResult = { ran: [], casesOpened: [] };
    await withTenant(o.pool, inst, c => syncSchedule(c, inst, now()));
    const pauseAfter = (await withTenant(o.pool, inst, c => effectiveSchedule(c))).schedule.pauseAfterFailures;
    for (let n = 0; n < (o.maxRunsPerTick ?? 10); n++) {
      const k: Claimed | null = await withTenant(o.pool, inst, c => claimDue(c, now(), o.claimMs ?? 30 * 60_000));
      if (!k) break;
      let error: string | null = null;
      try {
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("the run took too long and was given up on")), o.runTimeoutMs ?? 30 * 60_000); timer.unref(); });
        try { await Promise.race([o.run({ sourceKey: k.sourceKey, mode: k.mode }), limit]); } finally { clearTimeout(timer); }
      } catch (e) { error = e instanceof Error ? e.message : String(e); }
      const r = await withTenant(o.pool, inst, c => recordOutcome(c, inst, k, error === null ? { ok: true } : { ok: false, error }, pauseAfter, now()));
      out.ran.push({ source: k.sourceKey, ok: error === null, ...(error ? { error } : {}) });
      o.log?.(error === null ? "scheduled ingestion finished" : "scheduled ingestion failed", { source: k.sourceKey, ...(error ? { error, paused: r.paused } : {}) });
    }
    out.casesOpened = await withTenant(o.pool, inst, c => raiseHealthCases(c, inst, now()));
    this.lastTickAt = now();
    return out;
  }
}

/** The real job: one ingestion run of a source with its connector, through the same pipeline the command line uses. */
export function ingestJob(pool: pg.Pool, institutionId: string, http: () => PoliteHttp = () => new PoliteHttp()): RunJob {
  return async ({ sourceKey, mode }) => {
    const platform = await withTenant(pool, institutionId, async c => (await c.query("SELECT platform_type FROM sources WHERE source_key = $1", [sourceKey])).rows[0]?.platform_type as string | undefined);
    const connector = platform ? connectorFor(platform, mode, sourceKey) : undefined;
    if (!connector) throw new Error(`no ${mode} connector for source ${sourceKey}`);
    await runIngestion({ pool, institutionId, sourceKey, connector, http: http(), trigger: "scheduled" });
  };
}
