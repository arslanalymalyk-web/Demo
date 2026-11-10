import type { RawRecord, ValidationOutcome } from "../../core/src/index.js";

export const RULES_VERSION = "ingest-rules/1";
export interface SourceView { status: string; licence_verified: boolean; base_url: string; freshness_limit_ms: number }
export interface Check { name: string; result: "pass" | "warn" | "fail"; detail?: string }

const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_OBSERVATION_BYTES = 12 * 1024 * 1024;

/** Pure validation: every record gets machine-readable checks and one outcome. Failures quarantine the record. */
export function validateRecord(record: RawRecord, source: SourceView, now: Date): { outcome: ValidationOutcome; checks: Check[]; reason: string | null } {
  const checks: Check[] = [];
  const add = (name: string, result: Check["result"], detail?: string) => checks.push({ name, result, ...(detail ? { detail } : {}) });

  add("source_approved", source.status === "approved" ? "pass" : "fail", source.status);
  add("required_fields", record.externalKey && record.payload && Object.keys(record.payload).length > 0 ? "pass" : "fail");
  const size = Buffer.byteLength(JSON.stringify(record.payload));
  add("size_limit", size <= (record.kind === "observation" ? MAX_OBSERVATION_BYTES : MAX_CATALOG_BYTES) ? "pass" : "fail", `${size} bytes`);
  add("origin_present", record.sourceUrl || source.base_url ? (record.originalAgency ? "pass" : "warn") : "fail", record.originalAgency ? undefined : "original agency unknown");
  add("rights_known", source.licence_verified ? "pass" : "warn", source.licence_verified ? undefined : "licence to confirm");

  if (record.eventTime) {
    const t = Date.parse(record.eventTime);
    if (Number.isNaN(t)) add("timestamp_valid", "fail", "unparseable");
    else if (t > now.getTime() + 86_400_000) add("timestamp_valid", "fail", "in the future");
    else add("timestamp_valid", "pass");
    if (record.kind === "observation" && !record.series && !Number.isNaN(t)) add("fresh_enough", now.getTime() - t <= source.freshness_limit_ms ? "pass" : "warn", "older than the source freshness limit");
  }

  if (record.kind === "document") {
    const pages = (record.payload.pages as { chars: number; confidence: number | null; method: string }[] | undefined) ?? [];
    const chars = pages.reduce((a, p) => a + p.chars, 0);
    add("has_text", chars > 0 ? "pass" : "fail", `${chars} characters over ${pages.length} page(s)`);
    const conf = pages.filter(p => p.confidence !== null).map(p => p.confidence as number);
    if (conf.length) {
      const avg = conf.reduce((a, x) => a + x, 0) / conf.length;
      add("ocr_confidence", avg >= 60 ? "pass" : avg >= 35 ? "warn" : "fail", `average ${avg.toFixed(0)} over ${conf.length} scanned page(s)`);
    }
    add("rights_stated", typeof record.payload.rights === "string" && record.payload.rights.trim().length >= 3 ? "pass" : "fail");
  }

  if (record.series) {
    const facts = record.facts ?? [];
    add("has_observations", facts.length > 0 ? "pass" : "fail", `${facts.length} facts`);
    add("values_finite", facts.every(f => f.value === null || Number.isFinite(f.value)) ? "pass" : "fail");
    add("periods_valid", facts.length > 0 && facts.every(f => f.validTime && !Number.isNaN(Date.parse(f.validTime))) ? "pass" : "fail");
    const nulls = Number(record.payload.nullMeasures ?? 0);
    if (facts.length + nulls > 0) add("missing_values", nulls / (facts.length + nulls) > 0.5 ? "warn" : "pass", `${nulls} missing`);
    if (record.series.maxAgeDays !== undefined && record.eventTime) {
      const ageDays = (now.getTime() - Date.parse(record.eventTime)) / 86_400_000;
      add("latest_observation_age", ageDays <= record.series.maxAgeDays ? "pass" : "warn", `${Math.round(ageDays)} days since latest period start`);
    }
  }
  const failed = checks.filter(c => c.result === "fail");
  const warned = checks.filter(c => c.result === "warn");
  if (failed.length) return { outcome: "quarantined", checks, reason: failed.map(c => c.name).join(", ") };
  if (warned.length) return { outcome: "warned", checks, reason: warned.map(c => c.name).join(", ") };
  return { outcome: "accepted", checks, reason: null };
}
