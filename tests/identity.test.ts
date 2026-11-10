import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { AuthError, ROLE_PERMISSIONS, oidcConfigFromEnv, permissionsOf } from "../packages/identity/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { AUDIENCE, ISSUER, addUser, mint, otherKey, verifier } from "./helpers/auth.js";

describe("token verification", () => {
  const ok = async (t: string) => verifier()(t);
  it("accepts a valid token with an MFA claim", async () => {
    expect(await ok(await mint("alice"))).toMatchObject({ subject: "alice", issuer: ISSUER, mfa: true });
  });
  it("rejects wrong issuer, wrong audience, expired, forged signature and missing MFA", async () => {
    for (const t of [await mint("a", { issuer: "https://evil.example" }), await mint("a", { audience: "other" }), await mint("a", { expiresIn: "-5m" }), await mint("a", { key: otherKey }), await mint("a", { amr: ["pwd"] })]) {
      await expect(ok(t)).rejects.toBeInstanceOf(AuthError);
    }
  });
  it("rejects unsigned, malformed and symmetric-algorithm tokens", async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: "a", exp: 9999999999, amr: ["mfa"] })).toString("base64url")}.`;
    const hs = await new SignJWT({ amr: ["mfa"] }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject("a").setExpirationTime("5m").sign(new TextEncoder().encode("secret-secret-secret-secret-secret!"));
    for (const t of [none, hs, "garbage", ""]) await expect(ok(t)).rejects.toBeInstanceOf(AuthError);
  });
  it("lets the MFA claim check be switched off only by explicit configuration", async () => {
    await expect(verifier(false)(await mint("a", { amr: ["pwd"] }))).resolves.toMatchObject({ mfa: false });
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "i", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://x/jwks" })!.requireMfa).toBe(true);
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "i", OIDC_AUDIENCE: "a" })).toBeNull();
  });
});

describe("role policy", () => {
  it("gives only analysts and experts the right to run scenarios, and only the administrator identity management", () => {
    const has = (r: string, p: string) => (permissionsOf([r]) as Set<string>).has(p);
    expect(["analyst", "expert"].every(r => has(r, "scenario.run"))).toBe(true);
    expect(["executive", "approver", "operations", "administrator", "auditor"].some(r => has(r, "scenario.run"))).toBe(false);
    expect(Object.keys(ROLE_PERMISSIONS).filter(r => has(r, "identity.manage"))).toEqual(["administrator"]);
    expect(Object.keys(ROLE_PERMISSIONS).filter(r => has(r, "audit.verify")).sort()).toEqual(["auditor"]);
    expect(permissionsOf(["unknown"]).size).toBe(0);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("identity against a real database and the API", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function setup() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'I')", [id]); });
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = (token: string | null, method: string, url: string, payload?: unknown) => server.inject({ method: method as "GET", url, ...(payload ? { payload: payload as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { id, server, call, admin: await addUser(owner, app, id, "admin-1", ["administrator"]) };
  }
  const auditActions = (id: string) => withTenant(app, id, async c => (await c.query("SELECT action FROM audit_events ORDER BY seq")).rows.map(r => r.action as string));

  it("starts only when every route has an access rule, and leaves just /health open", async () => {
    const { server, call } = await setup();
    await server.ready();
    expect((await call(null, "GET", "/health")).statusCode).toBe(200);
    for (const url of ["/v1/sources", "/v1/evidence", "/v1/series", "/v1/graph/entities", "/v1/scenarios/runs", "/v1/audit/verify", "/v1/identity/me"]) {
      const r = await call(null, "GET", url);
      expect([url, r.statusCode]).toEqual([url, 401]);
      expect(r.headers["www-authenticate"]).toMatch(/Bearer/);
    }
    expect((await call("garbage", "GET", "/v1/sources")).statusCode).toBe(401);
  });

  it("refuses a valid token for someone who is not provisioned, and for a principal of another institution", async () => {
    const a = await setup(), b = await setup();
    expect((await a.call(await mint("stranger"), "GET", "/v1/sources")).json()).toMatchObject({ error: "not_provisioned" });
    expect((await b.call(a.admin, "GET", "/v1/sources")).statusCode).toBe(200); // same subject name 'admin-1' exists in b as its own principal
    const onlyA = await addUser(owner, app, a.id, "only-in-a", ["analyst"]);
    expect((await b.call(onlyA, "GET", "/v1/sources")).statusCode).toBe(403);
  });

  it("enforces role permissions and audits denials", async () => {
    const { id, call } = await setup();
    const exec = await addUser(owner, app, id, "exec", ["executive"]), analyst = await addUser(owner, app, id, "an", ["analyst"]), auditor = await addUser(owner, app, id, "au", ["auditor"]);
    expect((await call(exec, "GET", "/v1/sources")).statusCode).toBe(200);
    const denied = await call(exec, "POST", "/v1/scenarios/runs", { template: "oil-price-shock" });
    expect(denied.statusCode).toBe(403);
    expect((await call(analyst, "POST", "/v1/scenarios/runs", { template: "nope" })).statusCode).toBe(404); // allowed through, then fails on its own merits
    expect((await call(analyst, "GET", "/v1/audit/verify")).statusCode).toBe(403);
    expect((await call(auditor, "GET", "/v1/audit/verify")).statusCode).toBe(200);
    expect((await call(analyst, "GET", "/v1/identity/principals")).statusCode).toBe(403);
    expect((await call(auditor, "GET", "/v1/identity/principals")).statusCode).toBe(200);
    expect((await call(exec, "GET", "/v1/identity/me")).json()).toMatchObject({ roles: ["executive"], permissions: expect.arrayContaining(["sources.read"]) });
    expect((await auditActions(id)).filter(a => a === "identity.denied").length).toBe(3);
  });

  it("lets an administrator provision, change roles and disable, with every change audited", async () => {
    const { id, call, admin } = await setup();
    const made = await call(admin, "POST", "/v1/identity/principals", { issuer: ISSUER, subject: "bob", displayName: "Bob", roles: ["analyst"] });
    expect(made.statusCode).toBe(201);
    const bob = made.json() as { id: string };
    expect((await call(admin, "POST", "/v1/identity/principals", { issuer: ISSUER, subject: "bob", roles: [] })).statusCode).toBe(409);
    expect((await call(admin, "POST", "/v1/identity/principals", { issuer: ISSUER, subject: "x", roles: ["superuser"] })).statusCode).toBe(422);
    expect((await call(admin, "POST", "/v1/identity/principals", { subject: "x" })).statusCode).toBe(400);
    const bobTok = await mint("bob");
    expect((await call(bobTok, "GET", "/v1/scenarios/templates")).statusCode).toBe(200);
    expect((await call(admin, "PUT", `/v1/identity/principals/${bob.id}/roles`, { roles: ["executive"] })).json()).toMatchObject({ roles: ["executive"] });
    expect((await call(bobTok, "POST", "/v1/scenarios/runs", { template: "oil-price-shock" })).statusCode).toBe(403);
    expect((await call(admin, "POST", `/v1/identity/principals/${bob.id}/disable`)).json()).toMatchObject({ disabled: true });
    expect((await call(bobTok, "GET", "/v1/sources")).json()).toMatchObject({ message: "principal disabled" });
    expect((await call(admin, "POST", `/v1/identity/principals/${bob.id}/enable`)).json()).toMatchObject({ disabled: false });
    expect((await call(bobTok, "GET", "/v1/sources")).statusCode).toBe(200);
    expect((await call(admin, "PUT", `/v1/identity/principals/${randomUUID()}/roles`, { roles: [] })).statusCode).toBe(404);
    expect((await auditActions(id)).filter(a => a.startsWith("identity.") && a !== "identity.denied")).toEqual(["identity.principal_provisioned", "identity.principal_provisioned", "identity.roles_changed", "identity.principal_disabled", "identity.principal_enabled"]);
    expect((await call(await addUser(owner, app, id, "aud", ["auditor"]), "GET", "/v1/audit/verify")).json()).toMatchObject({ ok: true });
  });

  it("never lets the last active administrator be demoted or disabled", async () => {
    const { call, admin } = await setup();
    const me = (await call(admin, "GET", "/v1/identity/me")).json() as { id: string };
    expect((await call(admin, "PUT", `/v1/identity/principals/${me.id}/roles`, { roles: ["analyst"] })).statusCode).toBe(409);
    expect((await call(admin, "POST", `/v1/identity/principals/${me.id}/disable`)).statusCode).toBe(409);
    const second = (await call(admin, "POST", "/v1/identity/principals", { issuer: ISSUER, subject: "admin-2", roles: ["administrator"] })).json() as { id: string };
    expect((await call(admin, "PUT", `/v1/identity/principals/${me.id}/roles`, { roles: ["analyst"] })).statusCode).toBe(200);
    expect((await call(await mint("admin-2"), "POST", `/v1/identity/principals/${second.id}/disable`)).statusCode).toBe(409);
  });

  it("answers 422, not 500, when a scenario is requested in an institution with no graph", async () => {
    const { id, call } = await setup();
    const analyst = await addUser(owner, app, id, "runner", ["analyst"]);
    const r = await call(analyst, "POST", "/v1/scenarios/runs", { template: "oil-price-shock", baselineMonth: "2026-02" });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/seed it first/);
  });
});
