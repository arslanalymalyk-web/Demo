import type { RawRecord } from "../../core/src/index.js";
import type { Connector, ConnectorContext } from "./types.js";

interface CkanList { success: boolean; result: string[] }
interface CkanShow { success: boolean; result: Record<string, any> }

/** CKAN action API: package_list then package_show for each dataset. */
export const ckan: Connector = {
  platform: "ckan",
  async *fetchRecords(ctx: ConnectorContext): AsyncGenerator<RawRecord> {
    const base = ctx.baseUrl.replace(/\/$/, "");
    const list = await ctx.http.getJson<CkanList>(`${base}/api/3/action/package_list`);
    let n = 0;
    for (const name of list.result) {
      if (ctx.limit !== undefined && n >= ctx.limit) return;
      const show = await ctx.http.getJson<CkanShow>(`${base}/api/3/action/package_show?id=${encodeURIComponent(name)}`);
      const p = show.result;
      yield {
        externalKey: `package:${name}`, kind: "catalog",
        sourceUrl: `${base}/dataset/${name}`,
        originalAgency: p.organization?.title ?? p.author ?? null,
        eventTime: p.metadata_modified ? new Date(p.metadata_modified.endsWith("Z") ? p.metadata_modified : p.metadata_modified + "Z").toISOString() : null,
        payload: { name, title: p.title ?? null, notes: p.notes ?? null, licence: p.license_title ?? null, organization: p.organization?.title ?? null, resources: (p.resources ?? []).map((r: any) => ({ name: r.name ?? null, format: r.format ?? null, url: r.url ?? null })) },
      };
      n++;
    }
  },
};
