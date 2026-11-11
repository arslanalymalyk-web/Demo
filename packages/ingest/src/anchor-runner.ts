import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { takeCheckpoint, type Checkpoint } from "./anchor.js";
import { audit, withTenant } from "./store.js";

export interface CheckpointRunnerOptions { pool: pg.Pool; institutionId: string; key: string; dir: string; everyHours: number; checkEveryMs?: number; now?: () => Date; log?: (msg: string, o?: object) => void }

/** Takes a signed audit checkpoint on a schedule and writes it to a folder the institution chose, which should be somewhere the database administrator cannot change (a write-once or remote mount).
 *  The save is recorded in the audit trail only after the file is on disk, so a missing record means a missing file, and an alert follows. */
export class CheckpointRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private o: CheckpointRunnerOptions) {}

  start(): void {
    if (this.timer) return;
    const tick = () => { void this.tick().catch(e => this.o.log?.("audit checkpoint failed", { error: (e as Error).message })); };
    this.timer = setInterval(tick, this.o.checkEveryMs ?? 10 * 60_000); this.timer.unref(); tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Saves a checkpoint if the last one is older than the interval. Returns the file name, or null when none was due. */
  async tick(): Promise<string | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const now = (this.o.now ?? (() => new Date()))();
      const last = await withTenant(this.o.pool, this.o.institutionId, async c => (await c.query("SELECT max((payload->>'at')::timestamptz) AS t FROM audit_events WHERE action = 'audit.checkpoint_saved'")).rows[0].t as Date | null);
      if (last && now.getTime() - last.getTime() < this.o.everyHours * 3_600_000) return null;
      return await this.saveNow(now);
    } finally { this.busy = false; }
  }

  async saveNow(now: Date = (this.o.now ?? (() => new Date()))()): Promise<string> {
    const cp: Checkpoint = await withTenant(this.o.pool, this.o.institutionId, c => takeCheckpoint(c, this.o.institutionId, this.o.key, now));
    await mkdir(this.o.dir, { recursive: true });
    const name = `audit-checkpoint-${now.toISOString().replace(/[:.]/g, "-")}-seq${cp.seq}.json`, tmp = join(this.o.dir, `.${name}.partial`);
    await writeFile(tmp, JSON.stringify(cp, null, 2) + "\n", { mode: 0o444 });
    await rename(tmp, join(this.o.dir, name)); await chmod(join(this.o.dir, name), 0o444);
    await withTenant(this.o.pool, this.o.institutionId, c => audit(c, this.o.institutionId, { actorType: "system", action: "audit.checkpoint_saved", objectType: "audit", objectId: String(cp.seq), payload: { events: cp.events, file: name, at: now.toISOString() } }));
    this.o.log?.("audit checkpoint saved", { file: name, events: cp.events });
    return name;
  }
}
