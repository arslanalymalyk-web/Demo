import pg from "pg";
import { DocumentQueue } from "../../../packages/documents/src/index.js";
import { oidcVerifier, remoteKeys } from "../../../packages/identity/src/index.js";
import { anthropicAdapter, extractiveAdapter, openAiCompatibleAdapter, type ModelAdapter } from "../../../packages/reasoning/src/index.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { checkRuntimeSafety } from "./startup.js";

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

const documents = new DocumentQueue(pool, cfg.institutionId);
const app = buildServer({
  pool, institutionId: cfg.institutionId, verifier: oidcVerifier(cfg.oidc, remoteKeys(cfg.oidc.jwksUri)), documents, clientDataEnabled: cfg.clientDataEnabled,
  logger: { level: cfg.logLevel, redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], remove: true } },
  reasoning: adapter ? { adapter } : null, rateLimit: cfg.rateLimit, metricsToken: cfg.metricsToken, trustProxy: cfg.trustProxy,
});
await app.listen({ port: cfg.port, host: cfg.host });
const resumed = await documents.resume();
app.log.info({ port: cfg.port, host: cfg.host, production: cfg.production, resumedDocuments: resumed, metrics: cfg.metricsToken !== null, reasoning: adapter ? `${adapter.provider}/${adapter.model}` : "off" }, "api started");

// Finish in-flight work before exiting, so a restart does not cut a request or a document in half.
let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, async () => {
  if (closing) return; closing = true; app.log.info({ sig }, "shutting down");
  const timer = setTimeout(() => process.exit(1), 25_000); timer.unref();
  try { await app.close(); await documents.idle(); await pool.end(); } finally { process.exit(0); }
});
