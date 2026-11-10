// Creates the reference institution and the standard roles if the database has none. Prints the institution id.
import { randomUUID } from "node:crypto";
// A mounted secret may stand in for the variable: DATABASE_URL_OWNER_FILE=/run/secrets/...
if (!process.env.DATABASE_URL_OWNER && process.env.DATABASE_URL_OWNER_FILE) process.env.DATABASE_URL_OWNER = (await import("node:fs")).readFileSync(process.env.DATABASE_URL_OWNER_FILE, "utf8").trim();

import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();
const id = process.env.TIGERIS_INSTITUTION_ID || randomUUID(); // row-level security hides other institutions, so a repeat run must be given the id it created
await client.query("BEGIN");
await client.query("SELECT set_config('app.institution_id', $1, true)", [id]);
const existing = await client.query("SELECT id FROM institutions LIMIT 1");
await client.query("ROLLBACK");
if (existing.rows[0]) { console.log(existing.rows[0].id); await client.end(); process.exit(0); }
await client.query("BEGIN");
await client.query("SELECT set_config('app.institution_id', $1, true)", [id]);
await client.query("INSERT INTO institutions (id, name, jurisdiction) VALUES ($1,'Reference institution','SA')", [id]);
for (const [key, label] of [["executive","Executive"],["analyst","Analyst"],["expert","Expert"],["approver","Approver"],["operations","Operations owner"],["administrator","Administrator"],["auditor","Auditor"]]) {
  await client.query("INSERT INTO roles (institution_id, key, label) VALUES ($1,$2,$3)", [id, key, label]);
}
await client.query("COMMIT");
console.log(id);
await client.end();
