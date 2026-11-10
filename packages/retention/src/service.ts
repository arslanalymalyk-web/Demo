import type pg from "pg";
import { canonicalJson, sha256Hex } from "../../core/src/index.js";
import { getCase } from "../../cases/src/index.js";
import { auditEventsForCase, verifyAuditChain } from "../../ingest/src/lineage.js";
import { audit, tableStats, type TableStats } from "../../ingest/src/store.js";

export const RETENTION_YEARS = 10;
export class RetentionError extends Error { constructor(message: string, readonly code: "not_found" | "conflict" | "invalid") { super(message); } }

export interface ClassReport extends TableStats { key: string; label: string; basis: string; reviewDue: number }
const CLASSES: { key: string; table: string; label: string; basis: string }[] = [
  { key: "audit", table: "audit_events", label: "Audit events", basis: `Kept ${RETENTION_YEARS} years (decision K7)` },
  { key: "decisions", table: "human_decisions", label: "Human decisions", basis: `Kept ${RETENTION_YEARS} years (decision K7)` },
  { key: "policy_decisions", table: "policy_decisions", label: "Policy decisions", basis: `Kept ${RETENTION_YEARS} years, with the decisions they gated` },
  { key: "cases", table: "cases", label: "Cases", basis: `Kept ${RETENTION_YEARS} years` },
  { key: "memory", table: "memory_records", label: "Institutional memory", basis: `Kept ${RETENTION_YEARS} years (decision K7)` },
  { key: "evidence", table: "evidence_objects", label: "Evidence", basis: "Follows each source's licence terms; evidence cited by a decision is kept as long as the decision" },
  { key: "documents", table: "documents", label: "Documents", basis: "Follows the rights declared at upload" },
  { key: "scenario_runs", table: "scenario_runs", label: "Scenario runs", basis: "Kept with the decisions that cite them" },
  { key: "settings", table: "settings_versions", label: "Settings versions", basis: `Kept ${RETENTION_YEARS} years, since they explain past outputs` },
];

export interface Hold { id: string; caseId: string; caseKey: string; reason: string; placedBy: string; placedAt: string; releasedBy: string | null; releasedAt: string | null; releaseReason: string | null }
const mapHold = (r: Record<string, unknown>): Hold => ({ id: r.id as string, caseId: r.case_id as string, caseKey: r.case_key as string, reason: r.reason as string, placedBy: r.placed_by as string, placedAt: new Date(r.placed_at as string).toISOString(), releasedBy: (r.released_by as string | null) ?? null, releasedAt: r.released_at ? new Date(r.released_at as string).toISOString() : null, releaseReason: (r.release_reason as string | null) ?? null });
const HOLD_SQL = "SELECT h.*, k.case_key FROM retention_holds h JOIN cases k ON k.id = h.case_id";

export async function holdFor(c: pg.PoolClient, caseId: string): Promise<Hold | null> { const r = await c.query(`${HOLD_SQL} WHERE h.case_id = $1 AND h.released_at IS NULL`, [caseId]); return r.rows[0] ? mapHold(r.rows[0]) : null; }
/** Any future deletion tool must call this first and refuse a held case. */
export async function isOnHold(c: pg.PoolClient, caseId: string): Promise<boolean> { return (await holdFor(c, caseId)) !== null; }

export async function retentionReport(c: pg.PoolClient, now: Date = new Date()): Promise<unknown> {
  const horizon = new Date(Date.UTC(now.getUTCFullYear() - RETENTION_YEARS, now.getUTCMonth(), now.getUTCDate()));
  const classes: ClassReport[] = [];
  for (const k of CLASSES) {
    const s = await tableStats(c, k.table);
    const due = s.oldest && new Date(s.oldest) <= horizon ? Number((await c.query(`SELECT count(*)::int AS n FROM ${k.table} WHERE ${k.table === "audit_events" ? "occurred_at" : k.table === "evidence_objects" ? "retrieved_at" : "created_at"} <= $1`, [horizon])).rows[0].n) : 0;
    classes.push({ key: k.key, label: k.label, basis: k.basis, ...s, reviewDue: due });
  }
  const holds = (await c.query(`${HOLD_SQL} ORDER BY h.placed_at DESC LIMIT 100`)).rows.map(mapHold);
  const exp = (await c.query("SELECT e.id, e.kind, e.subject_id, e.exported_by, e.exported_at, e.sha256, e.bytes, e.purpose FROM record_exports e ORDER BY e.exported_at DESC LIMIT 50")).rows
    .map(r => ({ id: r.id, kind: r.kind, subjectId: r.subject_id, exportedBy: r.exported_by, exportedAt: new Date(r.exported_at).toISOString(), sha256: r.sha256, bytes: r.bytes, purpose: r.purpose }));
  return {
    years: RETENTION_YEARS, reviewHorizon: horizon.toISOString(), classes, holds, exports: exp,
    deletion: "This system has no deletion function and never removes a record on its own. Anything past the horizon is listed for a person to review.",
    note: "Retention periods for evidence follow each source's licence. The ten-year period applies to decisions, audit and memory.",
  };
}

export async function placeHold(c: pg.PoolClient, inst: string, actorId: string, caseId: string, reason: string): Promise<Hold> {
  if (reason.trim().length < 10) throw new RetentionError("state the reason for the hold in at least 10 characters", "invalid");
  const k = (await c.query("SELECT case_key FROM cases WHERE id = $1", [caseId])).rows[0];
  if (!k) throw new RetentionError("case not found", "not_found");
  if (await holdFor(c, caseId)) throw new RetentionError("this case is already on hold", "conflict");
  const r = await c.query("INSERT INTO retention_holds (institution_id, case_id, reason, placed_by) VALUES ($1,$2,$3,$4) RETURNING id", [inst, caseId, reason.trim(), actorId]);
  await audit(c, inst, { actorType: "principal", actorId, action: "retention.hold_placed", objectType: "case", objectId: caseId, payload: { caseKey: k.case_key, reason: reason.trim() } });
  return (await holdFor(c, caseId))!;
}

export async function releaseHold(c: pg.PoolClient, inst: string, actorId: string, caseId: string, reason: string): Promise<Hold> {
  if (reason.trim().length < 10) throw new RetentionError("state the reason for releasing the hold in at least 10 characters", "invalid");
  const h = await holdFor(c, caseId);
  if (!h) throw new RetentionError("this case is not on hold", "not_found");
  await c.query("UPDATE retention_holds SET released_by = $2, released_at = now(), release_reason = $3 WHERE id = $1", [h.id, actorId, reason.trim()]);
  await audit(c, inst, { actorType: "principal", actorId, action: "retention.hold_released", objectType: "case", objectId: caseId, payload: { caseKey: h.caseKey, reason: reason.trim() } });
  return mapHold((await c.query(`${HOLD_SQL} WHERE h.id = $1`, [h.id])).rows[0]);
}

export interface ExportBundle { header: { format: "tigeris-case-export/1"; exportedAt: string; exportedBy: string; purpose: string; institutionId: string; caseKey: string }; content: { case: unknown; auditEvents: unknown[] }; integrity: { algorithm: string; sha256: string; auditChain: { ok: boolean; events: number } } }

/** A complete, self-describing record of one case: its content, the audit events about it, and a hash over both. The export itself is recorded. */
export async function exportCase(c: pg.PoolClient, inst: string, actor: { id: string; roles: string[] }, caseId: string, purpose: string, now: Date = new Date()): Promise<ExportBundle> {
  if (purpose.trim().length < 10) throw new RetentionError("state the purpose of the export in at least 10 characters", "invalid");
  const full = await getCase(c, actor, caseId) as { caseKey: string };
  const events = await auditEventsForCase(c, caseId, full.caseKey);
  const content = JSON.parse(JSON.stringify({ case: full, auditEvents: events }));
  const bundle: ExportBundle = {
    header: { format: "tigeris-case-export/1", exportedAt: now.toISOString(), exportedBy: actor.id, purpose: purpose.trim(), institutionId: inst, caseKey: full.caseKey },
    content, integrity: { algorithm: "sha256 over the canonical JSON of content", sha256: sha256Hex(canonicalJson(content)), auditChain: await (async () => { const v = await verifyAuditChain(c); return { ok: v.ok, events: v.events }; })() },
  };
  const bytes = Buffer.byteLength(JSON.stringify(bundle));
  await c.query("INSERT INTO record_exports (institution_id, kind, subject_id, exported_by, sha256, bytes, purpose) VALUES ($1,'case',$2,$3,$4,$5,$6)", [inst, caseId, actor.id, bundle.integrity.sha256, bytes, purpose.trim()]);
  await audit(c, inst, { actorType: "principal", actorId: actor.id, action: "retention.exported", objectType: "case", objectId: caseId, payload: { caseKey: full.caseKey, sha256: bundle.integrity.sha256, bytes, purpose: purpose.trim() } });
  return bundle;
}

/** Offline check: does the content still match the hash recorded when it was exported? */
export function verifyExportBundle(b: ExportBundle): { ok: boolean; reason: string } {
  if (b.header?.format !== "tigeris-case-export/1") return { ok: false, reason: "not a case export of a known format" };
  return sha256Hex(canonicalJson(b.content)) === b.integrity?.sha256 ? { ok: true, reason: "the content matches its recorded hash" } : { ok: false, reason: "the content does not match its recorded hash: it has been changed since export" };
}
