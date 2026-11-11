import type pg from "pg";
import { audit } from "../../ingest/src/store.js";
import { ROLE_PERMISSIONS } from "./permissions.js";

export interface Principal { id: string; issuer: string; subject: string; displayName: string | null; roles: string[]; disabled: boolean; sessionsValidAfter: Date | null; expiresAt: Date | null }
export class IdentityError extends Error { constructor(message: string, readonly code: "not_found" | "conflict" | "invalid") { super(message); } }

const SELECT = `SELECT p.id, p.idp_issuer, p.idp_subject, p.display_name, p.disabled_at, p.sessions_valid_after, p.expires_at,
  COALESCE(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
  FROM principals p LEFT JOIN principal_roles pr ON pr.principal_id = p.id AND pr.institution_id = p.institution_id LEFT JOIN roles r ON r.id = pr.role_id AND r.institution_id = pr.institution_id`;
const map = (r: Record<string, unknown>): Principal => ({ id: r.id as string, issuer: r.idp_issuer as string, subject: r.idp_subject as string, displayName: (r.display_name as string | null) ?? null, roles: r.roles as string[], disabled: r.disabled_at !== null, sessionsValidAfter: r.sessions_valid_after ? new Date(r.sessions_valid_after as string) : null, expiresAt: r.expires_at ? new Date(r.expires_at as string) : null });

export async function findPrincipal(c: pg.PoolClient, issuer: string, subject: string): Promise<Principal | null> {
  const r = await c.query(`${SELECT} WHERE p.idp_issuer = $1 AND p.idp_subject = $2 GROUP BY p.id`, [issuer, subject]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
export async function getPrincipal(c: pg.PoolClient, id: string): Promise<Principal | null> {
  const r = await c.query(`${SELECT} WHERE p.id = $1 GROUP BY p.id`, [id]);
  return r.rows[0] ? map(r.rows[0]) : null;
}
export async function listPrincipals(c: pg.PoolClient): Promise<Principal[]> {
  return (await c.query(`${SELECT} GROUP BY p.id ORDER BY p.created_at, p.id`)).rows.map(map);
}

export async function assertRoles(c: pg.PoolClient, roles: string[]): Promise<void> {
  const known = new Set(Object.keys(ROLE_PERMISSIONS));
  const bad = roles.filter(r => !known.has(r));
  if (bad.length) throw new IdentityError(`unknown role: ${bad.join(", ")}`, "invalid");
  const have = new Set((await c.query("SELECT key FROM roles WHERE key = ANY($1)", [roles])).rows.map(r => r.key));
  const missing = roles.filter(r => !have.has(r));
  if (missing.length) throw new IdentityError(`role not defined for this institution: ${missing.join(", ")}`, "invalid");
}

export async function writeRoles(c: pg.PoolClient, institutionId: string, principalId: string, roles: string[]): Promise<void> {
  await c.query("DELETE FROM principal_roles WHERE institution_id = $1 AND principal_id = $2", [institutionId, principalId]);
  for (const key of new Set(roles)) await c.query("INSERT INTO principal_roles (institution_id, principal_id, role_id) SELECT $1, $2, id FROM roles WHERE key = $3", [institutionId, principalId, key]);
}

/** The last active administrator can neither lose the role nor be disabled, so the institution cannot lock itself out. */
async function assertAdminRemains(c: pg.PoolClient, principalId: string): Promise<void> {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM principals p JOIN principal_roles pr ON pr.principal_id = p.id AND pr.institution_id = p.institution_id JOIN roles r ON r.id = pr.role_id AND r.institution_id = pr.institution_id
     WHERE r.key = 'administrator' AND p.disabled_at IS NULL AND p.id <> $1`, [principalId]);
  if (r.rows[0].n === 0) throw new IdentityError("at least one active administrator must remain", "conflict");
}

export async function provisionPrincipal(c: pg.PoolClient, institutionId: string, actor: { type: string; id?: string }, p: { issuer: string; subject: string; displayName?: string | null; roles: string[]; expiresAt?: Date | null }): Promise<Principal> {
  await assertRoles(c, p.roles);
  if (p.expiresAt && p.expiresAt.getTime() <= Date.now()) throw new IdentityError("the expiry must be in the future", "invalid");
  const ins = await c.query("INSERT INTO principals (institution_id, idp_issuer, idp_subject, display_name, expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id", [institutionId, p.issuer, p.subject, p.displayName ?? null, p.expiresAt ?? null]);
  if (!ins.rows[0]) throw new IdentityError("principal already exists", "conflict");
  await writeRoles(c, institutionId, ins.rows[0].id, p.roles);
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: "identity.principal_provisioned", objectType: "principal", objectId: ins.rows[0].id, payload: { issuer: p.issuer, subject: p.subject, roles: [...new Set(p.roles)].sort() } });
  return (await getPrincipal(c, ins.rows[0].id))!;
}

export async function setRoles(c: pg.PoolClient, institutionId: string, actor: { type: string; id?: string }, principalId: string, roles: string[]): Promise<Principal> {
  const cur = await getPrincipal(c, principalId);
  if (!cur) throw new IdentityError("principal not found", "not_found");
  await assertRoles(c, roles);
  if (cur.roles.includes("administrator") && !roles.includes("administrator") && !cur.disabled) await assertAdminRemains(c, principalId);
  await writeRoles(c, institutionId, principalId, roles);
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: "identity.roles_changed", objectType: "principal", objectId: principalId, payload: { from: cur.roles, to: [...new Set(roles)].sort() } });
  return (await getPrincipal(c, principalId))!;
}

export async function setDisabled(c: pg.PoolClient, institutionId: string, actor: { type: string; id?: string }, principalId: string, disabled: boolean): Promise<Principal> {
  const cur = await getPrincipal(c, principalId);
  if (!cur) throw new IdentityError("principal not found", "not_found");
  if (disabled && !cur.disabled && cur.roles.includes("administrator")) await assertAdminRemains(c, principalId);
  await c.query("UPDATE principals SET disabled_at = CASE WHEN $2 THEN COALESCE(disabled_at, now()) ELSE NULL END WHERE id = $1", [principalId, disabled]);
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: disabled ? "identity.principal_disabled" : "identity.principal_enabled", objectType: "principal", objectId: principalId, payload: {} });
  return (await getPrincipal(c, principalId))!;
}

/** Ends every session of one person (or, with no person, of everyone): tokens issued before the cut-off are refused. Token issue times are whole seconds, so an administrator's revocation cuts at the next whole second (nothing issued before it survives), while a person signing out cuts at the current one (signing straight back in works). Returns how many people were affected. */
export async function revokeSessions(c: pg.PoolClient, institutionId: string, actor: { type: string; id?: string }, principalId: string | null, reason: string, own = false): Promise<number> {
  if (principalId !== null && !(await getPrincipal(c, principalId))) throw new IdentityError("principal not found", "not_found");
  const n = (await c.query("UPDATE principals SET sessions_valid_after = date_trunc('second', clock_timestamp()) + CASE WHEN $2 THEN interval '0' ELSE interval '1 second' END WHERE ($1::uuid IS NULL OR id = $1)", [principalId, own])).rowCount ?? 0;
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: principalId ? "identity.sessions_revoked" : "identity.sessions_revoked_all", objectType: principalId ? "principal" : "institution", objectId: principalId ?? institutionId, payload: { reason, people: n } });
  return n;
}

/** Sets or clears when a person's access ends. The reason is kept in the audit trail. */
export async function setExpiry(c: pg.PoolClient, institutionId: string, actor: { type: string; id?: string }, principalId: string, expiresAt: Date | null, reason: string): Promise<Principal> {
  const cur = await getPrincipal(c, principalId);
  if (!cur) throw new IdentityError("principal not found", "not_found");
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new IdentityError("the expiry must be in the future", "invalid");
  if (expiresAt === null && cur.expiresAt === null) throw new IdentityError("this person's access has no expiry", "conflict");
  if (expiresAt === null && cur.roles.length === 0) throw new IdentityError("a person with no roles cannot be made permanent", "conflict");
  await c.query("UPDATE principals SET expires_at = $2 WHERE id = $1", [principalId, expiresAt]);
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: "identity.expiry_changed", objectType: "principal", objectId: principalId, payload: { from: cur.expiresAt?.toISOString() ?? null, to: expiresAt?.toISOString() ?? null, reason } });
  return (await getPrincipal(c, principalId))!;
}
