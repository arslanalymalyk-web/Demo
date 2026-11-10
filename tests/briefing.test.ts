import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { composeBriefing, verifyBriefing, type ComposeInput } from "../packages/sectors/src/index.js";
import type { SectorView } from "../packages/sectors/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";

const view = (over: Partial<SectorView> = {}): SectorView => ({
  pack: "energy", name: "Energy and Oil", asOf: "2026-11-10T00:00:00.000Z", rulesVersion: "signal-rules/1", settingsVersion: 1,
  figures: [{ id: "brent", label: "Brent crude", value: 80, unit: "US$ per barrel", period: "2026-10-01T00:00:00Z", change: { text: "+3.0% on the month", direction: "up" }, evidenceId: "ev-b", validation: "accepted" }],
  trends: [], signals: [], rules: [], freshness: [], ...over,
});
const sig = (id: string, severity: "alert" | "watch") => ({ id, ruleId: "E1", severity, title: id, detail: "d", observedAt: "2026-10-01T00:00:00Z", evidenceIds: ["ev-s"], values: {} });
const input = (v: SectorView, over: Partial<ComposeInput> = {}): ComposeInput => ({ view: v, cases: [], runs: [], templates: [{ key: "oil-price-shock", pack: "energy", title: "Oil price shock" }, { key: "reserve-runway", pack: "sovereign", title: "Reserve runway" }], viewerId: "u", ...over });

describe("briefing composition", () => {
  it("says what the data supports: clear, watch, attention, or no data", () => {
    expect(composeBriefing(input(view())).headline).toMatchObject({ level: "clear" });
    expect(composeBriefing(input(view({ signals: [sig("a", "watch")] }))).headline).toMatchObject({ level: "watch", text: "1 item is on watch. No alert is raised." });
    expect(composeBriefing(input(view({ signals: [sig("a", "alert"), sig("b", "alert"), sig("c", "watch")] }))).headline.text).toBe("2 alerts need attention, and 1 more item is on watch.");
    expect(composeBriefing(input(view({ figures: [] }))).headline.level).toBe("no_data");
  });

  it("links a signal to its open case, and leaves closed cases out", () => {
    const cases = [
      { id: "c1", case_key: "CASE-1", title: "t", domain: "energy", state: "in_review", signal_id: "a", reviewer_id: "r", updated_at: "2026-11-01T00:00:00Z" },
      { id: "c2", case_key: "CASE-2", title: "t", domain: "energy", state: "closed", signal_id: "b", reviewer_id: null, updated_at: "2026-11-01T00:00:00Z" },
      { id: "c3", case_key: "CASE-3", title: "t", domain: "treasury", state: "open", signal_id: null, reviewer_id: null, updated_at: "2026-11-01T00:00:00Z" },
    ];
    const b = composeBriefing(input(view({ signals: [sig("a", "alert"), sig("b", "watch")] }), { cases }));
    expect(b.signals.find(s => s.id === "a")).toMatchObject({ caseId: "c1", caseKey: "CASE-1" });
    expect(b.signals.find(s => s.id === "b")!.caseId).toBeNull();
    expect(b.openCases).toEqual([expect.objectContaining({ caseKey: "CASE-1", waitingFor: "reviewer" })]);
  });

  it("omits cases and scenarios the reader may not see, rather than showing them empty", () => {
    const b = composeBriefing(input(view(), { cases: null, runs: null }));
    expect(b.openCases).toBeNull();
    expect(b.scenarios).toBeNull();
  });

  it("lists this pack's scenarios with the latest run, labelled as a Scenario simulation", () => {
    const b = composeBriefing(input(view(), { runs: [{ id: "r2", template_key: "oil-price-shock", confidence: "medium", created_at: "2026-11-02T00:00:00Z" }, { id: "r1", template_key: "oil-price-shock", confidence: "low", created_at: "2026-10-01T00:00:00Z" }] }));
    expect(b.scenarios).toEqual([{ key: "oil-price-shock", title: "Oil price shock", runId: "r2", confidence: "medium", ranAt: "2026-11-02T00:00:00Z", label: "Scenario simulation" }]);
  });

  it("reports stale, lagging and unvalidated data as caveats, never as current", () => {
    const b = composeBriefing(input(view({
      freshness: [
        { seriesKey: "s1", title: "Old series", frequency: "monthly", maxAgeDays: 60, latestPeriod: "2026-05-01T00:00:00Z", validation: "accepted", evidenceId: "e1", sourceKey: "x" },
        { seriesKey: "s2", title: "Empty series", frequency: "monthly", maxAgeDays: 60, latestPeriod: null, validation: null, evidenceId: null, sourceKey: "x" },
        { seriesKey: "s3", title: "Warned series", frequency: "monthly", maxAgeDays: 60, latestPeriod: "2026-10-01T00:00:00Z", validation: "warned", evidenceId: "e3", sourceKey: "x" },
        { seriesKey: "s4", title: "Fine series", frequency: "monthly", maxAgeDays: 60, latestPeriod: "2026-10-01T00:00:00Z", validation: "accepted", evidenceId: "e4", sourceKey: "x" },
      ],
      countries: [{ lagging: true, code: "IQ", name: "Iraq", exportsKbd: 1, medianKbd: 1, changePct: null, productionKbd: null, period: "2024-03-01T00:00:00Z", evidenceId: "iq" }],
    })));
    expect(b.caveats.map(c => c.kind).sort()).toEqual(["lagging", "stale", "stale", "unvalidated"]);
    expect(b.caveats.find(c => c.kind === "lagging")!.text).toMatch(/Iraq: no data since 2024-03/);
  });

  it("carries a content hash that detects any change to a saved copy", () => {
    const b = composeBriefing(input(view({ signals: [sig("a", "alert")] })));
    expect(verifyBriefing(b)).toBe(true);
    expect(verifyBriefing({ ...b, headline: { ...b.headline, text: "All is well." } })).toBe(false);
    expect(composeBriefing(input(view({ signals: [sig("a", "alert")] }))).contentHash).toBe(b.contentHash);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("briefing route", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  it("serves a verifiable briefing to a reader, refuses unknown packs and unauthenticated calls", async () => {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'B')", [id]); });
    const tokens = { ana: await addUser(owner, app, id, "ana", ["analyst"]) };
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier() });
    const get = (url: string, tok?: string) => server.inject({ method: "GET", url, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    const ok = await get("/v1/briefings/energy", tokens.ana);
    expect(ok.statusCode).toBe(200);
    const b = ok.json();
    expect(b).toMatchObject({ pack: "energy", dataClass: "public_record", headline: { level: "no_data" } });
    expect(verifyBriefing(b)).toBe(true);
    expect(Array.isArray(b.openCases)).toBe(true);
    expect((await get("/v1/briefings/nope", tokens.ana)).statusCode).toBe(404);
    expect((await get("/v1/briefings/energy")).statusCode).toBe(401);
    await server.close();
  });
});
