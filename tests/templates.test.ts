import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { PostgresGraph } from "../packages/graph/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { PACKS, TEMPLATES, avgDecay, createRun, curtailmentShock, endDecay, getRun, replayRun, resolveParams, runScenario, type Baseline } from "../packages/scenario/src/index.js";

const ref = (subject: string, value: number) => ({ evidenceId: "00000000-0000-0000-0000-000000000001", subject, validTime: "2026-02-01T00:00:00.000Z", value, validation: "accepted" });
const base = (): Baseline => ({
  month: "2026-05", priceUsd: 100, priceRef: ref("brent", 100), reservesMillionSar: null, reservesRef: null,
  countries: [
    { code: "SA", name: "A", exportsKbd: 7000, productionKbd: 10000, hormuzShare: 0.5, spareBypassKbd: 1000, linkClass: "sourced", refs: [ref("sa", 7000)] },
    { code: "KW", name: "B", exportsKbd: 2000, productionKbd: 2500, hormuzShare: 1, spareBypassKbd: 0, linkClass: "sourced", refs: [ref("kw", 2000)] },
  ],
  reserves: { quarter: "2026-04", totalMillionSar: 3_750_000, liquidMillionSar: 750_000, securitiesMillionSar: 2_250_000, goldMillionSar: 375_000, otherMillionSar: 375_000, refs: [ref("res", 3_750_000)] },
  gdp: { quarter: "2026-04", annualOilMillion: 1_200_000, annualNonOilMillion: 3_000_000, annualGovernmentMillion: 800_000, unitStated: false, refs: [ref("gdp", 5_000_000)] },
});
const values = (key: string, o: Record<string, number> = {}, flex: number | null = 10) => Object.fromEntries(Object.entries(resolveParams(key, o, flex)).map(([k, x]) => [k, x.value]));
const run = (key: string, o: Record<string, number> = {}, b = base()) => TEMPLATES[key]!.compute(b, values(key, o));
const get = (ms: ReturnType<typeof run>, h: string, m: string) => ms.find(x => x.horizon === h && x.metric === m)!.value;

describe("packs", () => {
  it("gives each pack exactly three templates", () => {
    const by = (k: string) => Object.values(TEMPLATES).filter(t => t.pack === k).map(t => t.key).sort();
    expect(by("energy")).toEqual(["hormuz-transit-restriction", "oil-price-shock", "production-curtailment"]);
    expect(by("sovereign")).toEqual(["export-revenue-gdp", "reserve-asset-stress", "reserve-runway"]);
    expect(Object.keys(PACKS)).toEqual(["energy", "sovereign"]);
  });
  it("names a headline measure that every template actually produces, and keeps formula versions distinct per method", () => {
    for (const t of Object.values(TEMPLATES)) {
      const ms = t.compute(base(), values(t.key, {}, t.usesFlexibility ? 10 : null));
      expect(ms.some(m => m.horizon === t.headline.horizon && m.metric === t.headline.metric), t.key).toBe(true);
      expect(ms.length, t.key).toBeGreaterThan(0);
      for (const m of ms) expect(Number.isFinite(m.value), `${t.key} ${m.metric}`).toBe(true);
    }
    expect(new Set(Object.values(TEMPLATES).map(t => t.formulaVersion)).size).toBe(4);
  });
});

describe("production curtailment (Energy and Oil)", () => {
  it("withholds a share of output, capped at what the country exports", () => {
    const v = values("production-curtailment", { curtailmentPct: 10 });
    expect(curtailmentShock(base(), v).lostKbd).toEqual({ SA: 1000, KW: 250 });
    expect(curtailmentShock(base(), values("production-curtailment", { curtailmentPct: 100 })).lostKbd).toEqual({ SA: 7000, KW: 2000 });
    expect(curtailmentShock(base(), values("production-curtailment", { curtailmentPct: 10, participation: 0.5 })).lostKbd).toEqual({ SA: 500, KW: 125 });
  });
  it("prices the cut by the supply removed and applies it to volume only while it lasts", () => {
    const ms = run("production-curtailment", { curtailmentPct: 10, durationDays: 30 });
    expect(get(ms, "72h", "lost_supply_kbd")).toBe(1250);
    const prem = 1250 / 100000 * 10, avg = 100 * (1 + prem * avgDecay(90, 60));
    expect(get(ms, "90d", "brent_avg_usd")).toBeCloseTo(avg, 9);
    expect(get(ms, "90d", "brent_end_usd")).toBeCloseTo(100 * (1 + prem * endDecay(90, 60)), 9);
    const kwBase = 2000 * 1000 * 90 * 100 / 1e6, kwScn = (2000 * 1000 * 90 - 250 * 1000 * 30) * avg / 1e6;
    expect(get(ms, "90d", "revenue_delta_musd:KW")).toBeCloseTo(kwScn - kwBase, 6);
  });
  it("loses revenue on a deep cut with a weak price response, and gains on a light cut with a strong one", () => {
    expect(get(run("production-curtailment", { curtailmentPct: 15, priceFlexibility: 2 }), "1y", "gulf_revenue_delta_musd")).toBeLessThan(0);
    expect(get(run("production-curtailment", { curtailmentPct: 2, priceFlexibility: 60, halfLifeDays: 365, durationDays: 30 }), "1y", "gulf_revenue_delta_musd")).toBeGreaterThan(0);
  });
});

describe("reserve runway (Sovereign Capital and Treasury)", () => {
  it("draws reserves down linearly when there is no return, by hand-checkable arithmetic", () => {
    const ms = run("reserve-runway", { annualGapUsdBn: 100, assetReturnPct: 0 });
    // reserves 3,750,000 / 3.75 = 1,000,000 musd; liquid 200,000; draw 100,000 a year
    expect(get(ms, "1y", "reserves_remaining_musd")).toBeCloseTo(900_000, 6);
    expect(get(ms, "5y", "reserves_remaining_musd")).toBeCloseTo(500_000, 6);
    expect(get(ms, "5y", "reserves_remaining_pct")).toBeCloseTo(50, 9);
    expect(get(ms, "1y", "runway_years")).toBeCloseTo(10, 9);
    expect(get(ms, "1y", "liquid_runway_years")).toBeCloseTo(2, 9);
    expect(get(ms, "1y", "liquid_assets_remaining_musd")).toBeCloseTo(100_000, 6);
    expect(get(ms, "5y", "liquid_assets_remaining_musd")).toBe(0);
  });
  it("holds reserves level when the draw equals the return, and never goes below zero", () => {
    const steady = run("reserve-runway", { annualGapUsdBn: 30, assetReturnPct: 3 });
    expect(get(steady, "5y", "reserves_remaining_pct")).toBeCloseTo(100, 6);
    expect(get(steady, "5y", "runway_years")).toBe(99);
    const heavy = run("reserve-runway", { annualGapUsdBn: 400, assetReturnPct: 3 });
    expect(get(heavy, "5y", "reserves_remaining_musd")).toBe(0);
    expect(get(heavy, "1y", "runway_years")).toBeLessThan(3);
  });
  it("matches the closed-form runway when the draw exceeds the return", () => {
    const ms = run("reserve-runway", { annualGapUsdBn: 40, assetReturnPct: 3 });
    expect(get(ms, "1y", "runway_years")).toBeCloseTo(Math.log(40_000 / (40_000 - 30_000)) / 0.03, 9);
  });
  it("says what is missing instead of guessing", () => {
    const b = base(); delete b.reserves;
    expect(() => run("reserve-runway", {}, b)).toThrow(/reserve-asset baseline/);
  });
});

describe("export revenue against GDP (Sovereign Capital and Treasury)", () => {
  it("rebuilds crude export revenue and sets it against GDP", () => {
    const ms = run("export-revenue-gdp", { priceChangePct: -30 });
    const gdpMusd = 5_000_000 / 3.75, revYear = 7000 * 1000 * 365 * 100 / 1e6;
    expect(get(ms, "1y", "crude_export_revenue_share_of_gdp_pct")).toBeCloseTo(revYear / gdpMusd * 100, 9);
    expect(get(ms, "1y", "oil_activity_share_of_gdp_pct")).toBeCloseTo(24, 9);
    const priceAvg = 100 * (1 - 0.3 * avgDecay(365, 180)), delta = 7000 * 1000 * 365 * (priceAvg - 100) / 1e6;
    expect(get(ms, "1y", "delta_musd")).toBeCloseTo(delta, 6);
    expect(get(ms, "1y", "delta_pct_of_annual_gdp")).toBeCloseTo(delta / gdpMusd * 100, 9);
    expect(get(ms, "72h", "brent_end_usd")).toBeLessThan(100);
  });
  it("scales revenue with volume alone when the price does not move", () => {
    const ms = run("export-revenue-gdp", { priceChangePct: 0, volumeChangePct: 10 });
    expect(get(ms, "90d", "delta_musd")).toBeCloseTo(0.1 * 7000 * 1000 * 90 * 100 / 1e6, 6);
  });
  it("needs Saudi volumes and a GDP baseline", () => {
    const noSa = base(); noSa.countries = noSa.countries.filter(c => c.code !== "SA");
    expect(() => run("export-revenue-gdp", {}, noSa)).toThrow(/Saudi export volumes/);
    const noGdp = base(); delete noGdp.gdp;
    expect(() => run("export-revenue-gdp", {}, noGdp)).toThrow(/GDP baseline/);
  });
  it("tells the reader that the GDP unit is not stated by its source", () => {
    const out = runScenario("export-revenue-gdp", base(), resolveParams("export-revenue-gdp", {}, null), new Date("2026-06-15T00:00:00Z"));
    expect(out.confidence.notes.join(" ")).toMatch(/does not state its unit/);
  });
});

describe("reserve asset stress (Sovereign Capital and Treasury)", () => {
  it("applies each class shock to the published composition and fades it", () => {
    const ms = run("reserve-asset-stress");
    const sec = 2_250_000 / 3.75, k = endDecay(3, 180);
    expect(get(ms, "72h", "change_musd")).toBeCloseTo(-0.08 * k * sec, 6);
    expect(get(ms, "72h", "change_pct")).toBeCloseTo(-0.08 * k * sec / 1_000_000 * 100, 9);
    expect(Math.abs(get(ms, "5y", "change_pct"))).toBeLessThan(0.1 * Math.abs(get(ms, "72h", "change_pct")));
  });
  it("leaves reserves unchanged with no shock, and shifts the mix toward liquid assets when securities fall", () => {
    const none = run("reserve-asset-stress", { securitiesShockPct: 0 });
    expect(get(none, "72h", "change_musd")).toBeCloseTo(0, 9);
    expect(get(none, "72h", "liquid_share_pct")).toBeCloseTo(20, 9);
    const hit = run("reserve-asset-stress");
    expect(get(hit, "72h", "liquid_share_pct")).toBeGreaterThan(20);
    expect(get(hit, "72h", "securities_share_pct")).toBeLessThan(60);
  });
  it("lasts longer when markets recover more slowly", () => {
    expect(Math.abs(get(run("reserve-asset-stress", { recoveryHalfLifeDays: 365 }), "1y", "change_pct"))).toBeGreaterThan(Math.abs(get(run("reserve-asset-stress", { recoveryHalfLifeDays: 60 }), "1y", "change_pct")));
  });
});

describe("runs of the new templates", () => {
  it("carry a range around every measure, non-negative where they must be, and are deterministic", () => {
    for (const key of ["production-curtailment", "reserve-runway", "export-revenue-gdp", "reserve-asset-stress"]) {
      const ps = resolveParams(key, {}, TEMPLATES[key]!.usesFlexibility ? 10 : null), today = new Date("2026-06-15T00:00:00Z");
      const a = runScenario(key, base(), ps, today), b = runScenario(key, base(), ps, today);
      expect(JSON.stringify(a), key).toBe(JSON.stringify(b));
      for (const m of a.metrics) { const bd = a.bands[`${m.horizon}|${m.metric}`]!; expect(bd.low, `${key} ${m.metric}`).toBeLessThanOrEqual(m.value + 1e-6); expect(bd.high).toBeGreaterThanOrEqual(m.value - 1e-6); if (TEMPLATES[key]!.nonNegative.includes(m.metric)) expect(bd.low).toBeGreaterThanOrEqual(0); }
      expect(a.sensitivity.length, key).toBeGreaterThan(0);
      expect(a.formulaVersion).toBe(TEMPLATES[key]!.formulaVersion);
    }
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });

const series = (key: string, subject: string, predicate: string, unit: string | undefined, points: [string, number][]): RawRecord => ({
  externalKey: `series:${key}:${subject}`, kind: "observation", sourceUrl: "https://p.example/x", originalAgency: "Agency", eventTime: "2026-06-01T00:00:00Z", payload: { subject },
  series: { key, title: key, frequency: "quarterly", packs: [], query: {} },
  facts: points.map(([t, v]) => ({ subject, predicate, value: v, ...(unit ? { unit } : {}), validTime: `${t}T00:00:00Z`, dims: {}, unitStated: unit !== undefined })),
});
const R = "sama-reserve-assets-quarterly", G = "gastat-gdp-main-activities-quarterly", J = "jodi-gulf-crude-monthly", I = "imf-commodity-prices-monthly";
const Q = ["2025-07-01", "2025-10-01", "2026-01-01", "2026-04-01"] as const;

suite("sovereign and energy templates against stored evidence", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function institution(o: { reserves?: Record<string, number>; gdpQuarters?: number } = {}): Promise<string> {
    const id = randomUUID(), keys = [R, G, J, I].map(k => `${k.slice(0, 4)}-${id.slice(0, 5)}`);
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'T')", [id]);
      for (const k of keys) await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,$2,'P','Agency','fake','https://p.example','approved','CC BY',true)", [id, k]);
    });
    const ing = (src: string, rs: RawRecord[]) => runIngestion({ pool: app, institutionId: id, sourceKey: src, connector: { platform: "fake", async *fetchRecords() { for (const r of rs) yield r; } } as Connector, http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    const res = o.reserves ?? { "Foreign Currency and Deposits Abroad": 750_000, "Investment in Foreign Securities": 2_250_000, "Monetary Gold": 375_000, "Reserve Position in the IMF": 175_000, SDR: 200_000, "Total Reserves Assets": 3_750_000 };
    await ing(keys[0]!, Object.entries(res).map(([t, v]) => series(R, `${R}|Reserve Assets=${t}`, "Million SAR", "million SAR", Q.map((q, i) => [q, v * (1 + i * 0.01)] as [string, number]))));
    const qs = Q.slice(4 - (o.gdpQuarters ?? 4));
    await ing(keys[1]!, [["Oil Activities", 300_000], ["Non-Oil Activities", 750_000], ["Government Activities", 170_000]].map(([a, v]) => series(G, `${G}|Main Economic Activities=${a}`, "Nominal GDP", undefined, qs.map(q => [q, v as number] as [string, number]))));
    const months = ["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"], fall = [1, 0.8, 0.7, 0.65];
    await ing(keys[2]!, [["SA", 7000], ["KW", 2000]].flatMap(([cc, ex]) => [series(J, `${J}|country=${cc}|flow=TOTEXPSB`, "Total exports", "thousand barrels per day", months.map((m, i) => [m, (ex as number) * fall[i]!] as [string, number])), series(J, `${J}|country=${cc}|flow=INDPROD`, "Indigenous production", "thousand barrels per day", months.map(m => [m, (ex as number) * 1.3] as [string, number]))]));
    await ing(keys[3]!, [series(I, `${I}|commodity=POILBRE`, "Price", "US$ per barrel", months.map((m, i) => [m, [70, 100, 105, 106][i]!] as [string, number]))]);
    await withTenant(app, id, async c => {
      const g = new PostgresGraph(c, id);
      await g.upsertEntity({ kind: "chokepoint", key: "chokepoint:hormuz", name: "H" });
      for (const code of ["SA", "KW"]) {
        await g.upsertEntity({ kind: "country", key: `country:${code}`, name: code, attrs: { code, exportsSubject: `${J}|country=${code}|flow=TOTEXPSB`, productionSubject: `${J}|country=${code}|flow=INDPROD` } });
        await g.addLink({ subject: "chokepoint:hormuz", predicate: "constrains_exports_of", object: `country:${code}`, linkClass: "assumed", rationale: "test placeholder", params: { hormuzShare: 1, spareBypassKbd: 0 } });
      }
    });
    return id;
  }
  const go = (id: string, key: string, o: Record<string, number> = {}, month = "2026-05") => withTenant(app, id, c => createRun(c, id, { templateKey: key, baselineMonth: month, overrides: o, createdBy: "t", today: new Date("2026-06-15T00:00:00Z") }));

  it("builds each baseline from stored evidence and replays every new template exactly", async () => {
    const id = await institution();
    for (const key of ["production-curtailment", "reserve-runway", "export-revenue-gdp", "reserve-asset-stress"]) {
      const r = await go(id, key);
      const replay = await withTenant(app, id, c => replayRun(c, r.id));
      expect(replay, key).toMatchObject({ manifestMatches: true, resultsMatch: true, storedRowsMatch: true });
      const stored = await withTenant(app, id, c => getRun(c, r.id)) as { results: { lineage: { evidence: string[] } }[]; template: string; formulaVersion: string };
      expect(stored.template).toBe(key); expect(stored.formulaVersion).toBe(TEMPLATES[key]!.formulaVersion);
      expect(stored.results[0]!.lineage.evidence.length, key).toBeGreaterThan(0);
    }
  });

  it("reads reserves from the latest quarter at or before the baseline month, with all classes from one quarter", async () => {
    const id = await institution();
    const r = await go(id, "reserve-runway");
    expect(r.baseline.reserves).toMatchObject({ quarter: "2026-04" });
    expect(r.baseline.reserves!.totalMillionSar).toBeCloseTo(3_750_000 * 1.03, 3);
    expect(r.baseline.reserves!.refs).toHaveLength(6);
    expect(r.baseline.priceUsd).toBeNull(); // a reserve scenario does not need Gulf data
    const earlier = await go(id, "reserve-runway", {}, "2026-02");
    expect(earlier.baseline.reserves!.quarter).toBe("2026-01");
  });

  it("sums the four most recent quarters of GDP and flags that the source states no unit", async () => {
    const id = await institution();
    const r = await go(id, "export-revenue-gdp");
    expect(r.baseline.gdp).toMatchObject({ quarter: "2026-04", annualOilMillion: 1_200_000, annualNonOilMillion: 3_000_000, annualGovernmentMillion: 680_000, unitStated: false });
    expect(r.confidence.notes.join(" ")).toMatch(/does not state its unit/);
  });

  it("refuses to build a baseline from inconsistent or thin data", async () => {
    const bad = await institution({ reserves: { "Foreign Currency and Deposits Abroad": 750_000, "Investment in Foreign Securities": 2_250_000, "Monetary Gold": 375_000, "Reserve Position in the IMF": 175_000, SDR: 200_000, "Total Reserves Assets": 4_500_000 } });
    await expect(go(bad, "reserve-asset-stress")).rejects.toThrow(/do not add up/);
    const thin = await institution({ gdpQuarters: 3 });
    await expect(go(thin, "export-revenue-gdp")).rejects.toThrow(/fewer than four quarters/);
    await expect(go(thin, "reserve-runway")).resolves.toBeDefined(); // unrelated data being thin does not block a reserve scenario
    await expect(go(thin, "reserve-runway", {}, "2020-01")).rejects.toThrow(/no reserve-asset observations/);
  });

  it("keeps a pre-existing Gulf-shaped run replayable", async () => {
    const id = await institution();
    const r = await go(id, "oil-price-shock");
    expect(r.baseline.reserves).toBeUndefined(); // energy baselines keep the shape older runs have
    expect(await withTenant(app, id, c => replayRun(c, r.id))).toMatchObject({ resultsMatch: true });
    expect((await go(id, "production-curtailment", { curtailmentPct: 10 })).metrics.find(m => m.metric === "lost_supply_kbd")!.value).toBeGreaterThan(0);
  });
});
