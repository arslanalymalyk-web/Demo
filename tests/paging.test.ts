import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import { PagingError, likePattern, type RawRecord } from "../packages/core/src/index.js";
import { createCase } from "../packages/cases/src/index.js";
import { submitDocument } from "../packages/documents/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

describe("paging helpers", () => {
  it("makes search characters literal", () => {
    expect(likePattern("50%_off")).toBe("%50\\%\\_off%");
    expect(likePattern("  a\\b ")).toBe("%a\\\\b%");
  });
  it("refuses a page marker that was not made by the system", async () => {
    const { keysetPage } = await import("../packages/core/src/index.js");
    const fake = { query: async () => ({ rows: [] }) } as never;
    for (const bad of ["not base64 json", Buffer.from("[1,2]").toString("base64url"), Buffer.from(JSON.stringify(["2026-01-01", randomUUID()])).toString("base64url"), Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000000Z", "x'; DROP TABLE cases;--"])).toString("base64url")])
      await expect(keysetPage(fake, { select: "1", from: "t", ts: "t.a", id: "t.id", limit: 10, cursor: bad })).rejects.toThrow(PagingError);
    await expect(keysetPage(fake, { select: "1", from: "t", ts: "t.a", id: "t.id", limit: 0 })).rejects.toThrow(PagingError);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });

suite("paged lists against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'P')", [id]); });
    const tokens = { ana: await addUser(owner, app, id, "ana", ["analyst"]), exe: await addUser(owner, app, id, "exe", ["executive"]), aud: await addUser(owner, app, id, "aud", ["auditor"]) };
    const pid = (sub: string) => withTenant(app, id, async c => (await c.query("SELECT id FROM principals WHERE idp_subject = $1", [sub])).rows[0].id as string);
    const ana = { id: await pid("ana"), roles: ["analyst"] };
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const get = async (who: keyof typeof tokens, url: string) => { const r = await server.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokens[who]}` } }); let body: any = null; try { body = r.json(); } catch { /* none */ } return { status: r.statusCode, body, total: r.headers["x-total-count"] as string | undefined, next: r.headers["x-next-cursor"] as string | undefined }; };
    /** Follows the page markers to the end and returns every row. */
    const all = async (who: keyof typeof tokens, url: string) => { const rows: any[] = [], sizes: number[] = []; let next: string | undefined, total: string | undefined; do { const r = await get(who, `${url}${url.includes("?") ? "&" : "?"}${next ? `cursor=${next}&` : ""}limit=50`); expect(r.status).toBe(200); rows.push(...r.body); sizes.push(r.body.length); next = r.next; total = r.total; } while (next); return { rows, sizes, total }; };
    return { id, ana, get, all, server };
  }
  const makeCases = (s: Awaited<ReturnType<typeof scene>>, n: number, over: (i: number) => { title: string; domain?: string; sensitivity?: "internal" | "restricted" }) => withTenant(app, s.id, async c => { const ids: string[] = []; for (let i = 0; i < n; i++) { const o = over(i); ids.push((await createCase(c, s.id, s.ana, { title: o.title, objective: "Decide whether this needs a response.", domain: o.domain ?? "energy", sensitivity: o.sensitivity ?? "internal" })).id); } return ids; });

  it("reads 120 cases in pages of 50 with no repeat, no gap, the right total and newest first, even when many share a timestamp", async () => {
    const s = await scene(); const ids = await makeCases(s, 120, i => ({ title: `Case number ${i}` }));
    await withTenant(app, s.id, c => c.query("UPDATE cases SET updated_at = '2026-06-01T00:00:00.123456Z' WHERE id = ANY($1::uuid[])", [ids.slice(0, 40)])); // forty rows tie exactly
    const first = await s.get("ana", "/v1/cases");
    expect(first.body).toHaveLength(50); expect(first.total).toBe("120"); expect(first.next).toBeTruthy();
    const r = await s.all("ana", "/v1/cases");
    expect(r.sizes).toEqual([50, 50, 20]); expect(r.total).toBe("120");
    expect(new Set(r.rows.map(x => x.id)).size).toBe(120);
    expect(new Set(r.rows.map(x => x.id))).toEqual(new Set(ids));
    const times = r.rows.map(x => new Date(x.updated_at).getTime()); expect(times).toEqual([...times].sort((a, b) => b - a));
    await s.server.close();
  });
  it("is not disturbed by a case added while someone reads", async () => {
    const s = await scene(); await makeCases(s, 60, i => ({ title: `Case ${i}` }));
    const p1 = await s.get("ana", "/v1/cases?limit=50"); expect(p1.next).toBeTruthy();
    await makeCases(s, 3, i => ({ title: `Late ${i}` }));
    const p2 = await s.get("ana", `/v1/cases?limit=50&cursor=${p1.next}`);
    expect(p2.body).toHaveLength(10); expect(p2.next).toBeUndefined();
    expect([...p1.body, ...p2.body].map(x => x.id).length).toBe(new Set([...p1.body, ...p2.body].map(x => x.id)).size);
    expect(p2.total).toBe("63");
    await s.server.close();
  });
  it("filters by state, domain, activity and a search word, with the total following the filter", async () => {
    const s = await scene();
    await makeCases(s, 5, i => ({ title: `Kuwait review ${i}`, domain: "energy" })); await makeCases(s, 4, i => ({ title: `Reserve check ${i}`, domain: "treasury" })); await makeCases(s, 2, () => ({ title: "100% literal_search", domain: "banking" }));
    const closed = await withTenant(app, s.id, async c => (await c.query("SELECT id FROM cases WHERE domain = 'banking' LIMIT 1")).rows[0].id as string);
    await withTenant(owner, s.id, c => c.query("UPDATE cases SET state = 'closed' WHERE id = $1", [closed]));
    expect((await s.get("ana", "/v1/cases?domain=energy")).total).toBe("5");
    expect((await s.get("ana", "/v1/cases?domain=energy,treasury")).total).toBe("9");
    expect((await s.get("ana", "/v1/cases?active=1")).total).toBe("10");
    expect((await s.get("ana", "/v1/cases?state=closed")).total).toBe("1");
    expect((await s.get("ana", "/v1/cases?q=kuwait")).total).toBe("5");
    expect((await s.get("ana", "/v1/cases?q=CASE-0001")).body.map((x: any) => x.case_key)).toEqual(["CASE-0001"]);
    expect((await s.get("ana", "/v1/cases?q=100%25%20literal")).total).toBe("2"); // a percent sign in a search is a percent sign
    expect((await s.get("ana", "/v1/cases?q=%25")).total).toBe("2");
    expect((await s.get("ana", "/v1/cases?q=nothing-like-this")).body).toEqual([]);
    await s.server.close();
  });
  it("neither lists nor counts a restricted case for someone with no part in it", async () => {
    const s = await scene(); await makeCases(s, 3, i => ({ title: `Open ${i}` })); await makeCases(s, 2, i => ({ title: `Secret ${i}`, sensitivity: "restricted" }));
    expect((await s.get("ana", "/v1/cases")).total).toBe("5");
    const exe = await s.get("exe", "/v1/cases"); expect(exe.total).toBe("3"); expect(exe.body.map((x: any) => x.title).join()).not.toMatch(/Secret/);
    expect((await s.get("exe", "/v1/cases?q=secret")).total).toBe("0");
    expect((await s.get("aud", "/v1/cases")).total).toBe("5"); // an auditor sees all
    await s.server.close();
  });
  it("refuses a bad page size, a bad filter and a forged marker", async () => {
    const s = await scene();
    for (const url of ["/v1/cases?limit=0", "/v1/cases?limit=201", "/v1/cases?limit=abc", "/v1/cases?state=nope", "/v1/cases?cursor=garbage", "/v1/documents?cursor=garbage", "/v1/evidence?cursor=garbage", "/v1/handoffs?status=nope", "/v1/memory?cursor=garbage", "/v1/scenarios/runs?cursor=garbage", "/v1/evidence?limit=abc"])
      expect((await s.get("ana", url)).status, url).toBe(400);
    await s.server.close();
  });

  it("pages documents, searches their titles, and filters by state", async () => {
    const s = await scene();
    await withTenant(app, s.id, async c => { for (let i = 0; i < 55; i++) await submitDocument(c, s.id, s.ana.id, { buffer: Buffer.from(`Document body number ${i} ${randomUUID()}`), filename: `f${i}.txt`, title: i % 5 === 0 ? `Quarterly report ${i}` : `Memo ${i}`, dataClass: "sample_dataset", rights: "Sample", clientDataEnabled: false }); });
    const r = await s.all("ana", "/v1/documents"); expect(r.sizes).toEqual([50, 5]); expect(r.total).toBe("55"); expect(new Set(r.rows.map(x => x.id)).size).toBe(55);
    expect((await s.get("ana", "/v1/documents?q=quarterly")).total).toBe("11");
    expect((await s.get("ana", "/v1/documents?q=f7.txt")).total).toBe("1"); // by file name too
    expect((await s.get("ana", "/v1/documents?status=queued")).total).toBe("55");
    expect((await s.get("ana", "/v1/documents?status=failed")).total).toBe("0");
    await s.server.close();
  });
  it("pages evidence with a source, a status, a search and a marker", async () => {
    const s = await scene(); const src = `src-${s.id.slice(0, 6)}`;
    await withTenant(owner, s.id, async c => { await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,'S','P','Agency','fake','https://p.example','approved','CC BY',true)", [s.id, src]); });
    const recs: RawRecord[] = Array.from({ length: 130 }, (_, i) => ({ externalKey: `rec-${String(i).padStart(3, "0")}${i % 10 === 0 ? "-special" : ""}`, kind: "catalog", sourceUrl: "https://p.example/x", originalAgency: "Agency", eventTime: "2026-01-01T00:00:00Z", payload: { title: `Record ${i}`, records_count: i + 1 } }));
    await runIngestion({ pool: app, institutionId: s.id, sourceKey: src, connector: { platform: "fake", async *fetchRecords() { for (const r of recs) yield r; } } as Connector, http: noNetwork });
    const r = await s.all("ana", "/v1/evidence"); expect(r.sizes).toEqual([50, 50, 30]); expect(r.total).toBe("130"); expect(new Set(r.rows.map(x => x.id)).size).toBe(130);
    expect((await s.get("ana", "/v1/evidence?q=special")).total).toBe("13");
    expect((await s.get("ana", `/v1/evidence?source=${src}&q=Record 12`)).total).toBe("11"); // 12 and 120 to 129
    expect((await s.get("ana", "/v1/evidence?status=quarantined")).total).toBe("0");
    expect((await s.get("ana", `/v1/evidence?source=nope`)).body).toEqual([]);
    await s.server.close();
  });
  it("serves the other lists as pages too", async () => {
    const s = await scene();
    for (const url of ["/v1/handoffs", "/v1/memory", "/v1/scenarios/runs"]) { const r = await s.get("ana", url); expect(r.status, url).toBe(200); expect(r.body, url).toEqual([]); expect(r.total, url).toBe("0"); }
    await s.server.close();
  });
});
