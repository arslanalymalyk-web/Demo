import { applyFileSecrets } from "../../core/src/secrets.js";
import pg from "pg";
import { connectorFor, PoliteHttp } from "../../connectors/src/index.js";
import { runIngestion } from "./pipeline.js";
import { registerSources, setSourceStatus } from "./registry.js";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
applyFileSecrets();
const institutionId = process.env.TIGERIS_INSTITUTION_ID;
if (!process.env.DATABASE_URL || !institutionId) { console.error("DATABASE_URL and TIGERIS_INSTITUTION_ID are required"); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (args.includes("--register")) {
    console.log("registry:", await registerSources(pool, institutionId, new URL("../../../data/registry/sources.json", import.meta.url).pathname));
  }
  const ss = args.indexOf("--set-status");
  if (ss >= 0) { await setSourceStatus(pool, institutionId, args[ss + 1]!, args[ss + 2]!, opt("reason") ?? ""); console.log("status updated"); }
  const key = opt("source");
  if (key) {
    const limit = opt("limit") ? Number(opt("limit")) : undefined;
    // platform lookup runs in a tenant transaction so row-level security applies
    const c = await pool.connect();
    let platform: string | undefined;
    try { await c.query("BEGIN"); await c.query("SELECT set_config('app.institution_id',$1,true)", [institutionId]); platform = (await c.query("SELECT platform_type FROM sources WHERE source_key=$1", [key])).rows[0]?.platform_type; await c.query("COMMIT"); } finally { c.release(); }
    const mode = opt("mode") === "series" ? "series" : "catalog";
    const connector = platform ? connectorFor(platform, mode, key) : undefined;
    if (!connector) throw new Error(`no connector for source ${key} (platform: ${platform ?? "unknown"})`);
    const http = new PoliteHttp();
    const stats = await runIngestion({ pool, institutionId, sourceKey: key, connector, http, ...(limit !== undefined ? { limit } : {}), ...(opt("series") ? { seriesKey: opt("series")! } : {}), ...(opt("file") ? { localFile: opt("file")! } : {}) });
    console.log(JSON.stringify({ source: key, requests: http.requests, ...stats }, null, 1));
  }
} finally { await pool.end(); }
