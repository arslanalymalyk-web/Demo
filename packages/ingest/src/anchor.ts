import { createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { verifyAuditChain } from "./lineage.js";

/** The audit chain proves that no event was changed without the next one noticing. It cannot prove that someone with full database rights did not rewrite the whole chain.
 *  A checkpoint closes that: the head of the chain, signed with a key that is not in the database. Kept somewhere the database administrator cannot reach, it shows later that nothing up to that point was changed or cut off. */
export interface Checkpoint { institutionId: string; events: number; seq: number; hash: string; at: string; signature: string }
export type CheckpointResult = { ok: true; events: number; since: string } | { ok: false; reason: "not_signed_by_this_key" | "other_institution" | "chain_shorter_than_checkpoint" | "history_changed" | "chain_broken"; detail: string };

export const MIN_ANCHOR_KEY_LENGTH = 32;
const sign = (key: string, p: Omit<Checkpoint, "signature">): string => createHmac("sha256", key).update(`tigeris-audit-checkpoint|${p.institutionId}|${p.events}|${p.seq}|${p.hash}|${p.at}`).digest("hex");

export async function takeCheckpoint(c: pg.PoolClient, institutionId: string, key: string, now: Date = new Date()): Promise<Checkpoint> {
  if (key.length < MIN_ANCHOR_KEY_LENGTH) throw new Error(`the signing key must be at least ${MIN_ANCHOR_KEY_LENGTH} characters`);
  const chain = await verifyAuditChain(c);
  if (!chain.ok) throw new Error(`the audit chain is already broken at event ${chain.firstBadSeq}; a checkpoint would sign a broken history`);
  const head = (await c.query("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")).rows[0] as { seq: string; hash: string } | undefined;
  const p = { institutionId, events: chain.events, seq: head ? Number(head.seq) : 0, hash: head?.hash ?? "0".repeat(64), at: now.toISOString() };
  return { ...p, signature: sign(key, p) };
}

/** Checks a checkpoint kept elsewhere against the chain as it is now. */
export async function verifyCheckpoint(c: pg.PoolClient, institutionId: string, key: string, cp: Checkpoint): Promise<CheckpointResult> {
  const expect = Buffer.from(typeof cp.signature === "string" ? cp.signature : "", "utf8"), mine = Buffer.from(sign(key, { institutionId: cp.institutionId, events: cp.events, seq: cp.seq, hash: cp.hash, at: cp.at }), "utf8");
  if (expect.length !== mine.length || !timingSafeEqual(expect, mine)) return { ok: false, reason: "not_signed_by_this_key", detail: "the signature does not match; the checkpoint was altered or made with another key" };
  if (cp.institutionId !== institutionId) return { ok: false, reason: "other_institution", detail: "the checkpoint belongs to another institution" };
  const chain = await verifyAuditChain(c);
  if (!chain.ok) return { ok: false, reason: "chain_broken", detail: `the chain no longer verifies from event ${chain.firstBadSeq}` };
  const row = cp.seq === 0 ? { hash: "0".repeat(64) } : (await c.query("SELECT hash FROM audit_events WHERE seq = $1", [cp.seq])).rows[0] as { hash: string } | undefined;
  if (!row) return { ok: false, reason: "chain_shorter_than_checkpoint", detail: `the checkpoint covers ${cp.events} events and the chain now stops at ${chain.events}` };
  if (row.hash !== cp.hash) return { ok: false, reason: "history_changed", detail: `event ${cp.seq} is not what it was when the checkpoint was signed` };
  return { ok: true, events: chain.events, since: cp.at };
}
