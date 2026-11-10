import type pg from "pg";
import { PostgresGraph, type LinkInput } from "./repository.js";

/** Public-record geography for the Gulf oil map. Positions are approximate and lanes are schematic: both are labelled so on screen.
 *  Pipeline capacities and the Hormuz flow come from one cited source (EIA, 21 November 2023). Where no source is cited, the link says assumed. */
export const GEOGRAPHY_SOURCE = { publisher: "U.S. Energy Information Administration", title: "The Strait of Hormuz is the world's most important oil transit chokepoint", date: "2023-11-21", url: "https://www.eia.gov/todayinenergy/detail.php?id=61002" } as const;
const POSITION = "Approximate position from public gazetteers, to be verified. Not a survey.";
const SCHEMATIC = "Schematic path for orientation. Not a surveyed route or a track.";

interface Facility { key: string; name: string; lat: number; lon: number; country: string; role: string; insideGulf: boolean }
export const FACILITIES: Facility[] = [
  { key: "ras-tanura", name: "Ras Tanura terminal", lat: 26.64, lon: 50.16, country: "SA", role: "Crude export terminal", insideGulf: true },
  { key: "mina-al-ahmadi", name: "Mina al-Ahmadi terminal", lat: 29.07, lon: 48.15, country: "KW", role: "Crude export terminal", insideGulf: true },
  { key: "basra-oil-terminal", name: "Basra Oil Terminal", lat: 29.68, lon: 48.8, country: "IQ", role: "Offshore crude export terminal", insideGulf: true },
  { key: "kharg", name: "Kharg Island terminal", lat: 29.23, lon: 50.31, country: "IR", role: "Crude export terminal", insideGulf: true },
  { key: "ras-laffan", name: "Ras Laffan", lat: 25.92, lon: 51.53, country: "QA", role: "Condensate and gas export port", insideGulf: true },
  { key: "jebel-dhanna", name: "Jebel Dhanna and Ruwais", lat: 24.18, lon: 52.6, country: "AE", role: "Crude export terminal", insideGulf: true },
  { key: "sitra", name: "Sitra terminal", lat: 26.15, lon: 50.62, country: "BH", role: "Export terminal", insideGulf: true },
  { key: "fujairah", name: "Fujairah", lat: 25.12, lon: 56.36, country: "AE", role: "Export terminal on the Gulf of Oman", insideGulf: false },
  { key: "jask", name: "Jask terminal", lat: 25.65, lon: 57.77, country: "IR", role: "Export terminal on the Gulf of Oman", insideGulf: false },
  { key: "yanbu", name: "Yanbu", lat: 24.09, lon: 38.06, country: "SA", role: "Export terminal on the Red Sea", insideGulf: false },
  { key: "mina-al-fahal", name: "Mina al Fahal", lat: 23.63, lon: 58.52, country: "OM", role: "Crude export terminal", insideGulf: false },
];
const CHOKEPOINTS = [
  { key: "hormuz", name: "Strait of Hormuz", lat: 26.57, lon: 56.25, note: "Connects the Persian Gulf with the Gulf of Oman and the Arabian Sea." },
  { key: "bab-el-mandeb", name: "Bab-el-Mandeb", lat: 12.58, lon: 43.33, note: "Connects the Red Sea with the Gulf of Aden." },
  { key: "suez", name: "Suez Canal", lat: 30.0, lon: 32.55, note: "Connects the Red Sea with the Mediterranean." },
];
const LANES: { key: string; name: string; path: [number, number][]; through: string }[] = [
  { key: "gulf-hormuz-arabian-sea", name: "Persian Gulf to the Arabian Sea", through: "hormuz", path: [[26.64, 50.16], [27.0, 51.6], [26.3, 54.2], [26.57, 56.25], [25.9, 57.3], [24.5, 59.5], [22.6, 62.5]] },
  { key: "red-sea-gulf-of-aden", name: "Red Sea to the Gulf of Aden", through: "bab-el-mandeb", path: [[24.09, 38.06], [20.0, 38.9], [15.5, 41.5], [12.58, 43.33], [12.2, 46.0]] },
  { key: "red-sea-suez", name: "Red Sea to Suez", through: "suez", path: [[24.09, 38.06], [27.5, 34.6], [29.6, 32.7], [30.0, 32.55]] },
];
const PIPELINES: { key: string; name: string; capacityKbd: number; extra: Record<string, unknown>; path: [number, number][] | null; end: string }[] = [
  { key: "east-west", name: "Saudi East-West crude pipeline", capacityKbd: 5000, extra: { temporaryMaxKbd: 7000, temporaryNote: "Temporarily expanded to 7 million b/d in 2019" }, path: [[25.94, 49.68], [24.9, 46.0], [24.2, 42.0], [24.09, 38.06]], end: "yanbu" },
  { key: "uae-fujairah", name: "UAE onshore fields to Fujairah pipeline", capacityKbd: 1500, extra: {}, path: [[23.84, 53.65], [24.5, 55.2], [25.12, 56.36]], end: "fujairah" },
  { key: "goreh-jask", name: "Goreh-Jask pipeline", capacityKbd: 300, extra: { inUse: false, note: "No use since the July 2021 inauguration, per EIA" }, path: null, end: "jask" },
];

/** Seeds the map's entities and links. `evidenceId` is the stored evidence record of the cited source; without it the sourced links are written as assumed. */
export async function seedGeography(c: pg.PoolClient, inst: string, evidenceId: string | null): Promise<{ entities: number; links: number }> {
  const g = new PostgresGraph(c, inst);
  let entities = 0, links = 0;
  const cite = (rationale: string): Pick<LinkInput, "linkClass" | "rationale" | "evidence"> => evidenceId ? { linkClass: "sourced", rationale, evidence: [{ evidenceId, role: "supports" }] } : { linkClass: "assumed", rationale: `${rationale} The cited source is not stored yet, so this is assumed.` };
  for (const k of CHOKEPOINTS) {
    // The one published flow figure is kept with the evidence record it came from. Without that record it is not stored at all.
    const flow = k.key === "hormuz" && evidenceId ? { flow: { kbd: 21000, year: 2022, shareOfGlobalLiquidsConsumption: 0.21, evidenceId, source: `EIA, ${GEOGRAPHY_SOURCE.date}` } } : {};
    await g.upsertEntity({ kind: "chokepoint", key: `chokepoint:${k.key}`, name: k.name, attrs: { lat: k.lat, lon: k.lon, positionBasis: POSITION, note: k.note, ...flow } }); entities++;
  }
  for (const f of FACILITIES) { await g.upsertEntity({ kind: "facility", key: `facility:${f.key}`, name: f.name, attrs: { lat: f.lat, lon: f.lon, country: f.country, role: f.role, positionBasis: POSITION } }); entities++; }
  for (const l of LANES) {
    await g.upsertEntity({ kind: "route", key: `route:lane:${l.key}`, name: l.name, attrs: { routeKind: "sea-lane", path: l.path, pathBasis: SCHEMATIC } }); entities++;
    await g.addLink({ subject: `route:lane:${l.key}`, predicate: "passes", object: `chokepoint:${l.through}`, linkClass: "assumed", rationale: "Schematic lane drawn through the named chokepoint for orientation." }); links++;
  }
  for (const f of FACILITIES.filter(x => x.insideGulf)) { await g.addLink({ subject: `facility:${f.key}`, predicate: "exports_via", object: "chokepoint:hormuz", linkClass: "inferred", rationale: "The terminal is inside the Persian Gulf, so cargoes bound for other seas pass the Strait of Hormuz." }); links++; }
  for (const p of PIPELINES) {
    await g.upsertEntity({ kind: "route", key: `route:pipeline:${p.key}`, name: p.name, attrs: { routeKind: "pipeline", capacityKbd: p.capacityKbd, ...p.extra, ...(p.path ? { path: p.path, pathBasis: SCHEMATIC } : {}) } }); entities++;
    await g.addLink({ subject: `route:pipeline:${p.key}`, predicate: "bypasses", object: "chokepoint:hormuz", params: { capacityKbd: p.capacityKbd, ...p.extra }, ...cite(`Pipeline that can circumvent the Strait of Hormuz, capacity ${p.capacityKbd / 1000} million b/d (EIA, ${GEOGRAPHY_SOURCE.date}).`) }); links++;
    const named = p.key !== "east-west"; // the article names Fujairah and Jask, but not Yanbu
    await g.addLink({ subject: `route:pipeline:${p.key}`, predicate: "terminates_at", object: `facility:${p.end}`, ...(named ? cite(`The article names the ${p.end === "jask" ? "Jask" : "Fujairah"} export terminal on the Gulf of Oman.`) : { linkClass: "assumed" as const, rationale: "Yanbu as the western end is public general knowledge, not stated in the cited article." }) }); links++;
  }
  return { entities, links };
}
