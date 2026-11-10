import { createHash } from "node:crypto";
import type pg from "pg";
import { PoliteHttp, type Connector } from "../../connectors/src/index.js";
import type { RawRecord } from "../../core/src/index.js";
import { runIngestion } from "../../ingest/src/pipeline.js";
import { audit, withTenant } from "../../ingest/src/store.js";
import { extract } from "./extract.js";
import { IntakeError, sniff } from "./sniff.js";
import { tools } from "./tools.js";

export type DocDataClass = "public_record" | "institution_own" | "sample_dataset";
export const DOC_CLASSES: DocDataClass[] = ["public_record", "institution_own", "sample_dataset"];
const LABEL: Record<DocDataClass, string> = { public_record: "public records", institution_own: "institution documents", sample_dataset: "sample dataset" };

export interface SubmitInput { buffer: Buffer; filename: string; title?: string; dataClass: DocDataClass; originalAgency?: string; sourceUrl?: string; rights: string; languages?: string; clientDataEnabled: boolean }

/** One approved upload source per data class, so each document's evidence inherits an honest class. */
async function uploadSource(c: pg.PoolClient, inst: string, cls: DocDataClass): Promise<string> {
  const key = `uploaded-documents:${cls}`;
  await c.query(
    `INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, data_class, licence_name, licence_verified, rights_note)
     VALUES ($1,$2,$3,'Uploaded by the institution',NULL,'upload','upload://documents','approved',$4::data_class,'Declared by the uploader',false,'The uploader states the rights for each document. TIGERIS has not verified them.')
     ON CONFLICT (institution_id, source_key) DO NOTHING`, [inst, key, `Uploaded documents (${LABEL[cls]})`, cls]);
  return key;
}

export async function submitDocument(c: pg.PoolClient, inst: string, actorId: string, i: SubmitInput): Promise<{ id: string; status: string; duplicate: boolean }> {
  const s = sniff(i.buffer);
  if (!DOC_CLASSES.includes(i.dataClass)) throw new IntakeError("choose a data class: public record, institution document or sample dataset", "invalid");
  if (i.dataClass === "institution_own" && !i.clientDataEnabled) throw new IntakeError("institution documents are not enabled on this deployment. Public sources only until the NDA and a data processing agreement are in place.", "forbidden");
  if (i.rights.trim().length < 3) throw new IntakeError("state the rights under which this document may be used", "invalid");
  if (i.dataClass === "public_record" && !i.originalAgency?.trim()) throw new IntakeError("a public record must name the agency that published it", "invalid");
  const sha = createHash("sha256").update(i.buffer).digest("hex");
  const dup = await c.query("SELECT id, status FROM documents WHERE sha256 = $1", [sha]);
  if (dup.rows[0]) return { id: dup.rows[0].id, status: dup.rows[0].status, duplicate: true };
  const name = i.filename.replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 200) || `document.${s.ext}`;
  const r = await c.query(
    `INSERT INTO documents (institution_id, title, filename, mime, size_bytes, sha256, data_class, original_agency, source_url, rights_statement, languages, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::data_class,$8,$9,$10,$11,$12) RETURNING id`,
    [inst, (i.title?.trim() || name).slice(0, 300), name, s.mime, i.buffer.length, sha, i.dataClass, i.originalAgency?.trim() || null, i.sourceUrl?.trim() || null, i.rights.trim(), i.languages ?? "eng", actorId]);
  await c.query("INSERT INTO document_files (institution_id, document_id, content) VALUES ($1,$2,$3)", [inst, r.rows[0].id, i.buffer]);
  await audit(c, inst, { actorType: "principal", actorId, action: "document.uploaded", objectType: "document", objectId: r.rows[0].id, payload: { sha256: sha, mime: s.mime, bytes: i.buffer.length, dataClass: i.dataClass } });
  return { id: r.rows[0].id, status: "queued", duplicate: false };
}

/** Extracts a stored document and records the result as evidence. Safe to call again for a document that failed. */
export async function processDocument(pool: pg.Pool, inst: string, docId: string, now: () => Date = () => new Date()): Promise<string> {
  const loaded = await withTenant(pool, inst, async c => {
    const r = await c.query("SELECT d.*, f.content FROM documents d JOIN document_files f ON f.document_id = d.id WHERE d.id = $1 FOR UPDATE OF d", [docId]);
    const d = r.rows[0];
    if (!d) throw new Error("document not found");
    if (d.status !== "queued" && d.status !== "processing") return null;
    await c.query("UPDATE documents SET status = 'processing', error = NULL WHERE id = $1", [docId]);
    return d as { content: Buffer; title: string; filename: string; sha256: string; size_bytes: number; data_class: DocDataClass; original_agency: string | null; source_url: string | null; rights_statement: string; languages: string };
  });
  if (!loaded) return "skipped";
  try {
    const x = await extract(loaded.content, { languages: loaded.languages });
    const pages = x.pages.map(p => ({ ...p, sha: createHash("sha256").update(p.text).digest("hex") }));
    const record: RawRecord = {
      externalKey: `document:${loaded.sha256}`, kind: "document", sourceUrl: loaded.source_url, originalAgency: loaded.original_agency, eventTime: x.created && Date.parse(x.created) <= now().getTime() ? x.created : null,
      transformation: `text extraction (${[...new Set(x.pages.map(p => p.method))].join(", ")}); no model reads or rewrites the content`,
      payload: { title: loaded.title, filename: loaded.filename, mime: x.mime, sizeBytes: loaded.size_bytes, sha256: loaded.sha256, rights: loaded.rights_statement, dataClass: loaded.data_class, language: x.language, ocrUsed: x.ocrUsed,
        pages: pages.map(p => ({ n: p.pageNo, method: p.method, chars: p.text.length, confidence: p.confidence === null ? null : Math.round(p.confidence * 10) / 10, textSha256: p.sha })), engine: x.engine },
    };
    const connector: Connector = { platform: "upload", async *fetchRecords() { yield record; } };
    const sourceKey = await withTenant(pool, inst, c => uploadSource(c, inst, loaded.data_class));
    await runIngestion({ pool, institutionId: inst, sourceKey, connector, http: new PoliteHttp({ minIntervalMs: 0 }), now });
    return await withTenant(pool, inst, async c => {
      const ev = await c.query("SELECT e.id, e.validation_status FROM evidence_objects e JOIN sources s ON s.id = e.source_id WHERE s.source_key = $1 AND e.external_key = $2 ORDER BY e.version DESC LIMIT 1", [sourceKey, record.externalKey]);
      const status = ev.rows[0].validation_status === "quarantined" ? "quarantined" : "ready";
      for (const p of pages) await c.query("INSERT INTO document_pages (institution_id, document_id, page_no, method, text, char_count, confidence, text_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [inst, docId, p.pageNo, p.method, p.text, p.text.length, p.confidence, p.sha]);
      await c.query("UPDATE documents SET status = $2, evidence_id = $3, page_count = $4, language = $5, ocr_used = $6, avg_confidence = $7, processed_at = now() WHERE id = $1", [docId, status, ev.rows[0].id, pages.length, x.language, x.ocrUsed, x.avgConfidence]);
      await audit(c, inst, { actorType: "system", action: "document.processed", objectType: "document", objectId: docId, payload: { status, pages: pages.length, ocrUsed: x.ocrUsed, language: x.language } });
      return status;
    });
  } catch (e) {
    const message = e instanceof IntakeError ? e.message : "processing failed";
    await withTenant(pool, inst, async c => {
      await c.query("UPDATE documents SET status = 'failed', error = $2, processed_at = now() WHERE id = $1", [docId, message]);
      await audit(c, inst, { actorType: "system", action: "document.failed", objectType: "document", objectId: docId, payload: { reason: message } });
    });
    return "failed";
  }
}

/** Processes uploads one at a time in this process. Anything left queued after a restart is picked up by resume(). */
export class DocumentQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private pool: pg.Pool, private inst: string, private now: () => Date = () => new Date()) {}
  enqueue(docId: string): void {
    this.pending++;
    this.chain = this.chain.then(() => processDocument(this.pool, this.inst, docId, this.now)).catch(() => undefined).finally(() => { this.pending--; });
  }
  async resume(): Promise<number> {
    const ids = await withTenant(this.pool, this.inst, async c => (await c.query("SELECT id FROM documents WHERE status IN ('queued','processing') ORDER BY created_at")).rows.map(r => r.id as string));
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }
  async idle(): Promise<void> { await this.chain; }
  get busy(): boolean { return this.pending > 0; }
}

export async function retryDocument(c: pg.PoolClient, inst: string, actorId: string, docId: string): Promise<void> {
  const r = await c.query("UPDATE documents SET status = 'queued', error = NULL WHERE id = $1 AND status = 'failed' RETURNING id", [docId]);
  if (!r.rowCount) throw new IntakeError("only a failed document can be retried", "invalid");
  await audit(c, inst, { actorType: "principal", actorId, action: "document.retried", objectType: "document", objectId: docId, payload: {} });
}

const COLS = "id, title, filename, mime, size_bytes, sha256, data_class, original_agency, source_url, rights_statement, languages, status, error, page_count, language, ocr_used, avg_confidence, evidence_id, uploaded_by, created_at, processed_at";
export async function listDocuments(c: pg.PoolClient): Promise<unknown[]> { return (await c.query(`SELECT ${COLS} FROM documents ORDER BY created_at DESC LIMIT 200`)).rows; }
export async function getDocument(c: pg.PoolClient, id: string): Promise<unknown | null> {
  const d = (await c.query(`SELECT ${COLS} FROM documents WHERE id = $1`, [id])).rows[0];
  if (!d) return null;
  const pages = (await c.query("SELECT page_no, method, char_count, confidence FROM document_pages WHERE document_id = $1 ORDER BY page_no", [id])).rows;
  const who = (await c.query("SELECT COALESCE(display_name, idp_subject) AS name FROM principals WHERE id = $1", [d.uploaded_by])).rows[0]?.name ?? null;
  return { ...d, uploaded_by_name: who, pages, tools: await tools() };
}
export async function getPage(c: pg.PoolClient, id: string, n: number): Promise<{ page_no: number; method: string; text: string; confidence: number | null } | null> {
  return (await c.query("SELECT page_no, method, text, confidence FROM document_pages WHERE document_id = $1 AND page_no = $2", [id, n])).rows[0] ?? null;
}
export async function searchDocuments(c: pg.PoolClient, q: string): Promise<unknown[]> {
  return (await c.query(
    `SELECT d.id, d.title, d.data_class, p.page_no, p.method,
            ts_headline('simple', p.text, plainto_tsquery('simple', $1), 'StartSel=⟦, StopSel=⟧, MaxFragments=1, MaxWords=32, MinWords=12') AS snippet,
            ts_rank(to_tsvector('simple', p.text), plainto_tsquery('simple', $1)) AS rank
     FROM document_pages p JOIN documents d ON d.id = p.document_id
     WHERE d.status = 'ready' AND to_tsvector('simple', p.text) @@ plainto_tsquery('simple', $1)
     ORDER BY rank DESC, d.created_at DESC LIMIT 30`, [q])).rows;
}
/** The original file, for download. Every download is written to the audit trail. */
export async function downloadDocument(c: pg.PoolClient, inst: string, actorId: string, id: string): Promise<{ content: Buffer; mime: string; filename: string } | null> {
  const r = (await c.query("SELECT d.mime, d.filename, f.content FROM documents d JOIN document_files f ON f.document_id = d.id WHERE d.id = $1", [id])).rows[0];
  if (!r) return null;
  await audit(c, inst, { actorType: "principal", actorId, action: "document.downloaded", objectType: "document", objectId: id, payload: {} });
  return { content: r.content, mime: r.mime, filename: r.filename };
}
