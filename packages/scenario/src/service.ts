import type pg from "pg";
import { keysetPage, type Page } from "../../core/src/index.js";
import { PostgresGraph } from "../../graph/src/index.js";
import { readObservations, type ObservedFact } from "../../ingest/src/observations.js";
import { audit } from "../../ingest/src/store.js";
import { backtest, type Backtest } from "./backtest.js";
import { hashManifest, hashResults, manifestOf, metricKey, resolveParams, runScenario, type DefaultsOverride, type RunOutput } from "./engine.js";
import { TEMPLATES } from "./templates.js";
import type { Baseline, CountryBaseline, FactRef, GdpBaseline, Need, Param, Params, ReservesBaseline } from "./types.js";

const JODI = "jodi-gulf-crude-monthly", IMF = "imf-commodity-prices-monthly", RESERVES = "sama-reserve-assets-quarterly", GDP = "gastat-gdp-main-activities-quarterly";
const ref = (f: ObservedFact): FactRef => ({ evidenceId: f.evidenceId, subject: f.subject, validTime: f.validTime, value: f.value, validation: f.validation });
const monthOf = (iso: string) => iso.slice(0, 7);
const monthStart = (m: string) => `${m}-01T00:00:00Z`;

export async function latestBaselineMonth(c: pg.PoolClient): Promise<string> {
  const r = await c.query(`SELECT max(f.valid_time) AS t FROM evidence_facts f JOIN series s ON s.id = f.series_id WHERE s.series_key = $1 AND f.subject LIKE '%flow=TOTEXPSB'`, [JODI]);
  if (r.rows[0]?.t) return monthOf(new Date(r.rows[0].t).toISOString());
  const q = await c.query(`SELECT max(f.valid_time) AS t FROM evidence_facts f JOIN series s ON s.id = f.series_id WHERE s.series_key = $1`, [RESERVES]);
  if (q.rows[0]?.t) return monthOf(new Date(q.rows[0].t).toISOString());
  throw new MissingHistoryError("no stored observations to build a baseline from; ingest the series first");
}

/** Reads the baseline for a month from stored evidence. Exposure and bypass capacity come from the graph's links and keep their link class. */
async function loadGulf(c: pg.PoolClient, institutionId: string, month: string): Promise<Baseline> {
  const g = new PostgresGraph(c, institutionId);
  const links = await g.linked("chokepoint:hormuz", "constrains_exports_of").catch(e => { if (e instanceof Error && e.message.startsWith("unknown entity")) return []; throw e; });
  if (links.length === 0) throw new MissingHistoryError("graph has no Hormuz structure; seed it first");
  const at = monthStart(month);
  const subjects = links.flatMap(l => [String(l.attrs.exportsSubject), String(l.attrs.productionSubject)]);
  const facts = await readObservations(c, JODI, { subjects, from: at, to: at });
  const by = new Map(facts.map(f => [f.subject, f]));
  const countries: CountryBaseline[] = [];
  for (const l of links) {
    const ex = by.get(String(l.attrs.exportsSubject)), pr = by.get(String(l.attrs.productionSubject));
    if (!ex || !pr) continue; // a country without observations for the month is left out rather than guessed
    countries.push({ code: String(l.attrs.code), name: l.name, exportsKbd: ex.value, productionKbd: pr.value, hormuzShare: Number(l.params.hormuzShare), spareBypassKbd: Number(l.params.spareBypassKbd), linkClass: l.linkClass, refs: [ref(ex), ref(pr)] });
  }
  if (countries.length === 0) throw new MissingHistoryError(`no export observations for ${month}`);
  const brent = await readObservations(c, IMF, { subjects: [`${IMF}|commodity=POILBRE`], from: at, to: at });
  if (!brent[0]) throw new MissingHistoryError(`no Brent price for ${month}`);
  const res = (await readObservations(c, RESERVES, { subjects: [`${RESERVES}|Reserve Assets=Total Reserves Assets`], to: at })).at(-1) ?? null;
  return { month, priceUsd: brent[0].value, priceRef: ref(brent[0]), countries, reservesMillionSar: res?.value ?? null, reservesRef: res ? ref(res) : null };
}

const RES_TYPES = { total: "Total Reserves Assets", liquid: "Foreign Currency and Deposits Abroad", securities: "Investment in Foreign Securities", gold: "Monetary Gold", imf: "Reserve Position in the IMF", sdr: "SDR" } as const;

/** The latest published composition of reserve assets at or before the month. All classes come from the same quarter. */
async function loadReserves(c: pg.PoolClient, month: string): Promise<ReservesBaseline> {
  const all = await readObservations(c, RESERVES, { subjects: Object.values(RES_TYPES).map(t => `${RESERVES}|Reserve Assets=${t}`), to: monthStart(month) });
  const total = all.filter(f => f.subject.endsWith(RES_TYPES.total));
  if (total.length === 0) throw new Error(`no reserve-asset observations on or before ${month}`);
  const at = total.at(-1)!.validTime, pick = (t: string) => { const f = all.find(x => x.subject.endsWith(`=${t}`) && x.validTime === at); if (!f) throw new Error(`reserve assets (${t}) are missing for ${at.slice(0, 7)}`); return f; };
  const parts = { total: pick(RES_TYPES.total), liquid: pick(RES_TYPES.liquid), securities: pick(RES_TYPES.securities), gold: pick(RES_TYPES.gold), imf: pick(RES_TYPES.imf), sdr: pick(RES_TYPES.sdr) };
  const drift = Math.abs(parts.liquid.value + parts.securities.value + parts.gold.value + parts.imf.value + parts.sdr.value - parts.total.value) / parts.total.value;
  if (drift > 0.01) throw new Error(`reserve asset classes do not add up to the total for ${at.slice(0, 7)} (off by ${(drift * 100).toFixed(1)}%)`);
  return { quarter: at.slice(0, 7), totalMillionSar: parts.total.value, liquidMillionSar: parts.liquid.value, securitiesMillionSar: parts.securities.value, goldMillionSar: parts.gold.value, otherMillionSar: parts.imf.value + parts.sdr.value, refs: Object.values(parts).map(ref) };
}

/** One year of nominal GDP by activity: the four most recent quarters at or before the month, summed. */
async function loadGdp(c: pg.PoolClient, month: string): Promise<GdpBaseline> {
  const acts = { oil: "Oil Activities", nonOil: "Non-Oil Activities", gov: "Government Activities" } as const;
  const all = (await readObservations(c, GDP, { subjects: Object.values(acts).map(a => `${GDP}|Main Economic Activities=${a}`), to: monthStart(month) })).filter(f => f.predicate === "Nominal GDP");
  const last4 = (a: string) => all.filter(f => f.subject.endsWith(`=${a}`)).slice(-4);
  const [o, n, g] = [last4(acts.oil), last4(acts.nonOil), last4(acts.gov)];
  if ([o, n, g].some(x => x.length < 4)) throw new Error(`fewer than four quarters of nominal GDP on or before ${month}`);
  if (new Set([...o, ...n, ...g].map(f => f.validTime)).size !== 4) throw new Error("GDP activities do not cover the same four quarters");
  const sum = (x: typeof o) => x.reduce((a, f) => a + f.value, 0);
  return { quarter: o.at(-1)!.validTime.slice(0, 7), annualOilMillion: sum(o), annualNonOilMillion: sum(n), annualGovernmentMillion: sum(g), unitStated: [...o, ...n, ...g].every(f => f.unit !== null), refs: [...o, ...n, ...g].map(ref) };
}

/** Builds the baseline a template needs from stored evidence. Sections a template does not use are left out. */
export async function loadBaseline(c: pg.PoolClient, institutionId: string, month: string, needs: Need[] = ["gulf"]): Promise<Baseline> {
  const base: Baseline = needs.includes("gulf") ? await loadGulf(c, institutionId, month) : { month, priceUsd: null, priceRef: null, countries: [], reservesMillionSar: null, reservesRef: null };
  if (needs.includes("reserves")) base.reserves = await loadReserves(c, month);
  if (needs.includes("gdp")) base.gdp = await loadGdp(c, month);
  return base;
}

/** Observed episode: exports lost against the baseline month, and the Brent price in each episode month. */
export class MissingHistoryError extends Error { constructor(message: string) { super(message); } }

export async function episodeBacktest(c: pg.PoolClient, institutionId: string, baselineMonth: string, episode: string[], globalSupplyKbd: number): Promise<Backtest> {
  const base = await loadBaseline(c, institutionId, baselineMonth);
  if (base.priceUsd === null) throw new MissingHistoryError(`no Brent price is stored for ${baselineMonth}`);
  const months = [];
  for (const m of episode) {
    const b = await loadBaseline(c, institutionId, m);
    if (b.priceUsd === null) throw new MissingHistoryError(`no Brent price is stored for ${m}`);
    const lost = base.countries.reduce((a, c0) => a + Math.max(0, c0.exportsKbd - (b.countries.find(x => x.code === c0.code)?.exportsKbd ?? c0.exportsKbd)), 0);
    months.push({ month: m, lostKbd: lost, observedPrice: b.priceUsd });
  }
  return backtest(baselineMonth, base.priceUsd!, globalSupplyKbd, months);
}

export const EPISODE = { baseline: "2026-02", months: ["2026-03", "2026-04", "2026-05"] };

export interface RunRequest { templateKey: string; overrides?: Record<string, number>; baselineMonth?: string; createdBy: string; today?: Date; settings?: DefaultsOverride }
export interface StoredRun extends RunOutput { id: string; manifestHash: string; resultsHash: string; baseline: Baseline; graphHash: string | null; created: string }

/** The back-test, or null when the stored records do not cover the episode. A deployment without that history says so; it does not fail. */
export async function episodeBacktestIfStored(c: pg.PoolClient, institutionId: string): Promise<Backtest | null> {
  try { return await episodeBacktest(c, institutionId, EPISODE.baseline, EPISODE.months, 100000); }
  catch (e) { if (e instanceof MissingHistoryError) return null; throw e; }
}
async function calibratedFlexibility(c: pg.PoolClient, institutionId: string): Promise<{ flex: number | null }> {
  return { flex: (await episodeBacktestIfStored(c, institutionId))?.flexibility ?? null };
}

export async function createRun(c: pg.PoolClient, institutionId: string, req: RunRequest): Promise<StoredRun> {
  if (!TEMPLATES[req.templateKey]) throw new Error(`unknown scenario template ${req.templateKey}`);
  const today = req.today ?? new Date();
  const tpl = TEMPLATES[req.templateKey]!;
  const baseline = await loadBaseline(c, institutionId, req.baselineMonth ?? await latestBaselineMonth(c), tpl.needs);
  const flex = tpl.usesFlexibility ? (await calibratedFlexibility(c, institutionId)).flex : null;
  const params = resolveParams(req.templateKey, req.overrides ?? {}, flex, req.settings);
  const snap = await new PostgresGraph(c, institutionId).snapshot();
  const out = runScenario(req.templateKey, baseline, params, today);
  const manifest = manifestOf({ templateKey: out.templateKey, templateVersion: out.templateVersion, formulaVersion: out.formulaVersion, params, baseline, graphHash: snap.hash });
  const manifestHash = hashManifest(manifest), resultsHash = hashResults(out);
  const ins = await c.query(
    `INSERT INTO scenario_runs (institution_id, template_key, template_version, formula_version, graph_snapshot_id, assumptions, inputs, manifest_hash, results_hash, confidence, sensitivity, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, created_at`,
    [institutionId, out.templateKey, out.templateVersion, out.formulaVersion, snap.id, JSON.stringify(params), JSON.stringify({ baseline, graphHash: snap.hash, runAt: today.toISOString(), settings: { scenarioDefaultsVersion: req.settings?.version ?? null } }), manifestHash, resultsHash, JSON.stringify(out.confidence), JSON.stringify(out.sensitivity), req.createdBy]);
  const id = ins.rows[0].id as string;
  for (const m of out.metrics) {
    const lineage = { band: out.bands[metricKey(m)], formula: out.formulaVersion, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.basis])), baselineMonth: baseline.month, evidence: [...new Set([...(baseline.priceRef ? [baseline.priceRef.evidenceId] : []), ...baseline.countries.flatMap(x => x.refs.map(r => r.evidenceId)), ...(baseline.reserves?.refs ?? []).map(r => r.evidenceId), ...(baseline.gdp?.refs ?? []).map(r => r.evidenceId)])] };
    await c.query("INSERT INTO scenario_results (institution_id, run_id, horizon, metric, value, unit, baseline, lineage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [institutionId, id, m.horizon, m.metric, m.value, m.unit, m.baseline, JSON.stringify(lineage)]);
  }
  await audit(c, institutionId, { actorType: "principal", actorId: req.createdBy, action: "scenario.run", objectType: "scenario_run", objectId: id, payload: { template: req.templateKey, manifestHash, resultsHash, confidence: out.confidence.level } });
  return { ...out, id, manifestHash, resultsHash, baseline, graphHash: snap.hash, created: new Date(ins.rows[0].created_at).toISOString() };
}

export interface ReplayResult { runId: string; manifestMatches: boolean; resultsMatch: boolean; storedResultsHash: string; replayedResultsHash: string; storedRowsMatch: boolean }

/** Recomputes a stored run from its own stored inputs and compares hashes. Any drift in code, inputs or stored rows shows up as a mismatch. */
export async function replayRun(c: pg.PoolClient, runId: string): Promise<ReplayResult> {
  const r = (await c.query("SELECT * FROM scenario_runs WHERE id = $1", [runId])).rows[0];
  if (!r) throw new Error("run not found");
  const baseline = r.inputs.baseline as Baseline, params = r.assumptions as Params;
  const out = runScenario(r.template_key, baseline, params, new Date(r.inputs.runAt));
  const manifestMatches = hashManifest(manifestOf({ templateKey: r.template_key, templateVersion: r.template_version, formulaVersion: r.formula_version, params, baseline, graphHash: r.inputs.graphHash })) === r.manifest_hash;
  const replayed = hashResults(out);
  const rows = (await c.query("SELECT horizon, metric, value FROM scenario_results WHERE run_id = $1", [runId])).rows;
  const stored = new Map(rows.map(x => [`${x.horizon}|${x.metric}`, x.value as number]));
  const storedRowsMatch = rows.length === out.metrics.length && out.metrics.every(m => stored.get(metricKey(m)) === m.value);
  return { runId, manifestMatches, resultsMatch: replayed === r.results_hash, storedResultsHash: r.results_hash, replayedResultsHash: replayed, storedRowsMatch };
}

const RUN_COLS = "r.id, r.template_key, r.template_version, r.formula_version, r.manifest_hash, r.results_hash, r.confidence->>'level' AS confidence, r.created_by, r.created_at";
export async function listRunsPage(c: pg.PoolClient, f: { template?: string; limit?: number; cursor?: string } = {}): Promise<Page<Record<string, unknown>>> {
  return keysetPage(c, { select: RUN_COLS, from: "scenario_runs r", where: "$1::text IS NULL OR r.template_key = $1", params: [f.template ?? null], ts: "r.created_at", id: "r.id", limit: f.limit ?? 50, cursor: f.cursor });
}
/** The newest 100 runs, for code that needs them all at once (in-process use only; screens page through listRunsPage). */
export async function listRuns(c: pg.PoolClient): Promise<unknown[]> { return (await listRunsPage(c, { limit: 100 })).rows; }
export async function getRun(c: pg.PoolClient, runId: string): Promise<unknown | null> {
  const r = (await c.query("SELECT * FROM scenario_runs WHERE id = $1", [runId])).rows[0];
  if (!r) return null;
  const results = (await c.query("SELECT horizon, metric, value, unit, baseline, lineage FROM scenario_results WHERE run_id = $1 ORDER BY horizon, metric", [runId])).rows;
  return { id: r.id, template: r.template_key, templateVersion: r.template_version, formulaVersion: r.formula_version, graphSnapshotId: r.graph_snapshot_id, assumptions: r.assumptions, inputs: r.inputs, manifestHash: r.manifest_hash, resultsHash: r.results_hash, confidence: r.confidence, sensitivity: r.sensitivity, createdBy: r.created_by, createdAt: r.created_at, results };
}
export type { Param };

export interface RunBrief { id: string; templateKey: string; confidence: "low" | "medium" | "high"; createdAt: string; resultsHash: string }
/** A short description of runs, for other modules that attach scenarios to their own records. */
export async function runBriefs(c: pg.PoolClient, ids: string[]): Promise<RunBrief[]> {
  if (ids.length === 0) return [];
  return (await c.query("SELECT id, template_key, confidence->>'level' AS level, created_at, results_hash FROM scenario_runs WHERE id = ANY($1::uuid[])", [ids])).rows
    .map(r => ({ id: r.id, templateKey: r.template_key, confidence: r.level, createdAt: new Date(r.created_at).toISOString(), resultsHash: r.results_hash }));
}
