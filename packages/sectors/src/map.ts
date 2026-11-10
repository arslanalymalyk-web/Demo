import type pg from "pg";
import { PostgresGraph } from "../../graph/src/index.js";
import type { SectorView } from "./view.js";

export interface MapProducer { code: string; name: string; exportsKbd: number; medianKbd: number; changePct: number | null; lagging: boolean; period: string; evidenceId: string; productionKbd: number | null }
export interface MapView {
  extent: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  entities: { key: string; kind: string; name: string; attrs: Record<string, unknown> }[];
  links: { id: string; from: string; to: string; predicate: string; linkClass: string; params: Record<string, unknown>; rationale: string | null; evidence: string[] }[];
  producers: MapProducer[];
  notes: { positions: string; lanes: string; vessels: string };
}
export const MAP_EXTENT = { lonMin: 32, lonMax: 66, latMin: 11, latMax: 34 };

/** Everything the map draws: public-record geography from the graph, and the stored export series for each producer. No vessel positions. */
export async function buildMap(c: pg.PoolClient, inst: string, energy: SectorView | null): Promise<MapView> {
  const g = await new PostgresGraph(c, inst).subgraph(["facility", "route", "chokepoint"]);
  return {
    extent: MAP_EXTENT, entities: g.entities.filter(e => typeof e.attrs.lat === "number" || Array.isArray(e.attrs.path) || e.kind === "route"), links: g.links,
    producers: (energy?.countries ?? []).map(x => ({ code: x.code, name: x.name, exportsKbd: x.exportsKbd, medianKbd: x.medianKbd, changePct: x.changePct, lagging: x.lagging, period: x.period, evidenceId: x.evidenceId, productionKbd: x.productionKbd })),
    notes: { positions: "Facility positions are approximate.", lanes: "Sea lanes and pipeline paths are schematic, for orientation.", vessels: "No vessel positions are shown. No live vessel feed is connected." },
  };
}
