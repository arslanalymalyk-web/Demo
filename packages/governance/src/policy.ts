import { z } from "zod";

export type Outcome = "PASS" | "HOLD" | "BLOCK";
export type ActionClass = "monitor" | "advisory" | "handoff";
export type Confidence = "low" | "medium" | "high";
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export const ruleSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(["evidence_required", "no_quarantined_evidence", "approved_sources_only", "forbid_data_class", "min_confidence", "scenario_required"]),
  params: z.record(z.string(), z.unknown()).default({}),
});
export const rulesSchema = z.array(ruleSchema).min(1).max(50).refine(r => new Set(r.map(x => x.id)).size === r.length, "rule ids must be unique");
export const authoritySchema = z.object({ monitor: z.array(z.string()).min(1), advisory: z.array(z.string()).min(1), handoff: z.array(z.string()).min(1) });
export type Rule = z.infer<typeof ruleSchema>;
export type Authority = z.infer<typeof authoritySchema>;

/** Everything a policy decision is computed from. It is stored with the decision so the result can be re-derived. */
export interface Manifest {
  actionClass: ActionClass;
  sensitivity: string;
  evidence: { id: string; validation: string; dataClass: string; sourceStatus: string }[];
  scenario: { runId: string; confidence: Confidence } | null;
}
export interface RuleResult { ruleId: string; type: Rule["type"]; outcome: Outcome; explanation: string }
export interface Evaluation { outcome: Outcome; results: RuleResult[] }

const applies = (p: Record<string, unknown>, a: ActionClass): boolean => !Array.isArray(p.actionClasses) || (p.actionClasses as string[]).includes(a);

/** Deterministic policy evaluation. BLOCK outranks HOLD outranks PASS. No model is involved. */
export function evaluate(rules: Rule[], m: Manifest): Evaluation {
  const results: RuleResult[] = rules.map(r => {
    const p = r.params, ok = (explanation: string): RuleResult => ({ ruleId: r.id, type: r.type, outcome: "PASS", explanation });
    const fail = (outcome: Outcome, explanation: string): RuleResult => ({ ruleId: r.id, type: r.type, outcome, explanation });
    if (!applies(p, m.actionClass) && r.type !== "min_confidence") return ok(`Not applicable to ${m.actionClass} actions.`);
    switch (r.type) {
      case "evidence_required": { const min = Number(p.min ?? 1); return m.evidence.length >= min ? ok(`${m.evidence.length} evidence record(s) cited.`) : fail("HOLD", `At least ${min} evidence record(s) must be cited; ${m.evidence.length} found.`); }
      case "no_quarantined_evidence": { const bad = m.evidence.filter(e => e.validation === "quarantined" || e.validation === "rejected"); return bad.length ? fail("BLOCK", `Cited evidence failed validation: ${bad.map(b => b.id.slice(0, 8)).join(", ")}.`) : ok("No cited evidence is quarantined or rejected."); }
      case "approved_sources_only": { const bad = m.evidence.filter(e => e.sourceStatus !== "approved"); return bad.length ? fail("BLOCK", `Evidence from sources that are not approved: ${bad.map(b => `${b.id.slice(0, 8)} (${b.sourceStatus})`).join(", ")}.`) : ok("All cited evidence comes from approved sources."); }
      case "forbid_data_class": { const banned = (p.dataClasses as string[] | undefined) ?? [], bad = m.evidence.filter(e => banned.includes(e.dataClass)); return bad.length ? fail("BLOCK", `Evidence of class ${[...new Set(bad.map(b => b.dataClass))].join(", ")} cannot support a ${m.actionClass} action.`) : ok("No prohibited data class is cited."); }
      case "scenario_required": return m.scenario ? ok("A scenario run is attached.") : fail("HOLD", `A ${m.actionClass} action must reference a scenario run.`);
      case "min_confidence": {
        const need = ((p.byActionClass as Record<string, Confidence> | undefined) ?? {})[m.actionClass];
        if (!need) return ok(`No confidence floor for ${m.actionClass} actions.`);
        if (!m.scenario) return fail("HOLD", `A ${need} confidence scenario is required for ${m.actionClass} actions; none is attached.`);
        return RANK[m.scenario.confidence] >= RANK[need] ? ok(`Scenario confidence ${m.scenario.confidence} meets the ${need} floor.`) : fail("HOLD", `Scenario confidence is ${m.scenario.confidence}; ${need} is required for ${m.actionClass} actions.`);
      }
    }
  });
  const outcome: Outcome = results.some(r => r.outcome === "BLOCK") ? "BLOCK" : results.some(r => r.outcome === "HOLD") ? "HOLD" : "PASS";
  return { outcome, results };
}

export const DEFAULT_RULES: Rule[] = [
  { id: "R1", type: "evidence_required", params: { min: 1 } },
  { id: "R2", type: "no_quarantined_evidence", params: {} },
  { id: "R3", type: "approved_sources_only", params: {} },
  { id: "R4", type: "forbid_data_class", params: { actionClasses: ["handoff"], dataClasses: ["sample_dataset"] } },
  { id: "R5", type: "scenario_required", params: { actionClasses: ["handoff"] } },
  { id: "R6", type: "min_confidence", params: { byActionClass: { handoff: "medium" } } },
];
export const DEFAULT_AUTHORITY: Authority = { monitor: ["approver", "executive"], advisory: ["approver", "executive"], handoff: ["approver"] };
