import type { Baseline } from "./types.js";

export interface EpisodeMonth { month: string; lostKbd: number; observedPrice: number }
export interface BacktestRow { month: string; lostKbd: number; lostShare: number; observedPremium: number; modelPremium: number; residual: number }
export interface Backtest {
  basis: "in-sample calibration"; statement: string; baselineMonth: string; baselinePrice: number; globalSupplyKbd: number;
  flexibility: number | null; rows: BacktestRow[]; meanAbsError: number | null;
}

/** Fits premium = flexibility x (lost supply / global supply) through the origin to the observed episode months (least squares).
 *  The same months are then used to score the fit, so this describes how the model matches one episode. It does not measure predictive accuracy. */
export function backtest(baselineMonth: string, baselinePrice: number, globalSupplyKbd: number, months: EpisodeMonth[]): Backtest {
  const pts = months.map(m => ({ ...m, share: m.lostKbd / globalSupplyKbd, premium: m.observedPrice / baselinePrice - 1 }));
  const sxx = pts.reduce((a, x) => a + x.share * x.share, 0), sxy = pts.reduce((a, x) => a + x.share * x.premium, 0);
  const flexibility = sxx > 0 && sxy > 0 ? sxy / sxx : null;
  const rows = pts.map(x => { const model = (flexibility ?? 0) * x.share; return { month: x.month, lostKbd: x.lostKbd, lostShare: x.share, observedPremium: x.premium, modelPremium: model, residual: model - x.premium }; });
  return {
    basis: "in-sample calibration",
    statement: "Calibrated and scored on the same observed months. It shows how well the model reproduces this episode, not how well it predicts the next one. The cause of the supply loss is not asserted.",
    baselineMonth, baselinePrice, globalSupplyKbd, flexibility, rows,
    meanAbsError: rows.length ? rows.reduce((a, r) => a + Math.abs(r.residual), 0) / rows.length : null,
  };
}

export const countriesOf = (b: Baseline): string[] => b.countries.map(c => c.code);
