import { DEFAULT_MAX_TOKEN_AGE_SECONDS } from "../../../packages/identity/src/verify.js";
import { applyFileSecrets, SECRET_NAMES } from "../../../packages/core/src/secrets.js";

export { applyFileSecrets, SECRET_NAMES };

export interface Config {
  production: boolean; databaseUrl: string; institutionId: string; port: number; host: string;
  oidc: { issuer: string; audience: string; jwksUri: string; requireMfa: boolean; maxTokenAgeSeconds: number };
  reasoning: { provider: "off" | "anthropic" | "openai_compatible" | "local_extractive"; model: string; baseUrl: string; apiKey: string | null };
  scheduler: { enabled: boolean; tickSeconds: number };
  alerts: { enabled: boolean; transport: "smtp" | "log"; host: string; port: number; security: "starttls" | "tls" | "none"; user: string | null; password: string | null; from: string; baseUrl: string; reminderHours: number; maxPerHour: number };
  backupMaxAgeHours: number;
  auditAnchorKey: string | null;
  documentKeys: { current: string; previous: string[] } | null;
  checkpoint: { dir: string; everyHours: number } | null;
  scanner: { kind: "off" | "clamav" | "stub"; host: string; port: number; socket: string };
  clientDataEnabled: boolean; metricsToken: string | null; trustProxy: boolean; logLevel: string; rateLimit: { max: number; timeWindow: string } | null;
}

const WEAK = /^(password|changeme|change_me|secret|admin|postgres|tigeris|ci|test|12345678)$/i;

/** Reads and checks the configuration. Everything wrong is reported together, and the API refuses to start on any of it. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  applyFileSecrets(env);
  const problems: string[] = [], production = env.TIGERIS_ENV === "production";
  const need = (k: string) => { const v = env[k]; if (!v) problems.push(`${k} is required`); return v ?? ""; };
  const databaseUrl = need("DATABASE_URL"), institutionId = need("TIGERIS_INSTITUTION_ID"), issuer = need("OIDC_ISSUER"), audience = need("OIDC_AUDIENCE"), jwksUri = need("OIDC_JWKS_URI");
  if (institutionId && !/^[0-9a-f-]{36}$/i.test(institutionId)) problems.push("TIGERIS_INSTITUTION_ID must be a UUID");
  const requireMfa = env.OIDC_REQUIRE_MFA_CLAIM !== "false";
  const maxTokenAgeSeconds = env.OIDC_MAX_TOKEN_AGE_SECONDS === undefined || env.OIDC_MAX_TOKEN_AGE_SECONDS === "" ? DEFAULT_MAX_TOKEN_AGE_SECONDS : Number(env.OIDC_MAX_TOKEN_AGE_SECONDS);
  if (!Number.isInteger(maxTokenAgeSeconds) || maxTokenAgeSeconds < 0) problems.push("OIDC_MAX_TOKEN_AGE_SECONDS must be a whole number of seconds, or 0 for no limit");
  if (production) {
    for (const [k, v] of [["OIDC_ISSUER", issuer], ["OIDC_JWKS_URI", jwksUri]] as const) if (v && !v.startsWith("https://")) problems.push(`${k} must use https in production`);
    if (!requireMfa && env.TIGERIS_ALLOW_NO_MFA_CLAIM !== "true") problems.push("OIDC_REQUIRE_MFA_CLAIM=false needs TIGERIS_ALLOW_NO_MFA_CLAIM=true in production, so skipping the claim is a recorded decision");
    try { const u = new URL(databaseUrl); if (WEAK.test(decodeURIComponent(u.password)) || decodeURIComponent(u.password).length < 12) problems.push("the database password is missing, short or a known weak value"); } catch { if (databaseUrl) problems.push("DATABASE_URL is not a valid URL"); }
    if (env.TIGERIS_CLIENT_DATA_ENABLED === "true" && env.TIGERIS_CLIENT_DATA_REVIEW_DONE !== "true") problems.push("institution documents are enabled but TIGERIS_CLIENT_DATA_REVIEW_DONE is not true: decision 11 requires the client's security review first");
    if (env.METRICS_TOKEN && env.METRICS_TOKEN.length < 24) problems.push("METRICS_TOKEN must be at least 24 characters");
  }
  const auditAnchorKey = env.TIGERIS_AUDIT_ANCHOR_KEY || null;
  if (auditAnchorKey && auditAnchorKey.length < 32) problems.push("TIGERIS_AUDIT_ANCHOR_KEY must be at least 32 characters");
  const cpDir = env.TIGERIS_AUDIT_CHECKPOINT_DIR || "", cpHours = Number(env.TIGERIS_AUDIT_CHECKPOINT_HOURS ?? 24);
  if (cpDir && !auditAnchorKey) problems.push("TIGERIS_AUDIT_CHECKPOINT_DIR needs TIGERIS_AUDIT_ANCHOR_KEY, which signs the checkpoints");
  if (!Number.isInteger(cpHours) || cpHours < 1 || cpHours > 720) problems.push("TIGERIS_AUDIT_CHECKPOINT_HOURS must be a whole number between 1 and 720");
  const docKey = env.TIGERIS_DOCUMENT_KEY || null, docPrev = (env.TIGERIS_DOCUMENT_KEY_PREVIOUS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  if (docKey && docKey.length < 32) problems.push("TIGERIS_DOCUMENT_KEY must be at least 32 characters");
  if (docPrev.some(k => k.length < 32)) problems.push("every key in TIGERIS_DOCUMENT_KEY_PREVIOUS must be at least 32 characters");
  if (docPrev.length && !docKey) problems.push("TIGERIS_DOCUMENT_KEY_PREVIOUS needs TIGERIS_DOCUMENT_KEY");
  if (production && env.TIGERIS_CLIENT_DATA_ENABLED === "true" && !docKey) problems.push("institution documents are enabled but TIGERIS_DOCUMENT_KEY is not set, so their contents would be stored unsealed");
  const provider = env.TIGERIS_REASONING_PROVIDER ?? "off", model = env.TIGERIS_MODEL_NAME ?? "", apiKey = env.TIGERIS_MODEL_API_KEY || null;
  let baseUrl = env.TIGERIS_MODEL_BASE_URL ?? "";
  if (!["off", "anthropic", "openai_compatible", "local_extractive"].includes(provider)) problems.push("TIGERIS_REASONING_PROVIDER must be off, anthropic, openai_compatible or local_extractive");
  if (provider === "anthropic" || provider === "openai_compatible") {
    if (!model) problems.push("TIGERIS_MODEL_NAME is required when a model provider is set");
    if (provider === "anthropic") { baseUrl ||= "https://api.anthropic.com"; if (!apiKey) problems.push("TIGERIS_MODEL_API_KEY (or _FILE) is required for the Claude API"); }
    else if (!baseUrl) problems.push("TIGERIS_MODEL_BASE_URL is required for an OpenAI-compatible provider");
    if (baseUrl && production && !baseUrl.startsWith("https://")) problems.push("TIGERIS_MODEL_BASE_URL must use https in production");
  }
  const kind = env.TIGERIS_SCANNER ?? "off", clamHost = env.TIGERIS_CLAMAV_HOST ?? "", clamPort = Number(env.TIGERIS_CLAMAV_PORT ?? 3310), clamSocket = env.TIGERIS_CLAMAV_SOCKET ?? "";
  if (!["off", "clamav", "stub"].includes(kind)) problems.push("TIGERIS_SCANNER must be off, clamav or stub");
  if (kind === "clamav" && !clamSocket && (!clamHost || !Number.isInteger(clamPort) || clamPort < 1 || clamPort > 65535)) problems.push("TIGERIS_SCANNER=clamav needs TIGERIS_CLAMAV_HOST and TIGERIS_CLAMAV_PORT, or TIGERIS_CLAMAV_SOCKET");
  if (production && kind === "stub") problems.push("TIGERIS_SCANNER=stub is not protection and is refused in production");
  if (env.TIGERIS_CLIENT_DATA_ENABLED === "true" && kind !== "clamav") problems.push("institution documents need a real malware scanner: set TIGERIS_SCANNER=clamav (decision 11)");
  const al = { enabled: env.TIGERIS_ALERTS_ENABLED === "true", transport: env.TIGERIS_ALERTS_TRANSPORT ?? "smtp", host: env.TIGERIS_SMTP_HOST ?? "", port: Number(env.TIGERIS_SMTP_PORT ?? 587), security: env.TIGERIS_SMTP_SECURITY ?? "starttls", user: env.TIGERIS_SMTP_USER || null, password: env.TIGERIS_SMTP_PASSWORD || null, from: env.TIGERIS_ALERTS_FROM ?? "", baseUrl: env.TIGERIS_WEB_BASE_URL ?? "", reminderHours: Number(env.TIGERIS_ALERTS_REMINDER_HOURS ?? 24), maxPerHour: Number(env.TIGERIS_ALERTS_MAX_PER_HOUR ?? 120) };
  if (al.enabled) {
    if (!["smtp", "log"].includes(al.transport)) problems.push("TIGERIS_ALERTS_TRANSPORT must be smtp or log");
    if (!["starttls", "tls", "none"].includes(al.security)) problems.push("TIGERIS_SMTP_SECURITY must be starttls, tls or none");
    if (al.transport === "smtp" && (!al.host || !Number.isInteger(al.port) || al.port < 1 || al.port > 65535)) problems.push("TIGERIS_SMTP_HOST and a valid TIGERIS_SMTP_PORT are required for alerts");
    if (!/^[^\s<>",;]+@[^\s<>",;]+\.[^\s<>",;]+$/.test(al.from.replace(/^.*<(.+)>$/, "$1"))) problems.push("TIGERIS_ALERTS_FROM must be an email address");
    try { new URL(al.baseUrl); } catch { problems.push("TIGERIS_WEB_BASE_URL must be the address people use to open TIGERIS"); }
    if (production && al.transport !== "smtp") problems.push("TIGERIS_ALERTS_TRANSPORT=log is not delivery and is refused in production");
    if (production && al.security === "none") problems.push("TIGERIS_SMTP_SECURITY=none is refused in production: the relay must be reached over TLS");
    if (production && al.baseUrl && !al.baseUrl.startsWith("https://")) problems.push("TIGERIS_WEB_BASE_URL must use https in production");
    if (!Number.isFinite(al.reminderHours) || al.reminderHours < 1 || al.reminderHours > 168) problems.push("TIGERIS_ALERTS_REMINDER_HOURS must be between 1 and 168");
    if (!Number.isInteger(al.maxPerHour) || al.maxPerHour < 1 || al.maxPerHour > 2000) problems.push("TIGERIS_ALERTS_MAX_PER_HOUR must be between 1 and 2000");
  }
  const backupMax = Number(env.TIGERIS_BACKUP_MAX_AGE_HOURS ?? 0);
  if (!Number.isFinite(backupMax) || backupMax < 0 || backupMax > 720) problems.push("TIGERIS_BACKUP_MAX_AGE_HOURS must be between 0 (off) and 720");
  const tick = Number(env.TIGERIS_SCHEDULER_TICK_SECONDS ?? 60);
  if (!Number.isFinite(tick) || tick < 10 || tick > 3600) problems.push("TIGERIS_SCHEDULER_TICK_SECONDS must be between 10 and 3600");
  const max = Number(env.RATE_LIMIT_PER_MINUTE ?? 600);
  if (!Number.isFinite(max) || max < 0) problems.push("RATE_LIMIT_PER_MINUTE must be a number, or 0 to turn it off");
  if (problems.length) throw new Error(`configuration refused:\n - ${problems.join("\n - ")}`);
  return {
    production, databaseUrl, institutionId, port: Number(env.PORT ?? 3000), host: env.HOST ?? "127.0.0.1", oidc: { issuer, audience, jwksUri, requireMfa, maxTokenAgeSeconds },
    alerts: al as Config["alerts"], backupMaxAgeHours: backupMax, auditAnchorKey, documentKeys: docKey ? { current: docKey, previous: docPrev } : null, checkpoint: cpDir && auditAnchorKey ? { dir: cpDir, everyHours: cpHours } : null,
    scanner: { kind: kind as Config["scanner"]["kind"], host: clamHost, port: clamPort, socket: clamSocket },
    scheduler: { enabled: env.TIGERIS_SCHEDULER_ENABLED === "true", tickSeconds: tick },
    reasoning: { provider: provider as Config["reasoning"]["provider"], model, baseUrl, apiKey },
    clientDataEnabled: env.TIGERIS_CLIENT_DATA_ENABLED === "true", metricsToken: env.METRICS_TOKEN || null, trustProxy: env.TIGERIS_TRUST_PROXY === "true", logLevel: env.LOG_LEVEL ?? "info",
    rateLimit: max === 0 ? null : { max, timeWindow: "1 minute" },
  };
}
