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
