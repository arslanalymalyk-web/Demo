import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { PostgresGraph } from "../packages/graph/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });
const fake = (records: RawRecord[]): Connector => ({ platform: "fake", async *fetchRecords() { for (const r of records) yield r; } });

suite("graph store against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function institution(): Promise<{ id: string; evidenceId: string }> {
    const id = randomUUID(), sourceKey = `src-${id.slice(0, 8)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'G')", [id]);
      await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,'S','P','Agency','fake','https://p.example','approved','CC BY',true)", [id, sourceKey]);
    });
    await runIngestion({ pool: app, institutionId: id, sourceKey, connector: fake([{ externalKey: "e1", kind: "catalog", sourceUrl: "https://p.example/e1", originalAgency: "Agency", eventTime: "2026-01-01T00:00:00Z", payload: { title: "e1", records_count: 3 } }]), http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    const evidenceId = await withTenant(app, id, async c => (await c.query("SELECT id FROM evidence_objects LIMIT 1")).rows[0].id as string);
    return { id, evidenceId };
  }
  const graph = <T>(id: string, fn: (g: PostgresGraph, c: pg.PoolClient) => Promise<T>) => withTenant(app, id, c => fn(new PostgresGraph(c, id), c));
  const nodes = async (g: PostgresGraph, keys: string[]) => { for (const k of keys) await g.upsertEntity({ kind: "country", key: k, name: k }); };

  it("requires a rationale for assumed, inferred and sample links", async () => {
    const i = await institution();
    for (const linkClass of ["assumed", "inferred", "sample"] as const) {
      await expect(graph(i.id, async g => { await nodes(g, ["a", "b"]); await g.addLink({ subject: "a", predicate: "p", object: "b", linkClass }); })).rejects.toThrow();
    }
  });

  it("requires supporting evidence for observed and sourced links, checked at commit", async () => {
    const i = await institution();
    for (const linkClass of ["observed", "sourced"] as const) {
      await expect(graph(i.id, async g => { await nodes(g, ["a", "b"]); await g.addLink({ subject: "a", predicate: "p", object: "b", linkClass }); })).rejects.toThrow();
    }
    await graph(i.id, async g => { await nodes(g, ["a", "b"]); await g.addLink({ subject: "a", predicate: "p", object: "b", linkClass: "observed", evidence: [{ evidenceId: i.evidenceId, role: "supports" }] }); });
    const paths = await graph(i.id, g => g.paths("a", 1));
    expect(paths[0]!.edges[0]).toMatchObject({ linkClass: "observed", evidence: [i.evidenceId] });
  });

  it("is idempotent, and retires the old version when a link changes", async () => {
    const i = await institution();
    const [a, b, c2] = await graph(i.id, async g => {
      await nodes(g, ["a", "b"]);
      const l = { subject: "a", predicate: "p", object: "b", linkClass: "assumed" as const, rationale: "r1", params: { x: 1 } };
      return [await g.addLink(l), await g.addLink(l), await g.addLink({ ...l, params: { x: 2 } })];
    });
    expect(a).toBe(b);
    expect(c2).not.toBe(a);
    const rows = await graph(i.id, async (_g, c) => (await c.query("SELECT status, params FROM relationships ORDER BY status")).rows);
    expect(rows.map(r => r.status)).toEqual(["active", "retired"]);
    expect((await graph(i.id, g => g.paths("a", 1)))[0]!.edges[0]!.params).toEqual({ x: 2 });
  });

  it("traverses to depth three and ends on cycles", async () => {
    const i = await institution();
    const paths = await graph(i.id, async g => {
      await nodes(g, ["a", "b", "c", "d", "e"]);
      for (const [s, o] of [["a", "b"], ["b", "c"], ["c", "a"], ["c", "d"], ["d", "e"]] as const) await g.addLink({ subject: s, predicate: "p", object: o, linkClass: "assumed", rationale: "test" });
      return g.paths("a", 3);
    });
    const routes = paths.map(p => p.edges.map(e => e.to).join(">"));
    expect(routes).toEqual(["b", "b>c", "b>c>d"]); // c>a is not followed, d>e is beyond depth 3
    expect(Math.max(...paths.map(p => p.depth))).toBe(3);
  });

  it("freezes the graph into a hashed snapshot that changes only when the graph does", async () => {
    const i = await institution();
    const [s1, s2, s3] = await graph(i.id, async g => {
      await nodes(g, ["a", "b"]);
      await g.addLink({ subject: "a", predicate: "p", object: "b", linkClass: "assumed", rationale: "r" });
      const one = await g.snapshot(), two = await g.snapshot();
      await g.addLink({ subject: "b", predicate: "p", object: "a", linkClass: "assumed", rationale: "r" });
      return [one, two, await g.snapshot()];
    });
    expect(s2).toMatchObject({ id: s1.id, hash: s1.hash, created: false });
    expect(s3.hash).not.toBe(s1.hash);
    expect(s3.relationships).toBe(2);
  });

  it("isolates graphs between institutions and keeps snapshots immutable", async () => {
    const a = await institution(), b = await institution();
    await graph(a.id, async g => { await nodes(g, ["x", "y"]); await g.addLink({ subject: "x", predicate: "p", object: "y", linkClass: "assumed", rationale: "r" }); });
    expect(await graph(b.id, async (_g, c) => Number((await c.query("SELECT count(*) FROM entities")).rows[0].count))).toBe(0);
    const snap = await graph(a.id, g => g.snapshot());
    await expect(graph(a.id, async (_g, c) => { await c.query("UPDATE graph_snapshots SET entity_count = 99 WHERE id = $1", [snap.id]); })).rejects.toThrow();
  });
});
