import { randomUUID } from "node:crypto";
import type pg from "pg";
import { activePolicy, ensureDefaultPolicy } from "../../governance/src/store.js";
import { findPrincipal, provisionPrincipal } from "../../identity/src/index.js";
import { registerSources } from "../../ingest/src/registry.js";
import { audit, withTenant } from "../../ingest/src/store.js";

export class SetupError extends Error { constructor(message: string) { super(message); } }
export const ROLES: [string, string][] = [["executive", "Executive"], ["analyst", "Analyst"], ["expert", "Expert"], ["approver", "Approver"], ["operations", "Operations owner"], ["administrator", "Administrator"], ["auditor", "Auditor"]];
export interface Person { subject: string; name?: string | null }
export interface BootstrapInput { institutionId?: string | null; name: string; jurisdiction?: string | null; issuer: string; admins: Person[]; auditors?: Person[]; registryFile?: string | null }
export interface Step { step: string; status: "done" | "already" | "skipped"; detail: string }
export interface BootstrapResult { institutionId: string; created: boolean; steps: Step[] }

const SUBJECT = /^[^\s\u0000-\u001f]{1,200}$/;
/** Everything wrong with the input, at once, before anything is written. */
export function validateInput(i: BootstrapInput): string[] {
  const p: string[] = [];
  if (i.name.trim().length < 2 || i.name.length > 120) p.push("the institution name must be 2 to 120 characters");
  if (i.institutionId && !/^[0-9a-f-]{36}$/i.test(i.institutionId)) p.push("the institution id must be a UUID");
  try { new URL(i.issuer); } catch { p.push("the issuer must be a URL"); }
  if (i.jurisdiction && !/^[A-Z]{2}$/.test(i.jurisdiction)) p.push("the jurisdiction must be a two-letter country code, such as SA");
  const all = [...i.admins.map(x => ({ ...x, role: "administrator" })), ...(i.auditors ?? []).map(x => ({ ...x, role: "auditor" }))];
  for (const x of all) if (!SUBJECT.test(x.subject)) p.push(`"${x.subject}" is not a valid identity-provider subject (no spaces, 1 to 200 characters)`);
  if (new Set(i.admins.map(x => x.subject)).size < 2) p.push("name at least two different administrators: settings and policy changes need one person to draft and another to approve");
  if (new Set(all.map(x => x.subject)).size !== all.length) p.push("a person can be listed only once; give an auditor a different subject from the administrators");
  return p;
}

/** Stands up one institution: the institution, its roles, the first administrators, the default policy and the source registry. Safe to run again. */
export async function bootstrap(owner: pg.Pool, app: pg.Pool, i: BootstrapInput): Promise<BootstrapResult> {
  const problems = validateInput(i);
  if (problems.length) throw new SetupError(`set-up refused:\n - ${problems.join("\n - ")}`);
  const id = i.institutionId ?? randomUUID(), steps: Step[] = [];
  const existed = await withTenant(owner, id, async c => (await c.query("SELECT 1 FROM institutions WHERE id = $1", [id])).rowCount === 1);
  if (!existed) await withTenant(owner, id, c => c.query("INSERT INTO institutions (id, name, jurisdiction) VALUES ($1,$2,$3)", [id, i.name.trim(), i.jurisdiction ?? null]));
  steps.push({ step: "institution", status: existed ? "already" : "done", detail: existed ? `Institution ${id} already exists; its name was left as it is.` : `Created ${i.name.trim()} (${id}).` });

  const added = await withTenant(owner, id, async c => { let n = 0; for (const [k, l] of ROLES) n += (await c.query("INSERT INTO roles (institution_id, key, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, k, l])).rowCount ?? 0; return n; });
  steps.push({ step: "roles", status: added ? "done" : "already", detail: added ? `${added} role${added === 1 ? "" : "s"} created.` : "All seven roles already exist." });

  for (const [people, role] of [[i.admins, "administrator"], [i.auditors ?? [], "auditor"]] as const) {
    for (const p of people) {
      const r = await withTenant(app, id, async c => {
        const have = await findPrincipal(c, i.issuer, p.subject);
        if (have) return have.roles.includes(role) ? "already" as const : "other" as const;
        await provisionPrincipal(c, id, { type: "system" }, { issuer: i.issuer, subject: p.subject, displayName: p.name ?? null, roles: [role] });
        return "done" as const;
      });
      steps.push({ step: `${role}: ${p.subject}`, status: r === "done" ? "done" : "already", detail: r === "done" ? `Provisioned with the ${role} role.` : r === "already" ? `Already provisioned as ${role}.` : `Already provisioned with other roles. Their roles were not changed; use Administration to change them.` });
    }
  }

  const hadPolicy = await withTenant(app, id, async c => (await activePolicy(c)) !== null);
  const pol = await withTenant(app, id, c => ensureDefaultPolicy(c, id));
  steps.push({ step: "decision policy", status: hadPolicy ? "already" : "done", detail: `Policy version ${pol.version} is active. Changes need two administrators.` });

  if (i.registryFile) { const r = await registerSources(app, id, i.registryFile); const ok = await withTenant(app, id, async c => (await c.query("SELECT count(*) FILTER (WHERE status = 'approved')::int AS a, count(*) FILTER (WHERE status = 'pending_rights')::int AS p FROM sources")).rows[0] as { a: number; p: number });
    steps.push({ step: "source registry", status: r.inserted ? "done" : "already", detail: `${r.inserted} added, ${r.updated} refreshed. ${ok.a} are approved as the registry records them; ${ok.p} wait for rights confirmation. Confirm each licence yourself before relying on it.` }); }
  else steps.push({ step: "source registry", status: "skipped", detail: "Skipped by request." });

  await withTenant(app, id, c => audit(c, id, { actorType: "system", action: "setup.completed", objectType: "institution", objectId: id, payload: { created: !existed, administrators: i.admins.length, auditors: (i.auditors ?? []).length, issuer: i.issuer } }));
  return { institutionId: id, created: !existed, steps };
}
