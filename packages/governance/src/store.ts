import type pg from "pg";
import { canonicalJson, sha256Hex } from "../../core/src/index.js";
import { audit } from "../../ingest/src/store.js";
import { authoritySchema, DEFAULT_AUTHORITY, DEFAULT_RULES, evaluate, rulesSchema, type ActionClass, type Authority, type Evaluation, type Manifest, type Outcome, type Rule } from "./policy.js";

export class GovernanceError extends Error { constructor(message: string, readonly code: "not_found" | "conflict" | "invalid" | "forbidden") { super(message); } }
export const POLICY_KEY = "decision-gate";
export interface Actor { type: string; id?: string }
const who = (a: Actor) => ({ actorType: a.type, ...(a.id ? { actorId: a.id } : {}) });

export interface PolicyRow { id: string; key: string; version: number; status: string; rules: Rule[]; authority: Authority; createdBy: string; activatedBy: string | null; createdAt: string; activatedAt: string | null }
const mapPolicy = (r: Record<string, unknown>): PolicyRow => ({ id: r.id as string, key: r.key as string, version: r.version as number, status: r.status as string, rules: r.rules as Rule[], authority: r.authority as Authority, createdBy: r.created_by as string, activatedBy: (r.activated_by as string | null) ?? null, createdAt: new Date(r.created_at as string).toISOString(), activatedAt: r.activated_at ? new Date(r.activated_at as string).toISOString() : null });

export async function listPolicies(c: pg.PoolClient): Promise<PolicyRow[]> { return (await c.query("SELECT * FROM policies ORDER BY key, version DESC")).rows.map(mapPolicy); }
export async function activePolicy(c: pg.PoolClient): Promise<PolicyRow | null> { const r = await c.query("SELECT * FROM policies WHERE key = $1 AND status = 'active'", [POLICY_KEY]); return r.rows[0] ? mapPolicy(r.rows[0]) : null; }

export async function createPolicyDraft(c: pg.PoolClient, institutionId: string, actor: Actor, input: { rules: unknown; authority: unknown }): Promise<PolicyRow> {
  const rules = rulesSchema.safeParse(input.rules), authority = authoritySchema.safeParse(input.authority);
  if (!rules.success || !authority.success) throw new GovernanceError("invalid policy: " + [...(rules.success ? [] : rules.error.issues.map(i => i.message)), ...(authority.success ? [] : authority.error.issues.map(i => i.message))].join("; "), "invalid");
  const v = (await c.query("SELECT COALESCE(max(version), 0) + 1 AS v FROM policies WHERE key = $1", [POLICY_KEY])).rows[0].v as number;
  const r = await c.query("INSERT INTO policies (institution_id, key, version, rules, authority, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [institutionId, POLICY_KEY, v, JSON.stringify(rules.data), JSON.stringify(authority.data), actor.id ?? actor.type]);
  await audit(c, institutionId, { ...who(actor), action: "governance.policy_drafted", objectType: "policy", objectId: r.rows[0].id, payload: { key: POLICY_KEY, version: v, rules: rules.data.length } });
  return mapPolicy(r.rows[0]);
}

/** A policy is activated by someone other than its author. The bootstrap path (system actor) is for the first policy only. */
export async function activatePolicy(c: pg.PoolClient, institutionId: string, actor: Actor, policyId: string, opts: { bootstrap?: boolean } = {}): Promise<PolicyRow> {
  const cur = (await c.query("SELECT * FROM policies WHERE id = $1 FOR UPDATE", [policyId])).rows[0];
  if (!cur) throw new GovernanceError("policy not found", "not_found");
  if (cur.status !== "draft") throw new GovernanceError(`policy is ${cur.status}, only a draft can be activated`, "conflict");
  if (!opts.bootstrap && cur.created_by === (actor.id ?? actor.type)) throw new GovernanceError("a policy must be activated by someone other than its author", "forbidden");
  await c.query("UPDATE policies SET status = 'retired' WHERE key = $1 AND status = 'active'", [cur.key]);
  const r = await c.query("UPDATE policies SET status = 'active', activated_by = $2, activated_at = now() WHERE id = $1 RETURNING *", [policyId, actor.id ?? actor.type]);
  await audit(c, institutionId, { ...who(actor), action: "governance.policy_activated", objectType: "policy", objectId: policyId, payload: { key: cur.key, version: cur.version } });
  return mapPolicy(r.rows[0]);
}

export async function ensureDefaultPolicy(c: pg.PoolClient, institutionId: string): Promise<PolicyRow> {
  const a = await activePolicy(c); if (a) return a;
  const d = await createPolicyDraft(c, institutionId, { type: "system" }, { rules: DEFAULT_RULES, authority: DEFAULT_AUTHORITY });
  return activatePolicy(c, institutionId, { type: "system" }, d.id, { bootstrap: true });
}

export interface PolicyDecisionRow { id: string; recommendationId: string; policyId: string; policyVersion: number; outcome: Outcome; results: Evaluation["results"]; manifestHash: string; createdAt: string }

/** Evaluates under the active policy and records the result. With no active policy the answer is a refusal, never an implicit pass. */
export async function evaluateAndRecord(c: pg.PoolClient, institutionId: string, a: { caseId: string; recommendationId: string; manifest: Manifest }): Promise<{ decision: PolicyDecisionRow; policy: PolicyRow }> {
  const policy = await activePolicy(c);
  if (!policy) throw new GovernanceError("no active policy: nothing can proceed until an administrator activates one", "conflict");
  const ev = evaluate(policy.rules, a.manifest), hash = sha256Hex(canonicalJson({ manifest: a.manifest, policy: [policy.key, policy.version] }));
  const r = await c.query("INSERT INTO policy_decisions (institution_id, case_id, recommendation_id, policy_id, outcome, results, manifest, manifest_hash) VALUES ($1,$2,$3,$4,$5::policy_outcome,$6,$7,$8) RETURNING id, created_at",
    [institutionId, a.caseId, a.recommendationId, policy.id, ev.outcome, JSON.stringify(ev.results), JSON.stringify(a.manifest), hash]);
  return { decision: { id: r.rows[0].id, recommendationId: a.recommendationId, policyId: policy.id, policyVersion: policy.version, outcome: ev.outcome, results: ev.results, manifestHash: hash, createdAt: new Date(r.rows[0].created_at).toISOString() }, policy };
}

export async function policyDecisionsFor(c: pg.PoolClient, caseId: string): Promise<PolicyDecisionRow[]> {
  return (await c.query("SELECT d.id, d.recommendation_id, d.policy_id, p.version, d.outcome, d.results, d.manifest_hash, d.created_at FROM policy_decisions d JOIN policies p ON p.id = d.policy_id WHERE d.case_id = $1 ORDER BY d.created_at, d.id", [caseId]))
    .rows.map(r => ({ id: r.id, recommendationId: r.recommendation_id, policyId: r.policy_id, policyVersion: r.version, outcome: r.outcome, results: r.results, manifestHash: r.manifest_hash, createdAt: new Date(r.created_at).toISOString() }));
}

/** The policy decides who may act. Roles alone are not authority. */
export function assertAuthority(policy: PolicyRow, actionClass: ActionClass, roles: string[]): void {
  const need = policy.authority[actionClass];
  if (!need.some(r => roles.includes(r))) throw new GovernanceError(`policy ${policy.key} v${policy.version} requires one of: ${need.join(", ")} for ${actionClass} actions`, "forbidden");
}

export interface HumanDecisionRow { id: string; recommendationId: string; policyDecisionId: string; decision: string; rationale: string; actorId: string; caseVersion: number; createdAt: string }
export async function recordHumanDecision(c: pg.PoolClient, institutionId: string, d: { caseId: string; recommendationId: string; policyDecisionId: string; decision: string; rationale: string; actorId: string; caseVersion: number }): Promise<HumanDecisionRow> {
  const r = await c.query("INSERT INTO human_decisions (institution_id, case_id, recommendation_id, policy_decision_id, decision, rationale, actor_id, case_version) VALUES ($1,$2,$3,$4,$5::decision_kind,$6,$7,$8) RETURNING id, created_at",
    [institutionId, d.caseId, d.recommendationId, d.policyDecisionId, d.decision, d.rationale, d.actorId, d.caseVersion]);
  return { id: r.rows[0].id, ...d, createdAt: new Date(r.rows[0].created_at).toISOString() };
}
export async function humanDecisionsFor(c: pg.PoolClient, caseId: string): Promise<HumanDecisionRow[]> {
  return (await c.query("SELECT * FROM human_decisions WHERE case_id = $1 ORDER BY created_at, id", [caseId])).rows.map(r => ({ id: r.id, recommendationId: r.recommendation_id, policyDecisionId: r.policy_decision_id, decision: r.decision, rationale: r.rationale, actorId: r.actor_id, caseVersion: r.case_version, createdAt: new Date(r.created_at).toISOString() }));
}

export interface HandoffRow { id: string; caseId: string; decisionId: string; task: string; ownerId: string | null; status: string; outcome: string | null; updatedAt: string; caseKey?: string }
const mapHandoff = (r: Record<string, unknown>): HandoffRow => ({ id: r.id as string, caseId: r.case_id as string, decisionId: r.decision_id as string, task: r.task as string, ownerId: (r.owner_id as string | null) ?? null, status: r.status as string, outcome: (r.outcome as string | null) ?? null, updatedAt: new Date(r.updated_at as string).toISOString() });
export async function createHandoff(c: pg.PoolClient, institutionId: string, h: { caseId: string; decisionId: string; task: string; ownerId: string | null }): Promise<HandoffRow> {
  return mapHandoff((await c.query("INSERT INTO action_handoffs (institution_id, case_id, decision_id, task, owner_id) VALUES ($1,$2,$3,$4,$5) RETURNING *", [institutionId, h.caseId, h.decisionId, h.task, h.ownerId])).rows[0]);
}
export async function handoffsFor(c: pg.PoolClient, caseId: string): Promise<HandoffRow[]> { return (await c.query("SELECT * FROM action_handoffs WHERE case_id = $1 ORDER BY created_at", [caseId])).rows.map(mapHandoff); }
export async function handoffById(c: pg.PoolClient, id: string): Promise<HandoffRow | null> { const r = await c.query("SELECT * FROM action_handoffs WHERE id = $1", [id]); return r.rows[0] ? mapHandoff(r.rows[0]) : null; }
export async function setHandoff(c: pg.PoolClient, id: string, actorId: string, status: string, outcome: string | null): Promise<HandoffRow> {
  return mapHandoff((await c.query("UPDATE action_handoffs SET status = $2::handoff_status, outcome = $3, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING *", [id, status, outcome, actorId])).rows[0]);
}
export async function handoffsForCases(c: pg.PoolClient, caseIds: string[]): Promise<HandoffRow[]> {
  return (await c.query("SELECT * FROM action_handoffs WHERE case_id = ANY($1::uuid[]) ORDER BY status, created_at DESC", [caseIds])).rows.map(mapHandoff);
}
