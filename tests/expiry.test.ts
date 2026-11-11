import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { ISSUER, addUser, mint, verifier } from "./helpers/auth.js";

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("access that ends by itself", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'X')", [id]); });
    await addUser(owner, app, id, "boss", ["administrator"]); await addUser(owner, app, id, "aud", ["auditor"]);
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = async (who: string, method: "GET" | "POST" | "PUT", url: string, body?: unknown) => { const r = await server.inject({ method, url, headers: { authorization: `Bearer ${await mint(who)}` }, ...(body !== undefined ? { payload: body as object } : {}) }); let json: any = null; try { json = r.json(); } catch { /* none */ } return { status: r.statusCode, json }; };
    return { id, call };
  }
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  it("creates a person whose access ends, refuses them afterwards, and records every change", async () => {
    const s = await scene();
    const made = await s.call("boss", "POST", "/v1/identity/principals", { issuer: ISSUER, subject: "vendor-eng", displayName: "Vendor engineer", roles: ["auditor"], expiresAt: inHours(4) });
    expect(made.status).toBe(201); expect(made.json.expiresAt).toBeTruthy();
    expect((await s.call("vendor-eng", "GET", "/v1/identity/me")).status).toBe(200);
    // time passes: the expiry is now in the past
    await withTenant(owner, s.id, async c => { await c.query("UPDATE principals SET expires_at = now() - interval '1 minute' WHERE idp_subject = 'vendor-eng'"); });
    const gone = await s.call("vendor-eng", "GET", "/v1/identity/me");
    expect(gone.status).toBe(403); expect(gone.json.message).toBe("access has expired");
    expect((await s.call("boss", "GET", "/v1/identity/principals")).json.find((p: any) => p.subject === "vendor-eng").expiresAt).toBeTruthy();
    // an administrator can extend or remove it, with a reason; the past is refused
    const id = made.json.id as string;
    expect((await s.call("boss", "PUT", `/v1/identity/principals/${id}/expiry`, { expiresAt: inHours(-1), reason: "Trying the past" })).status).toBe(422);
    expect((await s.call("boss", "PUT", `/v1/identity/principals/${id}/expiry`, { expiresAt: inHours(2), reason: "Support call continues" })).status).toBe(200);
    expect((await s.call("vendor-eng", "GET", "/v1/identity/me")).status).toBe(200);
    expect((await s.call("boss", "PUT", `/v1/identity/principals/${id}/expiry`, { expiresAt: null, reason: "Hired as staff" })).json.expiresAt).toBeNull();
    expect((await s.call("boss", "PUT", `/v1/identity/principals/${id}/expiry`, { expiresAt: null, reason: "Already permanent" })).status).toBe(409);
    expect((await s.call("aud", "PUT", `/v1/identity/principals/${id}/expiry`, { expiresAt: inHours(1), reason: "Not my job to" })).status).toBe(403);
    const trail = await withTenant(app, s.id, async c => (await c.query("SELECT action, payload FROM audit_events WHERE action = 'identity.expiry_changed' ORDER BY seq")).rows);
    expect(trail).toHaveLength(2); expect(trail[1].payload).toMatchObject({ to: null, reason: "Hired as staff" });
    expect((await s.call("boss", "POST", "/v1/identity/principals", { issuer: ISSUER, subject: "late", roles: ["auditor"], expiresAt: inHours(-2) })).status).toBe(422);
  });

  it("lets an auditor review what a person did, and keeps expired people out of notices and pickers", async () => {
    const s = await scene();
    const v = (await s.call("boss", "POST", "/v1/identity/principals", { issuer: ISSUER, subject: "vendor", roles: ["auditor"], expiresAt: inHours(3) })).json.id as string;
    await s.call("vendor", "GET", "/v1/audit/verify"); await s.call("vendor", "GET", "/v1/identity/principals");
    expect((await s.call("aud", "GET", `/v1/identity/principals/${v}/activity`)).status).toBe(200);
    expect((await s.call("boss", "GET", `/v1/identity/principals/${v}/activity`)).status).toBe(403); // administrators manage; auditors review
    await s.call("aud", "GET", "/v1/audit/verify");
    const mine = (await s.call("aud", "GET", `/v1/identity/principals/${(await s.call("aud", "GET", "/v1/identity/me")).json.id}/activity`)).json;
    expect(mine.every((e: any) => typeof e.action === "string")).toBe(true);
    const { resolveAudience } = await import("../packages/alerts/src/conditions.js");
    expect((await withTenant(app, s.id, c => resolveAudience(c, { roles: ["auditor"], principals: [] }))).map(r => r.name).sort()).toEqual(["aud", "vendor"]);
    await withTenant(owner, s.id, async c => { await c.query("UPDATE principals SET expires_at = now() - interval '1 minute' WHERE idp_subject = 'vendor'"); });
    expect((await withTenant(app, s.id, c => resolveAudience(c, { roles: ["auditor"], principals: [] }))).map(r => r.name)).toEqual(["aud"]);
  });
});
