import { z } from "zod";
import { DEFAULT_THRESHOLDS } from "../../sectors/src/rules.js";

export type Scope = "signal_rules" | "scenario_defaults" | "hormuz_exposure";
export const SCOPES: Scope[] = ["signal_rules", "scenario_defaults", "hormuz_exposure"];
export const SCOPE_INFO: Record<Scope, { title: string; description: string }> = {
  signal_rules: { title: "Signal thresholds", description: "The levels at which the attention-queue rules raise a watch or an alert." },
  scenario_defaults: { title: "Scenario defaults", description: "Default values and ranges for scenario parameters. A value taken from a source must cite its evidence." },
  hormuz_exposure: { title: "Hormuz exposure", description: "How much of each producer's crude exports pass the Strait of Hormuz and how much spare bypass capacity exists. Activation writes these into the graph." },
};

const frac = z.number().gt(0).lt(1);
const pair = (watch: string, alert: string) => (v: Record<string, number>) => (v[alert] as number) > (v[watch] as number);
export const signalRulesSchema = z.object({
  E1: z.object({ minMedian: z.number().min(0).max(1e6), watch: frac, alert: frac }).strict().refine(pair("watch", "alert"), "E1: the alert level must be larger than the watch level"),
  E2: z.object({ watch: frac, alert: frac }).strict().refine(pair("watch", "alert"), "E2: the alert level must be larger than the watch level"),
  E3: z.object({ watch: frac, alert: frac }).strict().refine(pair("watch", "alert"), "E3: the alert level must be larger than the watch level"),
  S1: z.object({ watch: frac, alert: frac }).strict().refine(pair("watch", "alert"), "S1: the alert level must be larger than the watch level"),
  S2: z.object({ watchBelow: frac, alertBelow: frac }).strict().refine(v => v.alertBelow < v.watchBelow, "S2: the alert level must be lower than the watch level"),
  S3: z.object({ watchBelowMedian: frac }).strict(),
  S4: z.object({ watch: z.number().min(0).max(100), alert: z.number().min(0).max(100) }).strict().refine(pair("watch", "alert"), "S4: the alert level must be larger than the watch level"),
}).strict();

const basis = z.enum(["assumed", "sourced"]);
export const scenarioDefaultsSchema = z.record(z.string(), z.record(z.string(), z.object({
  value: z.number().finite(), low: z.number().finite(), high: z.number().finite(), basis, note: z.string().min(5).max(500), evidenceId: z.string().uuid().optional(),
}).strict().refine(p => p.low <= p.value && p.value <= p.high, "the value must lie within its range").refine(p => p.basis !== "sourced" || !!p.evidenceId, "a sourced value must cite an evidence record")));
export const hormuzExposureSchema = z.record(z.string().regex(/^[A-Z]{2}$/), z.object({
  hormuzShare: z.number().min(0).max(1), spareBypassKbd: z.number().min(0).max(20000), basis, evidenceId: z.string().uuid().optional(), rationale: z.string().min(10).max(1000),
}).strict().refine(p => p.basis !== "sourced" || !!p.evidenceId, "a sourced value must cite an evidence record"));

export const SCHEMAS = { signal_rules: signalRulesSchema, scenario_defaults: scenarioDefaultsSchema, hormuz_exposure: hormuzExposureSchema } as const;
export const DEFAULT_SIGNAL_RULES = DEFAULT_THRESHOLDS;
export type ScenarioDefaults = z.infer<typeof scenarioDefaultsSchema>;
export type HormuzExposure = z.infer<typeof hormuzExposureSchema>;
