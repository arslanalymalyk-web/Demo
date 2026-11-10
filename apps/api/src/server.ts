import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import type pg from "pg";
import { z } from "zod";
import { PostgresGraph } from "../../../packages/graph/src/index.js";
import { EPISODE, PACKS, TEMPLATES, createRun, episodeBacktest, getRun, listRuns, replayRun } from "../../../packages/scenario/src/index.js";
import { AuthError, IdentityError, findPrincipal, listPrincipals, permissionsOf, provisionPrincipal, setDisabled, setRoles, type Permission, type Principal, type TokenVerifier } from "../../../packages/identity/src/index.js";
import { audit } from "../../../packages/ingest/src/store.js";
import { CaseError, addEvidence, addParticipant, addRecommendation, openCaseFromSignal, addScenario, closeCase, createCase, decide, getCase, listCases, listHandoffs, searchMemory, startAnalysis, submitForReview, updateHandoff } from "../../../packages/cases/src/index.js";
import { GovernanceError, activatePolicy, createPolicyDraft, listPolicies } from "../../../packages/governance/src/index.js";
import { IntakeError, tools as docTools, downloadDocument, getDocument, getPage, listDocuments, retryDocument, searchDocuments, submitDocument, type DocumentQueue } from "../../../packages/documents/src/index.js";
import { SCOPES, SCOPE_INFO, DEFAULT_SIGNAL_RULES, SettingsError, activate as activateSetting, activeOf, createDraft as createSettingDraft, effectiveScenarioDefaults, effectiveThresholds, listVersions as listSettings, type Scope } from "../../../packages/settings/src/index.js";
import { SECTORS, buildMap, buildSector, isPack } from "../../../packages/sectors/src/index.js";
import { getLineage, verifyAuditChain } from "../../../packages/ingest/src/lineage.js";
import { withTenant } from "../../../packages/ingest/src/store.js";

const listQuery = z.object({ source: z.string().optional(), status: z.enum(["accepted", "warned", "quarantined", "rejected"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
const uuid = z.string().uuid();
const runBody = z.object({ template: z.string(), baselineMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), overrides: z.record(z.string(), z.number().finite()).default({}) });
const pathQuery = z.object({ depth: z.coerce.number().int().min(1).max(6).default(3) });
const obsQuery = z.object({ subject: z.string().optional(), predicate: z.string().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), revisions: z.enum(["true", "false"]).default("false"), limit: z.coerce.number().int().min(1).max(5000).default(500) });

const caseBody = z.object({ title: z.string().min(3).max(200), objective: z.string().min(3).max(4000), domain: z.string().min(2).max(60), sensitivity: z.enum(["internal", "restricted"]).default("internal"), signal: z.record(z.string(), z.unknown()).optional() });
const evidenceBody = z.object({ evidenceId: z.string().uuid(), role: z.enum(["supports", "contradicts", "context"]).default("supports"), note: z.string().max(2000).optional() });
const recBody = z.object({ title: z.string().min(3).max(200), description: z.string().min(3).max(4000), actionClass: z.enum(["monitor", "advisory", "handoff"]), constraints: z.string().max(2000).optional(), scenarioRunId: z.string().uuid().optional(), evidenceIds: z.array(z.string().uuid()).max(50), ownerId: z.string().uuid().optional() });
const submitBody = z.object({ reviewerId: z.string().uuid(), recommendationIds: z.array(z.string().uuid()).min(1).max(20) });
const decisionBody = z.object({ recommendationId: z.string().uuid(), decision: z.enum(["approve", "reject", "defer", "request_evidence"]), rationale: z.string().min(1).max(4000), caseVersion: z.number().int().positive(), handoffTask: z.string().max(2000).optional(), handoffOwnerId: z.string().uuid().optional() });
const closeBody = z.object({ rationale: z.string().min(1).max(4000), outcome: z.string().max(4000).optional() });
const handoffBody = z.object({ status: z.enum(["done", "cancelled"]), outcome: z.string().min(1).max(4000) });
const policyBody = z.object({ rules: z.unknown(), authority: z.unknown() });
const principalBody = z.object({ issuer: z.string().min(1).max(500), subject: z.string().min(1).max(500), displayName: z.string().max(200).nullish(), roles: z.array(z.string()).max(7) });
const rolesBody = z.object({ roles: z.array(z.string()).max(7) });

/** Permission needed by each route. `null` means any authenticated, active principal. A route that is not listed here is refused. */
const ACCESS: Record<string, Permission | null | "public"> = {
  "GET /health": "public",
  "GET /v1/identity/me": null,
  "GET /v1/identity/principals": "identity.read",
  "POST /v1/identity/principals": "identity.manage",
  "PUT /v1/identity/principals/:id/roles": "identity.manage",
  "POST /v1/identity/principals/:id/disable": "identity.manage",
  "POST /v1/identity/principals/:id/enable": "identity.manage",
  "GET /v1/sources": "sources.read",
  "GET /v1/evidence": "evidence.read",
  "GET /v1/evidence/:id/lineage": "evidence.read",
  "GET /v1/series": "series.read",
  "GET /v1/series/:key/observations": "series.read",
  "GET /v1/series/:key/latest": "series.read",
  "GET /v1/graph/entities": "graph.read",
  "GET /v1/graph/entities/:key/paths": "graph.read",
  "GET /v1/scenarios/templates": "scenario.read",
  "GET /v1/scenarios/backtest": "scenario.read",
  "GET /v1/scenarios/runs": "scenario.read",
  "GET /v1/scenarios/runs/:id": "scenario.read",
  "POST /v1/scenarios/runs": "scenario.run",
  "POST /v1/scenarios/runs/:id/replay": "scenario.read",
  "GET /v1/audit/verify": "audit.verify",
  "GET /v1/identity/reviewers": "case.write",
  "POST /v1/documents": "document.upload",
  "GET /v1/documents": "document.read",
  "GET /v1/settings": "settings.read",
  "POST /v1/settings/:scope": "settings.manage",
  "POST /v1/settings/versions/:id/activate": "settings.manage",
  "GET /v1/map": "graph.read",
  "GET /v1/sectors": "series.read",
  "GET /v1/sectors/:pack": "series.read",
  "POST /v1/sectors/:pack/signals/:id/case": "case.write",
  "GET /v1/documents/search": "document.read",
  "GET /v1/documents/config": "document.read",
  "GET /v1/documents/:id": "document.read",
  "GET /v1/documents/:id/pages/:n": "document.read",
  "GET /v1/documents/:id/file": "document.read",
  "POST /v1/documents/:id/retry": "document.upload",
  "GET /v1/cases": "case.read",
  "POST /v1/cases": "case.write",
  "GET /v1/cases/:id": "case.read",
  "POST /v1/cases/:id/evidence": "case.write",
  "POST /v1/cases/:id/scenarios": "case.write",
  "POST /v1/cases/:id/participants": "case.write",
  "POST /v1/cases/:id/start": "case.write",
  "POST /v1/cases/:id/recommendations": "case.write",
  "POST /v1/cases/:id/submit": "case.write",
  "POST /v1/cases/:id/decision": "decision.make",
  "POST /v1/cases/:id/close": "case.write",
  "GET /v1/handoffs": "handoff.read",
  "POST /v1/handoffs/:id/update": "handoff.update",
  "GET /v1/memory": "memory.read",
  "GET /v1/policies": "policy.read",
  "POST /v1/policies": "policy.manage",
  "POST /v1/policies/:id/activate": "policy.manage",
};
declare module "fastify" { interface FastifyRequest { principal?: Principal } }

/**
 * The institution is fixed by deployment configuration (one deployment per institution).
 * Every route except /health needs a bearer token from the institution's identity provider and a provisioned, active principal with the right role.
 */
export function buildServer(opts: { pool: pg.Pool; institutionId: string; verifier: TokenVerifier; documents?: DocumentQueue; clientDataEnabled?: boolean }): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(swagger, { openapi: { info: { title: "TIGERIS AI OS API", version: "0.1.0", description: "Evidence, lineage and audit. Institution scope comes from deployment configuration." } } });
  const tenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTenant(opts.pool, opts.institutionId, fn);

  // Startup invariant: every route must have an access rule, so a new endpoint cannot ship open by accident.
  const declared: string[] = [];
  app.addHook("onRoute", r => { for (const m of [r.method].flat()) if (m !== "HEAD") declared.push(`${m} ${r.url}`); });
  app.addHook("onReady", async () => { const missing = declared.filter(k => !(k in ACCESS) && !k.includes("/documentation")); if (missing.length) throw new Error(`routes without an access rule: ${missing.join(", ")}`); });

  app.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url;
    if (!route) return; // unmatched paths fall through to the 404 handler and expose nothing
    const need = ACCESS[`${req.method} ${route}`];
    if (need === "public") return;
    if (need === undefined) return reply.code(403).send({ error: "forbidden", message: "route has no access rule" });
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const unauthorized = (message: string) => reply.code(401).header("www-authenticate", 'Bearer realm="tigeris"').send({ error: "unauthorized", message });
    if (!m) return unauthorized("bearer token required");
    let claims;
    try { claims = await opts.verifier(m[1]!); } catch (e) { return unauthorized(e instanceof AuthError ? e.message : "invalid token"); }
    const principal = await tenant(c => findPrincipal(c, claims.issuer, claims.subject));
    if (!principal) return reply.code(403).send({ error: "not_provisioned", message: "no principal for this identity in this institution" });
    const deny = async (reason: string) => { await tenant(c => audit(c, opts.institutionId, { actorType: "principal", actorId: principal.id, action: "identity.denied", objectType: "route", objectId: `${req.method} ${route}`, payload: { reason } })); return reply.code(403).send({ error: "forbidden", message: reason }); };
    if (principal.disabled) return deny("principal disabled");
    if (need !== null && !permissionsOf(principal.roles).has(need)) return deny(`missing permission ${need}`);
    req.principal = principal;
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/identity/me", async req => {
    const inst = await tenant(async c => (await c.query("SELECT id, name, jurisdiction FROM institutions WHERE id = $1", [opts.institutionId])).rows[0]);
    return { ...req.principal!, permissions: [...permissionsOf(req.principal!.roles)].sort(), institution: inst ? { id: inst.id, name: inst.name, jurisdiction: inst.jurisdiction ?? null } : null };
  });
  app.get("/v1/identity/principals", async () => tenant(c => listPrincipals(c)));
  const identityCall = async <T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: (c: pg.PoolClient) => Promise<T>) => {
    try { return await tenant(fn); } catch (e) {
      if (e instanceof IdentityError) return reply.code(e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 422).send({ error: e.code, message: e.message });
      throw e;
    }
  };
  app.post("/v1/identity/principals", async (req, reply) => {
    const b = principalBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body", details: b.error.flatten() });
    const r = await identityCall(reply, c => provisionPrincipal(c, opts.institutionId, { type: "principal", id: req.principal!.id }, { ...b.data, displayName: b.data.displayName ?? null }));
    return r && "id" in (r as object) ? reply.code(201).send(r) : r;
  });
  app.put("/v1/identity/principals/:id/roles", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id), b = rolesBody.safeParse(req.body);
    if (!id.success || !b.success) return reply.code(400).send({ error: "invalid_request" });
    return identityCall(reply, c => setRoles(c, opts.institutionId, { type: "principal", id: req.principal!.id }, id.data, b.data.roles));
  });
  for (const [verb, disabled] of [["disable", true], ["enable", false]] as const) {
    app.post(`/v1/identity/principals/:id/${verb}`, async (req, reply) => {
      const id = uuid.safeParse((req.params as { id: string }).id);
      if (!id.success) return reply.code(400).send({ error: "invalid_id" });
      return identityCall(reply, c => setDisabled(c, opts.institutionId, { type: "principal", id: req.principal!.id }, id.data, disabled));
    });
  }

  app.get("/v1/sources", async () => tenant(async c => (await c.query(
    `SELECT s.source_key, s.name, s.publisher, s.original_agency, s.platform_type, s.status, s.data_class, s.licence_name, s.licence_verified, s.rights_note,
            COUNT(e.id) FILTER (WHERE e.validation_status = 'accepted')::int AS accepted,
            COUNT(e.id) FILTER (WHERE e.validation_status = 'warned')::int AS warned,
            COUNT(e.id) FILTER (WHERE e.validation_status = 'quarantined')::int AS quarantined
     FROM sources s LEFT JOIN evidence_objects e ON e.source_id = s.id GROUP BY s.id ORDER BY s.source_key`)).rows));

  app.get("/v1/evidence", async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", details: q.error.flatten() });
    return tenant(async c => (await c.query(
      `SELECT e.id, s.source_key, e.external_key, e.payload->>'title' AS title, e.original_agency, e.event_time, e.retrieved_at, e.version, e.data_class, e.validation_status
       FROM evidence_objects e JOIN sources s ON s.id = e.source_id
       WHERE ($1::text IS NULL OR s.source_key = $1) AND ($2::text IS NULL OR e.validation_status::text = $2)
       ORDER BY e.retrieved_at DESC, e.external_key LIMIT $3 OFFSET $4`, [q.data.source ?? null, q.data.status ?? null, q.data.limit, q.data.offset])).rows);
  });

  app.get("/v1/evidence/:id/lineage", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    const out = await tenant(c => getLineage(c, id.data));
    return out ?? reply.code(404).send({ error: "not_found" });
  });

  app.get("/v1/series", async () => tenant(async c => (await c.query(
    `SELECT s.series_key, s.title, s.description, s.frequency, s.packs, s.max_age_days, src.source_key, COALESCE(le.original_agency, src.original_agency) AS original_agency,
            le.validation_status AS latest_validation, le.id AS latest_evidence_id, le.version AS latest_version,
            COUNT(DISTINCT (f.subject, f.predicate))::int AS tracks, MAX(f.valid_time) AS latest_period
     FROM series s JOIN sources src ON src.id = s.source_id
     LEFT JOIN LATERAL (SELECT e.id, e.version, e.validation_status, e.original_agency FROM evidence_objects e WHERE e.id IN (SELECT evidence_id FROM evidence_facts WHERE series_id = s.id) ORDER BY e.retrieved_at DESC, e.version DESC LIMIT 1) le ON true
     LEFT JOIN evidence_facts f ON f.series_id = s.id
     GROUP BY s.id, src.source_key, src.original_agency, le.id, le.version, le.validation_status, le.original_agency ORDER BY s.series_key`)).rows));

  app.get("/v1/series/:key/observations", async (req, reply) => {
    const q = obsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", details: q.error.flatten() });
    const key = (req.params as { key: string }).key;
    const args = [key, q.data.subject ?? null, q.data.predicate ?? null, q.data.from ?? null, q.data.to ?? null, q.data.limit];
    const where = `s.series_key = $1 AND ($2::text IS NULL OR f.subject = $2) AND ($3::text IS NULL OR f.predicate = $3) AND ($4::timestamptz IS NULL OR f.valid_time >= $4) AND ($5::timestamptz IS NULL OR f.valid_time <= $5)`;
    const cols = `f.subject, f.predicate, f.value, f.unit, f.unit_stated, f.valid_time, f.dims, f.evidence_id, e.version, e.validation_status`;
    const sql = q.data.revisions === "true"
      ? `SELECT ${cols} FROM evidence_facts f JOIN series s ON s.id = f.series_id JOIN evidence_objects e ON e.id = f.evidence_id WHERE ${where} ORDER BY f.subject, f.predicate, f.valid_time, e.version LIMIT $6`
      : `SELECT * FROM (SELECT DISTINCT ON (f.subject, f.predicate, f.valid_time) ${cols} FROM evidence_facts f JOIN series s ON s.id = f.series_id JOIN evidence_objects e ON e.id = f.evidence_id WHERE ${where} ORDER BY f.subject, f.predicate, f.valid_time, e.version DESC) t ORDER BY subject, predicate, valid_time LIMIT $6`;
    const rows = await tenant(async c => (await c.query(sql, args)).rows);
    if (rows.length === 0 && !(await tenant(async c => (await c.query("SELECT 1 FROM series WHERE series_key=$1", [key])).rowCount))) return reply.code(404).send({ error: "not_found" });
    return rows.map(r => ({ subject: r.subject, predicate: r.predicate, value: r.value, unit: r.unit, unitStated: r.unit_stated, validTime: r.valid_time, dims: r.dims, evidenceId: r.evidence_id, version: r.version, validation: r.validation_status, lineage: `/v1/evidence/${r.evidence_id}/lineage` }));
  });

  app.get("/v1/series/:key/latest", async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const rows = await tenant(async c => (await c.query(
      `SELECT DISTINCT ON (f.subject, f.predicate) f.subject, f.predicate, f.value, f.unit, f.unit_stated, f.valid_time, f.dims, f.evidence_id, e.version, e.validation_status
       FROM evidence_facts f JOIN series s ON s.id = f.series_id JOIN evidence_objects e ON e.id = f.evidence_id WHERE s.series_key = $1
       ORDER BY f.subject, f.predicate, f.valid_time DESC, e.version DESC`, [key])).rows);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return rows.map(r => ({ subject: r.subject, predicate: r.predicate, value: r.value, unit: r.unit, unitStated: r.unit_stated, validTime: r.valid_time, dims: r.dims, evidenceId: r.evidence_id, version: r.version, validation: r.validation_status, lineage: `/v1/evidence/${r.evidence_id}/lineage` }));
  });

  app.get("/v1/graph/entities", async () => tenant(async c => (await c.query("SELECT key, kind, name, attrs, data_class FROM entities ORDER BY key")).rows));

  app.get("/v1/graph/entities/:key/paths", async (req, reply) => {
    const q = pathQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", details: q.error.flatten() });
    const key = (req.params as { key: string }).key;
    try { return await tenant(c => new PostgresGraph(c, opts.institutionId).paths(key, q.data.depth)); }
    catch (e) { if (e instanceof Error && e.message.startsWith("unknown entity")) return reply.code(404).send({ error: "not_found" }); throw e; }
  });

  app.get("/v1/scenarios/templates", async () => Object.values(TEMPLATES).map(t => ({ key: t.key, pack: t.pack, packName: PACKS[t.pack], version: t.version, formulaVersion: t.formulaVersion, title: t.title, description: t.description, needs: t.needs, headline: t.headline, parameters: t.defaults(t.usesFlexibility ? null : null) })));

  app.get("/v1/scenarios/backtest", async () => tenant(c => episodeBacktest(c, opts.institutionId, EPISODE.baseline, EPISODE.months, 100000)));

  app.post("/v1/scenarios/runs", async (req, reply) => {
    const b = runBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body", details: b.error.flatten() });
    if (!TEMPLATES[b.data.template]) return reply.code(404).send({ error: "unknown_template" });
    try {
      const run = await tenant(async c => createRun(c, opts.institutionId, { settings: await effectiveScenarioDefaults(c), templateKey: b.data.template, overrides: b.data.overrides, createdBy: req.principal!.id, ...(b.data.baselineMonth ? { baselineMonth: b.data.baselineMonth } : {}) }));
      return reply.code(201).send({ id: run.id, manifestHash: run.manifestHash, resultsHash: run.resultsHash, confidence: run.confidence, link: `/v1/scenarios/runs/${run.id}` });
    } catch (e) {
      if (e instanceof Error && /unknown parameter|must be a finite|seed it first|no export observations|no Brent price|ingest the JODI/.test(e.message)) return reply.code(422).send({ error: "cannot_run", message: e.message });
      throw e;
    }
  });

  app.get("/v1/scenarios/runs", async () => tenant(c => listRuns(c)));

  app.get("/v1/scenarios/runs/:id", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    const run = await tenant(c => getRun(c, id.data));
    return run ?? reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/scenarios/runs/:id/replay", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    try { return await tenant(c => replayRun(c, id.data)); }
    catch (e) { if (e instanceof Error && e.message === "run not found") return reply.code(404).send({ error: "not_found" }); throw e; }
  });

  // Cases and governance. Domain errors become plain statuses; a refusal on authority grounds is also written to the audit trail.
  const actor = (req: { principal?: Principal }) => ({ id: req.principal!.id, roles: req.principal!.roles });
  const domain = async <T>(req: { principal?: Principal; method: string; url: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: (c: pg.PoolClient) => Promise<T>, okCode?: number | ((r: T) => number)) => {
    try { const r = await tenant(fn); return okCode ? reply.code(typeof okCode === "number" ? okCode : okCode(r)).send(r) : r; }
    catch (e) {
      if (e instanceof CaseError || e instanceof GovernanceError || e instanceof SettingsError) {
        if (e.code === "forbidden") await tenant(c => audit(c, opts.institutionId, { actorType: "principal", actorId: req.principal!.id, action: "governance.refused", objectType: "route", objectId: `${req.method} ${req.url.split("?")[0]}`, payload: { reason: e.message } }));
        return reply.code({ not_found: 404, conflict: 409, invalid: 422, forbidden: 403 }[e.code]).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  };
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: z.ZodError) => reply.code(400).send({ error: "invalid_body", details: e.flatten() });
  const idOf = (req: { params: unknown }) => uuid.safeParse((req.params as { id: string }).id);

  app.get("/v1/identity/reviewers", async () => tenant(async c => (await listPrincipals(c)).filter(p => !p.disabled && permissionsOf(p.roles).has("decision.make")).map(p => ({ id: p.id, name: p.displayName ?? p.subject, roles: p.roles }))));
  app.get("/v1/cases", async (req, reply) => { const st = z.enum(["open", "analysis", "in_review", "decided", "closed"]).optional().safeParse((req.query as { state?: string }).state); return st.success ? tenant(c => listCases(c, actor(req), st.data)) : reply.code(400).send({ error: "invalid_query" }); });
  app.post("/v1/cases", async (req, reply) => { const b = caseBody.safeParse(req.body); return b.success ? domain(req, reply, c => createCase(c, opts.institutionId, actor(req), b.data), 201) : bad(reply, b.error); });
  app.get("/v1/cases/:id", async (req, reply) => { const id = idOf(req); return id.success ? domain(req, reply, c => getCase(c, actor(req), id.data)) : reply.code(400).send({ error: "invalid_id" }); });
  const caseAction = <B,>(path: string, schema: z.ZodType<B, z.ZodTypeDef, unknown>, run: (c: pg.PoolClient, caseId: string, b: B, a: { id: string; roles: string[] }) => Promise<unknown>, okCode = 200) =>
    app.post(`/v1/cases/:id/${path}`, async (req, reply) => { const id = idOf(req), b = schema.safeParse(req.body ?? {}); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error); return domain(req, reply, async c => (await run(c, id.data, b.data, actor(req))) ?? { ok: true }, okCode); });
  caseAction("evidence", evidenceBody, (c, id, b, a) => addEvidence(c, opts.institutionId, a, id, b), 201);
  caseAction("scenarios", z.object({ runId: z.string().uuid() }), (c, id, b, a) => addScenario(c, opts.institutionId, a, id, b.runId), 201);
  caseAction("participants", z.object({ principalId: z.string().uuid() }), (c, id, b, a) => addParticipant(c, opts.institutionId, a, id, b.principalId), 201);
  caseAction("start", z.object({}), (c, id, _b, a) => startAnalysis(c, opts.institutionId, a, id));
  caseAction("recommendations", recBody, (c, id, b, a) => addRecommendation(c, opts.institutionId, a, id, { ...b, constraints: b.constraints, scenarioRunId: b.scenarioRunId, ownerId: b.ownerId } as never), 201);
  caseAction("submit", submitBody, (c, id, b, a) => submitForReview(c, opts.institutionId, a, id, b));
  caseAction("decision", decisionBody, (c, id, b, a) => decide(c, opts.institutionId, a, id, b as never));
  caseAction("close", closeBody, (c, id, b, a) => closeCase(c, opts.institutionId, a, id, b));
  app.get("/v1/handoffs", async req => tenant(c => listHandoffs(c, actor(req))));
  app.post("/v1/handoffs/:id/update", async (req, reply) => { const id = idOf(req), b = handoffBody.safeParse(req.body); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error); return domain(req, reply, async c => { await updateHandoff(c, opts.institutionId, actor(req), id.data, b.data); return { ok: true }; }); });
  app.get("/v1/memory", async (req, reply) => { const q = z.object({ q: z.string().max(200).optional() }).safeParse(req.query); return q.success ? tenant(c => searchMemory(c, actor(req), q.data.q)) : reply.code(400).send({ error: "invalid_query" }); });
  app.get("/v1/policies", async () => tenant(c => listPolicies(c)));
  app.post("/v1/policies", async (req, reply) => { const b = policyBody.safeParse(req.body); return b.success ? domain(req, reply, c => createPolicyDraft(c, opts.institutionId, { type: "principal", id: req.principal!.id }, { rules: b.data.rules, authority: b.data.authority }), 201) : bad(reply, b.error); });
  app.post("/v1/policies/:id/activate", async (req, reply) => { const id = idOf(req); return id.success ? domain(req, reply, c => activatePolicy(c, opts.institutionId, { type: "principal", id: req.principal!.id }, id.data)) : reply.code(400).send({ error: "invalid_id" }); });

  // Document intake. Files arrive as the raw request body; the type is decided from the content, never from the name or the declared type.
  const hdr = (v: unknown): string => { const s = Array.isArray(v) ? v[0] : v; if (typeof s !== "string") return ""; try { return decodeURIComponent(s); } catch { return s; } };
  const intake = async (req: { principal?: Principal; method: string; url: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: (c: pg.PoolClient) => Promise<unknown>, ok: number | ((r: never) => number) = 200) => {
    try { const r = await tenant(fn); return reply.code(typeof ok === "number" ? ok : ok(r as never)).send(r); }
    catch (e) { if (e instanceof IntakeError) return reply.code({ unsupported: 415, too_large: 413, invalid: 422, forbidden: 403 }[e.code]).send({ error: e.code, message: e.message }); throw e; }
  };
  void app.register(async sub => {
    sub.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 21 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    sub.post("/v1/documents", async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "invalid_body", message: "send the file as the request body" });
      const h = req.headers;
      let queued: string | null = null;
      const out = await intake(req, reply, async c => {
        const r = await submitDocument(c, opts.institutionId, req.principal!.id, { buffer: req.body as Buffer, filename: hdr(h["x-filename"]) || "document", title: hdr(h["x-title"]), dataClass: hdr(h["x-data-class"]) as never, originalAgency: hdr(h["x-original-agency"]), sourceUrl: hdr(h["x-source-url"]), rights: hdr(h["x-rights"]), languages: hdr(h["x-languages"]) || "eng", clientDataEnabled: opts.clientDataEnabled === true });
        if (!r.duplicate) queued = r.id;
        return r;
      }, ((r: { duplicate: boolean }) => r.duplicate ? 200 : 202) as never);
      if (queued) opts.documents?.enqueue(queued);
      return out;
    });
  });
  // Governed settings. Tiger's numbers: drafted by one administrator, activated by another, versioned and audited.
  app.get("/v1/settings", async () => tenant(async c => {
    const versions = await listSettings(c), links = await new PostgresGraph(c, opts.institutionId).linked("chokepoint:hormuz", "constrains_exports_of").catch(() => []);
    return {
      scopes: await (async () => { const out = []; for (const scope of SCOPES) out.push({ scope, ...SCOPE_INFO[scope], active: await activeOf(c, scope), versions: versions.filter(v => v.scope === scope), defaults: scope === "signal_rules" ? DEFAULT_SIGNAL_RULES : {} }); return out; })(),
      catalog: Object.values(TEMPLATES).map(t => ({ key: t.key, title: t.title, pack: t.pack, parameters: t.defaults(null) })),
      exposure: links.map(l => ({ code: String(l.attrs.code), name: l.name, hormuzShare: Number(l.params.hormuzShare), spareBypassKbd: Number(l.params.spareBypassKbd), linkClass: l.linkClass })),
    };
  }));
  app.post("/v1/settings/:scope", async (req, reply) => {
    const scope = (req.params as { scope: string }).scope as Scope, b = z.object({ payload: z.unknown(), note: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!SCOPES.includes(scope)) return reply.code(404).send({ error: "not_found" });
    if (!b.success) return bad(reply, b.error);
    return domain(req, reply, c => createSettingDraft(c, opts.institutionId, { id: req.principal!.id }, scope, b.data.payload, b.data.note, { templates: Object.fromEntries(Object.values(TEMPLATES).map(t => [t.key, Object.keys(t.defaults(null))])) }), 201);
  });
  app.post("/v1/settings/versions/:id/activate", async (req, reply) => { const id = idOf(req); return id.success ? domain(req, reply, c => activateSetting(c, opts.institutionId, { id: req.principal!.id }, id.data)) : reply.code(400).send({ error: "invalid_id" }); });

  // The map: public-record geography from the graph plus the stored producer series. There is no vessel data.
  app.get("/v1/map", async () => tenant(async c => buildMap(c, opts.institutionId, await buildSector(c, "energy", new Date(), await effectiveThresholds(c)))));

  // Sector command centres. Everything shown is computed from stored evidence; a signal can open a case with its own evidence attached.
  app.get("/v1/sectors", async () => Object.entries(SECTORS).map(([key, p]) => ({ key, name: p.name, domains: p.domains })));
  app.get("/v1/sectors/:pack", async (req, reply) => { const k = (req.params as { pack: string }).pack; return isPack(k) ? tenant(async c => buildSector(c, k, new Date(), await effectiveThresholds(c))) : reply.code(404).send({ error: "not_found" }); });
  app.post("/v1/sectors/:pack/signals/:id/case", async (req, reply) => {
    const { pack, id } = req.params as { pack: string; id: string };
    if (!isPack(pack)) return reply.code(404).send({ error: "not_found" });
    return domain(req, reply, async c => {
      const view = await buildSector(c, pack, new Date(), await effectiveThresholds(c)), sig = view.signals.find(s => s.id === id);
      if (!sig) throw new CaseError("this signal is no longer active, so a case cannot be opened from it", "not_found");
      const r = await openCaseFromSignal(c, opts.institutionId, actor(req), { signalId: sig.id, ruleId: sig.ruleId, rulesVersion: view.rulesVersion, settingsVersion: view.settingsVersion, title: sig.title, objective: `${sig.detail} Decide whether this needs a response and what the evidence supports.`, domain: SECTORS[pack].domains[0]!, observedAt: sig.observedAt, evidenceIds: sig.evidenceIds, values: sig.values });
      return r;
    }, r => r.existing ? 200 : 201);
  });

  app.get("/v1/documents", async () => tenant(c => listDocuments(c)));
  app.get("/v1/documents/config", async () => { const t = await docTools(); return { clientDataEnabled: opts.clientDataEnabled === true, ocr: { available: t.tesseract !== null, languages: t.languages }, maxMegabytes: 20, maxPages: 100, accepted: ["PDF", "PNG", "JPEG", "TIFF", "Word (.docx)", "Plain text"] }; });
  app.get("/v1/documents/search", async (req, reply) => { const q = z.object({ q: z.string().min(2).max(200) }).safeParse(req.query); return q.success ? tenant(c => searchDocuments(c, q.data.q)) : reply.code(400).send({ error: "invalid_query" }); });
  app.get("/v1/documents/:id", async (req, reply) => { const id = idOf(req); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); return (await tenant(c => getDocument(c, id.data))) ?? reply.code(404).send({ error: "not_found" }); });
  app.get("/v1/documents/:id/pages/:n", async (req, reply) => { const id = idOf(req), n = z.coerce.number().int().min(1).max(1000).safeParse((req.params as { n: string }).n); if (!id.success || !n.success) return reply.code(400).send({ error: "invalid_request" }); return (await tenant(c => getPage(c, id.data, n.data))) ?? reply.code(404).send({ error: "not_found" }); });
  app.get("/v1/documents/:id/file", async (req, reply) => {
    const id = idOf(req); if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    const f = await tenant(c => downloadDocument(c, opts.institutionId, req.principal!.id, id.data));
    if (!f) return reply.code(404).send({ error: "not_found" });
    return reply.header("content-type", f.mime).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`).header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox").send(f.content);
  });
  app.post("/v1/documents/:id/retry", async (req, reply) => { const id = idOf(req); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); const out = await intake(req, reply, async c => { await retryDocument(c, opts.institutionId, req.principal!.id, id.data); return { ok: true }; }); if (reply.statusCode === 200) opts.documents?.enqueue(id.data); return out; });

  app.get("/v1/audit/verify", async () => tenant(c => verifyAuditChain(c)));
  return app;
}
