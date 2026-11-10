import { canonicalJson, sha256Hex } from "../../core/src/index.js";
import type { StoredFact } from "../../ingest/src/observations.js";
import type { Briefing } from "../../sectors/src/index.js";
import type { Fact } from "./verify.js";

/** Only these data classes may be placed in a prompt. Institution data, third-party derived data and licensed feeds stay out until the client's review allows more. */
export const SENDABLE_CLASSES: ReadonlySet<string> = new Set(["public_record", "sample_dataset", "scenario_simulation"]);

export interface RawFact { text: string; evidenceId: string | null; dataClass: string }
export interface FactPack { facts: Fact[]; withheld: number; hash: string; classes: string[] }

/** Numbers every fact, drops duplicates and anything whose class may not be sent, and hashes the result. */
export function packFacts(raw: RawFact[]): FactPack {
  const seen = new Set<string>(), facts: Fact[] = []; let withheld = 0;
  for (const r of raw) {
    if (!SENDABLE_CLASSES.has(r.dataClass)) { withheld++; continue; }
    const key = `${r.text}|${r.evidenceId ?? ""}`; if (seen.has(key)) continue; seen.add(key);
    facts.push({ ref: `F${facts.length + 1}`, text: r.text, evidenceId: r.evidenceId, dataClass: r.dataClass });
  }
  return { facts, withheld, hash: sha256Hex(canonicalJson(facts)), classes: [...new Set(facts.map(f => f.dataClass))].sort() };
}

const amount = (v: number) => String(Number(v.toFixed(4)));
const periodOf = (iso: string) => iso.slice(0, 7);

/** Facts from a briefing. The briefing is already composed by fixed code; case titles are left out because people may have written them. */
export function factsFromBriefing(b: Briefing): RawFact[] {
  const out: RawFact[] = [{ text: `${b.name}: ${b.headline.text}`, evidenceId: null, dataClass: "public_record" }];
  for (const s of b.signals) out.push({ text: `${s.title}. ${s.detail}`, evidenceId: s.evidenceIds[0] ?? null, dataClass: "public_record" });
  for (const c of b.changes) out.push({ text: `${c.label}: ${amount(c.value)} ${c.unit} in ${periodOf(c.period)}, ${c.change}`, evidenceId: c.evidenceId, dataClass: "public_record" });
  for (const c of b.caveats) out.push({ text: c.text, evidenceId: c.evidenceId, dataClass: "public_record" });
  for (const s of b.scenarios ?? []) if (s.runId) out.push({ text: `Scenario simulation "${s.title}" was last run ${s.ranAt!.slice(0, 10)} with ${s.confidence} confidence`, evidenceId: null, dataClass: "scenario_simulation" });
  return out;
}

export const factText = (f: StoredFact): string => `${f.subject} · ${f.predicate}: ${typeof f.value === "number" ? amount(f.value) : String(f.value)}${f.unit ? ` ${f.unit}` : ""}${f.validTime ? ` (valid ${periodOf(f.validTime)})` : ""}`;
export const factsFromStored = (xs: StoredFact[]): RawFact[] => xs.map(f => ({ text: factText(f), evidenceId: f.evidenceId, dataClass: f.dataClass }));

/** Facts about a case: its stored evidence, and, when a rule opened it, the rule's own generated title and objective.
 *  Text people typed into a case (notes, recommendations, rationales) is institution content and is never sent. */
export function factsFromCase(c: { signal?: { id?: string } | null; title: string; objective: string }, stored: StoredFact[]): RawFact[] {
  const out: RawFact[] = [];
  if (c.signal && typeof c.signal === "object" && c.signal.id) out.push({ text: c.title, evidenceId: null, dataClass: "public_record" }, { text: c.objective, evidenceId: null, dataClass: "public_record" });
  return [...out, ...factsFromStored(stored)];
}
