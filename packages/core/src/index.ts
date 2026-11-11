import { createHash } from "node:crypto";

export type DataClass = "public_record" | "third_party_derived" | "licensed_feed" | "institution_own" | "sample_dataset";
export type ValidationOutcome = "accepted" | "warned" | "quarantined" | "rejected";

export interface ObservationFact {
  subject: string; predicate: string; value: number | null; unit?: string | null; unitStated?: boolean;
  validTime?: string | null; dims?: Record<string, string | number | null>;
}
export interface SeriesDef { key: string; title: string; description?: string; frequency: "annual" | "quarterly" | "monthly"; packs: string[]; maxAgeDays?: number; query: unknown }

/** One record as a connector returns it, before validation. */
export interface RawRecord {
  externalKey: string;
  kind: "catalog" | "observation" | "document";
  sourceUrl?: string | null;
  originalAgency?: string | null;
  eventTime?: string | null;
  payload: Record<string, unknown>;
  transformation?: string;
  series?: SeriesDef;
  facts?: ObservationFact[];
}

/** The six provenance fields every displayed number must be able to show. */
export interface Provenance {
  origin: { publisher: string; originalAgency: string | null; sourceUrl: string | null; recordKey: string };
  timeAndScope: { eventTime: string | null; retrievedAt: string };
  rightsAndVersion: { licence: string | null; licenceVerified: boolean; rawHash: string; version: number };
  transformation: string;
  confidence: { validation: ValidationOutcome; checks: unknown };
  dataClass: DataClass;
}

/** Deterministic JSON: object keys sorted recursively, so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
export * from "./paging.js";
