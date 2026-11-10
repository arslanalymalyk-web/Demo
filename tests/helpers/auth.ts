import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type pg from "pg";
import type { LightMyRequestResponse, InjectOptions } from "fastify";
import { buildServer } from "../../apps/api/src/server.js";
import { oidcVerifier } from "../../packages/identity/src/index.js";
import { withTenant } from "../../packages/ingest/src/store.js";
import { provisionPrincipal } from "../../packages/identity/src/index.js";

export const ISSUER = "https://idp.test.example", AUDIENCE = "tigeris-api";
const ROLES = ["executive", "analyst", "expert", "approver", "operations", "administrator", "auditor"];
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const keys = createLocalJWKSet({ keys: [jwk] });
export const verifier = (requireMfa = true) => oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, requireMfa }, keys);

export async function mint(sub: string, o: { amr?: string[]; issuer?: string; audience?: string; expiresIn?: string; key?: CryptoKey } = {}): Promise<string> {
  return new SignJWT({ name: `User ${sub}`, amr: o.amr ?? ["pwd", "mfa"] }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(o.issuer ?? ISSUER).setAudience(o.audience ?? AUDIENCE).setSubject(sub).setIssuedAt().setExpirationTime(o.expiresIn ?? "5m").sign(o.key ?? privateKey);
}
export const otherKey = (await generateKeyPair("RS256")).privateKey;

/** Creates the standard roles for an institution (owner role) and a principal holding the given roles. Returns its token. */
export async function addUser(owner: pg.Pool, app: pg.Pool, institutionId: string, sub: string, roles: string[]): Promise<string> {
  await withTenant(owner, institutionId, async c => { for (const r of ROLES) await c.query("INSERT INTO roles (institution_id, key, label) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING", [institutionId, r]); });
  await withTenant(app, institutionId, c => provisionPrincipal(c, institutionId, { type: "system" }, { issuer: ISSUER, subject: sub, roles }));
  return mint(sub);
}

/** A server whose inject() sends the token of a principal who holds the given roles. */
export async function testServer(owner: pg.Pool, app: pg.Pool, institutionId: string, roles = ["administrator", "analyst", "auditor"]) {
  const token = await addUser(owner, app, institutionId, `u-${Math.random().toString(36).slice(2)}`, roles);
  const server = buildServer({ pool: app, institutionId, verifier: verifier() });
  const inject = (o: string | InjectOptions): Promise<LightMyRequestResponse> => {
    const opts: InjectOptions = typeof o === "string" ? { url: o } : o;
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } } as InjectOptions);
  };
  return { server, inject, token };
}
