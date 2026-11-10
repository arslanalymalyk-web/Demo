import { canonicalJson, sha256Hex } from "../../core/src/index.js";
import { TEMPLATES } from "./templates.js";
import type { Baseline, FactRef, Metric, Params, Template } from "./types.js";

export interface Band { low: number; high: number }
export interface Sensitivity { param: string; low: number; high: number; basis: string; effects: Record<string, [number, number]> }
export interface Confidence { level: "low" | "medium" | "high"; score: number; basis: { assumedShare: number; sourceValidation: number; recency: number; sensitivity: number }; notes: string[] }
export interface RunOutput { templateKey: string; templateVersion: number; formulaVersion: string; params: Params; metrics: Metric[]; bands: Record<string, Band>; sensitivity: Sensitivity[]; confidence: Confidence }

export const metricKey = (m: Pick<Metric, "horizon" | "metric">): string => `${m.horizon}|${m.metric}`;
const values = (ps: Params): Record<string, number> => Object.fromEntries(Object.entries(ps).map(([k, x]) => [k, x.value]));

export function resolveParams(templateKey: string, overrides: Record<string, number>, flex: number | null): Params {
  const t = TEMPLATES[templateKey]; if (!t) throw new Error(`unknown scenario template ${templateKey}`);
  const ps = t.defaults(flex);
  for (const [k, v] of Object.entries(overrides)) {
    const d = ps[k]; if (!d) throw new Error(`unknown parameter ${k} for ${templateKey}`);
    if (!Number.isFinite(v)) throw new Error(`parameter ${k} must be a finite number`);
    ps[k] = { ...d, value: v, low: Math.min(d.low, v), high: Math.max(d.high, v) };
  }
  return ps;
}

const evaluate = (templateKey: string, b: Baseline, ps: Params): Metric[] => TEMPLATES[templateKey]!.compute(b, values(ps));

/** One-at-a-time sensitivity: every parameter with a range is moved to its low and high end while the rest stay fixed. */
export function sensitivity(templateKey: string, b: Baseline, ps: Params, base: Metric[]): Sensitivity[] {
  const out: Sensitivity[] = [];
  // Sorted so the result does not depend on key order, which jsonb storage does not preserve.
  for (const [name, d] of Object.entries(ps).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (d.low === d.high) continue;
    const at = (v: number) => new Map(evaluate(templateKey, b, { ...ps, [name]: { ...d, value: v } }).map(m => [metricKey(m), m.value]));
    const lo = at(d.low), hi = at(d.high);
    const effects: Record<string, [number, number]> = {};
    for (const m of base) effects[metricKey(m)] = [lo.get(metricKey(m))!, hi.get(metricKey(m))!];
    out.push({ param: name, low: d.low, high: d.high, basis: d.basis, effects });
  }
  return out;
}

/** Combines the one-at-a-time swings in quadrature, separately for the downside and the upside of each metric. */
export function bands(base: Metric[], sens: Sensitivity[], nonNegative: string[] = []): Record<string, Band> {
  const out: Record<string, Band> = {};
  for (const m of base) {
    let down = 0, up = 0;
    for (const s of sens) { const [a, b] = s.effects[metricKey(m)]!; down += Math.max(0, m.value - Math.min(a, b)) ** 2; up += Math.max(0, Math.max(a, b) - m.value) ** 2; }
    const low = m.value - Math.sqrt(down);
    out[metricKey(m)] = { low: nonNegative.includes(m.metric) ? Math.max(0, low) : low, high: m.value + Math.sqrt(up) };
  }
  return out;
}

export function confidence(t: Template, b: Baseline, ps: Params, bd: Record<string, Band>, base: Metric[], today: Date): Confidence {
  const notes: string[] = [];
  const entries = Object.values(ps).filter(x => x.low !== x.high || x.basis !== "assumed");
  const assumedShare = entries.length === 0 ? 0 : entries.filter(x => x.basis === "assumed").length / entries.length;
  const refs: FactRef[] = [...(b.priceRef ? [b.priceRef] : []), ...b.countries.flatMap(c => c.refs), ...(b.reservesRef ? [b.reservesRef] : []), ...(b.reserves?.refs ?? []), ...(b.gdp?.refs ?? [])];
  const sourceValidation = refs.length === 0 ? 0 : refs.reduce((a, r) => a + (r.validation === "accepted" ? 1 : r.validation === "warned" ? 0.5 : 0), 0) / refs.length;
  if (sourceValidation < 1) notes.push("Some inputs are warned: licence or terms not yet confirmed.");
  const baselineDate = b.reserves && !b.priceRef ? b.reserves.quarter : b.month;
  const ageDays = (today.getTime() - new Date(`${baselineDate.length === 7 ? `${baselineDate}-01` : baselineDate}T00:00:00Z`).getTime()) / 86_400_000;
  const recency = Math.max(0, Math.min(1, 1 - (ageDays - 45) / 320));
  if (recency < 0.5) notes.push(`The baseline (${baselineDate.slice(0, 7)}) is ${Math.round(ageDays)} days old.`);
  const headline = base.find(m => m.horizon === t.headline.horizon && m.metric === t.headline.metric);
  const hb = headline ? bd[metricKey(headline)] : undefined;
  const relWidth = headline && hb ? (hb.high - hb.low) / Math.max(Math.abs(headline.value), 1) : 0;
  const sens = 1 / (1 + relWidth);
  if (relWidth > 1) notes.push("The headline range is wider than the estimate itself.");
  const hasAssumedStructure = t.exposure === "hormuz" && b.countries.some(c => c.linkClass === "assumed");
  if (hasAssumedStructure) notes.push("Hormuz exposure and bypass capacity come from assumed links, not sourced data.");
  if (b.gdp && !b.gdp.unitStated) notes.push("The GDP source does not state its unit. It is read as million riyals.");
  const score = (1 - assumedShare + sourceValidation + recency + sens) / 4;
  let level: Confidence["level"] = score >= 0.7 ? "high" : score >= 0.45 ? "medium" : "low";
  if ((assumedShare > 0.5 || hasAssumedStructure) && level === "high") level = "medium";
  return { level, score: Math.round(score * 1000) / 1000, basis: { assumedShare, sourceValidation, recency, sensitivity: sens }, notes };
}

export function runScenario(templateKey: string, b: Baseline, ps: Params, today: Date): RunOutput {
  const t = TEMPLATES[templateKey]!;
  const metrics = evaluate(templateKey, b, ps);
  const sens = sensitivity(templateKey, b, ps, metrics);
  const bd = bands(metrics, sens, t.nonNegative);
  return { templateKey, templateVersion: t.version, formulaVersion: t.formulaVersion, params: ps, metrics, bands: bd, sensitivity: sens, confidence: confidence(t, b, ps, bd, metrics, today) };
}

/** The manifest is everything a run depends on. Hashing it lets a later replay prove it started from identical inputs. */
export const manifestOf = (o: { templateKey: string; templateVersion: number; formulaVersion: string; params: Params; baseline: Baseline; graphHash: string | null }) => ({ ...o });
export const hashManifest = (m: unknown): string => sha256Hex(canonicalJson(m));
export const hashResults = (o: RunOutput): string => sha256Hex(canonicalJson({ metrics: o.metrics, bands: o.bands, sensitivity: o.sensitivity }));
