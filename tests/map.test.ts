// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { FACILITIES, PostgresGraph, seedGeography } from "../packages/graph/src/index.js";
import { articleText } from "../packages/graph/src/cli.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { MAP_EXTENT } from "../packages/sectors/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";
import geo from "../apps/web/src/geo/gulf.json" with { type: "json" };

describe("bundled geography", () => {
  const rad = (d: number) => d * Math.PI / 180, my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));
  const project = (lat: number, lon: number): [number, number] => [rad(lon - geo.extent.lonMin) * geo.radius, (my(geo.extent.latMax) - my(lat)) * geo.radius];
  it("has the same extent as the map API and projects the corners onto the view", () => {
    expect(geo.extent).toEqual(MAP_EXTENT);
    const [x0, y0] = project(geo.extent.latMax, geo.extent.lonMin), [x1, y1] = project(geo.extent.latMin, geo.extent.lonMax);
    expect([x0, y0]).toEqual([0, 0]);
    expect(x1).toBeCloseTo(geo.width, 6); expect(y1).toBeCloseTo(geo.height, 0);
  });
  it("covers the Gulf states, is small enough to ship, and names its source", () => {
    const names = geo.countries.map(c => c.name);
    for (const n of ["Saudi Arabia", "United Arab Emirates", "Kuwait", "Qatar", "Bahrain", "Oman", "Iraq", "Iran", "Yemen", "Egypt"]) expect(names).toContain(n);
    expect(JSON.stringify(geo).length).toBeLessThan(200_000);
    expect(geo.source).toMatch(/Natural Earth, public domain/);
    for (const c of geo.countries) expect(c.d.startsWith("M")).toBe(true);
  });
  it("keeps every seeded facility inside the view", () => {
    for (const f of FACILITIES) { const [x, y] = project(f.lat, f.lon); expect(x, f.key).toBeGreaterThan(0); expect(x, f.key).toBeLessThan(geo.width); expect(y, f.key).toBeGreaterThan(0); expect(y, f.key).toBeLessThan(geo.height); }
  });
});

describe("article extraction", () => {
  it("keeps only the article and refuses a page it does not recognise", () => {
    const html = "<html><nav>menu</nav><body><p>November 21, 2023</p><p>The Strait of Hormuz &amp; the flow of oil.</p><script>x()</script><p>Principal contributors:</p><p>footer</p></body></html>";
    const t = articleText(html);
    expect(t).toContain("The Strait of Hormuz & the flow of oil.");
    expect(t).not.toMatch(/menu|footer|x\(\)/);
    expect(() => articleText("<html><body>something else entirely</body></html>")).toThrow(/not recognised/);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });

suite("map data against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID(), sk = `s-${id.slice(0, 6)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Map')", [id]);
      await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,'S','P','Agency','fake','https://p.example','approved','CC BY',true)", [id, sk]);
    });
    const rec: RawRecord = { externalKey: "eia", kind: "catalog", sourceUrl: "https://p.example/eia", originalAgency: "Agency", eventTime: "2023-11-21T00:00:00Z", payload: { title: "source", records_count: 1 } };
    await runIngestion({ pool: app, institutionId: id, sourceKey: sk, connector: { platform: "fake", async *fetchRecords() { yield rec; } } as Connector, http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    const evId = await withTenant(app, id, async c => (await c.query("SELECT id FROM evidence_objects LIMIT 1")).rows[0].id as string);
    const tok = await addUser(owner, app, id, "ed", ["executive"]);
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const get = async (url: string) => { const r = await server.inject({ method: "GET", url, headers: { authorization: `Bearer ${tok}` } }); return { status: r.statusCode, body: r.json() as any }; };
    return { id, evId, get };
  }
  const seed = (id: string, ev: string | null) => withTenant(app, id, async c => { const r = await seedGeography(c, id, ev); return { ...r, snap: await new PostgresGraph(c, id).snapshot() }; });

  it("seeds the geography with sourced links that cite the stored evidence, and is idempotent", async () => {
    const s = await scene();
    const a = await seed(s.id, s.evId), b = await seed(s.id, s.evId);
    expect(a).toMatchObject({ entities: 20, links: 16 });
    expect(b.snap.hash).toBe(a.snap.hash); // seeding again changes nothing
    const m = (await s.get("/v1/map")).body;
    const by = (p: string) => m.links.filter((l: { predicate: string }) => l.predicate === p);
    expect(by("bypasses")).toHaveLength(3);
    for (const l of by("bypasses")) expect(l).toMatchObject({ linkClass: "sourced", evidence: [s.evId] });
    expect(by("bypasses").find((l: { from: string }) => l.from === "route:pipeline:east-west").params).toMatchObject({ capacityKbd: 5000, temporaryMaxKbd: 7000 });
    expect(by("terminates_at").map((l: { linkClass: string; from: string }) => `${l.from.split(":").pop()}:${l.linkClass}`).sort()).toEqual(["east-west:assumed", "goreh-jask:sourced", "uae-fujairah:sourced"]);
    expect(by("exports_via")).toHaveLength(7); expect(by("exports_via").every((l: { linkClass: string }) => l.linkClass === "inferred")).toBe(true);
    const hormuz = m.entities.find((e: { key: string }) => e.key === "chokepoint:hormuz");
    expect(hormuz.attrs.flow).toMatchObject({ kbd: 21000, year: 2022, evidenceId: s.evId });
    expect(m.entities.filter((e: { kind: string }) => e.kind === "route").length).toBe(6);
    expect(m.notes.vessels).toMatch(/No live vessel feed/);
  });

  it("writes the cited facts as assumed, and keeps the flow figure out, when the source is not stored", async () => {
    const s = await scene();
    await seed(s.id, null);
    const m = (await s.get("/v1/map")).body;
    for (const l of m.links.filter((x: { predicate: string }) => x.predicate === "bypasses")) { expect(l.linkClass).toBe("assumed"); expect(l.rationale).toMatch(/not stored yet/); expect(l.evidence).toEqual([]); }
    expect(m.entities.find((e: { key: string }) => e.key === "chokepoint:hormuz").attrs.flow).toBeUndefined();
  });

  it("marks every position as approximate and every drawn route as schematic", async () => {
    const s = await scene(); await seed(s.id, s.evId);
    const m = (await s.get("/v1/map")).body;
    for (const e of m.entities) {
      if (typeof e.attrs.lat === "number") { expect(e.attrs.positionBasis, e.key).toMatch(/Approximate position/); expect(e.attrs.lat).toBeGreaterThan(MAP_EXTENT.latMin); expect(e.attrs.lon).toBeLessThan(MAP_EXTENT.lonMax); }
      if (Array.isArray(e.attrs.path)) expect(e.attrs.pathBasis, e.key).toMatch(/Schematic/);
    }
  });

  it("returns an empty map for an institution with no geography, and keeps institutions apart", async () => {
    const a = await scene(), b = await scene();
    await seed(a.id, a.evId);
    expect((await b.get("/v1/map")).body).toMatchObject({ entities: [], links: [], producers: [] });
    expect((await a.get("/v1/map")).body.entities.length).toBeGreaterThan(15);
  });
});
