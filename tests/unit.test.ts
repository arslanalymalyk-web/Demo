import { describe, expect, it } from "vitest";
import { canonicalJson, hashPayload } from "../packages/core/src/index.js";
import { PoliteHttp, opendatasoft, ckan, tesseract } from "../packages/connectors/src/index.js";
import { validateRecord } from "../packages/ingest/src/validate.js";

function fakeFetch(routes: Record<string, unknown>, log: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url); log.push(u);
    if (u.endsWith("/robots.txt")) { const r = routes["robots"]; return new Response(typeof r === "string" ? r : "", { status: r === undefined ? 404 : 200, headers: { "content-type": "text/plain" } }); }
    const hit = Object.keys(routes).find(k => k !== "robots" && u.includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    const v = routes[hit];
    if (typeof v === "function") return (v as () => Response)();
    return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const http = (routes: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof PoliteHttp>[0]> = {}) => new PoliteHttp({ fetchImpl: fakeFetch(routes), minIntervalMs: 0, sleep: async () => {}, ...extra });

describe("hashing", () => {
  it("is independent of key order", () => {
    expect(hashPayload({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(hashPayload({ a: [2, { c: 3, d: 4 }], b: 1 }));
    expect(canonicalJson({ z: undefined, a: 1 })).toBe('{"a":1}');
  });
  it("changes when content changes", () => { expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 })); });
});

describe("polite http", () => {
  it("parses only the wildcard group of robots.txt", () => {
    expect(PoliteHttp.parseDisallow("User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /api/\nDisallow:\n# c\nDisallow: /x # note")).toEqual(["/api/", "/x"]);
  });
  it("refuses paths that robots.txt disallows, without calling them", async () => {
    const log: string[] = [];
    const h = new PoliteHttp({ fetchImpl: fakeFetch({ robots: "User-agent: *\nDisallow: /api/", "/api/x": { ok: 1 } }, log), minIntervalMs: 0, sleep: async () => {} });
    await expect(h.getJson("https://portal.example/api/x")).rejects.toThrow(/robots\.txt disallows/);
    expect(log.some(u => u.includes("/api/x"))).toBe(false);
  });
  it("retries once on a server error", async () => {
    let calls = 0; const sleeps: number[] = [];
    const h = new PoliteHttp({ fetchImpl: fakeFetch({ "/data": () => (++calls === 1 ? new Response("x", { status: 503 }) : new Response('{"ok":true}', { status: 200 })) }), minIntervalMs: 0, sleep: async ms => { sleeps.push(ms); } });
    expect(await h.getJson("https://portal.example/data")).toEqual({ ok: true });
    expect(calls).toBe(2); expect(sleeps).toContain(1500);
  });
  it("spaces requests to the same host", async () => {
    const sleeps: number[] = []; let now = 1000; const real = Date.now; Date.now = () => now;
    try {
      const h = new PoliteHttp({ fetchImpl: fakeFetch({ "/a": {}, "/b": {} }), minIntervalMs: 400, sleep: async ms => { sleeps.push(ms); }, respectRobots: false });
      await h.getJson("https://portal.example/a"); await h.getJson("https://portal.example/b");
      expect(sleeps.some(s => s > 0 && s <= 400)).toBe(true);
    } finally { Date.now = real; }
  });
});

describe("connectors", () => {
  it("opendatasoft: reads catalogue entries, honours the limit and keeps the publisher", async () => {
    const ds = (i: number) => ({ dataset_id: `d${i}`, metas: { default: { title: `T${i}`, theme: ["Energy"], publisher: "Agency A", license: "CC BY", records_count: i * 10, modified: "2026-02-01T00:00:00Z" } } });
    const h = http({ "/api/explore/v2.1/catalog/datasets": { total_count: 3, results: [ds(1), ds(2), ds(3)] } });
    const out = []; for await (const r of opendatasoft.fetchRecords({ baseUrl: "https://portal.example", http: h, limit: 2 })) out.push(r);
    expect(out.map(r => r.externalKey)).toEqual(["catalog:d1", "catalog:d2"]);
    expect(out[0]).toMatchObject({ originalAgency: "Agency A", eventTime: "2026-02-01T00:00:00Z", payload: { licence: "CC BY", records_count: 10 } });
  });
  it("ckan: lists packages then reads each", async () => {
    const h = http({ package_list: { success: true, result: ["energy", "labour"] }, "package_show?id=energy": { success: true, result: { title: "Energy", license_title: "Open", metadata_modified: "2026-03-01T10:00:00.000000", organization: { title: "Stat Centre" }, resources: [{ name: "csv", format: "CSV", url: "https://x/y.csv" }] } }, "package_show?id=labour": { success: true, result: { title: "Labour" } } });
    const out = []; for await (const r of ckan.fetchRecords({ baseUrl: "https://stat.example", http: h })) out.push(r);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ externalKey: "package:energy", originalAgency: "Stat Centre", eventTime: "2026-03-01T10:00:00.000Z" });
    expect(out[1]!.originalAgency).toBeNull();
  });
  it("tesseract: falls back to the source link host when no agency name is given", async () => {
    const h = http({ "/tesseract/cubes": { cubes: [{ name: "cpi", annotations: { source_name: "GASTAT", source_link: "https://www.stats.example/cpi", topic_en: "Prices" }, dimensions: [{ name: "Month" }], measures: [{ name: "Index" }] }, { name: "trade", annotations: { source_link: "https://www.bank.example/x" } }] } });
    const out = []; for await (const r of tesseract.fetchRecords({ baseUrl: "https://api.example", http: h })) out.push(r);
    expect(out.map(r => r.originalAgency)).toEqual(["GASTAT", "www.bank.example"]);
    expect(out[0]!.payload).toMatchObject({ dimensions: ["Month"], measures: ["Index"] });
  });
});

describe("validation", () => {
  const src = { status: "approved", licence_verified: true, base_url: "https://p.example", freshness_limit_ms: 7 * 86_400_000 };
  const now = new Date("2026-11-10T00:00:00Z");
  const rec = { externalKey: "k", kind: "catalog" as const, sourceUrl: "https://p.example/k", originalAgency: "Agency", eventTime: "2026-01-01T00:00:00Z", payload: { a: 1 } };
  it("accepts a complete record from a verified source", () => { expect(validateRecord(rec, src, now).outcome).toBe("accepted"); });
  it("warns when the licence is unverified or the agency is unknown", () => {
    expect(validateRecord(rec, { ...src, licence_verified: false }, now)).toMatchObject({ outcome: "warned", reason: "rights_known" });
    expect(validateRecord({ ...rec, originalAgency: null }, src, now).outcome).toBe("warned");
  });
  it("quarantines empty payloads, bad or future timestamps, and unapproved sources", () => {
    expect(validateRecord({ ...rec, payload: {} }, src, now).outcome).toBe("quarantined");
    expect(validateRecord({ ...rec, eventTime: "not a date" }, src, now).outcome).toBe("quarantined");
    expect(validateRecord({ ...rec, eventTime: "2027-01-01T00:00:00Z" }, src, now).outcome).toBe("quarantined");
    expect(validateRecord(rec, { ...src, status: "pending_rights" }, now).outcome).toBe("quarantined");
  });
  it("applies the freshness limit to observations only", () => {
    expect(validateRecord({ ...rec, kind: "observation" }, src, now).outcome).toBe("warned");
    expect(validateRecord(rec, src, now).outcome).toBe("accepted");
  });
});

import { seriesConnector, toValidTime, type SeriesSpec } from "../packages/connectors/src/index.js";

describe("series connector", () => {
  it("converts period labels to the start of the period", () => {
    expect(toValidTime("Year", 2025)).toBe("2025-01-01T00:00:00.000Z");
    expect(toValidTime("Quarter", "2026-Q3")).toBe("2026-07-01T00:00:00.000Z");
    expect(toValidTime("Month", "2026-09")).toBe("2026-09-01T00:00:00.000Z");
    expect(toValidTime("Month", "September")).toBeNull();
    expect(toValidTime("Quarter", "2026-Q5")).toBeNull();
  });
  const spec: SeriesSpec = { key: "prices", title: "Prices", frequency: "annual", packs: ["energy"], maxAgeDays: 800, cube: "oil", dimensions: ["Oil"], timeLevel: "Year", drilldowns: ["Oil", "Year"], measures: [{ name: "USD per Barrel", unit: "USD per barrel" }, { name: "Daily", unit: null }] };
  it("turns query rows into one fact per measure with dimensions, units and the publisher's agency", async () => {
    const h = http({ "/tesseract/data.jsonrecords": { annotations: { source_name: "Central Bank", source_link: "https://bank.example/r" }, columns: ["Oil", "Year"], data: [{ Oil: "Light", Year: 2024, "USD per Barrel": 80.5, Daily: 9.1 }, { Oil: "Light", Year: 2025, "USD per Barrel": 65.8, Daily: null }] } });
    const out = []; for await (const r of seriesConnector([spec]).fetchRecords({ baseUrl: "https://api.example", http: h })) out.push(r);
    const r = out[0]!;
    expect(r).toMatchObject({ externalKey: "series:prices", kind: "observation", originalAgency: "Central Bank", eventTime: "2025-01-01T00:00:00.000Z" });
    expect(r.facts).toHaveLength(3);
    expect(r.facts![0]).toMatchObject({ subject: "prices|Oil=Light", predicate: "USD per Barrel", value: 80.5, unit: "USD per barrel", unitStated: true, validTime: "2024-01-01T00:00:00.000Z", dims: { period: 2024, Oil: "Light" } });
    expect(r.facts!.find(f => f.predicate === "Daily")).toMatchObject({ unit: null, unitStated: false });
    expect(r.payload.nullMeasures).toBe(1);
  });
  it("validates observation records: empty and stale series are flagged", () => {
    const src = { status: "approved", licence_verified: true, base_url: "https://p", freshness_limit_ms: 1 };
    const base = { externalKey: "series:x", kind: "observation" as const, originalAgency: "A", sourceUrl: "https://p/x", eventTime: "2026-09-01T00:00:00.000Z", payload: { a: 1 }, series: { key: "x", title: "x", frequency: "monthly" as const, packs: [], maxAgeDays: 90, query: {} } };
    const f = { subject: "x", predicate: "p", value: 1, validTime: "2026-09-01T00:00:00.000Z" };
    expect(validateRecord({ ...base, facts: [f] }, src, new Date("2026-11-10T00:00:00Z")).outcome).toBe("accepted");
    expect(validateRecord({ ...base, facts: [] }, src, new Date("2026-11-10T00:00:00Z")).outcome).toBe("quarantined");
    expect(validateRecord({ ...base, facts: [f] }, src, new Date("2027-03-10T00:00:00Z"))).toMatchObject({ outcome: "warned", reason: "latest_observation_age" });
    expect(validateRecord({ ...base, facts: [{ ...f, validTime: "bad" }] }, src, new Date("2026-11-10T00:00:00Z")).outcome).toBe("quarantined");
  });
});

import { parseImfSheet, parseJodiCsv } from "../packages/connectors/src/index.js";

describe("file parsers", () => {
  it("imf: reads codes, units and months; blanks are missing, not zero", () => {
    const grid: unknown[][] = [
      ["Commodity", "POILBRE", "POILAPSP", "PBAD"],
      ["Commodity.Description", "Crude Oil (petroleum),  Dated Brent, light blend 38 API, fob U.K., US$ per barrel", "Crude Oil (petroleum), Price index, 2016 = 100, simple average", "Odd, no unit text"],
      ["Data Type", "USD", "Index", "USD"],
      ["Frequency", "Monthly", "Monthly", "Monthly"],
      ["2026M8", 68.5, 140.2, null],
      ["2026M10", 71, "", 3],
      ["not a month", 1, 1, 1],
    ];
    const p = parseImfSheet(grid);
    expect(p.facts).toHaveLength(4); expect(p.missing).toBe(2); expect(p.latest).toBe("2026-10-01T00:00:00.000Z");
    const brent = p.facts.find(f => f.subject.endsWith("POILBRE") && f.validTime!.startsWith("2026-08"))!;
    expect(brent).toMatchObject({ predicate: "Price", value: 68.5, unit: "US$ per barrel", unitStated: true, dims: { commodity: "POILBRE", name: "Crude Oil (petroleum), Dated Brent" } });
    expect(p.facts.find(f => f.subject.endsWith("POILAPSP"))).toMatchObject({ predicate: "Price index", unit: "index (2016 = 100)" });
    expect(p.facts.find(f => f.subject.endsWith("PBAD"))!.unitStated).toBe(false);
  });
  const csv = ["REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE",
    "SA,2026-01,TOTCRUDE,INDPROD,KBD,9500.5,1", "SA,2026-01,TOTCRUDE,INDPROD,KBBL,294500,1", "SA,2026-02,TOTCRUDE,INDPROD,KBD,x,3",
    "AE,2026-02,TOTCRUDE,TOTEXPSB,KBD,-,3", "AE,2026-02,TOTCRUDE,CLOSTLV,KBBL,41000,2", "US,2026-01,TOTCRUDE,INDPROD,KBD,13000,1", "SA,2026-01,NGL,INDPROD,KBD,1000,1", "SA,bad,TOTCRUDE,INDPROD,KBD,1,1"].join("\n");
  it("jodi: keeps Gulf total crude, the right unit per flow, and treats x and - as missing", () => {
    const p = parseJodiCsv(csv);
    expect(p.facts.map(f => [f.dims!.country, f.predicate, f.value, f.unit])).toEqual([["SA", "Indigenous production", 9500.5, "thousand barrels per day"], ["AE", "Closing stocks", 41000, "thousand barrels"]]);
    expect(p.missing).toBe(2); expect(p.rows).toHaveLength(4); expect(p.latest).toBe("2026-02-01T00:00:00.000Z");
    expect(p.facts[0]!.dims).toMatchObject({ assessmentCode: "1", countryName: "Saudi Arabia" });
  });
  it("jodi: rejects an unexpected header instead of guessing", () => { expect(() => parseJodiCsv("A,B\n1,2")).toThrow(/unexpected JODI header/); });
});
