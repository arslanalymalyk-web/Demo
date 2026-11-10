import type { RawRecord } from "../../core/src/index.js";
import type { Connector, ConnectorContext } from "./types.js";

/** Tesseract OLAP API (used by DataSaudi). Each cube carries the original agency and a link to its source. */
export const tesseract: Connector = {
  platform: "tesseract",
  async *fetchRecords(ctx: ConnectorContext): AsyncGenerator<RawRecord> {
    const apiBase = ctx.baseUrl.replace(/\/$/, "");
    const cat = await ctx.http.getJson<{ cubes: any[] }>(`${apiBase}/tesseract/cubes`);
    let n = 0;
    for (const c of cat.cubes) {
      if (ctx.limit !== undefined && n >= ctx.limit) return;
      const a = c.annotations ?? {};
      let agency: string | null = a.source_name ?? null;
      if (!agency && a.source_link) { try { agency = new URL(a.source_link).host; } catch { agency = null; } }
      yield {
        externalKey: `cube:${c.name}`, kind: "catalog",
        sourceUrl: a.source_link ?? `${apiBase}/tesseract/cubes`,
        originalAgency: agency, eventTime: null,
        payload: { name: c.name, topic_en: a.topic_en ?? null, topic_ar: a.topic_ar ?? null, subtopic_en: a.subtopic_en ?? null, table_en: a.table_en ?? null, source_name: a.source_name ?? null, source_link: a.source_link ?? null, dimensions: (c.dimensions ?? []).map((d: any) => d.name), measures: (c.measures ?? []).map((m: any) => m.name) },
      };
      n++;
    }
  },
};
