import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { PoliteHttp, type Connector } from "../packages/connectors/src/index.js";
import type { RawRecord } from "../packages/core/src/index.js";
import { runIngestion } from "../packages/ingest/src/pipeline.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { SchedulerError, Scheduler, claimDue, classify, freshness, nextAfterFailure, nextAfterSuccess, pauseSource, resumeSource, retryDelayMs, shouldPause, sourceHealth, syncSchedule, type RunJob } from "../packages/scheduler/src/index.js";
import { SettingsError, activate, createDraft, type IngestionSchedule } from "../packages/settings/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";

const MIN = 60_000, HOUR = 3_600_000;
const T0 = new Date("2026-11-10T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("scheduling rules", () => {
  it("retries soon after a failure, then backs off, and never waits longer than the normal interval", () => {
    expect([1, 2, 3, 4, 5].map(n => retryDelayMs(n, 24) / MIN)).toEqual([15, 30, 60, 120, 240]);
    expect(retryDelayMs(3, 1) / MIN).toBe(60);
    expect(retryDelayMs(9, 2) / MIN).toBe(120);
    expect(retryDelayMs(500, 24) / HOUR).toBe(24);
    expect(retryDelayMs(0, 24) / MIN).toBe(15);
  });
  it("places the next run after the interval on success and after the back-off on failure", () => {
    expect(nextAfterSuccess(T0, 6).toISOString()).toBe("2026-11-10T06:00:00.000Z");
    expect(nextAfterFailure(T0, 2, 24).toISOString()).toBe("2026-11-10T00:30:00.000Z");
  });
  it("pauses at the limit and not before", () => { expect(shouldPause(5, 6)).toBe(false); expect(shouldPause(6, 6)).toBe(true); });
  it("judges a series stale only when its latest period is older than it allows, or missing", () => {
    expect(freshness({ seriesKey: "s", title: "S", latestPeriod: "2026-10-01T00:00:00Z", maxAgeDays: 60 }, T0)).toMatchObject({ ageDays: 40, stale: false });
    expect(freshness({ seriesKey: "s", title: "S", latestPeriod: "2026-08-01T00:00:00Z", maxAgeDays: 60 }, T0)).toMatchObject({ ageDays: 101, stale: true });
    expect(freshness({ seriesKey: "s", title: "S", latestPeriod: null, maxAgeDays: 60 }, T0).stale).toBe(true);
    expect(freshness({ seriesKey: "s", title: "S", latestPeriod: "2020-01-01T00:00:00Z", maxAgeDays: null }, T0).stale).toBe(false);
  });
  it("names a source by what matters most", () => {
    const stale = freshness({ seriesKey: "s", title: "Brent", latestPeriod: "2026-01-01T00:00:00Z", maxAgeDays: 60 }, T0), fresh = freshness({ seriesKey: "f", title: "F", latestPeriod: "2026-11-01T00:00:00Z", maxAgeDays: 60 }, T0);
    const base = { approved: true, paused: false, failureStreak: 0, series: [fresh], hasSuccess: true };
    expect(classify(base).health).toBe("healthy");
    expect(classify({ ...base, series: [fresh, stale] })).toMatchObject({ health: "stale", reasons: [expect.stringMatching(/Brent: latest period is 313 days old/)] });
    expect(classify({ ...base, failureStreak: 2 }).health).toBe("healthy");
    expect(classify({ ...base, failureStreak: 3, series: [stale] }).health).toBe("failing");
    expect(classify({ ...base, paused: true, failureStreak: 6 }).health).toBe("paused");
    expect(classify({ ...base, approved: false, paused: true }).health).toBe("not_approved");
    expect(classify({ ...base, series: [], hasSuccess: false }).health).toBe("no_data");
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const noNetwork = new PoliteHttp({ fetchImpl: (async () => { throw new Error("network not expected"); }) as typeof fetch, minIntervalMs: 0 });
const oldSeries = (key: string, latest: string): Connector => ({ platform: "fake", async *fetchRecords() { const r: RawRecord = { externalKey: `series:${key}`, kind: "observation", sourceUrl: "https://p.example/x", originalAgency: "Agency", eventTime: "2026-01-01T00:00:00Z", payload: { subject: key, predicate: "v" }, series: { key, title: `Series ${key}`, frequency: "monthly", packs: ["energy"], maxAgeDays: 30, query: {} }, facts: [{ subject: key, predicate: "v", value: 1, unit: "u", validTime: latest, dims: {}, unitStated: true }] }; yield r; } });

suite("scheduler against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  const SRC = "energy-jodi-test", SRC2 = "macro-imf-commodity-test";
  async function world() {
    const id = randomUUID();
    await withTenant(owner, id, async c => {
      await c.query("INSERT INTO institutions (id, name) VALUES ($1,'S')", [id]);
      for (const [k, st] of [[SRC, "approved"], [SRC2, "approved"], ["pending-one-jodi", "pending_rights"]] as const)
        await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,$2,$3,'P','Agency','files','https://p.example',$4,'CC BY',true)", [id, k, `Name ${k}`, st]);
    });
    const tokens = { a1: await addUser(owner, app, id, "a1", ["administrator"]), a2: await addUser(owner, app, id, "a2", ["administrator"]), ana: await addUser(owner, app, id, "ana", ["analyst"]), ops: await addUser(owner, app, id, "ops", ["operations"]), exe: await addUser(owner, app, id, "exe", ["executive"]) };
    const pid = async (sub: string) => withTenant(app, id, async c => (await c.query("SELECT id FROM principals WHERE idp_subject = $1", [sub])).rows[0].id as string);
    const ids = { a1: await pid("a1"), a2: await pid("a2"), ana: await pid("ana"), exe: await pid("exe") };
    return { id, tokens, ids };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const schedule = async (w: W, s: Partial<IngestionSchedule>) => {
    const payload: IngestionSchedule = { steward: null, pauseAfterFailures: 3, sources: { [SRC]: { intervalHours: 24, mode: "series" } }, ...s };
    const v = await withTenant(app, w.id, c => createDraft(c, w.id, { id: w.ids.a1 }, "ingestion_schedule", payload, "Schedule for the test", { templates: {} }));
    await withTenant(app, w.id, c => activate(c, w.id, { id: w.ids.a2 }, v.id));
  };
  const sched = (w: W, run: RunJob, extra: { now: () => Date; runTimeoutMs?: number }) => new Scheduler({ pool: app, institutionId: w.id, run, ...extra });
  const row = (w: W, key = SRC) => withTenant(app, w.id, async c => (await c.query("SELECT sc.* FROM source_schedule sc JOIN sources s ON s.id = sc.source_id WHERE s.source_key = $1", [key])).rows[0]);
  const actions = (w: W) => withTenant(app, w.id, async c => (await c.query("SELECT action FROM audit_events WHERE action LIKE 'scheduler.%' ORDER BY id")).rows.map(r => r.action as string));

  it("accepts only schedules that name approved sources with a connector and a steward who can own cases", async () => {
    const w = await world();
    const draft = (p: Partial<IngestionSchedule>) => withTenant(app, w.id, c => createDraft(c, w.id, { id: w.ids.a1 }, "ingestion_schedule", { steward: null, pauseAfterFailures: 3, sources: { [SRC]: { intervalHours: 24, mode: "series" } }, ...p }, "Schedule for the test", { templates: {} }));
    await expect(draft({ sources: { "no-such-source": { intervalHours: 24, mode: "series" } } })).rejects.toThrow(/unknown source/);
    await expect(draft({ sources: { "pending-one-jodi": { intervalHours: 24, mode: "series" } } })).rejects.toThrow(/only approved sources/);
    await expect(draft({ sources: { [SRC]: { intervalHours: 24, mode: "catalog" } } })).rejects.toThrow(/no catalog connector/);
    await expect(draft({ steward: w.ids.exe })).rejects.toThrow(/can own cases/);
    await expect(draft({ steward: randomUUID() })).rejects.toThrow(/not an active person/);
    await expect(draft({ sources: { [SRC]: { intervalHours: 0, mode: "series" } } })).rejects.toThrow(SettingsError);
    await expect(draft({ pauseAfterFailures: 1 })).rejects.toThrow(SettingsError);
    expect((await draft({ steward: w.ids.ana })).status).toBe("draft");
  });

  it("runs nothing until a schedule is activated, then runs each source when due and not before", async () => {
    const w = await world(); let now = T0; const ran: string[] = [];
    const s = sched(w, async k => { ran.push(k.sourceKey); }, { now: () => now });
    expect((await s.tick()).ran).toEqual([]);
    await schedule(w, {});
    expect((await s.tick()).ran).toEqual([{ source: SRC, ok: true }]);
    expect((await s.tick()).ran).toEqual([]);
    expect((await row(w)).next_run_at.toISOString()).toBe(at(24 * HOUR).toISOString());
    now = at(23 * HOUR); expect((await s.tick()).ran).toEqual([]);
    now = at(25 * HOUR); expect((await s.tick()).ran).toHaveLength(1);
    expect(ran).toEqual([SRC, SRC]);
    expect((await row(w)).last_success_at.toISOString()).toBe(at(25 * HOUR).toISOString());
    expect(await actions(w)).toEqual(["scheduler.run_succeeded", "scheduler.run_succeeded"]);
  });

  it("backs off after a failure, pauses after the limit, and resumes only on a person's word", async () => {
    const w = await world(); let now = T0;
    const s = sched(w, async () => { throw new Error("upstream said 503"); }, { now: () => now });
    await schedule(w, {});
    expect((await s.tick()).ran[0]).toMatchObject({ ok: false, error: "upstream said 503" });
    expect(await row(w)).toMatchObject({ consecutive_failures: 1, paused: false, last_error: "upstream said 503" });
    expect((await row(w)).next_run_at.toISOString()).toBe(at(15 * MIN).toISOString());
    expect((await s.tick()).ran).toEqual([]);
    now = at(15 * MIN); await s.tick();
    expect((await row(w)).next_run_at.toISOString()).toBe(at(45 * MIN).toISOString());
    now = at(45 * MIN); await s.tick();
    expect(await row(w)).toMatchObject({ consecutive_failures: 3, paused: true, next_run_at: null });
    expect((await row(w)).paused_reason).toMatch(/after 3 failed fetches/);
    expect(await actions(w)).toEqual(["scheduler.run_failed", "scheduler.run_failed", "scheduler.auto_paused"]);
    now = at(100 * HOUR); expect((await s.tick()).ran).toEqual([]);
    await expect(withTenant(app, w.id, c => resumeSource(c, w.id, w.ids.a1, SRC, "short", now))).rejects.toThrow(/at least 10/);
    await withTenant(app, w.id, c => resumeSource(c, w.id, w.ids.a1, SRC, "Upstream is back, confirmed with the publisher", now));
    expect(await row(w)).toMatchObject({ consecutive_failures: 0, paused: false });
    await expect(withTenant(app, w.id, c => resumeSource(c, w.id, w.ids.a1, SRC, "Upstream is back, confirmed again", now))).rejects.toThrow(/not paused/);
    expect((await s.tick()).ran).toHaveLength(1);
  });

  it("lets a person pause a healthy source, and keeps it paused through schedule changes", async () => {
    const w = await world(); let now = T0; const ran: string[] = [];
    const s = sched(w, async k => { ran.push(k.sourceKey); }, { now: () => now });
    await schedule(w, {}); await s.tick();
    await withTenant(app, w.id, c => pauseSource(c, w.id, w.ids.a1, SRC, "Publisher is migrating its site", now));
    await expect(withTenant(app, w.id, c => pauseSource(c, w.id, w.ids.a1, SRC, "Publisher is migrating its site", now))).rejects.toThrow(/already paused/);
    await schedule(w, { sources: { [SRC]: { intervalHours: 6, mode: "series" } } });
    now = at(48 * HOUR); await s.tick();
    expect(ran).toHaveLength(1);
    expect(await row(w)).toMatchObject({ paused: true, interval_hours: 6, next_run_at: null });
  });

  it("stops scheduling a source that is dropped from the schedule or no longer approved", async () => {
    const w = await world(); const now = T0;
    await schedule(w, { sources: { [SRC]: { intervalHours: 24, mode: "series" }, [SRC2]: { intervalHours: 12, mode: "series" } } });
    await withTenant(app, w.id, c => syncSchedule(c, w.id, now));
    expect((await row(w, SRC2)).enabled).toBe(true);
    await schedule(w, { sources: { [SRC]: { intervalHours: 24, mode: "series" } } });
    await withTenant(app, w.id, c => syncSchedule(c, w.id, now));
    expect(await row(w, SRC2)).toMatchObject({ enabled: false, next_run_at: null });
    await withTenant(owner, w.id, c => c.query("UPDATE sources SET status = 'blocked' WHERE source_key = $1", [SRC]));
    await withTenant(app, w.id, c => syncSchedule(c, w.id, now));
    expect(await row(w)).toMatchObject({ enabled: false });
  });

  it("gives a due source to exactly one claimant", async () => {
    const w = await world(); await schedule(w, {});
    await withTenant(app, w.id, c => syncSchedule(c, w.id, T0));
    const claims = await Promise.all([1, 2, 3, 4].map(() => withTenant(app, w.id, c => claimDue(c, T0, 60_000))));
    expect(claims.filter(x => x !== null)).toHaveLength(1);
  });

  it("shares one pass between overlapping ticks, and gives up on a run that never ends", async () => {
    const w = await world(); let calls = 0; await schedule(w, {});
    const s = sched(w, async () => { calls++; await new Promise(r => setTimeout(r, 30)); }, { now: () => T0 });
    const [a, b] = await Promise.all([s.tick(), s.tick()]);
    expect(a).toBe(b); expect(calls).toBe(1);
    const w2 = await world(); await schedule(w2, {});
    const hung = sched(w2, () => new Promise(() => undefined), { now: () => T0, runTimeoutMs: 40 });
    expect((await hung.tick()).ran[0]).toMatchObject({ ok: false, error: "the run took too long and was given up on" });
    expect(await row(w2)).toMatchObject({ consecutive_failures: 1, claimed_until: null });
  });

  it("marks stored runs with how they started, and reports health from stored series, runs and quarantine", async () => {
    const w = await world();
    await runIngestion({ pool: app, institutionId: w.id, sourceKey: SRC, connector: oldSeries("s1", "2026-01-01T00:00:00Z"), http: noNetwork, trigger: "scheduled", now: () => T0 });
    await schedule(w, { steward: w.ids.ana });
    await withTenant(app, w.id, c => syncSchedule(c, w.id, T0));
    const h = await withTenant(app, w.id, c => sourceHealth(c, T0));
    const s = h.find(x => x.sourceKey === SRC)!;
    expect(s).toMatchObject({ health: "stale", scheduled: true, mode: "series", intervalHours: 24, approval: "approved", packs: ["energy"] });
    expect(s.series[0]).toMatchObject({ seriesKey: "s1", stale: true, ageDays: 313 });
    expect(s.lastRuns[0]).toMatchObject({ status: "completed", trigger: "scheduled" });
    expect(s.lastSuccessAt).not.toBeNull();
    expect(h.find(x => x.sourceKey === "pending-one-jodi")!.health).toBe("not_approved");
    expect(h.find(x => x.sourceKey === SRC2)).toMatchObject({ health: "no_data", scheduled: false });
  });

  it("opens one case for a stale source, owned by the steward, and not another while it is open", async () => {
    const w = await world();
    await runIngestion({ pool: app, institutionId: w.id, sourceKey: SRC, connector: oldSeries("s1", "2026-01-01T00:00:00Z"), http: noNetwork, now: () => T0 });
    await schedule(w, { steward: w.ids.ana });
    const s = sched(w, async () => undefined, { now: () => at(MIN) });
    const first = await s.tick();
    expect(first.casesOpened).toHaveLength(1);
    expect((await s.tick()).casesOpened).toEqual([]);
    const k = await withTenant(app, w.id, async c => (await c.query("SELECT title, domain, owner_id, signal->>'id' AS sid, signal->>'ruleId' AS rule FROM cases")).rows);
    expect(k).toEqual([{ title: "Name energy-jodi-test: data is out of date", domain: "energy", owner_id: w.ids.ana, sid: "SRC1:energy-jodi-test:2026-01-01", rule: "SRC1" }]);
    const h = (await withTenant(app, w.id, c => sourceHealth(c, T0))).find(x => x.sourceKey === SRC)!;
    expect(h.openCase).toMatchObject({ caseKey: first.casesOpened[0] });
    await withTenant(app, w.id, c => c.query("SELECT 1"));
    expect(await actions(w)).toContain("scheduler.case_opened");
  });

  it("opens a failing-source case when a source is paused after repeated failures, and none without a steward", async () => {
    const w = await world(); let now = T0;
    const s = sched(w, async () => { throw new Error("blocked by publisher"); }, { now: () => now });
    await schedule(w, { steward: w.ids.ana });
    for (const m of [0, 15, 45]) { now = at(m * MIN); await s.tick(); }
    const k = await withTenant(app, w.id, async c => (await c.query("SELECT title, signal->>'id' AS sid FROM cases")).rows);
    expect(k).toEqual([{ title: "Name energy-jodi-test: fetching keeps failing", sid: "SRC2:energy-jodi-test:never" }]);
    const w2 = await world(); let n2 = T0;
    const s2 = sched(w2, async () => { throw new Error("x"); }, { now: () => n2 });
    await schedule(w2, { steward: null });
    for (const m of [0, 15, 45]) { n2 = at(m * MIN); await s2.tick(); }
    expect(await withTenant(app, w2.id, async c => (await c.query("SELECT 1 FROM cases")).rowCount)).toBe(0);
  });

  it("keeps each institution's schedule private", async () => {
    const a = await world(), b = await world(); await schedule(a, {});
    await withTenant(app, a.id, c => syncSchedule(c, a.id, T0));
    expect(await withTenant(app, b.id, async c => (await c.query("SELECT 1 FROM source_schedule")).rowCount)).toBe(0);
  });

  it("serves health to readers, and run, pause and resume only to people who manage ingestion", async () => {
    const w = await world();
    const sch = new Scheduler({ pool: app, institutionId: w.id, run: async () => undefined, now: () => new Date() });
    const off = buildServer({ pool: app, institutionId: w.id, verifier: verifier() }), on = buildServer({ pool: app, institutionId: w.id, verifier: verifier(), scheduler: sch, metricsToken: "m".repeat(30) });
    const call = (srv: typeof on, who: keyof W["tokens"], method: string, url: string, payload?: object) => srv.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${w.tokens[who]}` }, ...(payload ? { payload } : {}) });
    await schedule(w, {});
    const h = await call(on, "exe", "GET", "/v1/sources/health"); expect(h.statusCode).toBe(200);
    expect(h.json().scheduler).toMatchObject({ enabled: true, scheduleVersion: 1, pauseAfterFailures: 3 });
    expect(h.json().sources.map((x: any) => x.sourceKey)).toEqual(["energy-jodi-test", "macro-imf-commodity-test", "pending-one-jodi"]);
    expect((await call(off, "exe", "GET", "/v1/sources/health")).json().scheduler.enabled).toBe(false);
    expect((await call(on, "ana", "POST", `/v1/sources/${SRC}/pause`, { reason: "A reason long enough" })).statusCode).toBe(403);
    expect((await call(on, "exe", "POST", `/v1/sources/${SRC}/run`, {})).statusCode).toBe(403);
    expect((await call(off, "ops", "POST", `/v1/sources/${SRC}/run`, {})).statusCode).toBe(409);
    await withTenant(app, w.id, c => syncSchedule(c, w.id, new Date()));
    expect((await call(on, "ops", "POST", `/v1/sources/${SRC}/pause`, { reason: "short" })).statusCode).toBe(422);
    expect((await call(on, "ops", "POST", `/v1/sources/${SRC}/pause`, {})).statusCode).toBe(400);
    expect((await call(on, "ops", "POST", `/v1/sources/${SRC}/pause`, { reason: "Publisher is migrating its site" })).statusCode).toBe(202);
    expect((await call(on, "ops", "POST", `/v1/sources/${SRC}/run`, {})).statusCode).toBe(409);
    expect((await call(on, "ops", "POST", `/v1/sources/${SRC2}/pause`, { reason: "Not in the schedule at all" })).statusCode).toBe(409);
    expect((await call(on, "ops", "POST", "/v1/sources/nope-nope/pause", { reason: "Not a real source here" })).statusCode).toBe(404);
    expect((await call(on, "a1", "POST", `/v1/sources/${SRC}/resume`, { reason: "Migration finished, checked" })).statusCode).toBe(202);
    expect((await call(on, "a1", "POST", `/v1/sources/${SRC}/run`, {})).statusCode).toBe(202);
    await sch.idle();
    expect(await actions(w)).toEqual(expect.arrayContaining(["scheduler.paused", "scheduler.resumed", "scheduler.run_requested"]));
    const m = await on.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${"m".repeat(30)}` } });
    expect(m.body).toMatch(/tigeris_sources\{health="no_data"\} \d/);
    expect(m.body).toMatch(/tigeris_scheduler_enabled 1/);
    expect(m.body).toMatch(/tigeris_ingest_jobs_24h\{status="failed"\} 0/);
    await off.close(); await on.close();
  });
});

describe("scheduler configuration", () => {
  const base = { DATABASE_URL: "postgres://u:p@h/d", TIGERIS_INSTITUTION_ID: randomUUID(), OIDC_ISSUER: "https://idp.example", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://idp.example/keys" };
  it("is off by default and checks the tick", async () => {
    const { loadConfig } = await import("../apps/api/src/config.js");
    expect(loadConfig({ ...base }).scheduler).toEqual({ enabled: false, tickSeconds: 60 });
    expect(loadConfig({ ...base, TIGERIS_SCHEDULER_ENABLED: "true", TIGERIS_SCHEDULER_TICK_SECONDS: "30" }).scheduler).toEqual({ enabled: true, tickSeconds: 30 });
    expect(() => loadConfig({ ...base, TIGERIS_SCHEDULER_TICK_SECONDS: "2" })).toThrow(/TIGERIS_SCHEDULER_TICK_SECONDS/);
  });
});
