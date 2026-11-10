// Deterministic signal rules over stored series. Thresholds are defaults for the first release; an institution sets its own.
export const RULES_VERSION = "signal-rules/1";
export type Severity = "info" | "watch" | "alert";
export interface Point { t: string; v: number; evidenceId: string; validation: string }
export interface Signal { id: string; ruleId: string; severity: Severity; title: string; detail: string; observedAt: string; evidenceIds: string[]; values: Record<string, number | string> }
export interface RuleDoc { id: string; title: string; description: string; thresholds: string }

export const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const num = (x: number, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const period = (t: string) => t.slice(0, 7);
const sev = (x: number, watch: number, alert: number): Severity | null => x >= alert ? "alert" : x >= watch ? "watch" : null;

export interface SignalThresholds {
  E1: { minMedian: number; watch: number; alert: number }; E2: { watch: number; alert: number }; E3: { watch: number; alert: number };
  S1: { watch: number; alert: number }; S2: { watchBelow: number; alertBelow: number }; S3: { watchBelowMedian: number }; S4: { watch: number; alert: number };
}
/** First-release defaults. The institution's governed settings replace them. */
export const DEFAULT_THRESHOLDS: SignalThresholds = {
  E1: { minMedian: 100, watch: 0.2, alert: 0.4 }, E2: { watch: 0.15, alert: 0.25 }, E3: { watch: 0.15, alert: 0.3 },
  S1: { watch: 0.02, alert: 0.05 }, S2: { watchBelow: 0.25, alertBelow: 0.15 }, S3: { watchBelowMedian: 0.5 }, S4: { watch: 3, alert: 5 },
};
const P = (x: number) => `${+(x * 100).toFixed(1)}%`;
export const ruleDocs = (pack: "energy" | "sovereign", th: SignalThresholds = DEFAULT_THRESHOLDS): RuleDoc[] => pack === "energy" ? [
  { id: "E1", title: "Exports well below their recent level", description: `A country's latest monthly crude exports compared with the median of the previous 12 months. Countries whose median is under ${th.E1.minMedian} thousand barrels a day are skipped as too small to read.`, thresholds: `Watch at ${P(th.E1.watch)} below, alert at ${P(th.E1.alert)} below.` },
  { id: "E2", title: "Large monthly move in Brent", description: "The latest monthly Brent price against the month before.", thresholds: `Watch at a ${P(th.E2.watch)} move, alert at ${P(th.E2.alert)}, in either direction.` },
  { id: "E3", title: "Gulf total exports well below their recent level", description: "Total crude exports of the countries with current data, latest month against the median of the previous 12 months.", thresholds: `Watch at ${P(th.E3.watch)} below, alert at ${P(th.E3.alert)} below.` },
] : [
  { id: "S1", title: "Large quarterly change in reserve assets", description: "Total reserve assets in the latest published quarter against the quarter before.", thresholds: `Watch at a ${P(th.S1.watch)} change, alert at ${P(th.S1.alert)}, in either direction.` },
  { id: "S2", title: "Low liquid share of reserves", description: "Foreign currency and deposits abroad as a share of total reserve assets in the latest quarter.", thresholds: `Watch below ${P(th.S2.watchBelow)}, alert below ${P(th.S2.alertBelow)}.` },
  { id: "S3", title: "Weak trade balance", description: "The latest monthly trade balance against the median of the previous 12 months. A negative balance is always an alert.", thresholds: `Watch when ${P(th.S3.watchBelowMedian)} below the median, alert when negative.` },
  { id: "S4", title: "High consumer inflation", description: "The published inflation rate for the general consumer price index, latest month.", thresholds: `Watch at ${th.S4.watch}%, alert at ${th.S4.alert}%.` },
];
/** E1 and E3: latest value far below the median of the twelve months before it. */
export function belowRecent(points: Point[], o: { minMedian: number; watch: number; alert: number }): { latest: Point; median: number; change: number; severity: Severity } | null {
  const s = [...points].sort((a, b) => a.t.localeCompare(b.t)), latest = s.at(-1);
  if (!latest || s.length < 9) return null;
  const prior = s.slice(-13, -1).map(p => p.v), m = median(prior);
  if (!(m >= o.minMedian)) return null;
  const change = latest.v / m - 1, severity = sev(-change, o.watch, o.alert);
  return severity ? { latest, median: m, change, severity } : null;
}

export function energySignals(a: { exports: Record<string, Point[]>; brent: Point[] }, names: Record<string, string>, th: SignalThresholds = DEFAULT_THRESHOLDS): Signal[] {
  const out: Signal[] = [];
  // A country whose newest stored month is older than the others is lagging, not falling. It is shown as lagging and never compared.
  const newest = Object.values(a.exports).flat().map(p => p.t).sort().at(-1);
  const current = Object.fromEntries(Object.entries(a.exports).filter(([, pts]) => pts.some(p => p.t === newest)));
  for (const [code, pts] of Object.entries(current)) {
    const r = belowRecent(pts, th.E1);
    if (r) out.push({ id: `E1:${code}:${period(r.latest.t)}`, ruleId: "E1", severity: r.severity, title: `${names[code] ?? code}: crude exports ${pct(-r.change)} below their recent level`,
      detail: `${num(r.latest.v)} thousand barrels a day in ${period(r.latest.t)}, against a median of ${num(r.median)} over the previous 12 months.`, observedAt: r.latest.t, evidenceIds: [r.latest.evidenceId], values: { latest: r.latest.v, median: r.median, change: r.change, country: code } });
  }
  const months = new Map<string, { v: number; ev: string[] }>();
  for (const pts of Object.values(current)) for (const p of pts) { const x = months.get(p.t) ?? { v: 0, ev: [] }; x.v += p.v; x.ev.push(p.evidenceId); months.set(p.t, x); }
  const total: Point[] = [...months].map(([t, x]) => ({ t, v: x.v, evidenceId: x.ev[0]!, validation: "accepted" }));
  const g = belowRecent(total, { minMedian: th.E1.minMedian, watch: th.E3.watch, alert: th.E3.alert });
  if (g) out.push({ id: `E3:GULF:${period(g.latest.t)}`, ruleId: "E3", severity: g.severity, title: `Gulf total crude exports ${pct(-g.change)} below their recent level`,
    detail: `${num(g.latest.v)} thousand barrels a day in ${period(g.latest.t)}, against a median of ${num(g.median)} over the previous 12 months.`, observedAt: g.latest.t, evidenceIds: [...new Set(months.get(g.latest.t)!.ev)], values: { latest: g.latest.v, median: g.median, change: g.change } });
  const b = [...a.brent].sort((x, y) => x.t.localeCompare(y.t));
  if (b.length >= 2) {
    const last = b.at(-1)!, prev = b.at(-2)!, move = last.v / prev.v - 1, s = sev(Math.abs(move), th.E2.watch, th.E2.alert);
    if (s) out.push({ id: `E2:BRENT:${period(last.t)}`, ruleId: "E2", severity: s, title: `Brent ${move > 0 ? "rose" : "fell"} ${pct(Math.abs(move))} in a month`, detail: `US$ ${num(last.v, 1)} in ${period(last.t)}, from US$ ${num(prev.v, 1)} in ${period(prev.t)}.`, observedAt: last.t, evidenceIds: [...new Set([last.evidenceId, prev.evidenceId])], values: { latest: last.v, previous: prev.v, change: move } });
  }
  return out;
}

export function sovereignSignals(a: { reserves: Point[]; liquid: Point[]; trade: Point[]; inflation: Point[] }, th: SignalThresholds = DEFAULT_THRESHOLDS): Signal[] {
  const out: Signal[] = [], by = (x: Point[]) => [...x].sort((p, q) => p.t.localeCompare(q.t));
  const r = by(a.reserves);
  if (r.length >= 2) {
    const last = r.at(-1)!, prev = r.at(-2)!, ch = last.v / prev.v - 1, s = sev(Math.abs(ch), th.S1.watch, th.S1.alert);
    if (s) out.push({ id: `S1:RESERVES:${period(last.t)}`, ruleId: "S1", severity: s, title: `Reserve assets ${ch > 0 ? "rose" : "fell"} ${pct(Math.abs(ch), 1)} in the quarter`, detail: `SAR ${num(last.v)} million in ${period(last.t)}, from SAR ${num(prev.v)} million in ${period(prev.t)}.`, observedAt: last.t, evidenceIds: [...new Set([last.evidenceId, prev.evidenceId])], values: { latest: last.v, previous: prev.v, change: ch } });
    const liq = by(a.liquid).find(p => p.t === last.t);
    if (liq) { const share = liq.v / last.v, s2 = share < 0.15 ? "alert" : share < 0.25 ? "watch" : null; if (s2) out.push({ id: `S2:LIQUID:${period(last.t)}`, ruleId: "S2", severity: s2, title: `Liquid assets are ${pct(share, 1)} of reserves`, detail: `Foreign currency and deposits abroad are SAR ${num(liq.v)} million of SAR ${num(last.v)} million in ${period(last.t)}.`, observedAt: last.t, evidenceIds: [...new Set([liq.evidenceId, last.evidenceId])], values: { share, liquid: liq.v, total: last.v } }); }
  }
  const t = by(a.trade), lt = t.at(-1);
  if (lt && t.length >= 9) {
    const m = median(t.slice(-13, -1).map(p => p.v));
    if (lt.v < 0) out.push({ id: `S3:TRADE:${period(lt.t)}`, ruleId: "S3", severity: "alert", title: "Trade balance is negative", detail: `SAR ${num(lt.v)} million in ${period(lt.t)}; the median of the previous 12 months was SAR ${num(m)} million.`, observedAt: lt.t, evidenceIds: [lt.evidenceId], values: { latest: lt.v, median: m } });
    else if (m > 0 && lt.v / m - 1 <= -th.S3.watchBelowMedian) out.push({ id: `S3:TRADE:${period(lt.t)}`, ruleId: "S3", severity: "watch", title: `Trade balance ${pct(1 - lt.v / m)} below its recent level`, detail: `SAR ${num(lt.v)} million in ${period(lt.t)}, against a median of SAR ${num(m)} million over the previous 12 months.`, observedAt: lt.t, evidenceIds: [lt.evidenceId], values: { latest: lt.v, median: m, change: lt.v / m - 1 } });
  }
  const i = by(a.inflation).at(-1);
  if (i) { const s = sev(i.v, th.S4.watch, th.S4.alert); if (s) out.push({ id: `S4:CPI:${period(i.t)}`, ruleId: "S4", severity: s, title: `Consumer inflation is ${num(i.v, 1)}%`, detail: `The published inflation rate for the general index in ${period(i.t)}.`, observedAt: i.t, evidenceIds: [i.evidenceId], values: { rate: i.v } }); }
  return out;
}

const ORDER: Record<Severity, number> = { alert: 0, watch: 1, info: 2 };
export const rank = (s: Signal[]): Signal[] => [...s].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
