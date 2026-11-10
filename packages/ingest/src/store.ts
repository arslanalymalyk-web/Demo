import pg from "pg";

/** Runs fn inside a transaction with the institution scope set, so row-level security applies. */
export async function withTenant<T>(pool: pg.Pool, institutionId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.institution_id', $1, true)", [institutionId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(c: pg.PoolClient, institutionId: string, a: { actorType: string; actorId?: string; action: string; objectType?: string; objectId?: string; payload?: unknown }): Promise<void> {
  await c.query(
    "INSERT INTO audit_events (institution_id, actor_type, actor_id, action, object_type, object_id, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,'','')",
    [institutionId, a.actorType, a.actorId ?? null, a.action, a.objectType ?? null, a.objectId ?? null, JSON.stringify(a.payload ?? {})],
  );
}

export interface TableStats { records: number; oldest: string | null; newest: string | null }
// Table and column names are fixed here, never taken from a request.
const STATS: Record<string, string> = { audit_events: "occurred_at", evidence_objects: "retrieved_at", human_decisions: "created_at", policy_decisions: "created_at", cases: "created_at", memory_records: "created_at", documents: "created_at", settings_versions: "created_at", scenario_runs: "created_at" };
/** How many records a table holds and how old they are, for the retention report. */
export async function tableStats(c: pg.PoolClient, table: keyof typeof STATS & string): Promise<TableStats> {
  const col = STATS[table]; if (!col) throw new Error(`no stats defined for ${table}`);
  const r = (await c.query(`SELECT count(*)::int AS n, min(${col}) AS oldest, max(${col}) AS newest FROM ${table}`)).rows[0];
  return { records: r.n, oldest: r.oldest ? new Date(r.oldest).toISOString() : null, newest: r.newest ? new Date(r.newest).toISOString() : null };
}
