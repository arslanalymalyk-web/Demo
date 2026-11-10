import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { DEFAULT_AUTHORITY, DEFAULT_RULES, authoritySchema, ensureDefaultPolicy, evaluate, rulesSchema, type Manifest } from "../packages/governance/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { setSourceStatus } from "../packages/ingest/src/registry.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

const ev = (id: string, o: Partial<Manifest["evidence"][number]> = {}) => ({ id, validation: "accepted", dataClass: "public_record", sourceStatus: "approved", ...o });
const man = (o: Partial<Manifest> = {}): Manifest => ({ actionClass: "advisory", sensitivity: "internal", evidence: [ev("aaaaaaaa-0000-0000-0000-000000000001")], scenario: null, ...o });
const outcome = (m: Manifest) => evaluate(DEFAULT_RULES, m);

describe("policy evaluation", () => {
  it("passes a well-supported advisory proposal and explains every rule", () => {
    const r = outcome(man());
    expect(r.outcome).toBe("PASS");
    expect(r.results).toHaveLength(DEFAULT_RULES.length);
    expect(r.results.every(x => x.explanation.length > 0)).toBe(true);
  });
  it("holds a proposal with no evidence", () => expect(outcome(man({ evidence: [] }))).toMatchObject({ outcome: "HOLD", results: expect.arrayContaining([expect.objectContaining({ ruleId: "R1", outcome: "HOLD" })]) }));
  it("blocks quarantined evidence and evidence from unapproved sources", () => {
    expect(outcome(man({ evidence: [ev("a", { validation: "quarantined" })] })).outcome).toBe("BLOCK");
    expect(outcome(man({ evidence: [ev("a", { sourceStatus: "pending_rights" })] })).outcome).toBe("BLOCK");
  });
  it("keeps sample content from supporting a handoff, but allows it as advice", () => {
    const sample = [ev("a", { dataClass: "sample_dataset" })];
    expect(outcome(man({ actionClass: "handoff", evidence: sample, scenario: { runId: "r", confidence: "high" } })).outcome).toBe("BLOCK");
    expect(outcome(man({ actionClass: "advisory", evidence: sample })).outcome).toBe("PASS");
  });
  it("requires a scenario of at least medium confidence for a handoff", () => {
    expect(outcome(man({ actionClass: "handoff" })).outcome).toBe("HOLD");
    expect(outcome(man({ actionClass: "handoff", scenario: { runId: "r", confidence: "low" } })).outcome).toBe("HOLD");
    expect(outcome(man({ actionClass: "handoff", scenario: { runId: "r", confidence: "medium" } })).outcome).toBe("PASS");
  });
  it("lets BLOCK outrank HOLD", () => expect(outcome(man({ actionClass: "handoff", evidence: [ev("a", { validation: "rejected" })] })).outcome).toBe("BLOCK"));
  it("validates policy documents", () => {
    expect(rulesSchema.safeParse(DEFAULT_RULES).success).toBe(true);
    expect(rulesSchema.safeParse([]).success).toBe(false);
    expect(rulesSchema.safeParse([{ id: "x", type: "evidence_required" }, { id: "x", type: "scenario_required" }]).success).toBe(false);
    expect(rulesSchema.safeParse([{ id: "x", type: "run_anything" }]).success).toBe(false);
    expect(authoritySchema.safeParse(DEFAULT_AUTHORITY).success).toBe(true);
    expect(authoritySchema.safeParse({ monitor: [] , advisory: ["a"], handoff: ["a"] }).success).toBe(false);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });
const rec = (k: string, payload: Record<string, unknown> = { title: k, records_count: 5 }): RawRecord => ({ externalKey: k, kind: "catalog", sourceUrl: `https://p.example/${k}`, originalAgency: "Agency", eventTime: "2026-01-01T00:00:00Z", payload });

suite("cases and governance against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID(), sourceKey = `s-${id.slice(0, 6)}`, sampleKey = `x-${id.slice(0, 6)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Gov')", [id]);
      await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,'Public source','P','Agency','fake','https://p.example','approved','CC BY',true)", [id, sourceKey]);
      await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified, data_class) VALUES ($1,$2,'Sample source','P','Agency','fake','https://p.example','approved','CC BY',true,'sample_dataset')", [id, sampleKey]);
    });
    const fake = (rs: RawRecord[]): Connector => ({ platform: "fake", async *fetchRecords() { for (const r of rs) yield r; } });
    const ingest = (key: string, rs: RawRecord[]) => runIngestion({ pool: app, institutionId: id, sourceKey: key, connector: fake(rs), http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    await ingest(sourceKey, [rec("e1"), rec("e2"), { ...rec("bad"), payload: {} }]);
    await ingest(sampleKey, [rec("sample1")]);
    const evidence = await withTenant(app, id, async c => Object.fromEntries((await c.query("SELECT id, external_key FROM evidence_objects")).rows.map(r => [r.external_key, r.id as string])));
    const tokens = {
      ana: await addUser(owner, app, id, "ana", ["analyst"]), ben: await addUser(owner, app, id, "ben", ["analyst"]),
      rita: await addUser(owner, app, id, "rita", ["approver"]), rob: await addUser(owner, app, id, "rob", ["approver"]), ed: await addUser(owner, app, id, "ed", ["executive"]),
      olga: await addUser(owner, app, id, "olga", ["operations"]), adam: await addUser(owner, app, id, "adam", ["administrator"]), adel: await addUser(owner, app, id, "adel", ["administrator"]), aud: await addUser(owner, app, id, "aud", ["auditor"]),
    };
    await withTenant(app, id, c => ensureDefaultPolicy(c, id));
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = async (who: keyof typeof tokens, method: string, url: string, payload?: unknown) => {
      const r = await server.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
      return { status: r.statusCode, body: r.json() as Record<string, any> };
    };
    const ids = Object.fromEntries(await Promise.all((Object.keys(tokens) as (keyof typeof tokens)[]).map(async w => [w, (await call(w, "GET", "/v1/identity/me")).body.id as string])));
    const run = async (level: "low" | "medium" | "high") => {
      const rid = randomUUID();
      await withTenant(owner, id, c => c.query("INSERT INTO scenario_runs (id, institution_id, template_key, template_version, formula_version, assumptions, inputs, manifest_hash, results_hash, confidence, sensitivity, created_by) VALUES ($1,$2,'oil-price-shock',1,'t','{}','{}',repeat('a',64),repeat('b',64),$3,'[]','test')", [rid, id, JSON.stringify({ level })]));
      return rid;
    };
    /** Opens a case with evidence attached and analysis started. */
    const openCase = async (o: { sensitivity?: string; evidence?: string[] } = {}) => {
      const made = await call("ana", "POST", "/v1/cases", { title: "Strait disruption review", objective: "Assess exposure to a transit restriction", domain: "energy", ...(o.sensitivity ? { sensitivity: o.sensitivity } : {}) });
      expect(made.status).toBe(201);
      const caseId = made.body.id as string;
      for (const e of o.evidence ?? ["e1"]) expect((await call("ana", "POST", `/v1/cases/${caseId}/evidence`, { evidenceId: evidence[e], role: "supports" })).status).toBe(201);
      expect((await call("ana", "POST", `/v1/cases/${caseId}/start`)).status).toBe(200);
      return caseId;
    };
    const propose = async (caseId: string, o: Record<string, unknown> = {}) => (await call("ana", "POST", `/v1/cases/${caseId}/recommendations`, { title: "Raise monitoring", description: "Track exports weekly", actionClass: "advisory", evidenceIds: [evidence.e1], ...o })).body.id as string;
    const get = async (who: keyof typeof tokens, caseId: string) => (await call(who, "GET", `/v1/cases/${caseId}`)).body;
    return { id, call, evidence, ids, run, openCase, propose, get, ingest, sourceKey };
  }

  it("takes a case from signal to decision to institutional memory, with every step audited", async () => {
    const s = await scene();
    const caseId = await s.openCase();
    const r = await s.propose(caseId);
    const sub = await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] });
    expect(sub.body).toMatchObject({ submitted: true, evaluations: [{ outcome: "PASS", policyVersion: 1 }] });
    let c = await s.get("rita", caseId);
    expect(c).toMatchObject({ state: "in_review", caseKey: "CASE-0001", reviewer: { name: "rita" } });
    expect(c.startSnapshot.graphHash).toBeDefined();
    const d = await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { recommendationId: r, decision: "approve", rationale: "Evidence is sufficient for monitoring.", caseVersion: c.version });
    expect(d.body).toMatchObject({ policyOutcome: "PASS", caseState: "decided", handoffId: null });
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/close`, { rationale: "Monitoring in place.", outcome: "Weekly tracking started." })).body).toMatchObject({ disposition: "approved" });
    c = await s.get("ana", caseId);
    expect(c.state).toBe("closed");
    expect(c.events.map((e: { kind: string }) => e.kind)).toEqual(["opened", "evidence_added", "analysis_started", "recommendation_added", "submitted_for_review", "decision_approve", "closed"]);
    expect(c.decisions[0]).toMatchObject({ decision: "approve", actor: { name: "rita" } });
    expect((await s.call("ana", "GET", "/v1/memory?q=monitoring")).body).toHaveLength(1);
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/evidence`, { evidenceId: s.evidence.e2 })).status).toBe(409); // closed cases do not change
    expect((await s.call("aud", "GET", "/v1/audit/verify")).body).toMatchObject({ ok: true });
  });

  it("creates a handoff only on approval of a handoff action, and will not close until its outcome is recorded", async () => {
    const s = await scene();
    const caseId = await s.openCase(), runId = await s.run("medium");
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/scenarios`, { runId })).status).toBe(201);
    const r = await s.propose(caseId, { actionClass: "handoff", title: "Brief treasury desk", description: "Walk the desk through the exposure", scenarioRunId: runId, ownerId: s.ids.olga });
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] })).body.submitted).toBe(true);
    const d = await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { recommendationId: r, decision: "approve", rationale: "Approved as a human-owned task.", caseVersion: (await s.get("rita", caseId)).version });
    expect(d.body.handoffId).toBeTruthy();
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/close`, { rationale: "All done here." })).status).toBe(409);
    expect((await s.call("ana", "POST", `/v1/handoffs/${d.body.handoffId}/update`, { status: "done", outcome: "Briefing held" })).status).toBe(403); // not an operations role
    expect((await s.call("olga", "POST", `/v1/handoffs/${d.body.handoffId}/update`, { status: "done", outcome: "Briefing held with desk." })).status).toBe(200);
    expect((await s.call("olga", "POST", `/v1/handoffs/${d.body.handoffId}/update`, { status: "cancelled", outcome: "Changed my mind" })).status).toBe(409);
    expect((await s.call("olga", "GET", "/v1/handoffs")).body[0]).toMatchObject({ status: "done", caseKey: "CASE-0001" });
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/close`, { rationale: "Handoff completed and recorded." })).body.disposition).toBe("approved");
    expect((await s.call("ana", "GET", "/v1/memory")).body[0].outcome).toMatch(/Briefing held/);
  });

  it("stops at submission when policy says HOLD or BLOCK, and records why", async () => {
    const s = await scene();
    const caseId = await s.openCase({ evidence: ["e1", "bad"] }), low = await s.run("low");
    await s.call("ana", "POST", `/v1/cases/${caseId}/scenarios`, { runId: low });
    const weak = await s.propose(caseId, { actionClass: "handoff", scenarioRunId: low, title: "Act on it", description: "Execute a handoff" });
    const hold = await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [weak] });
    expect(hold.body.submitted).toBe(false);
    expect(hold.body.evaluations[0]).toMatchObject({ outcome: "HOLD" });
    expect(hold.body.evaluations[0].results.find((x: { ruleId: string }) => x.ruleId === "R6").explanation).toMatch(/low; medium is required/);
    const bad = await s.propose(caseId, { evidenceIds: [s.evidence.bad], title: "Use bad data", description: "Rely on a quarantined record" });
    const block = await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [bad] });
    expect(block.body.evaluations[0].outcome).toBe("BLOCK");
    const c = await s.get("ana", caseId);
    expect(c.state).toBe("analysis");
    expect(c.policyDecisions.map((p: { outcome: string }) => p.outcome)).toEqual(["HOLD", "BLOCK"]);
  });

  it("enforces separation of duty and named-reviewer authority", async () => {
    const s = await scene();
    const caseId = await s.openCase(), runId = await s.run("high");
    await s.call("ana", "POST", `/v1/cases/${caseId}/scenarios`, { runId });
    const r = await s.propose(caseId);
    // the owner cannot review their own case, and the reviewer must be allowed to decide
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.ana, recommendationIds: [r] })).status).toBe(422);
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.ben, recommendationIds: [r] })).status).toBe(422);
    expect((await s.call("ben", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] })).status).toBe(403); // not the owner
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] })).body.submitted).toBe(true);
    const v = (await s.get("rita", caseId)).version, body = { recommendationId: r, decision: "approve", rationale: "Looks right to me.", caseVersion: v };
    expect((await s.call("rob", "POST", `/v1/cases/${caseId}/decision`, body)).status).toBe(403); // another approver, not the named one
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/decision`, body)).status).toBe(403); // analyst lacks decision.make
    expect((await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { ...body, caseVersion: v - 1 })).status).toBe(409); // stale view
    expect((await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { ...body, rationale: "ok" })).status).toBe(422);
    expect((await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, body)).status).toBe(200);
    const refusals = await withTenant(app, s.id, async c => Number((await c.query("SELECT count(*) FROM audit_events WHERE action = 'governance.refused'")).rows[0].count));
    expect(refusals).toBeGreaterThanOrEqual(2);
  });

  it("lets the policy, not the role, decide who may approve a handoff", async () => {
    const s = await scene();
    const caseId = await s.openCase(), runId = await s.run("high");
    await s.call("ana", "POST", `/v1/cases/${caseId}/scenarios`, { runId });
    const r = await s.propose(caseId, { actionClass: "handoff", scenarioRunId: runId, title: "Handoff", description: "A human-owned task" });
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.ed, recommendationIds: [r] })).body.submitted).toBe(true);
    const out = await s.call("ed", "POST", `/v1/cases/${caseId}/decision`, { recommendationId: r, decision: "approve", rationale: "Executive approval attempt.", caseVersion: (await s.get("ed", caseId)).version });
    expect(out.status).toBe(403);
    expect(out.body.message).toMatch(/requires one of: approver/);
  });

  it("evaluates again at decision time: a source blocked after submission prevents approval, but not rejection", async () => {
    const s = await scene();
    const caseId = await s.openCase();
    const r = await s.propose(caseId);
    await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] });
    await setSourceStatus(app, s.id, s.sourceKey, "blocked", "rights withdrawn");
    const v = (await s.get("rita", caseId)).version;
    const approve = await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { recommendationId: r, decision: "approve", rationale: "Approving on the old evidence.", caseVersion: v });
    expect(approve.status).toBe(409);
    expect(approve.body.message).toMatch(/BLOCK/);
    const reject = await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { recommendationId: r, decision: "reject", rationale: "Source rights were withdrawn.", caseVersion: v });
    expect(reject.body).toMatchObject({ caseState: "decided", policyOutcome: "BLOCK" });
  });

  it("returns a deferred case to analysis and keeps the earlier review in the history", async () => {
    const s = await scene();
    const caseId = await s.openCase();
    const r = await s.propose(caseId);
    await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] });
    const d = await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { recommendationId: r, decision: "request_evidence", rationale: "Need a second source for this.", caseVersion: (await s.get("rita", caseId)).version });
    expect(d.body.caseState).toBe("analysis");
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/evidence`, { evidenceId: s.evidence.e2 })).status).toBe(201);
    const c = await s.get("ana", caseId);
    expect(c.decisions).toHaveLength(1);
    expect(c.recommendations[0].status).toBe("draft");
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] })).body.submitted).toBe(true);
  });

  it("hides restricted cases from people who are not part of them, except auditors", async () => {
    const s = await scene();
    const caseId = await s.openCase({ sensitivity: "restricted" });
    expect((await s.call("ben", "GET", `/v1/cases/${caseId}`)).status).toBe(404);
    expect((await s.call("ben", "GET", "/v1/cases")).body).toHaveLength(0);
    expect((await s.call("aud", "GET", `/v1/cases/${caseId}`)).status).toBe(200);
    expect((await s.call("ben", "POST", `/v1/cases/${caseId}/participants`, { principalId: s.ids.ben })).status).toBe(404);
    expect((await s.call("ana", "POST", `/v1/cases/${caseId}/participants`, { principalId: s.ids.ben })).status).toBe(201);
    expect((await s.call("ben", "GET", `/v1/cases/${caseId}`)).status).toBe(200);
  });

  it("dismisses a case without creating memory, and gates every route by permission", async () => {
    const s = await scene();
    const made = await s.call("ana", "POST", "/v1/cases", { title: "Weak signal", objective: "Check a rumour", domain: "energy" });
    expect((await s.call("ana", "POST", `/v1/cases/${made.body.id}/start`)).status).toBe(409); // no evidence yet
    expect((await s.call("ana", "POST", `/v1/cases/${made.body.id}/close`, { rationale: "Not actionable." })).body).toMatchObject({ disposition: "dismissed", memoryId: null });
    expect((await s.call("ana", "GET", "/v1/memory")).body).toHaveLength(0);
    expect((await s.call("ed", "POST", "/v1/cases", { title: "Nope", objective: "Nope", domain: "x" })).status).toBe(403);
    expect((await s.call("olga", "GET", "/v1/policies")).status).toBe(200);
    expect((await s.call("ana", "POST", "/v1/policies", {})).status).toBe(403);
    expect((await s.call("ana", "POST", "/v1/cases", { title: "x" })).status).toBe(400);
  });

  it("governs policy changes: versioned, activated by someone else, and fail-closed with no active policy", async () => {
    const s = await scene();
    const d = await s.call("adam", "POST", "/v1/policies", { rules: DEFAULT_RULES.filter(r => r.id !== "R6"), authority: DEFAULT_AUTHORITY });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ version: 2, status: "draft" });
    expect((await s.call("adam", "POST", `/v1/policies/${d.body.id}/activate`)).status).toBe(403);
    expect((await s.call("adel", "POST", `/v1/policies/${d.body.id}/activate`)).body).toMatchObject({ status: "active", activatedBy: s.ids.adel });
    expect((await s.call("adel", "GET", "/v1/policies")).body.map((p: { version: number; status: string }) => `${p.version}:${p.status}`).sort()).toEqual(["1:retired", "2:active"]);
    expect((await s.call("adam", "POST", "/v1/policies", { rules: [], authority: DEFAULT_AUTHORITY })).status).toBe(422);
    await withTenant(owner, s.id, c => c.query("UPDATE policies SET status = 'retired'"));
    const caseId = await s.openCase(), r = await s.propose(caseId);
    const out = await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] });
    expect(out.status).toBe(409);
    expect(out.body.message).toMatch(/no active policy/);
  });

  it("keeps decisions, policy versions and case history immutable in the database itself", async () => {
    const s = await scene();
    const caseId = await s.openCase(), r = await s.propose(caseId);
    await s.call("ana", "POST", `/v1/cases/${caseId}/submit`, { reviewerId: s.ids.rita, recommendationIds: [r] });
    await s.call("rita", "POST", `/v1/cases/${caseId}/decision`, { recommendationId: r, decision: "approve", rationale: "Sufficient and sourced.", caseVersion: (await s.get("rita", caseId)).version });
    const attempt = (sql: string) => expect(withTenant(app, s.id, c => c.query(sql))).rejects.toThrow();
    await attempt("UPDATE human_decisions SET decision = 'reject'");
    await attempt("DELETE FROM human_decisions");
    await attempt("UPDATE policy_decisions SET outcome = 'PASS'");
    await attempt("UPDATE case_events SET rationale = 'edited'");
    await attempt("UPDATE recommendations SET title = 'rewritten'");
    await attempt("UPDATE policies SET rules = '[]'");
    await attempt("UPDATE cases SET owner_id = reviewer_id");
    await attempt("DELETE FROM cases");
    await attempt("DELETE FROM case_evidence");
  });

  it("keeps cases apart between institutions", async () => {
    const a = await scene(), b = await scene();
    const caseId = await a.openCase();
    expect((await b.call("ana", "GET", `/v1/cases/${caseId}`)).status).toBe(404);
    expect((await b.call("ana", "GET", "/v1/cases")).body).toHaveLength(0);
  });
});
