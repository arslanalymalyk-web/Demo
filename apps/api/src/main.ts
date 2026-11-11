import pg from "pg";
import { DocumentQueue, clamavScanner, stubScanner, type Scanner } from "../../../packages/documents/src/index.js";
import { getLockdown, oidcVerifier, remoteKeys } from "../../../packages/identity/src/index.js";
import { CheckpointRunner } from "../../../packages/ingest/src/anchor-runner.js";
import { withTenant } from "../../../packages/ingest/src/store.js";
import { anthropicAdapter, extractiveAdapter, openAiCompatibleAdapter, type ModelAdapter } from "../../../packages/reasoning/src/index.js";
import { AlertRunner, createMailer, type Mailer } from "../../../packages/alerts/src/index.js";
import { Scheduler, ingestJob } from "../../../packages/scheduler/src/index.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { checkRuntimeSafety } from "./startup.js";

// A fault nobody caught must not leave the process half alive. Say what happened in one structured line and exit, so the container restarts it cleanly.
for (const ev of ["uncaughtException", "unhandledRejection"] as const) process.on(ev, e => { console.error(JSON.stringify({ level: "fatal", msg: ev, error: e instanceof Error ? e.message : String(e) })); process.exit(1); });

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(2); }
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
pool.on("error", e => console.error("database pool error:", e.message));
const safety = await checkRuntimeSafety(pool).catch(e => ({ ok: false, problems: [`the database could not be checked: ${(e as Error).message}`] }));
if (!safety.ok) { console.error(`refusing to start:\n - ${safety.problems.join("\n - ")}`); await pool.end(); process.exit(2); }

let adapter: ModelAdapter | null = null;
try {
  const m = cfg.reasoning;
  if (m.provider === "anthropic") adapter = anthropicAdapter({ baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey, production: cfg.production });
  else if (m.provider === "openai_compatible") adapter = openAiCompatibleAdapter({ baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey, production: cfg.production });
  else if (m.provider === "local_extractive") adapter = extractiveAdapter();
} catch (e) { console.error(`configuration refused: ${(e as Error).message}`); await pool.end(); process.exit(2); }

const scanner: Scanner | null = cfg.scanner.kind === "clamav" ? clamavScanner({ target: cfg.scanner.socket ? { socket: cfg.scanner.socket } : { host: cfg.scanner.host, port: cfg.scanner.port } }) : cfg.scanner.kind === "stub" ? stubScanner() : null;
if (scanner) {
  try { console.log(JSON.stringify({ level: "info", msg: "malware scanner answered", engine: scanner.engine, version: await scanner.ping() })); }
  catch (e) {
    if (cfg.clientDataEnabled) { console.error(`refusing to start: institution documents are enabled but the malware scanner does not answer (${(e as Error).message})`); await pool.end(); process.exit(2); }
    console.error(JSON.stringify({ level: "warn", msg: "malware scanner does not answer; uploads will wait for a scan", error: (e as Error).message }));
  }
}
let mailer: Mailer | null = null;
if (cfg.alerts.enabled) {
  const a = cfg.alerts;
  try { mailer = createMailer({ transport: a.transport, host: a.host, port: a.port, security: a.security, user: a.user, password: a.password, from: a.from, production: cfg.production }); await mailer.verify(); console.log(JSON.stringify({ level: "info", msg: "alert relay answered", transport: a.transport })); }
  catch (e) { console.error(JSON.stringify({ level: "warn", msg: "alert relay is not answering; notices will be retried", error: (e as Error).message })); }
}
const documents = new DocumentQueue(pool, cfg.institutionId, () => new Date(), scanner);
const scheduler = cfg.scheduler.enabled ? new Scheduler({ pool, institutionId: cfg.institutionId, run: ingestJob(pool, cfg.institutionId), tickMs: cfg.scheduler.tickSeconds * 1000, halted: () => withTenant(pool, cfg.institutionId, async c => (await getLockdown(c)).locked), log: (m, o) => console.log(JSON.stringify({ level: "info", msg: m, ...o })) }) : null;
const alertRunner = mailer ? new AlertRunner({ pool, institutionId: cfg.institutionId, mailer, baseUrl: cfg.alerts.baseUrl, backupMaxAgeHours: cfg.backupMaxAgeHours, ...(cfg.checkpoint ? { checkpointMaxAgeHours: cfg.checkpoint.everyHours * 2 } : {}), engine: { reminderHours: cfg.alerts.reminderHours, maxPerHour: cfg.alerts.maxPerHour }, ...(scanner ? { scanner: async () => ({ configured: true, reachable: await scanner.ping().then(() => true, () => false) }) } : {}), log: (m, o) => console.log(JSON.stringify({ level: "info", msg: m, ...o })) }) : null;
const checkpoints = cfg.checkpoint && cfg.auditAnchorKey ? new CheckpointRunner({ pool, institutionId: cfg.institutionId, key: cfg.auditAnchorKey, dir: cfg.checkpoint.dir, everyHours: cfg.checkpoint.everyHours, log: (msg, o) => console.log(JSON.stringify({ level: "info", msg, ...o })) }) : null;
const app = buildServer({
  scanner, pool, institutionId: cfg.institutionId, verifier: oidcVerifier(cfg.oidc, remoteKeys(cfg.oidc.jwksUri)), documents, clientDataEnabled: cfg.clientDataEnabled,
  logger: { level: cfg.logLevel, redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], remove: true } },
  reasoning: adapter ? { adapter } : null, scheduler, backupMaxAgeHours: cfg.backupMaxAgeHours, ...(cfg.auditAnchorKey ? { auditAnchorKey: cfg.auditAnchorKey } : {}), alerts: mailer ? { mailer, baseUrl: cfg.alerts.baseUrl, ...(alertRunner ? { runner: alertRunner } : {}) } : null, rateLimit: cfg.rateLimit, metricsToken: cfg.metricsToken, trustProxy: cfg.trustProxy,
});
await app.listen({ port: cfg.port, host: cfg.host });
const resumed = await documents.resume();
scheduler?.start();
alertRunner?.start();
checkpoints?.start();
documents.startRetrying();
app.log.info({ port: cfg.port, host: cfg.host, production: cfg.production, resumedDocuments: resumed, metrics: cfg.metricsToken !== null, scheduler: scheduler ? `every ${cfg.scheduler.tickSeconds}s` : "off", alerts: mailer ? mailer.transport : "off", reasoning: adapter ? `${adapter.provider}/${adapter.model}` : "off" }, "api started");

// Finish in-flight work before exiting, so a restart does not cut a request or a document in half.
let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, async () => {
  if (closing) return; closing = true; app.log.info({ sig }, "shutting down");
  const timer = setTimeout(() => process.exit(1), 25_000); timer.unref();
  try { await app.close(); await documents.idle(); await scheduler?.stop(); await alertRunner?.stop(); checkpoints?.stop(); await pool.end(); } finally { process.exit(0); }
});
