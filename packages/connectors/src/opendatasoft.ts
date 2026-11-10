import type { RawRecord } from "../../core/src/index.js";
import type { Connector, ConnectorContext } from "./types.js";

interface OdsDataset { dataset_id: string; metas?: { default?: Record<string, unknown> } }
interface OdsPage { total_count: number; results: OdsDataset[] }

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

/** Opendatasoft Explore API v2.1: catalogue entries (dataset metadata) with their licence and update time. */
export const opendatasoft: Connector = {
  platform: "opendatasoft",
  async *fetchRecords(ctx: ConnectorContext): AsyncGenerator<RawRecord> {
    const base = ctx.baseUrl.replace(/\/$/, "");
    const pageSize = 100; let offset = 0; let seen = 0; let total = Infinity;
    while (offset < total && (ctx.limit === undefined || seen < ctx.limit)) {
      const page = await ctx.http.getJson<OdsPage>(`${base}/api/explore/v2.1/catalog/datasets?limit=${pageSize}&offset=${offset}`);
      total = page.total_count;
      for (const d of page.results) {
        if (ctx.limit !== undefined && seen >= ctx.limit) return;
        const m = d.metas?.default ?? {};
        yield {
          externalKey: `catalog:${d.dataset_id}`, kind: "catalog",
          sourceUrl: `${base}/explore/dataset/${d.dataset_id}/`,
          originalAgency: str(m.publisher), eventTime: str(m.modified),
          payload: { dataset_id: d.dataset_id, title: str(m.title), theme: arr(m.theme), publisher: str(m.publisher), licence: str(m.license), records_count: typeof m.records_count === "number" ? m.records_count : null, modified: str(m.modified), language: str(m.language), keywords: arr(m.keyword) },
        };
        seen++;
      }
      offset += pageSize;
      if (page.results.length === 0) return;
    }
  },
};
