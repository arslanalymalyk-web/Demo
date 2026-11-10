import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyFileSecrets, loadConfig } from "../apps/api/src/config.js";
import { buildServer } from "../apps/api/src/server.js";
import { RateLimiter } from "../apps/api/src/ratelimit.js";
import { checkRuntimeSafety } from "../apps/api/src/startup.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

const good = { DATABASE_URL: "postgres://app:Str0ng-Passw0rd-xyz@db:5432/tigeris", TIGERIS_INSTITUTION_ID: randomUUID(), OIDC_ISSUER: "https://idp.client.example", OIDC_AUDIENCE: "tigeris-api", OIDC_JWKS_URI: "https://idp.client.example/jwks" };
const cfg = (e: Record<string, string>) => loadConfig({ ...e } as NodeJS.ProcessEnv);

describe("configuration", () => {
  it("reports every missing setting at once and refuses to start", () => {
    expect(() => cfg({})).toThrow(/DATABASE_URL is required[\s\S]*TIGERIS_INSTITUTION_ID is required[\s\S]*OIDC_ISSUER is required[\s\S]*OIDC_AUDIENCE is required[\s\S]*OIDC_JWKS_URI is required/);
    expect(() => cfg({ ...good, TIGERIS_INSTITUTION_ID: "not-a-uuid" })).toThrow(/must be a UUID/);
  });
  it("accepts a complete setup and applies safe defaults", () => {
    const c = cfg(good);
    expect(c).toMatchObject({ production: false, host: "127.0.0.1", port: 3000, clientDataEnabled: false, metricsToken: null, trustProxy: false, rateLimit: { max: 600 } });
    expect(c.oidc.requireMfa).toBe(true);
    expect(cfg({ ...good, RATE_LIMIT_PER_MINUTE: "0" }).rateLimit).toBeNull();
    expect(() => cfg({ ...good, RATE_LIMIT_PER_MINUTE: "lots" })).toThrow(/RATE_LIMIT_PER_MINUTE/);
  });
  it("holds production to a higher standard", () => {
    const prod = { ...good, TIGERIS_ENV: "production" };
    expect(cfg(prod).production).toBe(true);
    expect(() => cfg({ ...prod, OIDC_ISSUER: "http://idp.client.example" })).toThrow(/OIDC_ISSUER must use https/);
    expect(() => cfg({ ...prod, OIDC_JWKS_URI: "http://idp.client.example/jwks" })).toThrow(/OIDC_JWKS_URI must use https/);
    expect(() => cfg({ ...prod, DATABASE_URL: "postgres://app:password@db/tigeris" })).toThrow(/weak/);
    expect(() => cfg({ ...prod, DATABASE_URL: "postgres://app:short@db/tigeris" })).toThrow(/short or a known weak/);
    expect(() => cfg({ ...prod, OIDC_REQUIRE_MFA_CLAIM: "false" })).toThrow(/recorded decision/);
    expect(cfg({ ...prod, OIDC_REQUIRE_MFA_CLAIM: "false", TIGERIS_ALLOW_NO_MFA_CLAIM: "true" }).oidc.requireMfa).toBe(false);
    expect(() => cfg({ ...prod, TIGERIS_CLIENT_DATA_ENABLED: "true", TIGERIS_SCANNER: "clamav", TIGERIS_CLAMAV_HOST: "scan" })).toThrow(/security review/);
    expect(() => cfg({ ...prod, TIGERIS_CLIENT_DATA_ENABLED: "true", TIGERIS_CLIENT_DATA_REVIEW_DONE: "true" })).toThrow(/real malware scanner/);
    expect(cfg({ ...prod, TIGERIS_CLIENT_DATA_ENABLED: "true", TIGERIS_CLIENT_DATA_REVIEW_DONE: "true", TIGERIS_SCANNER: "clamav", TIGERIS_CLAMAV_HOST: "scan" }).clientDataEnabled).toBe(true);
    expect(() => cfg({ ...prod, METRICS_TOKEN: "short" })).toThrow(/at least 24/);
  });
  it("reads secrets from mounted files, trimmed, and refuses ambiguity or a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-")), f = join(dir, "db"), e = join(dir, "empty");
    writeFileSync(f, "postgres://app:Str0ng-Passw0rd-xyz@db:5432/tigeris\n"); writeFileSync(e, "  \n");
    const { DATABASE_URL: _d, ...rest } = good;
    expect(cfg({ ...rest, DATABASE_URL_FILE: f }).databaseUrl).toBe(good.DATABASE_URL);
    expect(() => cfg({ ...rest, DATABASE_URL: good.DATABASE_URL, DATABASE_URL_FILE: f })).toThrow(/both set/);
    expect(() => cfg({ ...rest, DATABASE_URL_FILE: join(dir, "nope") })).toThrow(/cannot be read/);
    expect(() => cfg({ ...rest, DATABASE_URL_FILE: e })).toThrow(/empty file/);
    const env: NodeJS.ProcessEnv = { METRICS_TOKEN_FILE: f }; applyFileSecrets(env); expect(env.METRICS_TOKEN).toContain("Str0ng");
  });
});

describe("rate limiter", () => {
  it("allows the first requests, refuses the excess with a wait time, and starts a new window", () => {
    let t = 1000; const l = new RateLimiter(2, 60_000, () => t);
    expect([l.check("a"), l.check("a")]).toEqual([0, 0]);
    expect(l.check("a")).toBe(60_000);
    t += 20_000; expect(l.check("a")).toBe(40_000);
    expect(l.check("b")).toBe(0); // another client is unaffected
    t += 41_000; expect(l.check("a")).toBe(0);
  });
  it("forgets expired clients so memory does not grow without bound", () => {
    let t = 0; const l = new RateLimiter(1, 1000, () => t);
    for (let i = 0; i < 10_050; i++) l.check(`c${i}`);
    t = 5000; l.check("new");
    expect((l as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThan(10);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("runtime safety and the HTTP surface against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  it("lets the restricted runtime role start, and refuses a role that owns tables", async () => {
    expect(await checkRuntimeSafety(app)).toEqual({ ok: true, problems: [] });
    const r = await checkRuntimeSafety(owner);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/owns \d+ table\(s\)/);
  });
  it("refuses to start when an institution table does not force row-level security", async () => {
    await owner.query("CREATE TABLE zz_probe (institution_id uuid)");
    try { const r = await checkRuntimeSafety(app); expect(r.ok).toBe(false); expect(r.problems.join(" ")).toMatch(/row-level security is not forced on: zz_probe/); }
    finally { await owner.query("DROP TABLE zz_probe"); }
    expect((await checkRuntimeSafety(app)).ok).toBe(true);
  });

  async function scene(extra: Partial<Parameters<typeof buildServer>[0]> = {}, pool = app) {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'H')", [id]); });
    const tok = await addUser(owner, app, id, "ed", ["executive"]);
    const server = buildServer({ pool, institutionId: id, verifier: verifier(), ...extra });
    return { server, tok, id, call: (url: string, o: { method?: string; payload?: unknown; headers?: Record<string, string> } = {}) => server.inject({ method: (o.method ?? "GET") as "GET", url, headers: o.headers ?? {}, ...(o.payload !== undefined ? { payload: o.payload as never } : {}) }) };
  }

  it("answers health without a database, and readiness only when the database answers", async () => {
    const s = await scene();
    expect((await s.call("/health")).json()).toEqual({ status: "ok" });
    expect((await s.call("/ready")).json()).toEqual({ status: "ready", scanner: "off" });
    const dead = new pg.Pool({ connectionString: "postgres://x:y@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
    const d = await scene({}, dead);
    expect((await d.call("/health")).statusCode).toBe(200);
    expect((await d.call("/ready")).statusCode).toBe(503);
    await dead.end().catch(() => undefined);
  });

  it("never shows internals in a server error, and gives the caller a request id to quote", async () => {
    const dead = new pg.Pool({ connectionString: "postgres://x:secret@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
    const s = await scene({}, dead);
    const r = await s.call("/v1/sources", { headers: { authorization: `Bearer ${s.tok}` } });
    expect(r.statusCode).toBe(500);
    const text = r.body;
    expect(r.json()).toMatchObject({ error: "internal", requestId: expect.any(String) });
    expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|secret|postgres|stack/i);
    expect(r.headers["x-request-id"]).toBe(r.json().requestId);
    await dead.end().catch(() => undefined);
  });

  it("echoes a well-formed request id, replaces a malformed one, and sets security headers", async () => {
    const s = await scene();
    expect((await s.call("/health", { headers: { "x-request-id": "trace-abc-12345" } })).headers["x-request-id"]).toBe("trace-abc-12345");
    const bad = (await s.call("/health", { headers: { "x-request-id": "bad id\nwith newline" } })).headers["x-request-id"] as string;
    expect(bad).toMatch(/^[0-9a-f-]{36}$/);
    const r = await s.call("/v1/identity/me", { headers: { authorization: `Bearer ${s.tok}` } });
    expect(r.headers).toMatchObject({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store", "cross-origin-resource-policy": "same-origin" });
    expect((await s.call("/health")).headers["cache-control"]).toBeUndefined();
  });

  it("limits request rates per client, but never the health checks", async () => {
    const s = await scene({ rateLimit: { max: 3, timeWindow: "1 minute" } });
    const codes: number[] = []; for (let i = 0; i < 5; i++) codes.push((await s.call("/v1/identity/me")).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    expect((await s.call("/v1/identity/me")).json()).toMatchObject({ error: "rate_limited" });
    for (let i = 0; i < 8; i++) expect((await s.call("/health")).statusCode).toBe(200);
  });

  it("rejects an oversized body with a clean message", async () => {
    const s = await scene(), ana = await addUser(owner, app, s.id, "ana", ["analyst"]);
    const r = await s.call("/v1/cases", { method: "POST", headers: { authorization: `Bearer ${ana}`, "content-type": "application/json" }, payload: JSON.stringify({ title: "x".repeat(2 * 1024 * 1024) }) });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ requestId: expect.any(String) });
  });

  it("serves metrics only with the right token, and counts refusals", async () => {
    const off = await scene();
    expect((await off.call("/metrics")).statusCode).toBe(404);
    const token = "m".repeat(32), s = await scene({ metricsToken: token });
    expect((await s.call("/metrics")).statusCode).toBe(401);
    expect((await s.call("/metrics", { headers: { authorization: "Bearer " + "x".repeat(32) } })).statusCode).toBe(401);
    await s.call("/v1/sources"); // an unauthenticated request, to be counted
    await s.call("/v1/identity/me", { headers: { authorization: `Bearer ${s.tok}` } });
    const m = await s.call("/metrics", { headers: { authorization: `Bearer ${token}` } });
    expect(m.statusCode).toBe(200);
    expect(m.headers["content-type"]).toMatch(/text\/plain/);
    expect(m.body).toMatch(/tigeris_http_request_duration_seconds_count\{method="GET",route="\/v1\/identity\/me",status="200"\} 1/);
    expect(m.body).toMatch(/tigeris_auth_failures_total\{reason="unauthorized"\} 1/);
    expect(m.body).toMatch(/tigeris_auth_failures_total\{reason="metrics_token"\} 2/);
    expect(m.body).toMatch(/tigeris_db_pool_connections\{state="total"\}/);
    expect(m.body).toMatch(/process_cpu_user_seconds_total/);
    expect(m.body).not.toMatch(/Bearer|eyJ/); // no credentials in the output
  });
});
