import type pg from "pg";
import { audit } from "../../ingest/src/store.js";
import { IdentityError } from "./store.js";

export interface Lockdown { locked: boolean; reason: string | null; changedAt: Date | null; changedBy: string | null }

export async function getLockdown(c: pg.PoolClient): Promise<Lockdown> {
  const r = (await c.query("SELECT lockdown, reason, changed_at, changed_by FROM institution_controls")).rows[0];
  return r ? { locked: r.lockdown as boolean, reason: r.reason ?? null, changedAt: new Date(r.changed_at), changedBy: r.changed_by ?? null } : { locked: false, reason: null, changedAt: null, changedBy: null };
}

/** Switches the emergency stop on or off. Both are written to the audit trail with the reason. */
export async function setLockdown(c: pg.PoolClient, institutionId: string, actor: { type: string; id?: string }, locked: boolean, reason: string): Promise<Lockdown> {
  if (reason.trim().length < 5) throw new IdentityError("a reason of at least five characters is required", "invalid");
  const cur = await getLockdown(c);
  if (cur.locked === locked) throw new IdentityError(locked ? "the institution is already locked down" : "the institution is not locked down", "conflict");
  await c.query("INSERT INTO institution_controls (institution_id, lockdown, reason, changed_by, changed_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (institution_id) DO UPDATE SET lockdown = $2, reason = $3, changed_by = $4, changed_at = now()", [institutionId, locked, reason.trim(), actor.id ?? null]);
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: locked ? "lockdown.started" : "lockdown.released", objectType: "institution", objectId: institutionId, payload: { reason: reason.trim() } });
  return getLockdown(c);
}
