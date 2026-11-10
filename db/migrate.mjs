// Applies db/migrations/*.sql in order using the owner role. Records applied files.
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (file text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
const done = new Set((await client.query("SELECT file FROM schema_migrations")).rows.map(r => r.file));
for (const file of readdirSync(new URL("./migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) {
  if (done.has(file)) { console.log("skip", file); continue; }
  const sql = readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  try { await client.query("BEGIN"); await client.query(sql); await client.query("INSERT INTO schema_migrations(file) VALUES ($1)", [file]); await client.query("COMMIT"); console.log("applied", file); }
  catch (e) { await client.query("ROLLBACK"); console.error("failed", file, e.message); process.exit(1); }
}
await client.end();
