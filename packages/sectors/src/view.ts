import type pg from "pg";
import { readObservations, seriesStatusForPack, type ObservedFact, type SeriesStatus } from "../../ingest/src/observations.js";
import { DEFAULT_THRESHOLDS, RULES_VERSION, energySignals, median, rank, ruleDocs, sovereignSignals, type Point, type RuleDoc, type Signal, type SignalThresholds } from "./rules.js";

export type PackKey = "energy" | "sovereign";
export const SECTORS: Record<PackKey, { name: string; domains: string[]; seriesPack: string }> = {
  energy: { name: "Energy and Oil", domains: ["energy"], seriesPack: "energy" },
  sovereign: { name: "Sovereign Capital and Treasury", domains: ["sovereign capital", "treasury"], seriesPack: "sovereign_capital" },
};
export const isPack = (k: string): k is PackKey => k in SECTORS;
export const NAMES: Record<string, string> = { SA: "Saudi Arabia", AE: "United Arab Emirates", KW: "Kuwait", QA: "Qatar", BH: "Bahrain", OM: "Oman", IQ: "Iraq", IR: "Iran" };

export interface Figure { id: string; label: string; value: number; unit: string; period: string; change: { text: string; direction: "up" | "down" | "flat" } | null; evidenceId: string; validation: string; note?: string }
export interface Trend { id: string; title: string; unit: string; points: { t: string; v: number }[]; evidenceId: string }
export interface CountryRow { lagging: boolean; code: string; name: string; exportsKbd: number; medianKbd: number; changePct: number | null; productionKbd: number | null; period: string; evidenceId: string }
export interface CompositionRow { label: string; millionSar: number; share: number; evidenceId: string }
export interface SectorView {
  pack: PackKey; name: string; asOf: string; rulesVersion: string; settingsVersion: number | null; figures: Figure[]; trends: Trend[]; signals: Signal[]; rules: RuleDoc[]; freshness: SeriesStatus[];
  countries?: CountryRow[]; composition?: { quarter: string; rows: CompositionRow[] };
}

const JODI = "jodi-gulf-crude-monthly", IMF = "imf-commodity-prices-monthly", RES = "sama-reserve-assets-quarterly", TRADE = "gastat-trade-balance-monthly", CPI = "gastat-cpi-monthly", M3 = "sama-money-supply-m3-monthly", GDP = "gastat-gdp-main-activities-quarterly";
const pt = (f: ObservedFact): Point => ({ t: f.validTime, v: f.value, evidenceId: f.evidenceId, validation: f.validation });
const monthsAgo = (now: Date, n: number): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString();
const sorted = (x: Point[]) => [...x].sort((a, b) => a.t.localeCompare(b.t));
const pctChange = (a: number, b: number) => b === 0 ? null : a / b - 1;
const fmtPct = (x: number, d = 1) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${(Math.abs(x) * 100).toFixed(d)}%`;
const dir = (x: number): "up" | "down" | "flat" => x > 0.0005 ? "up" : x < -0.0005 ? "down" : "flat";
const change = (x: number | null, vs: string): Figure["change"] => x === null ? null : { text: `${fmtPct(x)} ${vs}`, direction: dir(x) };
const trend = (id: string, title: string, unit: string, pts: Point[], n: number): Trend | null => { const s = sorted(pts).slice(-n); return s.length ? { id, title, unit, points: s.map(p => ({ t: p.t, v: p.v })), evidenceId: s.at(-1)!.evidenceId } : null; };

async function energy(c: pg.PoolClient, now: Date, th: SignalThresholds): Promise<Omit<SectorView, "pack" | "name" | "asOf" | "rulesVersion" | "settingsVersion" | "freshness">> {
  const from = monthsAgo(now, 48);
  const jodi = await readObservations(c, JODI, { from }), exportsBy: Record<string, Point[]> = {}, prod: Record<string, Point[]> = {};
  for (const f of jodi) {
    const m = /country=([A-Z]{2})\|flow=(\w+)/.exec(f.subject); if (!m) continue;
    if (m[2] === "TOTEXPSB") (exportsBy[m[1]!] ??= []).push(pt(f)); else if (m[2] === "INDPROD") (prod[m[1]!] ??= []).push(pt(f));
  }
  const brent = (await readObservations(c, IMF, { subjects: [`${IMF}|commodity=POILBRE`], from })).map(pt);
  const figures: Figure[] = [], trends: Trend[] = [], countries: CountryRow[] = [];
  const bs = sorted(brent);
  if (bs.length) { const l = bs.at(-1)!, p = bs.at(-2); figures.push({ id: "brent", label: "Brent crude", value: l.v, unit: "US$ per barrel", period: l.t, change: p ? change(pctChange(l.v, p.v), "on the month") : null, evidenceId: l.evidenceId, validation: l.validation }); }
  const latestMonth = Object.values(exportsBy).flat().map(p => p.t).sort().at(-1);
  const currentCodes = Object.entries(exportsBy).filter(([, pts]) => pts.some(p => p.t === latestMonth)).map(([k]) => k);
  const sumAt = (by: Record<string, Point[]>, t: string) => Object.values(by).reduce((a, pts) => a + (pts.find(p => p.t === t)?.v ?? 0), 0);
  if (latestMonth) {
    const months = [...new Set(currentCodes.flatMap(k => exportsBy[k]!).map(p => p.t))].sort(), total = months.map(t => ({ t, v: sumAt(Object.fromEntries(currentCodes.map(k => [k, exportsBy[k]!])), t), evidenceId: Object.values(exportsBy).flat().find(p => p.t === t)!.evidenceId, validation: "accepted" }));
    const med = median(total.slice(-13, -1).map(p => p.v)), last = total.at(-1)!;
    figures.push({ id: "gulf-exports", label: "Gulf crude exports", value: last.v, unit: "thousand barrels per day", period: last.t, change: Number.isFinite(med) ? change(pctChange(last.v, med), "against the 12-month median") : null, evidenceId: last.evidenceId, validation: Object.values(exportsBy).flat().find(p => p.t === latestMonth)!.validation, note: `Sum of the ${currentCodes.length} countries with stored data for this month: ${currentCodes.map(k => NAMES[k] ?? k).sort().join(", ")}.` });
    const pm = [...new Set(Object.values(prod).flat().map(p => p.t))].sort().at(-1);
    if (pm) { const ps = Object.values(prod).flat().find(p => p.t === pm)!, pmed = median([...new Set(Object.values(prod).flat().map(p => p.t))].sort().slice(-13, -1).map(t => sumAt(prod, t))); figures.push({ id: "gulf-production", label: "Gulf crude production", value: sumAt(prod, pm), unit: "thousand barrels per day", period: pm, change: Number.isFinite(pmed) ? change(pctChange(sumAt(prod, pm), pmed), "against the 12-month median") : null, evidenceId: ps.evidenceId, validation: ps.validation }); }
    const tt = trend("gulf-exports", "Gulf crude exports, monthly", "thousand barrels per day", total, 36); if (tt) trends.push(tt);
    for (const [code, pts] of Object.entries(exportsBy)) {
      const s = sorted(pts), l = s.at(-1)!, m = median(s.slice(-13, -1).map(p => p.v)), pr = sorted(prod[code] ?? []).at(-1);
      const lagging = l.t !== latestMonth;
      countries.push({ lagging, code, name: NAMES[code] ?? code, exportsKbd: l.v, medianKbd: m, changePct: !lagging && Number.isFinite(m) && m > 0 ? l.v / m - 1 : null, productionKbd: pr?.v ?? null, period: l.t, evidenceId: l.evidenceId });
    }
    countries.sort((a, b) => Number(a.lagging) - Number(b.lagging) || b.exportsKbd - a.exportsKbd);
  }
  const bt = trend("brent", "Brent crude, monthly", "US$ per barrel", brent, 36); if (bt) trends.unshift(bt);
  return { figures, trends, countries, signals: rank(energySignals({ exports: exportsBy, brent }, NAMES, th)), rules: ruleDocs("energy", th) };
}

const RES_CLASSES: [string, string][] = [["Foreign currency and deposits abroad", "Foreign Currency and Deposits Abroad"], ["Foreign securities", "Investment in Foreign Securities"], ["Monetary gold", "Monetary Gold"], ["IMF reserve position", "Reserve Position in the IMF"], ["Special drawing rights", "SDR"]];

async function sovereign(c: pg.PoolClient, now: Date, th: SignalThresholds): Promise<Omit<SectorView, "pack" | "name" | "asOf" | "rulesVersion" | "settingsVersion" | "freshness">> {
  const from = monthsAgo(now, 72), figures: Figure[] = [], trends: Trend[] = [];
  const resAll = await readObservations(c, RES, { from }), cls = (t: string) => resAll.filter(f => f.subject.endsWith(`=${t}`)).map(pt);
  const total = sorted(cls("Total Reserves Assets")), liquid = sorted(cls("Foreign Currency and Deposits Abroad"));
  let composition: SectorView["composition"];
  if (total.length) {
    const l = total.at(-1)!, p = total.at(-2), lq = liquid.find(x => x.t === l.t);
    figures.push({ id: "reserves", label: "Reserve assets", value: l.v, unit: "million SAR", period: l.t, change: p ? change(pctChange(l.v, p.v), "on the quarter") : null, evidenceId: l.evidenceId, validation: l.validation });
    if (lq) figures.push({ id: "liquid-share", label: "Liquid share of reserves", value: lq.v / l.v * 100, unit: "% of reserve assets", period: l.t, change: null, evidenceId: lq.evidenceId, validation: lq.validation, note: "Foreign currency and deposits abroad." });
    composition = { quarter: l.t, rows: RES_CLASSES.map(([label, key]) => { const x = cls(key).find(q => q.t === l.t); return x ? { label, millionSar: x.v, share: x.v / l.v, evidenceId: x.evidenceId } : null; }).filter((x): x is CompositionRow => x !== null) };
    const t = trend("reserves", "Reserve assets, quarterly", "million SAR", total, 24); if (t) trends.push(t);
  }
  const tradeAll = await readObservations(c, TRADE, { subjects: [TRADE], from });
  const trade = sorted(tradeAll.filter(f => f.predicate === "Trade Balance").map(pt));
  if (trade.length) { const l = trade.at(-1)!, m = median(trade.slice(-13, -1).map(p => p.v)); figures.push({ id: "trade", label: "Trade balance", value: l.v, unit: "million SAR", period: l.t, change: Number.isFinite(m) && m > 0 ? change(pctChange(l.v, m), "against the 12-month median") : null, evidenceId: l.evidenceId, validation: l.validation }); const t = trend("trade", "Trade balance, monthly", "million SAR", trade, 36); if (t) trends.push(t); }
  const cpiAll = await readObservations(c, CPI, { subjects: [`${CPI}|Main Division=General Index`], from });
  const inflation = sorted(cpiAll.filter(f => f.predicate === "Inflation rate").map(pt));
  if (inflation.length) { const l = inflation.at(-1)!; figures.push({ id: "inflation", label: "Consumer inflation", value: l.v, unit: "% (published rate, general index)", period: l.t, change: null, evidenceId: l.evidenceId, validation: l.validation }); const t = trend("inflation", "Consumer inflation rate, monthly", "%", inflation, 36); if (t) trends.push(t); }
  const m3 = await readObservations(c, M3, { subjects: [M3], from });
  const m3l = sorted(m3.filter(f => f.predicate === "Million SAR").map(pt)).at(-1), m3g = sorted(m3.filter(f => f.predicate === "Growth Rate").map(pt)).at(-1);
  if (m3l) figures.push({ id: "m3", label: "Money supply (M3)", value: m3l.v, unit: "million SAR", period: m3l.t, change: m3g ? { text: `Published growth rate ${m3g.v.toFixed(1)}%`, direction: dir(m3g.v) } : null, evidenceId: m3l.evidenceId, validation: m3l.validation, note: "The source does not say over what period its growth rate is measured." });
  const gdp = (await readObservations(c, GDP, { from })).filter(f => f.predicate === "Nominal GDP"), lastQ = gdp.map(f => f.validTime).sort().at(-1);
  if (lastQ) {
    const at = (a: string) => gdp.find(f => f.validTime === lastQ && f.subject.endsWith(`=${a}`)), o = at("Oil Activities"), n = at("Non-Oil Activities"), g = at("Government Activities");
    if (o && n && g) figures.push({ id: "oil-gdp", label: "Oil activities, share of nominal GDP", value: o.value / (o.value + n.value + g.value) * 100, unit: "% of GDP by activity", period: lastQ, change: null, evidenceId: o.evidenceId, validation: o.validation, note: "A share, so it does not depend on the unit the source leaves unstated." });
  }
  return { figures, trends, composition, signals: rank(sovereignSignals({ reserves: total, liquid, trade, inflation }, th)), rules: ruleDocs("sovereign", th) };
}

export async function buildSector(c: pg.PoolClient, pack: PackKey, now: Date = new Date(), settings: { thresholds: SignalThresholds; version: number | null } = { thresholds: DEFAULT_THRESHOLDS, version: null }): Promise<SectorView> {
  const body = pack === "energy" ? await energy(c, now, settings.thresholds) : await sovereign(c, now, settings.thresholds);
  return { pack, name: SECTORS[pack].name, asOf: now.toISOString(), rulesVersion: RULES_VERSION, settingsVersion: settings.version, freshness: await seriesStatusForPack(c, SECTORS[pack].seriesPack), ...body };
}
