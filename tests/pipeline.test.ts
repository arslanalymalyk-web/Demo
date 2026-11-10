import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { SourceNotApprovedError, runIngestion } from "../packages/ingest/src/pipeline.js";
import { setSourceStatus } from "../packages/ingest/src/registry.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { testServer } from "./helpers/auth.js";

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });
const fakeConnector = (records: RawRecord[]): Connector => ({ platform: "fake", async *fetchRecords() { for (const r of records) yield r; } });
const rec = (key: string, payload: Record<string, unknown> = { title: key, records_count: 5 }): RawRecord => ({ externalKey: key, kind: "catalog", sourceUrl: `https://portal.example/${key}`, originalAgency: "Example Agency", eventTime: "2026-01-01T00:00:00Z", payload });

suite("ingestion against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function institution(name: string, sourceStatus = "approved", licenceVerified = true): Promise<{ id: string; sourceKey: string }> {
    const id = randomUUID(), sourceKey = `src-${id.slice(0, 8)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,$2)", [id, name]);
      await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,'Test source','Test publisher','Example Agency','fake','https://portal.example',$3::source_status,'CC BY',$4)", [id, sourceKey, sourceStatus, licenceVerified]);
    });
    return { id, sourceKey };
  }
  const run = (i: { id: string; sourceKey: string }, records: RawRecord[]) => runIngestion({ pool: app, institutionId: i.id, sourceKey: i.sourceKey, connector: fakeConnector(records), http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
  const count = (inst: string, table: string) => withTenant(app, inst, async c => Number((await c.query(`SELECT count(*) FROM ${table}`)).rows[0].count));

  it("stores accepted records with provenance, validation runs and facts", async () => {
    const i = await institution("A");
    const r = await run(i, [rec("a"), rec("b"), rec("c")]);
    expect(r).toMatchObject({ seen: 3, inserted: 3, accepted: 3, duplicates: 0, quarantined: 0 });
    expect(await count(i.id, "validation_runs")).toBe(3);
    expect(await count(i.id, "evidence_facts")).toBe(3);
  });

  it("is idempotent, and versions a record whose content changed", async () => {
    const i = await institution("A");
    await run(i, [rec("a"), rec("b")]);
    const again = await run(i, [rec("a"), rec("b")]);
    expect(again).toMatchObject({ inserted: 0, duplicates: 2 });
    const changed = await run(i, [rec("a", { title: "a", records_count: 99 })]);
    expect(changed).toMatchObject({ inserted: 1, newVersions: 1 });
    const v = await withTenant(app, i.id, async c => (await c.query("SELECT version FROM evidence_objects WHERE external_key='a' ORDER BY version")).rows.map(x => x.version));
    expect(v).toEqual([1, 2]);
  });

  it("quarantines bad records and gives them no facts", async () => {
    const i = await institution("A");
    const r = await run(i, [rec("ok"), { ...rec("bad"), payload: {} }, { ...rec("future"), eventTime: "2030-01-01T00:00:00Z" }]);
    expect(r).toMatchObject({ accepted: 1, quarantined: 2 });
    expect(await count(i.id, "evidence_facts")).toBe(1);
  });

  it("marks records warned while the licence is unverified", async () => {
    const i = await institution("A", "approved", false);
    expect(await run(i, [rec("a")])).toMatchObject({ warned: 1, accepted: 0 });
  });

  it("refuses an unapproved source, writes nothing, and records the refusal", async () => {
    const i = await institution("A", "pending_rights");
    await expect(run(i, [rec("a")])).rejects.toBeInstanceOf(SourceNotApprovedError);
    expect(await count(i.id, "evidence_objects")).toBe(0);
    const actions = await withTenant(app, i.id, async c => (await c.query("SELECT action FROM audit_events ORDER BY seq")).rows.map(r => r.action));
    expect(actions).toEqual(["ingestion.refused"]);
  });

  it("records a failed job when the connector fails", async () => {
    const i = await institution("A");
    const broken: Connector = { platform: "fake", async *fetchRecords() { yield rec("a"); throw new Error("upstream down"); } };
    await expect(runIngestion({ pool: app, institutionId: i.id, sourceKey: i.sourceKey, connector: broken, http: noNetwork })).rejects.toThrow("upstream down");
    const job = await withTenant(app, i.id, async c => (await c.query("SELECT status, error FROM ingestion_jobs")).rows[0]);
    expect(job).toMatchObject({ status: "failed", error: "upstream down" });
  });

  it("isolates institutions from each other", async () => {
    const a = await institution("A"), b = await institution("B");
    await run(a, [rec("a1"), rec("a2")]);
    expect(await count(b.id, "evidence_objects")).toBe(0);
    expect(await count(b.id, "audit_events")).toBe(0);
    const noScope = await app.query("SELECT count(*) FROM evidence_objects");
    expect(Number(noScope.rows[0].count)).toBe(0);
    const sourceOfA = await withTenant(app, a.id, async c => (await c.query("SELECT id FROM sources")).rows[0].id);
    await expect(withTenant(app, b.id, c => c.query("INSERT INTO evidence_objects (institution_id, source_id, job_id, external_key, raw_hash, data_class, payload) VALUES ($1,$2,$2,'x','h','public_record','{}')", [a.id, sourceOfA]))).rejects.toThrow();
  });

  it("keeps evidence and audit rows immutable for the runtime role", async () => {
    const i = await institution("A"); await run(i, [rec("a")]);
    await expect(withTenant(app, i.id, c => c.query("UPDATE evidence_objects SET payload='{}'"))).rejects.toThrow();
    await expect(withTenant(app, i.id, c => c.query("DELETE FROM evidence_objects"))).rejects.toThrow();
    await expect(withTenant(app, i.id, c => c.query("UPDATE audit_events SET action='x'"))).rejects.toThrow();
    await expect(withTenant(app, i.id, c => c.query("DELETE FROM audit_events"))).rejects.toThrow();
  });

  it("audits status changes with a required reason", async () => {
    const i = await institution("A", "pending_rights");
    await expect(setSourceStatus(app, i.id, i.sourceKey, "approved", "  ")).rejects.toThrow(/reason/);
    await setSourceStatus(app, i.id, i.sourceKey, "approved", "licence confirmed", "admin-1");
    const ev = await withTenant(app, i.id, async c => (await c.query("SELECT actor_id, payload FROM audit_events WHERE action='source.status_changed'")).rows[0]);
    expect(ev.actor_id).toBe("admin-1"); expect(ev.payload).toMatchObject({ status: "approved", previous: "pending_rights", reason: "licence confirmed" });
  });

  it("serves lineage with all six provenance fields and verifies the audit chain", async () => {
    const i = await institution("A"); await run(i, [rec("a")]);
    const { inject: api } = await testServer(owner, app, i.id);
    const list = (await api("/v1/evidence")).json() as Array<{ id: string }>;
    expect(list).toHaveLength(1);
    const lin = (await api(`/v1/evidence/${list[0]!.id}/lineage`)).json();
    expect(lin.provenance.origin).toMatchObject({ publisher: "Test publisher", originalAgency: "Example Agency", recordKey: "a" });
    expect(lin.provenance.timeAndScope.retrievedAt).toBeTruthy();
    expect(lin.provenance.rightsAndVersion).toMatchObject({ licence: "CC BY", version: 1 });
    expect(lin.provenance.rightsAndVersion.rawHash).toHaveLength(64);
    expect(lin.provenance.transformation).toBe("none");
    expect(lin.provenance.confidence.validation).toBe("accepted");
    expect(lin.provenance.dataClass).toBe("public_record");
    expect(lin.facts).toHaveLength(1);
    expect((await api("/v1/audit/verify")).json()).toMatchObject({ ok: true });
    expect((await api(`/v1/evidence/${randomUUID()}/lineage`)).statusCode).toBe(404);
    expect((await api("/v1/evidence?limit=abc")).statusCode).toBe(400);
  });

  const obs = (value: number, extra: Partial<RawRecord> = {}): RawRecord => ({
    externalKey: "series:prices", kind: "observation", sourceUrl: "https://portal.example/prices", originalAgency: "Central Bank", eventTime: "2026-09-01T00:00:00.000Z",
    payload: { rowCount: 2, nullMeasures: 0, data: [{ m: "2026-08", v: 1 }, { m: "2026-09", v: value }] },
    series: { key: "prices", title: "Prices", frequency: "monthly", packs: ["energy"], maxAgeDays: 90, query: { cube: "x" } },
    facts: [{ subject: "prices|Oil=Light", predicate: "Price", value: 1, unit: "USD", validTime: "2026-08-01T00:00:00.000Z", dims: { Oil: "Light" } }, { subject: "prices|Oil=Light", predicate: "Price", value, unit: "USD", validTime: "2026-09-01T00:00:00.000Z", dims: { Oil: "Light" } }],
    ...extra });

  it("stores observations as facts tied to a series, and keeps revisions as new versions", async () => {
    const i = await institution("A");
    const first = await run(i, [obs(70)]);
    expect(first).toMatchObject({ inserted: 1, facts: 2 });
    const { inject: api } = await testServer(owner, app, i.id);
    const list = (await api("/v1/series")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ series_key: "prices", frequency: "monthly", packs: ["energy"], tracks: 1, latest_version: 1 });
    const latest1 = (await api("/v1/series/prices/latest")).json();
    expect(latest1).toHaveLength(1);
    expect(latest1[0]).toMatchObject({ value: 70, unit: "USD", version: 1 });
    // the publisher revises the latest figure: new snapshot, new version, older value stays on record
    const revised = await run(i, [obs(72)]);
    expect(revised).toMatchObject({ inserted: 1, newVersions: 1 });
    const now = (await api("/v1/series/prices/observations")).json();
    expect(now.map((r: any) => [r.validTime.slice(0, 7), r.value, r.version])).toEqual([["2026-08", 1, 2], ["2026-09", 72, 2]]);
    const all = (await api("/v1/series/prices/observations?revisions=true")).json();
    expect(all.filter((r: any) => r.validTime.startsWith("2026-09")).map((r: any) => [r.value, r.version])).toEqual([[70, 1], [72, 2]]);
    const ranged = (await api("/v1/series/prices/observations?from=2026-09-01T00:00:00Z")).json();
    expect(ranged).toHaveLength(1);
    expect((await api(`${latest1[0].lineage}`)).json().provenance.timeAndScope.eventTime).toBe("2026-09-01T00:00:00.000Z");
    expect((await api("/v1/series/missing/observations")).statusCode).toBe(404);
    expect((await api("/v1/series/prices/observations?from=yesterday")).statusCode).toBe(400);
  });

  it("lists a series built from several snapshots under different keys", async () => {
    const i = await institution("A");
    await run(i, [obs(70, { externalKey: "series:prices:2025" }), obs(71, { externalKey: "series:prices:2026" })]);
    const { inject: api } = await testServer(owner, app, i.id);
    const list = (await api("/v1/series")).json();
    expect(list).toHaveLength(1);
    expect(list[0].latest_validation).toBe("accepted");
    expect(list[0].latest_evidence_id).toBeTruthy();
  });

  it("does not show another institution's series or observations", async () => {
    const a = await institution("A"), b = await institution("B");
    await run(a, [obs(70)]);
    const { inject: other } = await testServer(owner, app, b.id);
    expect((await other("/v1/series")).json()).toEqual([]);
    expect((await other("/v1/series/prices/latest")).statusCode).toBe(404);
  });

  it("quarantines a series with no observations and stores no facts", async () => {
    const i = await institution("A");
    const r = await run(i, [obs(70, { facts: [] })]);
    expect(r).toMatchObject({ quarantined: 1, facts: 0 });
    expect(await count(i.id, "evidence_facts")).toBe(0);
  });

  it("detects a tampered audit event", async () => {
    const i = await institution("A"); await run(i, [rec("a")]);
    const { inject: api } = await testServer(owner, app, i.id);
    expect((await api("/v1/audit/verify")).json().ok).toBe(true);
    await withTenant(owner, i.id, async c => {
      await c.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable");
      await c.query("UPDATE audit_events SET payload = '{\"tampered\":true}' WHERE seq = 2");
      await c.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable");
    });
    expect((await api("/v1/audit/verify")).json()).toMatchObject({ ok: false, firstBadSeq: 2 });
  });
});
