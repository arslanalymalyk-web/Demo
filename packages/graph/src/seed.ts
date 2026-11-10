import type pg from "pg";
import { PostgresGraph } from "./repository.js";

/** Planning values for how much of each producer's crude exports pass the Strait of Hormuz, and spare bypass capacity.
 *  These are ASSUMPTIONS, not sourced figures. They are labelled as such and every scenario that uses them reports low confidence. */
export const HORMUZ_PLANNING: Record<string, { name: string; hormuzShare: number; spareBypassKbd: number }> = {
  SA: { name: "Saudi Arabia", hormuzShare: 0.55, spareBypassKbd: 2000 },
  AE: { name: "United Arab Emirates", hormuzShare: 0.6, spareBypassKbd: 1000 },
  KW: { name: "Kuwait", hormuzShare: 1, spareBypassKbd: 0 },
  QA: { name: "Qatar", hormuzShare: 1, spareBypassKbd: 0 },
  IQ: { name: "Iraq", hormuzShare: 0.9, spareBypassKbd: 0 },
  IR: { name: "Iran", hormuzShare: 0.9, spareBypassKbd: 0 },
  BH: { name: "Bahrain", hormuzShare: 1, spareBypassKbd: 0 },
  OM: { name: "Oman", hormuzShare: 0, spareBypassKbd: 0 },
};

async function latestEvidence(c: pg.PoolClient, externalKeyLike: string): Promise<string | null> {
  const r = await c.query("SELECT id FROM evidence_objects WHERE external_key LIKE $1 AND validation_status <> 'quarantined' ORDER BY retrieved_at DESC, version DESC LIMIT 1", [externalKeyLike]);
  return r.rows[0]?.id ?? null;
}

/** Seeds the Gulf crude structure. Observed links cite the stored JODI and IMF snapshots. */
export async function seedOilStructure(c: pg.PoolClient, institutionId: string): Promise<{ entities: number; links: number }> {
  const g = new PostgresGraph(c, institutionId);
  const jodi = await latestEvidence(c, "series:jodi-gulf-crude-monthly:%");
  const imf = await latestEvidence(c, "series:imf-commodity-prices-monthly");
  let entities = 0, links = 0;
  await g.upsertEntity({ kind: "chokepoint", key: "chokepoint:hormuz", name: "Strait of Hormuz", attrs: { note: "Maritime passage between the Persian Gulf and the Gulf of Oman" } }); entities++;
  await g.upsertEntity({ kind: "commodity", key: "commodity:brent", name: "Brent crude benchmark", attrs: { seriesKey: "imf-commodity-prices-monthly", subject: "imf-commodity-prices-monthly|commodity=POILBRE", predicate: "Price", unit: "US$ per barrel" } }); entities++;
  await g.upsertEntity({ kind: "indicator", key: "indicator:reserves:SA", name: "Saudi reserve assets (total)", attrs: { seriesKey: "sama-reserve-assets-quarterly", subject: "sama-reserve-assets-quarterly|Reserve Assets=Total Reserves Assets", predicate: "Million SAR", unit: "million SAR" } }); entities++;
  for (const [code, p] of Object.entries(HORMUZ_PLANNING)) {
    const key = `country:${code}`;
    await g.upsertEntity({ kind: "country", key, name: p.name, attrs: { code, exportsSubject: `jodi-gulf-crude-monthly|country=${code}|flow=TOTEXPSB`, exportsPredicate: "Total exports", productionSubject: `jodi-gulf-crude-monthly|country=${code}|flow=INDPROD` } }); entities++;
    await g.addLink({ subject: "chokepoint:hormuz", predicate: "constrains_exports_of", object: key, linkClass: "assumed", params: { hormuzShare: p.hormuzShare, spareBypassKbd: p.spareBypassKbd },
      rationale: "Planning placeholder from route geography. Not sourced. Replace with sourced terminal and pipeline data before any decision use.", author: "analysis-baseline" }); links++;
    await g.addLink({ subject: key, predicate: "supplies", object: "commodity:brent", linkClass: jodi ? "observed" : "assumed", ...(jodi ? { evidence: [{ evidenceId: jodi, role: "supports" as const }] } : { rationale: "Producer of crude oil priced against the benchmark. No evidence snapshot stored yet." }) }); links++;
    await g.addLink({ subject: "commodity:brent", predicate: "sets_revenue_of", object: key, linkClass: "inferred", rationale: "Export revenue is price times volume (accounting identity). Price from the IMF monthly series.", ...(imf ? { evidence: [{ evidenceId: imf, role: "context" as const }] } : {}) }); links++;
  }
  await g.addLink({ subject: "country:SA", predicate: "draws_on", object: "indicator:reserves:SA", linkClass: "assumed", rationale: "Assumes revenue shortfalls are met from reserve assets. Policy behaviour to be confirmed with the institution." }); links++;
  return { entities, links };
}
