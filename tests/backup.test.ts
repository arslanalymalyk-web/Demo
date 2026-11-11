import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../apps/api/src/config.js";
import { buildServer } from "../apps/api/src/server.js";
import { AlertRunner, backupStatus, desiredConditions, type Mail, type Mailer } from "../packages/alerts/src/index.js";
import { installationReadiness } from "../packages/setup/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

const T0 = new Date("2026-11-10T12:00:00Z"), HOUR = 3_600_000;
const ago = (h: number) => new Date(T0.getTime() - h * HOUR).toISOString();
const SHA = "a".repeat(64);

describe("backup monitoring settings", () => {
  const base = { DATABASE_URL: "postgres://u:p@h/d", TIGERIS_INSTITUTION_ID: randomUUID(), OIDC_ISSUER: "https://idp.example", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://idp.example/keys" };
  it("is off by default and accepts 0 to 720 hours", () => {
    expect(loadConfig({ ...base }).backupMaxAgeHours).toBe(0);
    expect(loadConfig({ ...base, TIGERIS_BACKUP_MAX_AGE_HOURS: "36" }).backupMaxAgeHours).toBe(36);
    expect(() => loadConfig({ ...base, TIGERIS_BACKUP_MAX_AGE_HOURS: "-1" })).toThrow(/TIGERIS_BACKUP_MAX_AGE_HOURS/);
    expect(() => loadConfig({ ...base, TIGERIS_BACKUP_MAX_AGE_HOURS: "9999" })).toThrow(/TIGERIS_BACKUP_MAX_AGE_HOURS/);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("base backup monitoring against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  // backup_runs belongs to the deployment, not to an institution, so tests add rows and clear their own effect by using times far apart from each other.
  const run = (status: "ok" | "failed", finishedHoursAgo: number) => owner.query("INSERT INTO backup_runs (status, started_at, finished_at, bytes, sha256, label, note) VALUES ($1,$2,$2,$3,$4,'t',$5)", [status, ago(finishedHoursAgo), status === "ok" ? 100 : null, status === "ok" ? SHA : null, status === "failed" ? "the base backup failed (exit 1)" : null]);
  const wipe = () => owner.query("ALTER TABLE backup_runs DISABLE TRIGGER backup_runs_immutable").then(() => owner.query("DELETE FROM backup_runs")).then(() => owner.query("ALTER TABLE backup_runs ENABLE TRIGGER backup_runs_immutable"));
  async function inst(ageHours: number) { const id = randomUUID(); await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name, created_at) VALUES ($1,'B',$2)", [id, ago(ageHours)]); }); return id; }
  const status = (id: string, max: number) => withTenant(app, id, c => backupStatus(c, T0, max));

  it("reads each state from the record the backup script writes", async () => {
    await wipe(); const old = await inst(500), fresh = await inst(1);
    expect((await status(old, 0)).state).toBe("off");
    expect((await status(old, 36)).state).toBe("never");
    expect((await status(fresh, 36)).state).toBe("ok"); // a new deployment is not blamed before it has had a chance
    await run("ok", 30);
    expect(await status(old, 36)).toMatchObject({ state: "ok", lastOkAgeHours: 30 });
    expect((await status(old, 24)).state).toBe("overdue");
    await run("failed", 2);
    expect(await status(old, 36)).toMatchObject({ state: "failing", failedLast24h: 1 });
    await run("ok", 1);
    expect(await status(old, 36)).toMatchObject({ state: "ok", lastOkAgeHours: 1, failedLast24h: 1 });
    await wipe();
  });

  it("lets only the backup role write the record, and nobody change or remove it", async () => {
    await wipe();
    await expect(app.query("INSERT INTO backup_runs (status, started_at, sha256) VALUES ('ok', now(), $1)", [SHA])).rejects.toThrow(/permission denied/);
    await run("ok", 1);
    await expect(owner.query("UPDATE backup_runs SET status = 'failed'")).rejects.toThrow();
    await expect(owner.query("DELETE FROM backup_runs")).rejects.toThrow();
    await expect(owner.query("INSERT INTO backup_runs (status, started_at) VALUES ('ok', now())")).rejects.toThrow(); // a good run needs its checksum
    await expect(owner.query("INSERT INTO backup_runs (status, started_at, sha256) VALUES ('ok', now(), 'not hex')")).rejects.toThrow();
    await wipe();
  });

  it("raises one operations notice for administrators and auditors when backups stop, and says so when they resume", async () => {
    await wipe(); const id = await inst(500);
    const sent: Mail[] = []; const m: Mailer = { transport: "smtp", async send(x) { sent.push(x); return { messageId: "<1@t>" }; }, async verify() { /* ok */ } };
    const tokens = { adm: await addUser(owner, app, id, "adm", ["administrator"]), aud: await addUser(owner, app, id, "aud", ["auditor"]) }; void tokens;
    await withTenant(app, id, c => c.query("UPDATE principals SET email = idp_subject || '@client.example'"));
    const clock = { t: T0 }, r = new AlertRunner({ pool: app, institutionId: id, mailer: m, baseUrl: "https://tigeris.client.example", engine: { reminderHours: 24, maxPerHour: 50 }, backupMaxAgeHours: 36, now: () => clock.t });
    await run("ok", 40);
    expect(await withTenant(app, id, c => desiredConditions(c, { auditOk: true, scanner: null, backupMaxAgeHours: 36 }, T0))).toEqual([expect.objectContaining({ key: "ops:backup", category: "operations", detail: "overdue" })]);
    await r.tick();
    expect(sent.map(x => x.to).sort()).toEqual(["adm@client.example", "aud@client.example"]);
    expect(sent[0]!.subject).toBe("[TIGERIS] An operational check needs attention");
    expect(sent[0]!.text).not.toMatch(/40|hours/); // the notice says nothing about the figures
    clock.t = new Date(T0.getTime() + HOUR); await r.tick(); expect(sent).toHaveLength(2);
    await owner.query("INSERT INTO backup_runs (status, started_at, finished_at, bytes, sha256, label) VALUES ('ok', $1, $1, 1, $2, 'new')", [new Date(T0.getTime() + 2 * HOUR).toISOString(), SHA]);
    clock.t = new Date(T0.getTime() + 3 * HOUR); await r.tick();
    expect(sent.filter(x => x.subject.includes("Resolved"))).toHaveLength(2);
    await wipe();
  });

  it("shows on Readiness and in metrics whether backups are happening", async () => {
    await wipe(); const id = await inst(500);
    const facts = (max: number) => ({ clientDataEnabled: false, scanner: { configured: false, reachable: false }, scheduler: { enabled: false }, reasoning: { provider: null }, alerts: { configured: false, transport: null }, backupMaxAgeHours: max });
    const check = (max: number) => withTenant(app, id, c => installationReadiness(c, facts(max))).then(r => r.checks.find(x => x.id === "base_backup")!);
    expect(await check(0)).toMatchObject({ status: "warn", detail: expect.stringMatching(/Nobody is told/) });
    expect(await check(36)).toMatchObject({ status: "fail", detail: expect.stringMatching(/ever been recorded/) });
    await owner.query("INSERT INTO backup_runs (status, started_at, finished_at, bytes, sha256, label) VALUES ('ok', now() - interval '2 hours', now() - interval '2 hours', 1, $1, 'x')", [SHA]);
    expect(await check(36)).toMatchObject({ status: "pass", detail: expect.stringMatching(/hours ago/) });
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier(), metricsToken: "m".repeat(30), backupMaxAgeHours: 36 });
    const body = (await server.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${"m".repeat(30)}` } })).body;
    expect(body).toMatch(/tigeris_last_backup_age_hours 2(\.\d)?/);
    expect(body).toMatch(/tigeris_backup_failures_24h 0/);
    await server.close(); await wipe();
  });
});
