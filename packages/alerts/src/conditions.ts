import type pg from "pg";
import { sourceHealth } from "../../scheduler/src/index.js";
import { effectiveSchedule } from "../../settings/src/index.js";
import type { Category } from "./templates.js";

export interface Audience { roles: string[]; principals: string[] }
export interface Desired { key: string; category: Category; kind: "event" | "state"; ref: string | null; link: string; detail: string | null; audience: Audience }
export interface Context { auditOk: boolean | null; scanner: { configured: boolean; reachable: boolean } | null }

const ADMINS = ["administrator", "auditor"];

/** Everything that needs a person right now, read from stored facts. Nothing here is a figure from the records; each item is a yes or no. */
export async function desiredConditions(c: pg.PoolClient, ctx: Context, now: Date): Promise<Desired[]> {
  const out: Desired[] = [];
  for (const r of (await c.query("SELECT id FROM documents WHERE scan_status = 'infected' AND coalesce(scanned_at, created_at) > $1", [new Date(now.getTime() - 7 * 86_400_000).toISOString()])).rows)
    out.push({ key: `malware:${r.id}`, category: "malware", kind: "event", ref: `DOC-${String(r.id).slice(0, 8).toUpperCase()}`, link: `/#/documents/${r.id}`, detail: null, audience: { roles: ADMINS, principals: [] } });

  const steward = (await effectiveSchedule(c)).schedule.steward;
  for (const h of await sourceHealth(c, now)) if (h.scheduled && ["failing", "paused", "stale"].includes(h.health))
    out.push({ key: `source:${h.sourceKey}`, category: "source", kind: "state", ref: null, link: "/#/source-health", detail: h.health, audience: { roles: ["administrator"], principals: steward ? [steward] : [] } });

  for (const r of (await c.query("SELECT id, case_key, reviewer_id FROM cases WHERE state = 'in_review' AND reviewer_id IS NOT NULL")).rows)
    out.push({ key: `review:${r.id}`, category: "review", kind: "state", ref: String(r.case_key), link: `/#/cases/${r.id}`, detail: null, audience: { roles: [], principals: [r.reviewer_id] } });

  if (ctx.auditOk === false) out.push({ key: "ops:audit_chain", category: "operations", kind: "state", ref: null, link: "/#/audit", detail: "broken", audience: { roles: ADMINS, principals: [] } });
  if (ctx.scanner?.configured && !ctx.scanner.reachable) out.push({ key: "ops:scanner", category: "operations", kind: "state", ref: null, link: "/#/documents", detail: "down", audience: { roles: ADMINS, principals: [] } });
  // The log archive keeps point-in-time recovery possible. A failure newer than the last success is worth a person's attention. How old the last base backup is cannot be read from the database.
  const arch = (await c.query("SELECT last_archived_time, last_failed_time FROM pg_stat_archiver")).rows[0];
  if (arch?.last_failed_time && (!arch.last_archived_time || new Date(arch.last_failed_time) > new Date(arch.last_archived_time))) out.push({ key: "ops:wal_archive", category: "operations", kind: "state", ref: null, link: "/#/readiness", detail: "failing", audience: { roles: ADMINS, principals: [] } });
  return out;
}

export interface Recipient { principalId: string; email: string | null; name: string }
/** The people an audience means: active, in a named role or named directly. */
export async function resolveAudience(c: pg.PoolClient, a: Audience): Promise<Recipient[]> {
  const r = await c.query(
    `SELECT DISTINCT p.id, p.email, COALESCE(p.display_name, p.idp_subject) AS name FROM principals p
     WHERE p.disabled_at IS NULL AND (p.id = ANY($1::uuid[]) OR EXISTS (SELECT 1 FROM principal_roles pr JOIN roles ro ON ro.id = pr.role_id AND ro.institution_id = pr.institution_id WHERE pr.principal_id = p.id AND pr.institution_id = p.institution_id AND ro.key = ANY($2::text[])))
     ORDER BY name`, [a.principals, a.roles]);
  return r.rows.map(x => ({ principalId: x.id, email: x.email ?? null, name: x.name }));
}
