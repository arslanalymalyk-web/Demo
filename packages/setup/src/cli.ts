// First-run set-up for a new deployment.
//   setup check  [--web-origin https://tigeris.client.example]        read-only: database, identity provider
//   setup apply  --name "Institution" --jurisdiction SA --admin sub1:"First Admin" --admin sub2:"Second Admin" [--auditor sub3:"Name"] [--institution-id <uuid>] [--skip-sources]
// Subjects are the identity provider's `sub` for each person. Run again with the same --institution-id to repair or extend; it never duplicates.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyFileSecrets } from "../../core/src/secrets.js";
import { bootstrap, SetupError, type Person } from "./apply.js";
import { checkDatabase, checkIdentityProvider, type Check } from "./checks.js";

const [cmd, ...rest] = process.argv.slice(2);
applyFileSecrets();
const flags = (n: string) => rest.flatMap((x, i) => x === `--${n}` ? [rest[i + 1] ?? ""] : []);
const flag = (n: string) => flags(n)[0];
const person = (s: string): Person => { const i = s.indexOf(":"); return i < 0 ? { subject: s } : { subject: s.slice(0, i), name: s.slice(i + 1) || null }; };
const ICON: Record<Check["status"], string> = { pass: "PASS  ", warn: "WARN  ", fail: "FAIL  ", manual: "CHECK " };
const show = (title: string, cs: Check[]) => { console.log(`\n${title}`); for (const x of cs) console.log(`  ${ICON[x.status]}${x.title}\n        ${x.detail}`); };

const ownerUrl = process.env.DATABASE_URL_OWNER, appUrl = process.env.DATABASE_URL, issuer = process.env.OIDC_ISSUER;
const production = process.env.TIGERIS_ENV === "production";
if (!ownerUrl || !appUrl || !issuer) { console.error("DATABASE_URL_OWNER, DATABASE_URL and OIDC_ISSUER are required (each may come from a _FILE)."); process.exit(2); }
if (cmd !== "check" && cmd !== "apply") { console.error('usage: check | apply (see the comment at the top of this file, or "docs/handover/DEPLOYMENT.md")'); process.exit(2); }

const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 }), app = new pg.Pool({ connectionString: appUrl, max: 2 });
let code = 0;
try {
  const db = await checkDatabase(owner, app);
  const idp = await checkIdentityProvider({ issuer, jwksUri: process.env.OIDC_JWKS_URI ?? null, webOrigin: flag("web-origin") ?? process.env.WEB_ORIGIN ?? null, production });
  show("Database", db); show("Identity provider", idp);
  if (db.some(x => x.status === "fail")) { console.error("\nThe database is not ready. Fix the items marked FAIL, then run this again."); code = 1; }
  else if (cmd === "check") code = idp.some(x => x.status === "fail") ? 1 : 0;
  else {
    if (idp.some(x => x.status === "fail")) console.log("\nThe identity provider has problems (above). Set-up continues, but nobody can sign in until they are fixed.");
    const admins = flags("admin").map(person), auditors = flags("auditor").map(person);
    const r = await bootstrap(owner, app, { institutionId: flag("institution-id") ?? process.env.TIGERIS_INSTITUTION_ID ?? null, name: flag("name") ?? "", jurisdiction: flag("jurisdiction") ?? null, issuer, admins, auditors, registryFile: rest.includes("--skip-sources") ? null : fileURLToPath(new URL("../../../data/registry/sources.json", import.meta.url)) });
    console.log("\nSet-up");
    for (const s of r.steps) console.log(`  ${s.status.toUpperCase().padEnd(8)}${s.step}\n          ${s.detail}`);
    console.log(`\nInstitution id: ${r.institutionId}\nPut this in the configuration of the API and the ingest service:\n  TIGERIS_INSTITUTION_ID=${r.institutionId}`);
    console.log("\nNext:\n  1. Start the API and sign in as the first administrator; open Readiness for what is still open.\n  2. Confirm each source's licence and approve it (Data and Sources).\n  3. Load the Gulf geography (pnpm geography).\n  4. A second administrator activates the settings the institution decides.\n  5. Run the restore drill and the identity provider checks marked CHECK above.");
  }
} catch (e) {
  if (e instanceof SetupError) { console.error(e.message); code = 2; } else throw e;
} finally { await owner.end(); await app.end(); }
process.exit(code);
