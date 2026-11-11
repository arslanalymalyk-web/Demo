import type pg from "pg";
import { audit } from "../../ingest/src/store.js";
import { desiredConditions, resolveAudience, type Audience, type Context, type Recipient } from "./conditions.js";
import { MUTABLE, type Category, type Kind } from "./templates.js";

export interface EngineConfig { reminderHours: number; maxPerHour: number }
export interface Planned { key: string; category: Category; kind: Kind; ref: string | null; link: string; detail: string | null; recipients: Recipient[]; muted: Recipient[]; capped: Recipient[] }
export type Outcome = { status: "sent"; messageId: string } | { status: "failed"; reason: string } | { status: "skipped"; reason: string };

const backoffMs = (attempts: number) => Math.min(5 * 60_000 * 2 ** Math.max(attempts - 1, 0), 2 * 3_600_000);
const GIVE_UP_AFTER = 6;

interface Stored { condition_key: string; category: Category; kind: "event" | "state"; state: "open" | "resolved"; ref: string | null; link: string | null; detail: string | null; audience: Audience; last_notified_at: Date | null; attempts: number; next_attempt_at: Date | null }

/** Works out which notices are due now: new conditions, reminders for ones still open, and a note for ones that cleared. It also brings the stored state up to date. */
export async function plan(c: pg.PoolClient, inst: string, ctx: Context, cfg: EngineConfig, now: Date): Promise<Planned[]> {
  const desired = await desiredConditions(c, ctx, now);
  const stored = new Map((await c.query("SELECT condition_key, category, kind, state, ref, link, detail, audience, last_notified_at, attempts, next_attempt_at FROM alert_conditions")).rows.map(r => [r.condition_key as string, r as Stored]));
  const due: { key: string; category: Category; kind: Kind; ref: string | null; link: string; detail: string | null; audience: Audience }[] = [];
  const iso = now.toISOString(), seen = new Set<string>();

  for (const d of desired) {
    seen.add(d.key);
    const s = stored.get(d.key);
    if (!s) {
      await c.query("INSERT INTO alert_conditions (institution_id, condition_key, category, kind, ref, link, detail, audience, first_seen_at, last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)", [inst, d.key, d.category, d.kind, d.ref, d.link, d.detail, JSON.stringify(d.audience), iso]);
      due.push({ ...d, kind: "raised" }); continue;
    }
    if (s.state === "resolved") {
      await c.query("UPDATE alert_conditions SET state = 'open', first_seen_at = $2, last_seen_at = $2, last_notified_at = NULL, notify_count = 0, attempts = 0, next_attempt_at = NULL, resolved_at = NULL, ref = $3, link = $4, detail = $5, audience = $6 WHERE condition_key = $1", [d.key, iso, d.ref, d.link, d.detail, JSON.stringify(d.audience)]);
      due.push({ ...d, kind: "raised" }); continue;
    }
    await c.query("UPDATE alert_conditions SET last_seen_at = $2, ref = $3, link = $4, detail = $5, audience = $6 WHERE condition_key = $1", [d.key, iso, d.ref, d.link, d.detail, JSON.stringify(d.audience)]);
    if (!s.last_notified_at) { if (!s.next_attempt_at || s.next_attempt_at <= now) due.push({ ...d, kind: "raised" }); }
    else if (d.kind === "state" && now.getTime() - s.last_notified_at.getTime() >= cfg.reminderHours * 3_600_000) due.push({ ...d, kind: "reminder" });
  }
  for (const s of stored.values()) {
    if (s.state !== "open" || seen.has(s.condition_key)) continue;
    await c.query("UPDATE alert_conditions SET state = 'resolved', resolved_at = $2 WHERE condition_key = $1", [s.condition_key, iso]);
    if (s.kind === "state" && s.last_notified_at) due.push({ key: s.condition_key, category: s.category, kind: "resolved", ref: s.ref, link: s.link ?? "/", detail: s.detail, audience: s.audience });
  }

  const sentLastHour = (await c.query("SELECT count(*)::int AS n FROM alert_deliveries WHERE status = 'sent' AND created_at > $1", [new Date(now.getTime() - 3_600_000).toISOString()])).rows[0].n as number;
  let room = Math.max(0, cfg.maxPerHour - sentLastHour);
  const muted = new Map<string, Set<string>>(); // category -> principals who switched it off
  for (const r of (await c.query("SELECT principal_id, category FROM alert_preferences WHERE enabled = false")).rows) { if (!muted.has(r.category)) muted.set(r.category, new Set()); muted.get(r.category)!.add(r.principal_id); }

  const out: Planned[] = [];
  for (const d of due) {
    // Someone who already received this notice (this kind, since the condition opened or was last announced) is not sent it again when a retry is needed for others.
    const since = stored.get(d.key)?.last_notified_at ?? (await c.query("SELECT first_seen_at FROM alert_conditions WHERE condition_key = $1", [d.key])).rows[0]?.first_seen_at ?? now;
    const got = new Set((await c.query("SELECT principal_id FROM alert_deliveries WHERE condition_key = $1 AND kind = $2 AND status = 'sent' AND created_at >= $3", [d.key, d.kind, since])).rows.map(r => r.principal_id as string));
    const all = (await resolveAudience(c, d.audience)).filter(r => !got.has(r.principalId)), off = MUTABLE.includes(d.category) ? muted.get(d.category) ?? new Set<string>() : new Set<string>();
    const wants = all.filter(r => !off.has(r.principalId)), mutedOnes = all.filter(r => off.has(r.principalId));
    const sendable = wants.filter(r => r.email), noAddress = wants.filter(r => !r.email);
    const go = sendable.slice(0, room), capped = sendable.slice(room);
    room -= go.length;
    out.push({ key: d.key, category: d.category, kind: d.kind, ref: d.ref, link: d.link, detail: d.detail, recipients: [...go, ...noAddress.map(r => ({ ...r }))], muted: mutedOnes, capped });
  }
  return out;
}

/** Writes what happened: one delivery row per person, the condition's notice state, and one audit event per notice (counts only, no addresses). */
export async function record(c: pg.PoolClient, inst: string, planned: Planned[], results: Map<string, Outcome>, now: Date): Promise<void> {
  for (const p of planned) {
    let sent = 0, failed = 0, skipped = 0;
    const row = (r: Recipient, o: Outcome) => c.query("INSERT INTO alert_deliveries (institution_id, condition_key, category, kind, principal_id, status, reason, message_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [inst, p.key, p.category, p.kind, r.principalId, o.status, "reason" in o ? o.reason : null, "messageId" in o ? o.messageId : null, now.toISOString()]);
    for (const r of p.recipients) {
      const o: Outcome = results.get(`${p.key}|${p.kind}|${r.principalId}`) ?? (r.email ? { status: "failed", reason: "not attempted" } : { status: "skipped", reason: "this person has no email address" });
      await row(r, o); if (o.status === "sent") sent++; else if (o.status === "failed") failed++; else skipped++;
    }
    for (const r of p.muted) { await row(r, { status: "skipped", reason: "switched off by the person" }); skipped++; }
    for (const r of p.capped) { await row(r, { status: "skipped", reason: "hourly limit reached" }); skipped++; }
    const cond = (await c.query("SELECT attempts FROM alert_conditions WHERE condition_key = $1", [p.key])).rows[0];
    const attempts = (cond?.attempts ?? 0) + 1;
    const retry = (failed > 0 || p.capped.length > 0) && attempts < GIVE_UP_AFTER; // anyone still waiting for the notice keeps it open for another try
    if (retry) await c.query("UPDATE alert_conditions SET attempts = $2, next_attempt_at = $3 WHERE condition_key = $1", [p.key, attempts, new Date(now.getTime() + (p.capped.length && !failed ? 10 * 60_000 : backoffMs(attempts))).toISOString()]);
    else await c.query("UPDATE alert_conditions SET last_notified_at = $2, notify_count = notify_count + 1, attempts = 0, next_attempt_at = NULL WHERE condition_key = $1", [p.key, now.toISOString()]);
    await audit(c, inst, { actorType: "system", action: "alert.notified", objectType: "alert", objectId: p.key, payload: { category: p.category, kind: p.kind, sent, failed, skipped, willRetry: retry } });
  }
}
