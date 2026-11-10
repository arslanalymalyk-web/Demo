import type pg from "pg";
import { listPrincipals, permissionsOf } from "../../identity/src/index.js";
import { verifyAuditChain } from "../../ingest/src/lineage.js";
import { activePolicy } from "../../governance/src/store.js";
import { SCOPES, SCOPE_INFO, activeOf } from "../../settings/src/index.js";
import type { Check } from "./checks.js";

export interface Facts { clientDataEnabled: boolean; scanner: { configured: boolean; reachable: boolean }; scheduler: { enabled: boolean }; reasoning: { provider: string | null } }
const c = (id: string, title: string, status: Check["status"], detail: string, href?: string): Check & { href?: string } => ({ id, title, status, detail, ...(href ? { href } : {}) });

/** Is this deployment ready for real use? Read from stored facts and the running configuration. "Fail" blocks use, "warn" needs a decision, "manual" needs a person to confirm. */
export async function installationReadiness(cx: pg.PoolClient, f: Facts): Promise<{ ready: boolean; checks: (Check & { href?: string })[] }> {
  const out: (Check & { href?: string })[] = [];
  const people = (await listPrincipals(cx)).filter(p => !p.disabled);
  const admins = people.filter(p => p.roles.includes("administrator"));
  out.push(admins.length >= 2 ? c("admins", "Two administrators", "pass", `${admins.length} active administrators, so settings and policy changes can be drafted and approved by different people.`, "#/admin")
    : c("admins", "Two administrators", "fail", `${admins.length} active administrator${admins.length === 1 ? "" : "s"}. Settings and policy changes need one person to draft and another to approve.`, "#/admin"));
  out.push(people.some(p => p.roles.includes("auditor")) ? c("auditor", "An auditor", "pass", "At least one active person can verify the audit trail.") : c("auditor", "An auditor", "warn", "No active auditor. Someone should hold that role to verify the audit chain independently.", "#/admin"));
  out.push(people.some(p => permissionsOf(p.roles).has("case.write")) ? c("analyst", "Someone who can open cases", "pass", "At least one active person can own cases.") : c("analyst", "Someone who can open cases", "warn", "Nobody can open or own a case yet.", "#/admin"));
  const pol = await activePolicy(cx);
  out.push(pol ? c("policy", "Decision policy in force", "pass", `Version ${pol.version}. Changes need two administrators.`, "#/policy") : c("policy", "Decision policy in force", "fail", "No policy is active, so no recommendation can be checked or decided.", "#/policy"));
  const src = (await cx.query("SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved, count(*) FILTER (WHERE status = 'pending_rights')::int AS pending, count(*)::int AS total FROM sources WHERE source_key NOT LIKE 'uploaded-documents:%'")).rows[0];
  out.push(src.total === 0 ? c("sources", "Sources registered", "fail", "No source is registered. Run the set-up command to load the registry.", "#/sources")
    : src.approved === 0 ? c("sources", "Sources approved", "warn", `${src.total} registered, none approved. Confirm each source's licence, then approve it; nothing is fetched from an unapproved source.`, "#/sources")
    : c("sources", "Sources approved", "pass", `${src.approved} approved, ${src.pending} waiting for rights confirmation.`, "#/sources"));
  const series = (await cx.query("SELECT count(*)::int AS n FROM series")).rows[0].n;
  out.push(series > 0 ? c("data", "Public records stored", "pass", `${series} series have stored observations.`, "#/series") : c("data", "Public records stored", "warn", "No series is stored yet. Run the ingest command or turn on scheduled fetching.", "#/source-health"));
  const active: string[] = [], defaults: string[] = [];
  for (const s of SCOPES) ((await activeOf(cx, s)) ? active : defaults).push(SCOPE_INFO[s].title);
  out.push(defaults.length === 0 ? c("settings", "Tiger-set values activated", "pass", "Every settings scope has an institution value in force.", "#/settings") : c("settings", "Tiger-set values activated", "warn", `Still on code defaults: ${defaults.join(", ")}. Defaults are first-release values; the institution should set its own.`, "#/settings"));
  const hormuz = (await cx.query("SELECT count(*)::int AS n FROM entities WHERE key LIKE '%hormuz%'")).rows[0].n;
  out.push(hormuz > 0 ? c("geography", "Map geography loaded", "pass", "The Gulf graph is seeded.", "#/map") : c("geography", "Map geography loaded", "warn", "The graph has no Gulf geography, so the map and the Hormuz scenarios have nothing to draw. Run the geography command.", "#/map"));
  const chain = await verifyAuditChain(cx);
  out.push(chain.ok ? c("audit", "Audit chain intact", "pass", `${chain.events} events verified.`, "#/audit") : c("audit", "Audit chain intact", "fail", `The chain breaks at event ${chain.firstBadSeq}. Treat as a serious incident.`, "#/audit"));
  if (f.clientDataEnabled) out.push(f.scanner.configured && f.scanner.reachable ? c("scanner", "Malware scanner answering", "pass", "Institution documents are on and the scanner answers.", "#/documents") : c("scanner", "Malware scanner answering", "fail", "Institution documents are on but the scanner is not answering. Uploads are held, unopened.", "#/documents"));
  else out.push(c("scanner", "Malware scanner", f.scanner.configured ? (f.scanner.reachable ? "pass" : "warn") : "warn", f.scanner.configured ? (f.scanner.reachable ? "Answering." : "Configured but not answering; uploads are held until it returns.") : "None is connected. Institution documents stay off until one is.", "#/documents"));
  out.push(c("client_data", "Client data", "manual", f.clientDataEnabled ? "Institution documents are on. Confirm the client's security review is recorded (decision 11)." : "Switched off, as it must be until the client's security review is complete (decision 11)."));
  out.push(f.scheduler.enabled ? c("scheduler", "Scheduled fetching", "pass", "Running. A schedule must be activated under Settings for anything to be fetched.", "#/source-health") : c("scheduler", "Scheduled fetching", "pass", "Off. Sources are fetched by running the ingest command.", "#/source-health"));
  out.push(c("assistant", "Assistant", "pass", f.reasoning.provider ? `Connected to ${f.reasoning.provider}.` : "Off. Nothing is sent to any model.", "#/assistant"));
  out.push(c("backup", "Restore drill done in this environment", "manual", "Run the backup restore drill and record the result before go-live."));
  out.push(c("pentest", "Independent penetration test", "manual", "Required by decision 11 before any client data."));
  out.push(c("mfa", "Multi-factor claim confirmed", "manual", "Sign in as an administrator and confirm the identity provider's token carries a multi-factor claim."));
  return { ready: out.every(x => x.status !== "fail"), checks: out };
}
