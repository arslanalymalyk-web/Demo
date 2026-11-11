import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCase } from "../packages/cases/src/index.js";
import { exportInstitution, verifyExport } from "../packages/retention/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser } from "./helpers/auth.js";

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("leaving with everything", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function institution(name: string) {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,$2)", [id, name]); });
    await addUser(owner, app, id, `ana-${name}`, ["analyst"]);
    const me = await withTenant(app, id, async c => (await c.query("SELECT id FROM principals LIMIT 1")).rows[0].id as string);
    await withTenant(app, id, async c => { for (let i = 0; i < 3; i++) await createCase(c, id, { id: me, roles: ["analyst"] } as never, { title: `${name} case ${i}`, objective: "Export check objective.", domain: "energy", sensitivity: "internal" }); });
    return id;
  }
  const read = async (dir: string, t: string) => (await readFile(join(dir, `${t}.ndjson`), "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l));

  it("writes every table as plain files with a manifest that checks out", async () => {
    const a = await institution("Alpha"), b = await institution("Beta");
    const dir = await mkdtemp(join(tmpdir(), "tigeris-export-"));
    const m = await exportInstitution(app, a, join(dir, "out"));
    expect(m.format).toBe("tigeris-institution-export-1");
    expect(m.auditChain.ok).toBe(true); expect(m.auditChain.events).toBeGreaterThan(3);
    expect(m.tables.map(t => t.name)).toEqual(expect.arrayContaining(["institutions", "principals", "cases", "audit_events", "case_events"]));
    expect(m.migrations.length).toBeGreaterThan(10);
    const out = join(dir, "out");
    expect((await read(out, "institutions")).map(r => r.id)).toEqual([a]);
    const cases = await read(out, "cases");
    expect(cases).toHaveLength(3); expect(cases.every(r => r.institution_id === a && r.title.startsWith("Alpha"))).toBe(true);
    for (const t of m.tables) for (const row of await read(out, t.name)) if ("institution_id" in row) expect(row.institution_id, t.name).toBe(a);
    expect(JSON.stringify(m)).not.toContain(b);
    expect(await verifyExport(out)).toMatchObject({ ok: true, problems: [] });
    // The export itself is on the record, after the files were written.
    expect((await withTenant(app, a, async c => (await c.query("SELECT payload FROM audit_events WHERE action = 'export.institution'")).rows)).length).toBe(1);
  });

  it("notices a changed, removed or added file, and refuses a folder that is not empty", async () => {
    const a = await institution("Gamma"), dir = join(await mkdtemp(join(tmpdir(), "tigeris-export-")), "out");
    await exportInstitution(app, a, dir);
    await expect(exportInstitution(app, a, dir)).rejects.toThrow(/not empty/);
    await writeFile(join(dir, "cases.ndjson"), (await readFile(join(dir, "cases.ndjson"), "utf8")).replace("Gamma", "Forged"));
    await writeFile(join(dir, "extra.ndjson"), "{}\n");
    const r = await verifyExport(dir);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(["cases.ndjson does not match its hash", "extra.ndjson is not listed in the manifest"]));
    expect((await verifyExport(join(dir, "nowhere"))).ok).toBe(false);
  });
});

import { readdir, stat } from "node:fs/promises";
import { CheckpointRunner } from "../packages/ingest/src/anchor-runner.js";
import { takeCheckpoint, verifyCheckpoint } from "../packages/ingest/src/anchor.js";
import { desiredConditions } from "../packages/alerts/src/conditions.js";
import { loadConfig } from "../apps/api/src/config.js";

suite("scheduled audit checkpoints", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });
  const KEY = "s".repeat(40), H = 3_600_000;

  it("saves a read-only signed file when one is due, and not before", async () => {
    const id = randomUUID(); await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'K')", [id]); });
    await addUser(owner, app, id, "someone", ["analyst"]);
    const dir = join(await mkdtemp(join(tmpdir(), "tigeris-cp-")), "kept"); let t = new Date("2030-01-01T00:00:00Z");
    const r = new CheckpointRunner({ pool: app, institutionId: id, key: KEY, dir, everyHours: 24, now: () => t });
    const first = await r.tick(); expect(first).toMatch(/^audit-checkpoint-.*\.json$/);
    expect((await stat(join(dir, first!))).mode & 0o222).toBe(0); // nobody can write to it
    t = new Date(t.getTime() + 23 * H); expect(await r.tick()).toBeNull();
    t = new Date(t.getTime() + 2 * H); expect(await r.tick()).not.toBeNull();
    expect((await readdir(dir)).filter(f => f.endsWith(".json")).length).toBe(2);
    expect((await readdir(dir)).filter(f => f.startsWith("."))).toEqual([]); // no half-written file left behind
    const cp = JSON.parse(await readFile(join(dir, first!), "utf8"));
    expect(await withTenant(app, id, c => verifyCheckpoint(c, id, KEY, cp))).toMatchObject({ ok: true });
    expect(await withTenant(app, id, c => takeCheckpoint(c, id, KEY))).toMatchObject({ institutionId: id });
  });

  it("alerts administrators when checkpoints stop, and says nothing when they are not scheduled", async () => {
    const id = randomUUID(); await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'K2')", [id]); });
    await addUser(owner, app, id, "someone", ["analyst"]);
    const later = new Date(Date.now() + 100 * H), soon = new Date(Date.now() + 10 * H);
    const keys = (max: number | undefined, at = later) => withTenant(app, id, async c => (await desiredConditions(c, { auditOk: true, scanner: null, ...(max !== undefined ? { checkpointMaxAgeHours: max } : {}) }, at))).then(d => d.map(x => x.key));
    expect(await keys(undefined)).toEqual([]);
    expect(await keys(48)).toEqual(["ops:audit_checkpoint"]);
    const runner = new CheckpointRunner({ pool: app, institutionId: id, key: KEY, dir: join(await mkdtemp(join(tmpdir(), "tigeris-cp-")), "k"), everyHours: 24, now: () => later });
    await runner.saveNow();
    expect(await keys(48, soon)).toEqual([]);
    expect(await keys(48)).toEqual(["ops:audit_checkpoint"]); // a day and a half later, with none newer, it is overdue again
    // an unwritable folder fails loudly and records nothing, so the alert follows
    const blocked = await mkdtemp(join(tmpdir(), "tigeris-cp-")); await writeFile(join(blocked, "afile"), "x");
    const bad = new CheckpointRunner({ pool: app, institutionId: id, key: KEY, dir: join(blocked, "afile", "x"), everyHours: 24, now: () => new Date(later.getTime() + 200 * H) });
    await expect(bad.saveNow()).rejects.toThrow();
  });

  it("is configured from the environment and refuses a folder without a key", () => {
    const base = { DATABASE_URL: "postgres://u:p@h/d", TIGERIS_INSTITUTION_ID: randomUUID(), OIDC_ISSUER: "https://i.example", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://i.example/jwks" };
    expect(loadConfig({ ...base }).checkpoint).toBeNull();
    expect(loadConfig({ ...base, TIGERIS_AUDIT_ANCHOR_KEY: KEY, TIGERIS_AUDIT_CHECKPOINT_DIR: "/mnt/worm" }).checkpoint).toEqual({ dir: "/mnt/worm", everyHours: 24 });
    expect(() => loadConfig({ ...base, TIGERIS_AUDIT_CHECKPOINT_DIR: "/mnt/worm" })).toThrow(/needs TIGERIS_AUDIT_ANCHOR_KEY/);
    expect(() => loadConfig({ ...base, TIGERIS_AUDIT_ANCHOR_KEY: KEY, TIGERIS_AUDIT_CHECKPOINT_HOURS: "0" })).toThrow(/between 1 and 720/);
  });
});
