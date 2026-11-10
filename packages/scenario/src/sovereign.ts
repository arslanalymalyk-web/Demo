import { avgDecay, endDecay } from "./calc.js";
import { gulf, HORIZONS, HORIZON_DAYS, type Baseline, type Metric, type Params, type ReservesBaseline, type Template } from "./types.js";
import { p, peg } from "./params.js";

const reserves = (b: Baseline): ReservesBaseline => { if (!b.reserves) throw new Error("this scenario needs the reserve-asset baseline, which is not in the baseline"); return b.reserves; };
const years = (days: number) => days / 365;
const m = (horizon: Metric["horizon"], metric: string, value: number, unit: string, baseline: number | null): Metric => ({ horizon, metric, value, unit, baseline });
const CAP = 99;

/** Funding a stated annual gap from reserve assets, with returns on what remains. Closed form: R(t) = R0 e^{rt} - D (e^{rt} - 1) / r. */
export const reserveRunway: Template = {
  key: "reserve-runway", pack: "sovereign", version: 1, formulaVersion: "reserve-runway/1", title: "Reserve runway under a funding gap",
  description: "A stated annual financing gap is met from reserve assets. Shows how much remains after each horizon, how long the reserves and the most liquid assets last, using the latest published reserve composition.",
  needs: ["reserves"], headline: { horizon: "5y", metric: "reserves_remaining_pct" }, nonNegative: ["reserves_remaining_musd", "reserves_remaining_pct", "liquid_assets_remaining_musd", "runway_years", "liquid_runway_years"], usesFlexibility: false, exposure: null,
  defaults: (): Params => ({
    annualGapUsdBn: p(40, 10, 100, "assumed", "Annual financing gap to be met, in US$ billion. This is the figure under review; it is not taken from a source."),
    reserveFundingShare: p(1, 0.5, 1, "assumed", "Share of the gap met from reserve assets rather than borrowing or other sources."),
    assetReturnPct: p(3, 1, 5, "assumed", "Annual return earned on the reserve assets that remain, in percent."),
    usdPerSar: peg(),
  }),
  compute(b, v) {
    const r0 = reserves(b), fx = v.usdPerSar!, R0 = r0.totalMillionSar / fx, L0 = r0.liquidMillionSar / fx;
    const D = v.annualGapUsdBn! * 1000 * v.reserveFundingShare!, r = v.assetReturnPct! / 100;
    const annuity = (t: number) => (r === 0 ? t : (Math.exp(r * t) - 1) / r);
    const runway = (S: number) => D <= 0 ? CAP : r === 0 ? Math.min(CAP, S / D) : D <= r * S ? CAP : Math.min(CAP, Math.log(D / (D - r * S)) / r);
    const out: Metric[] = [];
    for (const hz of HORIZONS) {
      const t = years(HORIZON_DAYS[hz]), left = Math.max(0, R0 * Math.exp(r * t) - D * annuity(t));
      out.push(m(hz, "reserves_remaining_musd", left, "million US$", R0));
      out.push(m(hz, "reserves_remaining_pct", left / R0 * 100, "% of today's reserve assets", 100));
      out.push(m(hz, "liquid_assets_remaining_musd", Math.max(0, L0 - D * t), "million US$", L0));
      out.push(m(hz, "runway_years", runway(R0), "years", null));
      out.push(m(hz, "liquid_runway_years", D <= 0 ? CAP : Math.min(CAP, L0 / D), "years", null));
    }
    return out;
  },
};

/** A move in the oil price and in export volume, set against the size of the economy. */
export const exportRevenueAgainstGdp: Template = {
  key: "export-revenue-gdp", pack: "sovereign", version: 1, formulaVersion: "export-revenue-gdp/1", title: "Crude export revenue against GDP",
  description: "Saudi crude export revenue is rebuilt from published volumes and the benchmark price, then set against nominal GDP. A price move and a volume move are applied and the change is shown as a share of one year's GDP.",
  needs: ["gulf", "gdp"], headline: { horizon: "1y", metric: "delta_pct_of_annual_gdp" }, nonNegative: ["crude_export_revenue_musd", "crude_export_revenue_share_of_gdp_pct", "oil_activity_share_of_gdp_pct"], usesFlexibility: false, exposure: null,
  defaults: (): Params => ({
    priceChangePct: p(-30, -50, 50, "assumed", "Initial change in the benchmark price, in percent. Negative is a fall."),
    volumeChangePct: p(0, -20, 20, "assumed", "Change in export volume held for the whole horizon, in percent."),
    halfLifeDays: p(180, 60, 365, "assumed", "Days for the price move to halve."),
    gdpUnitScale: p(1, 1, 1, "assumed", "The GDP source does not state its unit. Values are read as million riyals. Set to 1 to keep that reading."),
    usdPerSar: peg(),
  }),
  compute(b, v) {
    const g = gulf(b), sa = g.countries.find(c => c.code === "SA");
    if (!sa) throw new Error("this scenario needs Saudi export volumes in the baseline");
    const gd = b.gdp; if (!gd) throw new Error("this scenario needs the GDP baseline, which is not in the baseline");
    const fx = v.usdPerSar!, gdpAnnual = (gd.annualOilMillion + gd.annualNonOilMillion + gd.annualGovernmentMillion) * v.gdpUnitScale! / fx;
    const revYear = sa.exportsKbd * 1000 * 365 * g.priceUsd / 1e6;
    const out: Metric[] = [];
    for (const hz of HORIZONS) {
      const h = HORIZON_DAYS[hz], priceAvg = g.priceUsd * (1 + v.priceChangePct! / 100 * avgDecay(h, v.halfLifeDays!));
      const base = sa.exportsKbd * 1000 * h * g.priceUsd / 1e6, scn = sa.exportsKbd * (1 + v.volumeChangePct! / 100) * 1000 * h * priceAvg / 1e6;
      out.push(m(hz, "brent_end_usd", g.priceUsd * (1 + v.priceChangePct! / 100 * endDecay(h, v.halfLifeDays!)), "US$ per barrel", g.priceUsd));
      out.push(m(hz, "crude_export_revenue_musd", scn, "million US$", base));
      out.push(m(hz, "delta_musd", scn - base, "million US$", 0));
      out.push(m(hz, "delta_pct_of_annual_gdp", (scn - base) / gdpAnnual * 100, "% of one year's GDP", 0));
      out.push(m(hz, "crude_export_revenue_share_of_gdp_pct", revYear / gdpAnnual * 100, "% of annual GDP", null));
      out.push(m(hz, "oil_activity_share_of_gdp_pct", gd.annualOilMillion / (gd.annualOilMillion + gd.annualNonOilMillion + gd.annualGovernmentMillion) * 100, "% of GDP by activity", null));
    }
    return out;
  },
};

/** A market shock applied to the published composition of reserve assets, fading as markets recover. */
export const reserveAssetStress: Template = {
  key: "reserve-asset-stress", pack: "sovereign", version: 1, formulaVersion: "reserve-stress/1", title: "Reserve asset stress",
  description: "A market shock is applied to each class of reserve asset, using the latest published composition. The shock fades with a recovery half-life. Shows the change in value and how the mix shifts toward or away from liquid assets.",
  needs: ["reserves"], headline: { horizon: "72h", metric: "change_pct" }, nonNegative: ["reserves_value_musd", "liquid_share_pct", "securities_share_pct"], usesFlexibility: false, exposure: null,
  defaults: (): Params => ({
    securitiesShockPct: p(-8, -20, 0, "assumed", "Immediate change in the value of foreign securities, in percent."),
    depositsShockPct: p(0, -2, 0, "assumed", "Immediate change in foreign currency and deposits abroad, in percent."),
    goldShockPct: p(0, -15, 15, "assumed", "Immediate change in the value of monetary gold, in percent."),
    otherShockPct: p(0, -5, 5, "assumed", "Immediate change in IMF reserve position and SDR holdings, in percent."),
    recoveryHalfLifeDays: p(180, 60, 365, "assumed", "Days for the shock to halve as markets recover."),
    usdPerSar: peg(),
  }),
  compute(b, v) {
    const r = reserves(b), fx = v.usdPerSar!;
    const A = { sec: r.securitiesMillionSar / fx, dep: r.liquidMillionSar / fx, gold: r.goldMillionSar / fx, oth: r.otherMillionSar / fx };
    const total = A.sec + A.dep + A.gold + A.oth, out: Metric[] = [];
    for (const hz of HORIZONS) {
      const k = endDecay(HORIZON_DAYS[hz], v.recoveryHalfLifeDays!), at = (a: number, s: number) => a * (1 + s / 100 * k);
      const sec = at(A.sec, v.securitiesShockPct!), dep = at(A.dep, v.depositsShockPct!), gold = at(A.gold, v.goldShockPct!), oth = at(A.oth, v.otherShockPct!), now = sec + dep + gold + oth;
      out.push(m(hz, "reserves_value_musd", now, "million US$", total));
      out.push(m(hz, "change_musd", now - total, "million US$", 0));
      out.push(m(hz, "change_pct", (now - total) / total * 100, "% of reserve assets", 0));
      out.push(m(hz, "liquid_share_pct", dep / now * 100, "% of reserve assets", A.dep / total * 100));
      out.push(m(hz, "securities_share_pct", sec / now * 100, "% of reserve assets", A.sec / total * 100));
    }
    return out;
  },
};
