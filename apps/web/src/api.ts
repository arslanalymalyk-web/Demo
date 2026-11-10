export class ApiError extends Error { constructor(readonly status: number, message: string, readonly body: unknown) { super(message); } }

let token: string | null = null;
export const currentToken = (): string | null => token;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null): void => { token = t; };
export const setUnauthorizedHandler = (f: () => void): void => { onUnauthorized = f; };

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api${path}`, { method: init.method ?? "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await r.text();
  const body = text ? safeJson(text) : null;
  if (r.status === 401) onUnauthorized();
  if (!r.ok) throw new ApiError(r.status, explain(r.status, body), body);
  return body as T;
}
const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };
function explain(status: number, body: unknown): string {
  const m = (body as { message?: string; error?: string } | null);
  if (status === 403) return m?.message ?? "You do not have permission for this.";
  if (status === 404) return "Not found.";
  return m?.message ?? m?.error ?? `Request failed (${status}).`;
}

/** Sends a file as the raw request body. Details travel in headers, URL-encoded so any language is safe. */
export async function upload<T>(path: string, file: File, headers: Record<string, string>): Promise<{ status: number; body: T }> {
  const enc = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, encodeURIComponent(v)]));
  const r = await fetch(`/api${path}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/octet-stream", ...enc }, body: file });
  const text = await r.text(), body = text ? safeJson(text) : null;
  if (r.status === 401) onUnauthorized();
  if (!r.ok) throw new ApiError(r.status, explain(r.status, body), body);
  return { status: r.status, body: body as T };
}
export interface Me { id: string; subject: string; displayName: string | null; roles: string[]; permissions: string[]; institution: { id: string; name: string; jurisdiction: string | null } | null }
export interface SourceRow { source_key: string; name: string; publisher: string; original_agency: string | null; platform_type: string; status: "approved" | "pending_rights" | "blocked"; data_class: string; licence_name: string | null; licence_verified: boolean; rights_note: string | null; accepted: number; warned: number; quarantined: number }
export interface EvidenceRow { id: string; source_key: string; external_key: string; title: string | null; original_agency: string | null; event_time: string | null; retrieved_at: string; version: number; data_class: string; validation_status: string }
export interface SeriesRow { series_key: string; title: string; description: string | null; frequency: string; packs: string[]; max_age_days: number | null; source_key: string; original_agency: string | null; latest_validation: string | null; latest_evidence_id: string | null; latest_version: number | null; tracks: number; latest_period: string | null }
export interface Observation { subject: string; predicate: string; value: number; unit: string | null; unitStated: boolean; validTime: string; dims: Record<string, unknown>; evidenceId: string; version: number; validation: string; lineage: string }
export interface Lineage { evidenceId: string; provenance: { origin: { publisher: string; originalAgency: string | null; sourceUrl: string | null; recordKey: string }; timeAndScope: { eventTime: string | null; retrievedAt: string }; rightsAndVersion: { licence: string | null; licenceVerified: boolean; rawHash: string; version: number }; transformation: string; confidence: { validation: string; checks: { rule?: string; outcome?: string; detail?: string }[] }; dataClass: string }; validationRuns: unknown[]; facts: unknown[]; job: unknown; payload: unknown }
export interface Entity { key: string; kind: string; name: string; attrs: Record<string, unknown>; data_class: string }
export interface PathEdge { id: string; from: string; to: string; predicate: string; linkClass: string; params: Record<string, unknown>; rationale: string | null; evidence: string[] }
export interface GraphPath { depth: number; edges: PathEdge[] }
export interface Param { value: number; low: number; high: number; basis: "assumed" | "sourced" | "calibrated"; note: string }
export interface TemplateInfo { key: string; pack: "energy" | "sovereign"; packName: string; version: number; formulaVersion: string; title: string; description: string; needs: string[]; headline: { horizon: string; metric: string }; parameters: Record<string, Param> }
export interface RunSummary { id: string; template_key: string; template_version: number; formula_version: string; manifest_hash: string; results_hash: string; confidence: string; created_by: string; created_at: string }
export interface ResultRow { horizon: string; metric: string; value: number; unit: string; baseline: number | null; lineage: { band: { low: number; high: number }; evidence: string[]; baselineMonth: string } }
export interface Confidence { level: "low" | "medium" | "high"; score: number; basis: { assumedShare: number; sourceValidation: number; recency: number; sensitivity: number }; notes: string[] }
export interface Sensitivity { param: string; low: number; high: number; basis: string; effects: Record<string, [number, number]> }
export interface RunDetail { id: string; template: string; templateVersion: number; formulaVersion: string; graphSnapshotId: string | null; assumptions: Record<string, Param>; inputs: { baseline: { month: string; priceUsd: number | null; priceRef: { evidenceId: string } | null; countries: { code: string; name: string; exportsKbd: number; hormuzShare: number; spareBypassKbd: number; linkClass: string; refs: { evidenceId: string }[] }[]; reservesMillionSar: number | null; reserves?: { quarter: string; totalMillionSar: number; liquidMillionSar: number; securitiesMillionSar: number; goldMillionSar: number; otherMillionSar: number; refs: { evidenceId: string }[] } | null; gdp?: { quarter: string; annualOilMillion: number; annualNonOilMillion: number; annualGovernmentMillion: number; unitStated: boolean; refs: { evidenceId: string }[] } | null }; runAt: string }; manifestHash: string; resultsHash: string; confidence: Confidence; sensitivity: Sensitivity[]; createdBy: string; createdAt: string; results: ResultRow[] }
export interface Backtest { basis: string; statement: string; baselineMonth: string; baselinePrice: number; flexibility: number | null; rows: { month: string; lostKbd: number; observedPremium: number; modelPremium: number; residual: number }[]; meanAbsError: number | null }
export interface ReplayResult { manifestMatches: boolean; resultsMatch: boolean; storedRowsMatch: boolean; storedResultsHash: string; replayedResultsHash: string }
export interface PrincipalRow { id: string; issuer: string; subject: string; displayName: string | null; roles: string[]; disabled: boolean }
export const ROLES = ["executive", "analyst", "expert", "approver", "operations", "administrator", "auditor"] as const;

export type CaseState = "open" | "analysis" | "in_review" | "decided" | "closed";
export interface Ref { id: string; name: string }
export interface PolicyRule { ruleId: string; type: string; outcome: "PASS" | "HOLD" | "BLOCK"; explanation: string }
export interface PolicyDecision { id: string; recommendationId: string; policyVersion: number; outcome: "PASS" | "HOLD" | "BLOCK"; results: PolicyRule[]; manifestHash: string; createdAt: string }
export interface CaseListRow { signal_id?: string | null; id: string; case_key: string; title: string; domain: string; sensitivity: string; state: CaseState; owner_id: string; reviewer_id: string | null; version: number; updated_at: string }
export interface CaseDetail {
  hold?: { id: string; reason: string; placedBy: string; placedAt: string } | null;
  id: string; caseKey: string; title: string; objective: string; domain: string; sensitivity: string; state: CaseState; disposition: string | null; version: number; owner: Ref | null; reviewer: Ref | null;
  startSnapshot: { graphHash: string; entities: number; relationships: number; openedAt: string }; signal: Record<string, unknown>; createdAt: string; updatedAt: string;
  activePolicy: { key: string; version: number; authority: Record<string, string[]> } | null; participants: (Ref & { role: string })[];
  evidence: { id: string; sourceKey?: string; sourceName?: string; sourceStatus?: string; validation?: string; dataClass?: string; externalKey?: string; title?: string | null; retrievedAt?: string; role: string; note: string | null; addedBy: Ref | null }[];
  scenarios: { id: string; templateKey: string; confidence: "low" | "medium" | "high"; createdAt: string }[];
  recommendations: { id: string; title: string; description: string; constraints: string | null; actionClass: string; scenarioRunId: string | null; owner: Ref | null; author: Ref | null; status: string; evidenceIds: string[]; latestPolicy: PolicyDecision | null }[];
  policyDecisions: PolicyDecision[]; decisions: { id: string; recommendationId: string; decision: string; rationale: string; actor: Ref | null; caseVersion: number; createdAt: string; policyDecisionId: string }[];
  handoffs: { id: string; task: string; owner: Ref | null; status: string; outcome: string | null; updatedAt: string }[];
  events: { seq: number; actor: Ref | null; kind: string; rationale: string | null; payload: Record<string, unknown>; at: string }[];
}
export interface Reviewer { id: string; name: string; roles: string[] }
export interface HandoffRow { id: string; caseId: string; caseKey: string; caseTitle: string; task: string; ownerId: string | null; status: string; outcome: string | null; updatedAt: string }
export interface MemoryRow { id: string; case_id: string; case_key: string; title: string; summary: string; domain: string; sensitivity: string; decision: string; outcome: string | null; created_at: string }
export interface PolicyRow { id: string; key: string; version: number; status: string; rules: { id: string; type: string; params: Record<string, unknown> }[]; authority: Record<string, string[]>; createdBy: string; activatedBy: string | null; createdAt: string; activatedAt: string | null }

export interface DocRow { id: string; title: string; filename: string; mime: string; size_bytes: number; sha256: string; data_class: string; original_agency: string | null; source_url: string | null; rights_statement: string; languages: string; status: "queued" | "processing" | "ready" | "failed" | "quarantined"; error: string | null; page_count: number | null; language: string | null; ocr_used: boolean | null; avg_confidence: number | null; evidence_id: string | null; created_at: string; processed_at: string | null }
export interface DocDetail extends DocRow { uploaded_by_name: string | null; pages: { page_no: number; method: string; char_count: number; confidence: number | null }[]; tools: { pdftotext: string | null; tesseract: string | null; languages: string[] } }
export interface DocConfig { clientDataEnabled: boolean; ocr: { available: boolean; languages: string[] }; maxMegabytes: number; maxPages: number; accepted: string[] }
export interface DocHit { id: string; title: string; data_class: string; page_no: number; method: string; snippet: string }

export interface Signal { id: string; ruleId: string; severity: "info" | "watch" | "alert"; title: string; detail: string; observedAt: string; evidenceIds: string[]; values: Record<string, number | string> }
export interface Figure { id: string; label: string; value: number; unit: string; period: string; change: { text: string; direction: "up" | "down" | "flat" } | null; evidenceId: string; validation: string; note?: string }
export interface SectorView {
  pack: "energy" | "sovereign"; name: string; asOf: string; rulesVersion: string; figures: Figure[]; signals: Signal[];
  trends: { id: string; title: string; unit: string; points: { t: string; v: number }[]; evidenceId: string }[];
  rules: { id: string; title: string; description: string; thresholds: string }[];
  freshness: { seriesKey: string; title: string; frequency: string; maxAgeDays: number | null; latestPeriod: string | null; validation: string | null; evidenceId: string | null; sourceKey: string }[];
  countries?: { lagging: boolean; code: string; name: string; exportsKbd: number; medianKbd: number; changePct: number | null; productionKbd: number | null; period: string; evidenceId: string }[];
  composition?: { quarter: string; rows: { label: string; millionSar: number; share: number; evidenceId: string }[] };
}

export interface SettingVersion { id: string; scope: "signal_rules" | "scenario_defaults" | "hormuz_exposure"; version: number; status: "draft" | "active" | "retired"; payload: any; note: string; createdBy: string; activatedBy: string | null; createdAt: string; activatedAt: string | null }
export interface SettingsView {
  scopes: { scope: SettingVersion["scope"]; title: string; description: string; active: SettingVersion | null; versions: SettingVersion[]; defaults: any }[];
  catalog: { key: string; title: string; pack: string; parameters: Record<string, Param> }[];
  exposure: { code: string; name: string; hormuzShare: number; spareBypassKbd: number; linkClass: string }[];
}

export interface MapEntity { key: string; kind: "facility" | "route" | "chokepoint"; name: string; attrs: Record<string, any> }
export interface MapLink { id: string; from: string; to: string; predicate: string; linkClass: string; params: Record<string, any>; rationale: string | null; evidence: string[] }
export interface MapProducer { code: string; name: string; exportsKbd: number; medianKbd: number; changePct: number | null; lagging: boolean; period: string; evidenceId: string; productionKbd: number | null }
export interface MapData { extent: { lonMin: number; lonMax: number; latMin: number; latMax: number }; entities: MapEntity[]; links: MapLink[]; producers: MapProducer[]; notes: { positions: string; lanes: string; vessels: string } }

export interface RetentionHold { id: string; caseId: string; caseKey: string; reason: string; placedBy: string; placedAt: string; releasedBy: string | null; releasedAt: string | null; releaseReason: string | null }
export interface RetentionReport { years: number; reviewHorizon: string; classes: { key: string; label: string; basis: string; records: number; oldest: string | null; newest: string | null; reviewDue: number }[]; holds: RetentionHold[]; exports: { id: string; subjectId: string; exportedBy: string; exportedAt: string; sha256: string; bytes: number; purpose: string }[]; deletion: string; note: string }

export interface Briefing {
  version: 1; pack: "energy" | "sovereign"; name: string; asOf: string; rulesVersion: string; settingsVersion: number | null;
  headline: { level: "attention" | "watch" | "clear" | "no_data"; text: string };
  changes: { id: string; label: string; value: number; unit: string; period: string; change: string; direction: "up" | "down" | "flat"; evidenceId: string }[];
  signals: { id: string; ruleId: string; severity: "info" | "watch" | "alert"; title: string; detail: string; observedAt: string; evidenceIds: string[]; caseId: string | null; caseKey: string | null }[];
  openCases: { id: string; caseKey: string; title: string; state: string; updatedAt: string; waitingFor: "reviewer" | null }[] | null;
  scenarios: { key: string; title: string; runId: string | null; confidence: string | null; ranAt: string | null; label: "Scenario simulation" }[] | null;
  caveats: { kind: "stale" | "lagging" | "unvalidated" | "note"; text: string; evidenceId: string | null }[];
  dataClass: "public_record"; contentHash: string;
}
