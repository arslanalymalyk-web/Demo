import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { PostgresGraph } from "../packages/graph/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { resolveParams } from "../packages/scenario/src/index.js";
import { DEFAULT_THRESHOLDS } from "../packages/sectors/src/index.js";
import { SCHEMAS, signalRulesSchema } from "../packages/settings/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";

describe("settings schemas", () => {
  it("accepts the shipped defaults and rejects reversed or out-of-range thresholds", () => {
    expect(signalRulesSchema.safeParse(DEFAULT_THRESHOLDS).success).toBe(true);
    const bad = (patch: object) => signalRulesSchema.safeParse({ ...DEFAULT_THRESHOLDS, ...patch }).success;
    expect(bad({ E1: { minMedian: 100, watch: 0.5, alert: 0.2 } })).toBe(false);
    expect(bad({ S2: { watchBelow: 0.1, alertBelow: 0.2 } })).toBe(false);
    expect(bad({ S4: { watch: 3, alert: 150 } })).toBe(false);
    expect(bad({ E2: { watch: 0, alert: 0.2 } })).toBe(false);
    expect(bad({ E9: { watch: 0.1, alert: 0.2 } })).toBe(false);
  });
  it("requires evidence for any value that claims a source, and keeps ranges honest", () => {
    const one = { value: 5, low: 1, high: 9, note: "from the ministry statement" };
    expect(SCHEMAS.scenario_defaults.safeParse({ "reserve-runway": { annualGapUsdBn: { ...one, basis: "assumed" } } }).success).toBe(true);
    expect(SCHEMAS.scenario_defaults.safeParse({ "reserve-runway": { annualGapUsdBn: { ...one, basis: "sourced" } } }).success).toBe(false);
    expect(SCHEMAS.scenario_defaults.safeParse({ "reserve-runway": { annualGapUsdBn: { ...one, value: 20, basis: "assumed" } } }).success).toBe(false);
    expect(SCHEMAS.scenario_defaults.safeParse({ "reserve-runway": { annualGapUsdBn: { ...one, basis: "calibrated" } } }).success).toBe(false);
    const ex = { hormuzShare: 0.5, spareBypassKbd: 100, rationale: "planning placeholder under review", basis: "sourced" as const };
    expect(SCHEMAS.hormuz_exposure.safeParse({ SA: ex }).success).toBe(false);
    expect(SCHEMAS.hormuz_exposure.safeParse({ SA: { ...ex, evidenceId: randomUUID() } }).success).toBe(true);
    expect(SCHEMAS.hormuz_exposure.safeParse({ SA: { ...ex, basis: "assumed", hormuzShare: 1.4 } }).success).toBe(false);
    expect(SCHEMAS.hormuz_exposure.safeParse({ saudi: { ...ex, basis: "assumed" } }).success).toBe(false);
  });
  it("replaces a scenario default and says where the new value came from", () => {
    const set = { version: 3, defaults: { "reserve-runway": { annualGapUsdBn: { value: 60, low: 20, high: 120, basis: "assumed" as const, note: "Tiger planning figure" } } } };
    const ps = resolveParams("reserve-runway", {}, null, set);
    expect(ps.annualGapUsdBn).toMatchObject({ value: 60, low: 20, high: 120, basis: "assumed" });
    expect(ps.annualGapUsdBn!.note).toMatch(/Tiger planning figure \(institution setting v3\)/);
    expect(resolveParams("reserve-runway", { annualGapUsdBn: 80 }, null, set).annualGapUsdBn!.value).toBe(80); // a run's own override still wins
    expect(resolveParams("reserve-runway", {}, null).annualGapUsdBn!.value).toBe(40); // no setting, code default
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });
const ser = (key: string, pack: string, subject: string, predicate: string, unit: string, pts: [string, number][]): RawRecord => ({
  externalKey: `series:${key}:${subject}:${predicate}`, kind: "observation", sourceUrl: "https://p.example/x", originalAgency: "Agency", eventTime: "2026-06-01T00:00:00Z", payload: { subject },
  series: { key, title: key, frequency: "monthly", packs: [pack], query: {} }, facts: pts.map(([t, v]) => ({ subject, predicate, value: v, unit, validTime: `${t}T00:00:00Z`, dims: {}, unitStated: true })),
});
const J = "jodi-gulf-crude-monthly", R = "sama-reserve-assets-quarterly";
const m14 = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 7 - 13 + i, 1)).toISOString().slice(0, 10));

suite("governed settings against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene() {
    const id = randomUUID(), jk = `jodi-${id.slice(0, 5)}`, rk = `res-${id.slice(0, 5)}`;
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Set')", [id]);
      for (const k of [jk, rk]) await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,$2,'P','Agency','fake','https://p.example','approved','CC BY',true)", [id, k]);
    });
    const ing = (k: string, rs: RawRecord[]) => runIngestion({ pool: app, institutionId: id, sourceKey: k, connector: { platform: "fake", async *fetchRecords() { for (const r of rs) yield r; } } as Connector, http: noNetwork, now: () => new Date("2026-11-10T00:00:00Z") });
    await ing(jk, [ser(J, "energy", `${J}|country=KW|flow=TOTEXPSB`, "Total exports", "thousand barrels per day", m14.map((t, i) => [t, i === 13 ? 400 : 1000] as [string, number]))]);
    const comp: Record<string, number> = { "Foreign Currency and Deposits Abroad": 300_000, "Investment in Foreign Securities": 600_000, "Monetary Gold": 10_000, "Reserve Position in the IMF": 40_000, SDR: 50_000, "Total Reserves Assets": 1_000_000 };
    await ing(rk, Object.entries(comp).map(([k, v]) => ser(R, "sovereign_capital", `${R}|Reserve Assets=${k}`, "Million SAR", "million SAR", ["2025-10-01", "2026-01-01", "2026-04-01", "2026-07-01"].map(t => [t, v] as [string, number]))));
    const evId = await withTenant(app, id, async c => (await c.query("SELECT id FROM evidence_objects ORDER BY retrieved_at LIMIT 1")).rows[0].id as string);
    await withTenant(app, id, async c => {
      const g = new PostgresGraph(c, id);
      await g.upsertEntity({ kind: "chokepoint", key: "chokepoint:hormuz", name: "Hormuz" });
      for (const code of ["SA", "KW"]) {
        await g.upsertEntity({ kind: "country", key: `country:${code}`, name: code, attrs: { code } });
        await g.addLink({ subject: "chokepoint:hormuz", predicate: "constrains_exports_of", object: `country:${code}`, linkClass: "assumed", rationale: "planning placeholder", params: { hormuzShare: 0.5, spareBypassKbd: 1000 } });
      }
    });
    const tok = { adam: await addUser(owner, app, id, "adam", ["administrator"]), adel: await addUser(owner, app, id, "adel", ["administrator"]), ana: await addUser(owner, app, id, "ana", ["analyst"]), ed: await addUser(owner, app, id, "ed", ["executive"]) };
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const call = async (who: keyof typeof tok, method: string, url: string, payload?: object) => { const r = await server.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${tok[who]}` }, ...(payload ? { payload } : {}) }); let body: any = null; try { body = r.json(); } catch { /* none */ } return { status: r.statusCode, body }; };
    return { id, call, evId };
  }
  const T = { ...DEFAULT_THRESHOLDS, E1: { minMedian: 100, watch: 0.5, alert: 0.7 } };

  it("lists the scopes, the catalog and the current exposure, and keeps writing to administrators", async () => {
    const s = await scene();
    const g = await s.call("ed", "GET", "/v1/settings");
    expect(g.status).toBe(200);
    expect(g.body.scopes.map((x: { scope: string }) => x.scope)).toEqual(["signal_rules", "scenario_defaults", "hormuz_exposure"]);
    expect(g.body.catalog.map((t: { key: string }) => t.key)).toContain("reserve-runway");
    expect(g.body.exposure).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SA", linkClass: "assumed", hormuzShare: 0.5 })]));
    expect(g.body.scopes[0].defaults.E1.watch).toBe(0.2);
    expect((await s.call("ana", "POST", "/v1/settings/signal_rules", { payload: T, note: "a note that is long enough" })).status).toBe(403);
    expect((await s.call("adam", "POST", "/v1/settings/nope", { payload: T, note: "a note that is long enough" })).status).toBe(404);
  });

  it("changes what the sector rules raise only once a different administrator activates it, and says which version it used", async () => {
    const s = await scene();
    const before = (await s.call("ana", "GET", "/v1/sectors/energy")).body;
    expect(before.signals.find((x: { id: string }) => x.id.startsWith("E1:KW"))).toMatchObject({ severity: "alert" });
    expect(before.settingsVersion).toBeNull();
    const d = await s.call("adam", "POST", "/v1/settings/signal_rules", { payload: T, note: "Tiger sets the country export levels higher" });
    expect(d.status).toBe(201); expect(d.body).toMatchObject({ version: 1, status: "draft" });
    expect((await s.call("ana", "GET", "/v1/sectors/energy")).body.settingsVersion).toBeNull(); // a draft changes nothing
    expect((await s.call("adam", "POST", `/v1/settings/versions/${d.body.id}/activate`)).status).toBe(403);
    expect((await s.call("adel", "POST", `/v1/settings/versions/${d.body.id}/activate`)).body).toMatchObject({ status: "active", activatedBy: expect.any(String) });
    const after = (await s.call("ana", "GET", "/v1/sectors/energy")).body;
    expect(after.settingsVersion).toBe(1);
    expect(after.signals.find((x: { id: string }) => x.id.startsWith("E1:KW"))).toMatchObject({ severity: "watch" });
    expect(after.rules.find((r: { id: string }) => r.id === "E1").thresholds).toBe("Watch at 50% below, alert at 70% below.");
    const sig = after.signals.find((x: { id: string }) => x.id.startsWith("E1:KW"));
    const c = await s.call("ana", "POST", `/v1/sectors/energy/signals/${encodeURIComponent(sig.id)}/case`);
    expect((await s.call("ana", "GET", `/v1/cases/${c.body.id}`)).body.signal).toMatchObject({ rulesVersion: "signal-rules/1", settingsVersion: 1 });
  });

  it("retires the earlier version when a new one is activated, and refuses a second activation", async () => {
    const s = await scene();
    const a = (await s.call("adam", "POST", "/v1/settings/signal_rules", { payload: T, note: "first version of the thresholds" })).body;
    await s.call("adel", "POST", `/v1/settings/versions/${a.id}/activate`);
    const b = (await s.call("adel", "POST", "/v1/settings/signal_rules", { payload: { ...T, S4: { watch: 2, alert: 4 } }, note: "second version of the thresholds" })).body;
    expect((await s.call("adam", "POST", `/v1/settings/versions/${b.id}/activate`)).status).toBe(200);
    expect((await s.call("adam", "POST", `/v1/settings/versions/${b.id}/activate`)).status).toBe(409);
    const list = (await s.call("adam", "GET", "/v1/settings")).body.scopes[0].versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`).sort();
    expect(list).toEqual(["1:retired", "2:active"]);
  });

  it("rejects invalid drafts with the reason", async () => {
    const s = await scene();
    const post = (scope: string, payload: unknown, note = "a long enough reason") => s.call("adam", "POST", `/v1/settings/${scope}`, { payload, note });
    expect((await post("signal_rules", { ...T, E1: { minMedian: 100, watch: 0.8, alert: 0.2 } })).body.message).toMatch(/alert level must be larger/);
    expect((await post("signal_rules", T, "short")).status).toBe(422);
    expect((await post("scenario_defaults", { "nope-template": { x: { value: 1, low: 0, high: 2, basis: "assumed", note: "a note" } } })).body.message).toMatch(/unknown scenario template/);
    expect((await post("scenario_defaults", { "reserve-runway": { nothing: { value: 1, low: 0, high: 2, basis: "assumed", note: "a note" } } })).body.message).toMatch(/unknown parameter nothing/);
    expect((await post("scenario_defaults", { "reserve-runway": { annualGapUsdBn: { value: 1, low: 0, high: 2, basis: "sourced", note: "a note", evidenceId: randomUUID() } } })).body.message).toMatch(/evidence not found/);
    expect((await post("hormuz_exposure", { AE: { hormuzShare: 0.5, spareBypassKbd: 0, basis: "assumed", rationale: "not in the graph at all" } })).body.message).toMatch(/not in the graph: AE/);
    expect((await post("hormuz_exposure", { SA: { hormuzShare: 0.5, spareBypassKbd: 0, basis: "sourced", rationale: "needs evidence to claim a source" } })).status).toBe(422);
  });

  it("applies scenario defaults to new runs, and the run records the version and the new values", async () => {
    const s = await scene();
    const d = (await s.call("adam", "POST", "/v1/settings/scenario_defaults", { note: "Tiger's planning figure for the gap", payload: { "reserve-runway": { annualGapUsdBn: { value: 60, low: 20, high: 120, basis: "assumed", note: "Tiger planning figure" } } } })).body;
    await s.call("adel", "POST", `/v1/settings/versions/${d.id}/activate`);
    const made = await s.call("ana", "POST", "/v1/scenarios/runs", { template: "reserve-runway", baselineMonth: "2026-08" });
    expect(made.status).toBe(201);
    const run = (await s.call("ana", "GET", `/v1/scenarios/runs/${made.body.id}`)).body;
    expect(run.assumptions.annualGapUsdBn).toMatchObject({ value: 60, low: 20, high: 120 });
    expect(run.assumptions.annualGapUsdBn.note).toMatch(/institution setting v1/);
    expect(run.inputs.settings).toEqual({ scenarioDefaultsVersion: 1 });
    expect((await s.call("ana", "POST", `/v1/scenarios/runs/${made.body.id}/replay`)).body).toMatchObject({ resultsMatch: true, manifestMatches: true });
  });

  it("writes Hormuz exposure into the graph with the link class its basis states, citing evidence", async () => {
    const s = await scene();
    const payload = { SA: { hormuzShare: 0.42, spareBypassKbd: 2500, basis: "sourced", evidenceId: s.evId, rationale: "Terminal and pipeline capacity from the stored statistical release" }, KW: { hormuzShare: 1, spareBypassKbd: 0, basis: "assumed", rationale: "All exports leave through the Gulf terminals; still a planning value" } };
    const d = (await s.call("adam", "POST", "/v1/settings/hormuz_exposure", { payload, note: "Replace the placeholders with reviewed values" })).body;
    const edges = async () => (await s.call("ana", "GET", "/v1/graph/entities/chokepoint:hormuz/paths?depth=1")).body as { edges: { to: string; linkClass: string; params: Record<string, number>; evidence: string[] }[] }[];
    expect((await edges()).find(p => p.edges[0]!.to === "country:SA")!.edges[0]).toMatchObject({ linkClass: "assumed", params: { hormuzShare: 0.5 } });
    await s.call("adel", "POST", `/v1/settings/versions/${d.id}/activate`);
    const after = await edges();
    expect(after).toHaveLength(2); // the old links were retired, not duplicated
    expect(after.find(p => p.edges[0]!.to === "country:SA")!.edges[0]).toMatchObject({ linkClass: "sourced", params: { hormuzShare: 0.42, spareBypassKbd: 2500 }, evidence: [s.evId] });
    expect(after.find(p => p.edges[0]!.to === "country:KW")!.edges[0]).toMatchObject({ linkClass: "assumed", params: { hormuzShare: 1 } });
    const ev = await withTenant(app, s.id, async c => (await c.query("SELECT payload FROM audit_events WHERE action = 'settings.activated'")).rows[0].payload);
    expect(ev).toMatchObject({ scope: "hormuz_exposure", version: 1, graphLinksWritten: 2 });
    expect((await s.call("ana", "GET", "/v1/settings")).body.exposure.find((x: { code: string }) => x.code === "SA")).toMatchObject({ linkClass: "sourced", hormuzShare: 0.42 });
  });

  it("is immutable in the database, audited, and private to its institution", async () => {
    const a = await scene(), b = await scene();
    const d = (await a.call("adam", "POST", "/v1/settings/signal_rules", { payload: T, note: "a long enough reason here" })).body;
    const attempt = (sql: string) => expect(withTenant(app, a.id, c => c.query(sql))).rejects.toThrow();
    await attempt("UPDATE settings_versions SET payload = '{}'");
    await attempt("UPDATE settings_versions SET note = 'edited after the fact'");
    await attempt("DELETE FROM settings_versions");
    await attempt("UPDATE settings_versions SET status = 'retired'"); // a draft cannot skip to retired
    const acts = await withTenant(app, a.id, async c => (await c.query("SELECT action FROM audit_events WHERE action LIKE 'settings.%'")).rows.map(r => r.action));
    expect(acts).toEqual(["settings.drafted"]);
    expect((await b.call("adam", "GET", "/v1/settings")).body.scopes[0].versions).toEqual([]);
    expect((await b.call("adel", "POST", `/v1/settings/versions/${d.id}/activate`)).status).toBe(404);
  });
});
