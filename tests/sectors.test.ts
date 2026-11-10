import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { SECTORS, belowRecent, buildSector, energySignals, median, rank, sovereignSignals, type Point } from "../packages/sectors/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";

const P = (t: string, v: number, ev = "e"): Point => ({ t, v, evidenceId: ev, validation: "accepted" });
const months = (n: number, end = "2026-08"): string[] => { const [y, m] = end.split("-").map(Number) as [number, number]; return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)); return d.toISOString().slice(0, 10); }); };
const flat = (n: number, v: number, last?: number): Point[] => months(n).map((t, i) => P(t, i === n - 1 && last !== undefined ? last : v, `ev${i}`));

describe("signal rules", () => {
  it("computes a median that ignores a single outlier", () => { expect(median([1, 2, 100])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNaN(); });

  it("flags a latest value far below the previous twelve months, with watch and alert levels", () => {
    expect(belowRecent(flat(14, 1000, 900), { minMedian: 100, watch: 0.2, alert: 0.4 })).toBeNull();
    expect(belowRecent(flat(14, 1000, 700), { minMedian: 100, watch: 0.2, alert: 0.4 })).toMatchObject({ severity: "watch" });
    expect(belowRecent(flat(14, 1000, 700), { minMedian: 100, watch: 0.2, alert: 0.4 })!.change).toBeCloseTo(-0.3, 12);
    expect(belowRecent(flat(14, 1000, 500), { minMedian: 100, watch: 0.2, alert: 0.4 })).toMatchObject({ severity: "alert" });
  });
  it("does not flag short history or tiny volumes, and the latest month is not part of its own comparison", () => {
    expect(belowRecent(flat(8, 1000, 100), { minMedian: 100, watch: 0.2, alert: 0.4 })).toBeNull();
    expect(belowRecent(flat(14, 20, 1), { minMedian: 100, watch: 0.2, alert: 0.4 })).toBeNull();
    const pts = flat(14, 1000, 1000); pts[13] = P(pts[13]!.t, 100); // only the latest month collapses
    expect(belowRecent(pts, { minMedian: 100, watch: 0.2, alert: 0.4 })!.median).toBe(1000);
  });

  it("raises energy signals with stable ids, the exact figures and their evidence", () => {
    const brent = [P("2026-07-01", 80, "b1"), P("2026-08-01", 100, "b2")], nm = { KW: "Kuwait", SA: "Saudi Arabia" };
    // a small Saudi dip leaves the Gulf total within its band: only Kuwait and Brent are raised
    expect(energySignals({ exports: { KW: flat(14, 1000, 400), SA: flat(14, 7000, 6900) }, brent }, nm).map(s => s.id).sort()).toEqual(["E1:KW:2026-08", "E2:BRENT:2026-08"]);
    const sig = energySignals({ exports: { KW: flat(14, 1000, 400), SA: flat(14, 7000, 4000) }, brent }, nm);
    const ids = sig.map(s => s.id).sort();
    expect(ids).toEqual(["E1:KW:2026-08", "E1:SA:2026-08", "E2:BRENT:2026-08", "E3:GULF:2026-08"]);
    const kw = sig.find(s => s.id === "E1:KW:2026-08")!;
    expect(kw).toMatchObject({ severity: "alert", ruleId: "E1", evidenceIds: ["ev13"], values: { latest: 400, median: 1000 } });
    expect(kw.title).toMatch(/Kuwait: crude exports 60% below/);
    expect(kw.detail).toMatch(/400 thousand barrels a day in 2026-08, against a median of 1,000/);
    expect(sig.find(s => s.id === "E2:BRENT:2026-08")).toMatchObject({ severity: "alert", title: "Brent rose 25% in a month" });
  });
  it("does not compare a country whose newest data is older than the rest", () => {
    const stale = months(14, "2024-03").map((t, i) => P(t, i === 13 ? 100 : 3000, `iq${i}`));
    const ids = energySignals({ exports: { KW: flat(14, 1000, 400), IQ: stale }, brent: [] }, {}).map(s => s.id);
    expect(ids).toContain("E1:KW:2026-08");
    expect(ids.some(i => i.includes(":IQ:"))).toBe(false);
    expect(ids).toContain("E3:GULF:2026-08"); // the Gulf total is built from current countries only
  });
  it("says nothing when nothing has moved", () => {
    expect(energySignals({ exports: { KW: flat(14, 1000) }, brent: [P("2026-07-01", 80), P("2026-08-01", 82)] }, {})).toEqual([]);
    expect(sovereignSignals({ reserves: [P("2026-01-01", 100), P("2026-04-01", 101)], liquid: [P("2026-04-01", 40)], trade: flat(14, 1000), inflation: [P("2026-08-01", 1.5)] })).toEqual([]);
  });
  it("raises sovereign signals for reserves, liquidity, trade and inflation", () => {
    const s = sovereignSignals({ reserves: [P("2026-01-01", 100, "r1"), P("2026-04-01", 94, "r2")], liquid: [P("2026-04-01", 10, "l")], trade: flat(14, 1000, -5), inflation: [P("2026-08-01", 6.2, "i")] });
    expect(s.map(x => `${x.ruleId}:${x.severity}`).sort()).toEqual(["S1:alert", "S2:alert", "S3:alert", "S4:alert"]);
    expect(sovereignSignals({ reserves: [P("2026-01-01", 100), P("2026-04-01", 103)], liquid: [], trade: flat(14, 1000, 400), inflation: [P("2026-08-01", 3.4)] }).map(x => `${x.ruleId}:${x.severity}`).sort()).toEqual(["S1:watch", "S3:watch", "S4:watch"]);
  });
  it("puts alerts first, then the most recent", () => {
    const r = rank([{ id: "a", ruleId: "E1", severity: "watch", title: "", detail: "", observedAt: "2026-08-01", evidenceIds: [], values: {} }, { id: "b", ruleId: "E1", severity: "alert", title: "", detail: "", observedAt: "2026-01-01", evidenceIds: [], values: {} }, { id: "c", ruleId: "E1", severity: "watch", title: "", detail: "", observedAt: "2026-09-01", evidenceIds: [], values: {} }]);
    expect(r.map(x => x.id)).toEqual(["b", "c", "a"]);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });
const ser = (key: string, pack: string, subject: string, predicate: string, unit: string | undefined, pts: [string, number][]): RawRecord => ({
  externalKey: `series:${key}:${subject}:${predicate}`, kind: "observation", sourceUrl: "https://p.example/x", originalAgency: "Agency", eventTime: "2026-06-01T00:00:00Z", payload: { subject, predicate },
  series: { key, title: key, frequency: "monthly", packs: [pack], query: {} }, facts: pts.map(([t, v]) => ({ subject, predicate, value: v, ...(unit ? { unit } : {}), validTime: `${t}T00:00:00Z`, dims: {}, unitStated: unit !== undefined })),
});
const J = "jodi-gulf-crude-monthly", I = "imf-commodity-prices-monthly", R = "sama-reserve-assets-quarterly", T = "gastat-trade-balance-monthly", C = "gastat-cpi-monthly", M = "sama-money-supply-m3-monthly", G = "gastat-gdp-main-activities-quarterly";
const NOW = new Date("2026-11-10T00:00:00Z");

suite("sector command centres against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID(), src = (k: string) => `${k}-${id.slice(0, 5)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Sec')", [id]);
      for (const k of [J, I, R, T, C, M, G]) await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,$2,'P','Agency','fake','https://p.example','approved','CC BY',true)", [id, src(k)]);
    });
    const ing = (k: string, rs: RawRecord[]) => runIngestion({ pool: app, institutionId: id, sourceKey: src(k), connector: { platform: "fake", async *fetchRecords() { for (const r of rs) yield r; } } as Connector, http: noNetwork, now: () => NOW });
    const m14 = months(14), q = ["2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"];
    const exOld = ser(J, "energy", `${J}|country=IQ|flow=TOTEXPSB`, "Total exports", "thousand barrels per day", months(14, "2024-03").map(t => [t, 3000] as [string, number]));
    const ex = (code: string, base: number, last: number) => ser(J, "energy", `${J}|country=${code}|flow=TOTEXPSB`, "Total exports", "thousand barrels per day", m14.map((t, i) => [t, i === 13 ? last : base]));
    const pr = (code: string, v: number) => ser(J, "energy", `${J}|country=${code}|flow=INDPROD`, "Indigenous production", "thousand barrels per day", m14.map(t => [t, v]));
    await ing(J, [ex("KW", 1000, 400), ex("SA", 7000, 6900), pr("KW", 2000), pr("SA", 9500), exOld]);
    await ing(I, [ser(I, "energy", `${I}|commodity=POILBRE`, "Price", "US$ per barrel", m14.map((t, i) => [t, i === 13 ? 100 : i === 12 ? 80 : 75]))]);
    const comp: Record<string, number> = { "Foreign Currency and Deposits Abroad": 300_000, "Investment in Foreign Securities": 600_000, "Monetary Gold": 10_000, "Reserve Position in the IMF": 40_000, SDR: 50_000, "Total Reserves Assets": 1_000_000 };
    await ing(R, Object.entries(comp).map(([k, v]) => ser(R, "sovereign_capital", `${R}|Reserve Assets=${k}`, "Million SAR", "million SAR", q.map((t, i) => [t, i === 3 ? v * 0.94 : v]))));
    await ing(T, [ser(T, "sovereign_capital", T, "Trade Balance", undefined, m14.map((t, i) => [t, i === 13 ? 300 : 1000]))]);
    await ing(C, [ser(C, "sovereign_capital", `${C}|Main Division=General Index`, "Inflation rate", "percent", m14.map((t, i) => [t, i === 13 ? 3.6 : 2]))]);
    await ing(M, [ser(M, "sovereign_capital", M, "Million SAR", "million SAR", m14.map(t => [t, 3_000_000])), ser(M, "sovereign_capital", M, "Growth Rate", "percent", m14.map(t => [t, 9.5]))]);
    await ing(G, [["Oil Activities", 300], ["Non-Oil Activities", 700], ["Government Activities", 200]].map(([a, v]) => ser(G, "sovereign_capital", `${G}|Main Economic Activities=${a}`, "Nominal GDP", undefined, q.map(t => [t, v as number]))));
    const tokens = { ana: await addUser(owner, app, id, "ana", ["analyst"]), ed: await addUser(owner, app, id, "ed", ["executive"]) };
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = async (who: keyof typeof tokens, method: string, url: string, payload?: object) => { const r = await server.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload ? { payload } : {}) }); let body: any = null; try { body = r.json(); } catch { /* none */ } return { status: r.statusCode, body }; };
    return { id, call, view: (k: "energy" | "sovereign") => withTenant(app, id, c => buildSector(c, k, NOW)) };
  }

  it("builds the Energy and Oil centre from stored evidence, with provenance on every figure", async () => {
    const s = await scene(), v = await s.view("energy");
    expect(v).toMatchObject({ pack: "energy", name: "Energy and Oil", rulesVersion: "signal-rules/1" });
    const f = Object.fromEntries(v.figures.map(x => [x.id, x]));
    expect(f.brent).toMatchObject({ value: 100, unit: "US$ per barrel", validation: "accepted", change: { text: "+25.0% on the month", direction: "up" } });
    expect(f["gulf-exports"]!.value).toBe(7300); expect(f["gulf-production"]!.value).toBe(11500);
    expect(f["gulf-exports"]!.change!.direction).toBe("down");
    for (const x of v.figures) expect(x.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.countries!.map(c => c.code)).toEqual(["SA", "KW", "IQ"]);
    expect(v.countries!.find(c => c.code === "IQ")).toMatchObject({ lagging: true, changePct: null });
    expect(f["gulf-exports"]!.note).toMatch(/2 countries with stored data for this month: Kuwait, Saudi Arabia/);
    expect(v.countries!.find(c => c.code === "KW")).toMatchObject({ exportsKbd: 400, medianKbd: 1000, changePct: -0.6, productionKbd: 2000 });
    expect(v.trends.map(t => t.id)).toEqual(["brent", "gulf-exports"]);
    expect(v.trends[0]!.points).toHaveLength(14);
    expect(v.freshness.map(x => x.seriesKey)).toEqual([I, J]);
    expect(v.signals.map(x => x.id)).toEqual(expect.arrayContaining(["E1:KW:2026-08", "E2:BRENT:2026-08"]));
    expect(v.signals.every(x => x.evidenceIds.length > 0)).toBe(true);
  });

  it("builds the Sovereign Capital and Treasury centre, with the reserve mix adding to the whole", async () => {
    const s = await scene(), v = await s.view("sovereign");
    const f = Object.fromEntries(v.figures.map(x => [x.id, x]));
    expect(f.reserves).toMatchObject({ value: 940_000, unit: "million SAR", change: { text: "−6.0% on the quarter", direction: "down" } });
    expect(f["liquid-share"]!.value).toBeCloseTo(30, 9);
    expect(f.inflation!.value).toBe(3.6); expect(f.m3!.change!.text).toMatch(/Published growth rate 9.5%/); expect(f.m3!.note).toMatch(/does not say over what period/);
    expect(f["oil-gdp"]!.value).toBeCloseTo(25, 9);
    expect(v.composition!.rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1, 9);
    expect(v.signals.map(x => x.ruleId).sort()).toEqual(["S1", "S3", "S4"]);
    expect(v.signals.find(x => x.ruleId === "S1")).toMatchObject({ severity: "alert" });
    expect(v.freshness.length).toBe(5);
  });

  it("serves the centres over the API, and refuses an unknown pack", async () => {
    const s = await scene();
    expect((await s.call("ed", "GET", "/v1/sectors")).body.map((x: { key: string }) => x.key)).toEqual(["energy", "sovereign"]);
    expect((await s.call("ed", "GET", "/v1/sectors/energy")).body.figures.length).toBeGreaterThan(0);
    expect((await s.call("ed", "GET", "/v1/sectors/banking")).status).toBe(404);
    expect(Object.keys(SECTORS)).toEqual(["energy", "sovereign"]);
  });

  it("opens a case from a signal with its evidence attached, once, and keeps the lineage", async () => {
    const s = await scene();
    const sig = (await s.call("ana", "GET", "/v1/sectors/energy")).body.signals.find((x: { id: string }) => x.id === "E1:KW:2026-08");
    const first = await s.call("ana", "POST", `/v1/sectors/energy/signals/${encodeURIComponent(sig.id)}/case`);
    expect(first.status).toBe(201); expect(first.body).toMatchObject({ existing: false, caseKey: "CASE-0001" });
    const again = await s.call("ana", "POST", `/v1/sectors/energy/signals/${encodeURIComponent(sig.id)}/case`);
    expect(again.status).toBe(200); expect(again.body).toMatchObject({ existing: true, id: first.body.id });
    const c = (await s.call("ana", "GET", `/v1/cases/${first.body.id}`)).body;
    expect(c).toMatchObject({ domain: "energy", state: "open", title: expect.stringMatching(/Kuwait: crude exports 60% below/), signal: { id: sig.id, ruleId: "E1", rulesVersion: "signal-rules/1", origin: "sector signal", values: { latest: 400 } } });
    expect(c.evidence.map((e: { id: string; role: string }) => [e.id, e.role])).toEqual([[sig.evidenceIds[0], "context"]]);
    expect((await s.call("ana", "GET", "/v1/cases")).body[0].signal_id).toBe(sig.id);
    const sov = (await s.call("ana", "GET", "/v1/sectors/sovereign")).body.signals[0];
    const second = await s.call("ana", "POST", `/v1/sectors/sovereign/signals/${encodeURIComponent(sov.id)}/case`);
    expect((await s.call("ana", "GET", `/v1/cases/${second.body.id}`)).body.domain).toBe("sovereign capital");
  });

  it("refuses to open a case from a signal that is gone, or for someone who cannot write cases", async () => {
    const s = await scene();
    expect((await s.call("ana", "POST", "/v1/sectors/energy/signals/E1:KW:1999-01/case")).status).toBe(404);
    const sig = (await s.call("ed", "GET", "/v1/sectors/energy")).body.signals[0];
    expect((await s.call("ed", "POST", `/v1/sectors/energy/signals/${encodeURIComponent(sig.id)}/case`)).status).toBe(403);
  });

  it("shows an empty centre honestly when no data is stored", async () => {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Empty')", [id]); });
    for (const k of ["energy", "sovereign"] as const) {
      const v = await withTenant(app, id, c => buildSector(c, k, NOW));
      expect(v).toMatchObject({ figures: [], signals: [], trends: [], freshness: [] });
    }
  });
});
