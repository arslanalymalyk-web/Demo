// Seeds one fresh institution for an end-to-end run: roles, people, approved sources and stored public records dated relative to today.
// It writes through the same ingestion pipeline the product uses, with a fake connector in place of the network.
import pg from "pg";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { ensureDefaultPolicy } from "../packages/governance/src/store.js";
import { provisionPrincipal } from "../packages/identity/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";

export const PEOPLE: Record<string, string[]> = {
  root: ["administrator", "analyst", "auditor", "approver"], admin1: ["administrator"], admin2: ["administrator"], ana: ["analyst"], exe: ["executive"], aud: ["auditor"], ops: ["operations"],
};
const id = process.env.E2E_INSTITUTION_ID, ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
if (!id || !ownerUrl || !appUrl) throw new Error("E2E_INSTITUTION_ID, DATABASE_URL_TEST_OWNER and DATABASE_URL_TEST are required");
const owner = new pg.Pool({ connectionString: ownerUrl }), app = new pg.Pool({ connectionString: appUrl });
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });

const monthStart = (back: number) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - back, 1)); };
const months = (n: number) => Array.from({ length: n }, (_, i) => monthStart(n - i).toISOString().slice(0, 10));
const quarters = () => { const n = new Date(), q0 = Math.floor(n.getUTCMonth() / 3) * 3; return Array.from({ length: 4 }, (_, i) => new Date(Date.UTC(n.getUTCFullYear(), q0 - 3 * (4 - i), 1)).toISOString().slice(0, 10)); };

const J = "jodi-gulf-crude-monthly", I = "imf-commodity-prices-monthly", R = "sama-reserve-assets-quarterly", T = "gastat-trade-balance-monthly", C = "gastat-cpi-monthly", M = "sama-money-supply-m3-monthly", G = "gastat-gdp-main-activities-quarterly";
const ser = (key: string, pack: string, subject: string, predicate: string, unit: string | undefined, pts: [string, number][], maxAgeDays = 400): RawRecord => ({
  externalKey: `series:${key}:${subject}:${predicate}`, kind: "observation", sourceUrl: "https://p.example/x", originalAgency: "Agency", eventTime: new Date().toISOString(), payload: { subject, predicate },
  series: { key, title: key, frequency: "monthly", packs: [pack], maxAgeDays, query: {} },
  facts: pts.map(([t, v]) => ({ subject, predicate, value: v, ...(unit ? { unit } : {}), validTime: `${t}T00:00:00Z`, dims: {}, unitStated: unit !== undefined })),
});

const SOURCES: [string, string, string][] = [[J, "energy-jodi-e2e", "files"], [I, "macro-imf-commodity-e2e", "files"], [R, "sama-reserves-e2e", "fake"], [T, "gastat-trade-e2e", "fake"], [C, "gastat-cpi-e2e", "fake"], [M, "sama-m3-e2e", "fake"], [G, "gastat-gdp-e2e", "fake"], ["stale-series", "stale-source-e2e", "fake"]];

await withTenant(owner, id, async c => {
  await c.query("INSERT INTO institutions (id, name) VALUES ($1,'End-to-end Institution')", [id]);
  for (const r of Object.keys(PEOPLE).flatMap(k => PEOPLE[k]!)) await c.query("INSERT INTO roles (institution_id, key, label) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING", [id, r]);
  for (const [, key, platform] of SOURCES) await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,$2,'Publisher','Agency',$3,'https://p.example','approved','CC BY',true)", [id, key, platform]);
});
const issuer = `http://127.0.0.1:${process.env.DEV_IDP_PORT ?? 4011}`;
for (const [sub, roles] of Object.entries(PEOPLE)) await withTenant(app, id, c => provisionPrincipal(c, id, { type: "system" }, { issuer, subject: sub, displayName: sub, roles }));

await withTenant(app, id, c => ensureDefaultPolicy(c, id));
for (const [sub, email] of [["admin1", "admin1@e2e.example"], ["aud", "aud@e2e.example"]]) await withTenant(app, id, c => c.query("UPDATE principals SET email = $2 WHERE idp_subject = $1", [sub, email]));
const src = (series: string) => SOURCES.find(s => s[0] === series)![1];
const ing = (series: string, rs: RawRecord[]) => runIngestion({ pool: app, institutionId: id, sourceKey: src(series), connector: { platform: "fake", async *fetchRecords() { for (const r of rs) yield r; } } as Connector, http: noNetwork });
const m14 = months(14), q = quarters();
const ex = (code: string, base: number, last: number) => ser(J, "energy", `${J}|country=${code}|flow=TOTEXPSB`, "Total exports", "thousand barrels per day", m14.map((t, i) => [t, i === 13 ? last : base]));
const pr = (code: string, v: number) => ser(J, "energy", `${J}|country=${code}|flow=INDPROD`, "Indigenous production", "thousand barrels per day", m14.map(t => [t, v]));
await ing(J, [ex("KW", 1000, 400), ex("SA", 7000, 4500), pr("KW", 2000), pr("SA", 9500)]);
await ing(I, [ser(I, "energy", `${I}|commodity=POILBRE`, "Price", "US$ per barrel", m14.map((t, i) => [t, i === 13 ? 100 : i === 12 ? 80 : 75]))]);
const comp: Record<string, number> = { "Foreign Currency and Deposits Abroad": 300_000, "Investment in Foreign Securities": 600_000, "Monetary Gold": 10_000, "Reserve Position in the IMF": 40_000, SDR: 50_000, "Total Reserves Assets": 1_000_000 };
await ing(R, Object.entries(comp).map(([k, v]) => ser(R, "sovereign_capital", `${R}|Reserve Assets=${k}`, "Million SAR", "million SAR", q.map((t, i) => [t, i === 3 ? v * 0.94 : v]))));
await ing(T, [ser(T, "sovereign_capital", T, "Trade Balance", undefined, m14.map((t, i) => [t, i === 13 ? 300 : 1000]))]);
await ing(C, [ser(C, "sovereign_capital", `${C}|Main Division=General Index`, "Inflation rate", "percent", m14.map((t, i) => [t, i === 13 ? 3.6 : 2]))]);
await ing(M, [ser(M, "sovereign_capital", M, "Million SAR", "million SAR", m14.map(t => [t, 3_000_000])), ser(M, "sovereign_capital", M, "Growth Rate", "percent", m14.map(t => [t, 9.5]))]);
await ing(G, [["Oil Activities", 300], ["Non-Oil Activities", 700], ["Government Activities", 200]].map(([a, v]) => ser(G, "sovereign_capital", `${G}|Main Economic Activities=${a}`, "Nominal GDP", undefined, q.map(t => [t, v as number]))));
await ing("stale-series", [ser("stale-series", "energy", "stale-series", "Value", "units", [["2024-01-01", 1]], 30)]);
await owner.end(); await app.end();
console.log(`seeded institution ${id}`);
