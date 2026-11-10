import type pg from "pg";
import { activePolicy, assertAuthority, createHandoff, evaluateAndRecord, GovernanceError, handoffById, handoffsFor, handoffsForCases, humanDecisionsFor, policyDecisionsFor, recordHumanDecision, setHandoff,
  type ActionClass, type Manifest, type PolicyDecisionRow } from "../../governance/src/index.js";
import { PostgresGraph } from "../../graph/src/index.js";
import { getPrincipal, listPrincipals, permissionsOf } from "../../identity/src/index.js";
import { evidenceBriefs } from "../../ingest/src/observations.js";
import { audit } from "../../ingest/src/store.js";
import { runBriefs } from "../../scenario/src/index.js";

export class CaseError extends Error { constructor(message: string, readonly code: "not_found" | "conflict" | "invalid" | "forbidden") { super(message); } }
export interface Actor { id: string; roles: string[] }
type State = "open" | "analysis" | "in_review" | "decided" | "closed";

interface CaseRow { id: string; case_key: string; title: string; objective: string; domain: string; sensitivity: string; state: State; owner_id: string; reviewer_id: string | null; disposition: string | null; version: number; start_snapshot: unknown; signal: unknown; created_at: string; updated_at: string; closed_at: string | null }
const isAuditor = (a: Actor) => a.roles.includes("auditor");

/** Loads a case the actor may see. A restricted case the actor has no part in is reported as not found, so its existence is not revealed. */
async function load(c: pg.PoolClient, actor: Actor, id: string, lock = false): Promise<CaseRow> {
  const r = await c.query(`SELECT * FROM cases WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  const row = r.rows[0] as CaseRow | undefined;
  if (!row) throw new CaseError("case not found", "not_found");
  if (row.sensitivity === "restricted" && !isAuditor(actor)) {
    const p = await c.query("SELECT 1 FROM case_participants WHERE case_id = $1 AND principal_id = $2", [id, actor.id]);
    if (!p.rowCount) throw new CaseError("case not found", "not_found");
  }
  return row;
}
const requireState = (k: CaseRow, ...ok: State[]) => { if (!ok.includes(k.state)) throw new CaseError(`case is ${k.state}; this needs ${ok.join(" or ")}`, "conflict"); };
const requireOwner = (k: CaseRow, a: Actor, what: string) => { if (k.owner_id !== a.id) throw new CaseError(`only the case owner may ${what}`, "forbidden"); };

interface CaseUpdate { state?: State; reviewerId?: string; disposition?: string; closed?: boolean }
async function event(c: pg.PoolClient, inst: string, k: CaseRow, actor: Actor, kind: string, rationale: string | null, payload: Record<string, unknown> = {}, upd: CaseUpdate = {}): Promise<void> {
  const seq = (await c.query("SELECT COALESCE(max(seq), 0) + 1 AS n FROM case_events WHERE case_id = $1", [k.id])).rows[0].n as number;
  await c.query("INSERT INTO case_events (institution_id, case_id, seq, actor_id, kind, rationale, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)", [inst, k.id, seq, actor.id, kind, rationale, JSON.stringify(payload)]);
  // Every value goes in as a parameter; nothing is built into the SQL text.
  const sets = ["version = version + 1", "updated_at = now()"], args: unknown[] = [k.id];
  if (upd.state) { args.push(upd.state); sets.push("state = $" + args.length + "::case_state"); }
  if (upd.reviewerId) { args.push(upd.reviewerId); sets.push("reviewer_id = $" + args.length + "::uuid"); }
  if (upd.disposition) { args.push(upd.disposition); sets.push("disposition = $" + args.length); }
  if (upd.closed) sets.push("closed_at = now()");
  await c.query("UPDATE cases SET " + sets.join(", ") + " WHERE id = $1", args);
  await audit(c, inst, { actorType: "principal", actorId: actor.id, action: `case.${kind}`, objectType: "case", objectId: k.id, payload: { caseKey: k.case_key, ...payload } });
}

export async function createCase(c: pg.PoolClient, inst: string, actor: Actor, i: { title: string; objective: string; domain: string; sensitivity?: "internal" | "restricted"; signal?: Record<string, unknown> }): Promise<{ id: string; caseKey: string }> {
  const snap = await new PostgresGraph(c, inst).snapshot();
  const n = (await c.query("INSERT INTO case_counters (institution_id, n) VALUES ($1, 1) ON CONFLICT (institution_id) DO UPDATE SET n = case_counters.n + 1 RETURNING n", [inst])).rows[0].n as number;
  const key = `CASE-${String(n).padStart(4, "0")}`;
  const r = await c.query("INSERT INTO cases (institution_id, case_key, title, objective, domain, sensitivity, owner_id, start_snapshot, signal) VALUES ($1,$2,$3,$4,$5,$6::case_sensitivity,$7,$8,$9) RETURNING id",
    [inst, key, i.title, i.objective, i.domain, i.sensitivity ?? "internal", actor.id, JSON.stringify({ graphSnapshotId: snap.id, graphHash: snap.hash, entities: snap.entities, relationships: snap.relationships, openedAt: new Date().toISOString() }), JSON.stringify(i.signal ?? {})]);
  const k = (await c.query("SELECT * FROM cases WHERE id = $1", [r.rows[0].id])).rows[0] as CaseRow;
  await c.query("INSERT INTO case_participants (institution_id, case_id, principal_id, role) VALUES ($1,$2,$3,'owner')", [inst, k.id, actor.id]);
  await event(c, inst, k, actor, "opened", null, { title: i.title, sensitivity: i.sensitivity ?? "internal", graphHash: snap.hash });
  return { id: k.id, caseKey: key };
}

export async function listCases(c: pg.PoolClient, actor: Actor, state?: string): Promise<unknown[]> {
  const r = await c.query(
    `SELECT k.id, k.case_key, k.title, k.domain, k.sensitivity, k.state, k.owner_id, k.reviewer_id, k.version, k.updated_at, k.created_at, k.signal->>'id' AS signal_id
     FROM cases k WHERE ($1::case_state IS NULL OR k.state = $1::case_state)
       AND (k.sensitivity = 'internal' OR $3 OR EXISTS (SELECT 1 FROM case_participants p WHERE p.case_id = k.id AND p.principal_id = $2))
     ORDER BY k.updated_at DESC LIMIT 200`, [state ?? null, actor.id, isAuditor(actor)]);
  return r.rows;
}

export async function addParticipant(c: pg.PoolClient, inst: string, actor: Actor, caseId: string, principalId: string): Promise<void> {
  const k = await load(c, actor, caseId, true); requireOwner(k, actor, "add participants"); requireState(k, "open", "analysis", "in_review", "decided");
  const p = await getPrincipal(c, principalId);
  if (!p || p.disabled) throw new CaseError("principal not found or disabled", "invalid");
  const ins = await c.query("INSERT INTO case_participants (institution_id, case_id, principal_id, role) VALUES ($1,$2,$3,'contributor') ON CONFLICT DO NOTHING", [inst, caseId, principalId]);
  if (ins.rowCount) await event(c, inst, k, actor, "participant_added", null, { principalId });
}

export async function addEvidence(c: pg.PoolClient, inst: string, actor: Actor, caseId: string, i: { evidenceId: string; role: "supports" | "contradicts" | "context"; note?: string }): Promise<void> {
  const k = await load(c, actor, caseId, true); requireState(k, "open", "analysis");
  if ((await evidenceBriefs(c, [i.evidenceId])).length === 0) throw new CaseError("evidence not found", "invalid");
  const ins = await c.query("INSERT INTO case_evidence (institution_id, case_id, evidence_id, role, note, added_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [inst, caseId, i.evidenceId, i.role, i.note ?? null, actor.id]);
  if (!ins.rowCount) throw new CaseError("this evidence is already attached; evidence is never overwritten", "conflict");
  await event(c, inst, k, actor, "evidence_added", i.note ?? null, { evidenceId: i.evidenceId, role: i.role });
}

export async function addScenario(c: pg.PoolClient, inst: string, actor: Actor, caseId: string, runId: string): Promise<void> {
  const k = await load(c, actor, caseId, true); requireState(k, "open", "analysis");
  if ((await runBriefs(c, [runId])).length === 0) throw new CaseError("scenario run not found", "invalid");
  const ins = await c.query("INSERT INTO case_scenarios (institution_id, case_id, run_id, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [inst, caseId, runId, actor.id]);
  if (ins.rowCount) await event(c, inst, k, actor, "scenario_added", null, { runId });
}

export async function startAnalysis(c: pg.PoolClient, inst: string, actor: Actor, caseId: string): Promise<void> {
  const k = await load(c, actor, caseId, true); requireOwner(k, actor, "start analysis"); requireState(k, "open");
  if (!(await c.query("SELECT 1 FROM case_evidence WHERE case_id = $1", [caseId])).rowCount) throw new CaseError("attach at least one evidence record before starting analysis", "conflict");
  await event(c, inst, k, actor, "analysis_started", null, {}, { state: "analysis" });
}

export async function addRecommendation(c: pg.PoolClient, inst: string, actor: Actor, caseId: string, i: { title: string; description: string; actionClass: ActionClass; constraints?: string; scenarioRunId?: string; evidenceIds: string[]; ownerId?: string }): Promise<{ id: string }> {
  const k = await load(c, actor, caseId, true); requireState(k, "analysis");
  const att = new Set((await c.query("SELECT evidence_id FROM case_evidence WHERE case_id = $1", [caseId])).rows.map(r => r.evidence_id as string));
  const stray = i.evidenceIds.filter(e => !att.has(e));
  if (stray.length) throw new CaseError("a recommendation may cite only evidence attached to the case", "invalid");
  if (i.scenarioRunId && !(await c.query("SELECT 1 FROM case_scenarios WHERE case_id = $1 AND run_id = $2", [caseId, i.scenarioRunId])).rowCount) throw new CaseError("the scenario run must be attached to the case first", "invalid");
  if (i.ownerId && !(await getPrincipal(c, i.ownerId))) throw new CaseError("owner not found", "invalid");
  const r = await c.query("INSERT INTO recommendations (institution_id, case_id, title, description, constraints_text, action_class, scenario_run_id, owner_id, author_id) VALUES ($1,$2,$3,$4,$5,$6::action_class,$7,$8,$9) RETURNING id",
    [inst, caseId, i.title, i.description, i.constraints ?? null, i.actionClass, i.scenarioRunId ?? null, i.ownerId ?? null, actor.id]);
  for (const e of new Set(i.evidenceIds)) await c.query("INSERT INTO recommendation_evidence (institution_id, recommendation_id, evidence_id) VALUES ($1,$2,$3)", [inst, r.rows[0].id, e]);
  await event(c, inst, k, actor, "recommendation_added", null, { recommendationId: r.rows[0].id, actionClass: i.actionClass });
  return { id: r.rows[0].id };
}

interface RecRow { id: string; title: string; description: string; constraints_text: string | null; action_class: ActionClass; scenario_run_id: string | null; owner_id: string | null; author_id: string; status: string; created_at: string }

async function manifestFor(c: pg.PoolClient, k: CaseRow, rec: RecRow): Promise<Manifest> {
  const ids = (await c.query("SELECT evidence_id FROM recommendation_evidence WHERE recommendation_id = $1 ORDER BY evidence_id", [rec.id])).rows.map(r => r.evidence_id as string);
  const briefs = await evidenceBriefs(c, ids);
  const run = rec.scenario_run_id ? (await runBriefs(c, [rec.scenario_run_id]))[0] : undefined;
  return { actionClass: rec.action_class, sensitivity: k.sensitivity, evidence: briefs.map(b => ({ id: b.id, validation: b.validation, dataClass: b.dataClass, sourceStatus: b.sourceStatus })).sort((a, b) => a.id.localeCompare(b.id)), scenario: run ? { runId: run.id, confidence: run.confidence } : null };
}

export interface SubmitResult { submitted: boolean; evaluations: { recommendationId: string; outcome: string; policyVersion: number; results: PolicyDecisionRow["results"] }[] }

/** Routes proposals to a named reviewer. Every proposal is checked against the active policy first; anything but PASS stops here with the reasons. */
export async function submitForReview(c: pg.PoolClient, inst: string, actor: Actor, caseId: string, i: { reviewerId: string; recommendationIds: string[] }): Promise<SubmitResult> {
  const k = await load(c, actor, caseId, true); requireOwner(k, actor, "submit the case for review"); requireState(k, "analysis");
  if (i.recommendationIds.length === 0) throw new CaseError("choose at least one recommendation", "invalid");
  const rv = await getPrincipal(c, i.reviewerId);
  if (!rv || rv.disabled) throw new CaseError("reviewer not found or disabled", "invalid");
  if (!permissionsOf(rv.roles).has("decision.make")) throw new CaseError("the reviewer's roles do not allow decisions", "invalid");
  if (rv.id === k.owner_id) throw new CaseError("the owner cannot review their own case", "forbidden");
  const recs = (await c.query("SELECT * FROM recommendations WHERE case_id = $1 AND id = ANY($2::uuid[])", [caseId, i.recommendationIds])).rows as RecRow[];
  if (recs.length !== new Set(i.recommendationIds).size) throw new CaseError("recommendation not found on this case", "invalid");
  if (recs.some(r => r.status !== "draft")) throw new CaseError("only draft recommendations can be submitted", "conflict");
  if (recs.some(r => r.author_id === rv.id)) throw new CaseError("the reviewer wrote one of these recommendations; separation of duty applies", "forbidden");
  const evaluations: SubmitResult["evaluations"] = [];
  for (const rec of recs) {
    const { decision } = await evaluateAndRecord(c, inst, { caseId, recommendationId: rec.id, manifest: await manifestFor(c, k, rec) });
    evaluations.push({ recommendationId: rec.id, outcome: decision.outcome, policyVersion: decision.policyVersion, results: decision.results });
  }
  if (evaluations.some(e => e.outcome !== "PASS")) return { submitted: false, evaluations };
  await c.query("UPDATE recommendations SET status = 'submitted' WHERE id = ANY($1::uuid[])", [recs.map(r => r.id)]);
  await c.query("INSERT INTO case_participants (institution_id, case_id, principal_id, role) VALUES ($1,$2,$3,'reviewer') ON CONFLICT (case_id, principal_id) DO UPDATE SET role = 'reviewer'", [inst, caseId, rv.id]);
  await event(c, inst, k, actor, "submitted_for_review", null, { reviewerId: rv.id, recommendationIds: recs.map(r => r.id) }, { state: "in_review", reviewerId: rv.id });
  return { submitted: true, evaluations };
}

export interface DecideInput { recommendationId: string; decision: "approve" | "reject" | "defer" | "request_evidence"; rationale: string; caseVersion: number; handoffTask?: string; handoffOwnerId?: string }

export async function decide(c: pg.PoolClient, inst: string, actor: Actor, caseId: string, i: DecideInput): Promise<{ decisionId: string; policyOutcome: string; caseState: State; handoffId: string | null }> {
  const k = await load(c, actor, caseId, true); requireState(k, "in_review");
  if (k.reviewer_id !== actor.id) throw new CaseError("only the named reviewer may decide", "forbidden");
  if (k.owner_id === actor.id) throw new CaseError("the case owner cannot decide their own case", "forbidden");
  if (k.version !== i.caseVersion) throw new CaseError(`the case changed since you opened it (now version ${k.version}); reload before deciding`, "conflict");
  if (i.rationale.trim().length < 10) throw new CaseError("a rationale of at least 10 characters is required", "invalid");
  const rec = (await c.query("SELECT * FROM recommendations WHERE id = $1 AND case_id = $2", [i.recommendationId, caseId])).rows[0] as RecRow | undefined;
  if (!rec || rec.status !== "submitted") throw new CaseError("recommendation is not awaiting a decision", "conflict");
  if (rec.author_id === actor.id) throw new CaseError("you wrote this recommendation; separation of duty applies", "forbidden");
  // Decisions use a fresh evaluation, never the one made at submission. Evidence and policy may have changed since.
  const { decision: pd, policy } = await evaluateAndRecord(c, inst, { caseId, recommendationId: rec.id, manifest: await manifestFor(c, k, rec) });
  try { assertAuthority(policy, rec.action_class, actor.roles); } catch (e) { throw new CaseError((e as GovernanceError).message, "forbidden"); }
  if (i.decision === "approve" && pd.outcome !== "PASS") throw new CaseError(`policy returned ${pd.outcome}; a proposal cannot be approved until every rule passes`, "conflict");
  const hd = await recordHumanDecision(c, inst, { caseId, recommendationId: rec.id, policyDecisionId: pd.id, decision: i.decision, rationale: i.rationale.trim(), actorId: actor.id, caseVersion: k.version });
  const closing = i.decision === "approve" || i.decision === "reject";
  await c.query("UPDATE recommendations SET status = $2 WHERE id = $1", [rec.id, closing ? "decided" : "draft"]);
  let handoffId: string | null = null;
  if (i.decision === "approve" && rec.action_class === "handoff") {
    const h = await createHandoff(c, inst, { caseId, decisionId: hd.id, task: i.handoffTask?.trim() || `${rec.title}: ${rec.description}`, ownerId: rec.owner_id ?? i.handoffOwnerId ?? null });
    handoffId = h.id;
  }
  const open = Number((await c.query("SELECT count(*) FROM recommendations WHERE case_id = $1 AND status = 'submitted'", [caseId])).rows[0].count);
  const next: State = open > 0 ? "in_review" : closing ? "decided" : "analysis";
  await event(c, inst, k, actor, `decision_${i.decision}`, i.rationale.trim(), { recommendationId: rec.id, decisionId: hd.id, policyOutcome: pd.outcome, policyVersion: pd.policyVersion, handoffId }, next === k.state ? {} : { state: next });
  return { decisionId: hd.id, policyOutcome: pd.outcome, caseState: next, handoffId };
}

export async function updateHandoff(c: pg.PoolClient, inst: string, actor: Actor, handoffId: string, i: { status: "done" | "cancelled"; outcome: string }): Promise<void> {
  const h = await handoffById(c, handoffId);
  if (!h) throw new CaseError("handoff not found", "not_found");
  const k = await load(c, actor, h.caseId, true);
  if (h.status !== "open") throw new CaseError(`handoff is already ${h.status}`, "conflict");
  if (i.outcome.trim().length < 5) throw new CaseError("record the outcome in at least 5 characters", "invalid");
  await setHandoff(c, handoffId, actor.id, i.status, i.outcome.trim());
  await event(c, inst, k, actor, `handoff_${i.status}`, i.outcome.trim(), { handoffId });
}

export async function closeCase(c: pg.PoolClient, inst: string, actor: Actor, caseId: string, i: { rationale: string; outcome?: string }): Promise<{ disposition: string; memoryId: string | null }> {
  const k = await load(c, actor, caseId, true); requireOwner(k, actor, "close the case"); requireState(k, "open", "analysis", "decided");
  if (i.rationale.trim().length < 10) throw new CaseError("a rationale of at least 10 characters is required", "invalid");
  if (k.state !== "decided") {
    await event(c, inst, k, actor, "closed", i.rationale.trim(), { disposition: "dismissed" }, { state: "closed", disposition: "dismissed", closed: true });
    return { disposition: "dismissed", memoryId: null };
  }
  const hs = await handoffsFor(c, caseId);
  if (hs.some(h => h.status === "open")) throw new CaseError("record the outcome of every open handoff before closing", "conflict");
  const ds = await humanDecisionsFor(c, caseId);
  const last = ds.filter(d => d.decision === "approve" || d.decision === "reject").at(-1);
  if (!last) throw new CaseError("the case has no final decision", "conflict");
  const recs = (await c.query("SELECT id, title FROM recommendations WHERE case_id = $1", [caseId])).rows as { id: string; title: string }[];
  const title = new Map(recs.map(r => [r.id, r.title]));
  const summary = [`Objective: ${k.objective}`, ...ds.filter(d => d.decision === "approve" || d.decision === "reject").map(d => `${d.decision === "approve" ? "Approved" : "Rejected"}: ${title.get(d.recommendationId) ?? d.recommendationId}. Rationale: ${d.rationale}`)].join("\n");
  const outcome = [i.outcome?.trim(), ...hs.map(h => h.outcome && `${h.status}: ${h.outcome}`)].filter(Boolean).join("\n") || null;
  const m = await c.query("INSERT INTO memory_records (institution_id, case_id, decision_id, title, summary, domain, sensitivity, decision, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7::case_sensitivity,$8::decision_kind,$9) RETURNING id",
    [inst, caseId, last.id, k.title, summary, k.domain, k.sensitivity, last.decision, outcome]);
  const disposition = last.decision === "approve" ? "approved" : "rejected";
  await event(c, inst, k, actor, "closed", i.rationale.trim(), { disposition, memoryId: m.rows[0].id }, { state: "closed", disposition, closed: true });
  return { disposition, memoryId: m.rows[0].id };
}

export async function getCase(c: pg.PoolClient, actor: Actor, caseId: string): Promise<unknown> {
  const k = await load(c, actor, caseId);
  const names = new Map((await listPrincipals(c)).map(p => [p.id, p.displayName ?? p.subject]));
  const nm = (id: string | null) => id ? { id, name: names.get(id) ?? id } : null;
  const evRows = (await c.query("SELECT evidence_id, role, note, added_by, added_at FROM case_evidence WHERE case_id = $1 ORDER BY added_at", [caseId])).rows;
  const briefs = new Map((await evidenceBriefs(c, evRows.map(r => r.evidence_id))).map(b => [b.id, b]));
  const runIds = (await c.query("SELECT run_id FROM case_scenarios WHERE case_id = $1 ORDER BY added_at", [caseId])).rows.map(r => r.run_id as string);
  const recs = (await c.query("SELECT * FROM recommendations WHERE case_id = $1 ORDER BY created_at, id", [caseId])).rows as RecRow[];
  const recEv = (await c.query("SELECT recommendation_id, evidence_id FROM recommendation_evidence WHERE recommendation_id = ANY($1::uuid[])", [recs.map(r => r.id)])).rows;
  const pds = await policyDecisionsFor(c, caseId);
  const ds = await humanDecisionsFor(c, caseId);
  const [policy, hs] = [await activePolicy(c), await handoffsFor(c, caseId)];
  return {
    id: k.id, caseKey: k.case_key, title: k.title, objective: k.objective, domain: k.domain, sensitivity: k.sensitivity, state: k.state, disposition: k.disposition, version: k.version,
    owner: nm(k.owner_id), reviewer: nm(k.reviewer_id), startSnapshot: k.start_snapshot, signal: k.signal, createdAt: k.created_at, updatedAt: k.updated_at, closedAt: k.closed_at,
    activePolicy: policy ? { id: policy.id, key: policy.key, version: policy.version, authority: policy.authority } : null,
    participants: (await c.query("SELECT principal_id, role FROM case_participants WHERE case_id = $1 ORDER BY role, principal_id", [caseId])).rows.map(r => ({ ...nm(r.principal_id)!, role: r.role })),
    evidence: evRows.map(r => ({ ...(briefs.get(r.evidence_id) ?? { id: r.evidence_id }), role: r.role, note: r.note, addedBy: nm(r.added_by), addedAt: r.added_at })),
    scenarios: await runBriefs(c, runIds),
    recommendations: recs.map(r => ({ id: r.id, title: r.title, description: r.description, constraints: r.constraints_text, actionClass: r.action_class, scenarioRunId: r.scenario_run_id, owner: nm(r.owner_id), author: nm(r.author_id), status: r.status, evidenceIds: recEv.filter(e => e.recommendation_id === r.id).map(e => e.evidence_id), latestPolicy: pds.filter(p => p.recommendationId === r.id).at(-1) ?? null })),
    policyDecisions: pds,
    decisions: ds.map(d => ({ ...d, actor: nm(d.actorId) })),
    handoffs: hs.map(h => ({ ...h, owner: nm(h.ownerId) })),
    events: (await c.query("SELECT seq, actor_id, kind, rationale, payload, created_at FROM case_events WHERE case_id = $1 ORDER BY seq", [caseId])).rows.map(r => ({ seq: r.seq, actor: nm(r.actor_id), kind: r.kind, rationale: r.rationale, payload: r.payload, at: r.created_at })),
  };
}

export async function listHandoffs(c: pg.PoolClient, actor: Actor): Promise<unknown[]> {
  const visible = (await listCases(c, actor)) as { id: string; case_key: string; title: string }[];
  const byId = new Map(visible.map(k => [k.id, k]));
  return (await handoffsForCases(c, [...byId.keys()])).map(h => ({ ...h, caseKey: byId.get(h.caseId)!.case_key, caseTitle: byId.get(h.caseId)!.title }));
}

export async function searchMemory(c: pg.PoolClient, actor: Actor, q?: string): Promise<unknown[]> {
  const r = await c.query(
    `SELECT m.id, m.case_id, k.case_key, m.title, m.summary, m.domain, m.sensitivity, m.decision, m.outcome, m.created_at
     FROM memory_records m JOIN cases k ON k.id = m.case_id
     WHERE ($1::text IS NULL OR to_tsvector('simple', m.title || ' ' || m.summary || ' ' || COALESCE(m.outcome, '')) @@ plainto_tsquery('simple', $1))
       AND (m.sensitivity = 'internal' OR $3 OR EXISTS (SELECT 1 FROM case_participants p WHERE p.case_id = m.case_id AND p.principal_id = $2))
     ORDER BY m.created_at DESC LIMIT 50`, [q?.trim() || null, actor.id, isAuditor(actor)]);
  return r.rows;
}

export interface SignalInput { signalId: string; ruleId: string; rulesVersion: string; settingsVersion?: number | null; title: string; objective: string; domain: string; observedAt: string; evidenceIds: string[]; values: Record<string, unknown> }

/** Opens a case from a detected signal, with the signal's own evidence attached. A signal that already has an open case returns that case. */
export async function openCaseFromSignal(c: pg.PoolClient, inst: string, actor: Actor, i: SignalInput): Promise<{ id: string; caseKey: string; existing: boolean }> {
  const ex = await c.query("SELECT id, case_key FROM cases WHERE signal->>'id' = $1 AND state <> 'closed' ORDER BY created_at LIMIT 1", [i.signalId]);
  if (ex.rows[0]) return { id: ex.rows[0].id, caseKey: ex.rows[0].case_key, existing: true };
  const made = await createCase(c, inst, actor, { title: i.title.slice(0, 200), objective: i.objective, domain: i.domain, signal: { id: i.signalId, ruleId: i.ruleId, rulesVersion: i.rulesVersion, settingsVersion: i.settingsVersion ?? null, observedAt: i.observedAt, values: i.values, origin: "sector signal" } });
  for (const e of new Set(i.evidenceIds)) await addEvidence(c, inst, actor, made.id, { evidenceId: e, role: "context", note: `Evidence behind signal ${i.signalId}` });
  return { ...made, existing: false };
}
