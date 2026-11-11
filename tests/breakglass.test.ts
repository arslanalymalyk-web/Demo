import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, generateKeyPair } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { desiredConditions } from "../packages/alerts/src/conditions.js";
import { AuthError, BREAK_GLASS_ISSUER, breakGlassVerifier, generateBreakGlass, issueBreakGlassToken, withBreakGlass } from "../packages/identity/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { ISSUER, addUser, mint, verifier } from "./helpers/auth.js";

describe("emergency tokens", () => {
  const k = generateBreakGlass(), verify = breakGlassVerifier(k.publicKeyPem, ISSUER);
  const issue = (o: Partial<Parameters<typeof issueBreakGlassToken>[0]> = {}) => issueBreakGlassToken({ shareA: k.shares[0], shareB: k.shares[1], subject: "boss", actAsIssuer: ISSUER, minutes: 30, reason: "The identity provider is down", ...o });

  it("needs both shares, names an administrator, and carries its reason", async () => {
    const c = await verify(await issue());
    expect(c).toMatchObject({ issuer: ISSUER, subject: "boss", mfa: true, breakGlass: { reason: "The identity provider is down" } });
    const other = generateBreakGlass();
    await expect(issue({ shareB: other.shares[1] })).resolves.toBeTruthy(); // a wrong pair still makes a token...
    await expect(verify(await issue({ shareB: other.shares[1] }))).rejects.toBeInstanceOf(AuthError); // ...that the application refuses
    await expect(issue({ publicKeyPem: k.publicKeyPem, shareB: other.shares[1] })).rejects.toThrow(/do not make the configured key/);
    await expect(issue({ shareA: "abcd" })).rejects.toThrow(/64 hexadecimal/);
  });
  it("is short, explained and for this institution only", async () => {
    await expect(issue({ minutes: 241 })).rejects.toThrow(/between 1 and 240/);
    await expect(issue({ reason: "short" })).rejects.toThrow(/reason/);
    await expect(verify(await issue({ actAsIssuer: "https://other.example" }))).rejects.toThrow(/another institution/);
    await expect(verify(await issue({ now: new Date(Date.now() - 3 * 3600_000), minutes: 30 }))).rejects.toBeInstanceOf(AuthError); // expired
    // a token signed by someone with the right shape but another key
    const { privateKey } = await generateKeyPair("EdDSA");
    const forged = await new SignJWT({ act_as_issuer: ISSUER, reason: "A forged token for testing" }).setProtectedHeader({ alg: "EdDSA" }).setIssuer(BREAK_GLASS_ISSUER).setAudience(BREAK_GLASS_ISSUER).setSubject("boss").setJti("x").setIssuedAt().setExpirationTime("1h").sign(privateKey);
    await expect(verify(forged)).rejects.toBeInstanceOf(AuthError);
    // a four-hour limit that cannot be raised by signing a longer token with the real key
    const real = await issue({ minutes: 240 }); await expect(verify(real)).resolves.toBeTruthy();
  });
  it("is routed by issuer, so an identity-provider token never reaches it and the reverse", async () => {
    const both = withBreakGlass(verifier(), verify);
    expect((await both(await mint("ana"))).breakGlass).toBeUndefined();
    expect((await both(await issue())).breakGlass).toBeDefined();
    await expect(both("garbage")).rejects.toBeInstanceOf(AuthError);
  });
  it("is made offline by the command line, from two files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tigeris-bg-")), out = join(dir, "keys"), run = (...a: string[]) => execFileSync("node", ["--import", "tsx", "packages/identity/src/cli.ts", "break-glass", ...a], { env: { ...process.env, DATABASE_URL: "", TIGERIS_INSTITUTION_ID: "" }, encoding: "utf8" });
    run("init", "--out", out);
    const token = run("issue", "--share-1", join(out, "share-1.txt"), "--share-2", join(out, "share-2.txt"), "--subject", "boss", "--issuer", ISSUER, "--minutes", "20", "--reason", "Provider outage, drill", "--public-key", join(out, "public-key.pem")).trim();
    expect(await breakGlassVerifier(await readFile(join(out, "public-key.pem"), "utf8"), ISSUER)(token)).toMatchObject({ subject: "boss" });
    expect(() => run("issue", "--share-1", join(out, "share-1.txt"), "--subject", "boss")).toThrow();
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("emergency sign-in against the API", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });
  const k = generateBreakGlass();
  const issue = (subject: string, minutes = 30) => issueBreakGlassToken({ shareA: k.shares[0], shareB: k.shares[1], subject, actAsIssuer: ISSUER, minutes, reason: "The identity provider is down" });

  async function scene() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'B')", [id]); });
    await addUser(owner, app, id, "boss", ["administrator"]); await addUser(owner, app, id, "ana", ["analyst"]);
    const server = buildServer({ pool: app, institutionId: id, verifier: withBreakGlass(verifier(), breakGlassVerifier(k.publicKeyPem, ISSUER)) });
    const call = async (token: string, url: string, method: "GET" | "POST" = "GET", body?: unknown) => { const r = await server.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) }); let json: any = null; try { json = r.json(); } catch { /* none */ } return { status: r.statusCode, json, headers: r.headers }; };
    const events = () => withTenant(app, id, async c => (await c.query("SELECT payload FROM audit_events WHERE action = 'identity.break_glass_used'")).rows.map(r => r.payload));
    return { id, call, events };
  }

  it("signs an administrator in without the identity provider, once on the record however often it is used", async () => {
    const s = await scene(), t = await issue("boss");
    const me = await s.call(t, "/v1/identity/me");
    expect(me.status).toBe(200); expect(me.json).toMatchObject({ subject: "boss", emergencyAccess: true }); expect(me.headers["x-emergency-access"]).toBe("1");
    expect((await s.call(t, "/v1/identity/principals")).status).toBe(200); await s.call(t, "/v1/identity/me");
    const ev = await s.events(); expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ reason: "The identity provider is down" });
    expect((await s.call(await mint("boss"), "/v1/identity/me")).json.emergencyAccess).toBe(false); // an ordinary sign-in is not marked
    const alerts = await withTenant(app, s.id, c => desiredConditions(c, { auditOk: true, scanner: null }, new Date()));
    expect(alerts.map(a => a.key)).toContain("ops:break_glass");
    expect(await withTenant(app, s.id, c => desiredConditions(c, { auditOk: true, scanner: null }, new Date(Date.now() + 2 * 86_400_000))).then(a => a.map(x => x.key))).not.toContain("ops:break_glass");
  });

  it("is for administrators who exist and are active, and obeys sessions ended and the emergency stop", async () => {
    const s = await scene();
    expect((await s.call(await issue("ana"), "/v1/identity/me")).status).toBe(403); // not an administrator
    expect((await s.call(await issue("nobody"), "/v1/identity/me")).status).toBe(403); // not provisioned
    const t = await issue("boss", 30);
    expect((await s.call(t, "/v1/lockdown", "POST", { locked: true, reason: "Containing an incident" })).status).toBe(200);
    expect((await s.call(t, "/v1/sources")).status).toBe(423); // the stop applies to emergency access too
    expect((await s.call(t, "/v1/lockdown", "POST", { locked: false, reason: "Incident contained" })).status).toBe(200);
    await new Promise(r => setTimeout(r, 1100));
    expect((await s.call(await mint("boss"), "/v1/identity/revoke-all-sessions", "POST", { reason: "Ending all sessions now" })).status).toBe(200);
    expect((await s.call(t, "/v1/identity/me")).status).toBe(401); // issued before sessions were ended
  });
});
