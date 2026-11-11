import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import type pg from "pg";
import { audit, withTenant } from "../../ingest/src/store.js";
import { verifyAuditChain } from "../../ingest/src/lineage.js";

/** Everything the institution holds, written as plain files anyone can read without this software or PostgreSQL: one newline-delimited JSON file per table and a manifest of hashes.
 *  It is how an institution leaves, or answers a regulator who asks for everything. Binary columns are written as hexadecimal text. */
export interface ExportManifest {
  format: "tigeris-institution-export-1"; institutionId: string; createdAt: string; migrations: string[];
  tables: { name: string; rows: number; sha256: string }[];
  auditChain: { ok: boolean; events: number; headHash: string | null };
}

const MIGRATIONS = new URL("../../../db/migrations/", import.meta.url);
const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;

export async function exportInstitution(pool: pg.Pool, institutionId: string, dir: string, actor: { type: string; id?: string } = { type: "system" }, now: Date = new Date()): Promise<ExportManifest> {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length > 0) throw new Error(`${dir} is not empty; an export goes in a new folder`);
  const tables: ExportManifest["tables"] = [];
  let manifest!: ExportManifest;
  // One transaction, so every table is read at the same moment and the files agree with each other.
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('app.institution_id', $1, true)", [institutionId]);
    const names = (await client.query(`SELECT table_name FROM information_schema.tables t WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND (EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'institution_id') OR table_name = 'institutions') ORDER BY table_name`)).rows.map(r => r.table_name as string);
    for (const name of names) {
      const hash = createHash("sha256"), file = join(dir, `${name}.ndjson`), out = createWriteStream(file);
      let rows = 0;
      const cur = `c_${rows}_${name.replace(/\W/g, "_")}`.slice(0, 60);
      await client.query(`DECLARE ${ident(cur)} NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS j FROM ${ident(name)} t ${name === "institutions" ? "WHERE t.id = current_setting('app.institution_id')::uuid" : ""}`);
      for (;;) {
        const batch = (await client.query(`FETCH 1000 FROM ${ident(cur)}`)).rows as { j: string }[];
        if (batch.length === 0) break;
        const text = batch.map(r => r.j + "\n").join("");
        hash.update(text); rows += batch.length;
        if (!out.write(text)) await once(out, "drain");
      }
      await client.query(`CLOSE ${ident(cur)}`);
      out.end(); await once(out, "finish");
      tables.push({ name, rows, sha256: hash.digest("hex") });
    }
    const chain = await verifyAuditChain(client);
    const head = (await client.query("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1")).rows[0]?.hash as string | undefined;
    // The schema this data belongs to is the migration list shipped with this release (the runtime role cannot read the migration record, by design).
    const migrations = (await readdir(MIGRATIONS).catch(() => [] as string[])).filter(f => f.endsWith(".sql")).sort();
    manifest = { format: "tigeris-institution-export-1", institutionId, createdAt: now.toISOString(), migrations, tables, auditChain: { ok: chain.ok, events: chain.events, headHash: head ?? null } };
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; } finally { client.release(); }
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await withTenant(pool, institutionId, c => audit(c, institutionId, { actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: "export.institution", objectType: "institution", objectId: institutionId, payload: { tables: tables.length, rows: tables.reduce((n, t) => n + t.rows, 0), auditEvents: manifest.auditChain.events } }));
  return manifest;
}

/** Checks an export folder against its manifest. Needs nothing but the files. */
export async function verifyExport(dir: string): Promise<{ ok: boolean; problems: string[]; tables: number; rows: number }> {
  const problems: string[] = [];
  let m: ExportManifest;
  try { m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); } catch { return { ok: false, problems: ["manifest.json is missing or unreadable"], tables: 0, rows: 0 }; }
  if (m.format !== "tigeris-institution-export-1") problems.push("unknown export format");
  const files = new Set((await readdir(dir)).filter(f => f.endsWith(".ndjson")));
  for (const t of m.tables) {
    if (!files.delete(`${t.name}.ndjson`)) { problems.push(`${t.name}.ndjson is missing`); continue; }
    const h = createHash("sha256"); let rows = 0;
    for await (const chunk of createReadStream(join(dir, `${t.name}.ndjson`))) { h.update(chunk as Buffer); rows += (chunk as Buffer).filter(b => b === 10).length; }
    if (h.digest("hex") !== t.sha256) problems.push(`${t.name}.ndjson does not match its hash`);
    else if (rows !== t.rows) problems.push(`${t.name}.ndjson has ${rows} rows, the manifest says ${t.rows}`);
  }
  for (const extra of files) problems.push(`${extra} is not listed in the manifest`);
  if (!m.auditChain.ok) problems.push("the audit chain did not verify when the export was made");
  return { ok: problems.length === 0, problems, tables: m.tables.length, rows: m.tables.reduce((n, t) => n + t.rows, 0) };
}
