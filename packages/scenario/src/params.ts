import type { Param } from "./types.js";
export const p = (value: number, low: number, high: number, basis: Param["basis"], note: string): Param => ({ value, low, high, basis, note });
export const peg = (): Param => p(3.75, 3.75, 3.75, "assumed", "Official riyal peg. Not yet ingested as evidence.");
