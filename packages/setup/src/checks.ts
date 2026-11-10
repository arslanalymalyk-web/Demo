import { readdirSync } from "node:fs";
import type pg from "pg";

export type Status = "pass" | "warn" | "fail" | "manual";
export interface Check { id: string; title: string; status: Status; detail: string }
const c = (id: string, title: string, status: Status, detail: string): Check => ({ id, title, status, detail });
const trim = (u: string) => u.replace(/\/+$/, "");

export interface IdpOptions { issuer: string; jwksUri?: string | null; webOrigin?: string | null; production: boolean; fetchImpl?: typeof fetch }

/** What can be learned about the client's identity provider from outside. The multi-factor claim and the registered redirect addresses cannot, so they are listed for a person to confirm. */
export async function checkIdentityProvider(o: IdpOptions): Promise<Check[]> {
  const f = o.fetchImpl ?? fetch, out: Check[] = [];
  const get = async (url: string, init?: RequestInit) => { const r = await f(url, { redirect: "error", signal: AbortSignal.timeout(10_000), ...init }); return r; };
  if (o.production && !o.issuer.startsWith("https://")) out.push(c("idp.https", "Issuer uses https", "fail", "Production requires an https issuer."));
  let meta: Record<string, any>;
  try {
    const r = await get(`${trim(o.issuer)}/.well-known/openid-configuration`);
    if (!r.ok) return [...out, c("idp.discovery", "Provider metadata is published", "fail", `The metadata address answered ${r.status}.`)];
    meta = await r.json() as Record<string, any>;
    out.push(c("idp.discovery", "Provider metadata is published", "pass", "OpenID discovery answered."));
  } catch { return [...out, c("idp.discovery", "Provider metadata is published", "fail", "The provider could not be reached or did not return JSON.")]; }
  out.push(trim(String(meta.issuer ?? "")) === trim(o.issuer) ? c("idp.issuer", "Issuer matches the configuration", "pass", "Tokens will carry the same issuer the API expects.") : c("idp.issuer", "Issuer matches the configuration", "fail", `The provider says its issuer is ${meta.issuer ?? "missing"}, not ${o.issuer}. Every token would be refused.`));
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    const v = meta[k];
    if (typeof v !== "string") out.push(c(`idp.${k}`, `${k.replace(/_/g, " ")} is published`, "fail", "Missing from the metadata."));
    else if (o.production && !v.startsWith("https://")) out.push(c(`idp.${k}`, `${k.replace(/_/g, " ")} uses https`, "fail", "Production requires https."));
  }
  const methods = meta.code_challenge_methods_supported;
  out.push(Array.isArray(methods) ? (methods.includes("S256") ? c("idp.pkce", "PKCE with S256", "pass", "The provider lists S256.") : c("idp.pkce", "PKCE with S256", "fail", "The provider does not list S256, which the web app requires.")) : c("idp.pkce", "PKCE with S256", "warn", "The provider does not say which challenge methods it supports. Confirm S256 is enabled for the web client."));
  const jwks = o.jwksUri || meta.jwks_uri;
  if (typeof jwks === "string") {
    if (o.jwksUri && typeof meta.jwks_uri === "string" && trim(o.jwksUri) !== trim(meta.jwks_uri)) out.push(c("idp.jwks_match", "Signing-key address matches the metadata", "warn", `Configured ${o.jwksUri}, published ${meta.jwks_uri}.`));
    try {
      const r = await get(jwks), j = await r.json() as { keys?: { kty?: string; alg?: string; use?: string }[] };
      const keys = Array.isArray(j.keys) ? j.keys : [];
      if (!r.ok || keys.length === 0) out.push(c("idp.jwks", "Signing keys are published", "fail", "The key set is empty or unreachable."));
      else if (keys.some(k => k.kty === "oct")) out.push(c("idp.jwks", "Signing keys are asymmetric", "fail", "A symmetric key is published. Symmetric keys are refused."));
      else out.push(c("idp.jwks", "Signing keys are published", "pass", `${keys.length} asymmetric key${keys.length === 1 ? "" : "s"}. The API reads the set again when a token names an unknown key.`));
    } catch { out.push(c("idp.jwks", "Signing keys are published", "fail", "The key set could not be read.")); }
  }
  if (o.webOrigin && typeof meta.token_endpoint === "string") {
    try {
      const r = await get(meta.token_endpoint, { method: "OPTIONS", headers: { origin: o.webOrigin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
      const allow = r.headers.get("access-control-allow-origin");
      out.push(allow === "*" || allow === o.webOrigin ? c("idp.cors", "Token endpoint allows the web origin", "pass", `Allowed for ${o.webOrigin}.`) : c("idp.cors", "Token endpoint allows the web origin", "fail", `The token endpoint does not allow ${o.webOrigin}. The browser cannot finish sign-in until it does.`));
    } catch { out.push(c("idp.cors", "Token endpoint allows the web origin", "warn", "The token endpoint did not answer a cross-origin check. Confirm it allows the web origin.")); }
  } else out.push(c("idp.cors", "Token endpoint allows the web origin", "manual", "Give the web origin (--web-origin) to check it. The browser calls the token endpoint directly."));
  out.push(c("idp.mfa", "Tokens carry a multi-factor claim", "manual", "Sign in as the first administrator and confirm the token has amr or acr showing multi-factor. Without it sign-in is refused."));
  out.push(c("idp.redirect", "Web address registered as a redirect", "manual", `Register ${o.webOrigin ?? "the web address"}/ as a redirect for the public client, with PKCE allowed.`));
  out.push(c("idp.rotation", "Signing-key rotation is understood", "manual", "Confirm how the provider rotates keys; the API follows the published set."));
  return out;
}

const MIGRATIONS = new URL("../../../db/migrations/", import.meta.url);
/** Is the database ready for this version: every migration applied, and the runtime role as unprivileged as it must be. */
export async function checkDatabase(owner: pg.Pool, app: pg.Pool): Promise<Check[]> {
  const out: Check[] = [];
  try {
    await owner.query("SELECT 1"); out.push(c("db.owner", "Owner role connects", "pass", "Used for migrations and set-up only."));
    const want = readdirSync(MIGRATIONS).filter(x => x.endsWith(".sql")).sort();
    const have = new Set((await owner.query("SELECT file FROM schema_migrations").catch(() => ({ rows: [] as { file: string }[] }))).rows.map(r => r.file));
    const missing = want.filter(x => !have.has(x));
    out.push(missing.length === 0 ? c("db.migrations", "Every migration is applied", "pass", `${want.length} migrations.`) : c("db.migrations", "Every migration is applied", "fail", `Not applied: ${missing.join(", ")}. Run the migrations first.`));
  } catch { out.push(c("db.owner", "Owner role connects", "fail", "The owner role could not connect.")); }
  try {
    const r = (await app.query("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user")).rows[0];
    const bad = ["rolsuper", "rolbypassrls", "rolcreaterole", "rolcreatedb"].filter(k => r[k]);
    out.push(bad.length ? c("db.app", "Runtime role is unprivileged", "fail", `The runtime role has ${bad.join(", ")}. The API refuses to start with it.`) : c("db.app", "Runtime role is unprivileged", "pass", "No superuser, no row-level-security bypass, no role or database creation."));
    const owns = (await app.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user")).rows[0].n;
    if (owns) out.push(c("db.app_owns", "Runtime role owns no tables", "fail", `It owns ${owns}. An owner can change its own table rules.`));
  } catch { out.push(c("db.app", "Runtime role connects", "fail", "The runtime role could not connect.")); }
  return out;
}
