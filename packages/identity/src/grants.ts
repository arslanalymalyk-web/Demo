import type pg from "pg";
import { audit } from "../../ingest/src/store.js";
import { IdentityError, getPrincipal, setRoles, writeRoles, type Principal } from "./store.js";

/** Roles that confer authority over other people or over decisions. Giving one needs a second administrator. Taking one away does not. */
export const PRIVILEGED_ROLES = ["administrator", "approver"] as const;
export interface GrantRequest { id: string; principalId: string; roles: string[]; requestedBy: string; requestedAt: Date; status: "pending" | "approved" | "rejected"; decidedBy: string | null; decidedAt: Date | null; note: string | null }
type Actor = { type: string; id?: string };
const map = (r: Record<string, unknown>): GrantRequest => ({ id: r.id as string, principalId: r.principal_id as string, roles: r.roles as string[], requestedBy: r.requested_by as string, requestedAt: new Date(r.requested_at as string), status: r.status as GrantRequest["status"], decidedBy: (r.decided_by as string | null) ?? null, decidedAt: r.decided_at ? new Date(r.decided_at as string) : null, note: (r.note as string | null) ?? null });

/** Opens a request for privileged roles, or returns the identical one already open. */
async function openRequest(c: pg.PoolClient, institutionId: string, actor: Actor, principalId: string, roles: string[]): Promise<GrantRequest> {
  const sorted = [...roles].sort();
  const same = (await c.query("SELECT * FROM role_grant_requests WHERE principal_id = $1 AND status = 'pending' AND roles = $2::text[]", [principalId, sorted])).rows[0];
  if (same) return map(same);
  const r = (await c.query("INSERT INTO role_grant_requests (institution_id, principal_id, roles, requested_by) VALUES ($1,$2,$3,$4) RETURNING *", [institutionId, principalId, sorted, actor.id])).rows[0];
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: "identity.role_grant_requested", objectType: "principal", objectId: principalId, payload: { roles: sorted, requestId: r.id } });
  return map(r);
}

/** Sets a person's roles. Anything that adds administrator or approver becomes a request that another administrator must approve; the rest applies at once.
 *  Set-up and the identity command run as the system and apply everything, which is how the first administrators come to exist. */
export async function changeRoles(c: pg.PoolClient, institutionId: string, actor: Actor, principalId: string, roles: string[]): Promise<{ principal: Principal; pending: GrantRequest | null }> {
  const cur = await getPrincipal(c, principalId);
  if (!cur) throw new IdentityError("principal not found", "not_found");
  const added = [...new Set(roles)].filter(r => (PRIVILEGED_ROLES as readonly string[]).includes(r) && !cur.roles.includes(r));
  if (actor.type === "system" || added.length === 0) return { principal: await setRoles(c, institutionId, actor, principalId, roles), pending: null };
  if (!actor.id) throw new IdentityError("a person must make this request", "invalid");
  const principal = await setRoles(c, institutionId, actor, principalId, roles.filter(r => !added.includes(r)));
  return { principal, pending: await openRequest(c, institutionId, actor, principalId, added) };
}

/** For a person just created through the API: privileged roles wait for approval. */
export async function requestForNewPerson(c: pg.PoolClient, institutionId: string, actor: Actor, principalId: string, privileged: string[]): Promise<GrantRequest | null> {
  return privileged.length && actor.id ? openRequest(c, institutionId, actor, principalId, privileged) : null;
}

export async function listGrantRequests(c: pg.PoolClient, status?: GrantRequest["status"]): Promise<(GrantRequest & { subject: string; displayName: string | null })[]> {
  const r = await c.query("SELECT g.*, p.idp_subject, p.display_name FROM role_grant_requests g JOIN principals p ON p.id = g.principal_id WHERE ($1::text IS NULL OR g.status = $1) ORDER BY g.requested_at DESC LIMIT 200", [status ?? null]);
  return r.rows.map(x => ({ ...map(x), subject: x.idp_subject as string, displayName: x.display_name ?? null }));
}

/** A different administrator approves or rejects. The person asking cannot approve their own request, and the person receiving the role cannot approve it for themselves. The asker may withdraw it. */
export async function decideGrantRequest(c: pg.PoolClient, institutionId: string, actor: Actor, requestId: string, approve: boolean, note: string | null): Promise<GrantRequest> {
  const row = (await c.query("SELECT * FROM role_grant_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
  if (!row) throw new IdentityError("request not found", "not_found");
  const req = map(row);
  if (req.status !== "pending") throw new IdentityError(`the request was already ${req.status}`, "conflict");
  if (approve) {
    if (actor.id === req.requestedBy) throw new IdentityError("a second administrator must approve; you made this request", "conflict");
    if (actor.id === req.principalId) throw new IdentityError("a person cannot approve a role for themselves", "conflict");
    const target = await getPrincipal(c, req.principalId);
    if (!target || target.disabled) throw new IdentityError("the person is not active", "conflict");
    await writeRoles(c, institutionId, req.principalId, [...new Set([...target.roles, ...req.roles])]);
  } else if (actor.id !== req.requestedBy && actor.id === req.principalId) throw new IdentityError("a person cannot decide on their own request", "conflict");
  const upd = (await c.query("UPDATE role_grant_requests SET status = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $1 RETURNING *", [requestId, approve ? "approved" : "rejected", actor.id ?? null, note])).rows[0];
  await audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: approve ? "identity.role_grant_approved" : "identity.role_grant_rejected", objectType: "principal", objectId: req.principalId, payload: { roles: req.roles, requestId, requestedBy: req.requestedBy, ...(note ? { note } : {}) } });
  return map(upd);
}
