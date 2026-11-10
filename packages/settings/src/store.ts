import type pg from "pg";
import { connectorFor } from "../../connectors/src/index.js";
import { getPrincipal } from "../../identity/src/index.js";
import { permissionsOf } from "../../identity/src/permissions.js";
import { PostgresGraph } from "../../graph/src/index.js";
import { evidenceBriefs } from "../../ingest/src/observations.js";
import { audit } from "../../ingest/src/store.js";
import { DEFAULT_THRESHOLDS, type SignalThresholds } from "../../sectors/src/rules.js";
import { DEFAULT_SIGNAL_RULES, SCHEMAS, SCOPES, SCOPE_INFO, type HormuzExposure, type IngestionSchedule, DEFAULT_SCHEDULE, type Scope, type ScenarioDefaults } from "./schemas.js";

export class SettingsError extends Error { constructor(message: string, readonly code: "not_found" | "conflict" | "invalid" | "forbidden") { super(message); } }
export interface Actor { id: string }
export interface VersionRow { id: string; scope: Scope; version: number; status: "draft" | "active" | "retired"; payload: unknown; note: string; createdBy: string; activatedBy: string | null; createdAt: string; activatedAt: string | null }
const map = (r: Record<string, unknown>): VersionRow => ({ id: r.id as string, scope: r.scope as Scope, version: r.version as number, status: r.status as VersionRow["status"], payload: r.payload, note: r.note as string, createdBy: r.created_by as string, activatedBy: (r.activated_by as string | null) ?? null, createdAt: new Date(r.created_at as string).toISOString(), activatedAt: r.activated_at ? new Date(r.activated_at as string).toISOString() : null });

export async function listVersions(c: pg.PoolClient): Promise<VersionRow[]> { return (await c.query("SELECT * FROM settings_versions ORDER BY scope, version DESC")).rows.map(map); }
export async function activeOf(c: pg.PoolClient, scope: Scope): Promise<VersionRow | null> { const r = await c.query("SELECT * FROM settings_versions WHERE scope = $1 AND status = 'active'", [scope]); return r.rows[0] ? map(r.rows[0]) : null; }

/** What a draft is checked against: the scenario templates' parameters (supplied by the caller) and the evidence and graph it refers to. */
export interface Catalog { templates: Record<string, string[]> }

async function checkEvidence(c: pg.PoolClient, ids: (string | undefined)[]): Promise<void> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return;
  const have = new Set((await evidenceBriefs(c, want)).map(b => b.id));
  const missing = want.filter(x => !have.has(x));
  if (missing.length) throw new SettingsError(`evidence not found: ${missing.map(m => m.slice(0, 8)).join(", ")}`, "invalid");
}

export async function createDraft(c: pg.PoolClient, inst: string, actor: Actor, scope: Scope, payload: unknown, note: string, catalog: Catalog): Promise<VersionRow> {
  if (!SCOPES.includes(scope)) throw new SettingsError("unknown settings scope", "invalid");
  if (note.trim().length < 10) throw new SettingsError("say why this change is made, in at least 10 characters", "invalid");
  const parsed = SCHEMAS[scope].safeParse(payload);
  if (!parsed.success) throw new SettingsError(parsed.error.issues.map(i => `${i.path.join(".") || "payload"}: ${i.message}`).slice(0, 6).join("; "), "invalid");
  if (scope === "scenario_defaults") {
    const d = parsed.data as ScenarioDefaults;
    for (const [t, ps] of Object.entries(d)) {
      if (!catalog.templates[t]) throw new SettingsError(`unknown scenario template ${t}`, "invalid");
      for (const k of Object.keys(ps)) if (!catalog.templates[t]!.includes(k)) throw new SettingsError(`unknown parameter ${k} for ${t}`, "invalid");
    }
    await checkEvidence(c, Object.values(d).flatMap(ps => Object.values(ps).map(p => p.evidenceId)));
  }
  if (scope === "hormuz_exposure") {
    const d = parsed.data as HormuzExposure, known = new Set((await new PostgresGraph(c, inst).linked("chokepoint:hormuz", "constrains_exports_of").catch(() => [])).map(l => String(l.attrs.code)));
    const unknown = Object.keys(d).filter(k => !known.has(k));
    if (unknown.length) throw new SettingsError(`not in the graph: ${unknown.join(", ")}. Seed the graph with these countries first.`, "invalid");
    await checkEvidence(c, Object.values(d).map(p => p.evidenceId));
  }
  if (scope === "ingestion_schedule") {
    const d = parsed.data as IngestionSchedule, keys = Object.keys(d.sources);
    const rows = (await c.query("SELECT source_key, platform_type, status FROM sources WHERE source_key = ANY($1)", [keys])).rows as { source_key: string; platform_type: string; status: string }[];
    for (const k of keys) {
      const r = rows.find(x => x.source_key === k);
      if (!r) throw new SettingsError(`unknown source ${k}`, "invalid");
      if (r.status !== "approved") throw new SettingsError(`source ${k} is ${r.status}; only approved sources can be scheduled`, "invalid");
      if (!connectorFor(r.platform_type, d.sources[k]!.mode, k)) throw new SettingsError(`source ${k} has no ${d.sources[k]!.mode} connector`, "invalid");
    }
    if (d.steward) {
      const p = await getPrincipal(c, d.steward);
      if (!p || p.disabled) throw new SettingsError("the steward is not an active person in this institution", "invalid");
      if (!permissionsOf(p.roles).has("case.write")) throw new SettingsError("the steward must hold a role that can own cases", "invalid");
    }
  }
  const v = (await c.query("SELECT COALESCE(max(version), 0) + 1 AS v FROM settings_versions WHERE scope = $1", [scope])).rows[0].v as number;
  const r = await c.query("INSERT INTO settings_versions (institution_id, scope, version, payload, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [inst, scope, v, JSON.stringify(parsed.data), note.trim(), actor.id]);
  await audit(c, inst, { actorType: "principal", actorId: actor.id, action: "settings.drafted", objectType: "settings", objectId: r.rows[0].id, payload: { scope, version: v, note: note.trim() } });
  return map(r.rows[0]);
}

/** Activation is by someone other than the author. For Hormuz exposure it also writes the values into the graph, with the link class the basis states. */
export async function activate(c: pg.PoolClient, inst: string, actor: Actor, id: string): Promise<VersionRow> {
  const cur = (await c.query("SELECT * FROM settings_versions WHERE id = $1 FOR UPDATE", [id])).rows[0];
  if (!cur) throw new SettingsError("settings version not found", "not_found");
  if (cur.status !== "draft") throw new SettingsError(`this version is ${cur.status}; only a draft can be activated`, "conflict");
  if (cur.created_by === actor.id) throw new SettingsError("a change must be activated by someone other than its author", "forbidden");
  let applied = 0;
  if (cur.scope === "hormuz_exposure") {
    const g = new PostgresGraph(c, inst);
    for (const [code, v] of Object.entries(cur.payload as HormuzExposure)) {
      await g.addLink({ subject: "chokepoint:hormuz", predicate: "constrains_exports_of", object: `country:${code}`, linkClass: v.basis, params: { hormuzShare: v.hormuzShare, spareBypassKbd: v.spareBypassKbd }, rationale: v.rationale, author: `settings v${cur.version}`,
        ...(v.basis === "sourced" ? { evidence: [{ evidenceId: v.evidenceId!, role: "supports" as const }] } : {}) });
      applied++;
    }
  }
  await c.query("UPDATE settings_versions SET status = 'retired' WHERE scope = $1 AND status = 'active'", [cur.scope]);
  const r = await c.query("UPDATE settings_versions SET status = 'active', activated_by = $2, activated_at = now() WHERE id = $1 RETURNING *", [id, actor.id]);
  await audit(c, inst, { actorType: "principal", actorId: actor.id, action: "settings.activated", objectType: "settings", objectId: id, payload: { scope: cur.scope, version: cur.version, graphLinksWritten: applied } });
  return map(r.rows[0]);
}

export async function effectiveThresholds(c: pg.PoolClient): Promise<{ thresholds: SignalThresholds; version: number | null }> {
  const a = await activeOf(c, "signal_rules");
  return a ? { thresholds: a.payload as SignalThresholds, version: a.version } : { thresholds: DEFAULT_THRESHOLDS, version: null };
}
export async function effectiveScenarioDefaults(c: pg.PoolClient): Promise<{ defaults: ScenarioDefaults; version: number | null }> {
  const a = await activeOf(c, "scenario_defaults");
  return { defaults: (a?.payload as ScenarioDefaults | undefined) ?? {}, version: a?.version ?? null };
}
export { DEFAULT_SIGNAL_RULES, SCOPES, SCOPE_INFO };
export async function effectiveSchedule(c: pg.PoolClient): Promise<{ schedule: IngestionSchedule; version: number | null }> {
  const a = await activeOf(c, "ingestion_schedule");
  return a ? { schedule: a.payload as IngestionSchedule, version: a.version } : { schedule: DEFAULT_SCHEDULE, version: null };
}
