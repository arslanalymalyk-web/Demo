import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { AuthError, DEFAULT_MAX_TOKEN_AGE_SECONDS, oidcConfigFromEnv, oidcVerifier } from "../packages/identity/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { ISSUER, AUDIENCE, addUser, mint, verifier } from "./helpers/auth.js";

describe("how long a token is honoured", () => {
  it("refuses a token older than the allowed session length, even if its own expiry is far away", async () => {
    const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import("jose");
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "RS256", use: "sig" }] });
    const issuedAt = Math.floor(Date.now() / 1000) - 3 * 3600;
    const t = await new SignJWT({ amr: ["mfa"] }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject("a").setIssuedAt(issuedAt).setExpirationTime("30d").sign(privateKey);
    const noIat = await new SignJWT({ amr: ["mfa"] }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject("a").setExpirationTime("1h").sign(privateKey);
    const within = oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, requireMfa: true, maxTokenAgeSeconds: 4 * 3600 }, keys);
    const tooOld = oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, requireMfa: true, maxTokenAgeSeconds: 2 * 3600 }, keys);
    const off = oidcVerifier({ issuer: ISSUER, audience: AUDIENCE, requireMfa: true, maxTokenAgeSeconds: 0 }, keys);
    await expect(within(t)).resolves.toMatchObject({ issuedAt });
    await expect(tooOld(t)).rejects.toThrow(/older than the allowed session length/);
    await expect(tooOld(noIat)).rejects.toBeInstanceOf(AuthError);
    await expect(off(t)).resolves.toBeTruthy();
    await expect(off(noIat)).resolves.toMatchObject({ issuedAt: null });
  });
  it("reads the limit from configuration, eight hours by default, and ignores nonsense", () => {
    const base = { OIDC_ISSUER: "i", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://x/jwks" };
    expect(DEFAULT_MAX_TOKEN_AGE_SECONDS).toBe(28800);
    expect(oidcConfigFromEnv(base)!.maxTokenAgeSeconds).toBe(28800);
    expect(oidcConfigFromEnv({ ...base, OIDC_MAX_TOKEN_AGE_SECONDS: "600" })!.maxTokenAgeSeconds).toBe(600);
    expect(oidcConfigFromEnv({ ...base, OIDC_MAX_TOKEN_AGE_SECONDS: "0" })!.maxTokenAgeSeconds).toBe(0);
    expect(oidcConfigFromEnv({ ...base, OIDC_MAX_TOKEN_AGE_SECONDS: "-3" })!.maxTokenAgeSeconds).toBe(28800);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

suite("ending sessions", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'S')", [id]); });
    await addUser(owner, app, id, "boss", ["administrator"]); await addUser(owner, app, id, "ana", ["analyst"]);
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = async (token: string, method: "GET" | "POST", url: string, body?: unknown) => { const r = await server.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) }); let json: any = null; try { json = r.json(); } catch { /* none */ } return { status: r.statusCode, json }; };
    const pid = (sub: string) => withTenant(app, id, async c => (await c.query("SELECT id FROM principals WHERE idp_subject = $1", [sub])).rows[0].id as string);
    const audits = (action: string) => withTenant(app, id, async c => (await c.query("SELECT payload FROM audit_events WHERE action = $1", [action])).rows as { payload: any }[]);
    return { id, call, pid, audits };
  }

  it("lets an administrator end one person's sessions, and the person back in with a fresh token", async () => {
    const s = await scene(), boss = await mint("boss"), ana = await mint("ana");
    expect((await s.call(ana, "GET", "/v1/identity/me")).status).toBe(200);
    const r = await s.call(boss, "POST", `/v1/identity/principals/${await s.pid("ana")}/revoke-sessions`, { reason: "Laptop reported lost" });
    expect(r.status).toBe(200); expect(r.json.revoked).toBe(1);
    const after = await s.call(ana, "GET", "/v1/identity/me");
    expect(after.status).toBe(401); expect(after.json.message).toMatch(/session was ended/);
    expect((await s.call(boss, "GET", "/v1/identity/me")).status).toBe(200); // other people are untouched
    await sleep(1100);
    expect((await s.call(await mint("ana"), "GET", "/v1/identity/me")).status).toBe(200);
    expect((await s.audits("identity.sessions_revoked"))[0]!.payload).toMatchObject({ reason: "Laptop reported lost", people: 1 });
  });

  it("refuses a request to end sessions from someone who is not an administrator, or without a reason", async () => {
    const s = await scene(), boss = await mint("boss"), ana = await mint("ana");
    expect((await s.call(ana, "POST", `/v1/identity/principals/${await s.pid("boss")}/revoke-sessions`, { reason: "Because I can" })).status).toBe(403);
    expect((await s.call(ana, "POST", "/v1/identity/revoke-all-sessions", { reason: "Because I can" })).status).toBe(403);
    expect((await s.call(boss, "POST", `/v1/identity/principals/${await s.pid("ana")}/revoke-sessions`, { reason: "no" })).status).toBe(400);
    expect((await s.call(boss, "POST", `/v1/identity/principals/${randomUUID()}/revoke-sessions`, { reason: "A person who does not exist" })).status).toBe(404);
    expect((await s.call(ana, "GET", "/v1/identity/me")).status).toBe(200);
  });

  it("signs a person out of every device when they sign out", async () => {
    const s = await scene(), ana = await mint("ana");
    expect((await s.call(ana, "POST", "/v1/identity/me/sign-out", {})).status).toBe(200);
    expect((await s.call(ana, "GET", "/v1/identity/me")).status).toBe(401);
  });

  it("ends everyone's sessions in an emergency and records why", async () => {
    const s = await scene(), boss = await mint("boss"), ana = await mint("ana");
    const r = await s.call(boss, "POST", "/v1/identity/revoke-all-sessions", { reason: "Suspected key exposure" });
    expect(r.json.revoked).toBe(2);
    expect((await s.call(ana, "GET", "/v1/identity/me")).status).toBe(401);
    expect((await s.call(boss, "GET", "/v1/identity/me")).status).toBe(401);
    expect((await s.audits("identity.sessions_revoked_all"))[0]!.payload).toMatchObject({ reason: "Suspected key exposure", people: 2 });
  });
});

suite("signed audit checkpoints", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });
  const KEY = "k".repeat(40);

  async function scene(key: string | null = KEY) {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'C')", [id]); });
    const token = await addUser(owner, app, id, "aud", ["auditor"]); await addUser(owner, app, id, "ana", ["analyst"]);
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier(), ...(key ? { auditAnchorKey: key } : {}) });
    const call = async (t: string, method: "GET" | "POST", url: string, body?: unknown) => { const r = await server.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(body !== undefined ? { payload: body as object } : {}) }); return { status: r.statusCode, json: r.json() as any }; };
    return { id, token, call };
  }

  it("signs the head of the chain, and accepts it later while history is unchanged", async () => {
    const s = await scene();
    const cp = await s.call(s.token, "GET", "/v1/audit/checkpoint");
    expect(cp.status).toBe(200); expect(cp.json).toMatchObject({ institutionId: s.id, seq: expect.any(Number), signature: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await addUser(owner, app, s.id, "later", ["analyst"]); // more events after the checkpoint are fine
    const v = await s.call(s.token, "POST", "/v1/audit/checkpoint/verify", cp.json);
    expect(v.json).toMatchObject({ ok: true }); expect(v.json.events).toBeGreaterThan(cp.json.events);
  });

  it("detects an altered checkpoint, one from another key, a rewritten history and a cut-off history", async () => {
    const s = await scene(), cp = (await s.call(s.token, "GET", "/v1/audit/checkpoint")).json;
    expect((await s.call(s.token, "POST", "/v1/audit/checkpoint/verify", { ...cp, events: cp.events + 5 })).json).toMatchObject({ ok: false, reason: "not_signed_by_this_key" });
    const other = await scene("z".repeat(40));
    expect((await other.call(other.token, "POST", "/v1/audit/checkpoint/verify", cp)).json).toMatchObject({ ok: false });
    // A database administrator rewrites history and recomputes the chain so that it still verifies on its own.
    await withTenant(owner, s.id, async c => {
      await c.query("ALTER TABLE audit_events DISABLE TRIGGER USER");
      const rows = (await c.query("SELECT id, seq, payload FROM audit_events ORDER BY seq")).rows;
      let prev = "0".repeat(64);
      for (const r of rows) {
        const payload = JSON.stringify(r.seq === rows[0].seq ? { forged: true } : r.payload);
        prev = (await c.query("UPDATE audit_events SET payload = $2::jsonb, prev_hash = $3::text, hash = encode(digest($3::text || institution_id::text || seq::text || actor_type || COALESCE(actor_id,'') || action || COALESCE(object_type,'') || COALESCE(object_id,'') || $2::jsonb::text, 'sha256'), 'hex') WHERE id = $1 RETURNING hash", [r.id, payload, prev])).rows[0].hash;
      }
      await c.query("ALTER TABLE audit_events ENABLE TRIGGER USER");
    });
    expect((await s.call(s.token, "GET", "/v1/audit/verify")).json.ok).toBe(true); // the rewritten chain is internally consistent
    expect((await s.call(s.token, "POST", "/v1/audit/checkpoint/verify", cp)).json).toMatchObject({ ok: false, reason: "history_changed" });
  });

  it("detects a history that was cut short", async () => {
    const s = await scene(); await addUser(owner, app, s.id, "more", ["analyst"]);
    const cp = (await s.call(s.token, "GET", "/v1/audit/checkpoint")).json;
    await withTenant(owner, s.id, async c => { await c.query("ALTER TABLE audit_events DISABLE TRIGGER USER"); await c.query("DELETE FROM audit_events WHERE seq > 2"); await c.query("ALTER TABLE audit_events ENABLE TRIGGER USER"); });
    expect((await s.call(s.token, "POST", "/v1/audit/checkpoint/verify", cp)).json).toMatchObject({ ok: false, reason: "chain_shorter_than_checkpoint" });
  });

  it("is off without a key, refuses malformed input and is for auditors", async () => {
    const off = await scene(null);
    expect((await off.call(off.token, "GET", "/v1/audit/checkpoint")).status).toBe(409);
    const s = await scene();
    expect((await s.call(s.token, "POST", "/v1/audit/checkpoint/verify", { nonsense: 1 })).status).toBe(400);
    expect((await s.call(await mint("ana"), "GET", "/v1/audit/checkpoint")).status).toBe(403);
  });
});

suite("the emergency stop", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'L')", [id]); });
    await addUser(owner, app, id, "boss", ["administrator"]); await addUser(owner, app, id, "ana", ["analyst"]); await addUser(owner, app, id, "aud", ["auditor"]);
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = async (who: string, method: "GET" | "POST", url: string, body?: unknown) => { const r = await server.inject({ method, url, headers: { authorization: `Bearer ${await mint(who)}` }, ...(body !== undefined ? { payload: body as object } : {}) }); let json: any = null; try { json = r.json(); } catch { /* none */ } return { status: r.statusCode, json }; };
    return { id, call };
  }

  it("refuses everyone's ordinary work while on, keeps the investigation routes open, and ends when released", async () => {
    const s = await scene();
    expect((await s.call("ana", "GET", "/v1/sources")).status).toBe(200);
    expect((await s.call("ana", "POST", "/v1/lockdown", { locked: true, reason: "Because I can" })).status).toBe(403);
    const on = await s.call("boss", "POST", "/v1/lockdown", { locked: true, reason: "Suspected misuse of an account" });
    expect(on.status).toBe(200); expect(on.json).toMatchObject({ locked: true, reason: "Suspected misuse of an account" });
    for (const [who, url] of [["ana", "/v1/sources"], ["boss", "/v1/sources"], ["aud", "/v1/evidence"], ["boss", "/v1/evidence"]] as const) {
      const r = await s.call(who, "GET", url); expect(r.status, `${who} ${url}`).toBe(423); expect(r.json.error).toBe("locked_down");
    }
    expect((await s.call("ana", "POST", "/v1/scenarios/runs", { template: "any" })).status).toBe(423);
    for (const [who, url] of [["boss", "/v1/identity/principals"], ["aud", "/v1/audit/verify"], ["boss", "/v1/lockdown"], ["ana", "/v1/identity/me"]] as const) expect((await s.call(who, "GET", url)).status, `${who} ${url}`).toBe(200);
    expect((await s.call("boss", "POST", "/v1/lockdown", { locked: true, reason: "Already on, again" })).status).toBe(409);
    const off = await s.call("boss", "POST", "/v1/lockdown", { locked: false, reason: "Account secured, checked" });
    expect(off.json.locked).toBe(false);
    expect((await s.call("ana", "GET", "/v1/sources")).status).toBe(200);
    const actions = await withTenant(app, s.id, async c => (await c.query("SELECT action, payload FROM audit_events WHERE action LIKE 'lockdown.%' ORDER BY seq")).rows);
    expect(actions.map(a => a.action)).toEqual(["lockdown.started", "lockdown.released"]);
    expect(actions[0].payload).toMatchObject({ reason: "Suspected misuse of an account" });
  });

  it("lets an administrator end a person's access while locked, and refuses an empty reason", async () => {
    const s = await scene();
    expect((await s.call("boss", "POST", "/v1/lockdown", { locked: true, reason: "no" })).status).toBe(400);
    await s.call("boss", "POST", "/v1/lockdown", { locked: true, reason: "Containing an incident" });
    const ana = (await withTenant(app, s.id, async c => (await c.query("SELECT id FROM principals WHERE idp_subject = 'ana'")).rows[0].id)) as string;
    expect((await s.call("boss", "POST", `/v1/identity/principals/${ana}/disable`)).status).toBe(200);
  });

  it("stops the scheduler from fetching anything while on", async () => {
    const { Scheduler } = await import("../packages/scheduler/src/runner.js");
    const ran: string[] = []; let halted = true;
    const sch = new Scheduler({ pool: app, institutionId: randomUUID(), run: async k => { ran.push(k.sourceKey); }, halted: async () => halted });
    expect(await sch.tick()).toEqual({ ran: [], casesOpened: [] });
    halted = false; expect(ran).toEqual([]);
  });
});
