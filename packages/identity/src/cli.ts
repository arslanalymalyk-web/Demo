import pg from "pg";
import { withTenant } from "../../ingest/src/store.js";
import { listPrincipals, provisionPrincipal } from "./store.js";

const [cmd, ...rest] = process.argv.slice(2);
const institutionId = process.env.TIGERIS_INSTITUTION_ID;
if (!process.env.DATABASE_URL || !institutionId) { console.error("DATABASE_URL and TIGERIS_INSTITUTION_ID are required"); process.exit(2); }
const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (cmd === "add") {
    const [issuer, subject, roles] = [opt("issuer") ?? process.env.OIDC_ISSUER, opt("subject"), (opt("roles") ?? "").split(",").filter(Boolean)];
    if (!issuer || !subject || roles.length === 0) { console.error("usage: add --subject <idp subject> --roles a,b [--issuer <url>] [--name <display name>]"); process.exit(2); }
    // Bootstrap path for the first administrator. It is audited like any other provisioning, with actor type "system".
    console.log(JSON.stringify(await withTenant(pool, institutionId, c => provisionPrincipal(c, institutionId, { type: "system" }, { issuer, subject, roles, displayName: opt("name") ?? null })), null, 1));
  } else if (cmd === "list") console.log(JSON.stringify(await withTenant(pool, institutionId, c => listPrincipals(c)), null, 1));
  else { console.error("usage: add | list"); process.exit(2); }
} finally { await pool.end(); }
