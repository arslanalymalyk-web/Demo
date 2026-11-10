import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { verifyExportBundle, type ExportBundle } from "../packages/retention/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";

describe("export verification", () => {
  const good = (): ExportBundle => ({ header: { format: "tigeris-case-export/1", exportedAt: "2026-01-01T00:00:00Z", exportedBy: "x", purpose: "an audit request", institutionId: "i", caseKey: "CASE-0001" }, content: { case: { a: 1, b: [1, 2] }, auditEvents: [] }, integrity: { algorithm: "", sha256: "", auditChain: { ok: true, events: 0 } } });
  it("accepts an untouched bundle, whatever the key order, and rejects any change", async () => {
    const { canonicalJson, sha256Hex } = await import("../packages/core/src/index.js");
    const b = good(); b.integrity.sha256 = sha256Hex(canonicalJson(b.content));
    expect(verifyExportBundle(b).ok).toBe(true);
    expect(verifyExportBundle({ ...b, content: { auditEvents: [], case: { b: [1, 2], a: 1 } } }).ok).toBe(true);
    expect(verifyExportBundle({ ...b, content: { ...b.content, case: { a: 2, b: [1, 2] } } })).toMatchObject({ ok: false, reason: expect.stringMatching(/changed since export/) });
    expect(verifyExportBundle({ ...b, header: { ...b.header, format: "other" as never } }).ok).toBe(false);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });

suite("retention against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID(), sk = `s-${id.slice(0, 6)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'R')", [id]);
      await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,'S','P','Agency','fake','https://p.example','approved','CC BY',true)", [id, sk]);
    });
    const rec: RawRecord = { externalKey: "e1", kind: "catalog", sourceUrl: "https://p.example/e1", originalAgency: "Agency", eventTime: "2026-01-01T00:00:00Z", payload: { title: "e1", records_count: 3 } };
    await runIngestion({ pool: app, institutionId: id, sourceKey: sk, connector: { platform: "fake", async *fetchRecords() { yield rec; } } as Connector, http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    const ev = await withTenant(app, id, async c => (await c.query("SELECT id FROM evidence_objects LIMIT 1")).rows[0].id as string);
    const tok = { ana: await addUser(owner, app, id, "ana", ["analyst"]), adm: await addUser(owner, app, id, "adm", ["administrator"]), aud: await addUser(owner, app, id, "aud", ["auditor"]), ed: await addUser(owner, app, id, "ed", ["executive"]), ben: await addUser(owner, app, id, "ben", ["analyst"]) };
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = async (who: keyof typeof tok, method: string, url: string, payload?: object) => { const r = await server.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${tok[who]}` }, ...(payload ? { payload } : {}) }); let body: any = null; try { body = r.json(); } catch { /* none */ } return { status: r.statusCode, body, headers: r.headers }; };
    const mk = async (sensitivity = "internal") => { const c = await call("ana", "POST", "/v1/cases", { title: "Retention case", objective: "Keep the record", domain: "energy", sensitivity }); await call("ana", "POST", `/v1/cases/${c.body.id}/evidence`, { evidenceId: ev }); return c.body.id as string; };
    return { id, call, mk };
  }

  it("reports every record class with its age, and says plainly that nothing is deleted", async () => {
    const s = await scene(); await s.mk();
    const r = (await s.call("aud", "GET", "/v1/retention")).body;
    expect(r.years).toBe(10);
    expect(r.classes.map((c: { key: string }) => c.key)).toEqual(["audit", "decisions", "policy_decisions", "cases", "memory", "evidence", "documents", "scenario_runs", "settings"]);
    const by = Object.fromEntries(r.classes.map((c: { key: string }) => [c.key, c]));
    expect(by.cases).toMatchObject({ records: 1, reviewDue: 0 }); expect(by.audit.records).toBeGreaterThan(2); expect(by.evidence.records).toBe(1);
    expect(by.decisions.records).toBe(0); expect(by.decisions.oldest).toBeNull();
    expect(r.deletion).toMatch(/no deletion function/);
    expect((await s.call("ana", "GET", "/v1/retention")).status).toBe(403);
  });

  it("lists records past the horizon for review, and does not touch them", async () => {
    const s = await scene(); await s.mk();
    await withTenant(owner, s.id, async c => { await c.query("ALTER TABLE cases DISABLE TRIGGER cases_guard_t"); await c.query("UPDATE cases SET created_at = now() - interval '11 years'"); await c.query("ALTER TABLE cases ENABLE TRIGGER cases_guard_t"); });
    const r = (await s.call("aud", "GET", "/v1/retention")).body, c = r.classes.find((x: { key: string }) => x.key === "cases");
    expect(c.reviewDue).toBe(1);
    expect(await withTenant(app, s.id, async cl => Number((await cl.query("SELECT count(*) FROM cases")).rows[0].count))).toBe(1);
  });

  it("lets an administrator hold a case with a reason, once, and release it, with both audited", async () => {
    const s = await scene(), id = await s.mk();
    expect((await s.call("ana", "POST", `/v1/cases/${id}/hold`, { reason: "not allowed for analysts" })).status).toBe(403);
    expect((await s.call("adm", "POST", `/v1/cases/${id}/hold`, { reason: "short" })).status).toBe(422);
    const h = await s.call("adm", "POST", `/v1/cases/${id}/hold`, { reason: "Regulator request reference 2026-114" });
    expect(h.status).toBe(201); expect(h.body).toMatchObject({ caseId: id, releasedAt: null });
    expect((await s.call("adm", "POST", `/v1/cases/${id}/hold`, { reason: "a second hold on the same case" })).status).toBe(409);
    expect((await s.call("ana", "GET", `/v1/cases/${id}`)).body.hold).toMatchObject({ reason: "Regulator request reference 2026-114" });
    expect((await s.call("aud", "GET", "/v1/retention")).body.holds).toHaveLength(1);
    expect((await s.call("adm", "POST", `/v1/cases/${id}/release`, { reason: "Regulator closed the request" })).body).toMatchObject({ releasedAt: expect.any(String) });
    expect((await s.call("adm", "POST", `/v1/cases/${id}/release`, { reason: "releasing it a second time" })).status).toBe(404);
    expect((await s.call("ana", "GET", `/v1/cases/${id}`)).body.hold).toBeNull();
    expect((await s.call("adm", "POST", `/v1/cases/${id}/hold`, { reason: "A new hold after the release" })).status).toBe(201);
    const acts = await withTenant(app, s.id, async c => (await c.query("SELECT action FROM audit_events WHERE action LIKE 'retention.%' ORDER BY seq")).rows.map(r => r.action));
    expect(acts).toEqual(["retention.hold_placed", "retention.hold_released", "retention.hold_placed"]);
    await expect(withTenant(app, s.id, c => c.query("UPDATE retention_holds SET reason = 'edited after the fact'"))).rejects.toThrow();
    await expect(withTenant(app, s.id, c => c.query("DELETE FROM retention_holds"))).rejects.toThrow();
  });

  it("exports a case as a self-checking bundle, records the export, and respects who may see the case", async () => {
    const s = await scene(), id = await s.mk();
    expect((await s.call("ana", "POST", `/v1/cases/${id}/export`, { purpose: "an audit request" })).status).toBe(403);
    expect((await s.call("aud", "POST", `/v1/cases/${id}/export`, { purpose: "short" })).status).toBe(422);
    const r = await s.call("aud", "POST", `/v1/cases/${id}/export`, { purpose: "Annual audit sample, ticket 8812" });
    expect(r.status).toBe(200);
    expect(String(r.headers["content-disposition"])).toMatch(/CASE-0001-export\.json/);
    const b = r.body as ExportBundle;
    expect(b.header).toMatchObject({ format: "tigeris-case-export/1", caseKey: "CASE-0001", purpose: "Annual audit sample, ticket 8812" });
    expect((b.content.case as { evidence: unknown[] }).evidence).toHaveLength(1);
    expect(b.content.auditEvents.length).toBeGreaterThanOrEqual(2);
    expect(b.integrity.auditChain.ok).toBe(true);
    expect(verifyExportBundle(JSON.parse(JSON.stringify(b)))).toMatchObject({ ok: true });
    const tampered = JSON.parse(JSON.stringify(b)); tampered.content.case.title = "Changed"; expect(verifyExportBundle(tampered).ok).toBe(false);
    const rec = (await s.call("aud", "GET", "/v1/retention")).body.exports;
    expect(rec).toHaveLength(1); expect(rec[0]).toMatchObject({ sha256: b.integrity.sha256, purpose: "Annual audit sample, ticket 8812" });
    const exp = await withTenant(app, s.id, async c => (await c.query("SELECT payload FROM audit_events WHERE action = 'retention.exported'")).rows[0].payload);
    expect(exp).toMatchObject({ caseKey: "CASE-0001", sha256: b.integrity.sha256 });
  });

  it("will not export a restricted case to someone who is not part of it, but lets an auditor", async () => {
    const s = await scene(), id = await s.mk("restricted");
    expect((await s.call("adm", "POST", `/v1/cases/${id}/export`, { purpose: "an administrator without a part in it" })).status).toBe(404);
    expect((await s.call("aud", "POST", `/v1/cases/${id}/export`, { purpose: "an auditor may read restricted cases" })).status).toBe(200);
    expect((await s.call("adm", "POST", `/v1/cases/${id}/hold`, { reason: "a hold needs no access to the content" })).status).toBe(201);
  });

  it("gives the runtime role no way to delete records, apart from reassigning a person's roles", async () => {
    const rows = (await owner.query("SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'tigeris_app' AND privilege_type = 'DELETE' AND table_schema = 'public' ORDER BY 1")).rows.map(r => r.table_name);
    expect(rows).toEqual(["principal_roles"]);
    const truncate = (await owner.query("SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'tigeris_app' AND privilege_type = 'TRUNCATE'")).rows[0].n;
    expect(truncate).toBe(0);
  });
});
