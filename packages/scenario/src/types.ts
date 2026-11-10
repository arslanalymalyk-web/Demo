export type Horizon = "72h" | "90d" | "1y" | "5y";
export const HORIZONS: Horizon[] = ["72h", "90d", "1y", "5y"];
export const HORIZON_DAYS: Record<Horizon, number> = { "72h": 3, "90d": 90, "1y": 365, "5y": 1825 };

export interface FactRef { evidenceId: string; subject: string; validTime: string; value: number; validation: string }
export interface CountryBaseline { code: string; name: string; exportsKbd: number; productionKbd: number; hormuzShare: number; spareBypassKbd: number; linkClass: string; refs: FactRef[] }
export interface ReservesBaseline { quarter: string; totalMillionSar: number; liquidMillionSar: number; securitiesMillionSar: number; goldMillionSar: number; otherMillionSar: number; refs: FactRef[] }
export interface GdpBaseline { quarter: string; annualOilMillion: number; annualNonOilMillion: number; annualGovernmentMillion: number; unitStated: boolean; refs: FactRef[] }
/** The Gulf fields are empty for a template that does not use them. Older stored runs have exactly this Gulf shape, so they stay replayable. */
export interface Baseline { month: string; priceUsd: number | null; priceRef: FactRef | null; countries: CountryBaseline[]; reservesMillionSar: number | null; reservesRef: FactRef | null; reserves?: ReservesBaseline | null; gdp?: GdpBaseline | null }
export interface GulfBaseline extends Baseline { priceUsd: number; priceRef: FactRef }

export type ParamBasis = "assumed" | "sourced" | "calibrated";
export interface Param { value: number; low: number; high: number; basis: ParamBasis; note: string }
export type Params = Record<string, Param>;

export interface Metric { horizon: Horizon; metric: string; value: number; unit: string; baseline: number | null }
export interface Shock { lostKbd: Record<string, number>; peakPremium: number; durationDays: number; halfLifeDays: number; reserveDrawShare: number; usdPerSar: number }

export type Need = "gulf" | "reserves" | "gdp";
export const PACKS = { energy: "Energy and Oil", sovereign: "Sovereign Capital and Treasury" } as const;
export type PackKey = keyof typeof PACKS;
export interface Template {
  key: string; pack: PackKey; version: number; formulaVersion: string; title: string; description: string;
  needs: Need[]; /** the measure that sets the width of the confidence range */ headline: { horizon: Horizon; metric: string };
  nonNegative: string[]; usesFlexibility: boolean; exposure: "hormuz" | null;
  defaults(calibratedFlexibility: number | null): Params;
  compute(b: Baseline, values: Record<string, number>): Metric[];
}
export const gulf = (b: Baseline): GulfBaseline => { if (b.priceUsd === null || b.priceRef === null || b.countries.length === 0) throw new Error("this scenario needs the Gulf baseline (prices and exports), which is not in the baseline"); return b as GulfBaseline; };
