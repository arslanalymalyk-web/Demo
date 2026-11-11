import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { RateLimiter } from "./ratelimit.js";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import swagger from "@fastify/swagger";
import type pg from "pg";
import { z } from "zod";
import { PostgresGraph } from "../../../packages/graph/src/index.js";
import { EPISODE, PACKS, TEMPLATES, createRun, episodeBacktestIfStored, getRun, listRuns, listRunsPage, replayRun } from "../../../packages/scenario/src/index.js";
import { AuthError, IdentityError, PRIVILEGED_ROLES, changeRoles, decideGrantRequest, findPrincipal, listGrantRequests, requestForNewPerson, listPrincipals, permissionsOf, getLockdown, provisionPrincipal, revokeSessions, setDisabled, setLockdown, setRoles, type Permission, type Principal, type TokenVerifier } from "../../../packages/identity/src/index.js";
import { audit } from "../../../packages/ingest/src/store.js";
import { PagingError, keysetPage, likePattern, type Page } from "../../../packages/core/src/index.js";
import { CaseError, addEvidence, addParticipant, addRecommendation, openCaseFromSignal, addScenario, closeCase, createCase, decide, getCase, listCases, listCasesPage, listHandoffsPage, searchMemoryPage, startAnalysis, submitForReview, updateHandoff } from "../../../packages/cases/src/index.js";
import { GovernanceError, activatePolicy, createPolicyDraft, listPolicies } from "../../../packages/governance/src/index.js";
import { IntakeError, documentCrypto, tools as docTools, downloadDocument, getDocument, getPage, listDocumentsPage, retryDocument, searchDocuments, submitDocument, type DocumentQueue, type Scanner, type Verdict, scanSummary } from "../../../packages/documents/src/index.js";
import { RetentionError, exportCase, holdFor, placeHold, releaseHold, retentionReport } from "../../../packages/retention/src/index.js";
import { SCOPES, SCOPE_INFO, DEFAULT_SIGNAL_RULES, SettingsError, activate as activateSetting, activeOf, createDraft as createSettingDraft, effectiveScenarioDefaults, effectiveSchedule, effectiveThresholds, listVersions as listSettings, type Scope } from "../../../packages/settings/src/index.js";
import { SECTORS, buildMap, buildSector, composeBriefing, isPack, type BriefingCase, type BriefingRun } from "../../../packages/sectors/src/index.js";
import { connectorFor } from "../../../packages/connectors/src/index.js";
import { ReasoningError, listCalls, runReasoning, type ModelAdapter } from "../../../packages/reasoning/src/index.js";
import { CATEGORIES, MUTABLE, backupStatus, sendTest, type AlertRunner, type Mailer } from "../../../packages/alerts/src/index.js";
import { installationReadiness } from "../../../packages/setup/src/index.js";
import { SchedulerError, pauseSource, requestRun, resumeSource, sourceHealth, type Scheduler } from "../../../packages/scheduler/src/index.js";
import { takeCheckpoint, verifyCheckpoint } from "../../../packages/ingest/src/anchor.js";
import { getLineage, verifyAuditChain } from "../../../packages/ingest/src/lineage.js";
import { withTenant } from "../../../packages/ingest/src/store.js";

const pageQ = { limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(400).optional() };
const listQuery = z.object({ source: z.string().optional(), status: z.enum(["accepted", "warned", "quarantined", "rejected"]).optional(), q: z.string().max(100).optional(), ...pageQ });
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

/** The routes that still answer during a lockdown: finding out what happened, ending sessions and people's access, and switching the lockdown off. Everything else is refused, including model calls, uploads and scheduled fetches. */
const LOCKDOWN_OK = new Set(["GET /v1/identity/me", "POST /v1/identity/me/sign-out", "GET /v1/identity/principals", "POST /v1/identity/principals/:id/disable", "POST /v1/identity/principals/:id/enable", "POST /v1/identity/principals/:id/revoke-sessions", "POST /v1/identity/revoke-all-sessions", "PUT /v1/identity/principals/:id/roles", "GET /v1/lockdown", "POST /v1/lockdown", "GET /v1/identity/role-requests", "POST /v1/identity/role-requests/:id/:verb", "GET /v1/audit/verify", "GET /v1/audit/checkpoint", "POST /v1/audit/checkpoint/verify", "GET /v1/readiness"]);

/** Permission needed by each route. `null` means any authenticated, active principal. A route that is not listed here is refused. */
const ACCESS: Record<string, Permission | null | "public"> = {
  "GET /health": "public",
  "GET /ready": "public",
  "GET /metrics": "public",
  "GET /v1/identity/me": null,
  "GET /v1/identity/principals": "identity.read",
  "POST /v1/identity/principals": "identity.manage",
  "PUT /v1/identity/principals/:id/roles": "identity.manage",
  "GET /v1/identity/role-requests": "identity.read",
  "POST /v1/identity/role-requests/:id/:verb": "identity.manage",
  "POST /v1/identity/principals/:id/disable": "identity.manage",
  "POST /v1/identity/principals/:id/revoke-sessions": "identity.manage",
  "POST /v1/identity/revoke-all-sessions": "identity.manage",
  "POST /v1/identity/me/sign-out": null,
  "GET /v1/lockdown": "identity.read",
  "POST /v1/lockdown": "identity.manage",
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
  "GET /v1/audit/checkpoint": "audit.verify",
  "POST /v1/audit/checkpoint/verify": "audit.verify",
  "GET /v1/identity/reviewers": "case.write",
  "POST /v1/documents": "document.upload",
  "GET /v1/documents": "document.read",
  "GET /v1/retention": "retention.read",
  "POST /v1/cases/:id/hold": "retention.manage",
  "POST /v1/cases/:id/release": "retention.manage",
  "POST /v1/cases/:id/export": "export.run",
  "GET /v1/settings": "settings.read",
  "POST /v1/settings/:scope": "settings.manage",
  "POST /v1/settings/versions/:id/activate": "settings.manage",
  "GET /v1/map": "graph.read",
  "GET /v1/sectors": "series.read",
  "GET /v1/sectors/:pack": "series.read",
  "GET /v1/briefings/:pack": "series.read",
  "GET /v1/readiness": "identity.read",
  "GET /v1/alerts": "alerts.read",
  "GET /v1/alerts/mine": "sources.read",
  "PUT /v1/alerts/mine": "sources.read",
  "GET /v1/alerts/addresses": "alerts.manage",
  "PUT /v1/alerts/addresses/:id": "alerts.manage",
  "POST /v1/alerts/test": "alerts.manage",
  "GET /v1/sources/health": "sources.read",
  "POST /v1/sources/:key/run": "ingest.manage",
  "POST /v1/sources/:key/pause": "ingest.manage",
  "POST /v1/sources/:key/resume": "ingest.manage",
  "GET /v1/reasoning/config": "sources.read",
  "POST /v1/reasoning/run": "reasoning.use",
  "GET /v1/reasoning/calls": "reasoning.read",
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
export interface ServerOptions { pool: pg.Pool; institutionId: string; verifier: TokenVerifier; auditAnchorKey?: string; documents?: DocumentQueue; clientDataEnabled?: boolean; logger?: FastifyServerOptions["logger"]; rateLimit?: { max: number; timeWindow: string } | null; metricsToken?: string | null; trustProxy?: boolean; reasoning?: { adapter: ModelAdapter; perHour?: number } | null; scheduler?: Scheduler | null; scanner?: Scanner | null; alerts?: { mailer: Mailer; baseUrl: string; runner?: AlertRunner } | null; backupMaxAgeHours?: number }

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false, trustProxy: opts.trustProxy === true, requestTimeout: 120_000, connectionTimeout: 30_000, bodyLimit: 1024 * 1024,
    genReqId: req => { const h = req.headers["x-request-id"]; return typeof h === "string" && /^[A-Za-z0-9._-]{8,64}$/.test(h) ? h : crypto.randomUUID(); },
  });

  // Operations: request ids, security headers, metrics and an error handler that never shows internals.
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const httpDuration = new Histogram({ name: "tigeris_http_request_duration_seconds", help: "Request duration", labelNames: ["method", "route", "status"], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30], registers: [registry] });
  const authFailures = new Counter({ name: "tigeris_auth_failures_total", help: "Refused requests by reason", labelNames: ["reason"], registers: [registry] });
  new Gauge({ name: "tigeris_db_pool_connections", help: "Database pool connections", labelNames: ["state"], registers: [registry], collect() { this.set({ state: "total" }, opts.pool.totalCount); this.set({ state: "idle" }, opts.pool.idleCount); this.set({ state: "waiting" }, opts.pool.waitingCount); } });
  new Gauge({ name: "tigeris_document_queue_busy", help: "1 while documents are being processed", registers: [registry], collect() { this.set(opts.documents?.busy ? 1 : 0); } });
  // Source health for the monitoring system: read from stored facts, cached briefly so a scrape stays cheap.
  let healthCache: { at: number; rows: Awaited<ReturnType<typeof sourceHealth>> } | null = null;
  const healthNow = async () => { if (!healthCache || Date.now() - healthCache.at > 30_000) healthCache = { at: Date.now(), rows: await withTenant(opts.pool, opts.institutionId, c => sourceHealth(c)) }; return healthCache.rows; };
  new Gauge({ name: "tigeris_sources", help: "Sources by health", labelNames: ["health"], registers: [registry], async collect() { this.reset(); const rows = await healthNow().catch(() => []); for (const h of ["healthy", "stale", "failing", "paused", "no_data", "not_approved"]) this.set({ health: h }, rows.filter(r => r.health === h).length); } });
  new Gauge({ name: "tigeris_source_last_success_age_hours", help: "Hours since the last completed fetch of a scheduled source", labelNames: ["source"], registers: [registry], async collect() { this.reset(); for (const r of (await healthNow().catch(() => [])).filter(x => x.scheduled && x.lastSuccessAgeHours !== null)) this.set({ source: r.sourceKey }, r.lastSuccessAgeHours!); } });
  new Gauge({ name: "tigeris_ingest_jobs_24h", help: "Ingestion jobs started in the last 24 hours, by outcome", labelNames: ["status"], registers: [registry], async collect() { this.reset(); const rows = await withTenant(opts.pool, opts.institutionId, async c => (await c.query("SELECT status, count(*)::int AS n FROM ingestion_jobs WHERE started_at > now() - interval '24 hours' GROUP BY status")).rows).catch(() => []); for (const s of ["completed", "failed", "running"]) this.set({ status: s }, rows.find((r: { status: string; n: number }) => r.status === s)?.n ?? 0); } });
  new Gauge({ name: "tigeris_alert_conditions_open", help: "Alert conditions that are open, by category", labelNames: ["category"], registers: [registry], async collect() { this.reset(); const rows = await withTenant(opts.pool, opts.institutionId, async c => (await c.query("SELECT category, count(*)::int AS n FROM alert_conditions WHERE state = 'open' GROUP BY category")).rows).catch(() => []); for (const k of ["malware", "source", "review", "operations"]) this.set({ category: k }, rows.find((r: { category: string; n: number }) => r.category === k)?.n ?? 0); } });
  new Gauge({ name: "tigeris_alert_deliveries_24h", help: "Alert messages attempted in the last 24 hours, by result", labelNames: ["status"], registers: [registry], async collect() { this.reset(); const rows = await withTenant(opts.pool, opts.institutionId, async c => (await c.query("SELECT status, count(*)::int AS n FROM alert_deliveries WHERE created_at > now() - interval '24 hours' GROUP BY status")).rows).catch(() => []); for (const s of ["sent", "failed", "skipped"]) this.set({ status: s }, rows.find((r: { status: string; n: number }) => r.status === s)?.n ?? 0); } });
  new Gauge({ name: "tigeris_last_backup_age_hours", help: "Hours since the last good base backup was recorded (absent when none, or when monitoring is off)", registers: [registry], async collect() { const b = await withTenant(opts.pool, opts.institutionId, c => backupStatus(c, new Date(), opts.backupMaxAgeHours ?? 0)).catch(() => null); if (b?.lastOkAgeHours != null) this.set(b.lastOkAgeHours); } });
  new Gauge({ name: "tigeris_backup_failures_24h", help: "Base backups recorded as failed in the last 24 hours", registers: [registry], async collect() { const b = await withTenant(opts.pool, opts.institutionId, c => backupStatus(c, new Date(), opts.backupMaxAgeHours ?? 1)).catch(() => null); this.set(b?.failedLast24h ?? 0); } });
  new Gauge({ name: "tigeris_scheduler_enabled", help: "1 when scheduled ingestion is running in this process", registers: [registry], collect() { this.set(opts.scheduler ? 1 : 0); } });
  // The scanner is pinged at most every 30 seconds, whoever asks.
  let scanProbe: { at: number; up: boolean; version: string | null } | null = null;
  const scannerState = async () => {
    if (!opts.scanner) return { configured: false, engine: null as string | null, reachable: false, version: null as string | null };
    if (!scanProbe || Date.now() - scanProbe.at > 30_000) { try { scanProbe = { at: Date.now(), up: true, version: await opts.scanner.ping() }; } catch { scanProbe = { at: Date.now(), up: false, version: null }; } }
    return { configured: true, engine: opts.scanner.engine, reachable: scanProbe.up, version: scanProbe.version };
  };
  new Gauge({ name: "tigeris_scanner_up", help: "1 when the malware scanner answers, 0 when configured but not answering", registers: [registry], async collect() { const s = await scannerState(); this.set(s.configured && s.reachable ? 1 : 0); } });
  new Gauge({ name: "tigeris_documents_by_scan", help: "Documents by malware-scan state", labelNames: ["status"], registers: [registry], async collect() { this.reset(); const s = await withTenant(opts.pool, opts.institutionId, c => scanSummary(c)).catch(() => ({} as Record<string, number>)); for (const [k, v] of Object.entries(s)) this.set({ status: k }, v); } });
  app.addHook("onRequest", async (req, reply) => { reply.header("x-request-id", req.id); });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff").header("x-frame-options", "DENY").header("referrer-policy", "no-referrer").header("cross-origin-resource-policy", "same-origin");
    if (req.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => { httpDuration.observe({ method: req.method, route: req.routeOptions?.url ?? "unmatched", status: String(reply.statusCode) }, reply.elapsedTime / 1000); });
  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const status = err.statusCode ?? 500;
    if (status >= 500) { req.log.error({ err }, "unhandled error"); return reply.code(500).send({ error: "internal", message: "Something went wrong. Quote this request id to the operator.", requestId: req.id }); }
    return reply.code(status).send({ error: err.code ?? "bad_request", message: err.message, requestId: req.id });
  });
  if (opts.rateLimit) {
    const limiter = new RateLimiter(opts.rateLimit.max, 60_000);
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/health" || req.url === "/ready") return;
      const wait = limiter.check(req.ip);
      if (wait > 0) { authFailures.inc({ reason: "rate_limited" }); return reply.code(429).header("retry-after", String(Math.ceil(wait / 1000))).send({ error: "rate_limited", message: `Too many requests. Try again in ${Math.ceil(wait / 1000)} seconds.`, requestId: req.id }); }
    });
  }
  void app.register(swagger, { openapi: { info: { title: "TIGERIS AI OS API", version: "0.1.0", description: "Evidence, lineage and audit. Institution scope comes from deployment configuration." } } });
  const tenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTenant(opts.pool, opts.institutionId, fn);
  // A paged list is an array, with the total and the marker for the next page in headers. A bad marker is a plain 400.
  const paged = async <T>(reply: { header: (k: string, v: string) => unknown; code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<Page<T>>) => {
    try { const p = await fn(); reply.header("x-total-count", String(p.total)); if (p.next) reply.header("x-next-cursor", p.next); return p.rows; }
    catch (e) { if (e instanceof PagingError) return reply.code(400).send({ error: "invalid_query", message: e.message }); throw e; }
  };

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
    const unauthorized = (message: string) => { authFailures.inc({ reason: "unauthorized" }); return reply.code(401).header("www-authenticate", 'Bearer realm="tigeris"').send({ error: "unauthorized", message }); };
    if (!m) return unauthorized("bearer token required");
    let claims;
    try { claims = await opts.verifier(m[1]!); } catch (e) { return unauthorized(e instanceof AuthError ? e.message : "invalid token"); }
    const principal = await tenant(c => findPrincipal(c, claims.issuer, claims.subject));
    if (!principal) return reply.code(403).send({ error: "not_provisioned", message: "no principal for this identity in this institution" });
    const deny = async (reason: string) => { authFailures.inc({ reason: "forbidden" }); await tenant(c => audit(c, opts.institutionId, { actorType: "principal", actorId: principal.id, action: "identity.denied", objectType: "route", objectId: `${req.method} ${route}`, payload: { reason } })); return reply.code(403).send({ error: "forbidden", message: reason }); };
    if (principal.disabled) return deny("principal disabled");
    if (principal.sessionsValidAfter && (claims.issuedAt === null || claims.issuedAt * 1000 < principal.sessionsValidAfter.getTime())) return unauthorized("this session was ended; sign in again");
    if (need !== null && !permissionsOf(principal.roles).has(need)) return deny(`missing permission ${need}`);
    if (!LOCKDOWN_OK.has(`${req.method} ${route}`) && (await tenant(c => getLockdown(c))).locked) { authFailures.inc({ reason: "forbidden" }); return reply.code(423).send({ error: "locked_down", message: "the institution is in lockdown; only administrators and auditors can use the investigation and release routes" }); }
    req.principal = principal;
  });

  app.get("/health", async () => ({ status: "ok" }));
  // Readiness: can this instance serve a request that needs the database? Liveness above does not touch it.
  app.get("/ready", async (_req, reply) => { try { await Promise.race([opts.pool.query("SELECT 1"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]); return { status: "ready", scanner: (await scannerState().then(s => !s.configured ? "off" : s.reachable ? "up" : "down")) }; } catch { return reply.code(503).send({ status: "not_ready" }); } });
  // Metrics have their own bearer token, so they never depend on a person's identity. Without a token the endpoint does not exist.
  app.get("/metrics", async (req, reply) => {
    const tok = opts.metricsToken; if (!tok) return reply.code(404).send({ error: "not_found" });
    const given = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "", a = Buffer.from(given), b = Buffer.from(tok);
    if (a.length !== b.length || !timingSafeEqual(a, b)) { authFailures.inc({ reason: "metrics_token" }); return reply.code(401).header("www-authenticate", 'Bearer realm="metrics"').send({ error: "unauthorized" }); }
    return reply.header("content-type", registry.contentType).send(await registry.metrics());
  });

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
    const actor = { type: "principal", id: req.principal!.id }, privileged = b.data.roles.filter(x => (PRIVILEGED_ROLES as readonly string[]).includes(x));
    const r = await identityCall(reply, async c => {
      const p = await provisionPrincipal(c, opts.institutionId, actor, { ...b.data, roles: b.data.roles.filter(x => !privileged.includes(x)), displayName: b.data.displayName ?? null });
      return { ...p, pendingGrant: await requestForNewPerson(c, opts.institutionId, actor, p.id, privileged) };
    });
    return r && "id" in (r as object) ? reply.code(201).send(r) : r;
  });
  app.put("/v1/identity/principals/:id/roles", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id), b = rolesBody.safeParse(req.body);
    if (!id.success || !b.success) return reply.code(400).send({ error: "invalid_request" });
    return identityCall(reply, async c => { const r = await changeRoles(c, opts.institutionId, { type: "principal", id: req.principal!.id }, id.data, b.data.roles); return { ...r.principal, pendingGrant: r.pending }; });
  });
  app.get("/v1/identity/role-requests", async () => tenant(c => listGrantRequests(c)));
  app.post("/v1/identity/role-requests/:id/:verb", async (req, reply) => {
    const p = req.params as { id: string; verb: string }, id = uuid.safeParse(p.id), b = z.object({ note: z.string().trim().max(300).optional() }).safeParse(req.body ?? {});
    if (!id.success || !b.success || !["approve", "reject"].includes(p.verb)) return reply.code(400).send({ error: "invalid_request" });
    return identityCall(reply, c => decideGrantRequest(c, opts.institutionId, { type: "principal", id: req.principal!.id }, id.data, p.verb === "approve", b.data.note ?? null));
  });
  const why = z.object({ reason: z.string().trim().min(5).max(300) });
  app.get("/v1/lockdown", async () => tenant(c => getLockdown(c)));
  app.post("/v1/lockdown", async (req, reply) => {
    const b = z.object({ locked: z.boolean(), reason: z.string().trim().min(5).max(300) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_request" });
    return identityCall(reply, c => setLockdown(c, opts.institutionId, { type: "principal", id: req.principal!.id }, b.data.locked, b.data.reason));
  });
  app.post("/v1/identity/principals/:id/revoke-sessions", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id), b = why.safeParse(req.body);
    if (!id.success || !b.success) return reply.code(400).send({ error: "invalid_request" });
    return identityCall(reply, async c => ({ revoked: await revokeSessions(c, opts.institutionId, { type: "principal", id: req.principal!.id }, id.data, b.data.reason) }));
  });
  // Emergency: ends everyone's sessions, the caller's included. Each person signs in again with the identity provider.
  app.post("/v1/identity/revoke-all-sessions", async (req, reply) => {
    const b = why.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_request" });
    return identityCall(reply, async c => ({ revoked: await revokeSessions(c, opts.institutionId, { type: "principal", id: req.principal!.id }, null, b.data.reason) }));
  });
  app.post("/v1/identity/me/sign-out", async req => tenant(async c => ({ revoked: await revokeSessions(c, opts.institutionId, { type: "principal", id: req.principal!.id }, req.principal!.id, "signed out by the person") })));
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
    return paged(reply, () => tenant(c => keysetPage(c, {
      select: "e.id, s.source_key, e.external_key, e.payload->>'title' AS title, e.original_agency, e.event_time, e.retrieved_at, e.version, e.data_class, e.validation_status", from: "evidence_objects e JOIN sources s ON s.id = e.source_id",
      where: "($1::text IS NULL OR s.source_key = $1) AND ($2::text IS NULL OR e.validation_status::text = $2) AND ($3::text IS NULL OR e.external_key ILIKE $3 OR e.payload->>'title' ILIKE $3)",
      params: [q.data.source ?? null, q.data.status ?? null, q.data.q?.trim() ? likePattern(q.data.q) : null], ts: "e.retrieved_at", id: "e.id", limit: q.data.limit, cursor: q.data.cursor })));
  });

  app.get("/v1/evidence/:id/lineage", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    const out = await tenant(c => getLineage(c, id.data));
    return out ?? reply.code(404).send({ error: "not_found" });
  });

  // The tracks and latest period are grouped per series with a hash aggregate, not by sorting every fact of every series (which spilled to disk).
  app.get("/v1/series", async () => tenant(async c => (await c.query(
    `SELECT s.series_key, s.title, s.description, s.frequency, s.packs, s.max_age_days, src.source_key, COALESCE(le.original_agency, src.original_agency) AS original_agency,
            le.validation_status AS latest_validation, le.id AS latest_evidence_id, le.version AS latest_version, COALESCE(t.tracks, 0) AS tracks, t.latest_period
     FROM series s JOIN sources src ON src.id = s.source_id
     LEFT JOIN LATERAL (SELECT e.id, e.version, e.validation_status, e.original_agency FROM evidence_objects e WHERE e.id IN (SELECT evidence_id FROM evidence_facts WHERE series_id = s.id) ORDER BY e.retrieved_at DESC, e.version DESC LIMIT 1) le ON true
     LEFT JOIN LATERAL (SELECT count(*)::int AS tracks, max(g.latest) AS latest_period FROM (SELECT max(f.valid_time) AS latest FROM evidence_facts f WHERE f.series_id = s.id GROUP BY f.subject, f.predicate) g) t ON true
     ORDER BY s.series_key`)).rows));

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

  app.get("/v1/scenarios/backtest", async () => tenant(async c => (await episodeBacktestIfStored(c, opts.institutionId)) ?? { available: false, reason: "The stored records and the graph do not yet cover March to May 2026, so the back-test cannot be shown. Source not connected for those months." }));

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

  app.get("/v1/scenarios/runs", async (req, reply) => { const q = z.object({ template: z.string().max(80).optional(), ...pageQ }).safeParse(req.query); return q.success ? paged(reply, () => tenant(c => listRunsPage(c, q.data))) : reply.code(400).send({ error: "invalid_query" }); });

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
      if (e instanceof CaseError || e instanceof GovernanceError || e instanceof SettingsError || e instanceof RetentionError) {
        if (e.code === "forbidden") await tenant(c => audit(c, opts.institutionId, { actorType: "principal", actorId: req.principal!.id, action: "governance.refused", objectType: "route", objectId: `${req.method} ${req.url.split("?")[0]}`, payload: { reason: e.message } }));
        return reply.code({ not_found: 404, conflict: 409, invalid: 422, forbidden: 403 }[e.code]).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  };
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: z.ZodError) => reply.code(400).send({ error: "invalid_body", details: e.flatten() });
  const idOf = (req: { params: unknown }) => uuid.safeParse((req.params as { id: string }).id);

  app.get("/v1/identity/reviewers", async () => tenant(async c => (await listPrincipals(c)).filter(p => !p.disabled && permissionsOf(p.roles).has("decision.make")).map(p => ({ id: p.id, name: p.displayName ?? p.subject, roles: p.roles }))));
  app.get("/v1/cases", async (req, reply) => {
    const q = z.object({ state: z.enum(["open", "analysis", "in_review", "decided", "closed"]).optional(), domain: z.string().max(200).optional(), active: z.enum(["1", "true"]).optional(), q: z.string().max(100).optional(), ...pageQ }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    return paged(reply, () => tenant(c => listCasesPage(c, actor(req), { ...(q.data.state ? { state: q.data.state } : {}), ...(q.data.domain ? { domain: q.data.domain.split(",").map(x => x.trim()).filter(Boolean).slice(0, 10) } : {}), ...(q.data.active ? { active: true } : {}), ...(q.data.q ? { q: q.data.q } : {}), limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) })));
  });
  app.post("/v1/cases", async (req, reply) => { const b = caseBody.safeParse(req.body); return b.success ? domain(req, reply, c => createCase(c, opts.institutionId, actor(req), b.data), 201) : bad(reply, b.error); });
  app.get("/v1/cases/:id", async (req, reply) => { const id = idOf(req); return id.success ? domain(req, reply, async c => ({ ...(await getCase(c, actor(req), id.data) as object), hold: await holdFor(c, id.data) })) : reply.code(400).send({ error: "invalid_id" }); });
  const caseAction = <B,>(path: string, schema: z.ZodType<B, unknown>, run: (c: pg.PoolClient, caseId: string, b: B, a: { id: string; roles: string[] }) => Promise<unknown>, okCode = 200) =>
    app.post(`/v1/cases/:id/${path}`, async (req, reply) => { const id = idOf(req), b = schema.safeParse(req.body ?? {}); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error); return domain(req, reply, async c => (await run(c, id.data, b.data, actor(req))) ?? { ok: true }, okCode); });
  caseAction("evidence", evidenceBody, (c, id, b, a) => addEvidence(c, opts.institutionId, a, id, b), 201);
  caseAction("scenarios", z.object({ runId: z.string().uuid() }), (c, id, b, a) => addScenario(c, opts.institutionId, a, id, b.runId), 201);
  caseAction("participants", z.object({ principalId: z.string().uuid() }), (c, id, b, a) => addParticipant(c, opts.institutionId, a, id, b.principalId), 201);
  caseAction("start", z.object({}), (c, id, _b, a) => startAnalysis(c, opts.institutionId, a, id));
  caseAction("recommendations", recBody, (c, id, b, a) => addRecommendation(c, opts.institutionId, a, id, { ...b, constraints: b.constraints, scenarioRunId: b.scenarioRunId, ownerId: b.ownerId } as never), 201);
  caseAction("submit", submitBody, (c, id, b, a) => submitForReview(c, opts.institutionId, a, id, b));
  caseAction("decision", decisionBody, (c, id, b, a) => decide(c, opts.institutionId, a, id, b as never));
  caseAction("close", closeBody, (c, id, b, a) => closeCase(c, opts.institutionId, a, id, b));
  app.get("/v1/handoffs", async (req, reply) => { const q = z.object({ status: z.enum(["open", "done", "cancelled"]).optional(), ...pageQ }).safeParse(req.query); return q.success ? paged(reply, () => tenant(c => listHandoffsPage(c, actor(req), { ...(q.data.status ? { status: q.data.status } : {}), limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) }))) : reply.code(400).send({ error: "invalid_query" }); });
  app.post("/v1/handoffs/:id/update", async (req, reply) => { const id = idOf(req), b = handoffBody.safeParse(req.body); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error); return domain(req, reply, async c => { await updateHandoff(c, opts.institutionId, actor(req), id.data, b.data); return { ok: true }; }); });
  app.get("/v1/memory", async (req, reply) => { const q = z.object({ q: z.string().max(200).optional(), ...pageQ }).safeParse(req.query); return q.success ? paged(reply, () => tenant(c => searchMemoryPage(c, actor(req), { ...(q.data.q ? { q: q.data.q } : {}), limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) }))) : reply.code(400).send({ error: "invalid_query" }); });
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
      // Scan before anything is stored. If the scanner cannot give a verdict now, the file is stored as waiting and is scanned again later; it is never treated as clean.
      let verdict: Verdict | null = null;
      if (opts.scanner) { try { verdict = await opts.scanner.scan(req.body); } catch { verdict = null; } }
      const out = await intake(req, reply, async c => {
        const r = await submitDocument(c, opts.institutionId, req.principal!.id, { buffer: req.body as Buffer, filename: hdr(h["x-filename"]) || "document", title: hdr(h["x-title"]), dataClass: hdr(h["x-data-class"]) as never, originalAgency: hdr(h["x-original-agency"]), sourceUrl: hdr(h["x-source-url"]), rights: hdr(h["x-rights"]), languages: hdr(h["x-languages"]) || "eng", clientDataEnabled: opts.clientDataEnabled === true , scan: { configured: !!opts.scanner, engine: opts.scanner?.engine ?? null, verdict }});
        if (!r.duplicate && r.status === "queued") queued = r.id;
        return r;
      }, ((r: { duplicate: boolean }) => r.duplicate ? 200 : 202) as never);
      if (queued) opts.documents?.enqueue(queued);
      return out;
    });
  });
  // Retention: a report, legal holds and case exports. There is no deletion route anywhere in this API.
  app.get("/v1/retention", async () => tenant(c => retentionReport(c)));
  const reason = z.object({ reason: z.string().min(1).max(2000) });
  app.post("/v1/cases/:id/hold", async (req, reply) => { const id = idOf(req), b = reason.safeParse(req.body); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error); return domain(req, reply, c => placeHold(c, opts.institutionId, req.principal!.id, id.data, b.data.reason), 201); });
  app.post("/v1/cases/:id/release", async (req, reply) => { const id = idOf(req), b = reason.safeParse(req.body); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error); return domain(req, reply, c => releaseHold(c, opts.institutionId, req.principal!.id, id.data, b.data.reason)); });
  app.post("/v1/cases/:id/export", async (req, reply) => {
    const id = idOf(req), b = z.object({ purpose: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error);
    const r = await domain(req, reply, c => exportCase(c, opts.institutionId, actor(req), id.data, b.data.purpose));
    if (reply.statusCode === 200 && r && typeof r === "object" && "header" in r) reply.header("content-disposition", `attachment; filename="${(r as { header: { caseKey: string } }).header.caseKey}-export.json"`);
    return r;
  });

  // Governed settings. Tiger's numbers: drafted by one administrator, activated by another, versioned and audited.
  app.get("/v1/settings", async () => tenant(async c => {
    const versions = await listSettings(c), links = await new PostgresGraph(c, opts.institutionId).linked("chokepoint:hormuz", "constrains_exports_of").catch(() => []);
    return {
      scopes: await (async () => { const out = []; for (const scope of SCOPES) out.push({ scope, ...SCOPE_INFO[scope], active: await activeOf(c, scope), versions: versions.filter(v => v.scope === scope), defaults: scope === "signal_rules" ? DEFAULT_SIGNAL_RULES : {} }); return out; })(),
      catalog: Object.values(TEMPLATES).map(t => ({ key: t.key, title: t.title, pack: t.pack, parameters: t.defaults(null) })),
      schedule: {
        sources: (await c.query("SELECT source_key, name, platform_type FROM sources WHERE status = 'approved' ORDER BY source_key")).rows.map((r: { source_key: string; name: string; platform_type: string }) => ({ key: r.source_key, name: r.name, platform: r.platform_type, modes: (["series", "catalog"] as const).filter(m => connectorFor(r.platform_type, m, r.source_key)) })).filter((r: { modes: string[] }) => r.modes.length > 0),
        stewards: (await listPrincipals(c)).filter(p => !p.disabled && permissionsOf(p.roles).has("case.write")).map(p => ({ id: p.id, name: p.displayName ?? p.subject })),
      },
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
  // Executive briefing: composed by fixed code from the sector view, the cases and scenario runs this reader may see. Carries a content hash so a saved copy can be checked.
  app.get("/v1/briefings/:pack", async (req, reply) => {
    const k = (req.params as { pack: string }).pack;
    if (!isPack(k)) return reply.code(404).send({ error: "not_found" });
    const perms = permissionsOf(req.principal!.roles);
    return tenant(async c => composeBriefing({
      view: await buildSector(c, k, new Date(), await effectiveThresholds(c)),
      cases: perms.has("case.read") ? (await listCases(c, actor(req))) as BriefingCase[] : null,
      runs: perms.has("scenario.read") ? (await listRuns(c)) as BriefingRun[] : null,
      templates: Object.values(TEMPLATES).map(t => ({ key: t.key, pack: t.pack, title: t.title })), viewerId: req.principal!.id,
    }));
  });

  // Installation readiness: what is still open before real use. Read from stored facts and the running configuration.
  app.get("/v1/readiness", async () => { const sc = await scannerState(); return tenant(c => installationReadiness(c, { clientDataEnabled: opts.clientDataEnabled === true, scanner: { configured: sc.configured, reachable: sc.reachable }, scheduler: { enabled: !!opts.scheduler }, alerts: { configured: !!opts.alerts, transport: opts.alerts?.mailer.transport ?? null }, backupMaxAgeHours: opts.backupMaxAgeHours ?? 0, auditAnchorConfigured: Boolean(opts.auditAnchorKey), documentKeyConfigured: documentCrypto() !== null, reasoning: { provider: opts.reasoning ? `${opts.reasoning.adapter.provider} · ${opts.reasoning.adapter.model}` : null } })); });
  // Source health and scheduled ingestion. The schedule is a governed setting; these routes read state and let an operator run, pause or resume one source.
  app.get("/v1/sources/health", async () => tenant(async c => {
    const { schedule, version } = await effectiveSchedule(c);
    return { asOf: new Date().toISOString(), scheduler: { enabled: !!opts.scheduler, running: opts.scheduler?.running ?? false, tickSeconds: opts.scheduler?.tickSeconds ?? null, lastTickAt: opts.scheduler?.lastTickAt?.toISOString() ?? null, scheduleVersion: version, steward: schedule.steward, pauseAfterFailures: schedule.pauseAfterFailures }, sources: await sourceHealth(c) };
  }));
  const keyOf = (req: { params: unknown }) => z.string().regex(/^[a-z0-9][a-z0-9-]{1,119}$/).safeParse((req.params as { key: string }).key);
  const reasonBody = z.object({ reason: z.string().min(1).max(1000) });
  const sched = async (req: { principal?: Principal; params: unknown; body: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: (c: pg.PoolClient, key: string, reason: string) => Promise<void>, needReason: boolean) => {
    const k = keyOf(req), b = reasonBody.safeParse(req.body ?? {});
    if (!k.success) return reply.code(400).send({ error: "invalid_key" });
    if (needReason && !b.success) return bad(reply, b.error);
    try { await tenant(c => fn(c, k.data, b.success ? b.data.reason : "")); return reply.code(202).send({ ok: true }); }
    catch (e) { if (e instanceof SchedulerError) return reply.code({ not_found: 404, conflict: 409, invalid: 422 }[e.code]).send({ error: e.code, message: e.message }); throw e; }
  };
  app.post("/v1/sources/:key/run", async (req, reply) => { if (!opts.scheduler) return reply.code(409).send({ error: "conflict", message: "Scheduled ingestion is not running in this deployment. Run the ingest command instead." }); const r = await sched(req, reply, (c, k) => requestRun(c, opts.institutionId, req.principal!.id, k, new Date()), false); void opts.scheduler.tick().catch(() => undefined); return r; });
  app.post("/v1/sources/:key/pause", async (req, reply) => sched(req, reply, (c, k, why) => pauseSource(c, opts.institutionId, req.principal!.id, k, why, new Date()), true));
  app.post("/v1/sources/:key/resume", async (req, reply) => sched(req, reply, (c, k, why) => resumeSource(c, opts.institutionId, req.principal!.id, k, why, new Date()), true));

  // Alerts: a short notice by email when something needs a person. The message carries a category, a reference code and a link, never record content.
  const maskEmail = (e: string | null) => e ? `${e[0]}***@${e.split("@")[1]}` : null;
  const testLimiter = new RateLimiter(5, 3_600_000);
  app.get("/v1/alerts", async () => tenant(async c => ({
    configured: !!opts.alerts, transport: opts.alerts?.mailer.transport ?? null, lastPassAt: opts.alerts?.runner?.lastTickAt?.toISOString() ?? null,
    conditions: (await c.query("SELECT condition_key, category, kind, state, ref, link, detail, first_seen_at, last_seen_at, last_notified_at, notify_count, attempts, resolved_at FROM alert_conditions WHERE state = 'open' OR resolved_at > now() - interval '7 days' ORDER BY state, last_seen_at DESC LIMIT 100")).rows,
    deliveries: (await c.query("SELECT d.id, d.condition_key, d.category, d.kind, d.status, d.reason, d.created_at, COALESCE(p.display_name, p.idp_subject) AS person FROM alert_deliveries d JOIN principals p ON p.id = d.principal_id ORDER BY d.created_at DESC LIMIT 100")).rows,
  })));
  app.get("/v1/alerts/mine", async req => tenant(async c => {
    const me = (await c.query("SELECT email FROM principals WHERE id = $1", [req.principal!.id])).rows[0]?.email as string | null | undefined;
    const off = new Set((await c.query("SELECT category FROM alert_preferences WHERE principal_id = $1 AND enabled = false", [req.principal!.id])).rows.map(r => r.category as string));
    return { configured: !!opts.alerts, email: maskEmail(me ?? null), categories: CATEGORIES.map(k => ({ category: k, mutable: MUTABLE.includes(k), enabled: !off.has(k) })) };
  }));
  app.put("/v1/alerts/mine", async (req, reply) => {
    const b = z.object({ category: z.enum(["source", "review"]), enabled: z.boolean() }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    await tenant(async c => {
      await c.query("INSERT INTO alert_preferences (institution_id, principal_id, category, enabled) VALUES ($1,$2,$3,$4) ON CONFLICT (institution_id, principal_id, category) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()", [opts.institutionId, req.principal!.id, b.data.category, b.data.enabled]);
      await audit(c, opts.institutionId, { actorType: "principal", actorId: req.principal!.id, action: "alerts.preference_set", objectType: "principal", objectId: req.principal!.id, payload: b.data });
    });
    return { ok: true };
  });
  app.get("/v1/alerts/addresses", async () => tenant(async c => (await c.query("SELECT p.id, COALESCE(p.display_name, p.idp_subject) AS name, p.idp_subject AS subject, p.email, p.disabled_at IS NOT NULL AS disabled, COALESCE(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles FROM principals p LEFT JOIN principal_roles pr ON pr.principal_id = p.id AND pr.institution_id = p.institution_id LEFT JOIN roles r ON r.id = pr.role_id AND r.institution_id = pr.institution_id GROUP BY p.id ORDER BY name")).rows));
  app.put("/v1/alerts/addresses/:id", async (req, reply) => {
    const id = idOf(req), b = z.object({ email: z.string().trim().min(3).max(254).nullable() }).safeParse(req.body);
    if (!id.success) return reply.code(400).send({ error: "invalid_id" }); if (!b.success) return bad(reply, b.error);
    try {
      await tenant(async c => {
        const r = await c.query("UPDATE principals SET email = $2 WHERE id = $1 RETURNING id", [id.data, b.data.email]);
        if (!r.rowCount) throw new IdentityError("person not found", "not_found");
        await audit(c, opts.institutionId, { actorType: "principal", actorId: req.principal!.id, action: "alerts.address_set", objectType: "principal", objectId: id.data, payload: { set: b.data.email !== null, domain: b.data.email ? b.data.email.split("@")[1] : null } });
      });
    } catch (e) {
      if (e instanceof IdentityError) return reply.code(404).send({ error: e.code, message: e.message });
      if ((e as { code?: string }).code === "23514") return reply.code(422).send({ error: "invalid", message: "that is not a valid email address" });
      throw e;
    }
    return { ok: true };
  });
  app.post("/v1/alerts/test", async (req, reply) => {
    if (!opts.alerts) return reply.code(409).send({ error: "conflict", message: "Alerts are not configured on this deployment." });
    const wait = testLimiter.check(req.principal!.id);
    if (wait > 0) return reply.code(429).send({ error: "rate_limited", message: "Too many test messages this hour." });
    return sendTest({ pool: opts.pool, institutionId: opts.institutionId, mailer: opts.alerts.mailer, baseUrl: opts.alerts.baseUrl, principalId: req.principal!.id });
  });

  // Reasoning: a model drafts, fixed code verifies, a person decides. Off unless a model is configured. Every call is recorded and audited.
  const reasoningLimiter = new RateLimiter(opts.reasoning?.perHour ?? 30, 3_600_000);
  const reasoningBody = z.discriminatedUnion("task", [
    z.object({ task: z.literal("summary_briefing"), pack: z.enum(["energy", "sovereign"]) }),
    z.object({ task: z.enum(["summary_case", "questions_case", "recommendation_case"]), caseId: uuid }),
    z.object({ task: z.literal("answer"), question: z.string().trim().min(5).max(500) }),
  ]);
  app.get("/v1/reasoning/config", async () => ({ enabled: !!opts.reasoning, provider: opts.reasoning?.adapter.provider ?? null, model: opts.reasoning?.adapter.model ?? null, perHour: opts.reasoning?.perHour ?? 30, sentClasses: ["public_record", "sample_dataset", "scenario_simulation"] }));
  app.post("/v1/reasoning/run", async (req, reply) => {
    if (!opts.reasoning) return reply.code(503).send({ error: "reasoning_not_configured", message: "No model is connected to this deployment." });
    const b = reasoningBody.safeParse(req.body); if (!b.success) return bad(reply, b.error);
    const wait = reasoningLimiter.check(req.principal!.id);
    if (wait > 0) return reply.code(429).header("retry-after", String(Math.ceil(wait / 1000))).send({ error: "rate_limited", message: "Too many drafts this hour." });
    const ctx = {
      pool: opts.pool, institutionId: opts.institutionId, adapter: opts.reasoning.adapter,
      briefing: async (c: pg.PoolClient, pack: "energy" | "sovereign") => composeBriefing({ view: await buildSector(c, pack, new Date(), await effectiveThresholds(c)), cases: null, runs: (await listRuns(c)) as BriefingRun[], templates: Object.values(TEMPLATES).map(t => ({ key: t.key, pack: t.pack, title: t.title })), viewerId: req.principal!.id }),
      getCase: (c: pg.PoolClient, a: { id: string; roles: string[] }, id: string) => getCase(c, a, id) as Promise<any>,
    };
    try { return await runReasoning(ctx, actor(req), b.data); }
    catch (e) {
      if (e instanceof CaseError || e instanceof ReasoningError) return reply.code({ not_found: 404, conflict: 409, invalid: 422, forbidden: 403 }[e.code]).send({ error: e.code, message: e.message });
      throw e;
    }
  });
  app.get("/v1/reasoning/calls", async (req, reply) => { const q = z.object(pageQ).safeParse(req.query); return q.success ? paged(reply, () => tenant(c => listCalls(c, { limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) }))) : reply.code(400).send({ error: "invalid_query" }); });

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

  app.get("/v1/documents", async (req, reply) => { const q = z.object({ q: z.string().max(100).optional(), status: z.enum(["queued", "processing", "ready", "failed", "quarantined"]).optional(), ...pageQ }).safeParse(req.query); return q.success ? paged(reply, () => tenant(c => listDocumentsPage(c, { ...(q.data.q ? { q: q.data.q } : {}), ...(q.data.status ? { status: q.data.status } : {}), limit: q.data.limit, ...(q.data.cursor ? { cursor: q.data.cursor } : {}) }))) : reply.code(400).send({ error: "invalid_query" }); });
  app.get("/v1/documents/config", async () => { const t = await docTools(); return { clientDataEnabled: opts.clientDataEnabled === true, ocr: { available: t.tesseract !== null, languages: t.languages }, scanner: await scannerState(), scan: await tenant(c => scanSummary(c)), maxMegabytes: 20, maxPages: 100, accepted: ["PDF", "PNG", "JPEG", "TIFF", "Word (.docx)", "Plain text"] }; });
  app.get("/v1/documents/search", async (req, reply) => { const q = z.object({ q: z.string().min(2).max(200) }).safeParse(req.query); return q.success ? tenant(c => searchDocuments(c, q.data.q)) : reply.code(400).send({ error: "invalid_query" }); });
  app.get("/v1/documents/:id", async (req, reply) => { const id = idOf(req); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); return (await tenant(c => getDocument(c, id.data))) ?? reply.code(404).send({ error: "not_found" }); });
  app.get("/v1/documents/:id/pages/:n", async (req, reply) => { const id = idOf(req), n = z.coerce.number().int().min(1).max(1000).safeParse((req.params as { n: string }).n); if (!id.success || !n.success) return reply.code(400).send({ error: "invalid_request" }); return (await tenant(c => getPage(c, id.data, n.data))) ?? reply.code(404).send({ error: "not_found" }); });
  app.get("/v1/documents/:id/file", async (req, reply) => {
    const id = idOf(req); if (!id.success) return reply.code(400).send({ error: "invalid_id" });
    let f; try { f = await tenant(c => downloadDocument(c, opts.institutionId, req.principal!.id, id.data)); } catch (e) { if (e instanceof IntakeError) return reply.code(403).send({ error: e.code, message: e.message }); throw e; }
    if (!f) return reply.code(404).send({ error: "not_found" });
    return reply.header("content-type", f.mime).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`).header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox").send(f.content);
  });
  app.post("/v1/documents/:id/retry", async (req, reply) => { const id = idOf(req); if (!id.success) return reply.code(400).send({ error: "invalid_id" }); const out = await intake(req, reply, async c => { await retryDocument(c, opts.institutionId, req.principal!.id, id.data); return { ok: true }; }); if (reply.statusCode === 200) opts.documents?.enqueue(id.data); return out; });

  app.get("/v1/audit/verify", async () => tenant(c => verifyAuditChain(c)));
  // A signed statement of where the audit chain stands. Keep it somewhere the database administrator cannot reach; check it later with the verify route.
  app.get("/v1/audit/checkpoint", async (req, reply) => {
    if (!opts.auditAnchorKey) return reply.code(409).send({ error: "not_configured", message: "set TIGERIS_AUDIT_ANCHOR_KEY to sign checkpoints" });
    const cp = await tenant(async c => { const out = await takeCheckpoint(c, opts.institutionId, opts.auditAnchorKey!); await audit(c, opts.institutionId, { actorType: "principal", actorId: req.principal!.id, action: "audit.checkpoint_taken", objectType: "audit", objectId: String(out.seq), payload: { events: out.events } }); return out; });
    return cp;
  });
  const checkpointBody = z.object({ institutionId: z.string().uuid(), events: z.number().int().min(0), seq: z.number().int().min(0), hash: z.string().regex(/^[0-9a-f]{64}$/), at: z.string().max(40), signature: z.string().max(100) });
  app.post("/v1/audit/checkpoint/verify", async (req, reply) => {
    if (!opts.auditAnchorKey) return reply.code(409).send({ error: "not_configured", message: "set TIGERIS_AUDIT_ANCHOR_KEY to verify checkpoints" });
    const b = checkpointBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_request" });
    return tenant(c => verifyCheckpoint(c, opts.institutionId, opts.auditAnchorKey!, b.data));
  });
  return app;
}
