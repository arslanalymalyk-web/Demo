// Measures the paged lists against far more data than a first deployment will hold, in a scratch database it creates and drops.
// Pass --keep to keep the scratch database for inspection (drop it with DROP DATABASE tigeris_scale).
// Usage: node --env-file=.env --import tsx scripts/paging-scale.ts [cases] [evidence] [--keep]
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { listCasesPage } from "../packages/cases/src/service.js";
import { keysetPage, likePattern } from "../packages/core/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";

const owner = process.env.DATABASE_URL_TEST_OWNER;
if (!owner) throw new Error("DATABASE_URL_TEST_OWNER is required");
const nCases = Number(process.argv[2] ?? 200_000), nEvidence = Number(process.argv[3] ?? 1_000_000);
const db = "tigeris_scale", u = new URL(owner), admin = new URL(owner); admin.pathname = "/postgres"; u.pathname = `/${db}`;
const adminPool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
await adminPool.query(`DROP DATABASE IF EXISTS ${db}`); await adminPool.query(`CREATE DATABASE ${db}`);
execFileSync("node", ["db/migrate.mjs"], { env: { ...process.env, DATABASE_URL_OWNER: u.toString() }, stdio: "inherit" });
const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
const id = randomUUID();
const ms = async <T>(label: string, fn: () => Promise<T>, runs = 5): Promise<T> => {
  let out!: T; const t: number[] = [];
  for (let i = 0; i < runs; i++) { const s = performance.now(); out = await fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${t[Math.floor(t.length / 2)]!.toFixed(1).padStart(8)} ms   worst ${t[t.length - 1]!.toFixed(1).padStart(8)} ms`);
  return out;
};

try {
  let me = "";
  const seed = Date.now();
  await withTenant(pool, id, async c => {
    await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Scale')", [id]);
    me = (await c.query("INSERT INTO principals (institution_id, idp_issuer, idp_subject) VALUES ($1,'x','a') RETURNING id", [id])).rows[0].id as string;
    const s = (await c.query("INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, licence_name, licence_verified) VALUES ($1,'s1','S','P','A','fake','https://x.example','approved','L',true) RETURNING id", [id])).rows[0].id as string;
    const j = (await c.query("INSERT INTO ingestion_jobs (institution_id, source_id) VALUES ($1,$2) RETURNING id", [id, s])).rows[0].id as string;
    await c.query(`INSERT INTO evidence_objects (institution_id, source_id, job_id, external_key, retrieved_at, raw_hash, data_class, payload, validation_status)
      SELECT $1, $2, $3, 'rec-' || g, now() - (g || ' seconds')::interval, md5(g::text) || md5(g::text || 'x'), 'public_record', jsonb_build_object('title', 'Record ' || g), (ARRAY['accepted','warned','quarantined'])[1 + g % 3]::validation_outcome
      FROM generate_series(1, $4::int) g`, [id, s, j, nEvidence]);
    await c.query(`INSERT INTO case_counters (institution_id, n) VALUES ($1, $2) ON CONFLICT (institution_id) DO UPDATE SET n = $2`, [id, nCases]);
    await c.query(`INSERT INTO cases (institution_id, case_key, title, objective, domain, sensitivity, state, owner_id, start_snapshot, updated_at)
      SELECT $1, 'CASE-' || lpad(g::text, 7, '0'), 'Case number ' || g, 'Generated objective text', (ARRAY['energy','sovereign_capital','paging_check'])[1 + g % 3],
             (CASE WHEN g % 10 = 0 THEN 'restricted' ELSE 'internal' END)::case_sensitivity, (ARRAY['open','analysis','closed'])[1 + g % 3]::case_state, $2, '{}'::jsonb, now() - (g || ' seconds')::interval
      FROM generate_series(1, $3::int) g`, [id, me, nCases]);
    await c.query("ANALYZE");
  });
  console.log(`built ${nCases} cases and ${nEvidence} evidence records in ${((Date.now() - seed) / 1000).toFixed(0)} s\n`);
  const actor = { id: me, roles: ["analyst"] } as never;
  const run = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTenant(pool, id, fn);

  const first = await ms("cases: first page of 50", () => run(c => listCasesPage(c, actor, { limit: 50 })));
  let cur = first.next;
  for (let i = 0; i < 400 && cur; i++) cur = (await run(c => listCasesPage(c, actor, { limit: 500, cursor: cur! }))).next; // about 200,000 rows in
  await ms("cases: page 50 rows deep into the list", () => run(c => listCasesPage(c, actor, { limit: 50, ...(cur ? { cursor: cur } : {}) })));
  await ms("cases: filtered by state and domain", () => run(c => listCasesPage(c, actor, { limit: 50, state: "open", domain: ["energy"] })));
  await ms("cases: active only", () => run(c => listCasesPage(c, actor, { limit: 50, active: true })));
  await ms("cases: search for a title word", () => run(c => listCasesPage(c, actor, { limit: 50, q: "number 1234" })), 3);
  await ms("cases: search with no match", () => run(c => listCasesPage(c, actor, { limit: 50, q: "zzzz-none" })), 3);

  const ev = (extra: { source?: string; status?: string; q?: string; cursor?: string }) => run(c => keysetPage(c, {
    select: "e.id, s.source_key, e.external_key, e.payload->>'title' AS title, e.retrieved_at, e.validation_status", from: "evidence_objects e JOIN sources s ON s.id = e.source_id",
    where: "($1::text IS NULL OR s.source_key = $1) AND ($2::text IS NULL OR e.validation_status::text = $2) AND ($3::text IS NULL OR e.external_key ILIKE $3 OR e.payload->>'title' ILIKE $3)",
    params: [extra.source ?? null, extra.status ?? null, extra.q ? likePattern(extra.q) : null], ts: "e.retrieved_at", id: "e.id", limit: 50, cursor: extra.cursor }));
  const e1 = await ms("evidence: first page of 50", () => ev({}));
  let ec = e1.next;
  for (let i = 0; i < 40 && ec; i++) ec = (await run(c => keysetPage(c, { select: "e.id", from: "evidence_objects e", ts: "e.retrieved_at", id: "e.id", limit: 500, cursor: ec! }))).next; // 20,000 rows in
  await ms("evidence: page 50 rows after 20,000", () => ev({ ...(ec ? { cursor: ec } : {}) }));
  await ms("evidence: filtered by validation status", () => ev({ status: "warned" }));
  await ms("evidence: search for a title word", () => ev({ q: "Record 123456" }), 3);
  await ms("evidence: search with no match", () => ev({ q: "zzzz-none" }), 3);
} finally {
  await pool.end();
  if (!process.argv.includes("--keep")) await adminPool.query(`DROP DATABASE IF EXISTS ${db}`);
  await adminPool.end();
}
