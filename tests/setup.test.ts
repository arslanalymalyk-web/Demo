import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { listPrincipals } from "../packages/identity/src/index.js";
import { verifyAuditChain } from "../packages/ingest/src/lineage.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { SetupError, bootstrap, checkDatabase, checkIdentityProvider, installationReadiness, validateInput, type BootstrapInput } from "../packages/setup/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";

const run = promisify(execFile);
const ISS = "https://idp.client.example";
const meta = (o: Record<string, unknown> = {}) => ({ issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks`, code_challenge_methods_supported: ["S256"], ...o });
function idp(over: { meta?: Record<string, unknown> | null; jwks?: unknown; cors?: string | null; status?: number } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/.well-known/openid-configuration")) return over.meta === null ? new Response("", { status: 404 }) : new Response(JSON.stringify(meta(over.meta)));
    if (url.endsWith("/jwks")) return new Response(JSON.stringify(over.jwks ?? { keys: [{ kty: "RSA", kid: "k" }] }), { status: over.status ?? 200 });
    if (url.endsWith("/token") && init?.method === "OPTIONS") return new Response(null, { status: 204, headers: over.cors ? { "access-control-allow-origin": over.cors } : {} });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}
const status = (cs: { id: string; status: string }[], id: string) => cs.find(x => x.id === id)?.status;

describe("identity provider checks", () => {
  const base = { issuer: ISS, production: true, webOrigin: "https://tigeris.client.example" };
  it("passes a correct provider and lists what only a person can confirm", async () => {
    const cs = await checkIdentityProvider({ ...base, fetchImpl: idp({ cors: "https://tigeris.client.example" }) });
    for (const id of ["idp.discovery", "idp.issuer", "idp.pkce", "idp.jwks", "idp.cors"]) expect(status(cs, id), id).toBe("pass");
    expect(["idp.mfa", "idp.redirect", "idp.rotation"].map(id => status(cs, id))).toEqual(["manual", "manual", "manual"]);
    expect(cs.some(x => x.status === "fail")).toBe(false);
  });
  it("fails on the problems that stop sign-in", async () => {
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ meta: null }) }), "idp.discovery")).toBe("fail");
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ meta: { issuer: "https://other.example" } }) }), "idp.issuer")).toBe("fail");
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ meta: { code_challenge_methods_supported: ["plain"] } }) }), "idp.pkce")).toBe("fail");
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ jwks: { keys: [] } }) }), "idp.jwks")).toBe("fail");
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ jwks: { keys: [{ kty: "oct" }] } }) }), "idp.jwks")).toBe("fail");
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ cors: null }) }), "idp.cors")).toBe("fail");
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ cors: "https://elsewhere.example" }) }), "idp.cors")).toBe("fail");
  });
  it("warns where the provider is silent and asks for the web origin when none is given", async () => {
    expect(status(await checkIdentityProvider({ ...base, fetchImpl: idp({ meta: { code_challenge_methods_supported: undefined } }) }), "idp.pkce")).toBe("warn");
    expect(status(await checkIdentityProvider({ issuer: ISS, production: true, fetchImpl: idp() }), "idp.cors")).toBe("manual");
  });
  it("requires https in production and reports an unreachable provider", async () => {
    const cs = await checkIdentityProvider({ issuer: "http://idp.client.example", production: true, fetchImpl: idp() });
    expect(status(cs, "idp.https")).toBe("fail");
    expect(status(await checkIdentityProvider({ issuer: ISS, production: false, fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch }), "idp.discovery")).toBe("fail");
    expect(status(await checkIdentityProvider({ issuer: "http://127.0.0.1:1", production: false }), "idp.discovery")).toBe("fail");
  });
});

describe("set-up input", () => {
  const ok: BootstrapInput = { name: "Client Fund", jurisdiction: "SA", issuer: ISS, admins: [{ subject: "a1" }, { subject: "a2" }] };
  it("accepts a good input and reports every problem at once", () => {
    expect(validateInput(ok)).toEqual([]);
    const p = validateInput({ name: "x", jurisdiction: "Saudi", issuer: "nonsense", institutionId: "nope", admins: [{ subject: "same" }, { subject: "same" }], auditors: [{ subject: "has space" }] });
    expect(p.join("\n")).toMatch(/name must be 2 to 120[\s\S]*institution id[\s\S]*issuer must be a URL[\s\S]*two-letter[\s\S]*not a valid identity-provider subject[\s\S]*at least two different administrators[\s\S]*only once/);
    expect(validateInput({ ...ok, admins: [{ subject: "only-one" }] }).join()).toMatch(/at least two different administrators/);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("first-run set-up against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });
  const input = (over: Partial<BootstrapInput> = {}): BootstrapInput => ({ institutionId: randomUUID(), name: "Client Fund", jurisdiction: "SA", issuer: ISS, admins: [{ subject: "a1", name: "First Admin" }, { subject: "a2" }], auditors: [{ subject: "aud" }], registryFile: null, ...over });
  const facts = { clientDataEnabled: false, scanner: { configured: false, reachable: false }, scheduler: { enabled: false }, reasoning: { provider: null }, alerts: { configured: false, transport: null }, backupMaxAgeHours: 0 };

  it("finds the database ready, and says what is missing when it is not", async () => {
    const cs = await checkDatabase(owner, app);
    expect(["db.owner", "db.migrations", "db.app"].map(id => status(cs, id))).toEqual(["pass", "pass", "pass"]);
    expect(status(await checkDatabase(app, app), "db.migrations")).toBe("fail"); // the runtime role cannot read the migration record, so it cannot stand in for the owner
    const dead = new pg.Pool({ connectionString: "postgres://x:y@127.0.0.1:1/none", connectionTimeoutMillis: 300 });
    expect(status(await checkDatabase(dead, dead), "db.owner")).toBe("fail");
    await dead.end().catch(() => undefined);
  });

  it("stands up an institution with its roles, two administrators, the default policy and the source registry", async () => {
    const i = input({ registryFile: new URL("../data/registry/sources.json", import.meta.url).pathname });
    const r = await bootstrap(owner, app, i);
    expect(r.created).toBe(true);
    expect(r.steps.map(s => `${s.step}:${s.status}`)).toEqual(["institution:done", "roles:done", "administrator: a1:done", "administrator: a2:done", "auditor: aud:done", "decision policy:done", "source registry:done"]);
    const id = r.institutionId;
    const people = await withTenant(app, id, c => listPrincipals(c));
    expect(people.map(p => `${p.subject}=${p.roles}`).sort()).toEqual(["a1=administrator", "a2=administrator", "aud=auditor"]);
    expect(people.find(p => p.subject === "a1")!.displayName).toBe("First Admin");
    expect(await withTenant(app, id, async c => (await c.query("SELECT count(*)::int AS n FROM roles")).rows[0].n)).toBe(7);
    expect(await withTenant(app, id, async c => (await c.query("SELECT count(*) FILTER (WHERE status = 'approved')::int AS ok, count(*)::int AS n FROM sources")).rows[0])).toMatchObject({ ok: 7 }); // the registry records which sources were verified; the rest wait for rights confirmation
    expect(await withTenant(app, id, async c => (await c.query("SELECT count(*)::int AS n FROM sources")).rows[0].n)).toBeGreaterThan(20);
    expect((await withTenant(app, id, c => verifyAuditChain(c))).ok).toBe(true);
    expect(await withTenant(app, id, async c => (await c.query("SELECT action FROM audit_events WHERE action = 'setup.completed'")).rowCount)).toBe(1);
  });

  it("is safe to run again: nothing is duplicated and existing people are left alone", async () => {
    const i = input(); const first = await bootstrap(owner, app, i);
    await withTenant(app, first.institutionId, c => c.query("SELECT 1"));
    const again = await bootstrap(owner, app, { ...i, name: "A different name" });
    expect(again.created).toBe(false);
    expect(again.steps.map(s => s.status)).toEqual(["already", "already", "already", "already", "already", "already", "skipped"]);
    expect(await withTenant(app, i.institutionId!, async c => (await c.query("SELECT name FROM institutions")).rows[0].name)).toBe("Client Fund");
    expect((await withTenant(app, i.institutionId!, c => listPrincipals(c)))).toHaveLength(3);
    const extended = await bootstrap(owner, app, { ...i, admins: [...i.admins, { subject: "a3" }] });
    expect(extended.steps.find(s => s.step === "administrator: a3")!.status).toBe("done");
  });

  it("does not change the roles of someone who already exists, and says so", async () => {
    const i = input(); await bootstrap(owner, app, i);
    await withTenant(app, i.institutionId!, async c => { const { setRoles } = await import("../packages/identity/src/index.js"); const p = (await listPrincipals(c)).find(x => x.subject === "aud")!; await setRoles(c, i.institutionId!, { type: "system" }, p.id, ["analyst"]); });
    const r = await bootstrap(owner, app, i);
    expect(r.steps.find(s => s.step === "auditor: aud")).toMatchObject({ status: "already", detail: expect.stringMatching(/other roles/) });
    expect((await withTenant(app, i.institutionId!, c => listPrincipals(c))).find(p => p.subject === "aud")!.roles).toEqual(["analyst"]);
  });

  it("refuses a bad input before writing anything", async () => {
    const i = input({ admins: [{ subject: "alone" }] });
    await expect(bootstrap(owner, app, i)).rejects.toThrow(SetupError);
    expect(await withTenant(owner, i.institutionId!, async c => (await c.query("SELECT 1 FROM institutions WHERE id = $1", [i.institutionId])).rowCount)).toBe(0);
  });

  it("reports what is still open after set-up, and what blocks use before it", async () => {
    const i = input({ registryFile: new URL("../data/registry/sources.json", import.meta.url).pathname }); const { institutionId: id } = await bootstrap(owner, app, i);
    const after = await withTenant(app, id, c => installationReadiness(c, facts));
    expect(after.ready).toBe(true);
    expect(["admins", "auditor", "analyst", "policy", "audit"].map(x => status(after.checks, x))).toEqual(["pass", "pass", "warn", "pass", "pass"]);
    expect(["sources", "data", "settings", "geography"].map(x => status(after.checks, x))).toEqual(["pass", "warn", "warn", "warn"]);
    expect(["client_data", "backup", "pentest", "mfa"].map(x => status(after.checks, x))).toEqual(["manual", "manual", "manual", "manual"]);

    const bare = randomUUID();
    await withTenant(owner, bare, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Bare')", [bare]); });
    const before = await withTenant(app, bare, c => installationReadiness(c, facts));
    expect(before.ready).toBe(false);
    expect(["admins", "policy", "sources"].map(x => status(before.checks, x))).toEqual(["fail", "fail", "fail"]);
    const on = await withTenant(app, id, c => installationReadiness(c, { ...facts, clientDataEnabled: true }));
    expect(status(on.checks, "scanner")).toBe("fail");
    expect((await withTenant(app, id, c => installationReadiness(c, { ...facts, clientDataEnabled: true, scanner: { configured: true, reachable: true } }))).checks.find(x => x.id === "scanner")!.status).toBe("pass");
  });

  it("serves readiness to administrators and auditors only", async () => {
    const i = input(); await bootstrap(owner, app, i); const id = i.institutionId!;
    const tokens = { adm: await addUser(owner, app, id, "adm2", ["administrator"]), ana: await addUser(owner, app, id, "ana", ["analyst"]), aud: await addUser(owner, app, id, "aud2", ["auditor"]) };
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const get = (who: keyof typeof tokens) => server.inject({ method: "GET", url: "/v1/readiness", headers: { authorization: `Bearer ${tokens[who]}` } });
    expect((await get("adm")).statusCode).toBe(200);
    expect((await get("aud")).statusCode).toBe(200);
    expect((await get("ana")).statusCode).toBe(403);
    expect((await get("adm")).json()).toMatchObject({ ready: expect.any(Boolean), checks: expect.arrayContaining([expect.objectContaining({ id: "admins" })]) });
    await server.close();
  });

  it("runs from the command line: check, apply, apply again, and a refusal", async () => {
    const id = randomUUID();
    const env = { ...process.env, DATABASE_URL_OWNER: ownerUrl!, DATABASE_URL: appUrl!, OIDC_ISSUER: "http://127.0.0.1:1", TIGERIS_INSTITUTION_ID: "" };
    const cli = (...a: string[]) => run("node", ["--import", "tsx", "packages/setup/src/cli.ts", ...a], { env }).then(r => ({ code: 0, out: r.stdout + r.stderr }), e => ({ code: e.code as number, out: String(e.stdout) + String(e.stderr) }));
    const check = await cli("check");
    expect(check.code).toBe(1); expect(check.out).toMatch(/PASS  Every migration is applied/); expect(check.out).toMatch(/FAIL  Provider metadata/);
    const refused = await cli("apply", "--name", "Client Fund", "--admin", "only-one", "--skip-sources");
    expect(refused.code).toBe(2); expect(refused.out).toMatch(/at least two different administrators/);
    const args = ["apply", "--name", "Client Fund", "--jurisdiction", "SA", "--institution-id", id, "--admin", "a1:First Admin", "--admin", "a2:Second Admin", "--skip-sources"];
    const first = await cli(...args);
    expect(first.code).toBe(0); expect(first.out).toContain(`TIGERIS_INSTITUTION_ID=${id}`); expect(first.out).toMatch(/DONE    administrator: a1/);
    const second = await cli(...args);
    expect(second.code).toBe(0); expect(second.out).toMatch(/ALREADY administrator: a1/);
    expect(await withTenant(app, id, c => listPrincipals(c))).toHaveLength(2);
  }, 90_000);
});
