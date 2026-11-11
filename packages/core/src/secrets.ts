import { readFileSync } from "node:fs";

/** Secrets and settings may come from the environment or, for any NAME, from a file named by NAME_FILE (a mounted secret). */
export const SECRET_NAMES = ["DATABASE_URL", "DATABASE_URL_OWNER", "OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URI", "METRICS_TOKEN", "TIGERIS_INSTITUTION_ID", "TIGERIS_MODEL_API_KEY", "TIGERIS_SMTP_PASSWORD", "TIGERIS_AUDIT_ANCHOR_KEY", "TIGERIS_DOCUMENT_KEY", "TIGERIS_DOCUMENT_KEY_PREVIOUS"] as const;

export function applyFileSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_NAMES) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    if (env[name]) throw new Error(`${name} and ${name}_FILE are both set; use one`);
    let v: string;
    try { v = readFileSync(file, "utf8").trim(); } catch { throw new Error(`${name}_FILE points to ${file}, which cannot be read`); }
    if (!v) throw new Error(`${name}_FILE points to an empty file`);
    env[name] = v;
  }
}

