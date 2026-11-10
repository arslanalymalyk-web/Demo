import { canonicalJson, sha256Hex } from "../../core/src/index.js";
import type { PackKey, SectorView } from "./view.js";

/** A briefing is composed by fixed code from a sector view, the cases the reader may see and the stored scenario runs. No model writes any sentence in it. */
export interface BriefingCase { id: string; case_key: string; title: string; domain: string; state: string; signal_id?: string | null; reviewer_id: string | null; updated_at: string }
export interface BriefingRun { id: string; template_key: string; confidence: string; created_at: string }
export interface BriefingTemplate { key: string; pack: string; title: string }

export interface BriefingChange { id: string; label: string; value: number; unit: string; period: string; change: string; direction: "up" | "down" | "flat"; evidenceId: string }
export interface BriefingSignal { id: string; ruleId: string; severity: "info" | "watch" | "alert"; title: string; detail: string; observedAt: string; evidenceIds: string[]; caseId: string | null; caseKey: string | null }
export interface BriefingCaseItem { id: string; caseKey: string; title: string; state: string; updatedAt: string; waitingFor: "reviewer" | null }
export interface BriefingScenario { key: string; title: string; runId: string | null; confidence: string | null; ranAt: string | null; label: "Scenario simulation" }
export interface BriefingCaveat { kind: "stale" | "lagging" | "unvalidated" | "note"; text: string; evidenceId: string | null }

export interface Briefing {
  version: 1; pack: PackKey; name: string; asOf: string; rulesVersion: string; settingsVersion: number | null;
  headline: { level: "attention" | "watch" | "clear" | "no_data"; text: string };
  changes: BriefingChange[]; signals: BriefingSignal[]; openCases: BriefingCaseItem[] | null; scenarios: BriefingScenario[] | null; caveats: BriefingCaveat[];
  dataClass: "public_record"; contentHash: string;
}

const DOMAINS: Record<PackKey, string[]> = { energy: ["energy"], sovereign: ["sovereign capital", "treasury"] };
const day = 86_400_000;
const month = (iso: string) => iso.slice(0, 7);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface ComposeInput { view: SectorView; cases: BriefingCase[] | null; runs: BriefingRun[] | null; templates: BriefingTemplate[]; viewerId: string }

export function composeBriefing(i: ComposeInput): Briefing {
  const { view } = i, asOf = new Date(view.asOf).getTime();
  const openCases = i.cases ? i.cases.filter(c => DOMAINS[view.pack].includes(c.domain) && c.state !== "closed") : null;
  const caseBySignal = new Map((openCases ?? []).filter(c => c.signal_id).map(c => [c.signal_id!, c]));

  const changes: BriefingChange[] = view.figures.filter(f => f.change).map(f => ({ id: f.id, label: f.label, value: f.value, unit: f.unit, period: f.period, change: f.change!.text, direction: f.change!.direction, evidenceId: f.evidenceId }));
  const signals: BriefingSignal[] = view.signals.map(s => { const c = caseBySignal.get(s.id); return { id: s.id, ruleId: s.ruleId, severity: s.severity, title: s.title, detail: s.detail, observedAt: s.observedAt, evidenceIds: s.evidenceIds, caseId: c?.id ?? null, caseKey: c?.case_key ?? null }; });

  const caveats: BriefingCaveat[] = [];
  for (const s of view.freshness) {
    if (!s.latestPeriod) caveats.push({ kind: "stale", text: `${s.title}: no data is stored yet.`, evidenceId: null });
    else if (s.maxAgeDays && (asOf - new Date(s.latestPeriod).getTime()) / day > s.maxAgeDays) caveats.push({ kind: "stale", text: `${s.title}: the latest stored period is ${month(s.latestPeriod)}, older than the ${s.maxAgeDays} days this series allows.`, evidenceId: s.evidenceId });
    if (s.validation && s.validation !== "accepted") caveats.push({ kind: "unvalidated", text: `${s.title}: the latest record was ${s.validation}, not fully accepted.`, evidenceId: s.evidenceId });
  }
  for (const c of view.countries ?? []) if (c.lagging) caveats.push({ kind: "lagging", text: `${c.name}: no data since ${month(c.period)}. It is left out of the Gulf total and of every rule.`, evidenceId: c.evidenceId });
  for (const f of view.figures) if (f.note) caveats.push({ kind: "note", text: `${f.label}: ${f.note}`, evidenceId: f.evidenceId });

  const scenarios: BriefingScenario[] | null = i.runs ? i.templates.filter(t => t.pack === view.pack).map(t => { const r = i.runs!.find(x => x.template_key === t.key); return { key: t.key, title: t.title, runId: r?.id ?? null, confidence: r?.confidence ?? null, ranAt: r?.created_at ?? null, label: "Scenario simulation" as const }; }) : null;

  const alerts = signals.filter(s => s.severity === "alert").length, watch = signals.filter(s => s.severity === "watch").length;
  const headline: Briefing["headline"] = view.figures.length === 0 ? { level: "no_data", text: "No data for this pack is stored yet, so nothing can be said." }
    : alerts > 0 ? { level: "attention", text: `${plural(alerts, "alert needs", "alerts need")} attention${watch ? `, and ${plural(watch, "more item is", "more items are")} on watch` : ""}.` }
    : watch > 0 ? { level: "watch", text: `${plural(watch, "item is", "items are")} on watch. No alert is raised.` }
    : { level: "clear", text: "No rule is firing on the stored data." };

  const body = {
    version: 1 as const, pack: view.pack, name: view.name, asOf: view.asOf, rulesVersion: view.rulesVersion, settingsVersion: view.settingsVersion, headline, changes, signals,
    openCases: openCases ? openCases.map(c => ({ id: c.id, caseKey: c.case_key, title: c.title, state: c.state, updatedAt: c.updated_at, waitingFor: c.state === "in_review" ? "reviewer" as const : null })) : null,
    scenarios, caveats, dataClass: "public_record" as const,
  };
  return { ...body, contentHash: sha256Hex(canonicalJson(body)) };
}

/** True when the briefing's content still matches its hash, so a saved copy can be checked. */
export function verifyBriefing(b: Briefing): boolean {
  const { contentHash, ...body } = b;
  return sha256Hex(canonicalJson(body)) === contentHash;
}
