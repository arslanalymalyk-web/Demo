import { readFileSync } from "node:fs";
import type pg from "pg";
import { audit, withTenant } from "./store.js";

interface RegistryEntry { source_key: string; name: string; publisher: string; original_agency: string | null; platform_type: string; base_url: string; area: string; status: string; licence_name: string | null; licence_url: string | null; licence_verified: boolean; rights_note: string | null }

/** Loads the verified source list. New sources get the registry status; existing sources keep any approval an administrator already gave. */
export async function registerSources(pool: pg.Pool, institutionId: string, file: string): Promise<{ inserted: number; updated: number }> {
  const entries = JSON.parse(readFileSync(file, "utf8")) as RegistryEntry[];
  return withTenant(pool, institutionId, async c => {
    let inserted = 0, updated = 0;
    for (const e of entries) {
      const r = await c.query(
        `INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, country, status, licence_name, licence_url, licence_verified, rights_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::source_status,$10,$11,$12,$13)
         ON CONFLICT (institution_id, source_key) DO UPDATE SET name=EXCLUDED.name, publisher=EXCLUDED.publisher, original_agency=EXCLUDED.original_agency, platform_type=EXCLUDED.platform_type, base_url=EXCLUDED.base_url, country=EXCLUDED.country, licence_name=EXCLUDED.licence_name, licence_url=EXCLUDED.licence_url, licence_verified=EXCLUDED.licence_verified, rights_note=EXCLUDED.rights_note
         RETURNING (xmax = 0) AS inserted`,
        [institutionId, e.source_key, e.name, e.publisher, e.original_agency, e.platform_type, e.base_url, e.area, e.status, e.licence_name, e.licence_url, e.licence_verified, e.rights_note],
      );
      if (r.rows[0].inserted) inserted++; else updated++;
    }
    await audit(c, institutionId, { actorType: "system", action: "sources.registered", payload: { inserted, updated, total: entries.length } });
    return { inserted, updated };
  });
}

const STATUSES = ["approved", "pending_rights", "blocked"] as const;
/** Changes a source's approval status. Always audited with a reason. */
export async function setSourceStatus(pool: pg.Pool, institutionId: string, sourceKey: string, status: string, reason: string, actor = "administrator"): Promise<void> {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  if (!reason.trim()) throw new Error("a reason is required");
  await withTenant(pool, institutionId, async c => {
    const r = await c.query("UPDATE sources SET status=$2::source_status WHERE source_key=$1 RETURNING id, (SELECT status FROM sources WHERE source_key=$1) AS previous", [sourceKey, status]);
    if (r.rowCount === 0) throw new Error(`unknown source ${sourceKey}`);
    await audit(c, institutionId, { actorType: "user", actorId: actor, action: "source.status_changed", objectType: "source", objectId: r.rows[0].id, payload: { source: sourceKey, status, reason, previous: r.rows[0].previous } });
  });
}
