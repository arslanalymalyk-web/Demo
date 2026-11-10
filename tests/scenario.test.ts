import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { PostgresGraph } from "../packages/graph/src/index.js";
import { testServer } from "./helpers/auth.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { avgDecay, backtest, createRun, endDecay, getRun, gulf, hormuzShock, replayRun, resolveParams, runScenario, simulate, TEMPLATES, type Baseline } from "../packages/scenario/src/index.js";

const ref = (subject: string, value: number) => ({ evidenceId: "00000000-0000-0000-0000-000000000001", subject, validTime: "2026-02-01T00:00:00.000Z", value, validation: "accepted" });
const baseline = (): Baseline => ({
  month: "2026-02", priceUsd: 100, priceRef: ref("brent", 100), reservesMillionSar: 3750000, reservesRef: ref("res", 3750000),
  countries: [
    { code: "SA", name: "A", exportsKbd: 7000, productionKbd: 10000, hormuzShare: 0.5, spareBypassKbd: 1000, linkClass: "sourced", refs: [ref("sa", 7000)] },
    { code: "KW", name: "B", exportsKbd: 2000, productionKbd: 2500, hormuzShare: 1, spareBypassKbd: 0, linkClass: "sourced", refs: [ref("kw", 2000)] },
  ],
});
const get = (ms: ReturnType<typeof simulate>, h: string, m: string) => ms.find(x => x.horizon === h && x.metric === m)!.value;

describe("scenario calculators", () => {
  it("decay averages match closed forms", () => {
    expect(endDecay(60, 60)).toBeCloseTo(0.5, 12);
    expect(avgDecay(60, 60)).toBeCloseTo((1 - 0.5) / Math.LN2, 12);
    expect(avgDecay(1e-9, 60)).toBeCloseTo(1, 6);
  });

  it("computes the Hormuz template by hand-checkable arithmetic", () => {
    const b = baseline(), t = TEMPLATES["hormuz-transit-restriction"]!;
    const v = Object.fromEntries(Object.entries(resolveParams(t.key, { restrictionPct: 1, rerouteEfficiency: 1, durationDays: 30 }, 10)).map(([k, x]) => [k, x.value]));
    const s = hormuzShock(b, v);
    expect(s.lostKbd).toEqual({ SA: 2500, KW: 2000 });  // 7000*0.5*1-1000 ; 2000*1*1-0
    expect(s.peakPremium).toBeCloseTo(4500 / 100000 * 10, 12); // 0.45
    const ms = simulate(gulf(b), s);
    expect(get(ms, "72h", "lost_supply_kbd")).toBe(4500);
    const avg = 100 * (1 + 0.45 * avgDecay(3, 60));
    expect(get(ms, "72h", "brent_avg_usd")).toBeCloseTo(avg, 9);
    // KW 72h: (2000*1000*3 - 2000*1000*3) * price = 0 volume shipped, so revenue delta is minus baseline revenue
    expect(get(ms, "72h", "revenue_delta_musd:KW")).toBeCloseTo(-(2000 * 1000 * 3 * 100) / 1e6, 6);
    // 5y: loss only lasts 30 days
    const h = 1825, scnSa = (7000 * 1000 * h - 2500 * 1000 * 30) * (100 * (1 + 0.45 * avgDecay(h, 60))) / 1e6;
    expect(get(ms, "5y", "revenue_delta_musd:SA")).toBeCloseTo(scnSa - 7000 * 1000 * h * 100 / 1e6, 6);
  });

  it("price shock changes price only, and a Gulf producer with no Hormuz loss gains from a rise", () => {
    const b = baseline(), t = TEMPLATES["oil-price-shock"]!;
    const v = Object.fromEntries(Object.entries(resolveParams(t.key, { priceShockPct: 20 }, null)).map(([k, x]) => [k, x.value]));
    const ms = t.compute(b, v);
    expect(get(ms, "72h", "lost_supply_kbd")).toBe(0);
    expect(get(ms, "72h", "revenue_delta_musd:SA")).toBeGreaterThan(0);
    expect(get(ms, "1y", "brent_end_usd")).toBeLessThan(get(ms, "72h", "brent_end_usd")); // premium fades
    expect(get(ms, "1y", "brent_end_usd")).toBeGreaterThan(100);
  });

  it("never lets restriction exceed what bypass can offset into a negative loss", () => {
    const b = baseline();
    const ps = resolveParams("hormuz-transit-restriction", { restrictionPct: 0.1 }, 10);
    const s = hormuzShock(b, Object.fromEntries(Object.entries(ps).map(([k, x]) => [k, x.value])));
    expect(s.lostKbd.SA).toBe(0);
  });

  it("rejects unknown templates, unknown parameters and non-finite values", () => {
    expect(() => resolveParams("nope", {}, null)).toThrow(/unknown scenario template/);
    expect(() => resolveParams("oil-price-shock", { bogus: 1 }, null)).toThrow(/unknown parameter/);
    expect(() => resolveParams("oil-price-shock", { priceShockPct: NaN }, null)).toThrow(/finite/);
  });

  it("is deterministic, with sensitivity and bands around every metric", () => {
    const b = baseline(), ps = resolveParams("hormuz-transit-restriction", {}, null), today = new Date("2026-03-01T00:00:00Z");
    const a = runScenario("hormuz-transit-restriction", b, ps, today), c = runScenario("hormuz-transit-restriction", b, ps, today);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    for (const m of a.metrics) { const bd = a.bands[`${m.horizon}|${m.metric}`]!; expect(bd.low).toBeLessThanOrEqual(m.value + 1e-9); expect(bd.high).toBeGreaterThanOrEqual(m.value - 1e-9); }
    expect(a.bands["72h|lost_supply_kbd"]!.low).toBeGreaterThanOrEqual(0);
    expect(a.sensitivity.map(s => s.param)).not.toContain("usdPerSar"); // fixed parameter has no range
  });

  it("reports low confidence when inputs are assumed, warned or old, and says why", () => {
    const b = baseline(); b.priceRef!.validation = "warned";
    const out = runScenario("hormuz-transit-restriction", b, resolveParams("hormuz-transit-restriction", {}, null), new Date("2026-11-10T00:00:00Z"));
    expect(out.confidence.level).toBe("low");
    expect(out.confidence.basis.assumedShare).toBeGreaterThan(0.8);
    expect(out.confidence.notes.join(" ")).toMatch(/warned/);
    expect(out.confidence.notes.join(" ")).toMatch(/days old/);
  });
});

describe("episode back-test", () => {
  it("fits through the origin and labels itself in-sample", () => {
    const t = backtest("2026-02", 100, 100000, [{ month: "a", lostKbd: 1000, observedPrice: 110 }, { month: "b", lostKbd: 2000, observedPrice: 120 }]);
    expect(t.flexibility).toBeCloseTo(10, 9); // premium = 10 x share exactly
    expect(t.meanAbsError).toBeCloseTo(0, 9);
    expect(t.basis).toBe("in-sample calibration");
    expect(t.statement).toMatch(/not how well it predicts/);
  });
  it("returns no flexibility when there is no loss or the price fell", () => {
    expect(backtest("m", 100, 100000, [{ month: "a", lostKbd: 0, observedPrice: 100 }]).flexibility).toBeNull();
    expect(backtest("m", 100, 100000, [{ month: "a", lostKbd: 1000, observedPrice: 90 }]).flexibility).toBeNull();
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });
const months = ["2026-02", "2026-03", "2026-04", "2026-05"];
const seriesRecs = (key: string, subject: string, predicate: string, unit: string, vals: number[]): RawRecord => ({
  externalKey: `series:${key}:${subject}`, kind: "observation", sourceUrl: "https://p.example/x", originalAgency: "Agency", eventTime: "2026-06-01T00:00:00Z", payload: { subject },
  series: { key, title: key, frequency: "monthly", packs: [], query: {} },
  facts: vals.map((v, i) => ({ subject, predicate, value: v, unit, validTime: `${months[i]}-01T00:00:00Z`, dims: {}, unitStated: true })),
});

suite("scenario runs against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function institution(): Promise<string> {
    const id = randomUUID(), jodi = `j-${id.slice(0, 6)}`, imf = `i-${id.slice(0, 6)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'S')", [id]);
      for (const [k, n] of [[jodi, "jodi"], [imf, "imf"]]) await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,$3,'P','Agency','fake','https://p.example','approved','CC BY',true)", [id, k, n]);
    });
    const recs = (rs: RawRecord[]): Connector => ({ platform: "fake", async *fetchRecords() { for (const r of rs) yield r; } });
    const countries = [["SA", [7000, 5000, 4000, 3500]], ["KW", [2000, 1000, 800, 700]]] as const;
    const jr: RawRecord[] = countries.flatMap(([code, ex]) => [seriesRecs("jodi-gulf-crude-monthly", `jodi-gulf-crude-monthly|country=${code}|flow=TOTEXPSB`, "Total exports", "thousand barrels per day", [...ex]), seriesRecs("jodi-gulf-crude-monthly", `jodi-gulf-crude-monthly|country=${code}|flow=INDPROD`, "Indigenous production", "thousand barrels per day", ex.map(x => x * 1.3))]);
    await runIngestion({ pool: app, institutionId: id, sourceKey: jodi, connector: recs(jr), http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    await runIngestion({ pool: app, institutionId: id, sourceKey: imf, connector: recs([seriesRecs("imf-commodity-prices-monthly", "imf-commodity-prices-monthly|commodity=POILBRE", "Price", "US$ per barrel", [70, 100, 105, 106])]), http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    await withTenant(app, id, async c => {
      const g = new PostgresGraph(c, id);
      await g.upsertEntity({ kind: "chokepoint", key: "chokepoint:hormuz", name: "H" });
      for (const code of ["SA", "KW"]) {
        await g.upsertEntity({ kind: "country", key: `country:${code}`, name: code, attrs: { code, exportsSubject: `jodi-gulf-crude-monthly|country=${code}|flow=TOTEXPSB`, productionSubject: `jodi-gulf-crude-monthly|country=${code}|flow=INDPROD` } });
        await g.addLink({ subject: "chokepoint:hormuz", predicate: "constrains_exports_of", object: `country:${code}`, linkClass: "assumed", rationale: "test placeholder", params: { hormuzShare: code === "SA" ? 0.5 : 1, spareBypassKbd: code === "SA" ? 1000 : 0 } });
      }
    });
    return id;
  }
  const tx = <T>(id: string, fn: (c: pg.PoolClient) => Promise<T>) => withTenant(app, id, fn);

  it("stores an immutable run with lineage, bands and an audit event, and replays it exactly", async () => {
    const id = await institution();
    const today = new Date("2026-06-15T00:00:00Z");
    const run = await tx(id, c => createRun(c, id, { templateKey: "hormuz-transit-restriction", baselineMonth: "2026-02", createdBy: "tester", today }));
    expect(run.baseline.countries.map(c => c.code).sort()).toEqual(["KW", "SA"]);
    expect(run.params.priceFlexibility!.basis).toBe("calibrated");
    const stored = await tx(id, c => getRun(c, run.id)) as { results: { lineage: { evidence: string[]; band: unknown } }[]; manifestHash: string };
    expect(stored.manifestHash).toBe(run.manifestHash);
    expect(stored.results.length).toBe(run.metrics.length);
    expect(stored.results[0]!.lineage.evidence.length).toBeGreaterThan(0);
    const replay = await tx(id, c => replayRun(c, run.id));
    expect(replay).toMatchObject({ manifestMatches: true, resultsMatch: true, storedRowsMatch: true });
    const aud = await tx(id, async c => (await c.query("SELECT payload FROM audit_events WHERE action = 'scenario.run'")).rows);
    expect(aud).toHaveLength(1);
    await expect(tx(id, async c => { await c.query("UPDATE scenario_results SET value = 0 WHERE run_id = $1", [run.id]); })).rejects.toThrow();
    await expect(tx(id, async c => { await c.query("DELETE FROM scenario_runs WHERE id = $1", [run.id]); })).rejects.toThrow();
  });

  it("changes the manifest hash when an assumption changes, and keeps a run's own inputs when new data arrives", async () => {
    const id = await institution(), today = new Date("2026-06-15T00:00:00Z");
    const a = await tx(id, c => createRun(c, id, { templateKey: "hormuz-transit-restriction", baselineMonth: "2026-02", createdBy: "t", today }));
    const b = await tx(id, c => createRun(c, id, { templateKey: "hormuz-transit-restriction", baselineMonth: "2026-02", overrides: { restrictionPct: 0.9 }, createdBy: "t", today }));
    const a2 = await tx(id, c => createRun(c, id, { templateKey: "hormuz-transit-restriction", baselineMonth: "2026-02", createdBy: "t", today }));
    expect(b.manifestHash).not.toBe(a.manifestHash);
    expect(a2.manifestHash).toBe(a.manifestHash);
    expect(a2.resultsHash).toBe(a.resultsHash);
  });

  it("refuses to run without a graph, and keeps institutions apart", async () => {
    const id = await institution(), other = await institution();
    await expect(tx(id, async c => { await c.query("UPDATE relationships SET status='retired'"); return createRun(c, id, { templateKey: "oil-price-shock", baselineMonth: "2026-02", createdBy: "t" }); })).rejects.toThrow(/seed it first/);
    const run = await tx(other, c => createRun(c, other, { templateKey: "oil-price-shock", baselineMonth: "2026-02", createdBy: "t" }));
    expect(await tx(id, c => getRun(c, run.id))).toBeNull();
  });

  it("serves the graph, runs and replay over the API with clear errors", async () => {
    const id = await institution(), { inject: api } = await testServer(owner, app, id);
    expect((await api("/v1/scenarios/templates")).json().map((t: { key: string }) => t.key).sort()).toEqual(["export-revenue-gdp", "hormuz-transit-restriction", "oil-price-shock", "production-curtailment", "reserve-asset-stress", "reserve-runway"]);
    const paths = (await api("/v1/graph/entities/chokepoint:hormuz/paths?depth=2")).json() as { depth: number }[];
    expect(paths.length).toBe(2);
    expect((await api("/v1/graph/entities/nope/paths")).statusCode).toBe(404);
    expect((await api("/v1/graph/entities/chokepoint:hormuz/paths?depth=99")).statusCode).toBe(400);
    expect((await api({ method: "POST", url: "/v1/scenarios/runs", payload: { template: "nope" } })).statusCode).toBe(404);
    expect((await api({ method: "POST", url: "/v1/scenarios/runs", payload: { template: "oil-price-shock", overrides: { bogus: 1 }, baselineMonth: "2026-02" } })).statusCode).toBe(422);
    expect((await api({ method: "POST", url: "/v1/scenarios/runs", payload: { template: "oil-price-shock", baselineMonth: "2026-13" } })).statusCode).toBe(400);
    const made = await api({ method: "POST", url: "/v1/scenarios/runs", payload: { template: "oil-price-shock", baselineMonth: "2026-02", overrides: { priceShockPct: 40 } } });
    expect(made.statusCode).toBe(201);
    const { id: runId } = made.json() as { id: string };
    const got = (await api(`/v1/scenarios/runs/${runId}`)).json() as { results: unknown[]; confidence: { level: string } };
    expect(got.results.length).toBeGreaterThan(0);
    expect((await api({ method: "POST", url: `/v1/scenarios/runs/${runId}/replay` })).json()).toMatchObject({ resultsMatch: true, manifestMatches: true });
    const created = await withTenant(app, id, async c => (await c.query("SELECT s.created_by, p.id AS pid FROM scenario_runs s, principals p WHERE s.id = $1", [runId])).rows[0]);
    expect(created.created_by).toBe(created.pid); // the acting principal, taken from the token, not from the request body
    expect((await api("/v1/scenarios/runs/not-a-uuid")).statusCode).toBe(400);
    expect((await api(`/v1/scenarios/runs/${randomUUID()}`)).statusCode).toBe(404);
    expect((await api("/v1/scenarios/backtest")).json()).toMatchObject({ basis: "in-sample calibration" });
    expect((await api("/v1/audit/verify")).json()).toMatchObject({ ok: true });
  });
});
