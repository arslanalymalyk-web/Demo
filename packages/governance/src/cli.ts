import pg from "pg";
import { withTenant } from "../../ingest/src/store.js";
import { ensureDefaultPolicy, listPolicies } from "./store.js";

const [cmd] = process.argv.slice(2);
const institutionId = process.env.TIGERIS_INSTITUTION_ID;
if (!process.env.DATABASE_URL || !institutionId) { console.error("DATABASE_URL and TIGERIS_INSTITUTION_ID are required"); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  // Bootstrap only: the first policy is created and activated by the system actor, and audited as such. Later changes need two administrators.
  if (cmd === "seed-policy") console.log(JSON.stringify(await withTenant(pool, institutionId, c => ensureDefaultPolicy(c, institutionId)), null, 1));
  else if (cmd === "list") console.log(JSON.stringify(await withTenant(pool, institutionId, c => listPolicies(c)), null, 1));
  else { console.error("usage: seed-policy | list"); process.exit(2); }
} finally { await pool.end(); }
