import pg from "pg";
import { applyFileSecrets } from "../../core/src/secrets.js";
import { exportInstitution, verifyExport } from "./institution-export.js";

const [cmd, dir] = process.argv.slice(2);
applyFileSecrets();
if (cmd === "verify-export" && dir) {
  const r = await verifyExport(dir); console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 1);
}
if (cmd === "export" && dir) {
  const institutionId = process.env.TIGERIS_INSTITUTION_ID;
  if (!process.env.DATABASE_URL || !institutionId) { console.error("DATABASE_URL and TIGERIS_INSTITUTION_ID are required"); process.exit(2); }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { const m = await exportInstitution(pool, institutionId, dir); console.log(JSON.stringify({ folder: dir, tables: m.tables.length, rows: m.tables.reduce((n, t) => n + t.rows, 0), auditChain: m.auditChain }, null, 1)); } finally { await pool.end(); }
} else { console.error("usage: export <new folder> | verify-export <folder>"); process.exit(2); }
