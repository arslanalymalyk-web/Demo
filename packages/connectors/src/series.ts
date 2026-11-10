import type { ObservationFact, RawRecord } from "../../core/src/index.js";
import type { Connector, ConnectorContext } from "./types.js";

export interface SeriesSpec {
  key: string; title: string; description?: string; frequency: "annual" | "quarterly" | "monthly"; packs: string[]; maxAgeDays?: number;
  cube: string; dimensions: string[]; timeLevel: "Year" | "Quarter" | "Month"; drilldowns: string[]; measures: { name: string; unit: string | null }[];
}

/** Start of the period as an ISO instant (UTC), or null when the label is not understood. */
export function toValidTime(level: SeriesSpec["timeLevel"], v: unknown): string | null {
  if (level === "Year") { const y = typeof v === "number" ? v : Number(v); return Number.isInteger(y) && y > 1800 && y < 2200 ? `${y}-01-01T00:00:00.000Z` : null; }
  if (level === "Quarter") { const m = /^(\d{4})-Q([1-4])$/.exec(String(v)); return m ? `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}-01T00:00:00.000Z` : null; }
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(v)); return m ? `${m[1]}-${m[2]}-01T00:00:00.000Z` : null;
}

/** One record per series: the full query result as the evidence snapshot, plus one fact per observation and measure. */
export function seriesConnector(specs: SeriesSpec[]): Connector {
  return {
    platform: "tesseract-series",
    async *fetchRecords(ctx: ConnectorContext): AsyncGenerator<RawRecord> {
      const base = ctx.baseUrl.replace(/\/$/, "");
      const chosen = specs.filter(s => !ctx.seriesKey || s.key === ctx.seriesKey).slice(0, ctx.limit ?? specs.length);
      for (const spec of chosen) {
        const qs = new URLSearchParams({ cube: spec.cube, drilldowns: spec.drilldowns.join(","), measures: spec.measures.map(m => m.name).join(","), locale: "en" });
        const res = await ctx.http.getJson<{ annotations?: Record<string, any>; columns?: string[]; data: Record<string, unknown>[] }>(`${base}/tesseract/data.jsonrecords?${qs.toString()}`);
        const facts: ObservationFact[] = []; let nulls = 0; let latest: string | null = null;
        for (const row of res.data) {
          const validTime = toValidTime(spec.timeLevel, row[spec.timeLevel]);
          const dims: Record<string, string | number | null> = { period: (row[spec.timeLevel] as string | number | null) ?? null };
          for (const d of spec.dimensions) dims[d] = (row[d] as string | number | null) ?? null;
          const subject = [spec.key, ...spec.dimensions.map(d => `${d}=${row[d]}`)].join("|");
          for (const m of spec.measures) {
            const v = row[m.name];
            if (typeof v !== "number" || !Number.isFinite(v)) { nulls++; continue; }
            facts.push({ subject, predicate: m.name, value: v, unit: m.unit, unitStated: m.unit !== null, validTime, dims });
          }
          if (validTime && (!latest || validTime > latest)) latest = validTime;
        }
        const ann = res.annotations ?? {};
        yield {
          externalKey: `series:${spec.key}`, kind: "observation",
          sourceUrl: ann.source_link ?? `${base}/tesseract/cubes/${spec.cube}`,
          originalAgency: ann.source_name ?? null, eventTime: latest,
          transformation: `tesseract data.jsonrecords; one fact per row and measure; ${spec.timeLevel} label converted to period start (UTC)`,
          series: { key: spec.key, title: spec.title, ...(spec.description ? { description: spec.description } : {}), frequency: spec.frequency, packs: spec.packs, ...(spec.maxAgeDays !== undefined ? { maxAgeDays: spec.maxAgeDays } : {}), query: { cube: spec.cube, drilldowns: spec.drilldowns, measures: spec.measures.map(m => m.name) } },
          payload: { cube: spec.cube, table: ann.table_en ?? null, rowCount: res.data.length, nullMeasures: nulls, columns: res.columns ?? [], data: res.data },
          facts,
        };
      }
    },
  };
}
