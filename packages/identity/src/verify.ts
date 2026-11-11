import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface Claims { issuer: string; subject: string; name: string | null; mfa: boolean; issuedAt: number | null; breakGlass?: { jti: string; reason: string } }
export type TokenVerifier = (token: string) => Promise<Claims>;
export class AuthError extends Error {}

export interface OidcConfig { issuer: string; audience: string; jwksUri: string; requireMfa: boolean; maxTokenAgeSeconds: number }
/** Longest a token is honoured after the provider issued it, whatever its own expiry says. 0 turns the limit off. */
export const DEFAULT_MAX_TOKEN_AGE_SECONDS = 8 * 3600;

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv): OidcConfig | null {
  const { OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience, OIDC_JWKS_URI: jwksUri } = env;
  if (!issuer || !audience || !jwksUri) return null;
  const age = env.OIDC_MAX_TOKEN_AGE_SECONDS === undefined || env.OIDC_MAX_TOKEN_AGE_SECONDS === "" ? DEFAULT_MAX_TOKEN_AGE_SECONDS : Number(env.OIDC_MAX_TOKEN_AGE_SECONDS);
  return { issuer, audience, jwksUri, requireMfa: env.OIDC_REQUIRE_MFA_CLAIM !== "false", maxTokenAgeSeconds: Number.isFinite(age) && age >= 0 ? age : DEFAULT_MAX_TOKEN_AGE_SECONDS };
}

/** Verifies a bearer token from the institution's identity provider: signature, issuer, audience, expiry and (by default) an MFA claim.
 *  Multi-factor itself is enforced at the provider (decision K2); the claim check is a second line of defence. */
export function oidcVerifier(cfg: Pick<OidcConfig, "issuer" | "audience" | "requireMfa"> & { maxTokenAgeSeconds?: number }, keys: JWTVerifyGetKey, now: () => number = () => Date.now()): TokenVerifier {
  return async token => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: cfg.issuer, audience: cfg.audience, algorithms: ["RS256", "PS256", "ES256", "EdDSA"], clockTolerance: 30, requiredClaims: ["sub", "exp"] });
      const amr = Array.isArray(payload.amr) ? payload.amr.map(String) : [];
      const mfa = amr.includes("mfa") || amr.includes("otp") || amr.includes("hwk") || amr.includes("swk") || typeof payload.acr === "string" && /mfa|2fa|loa[2-9]/i.test(payload.acr);
      if (cfg.requireMfa && !mfa) throw new AuthError("multi-factor authentication claim missing");
      const iat = typeof payload.iat === "number" ? payload.iat : null, max = cfg.maxTokenAgeSeconds ?? 0;
      if (max > 0) {
        if (iat === null) throw new AuthError("token has no issue time");
        if (now() / 1000 - iat > max) throw new AuthError("token is older than the allowed session length; sign in again");
      }
      return { issuer: cfg.issuer, subject: String(payload.sub), name: typeof payload.name === "string" ? payload.name : null, mfa, issuedAt: iat };
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError("invalid token");
    }
  };
}

export const remoteKeys = (jwksUri: string): JWTVerifyGetKey => createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 5000, cooldownDuration: 30_000 });
