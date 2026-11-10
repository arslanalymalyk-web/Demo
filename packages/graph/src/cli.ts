import pg from "pg";
import { PoliteHttp } from "../../connectors/src/index.js";
import { DocumentQueue, submitDocument } from "../../documents/src/index.js";
import { withTenant } from "../../ingest/src/store.js";
import { GEOGRAPHY_SOURCE, seedGeography } from "./geography.js";
import { PostgresGraph } from "./repository.js";

const [cmd, ...rest] = process.argv.slice(2);
const institutionId = process.env.TIGERIS_INSTITUTION_ID;
if (!process.env.DATABASE_URL || !institutionId) { console.error("DATABASE_URL and TIGERIS_INSTITUTION_ID are required"); process.exit(2); }
const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };

/** Reduces the article's HTML to its text. Only the article body is kept. */
export function articleText(html: string): string {
  const body = html.replace(/<(script|style|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ");
  const text = body.replace(/<[^>]+>/g, "\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;/g, "’").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
  const start = text.indexOf("November 21, 2023"), end = text.indexOf("Principal contributors");
  if (start < 0 || end < 0) throw new Error("the article layout was not recognised; refusing to store a guess");
  return text.slice(start, end).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (cmd === "seed") {
      const as = opt("as");
      if (!as) { console.error("usage: seed --as <subject of the administrator the upload is recorded under>"); process.exit(2); }
      const http = new PoliteHttp();
      const html = (await http.getBuffer(GEOGRAPHY_SOURCE.url, "text/html")).toString("utf8");
      const text = `${GEOGRAPHY_SOURCE.publisher}\n${GEOGRAPHY_SOURCE.title}\n${GEOGRAPHY_SOURCE.url}\n\n${articleText(html)}\n`;
      const me = await withTenant(pool, institutionId, async c => (await c.query("SELECT id FROM principals WHERE idp_subject = $1 AND disabled_at IS NULL", [as])).rows[0]?.id as string | undefined);
      if (!me) throw new Error(`no active principal with subject ${as}`);
      const sub = await withTenant(pool, institutionId, c => submitDocument(c, institutionId, me, { buffer: Buffer.from(text, "utf8"), filename: "eia-hormuz-2023-11-21.txt", title: `${GEOGRAPHY_SOURCE.publisher}: ${GEOGRAPHY_SOURCE.title} (${GEOGRAPHY_SOURCE.date})`, dataClass: "public_record", originalAgency: GEOGRAPHY_SOURCE.publisher, sourceUrl: GEOGRAPHY_SOURCE.url, rights: "Published by a U.S. government agency and stated by the publisher to be public. Declared by the uploader; not verified.", clientDataEnabled: false }));
      const q = new DocumentQueue(pool, institutionId); q.enqueue(sub.id); await q.idle();
      const ev = await withTenant(pool, institutionId, async c => (await c.query("SELECT evidence_id, status FROM documents WHERE id = $1", [sub.id])).rows[0] as { evidence_id: string | null; status: string });
      if (ev.status !== "ready" || !ev.evidence_id) throw new Error(`the source document is ${ev.status}; geography was not seeded with a citation`);
      const r = await withTenant(pool, institutionId, async c => ({ ...(await seedGeography(c, institutionId, ev.evidence_id)), snapshot: await new PostgresGraph(c, institutionId).snapshot() }));
      console.log(JSON.stringify({ document: sub.id, evidenceId: ev.evidence_id, duplicateUpload: sub.duplicate, ...r }, null, 1));
    } else { console.error("usage: seed --as <administrator subject>"); process.exit(2); }
  } finally { await pool.end(); }
}
