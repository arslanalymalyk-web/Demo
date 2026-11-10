import { HORIZONS, HORIZON_DAYS, type GulfBaseline, type Metric, type Shock } from "./types.js";

/** Average of exp(-k t) over [0, h]: (1 - e^{-kh}) / (kh). */
export function avgDecay(h: number, halfLifeDays: number): number {
  const k = Math.LN2 / halfLifeDays;
  return h === 0 ? 1 : -Math.expm1(-k * h) / (k * h);
}
export const endDecay = (h: number, halfLifeDays: number): number => Math.exp(-(Math.LN2 / halfLifeDays) * h);

/** Deterministic oil-shock arithmetic. Prices carry a premium that decays exponentially from onset; volumes are lost only while the event lasts.
 *  Revenue is volume times price (an accounting identity). No model is involved. */
export function simulate(b: GulfBaseline, s: Shock): Metric[] {
  const out: Metric[] = [];
  const totalLostKbd = Object.values(s.lostKbd).reduce((a, x) => a + x, 0);
  const reservesMusd = b.reservesMillionSar === null ? null : b.reservesMillionSar / s.usdPerSar;
  for (const hz of HORIZONS) {
    const h = HORIZON_DAYS[hz], active = Math.min(h, s.durationDays);
    const priceAvg = b.priceUsd * (1 + s.peakPremium * avgDecay(h, s.halfLifeDays));
    const priceEnd = b.priceUsd * (1 + s.peakPremium * endDecay(h, s.halfLifeDays));
    out.push({ horizon: hz, metric: "brent_end_usd", value: priceEnd, unit: "US$ per barrel", baseline: b.priceUsd });
    out.push({ horizon: hz, metric: "brent_avg_usd", value: priceAvg, unit: "US$ per barrel", baseline: b.priceUsd });
    out.push({ horizon: hz, metric: "lost_supply_kbd", value: totalLostKbd, unit: "thousand barrels per day", baseline: 0 });
    let gulfBase = 0, gulfScn = 0, saDelta = 0;
    for (const c of b.countries) {
      const baseRev = c.exportsKbd * 1000 * h * b.priceUsd / 1e6;
      const lostBbl = (s.lostKbd[c.code] ?? 0) * 1000 * active;
      const scnRev = (c.exportsKbd * 1000 * h - lostBbl) * priceAvg / 1e6;
      out.push({ horizon: hz, metric: `revenue_delta_musd:${c.code}`, value: scnRev - baseRev, unit: "million US$", baseline: 0 });
      gulfBase += baseRev; gulfScn += scnRev;
      if (c.code === "SA") saDelta = scnRev - baseRev;
    }
    out.push({ horizon: hz, metric: "gulf_revenue_delta_musd", value: gulfScn - gulfBase, unit: "million US$", baseline: 0 });
    if (reservesMusd !== null) out.push({ horizon: hz, metric: "sa_reserve_drawdown_pct", value: Math.max(0, -saDelta) * s.reserveDrawShare / reservesMusd * 100, unit: "% of reserve assets", baseline: 0 });
  }
  return out;
}
