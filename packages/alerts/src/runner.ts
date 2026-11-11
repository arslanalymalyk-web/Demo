import type pg from "pg";
import { verifyAuditChain } from "../../ingest/src/lineage.js";
import { withTenant } from "../../ingest/src/store.js";
import type { Context } from "./conditions.js";
import { plan, record, type EngineConfig, type Outcome } from "./engine.js";
import { MailError, type Mailer } from "./mailer.js";
import { render } from "./templates.js";

export interface RunnerOptions { pool: pg.Pool; institutionId: string; mailer: Mailer; engine: EngineConfig; baseUrl: string; scanner?: () => Promise<{ configured: boolean; reachable: boolean }>; tickMs?: number; auditEveryMs?: number; now?: () => Date; log?: (msg: string, o?: object) => void }
export interface AlertTick { planned: number; sent: number; failed: number; skipped: number }

/** Looks for conditions that need a person once a minute and sends the notices that are due. One pass at a time, in this process. */
export class AlertRunner {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<AlertTick> | null = null;
  private auditCheck: { at: number; ok: boolean } | null = null;
  lastTickAt: Date | null = null;
  constructor(private o: RunnerOptions) {}

  start(): void {
    if (this.timer) return;
    const go = () => { void this.tick().catch(e => this.o.log?.("alert pass failed", { error: (e as Error).message })); };
    this.timer = setInterval(go, this.o.tickMs ?? 60_000); this.timer.unref(); go();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.idle(); }
  async idle(): Promise<void> { while (this.current) await this.current.catch(() => undefined); }
  tick(): Promise<AlertTick> {
    if (this.current) return this.current;
    const p = this.pass().finally(() => { if (this.current === p) this.current = null; });
    this.current = p; return p;
  }

  private async context(now: Date): Promise<Context> {
    const every = this.o.auditEveryMs ?? 6 * 3_600_000;
    if (!this.auditCheck || now.getTime() - this.auditCheck.at >= every) this.auditCheck = { at: now.getTime(), ok: (await withTenant(this.o.pool, this.o.institutionId, c => verifyAuditChain(c))).ok };
    return { auditOk: this.auditCheck.ok, scanner: this.o.scanner ? await this.o.scanner().catch(() => null) : null };
  }

  private async pass(): Promise<AlertTick> {
    const o = this.o, now = (o.now ?? (() => new Date()))(), inst = o.institutionId;
    const ctx = await this.context(now);
    const planned = await withTenant(o.pool, inst, c => plan(c, inst, ctx, o.engine, now));
    const results = new Map<string, Outcome>();
    let down: string | null = null; // once the relay cannot be reached, the rest of this pass fails fast instead of waiting on each person
    for (const p of planned) for (const r of p.recipients) {
      const k = `${p.key}|${p.kind}|${r.principalId}`;
      if (!r.email) { results.set(k, { status: "skipped", reason: "this person has no email address" }); continue; }
      if (down) { results.set(k, { status: "failed", reason: down }); continue; }
      try { const m = render({ category: p.category, kind: p.kind, ref: p.ref, link: p.link, baseUrl: o.baseUrl }); results.set(k, { status: "sent", messageId: (await o.mailer.send({ to: r.email, subject: m.subject, text: m.text, category: p.category })).messageId }); }
      catch (e) { const why = e instanceof MailError ? e.message : "the message could not be sent"; if (e instanceof MailError && e.transient && why.includes("reached")) down = why; results.set(k, { status: "failed", reason: why }); }
    }
    await withTenant(o.pool, inst, c => record(c, inst, planned, results, now));
    const vals = [...results.values()];
    this.lastTickAt = now;
    const tick = { planned: planned.length, sent: vals.filter(v => v.status === "sent").length, failed: vals.filter(v => v.status === "failed").length, skipped: vals.filter(v => v.status === "skipped").length };
    if (planned.length) o.log?.("alerts processed", tick);
    return tick;
  }
}

/** One test message to one person, outside the normal conditions. Recorded like any other. */
export async function sendTest(o: { pool: pg.Pool; institutionId: string; mailer: Mailer; baseUrl: string; principalId: string; now?: Date }): Promise<{ status: "sent" | "failed" | "skipped"; reason?: string }> {
  const now = o.now ?? new Date();
  const email = await withTenant(o.pool, o.institutionId, async c => (await c.query("SELECT email FROM principals WHERE id = $1", [o.principalId])).rows[0]?.email as string | null | undefined);
  let out: { status: "sent" | "failed" | "skipped"; reason?: string; messageId?: string };
  if (!email) out = { status: "skipped", reason: "you have no email address set" };
  else try { const m = render({ category: "operations", kind: "test", baseUrl: o.baseUrl, link: "/#/alerts" }); out = { status: "sent", messageId: (await o.mailer.send({ to: email, subject: m.subject, text: m.text, category: "test" })).messageId }; }
  catch (e) { out = { status: "failed", reason: e instanceof MailError ? e.message : "the message could not be sent" }; }
  await withTenant(o.pool, o.institutionId, async c => {
    await c.query("INSERT INTO alert_deliveries (institution_id, condition_key, category, kind, principal_id, status, reason, message_id) VALUES ($1,'test','operations','test',$2,$3,$4,$5)", [o.institutionId, o.principalId, out.status, out.reason ?? null, out.messageId ?? null]);
    await c.query("INSERT INTO audit_events (institution_id, actor_type, actor_id, action, object_type, payload, prev_hash, hash) VALUES ($1,'principal',$2,'alert.test_sent','alert',$3,'','')", [o.institutionId, o.principalId, JSON.stringify({ status: out.status, at: now.toISOString() })]);
  });
  return { status: out.status, ...(out.reason ? { reason: out.reason } : {}) };
}
