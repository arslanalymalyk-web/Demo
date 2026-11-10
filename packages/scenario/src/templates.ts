import { simulate } from "./calc.js";
import { p, peg } from "./params.js";
import { gulf, type Baseline, type Params, type Shock, type Template } from "./types.js";
import { exportRevenueAgainstGdp, reserveAssetStress, reserveRunway } from "./sovereign.js";


const common = (flex: number | null): Params => ({
  priceFlexibility: flex === null
    ? p(8, 4, 15, "assumed", "Price premium per unit of global supply lost. Planning range, not calibrated.")
    : p(flex, flex * 0.5, flex * 1.5, "calibrated", "Fitted in-sample to the observed Mar–May 2026 episode. One episode: not a predictive accuracy claim."),
  halfLifeDays: p(60, 30, 120, "assumed", "Days for the price premium to halve as demand and supply adjust."),
  globalSupplyKbd: p(100000, 98000, 104000, "assumed", "World crude supply used to scale a supply loss. Not yet ingested as evidence."),
  reserveDrawShare: p(1, 0.5, 1, "assumed", "Share of a revenue shortfall met from reserve assets."),
  usdPerSar: peg(),
});
const ENERGY_NON_NEGATIVE = ["brent_end_usd", "brent_avg_usd", "lost_supply_kbd", "sa_reserve_drawdown_pct"];
const ENERGY_HEADLINE = { horizon: "90d" as const, metric: "gulf_revenue_delta_musd" };
const totalLost = (s: Shock) => Object.values(s.lostKbd).reduce((a, x) => a + x, 0);
const energy = (shock: (b: Baseline, v: Record<string, number>) => Shock) => (b: Baseline, v: Record<string, number>) => simulate(gulf(b), shock(b, v));

export const hormuzTransitRestriction: Template = {
  key: "hormuz-transit-restriction", pack: "energy", version: 1, formulaVersion: "oil-shock/1", title: "Hormuz transit restriction",
  description: "A share of Strait of Hormuz transit is restricted for a number of days. Exports that cannot be rerouted are lost and the benchmark price carries a decaying premium.",
  needs: ["gulf"], headline: ENERGY_HEADLINE, nonNegative: ENERGY_NON_NEGATIVE, usesFlexibility: true, exposure: "hormuz",
  defaults: flex => ({
    restrictionPct: p(0.5, 0.2, 1, "assumed", "Share of Hormuz transit restricted while the event lasts."),
    durationDays: p(30, 7, 90, "assumed", "Days the restriction lasts."),
    rerouteEfficiency: p(0.8, 0.5, 1, "assumed", "Share of spare bypass pipeline capacity that can be used."),
    hormuzShareScale: p(1, 0.8, 1, "assumed", "Scales the planning share of exports that pass Hormuz. Shares are placeholders, not sourced."),
    bypassScale: p(1, 0.5, 1.5, "assumed", "Scales the planning spare bypass capacity. Placeholders, not sourced."),
    ...common(flex),
  }),
  compute: energy((b, v) => hormuzShock(b, v)),
};

export const hormuzShock = (b: Baseline, v: Record<string, number>): Shock => {
    const lostKbd: Record<string, number> = {};
    for (const c of gulf(b).countries) {
      const share = Math.min(1, c.hormuzShare * v.hormuzShareScale!);
      lostKbd[c.code] = Math.max(0, c.exportsKbd * share * v.restrictionPct! - c.spareBypassKbd * v.bypassScale! * v.rerouteEfficiency!);
    }
    const s = { lostKbd, peakPremium: 0, durationDays: v.durationDays!, halfLifeDays: v.halfLifeDays!, reserveDrawShare: v.reserveDrawShare!, usdPerSar: v.usdPerSar! };
    return { ...s, peakPremium: totalLost(s) / v.globalSupplyKbd! * v.priceFlexibility! };
};

export const oilPriceShock: Template = {
  key: "oil-price-shock", pack: "energy", version: 1, formulaVersion: "oil-shock/1", title: "Oil price shock",
  description: "The benchmark price moves by a stated percentage and the move fades. Volumes are held at the baseline, which is an assumption.",
  needs: ["gulf"], headline: ENERGY_HEADLINE, nonNegative: ENERGY_NON_NEGATIVE, usesFlexibility: false, exposure: null,
  defaults: () => {
    const { priceFlexibility: _f, globalSupplyKbd: _g, ...rest } = common(null);
    return { priceShockPct: p(-30, -50, 50, "assumed", "Initial change in the benchmark price, in percent. Negative is a fall."), ...rest };
  },
  compute: energy((_b, v) => ({ lostKbd: {}, peakPremium: v.priceShockPct! / 100, durationDays: 0, halfLifeDays: v.halfLifeDays!, reserveDrawShare: v.reserveDrawShare!, usdPerSar: v.usdPerSar! })),
};

export const productionCurtailment: Template = {
  key: "production-curtailment", pack: "energy", version: 1, formulaVersion: "oil-shock/1", title: "Coordinated production curtailment",
  description: "Producers withhold a share of their output for a number of days. Exports fall by the withheld volume, and the benchmark carries a decaying premium sized by the supply removed. It shows when a cut raises revenue and when it costs more in volume than it earns in price.",
  needs: ["gulf"], headline: ENERGY_HEADLINE, nonNegative: ENERGY_NON_NEGATIVE, usesFlexibility: true, exposure: null,
  defaults: flex => ({
    curtailmentPct: p(5, 2, 15, "assumed", "Share of each producer's output withheld, in percent."),
    participation: p(1, 0.5, 1, "assumed", "Share of the cut that is actually delivered. Compliance is not observed."),
    durationDays: p(90, 30, 365, "assumed", "Days the cut lasts."),
    ...common(flex),
  }),
  compute: energy((b, v) => curtailmentShock(b, v)),
};

export const curtailmentShock = (b: Baseline, v: Record<string, number>): Shock => {
    const lostKbd: Record<string, number> = {};
    for (const c of gulf(b).countries) lostKbd[c.code] = Math.min(c.exportsKbd, c.productionKbd * (v.curtailmentPct! / 100) * v.participation!);
    const s = { lostKbd, peakPremium: 0, durationDays: v.durationDays!, halfLifeDays: v.halfLifeDays!, reserveDrawShare: v.reserveDrawShare!, usdPerSar: v.usdPerSar! };
    return { ...s, peakPremium: totalLost(s) / v.globalSupplyKbd! * v.priceFlexibility! };
};

export const TEMPLATES: Record<string, Template> = Object.fromEntries([hormuzTransitRestriction, oilPriceShock, productionCurtailment, reserveRunway, exportRevenueAgainstGdp, reserveAssetStress].map(t => [t.key, t]));
