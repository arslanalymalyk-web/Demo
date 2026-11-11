import { applyFileSecrets } from "../../core/src/secrets.js";
import pg from "pg";
import { withTenant } from "../../ingest/src/store.js";
import { listPrincipals, provisionPrincipal } from "./store.js";

const [cmd, ...rest] = process.argv.slice(2);
applyFileSecrets();
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd === "break-glass") {
  // Offline: no database and no network. Run it on a machine the two custodians control.
  const { generateBreakGlass, issueBreakGlassToken } = await import("./breakglass.js");
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const sub = rest[0];
  if (sub === "init") {
    const out = flag("out"); if (!out) { console.error("usage: break-glass init --out <new folder>"); process.exit(2); }
    const k = generateBreakGlass(); mkdirSync(out, { recursive: false, mode: 0o700 });
    writeFileSync(`${out}/public-key.pem`, k.publicKeyPem); writeFileSync(`${out}/share-1.txt`, k.shares[0] + "\n", { mode: 0o600 }); writeFileSync(`${out}/share-2.txt`, k.shares[1] + "\n", { mode: 0o600 });
    console.log(`Made ${out}/. Give share-1.txt to one custodian and share-2.txt to a different one, then delete them from this machine. Put public-key.pem (or its base64) in TIGERIS_BREAKGLASS_PUBLIC_KEY.`);
  } else if (sub === "issue") {
    const need = ["share-1", "share-2", "subject", "reason"].filter(n => !flag(n));
    if (need.length) { console.error("usage: break-glass issue --share-1 <file> --share-2 <file> --subject <administrator's identity-provider subject> --minutes <1-240> --reason \"why\" [--issuer <url>] [--public-key <file>]"); process.exit(2); }
    const issuer = flag("issuer") ?? process.env.OIDC_ISSUER; if (!issuer) { console.error("--issuer or OIDC_ISSUER is required"); process.exit(2); }
    const pk = flag("public-key");
    console.log(await issueBreakGlassToken({ shareA: readFileSync(flag("share-1")!, "utf8"), shareB: readFileSync(flag("share-2")!, "utf8"), subject: flag("subject")!, actAsIssuer: issuer, minutes: Number(flag("minutes") ?? 60), reason: flag("reason")!, ...(pk ? { publicKeyPem: readFileSync(pk, "utf8") } : {}) }));
  } else { console.error("usage: break-glass init | issue"); process.exit(2); }
  process.exit(0);
}
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
