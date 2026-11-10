import { applyFileSecrets, SECRET_NAMES } from "../../../packages/core/src/secrets.js";

export { applyFileSecrets, SECRET_NAMES };

export interface Config {
  production: boolean; databaseUrl: string; institutionId: string; port: number; host: string;
  oidc: { issuer: string; audience: string; jwksUri: string; requireMfa: boolean };
  reasoning: { provider: "off" | "anthropic" | "openai_compatible" | "local_extractive"; model: string; baseUrl: string; apiKey: string | null };
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
  if (production) {
    for (const [k, v] of [["OIDC_ISSUER", issuer], ["OIDC_JWKS_URI", jwksUri]] as const) if (v && !v.startsWith("https://")) problems.push(`${k} must use https in production`);
    if (!requireMfa && env.TIGERIS_ALLOW_NO_MFA_CLAIM !== "true") problems.push("OIDC_REQUIRE_MFA_CLAIM=false needs TIGERIS_ALLOW_NO_MFA_CLAIM=true in production, so skipping the claim is a recorded decision");
    try { const u = new URL(databaseUrl); if (WEAK.test(decodeURIComponent(u.password)) || decodeURIComponent(u.password).length < 12) problems.push("the database password is missing, short or a known weak value"); } catch { if (databaseUrl) problems.push("DATABASE_URL is not a valid URL"); }
    if (env.TIGERIS_CLIENT_DATA_ENABLED === "true" && env.TIGERIS_CLIENT_DATA_REVIEW_DONE !== "true") problems.push("institution documents are enabled but TIGERIS_CLIENT_DATA_REVIEW_DONE is not true: decision 11 requires the client's security review first");
    if (env.METRICS_TOKEN && env.METRICS_TOKEN.length < 24) problems.push("METRICS_TOKEN must be at least 24 characters");
  }
  const provider = env.TIGERIS_REASONING_PROVIDER ?? "off", model = env.TIGERIS_MODEL_NAME ?? "", apiKey = env.TIGERIS_MODEL_API_KEY || null;
  let baseUrl = env.TIGERIS_MODEL_BASE_URL ?? "";
  if (!["off", "anthropic", "openai_compatible", "local_extractive"].includes(provider)) problems.push("TIGERIS_REASONING_PROVIDER must be off, anthropic, openai_compatible or local_extractive");
  if (provider === "anthropic" || provider === "openai_compatible") {
    if (!model) problems.push("TIGERIS_MODEL_NAME is required when a model provider is set");
    if (provider === "anthropic") { baseUrl ||= "https://api.anthropic.com"; if (!apiKey) problems.push("TIGERIS_MODEL_API_KEY (or _FILE) is required for the Claude API"); }
    else if (!baseUrl) problems.push("TIGERIS_MODEL_BASE_URL is required for an OpenAI-compatible provider");
    if (baseUrl && production && !baseUrl.startsWith("https://")) problems.push("TIGERIS_MODEL_BASE_URL must use https in production");
  }
  const max = Number(env.RATE_LIMIT_PER_MINUTE ?? 600);
  if (!Number.isFinite(max) || max < 0) problems.push("RATE_LIMIT_PER_MINUTE must be a number, or 0 to turn it off");
  if (problems.length) throw new Error(`configuration refused:\n - ${problems.join("\n - ")}`);
  return {
    production, databaseUrl, institutionId, port: Number(env.PORT ?? 3000), host: env.HOST ?? "127.0.0.1", oidc: { issuer, audience, jwksUri, requireMfa },
    reasoning: { provider: provider as Config["reasoning"]["provider"], model, baseUrl, apiKey },
    clientDataEnabled: env.TIGERIS_CLIENT_DATA_ENABLED === "true", metricsToken: env.METRICS_TOKEN || null, trustProxy: env.TIGERIS_TRUST_PROXY === "true", logLevel: env.LOG_LEVEL ?? "info",
    rateLimit: max === 0 ? null : { max, timeWindow: "1 minute" },
  };
}
