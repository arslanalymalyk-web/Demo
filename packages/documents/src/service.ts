import { createHash } from "node:crypto";
import type pg from "pg";
import { PoliteHttp, type Connector } from "../../connectors/src/index.js";
import { keysetPage, likePattern, type Page } from "../../core/src/index.js";
import type { RawRecord } from "../../core/src/index.js";
import { runIngestion } from "../../ingest/src/pipeline.js";
import { audit, withTenant } from "../../ingest/src/store.js";
import { extract } from "./extract.js";
import { IntakeError, sniff } from "./sniff.js";
import { ScannerUnavailable, scanBackoffMs, type Scanner, type Verdict } from "./scan.js";
import { tools } from "./tools.js";

export type DocDataClass = "public_record" | "institution_own" | "sample_dataset";
export const DOC_CLASSES: DocDataClass[] = ["public_record", "institution_own", "sample_dataset"];
const LABEL: Record<DocDataClass, string> = { public_record: "public records", institution_own: "institution documents", sample_dataset: "sample dataset" };

export interface SubmitInput { buffer: Buffer; filename: string; title?: string; dataClass: DocDataClass; originalAgency?: string; sourceUrl?: string; rights: string; languages?: string; clientDataEnabled: boolean; scan?: { configured: boolean; engine: string | null; verdict: Verdict | null } }

/** One approved upload source per data class, so each document's evidence inherits an honest class. */
async function uploadSource(c: pg.PoolClient, inst: string, cls: DocDataClass): Promise<string> {
  const key = `uploaded-documents:${cls}`;
  await c.query(
    `INSERT INTO sources (institution_id, source_key, name, publisher, original_agency, platform_type, base_url, status, data_class, licence_name, licence_verified, rights_note)
     VALUES ($1,$2,$3,'Uploaded by the institution',NULL,'upload','upload://documents','approved',$4::data_class,'Declared by the uploader',false,'The uploader states the rights for each document. TIGERIS has not verified them.')
     ON CONFLICT (institution_id, source_key) DO NOTHING`, [inst, key, `Uploaded documents (${LABEL[cls]})`, cls]);
  return key;
}

export async function submitDocument(c: pg.PoolClient, inst: string, actorId: string, i: SubmitInput): Promise<{ id: string; status: string; duplicate: boolean; scanStatus: string }> {
  const s = sniff(i.buffer);
  if (!DOC_CLASSES.includes(i.dataClass)) throw new IntakeError("choose a data class: public record, institution document or sample dataset", "invalid");
  if (i.dataClass === "institution_own" && !i.clientDataEnabled) throw new IntakeError("institution documents are not enabled on this deployment. Public sources only until the NDA and a data processing agreement are in place.", "forbidden");
  if (i.rights.trim().length < 3) throw new IntakeError("state the rights under which this document may be used", "invalid");
  if (i.dataClass === "public_record" && !i.originalAgency?.trim()) throw new IntakeError("a public record must name the agency that published it", "invalid");
  const scan = i.scan ?? { configured: false, engine: null, verdict: null };
  if (i.dataClass === "institution_own" && !scan.configured) throw new IntakeError("institution documents need a malware scanner, and none is configured on this deployment", "forbidden");
  const sha = createHash("sha256").update(i.buffer).digest("hex");
  const dup = await c.query("SELECT id, status, scan_status FROM documents WHERE sha256 = $1", [sha]);
  if (dup.rows[0]) return { id: dup.rows[0].id, status: dup.rows[0].status, duplicate: true, scanStatus: dup.rows[0].scan_status };
  const infected = scan.verdict && !scan.verdict.clean ? scan.verdict.signature : null;
  const scanStatus = infected ? "infected" : scan.verdict?.clean ? "clean" : scan.configured ? "pending" : "not_scanned";
  const name = i.filename.replace(/[\u0000-\u001f/\\]/g, "_").slice(0, 200) || `document.${s.ext}`;
  const r = await c.query(
    `INSERT INTO documents (institution_id, title, filename, mime, size_bytes, sha256, data_class, original_agency, source_url, rights_statement, languages, uploaded_by, status, scan_status, scan_engine, scan_signature, scanned_at, processed_at, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7::data_class,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [inst, (i.title?.trim() || name).slice(0, 300), name, s.mime, i.buffer.length, sha, i.dataClass, i.originalAgency?.trim() || null, i.sourceUrl?.trim() || null, i.rights.trim(), i.languages ?? "eng", actorId,
      infected ? "quarantined" : "queued", scanStatus, scan.verdict ? scan.engine : null, infected, scan.verdict ? new Date().toISOString() : null, infected ? new Date().toISOString() : null, infected ? `The malware scanner flagged this file (${infected}). It was not opened and cannot be downloaded.` : null]);
  // A file the scanner flagged is recorded but its bytes are not kept.
  if (!infected) await c.query("INSERT INTO document_files (institution_id, document_id, content) VALUES ($1,$2,$3)", [inst, r.rows[0].id, i.buffer]);
  await audit(c, inst, { actorType: "principal", actorId, action: "document.uploaded", objectType: "document", objectId: r.rows[0].id, payload: { sha256: sha, mime: s.mime, bytes: i.buffer.length, dataClass: i.dataClass, scan: scanStatus } });
  if (infected) await audit(c, inst, { actorType: "system", action: "document.malware_detected", objectType: "document", objectId: r.rows[0].id, payload: { sha256: sha, signature: infected, engine: scan.engine, uploadedBy: actorId } });
  return { id: r.rows[0].id, status: infected ? "quarantined" : "queued", duplicate: false, scanStatus };
}

/** Extracts a stored document and records the result as evidence. Safe to call again for a document that failed. */
/** Decides whether a stored document may be opened. A file is processed only after a scanner has said it is clean; if no verdict can be had, it waits and is tried again. */
async function scanGate(pool: pg.Pool, inst: string, docId: string, scanner: Scanner | null, now: () => Date): Promise<"go" | "skip" | "waiting" | "infected"> {
  const d = await withTenant(pool, inst, async c => (await c.query("SELECT d.status, d.scan_status, d.scan_attempts, d.data_class, f.content FROM documents d JOIN document_files f ON f.document_id = d.id WHERE d.id = $1", [docId])).rows[0] as { status: string; scan_status: string; scan_attempts: number; data_class: string; content: Buffer } | undefined);
  if (!d) throw new Error("document not found");
  if (d.status !== "queued" && d.status !== "processing") return "skip";
  if (d.scan_status === "clean" || (d.scan_status === "not_scanned" && d.data_class !== "institution_own")) return "go";
  const defer = (why: string) => withTenant(pool, inst, async c => {
    const n = d.scan_attempts + 1;
    await c.query("UPDATE documents SET scan_status = 'error', scan_attempts = $2, scan_next_at = $3, scan_error = $4 WHERE id = $1", [docId, n, new Date(now().getTime() + scanBackoffMs(n)).toISOString(), why]);
    if (n === 1) await audit(c, inst, { actorType: "system", action: "document.scan_deferred", objectType: "document", objectId: docId, payload: { reason: why } });
    return "waiting" as const;
  });
  if (!scanner) return defer("no malware scanner is configured, so the file is held");
  let v: Verdict;
  try { v = await scanner.scan(d.content); } catch (e) { return defer(e instanceof ScannerUnavailable ? e.message : "the scan could not be completed"); }
  return withTenant(pool, inst, async c => {
    if (v.clean) { await c.query("UPDATE documents SET scan_status = 'clean', scan_engine = $2, scanned_at = now(), scan_error = NULL, scan_next_at = NULL WHERE id = $1", [docId, scanner.engine]); await audit(c, inst, { actorType: "system", action: "document.scanned", objectType: "document", objectId: docId, payload: { engine: scanner.engine, verdict: "clean" } }); return "go" as const; }
    await c.query("UPDATE documents SET status = 'quarantined', scan_status = 'infected', scan_engine = $2, scan_signature = $3, scanned_at = now(), processed_at = now(), scan_error = NULL, scan_next_at = NULL, error = $4 WHERE id = $1", [docId, scanner.engine, v.signature, `The malware scanner flagged this file (${v.signature}). It was not opened and cannot be downloaded.`]);
    await audit(c, inst, { actorType: "system", action: "document.malware_detected", objectType: "document", objectId: docId, payload: { signature: v.signature, engine: scanner.engine } });
    return "infected" as const;
  });
}

export async function processDocument(pool: pg.Pool, inst: string, docId: string, now: () => Date = () => new Date(), scanner: Scanner | null = null): Promise<string> {
  const gate = await scanGate(pool, inst, docId, scanner, now);
  if (gate !== "go") return gate === "skip" ? "skipped" : gate;
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
  private inflight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private pool: pg.Pool, private inst: string, private now: () => Date = () => new Date(), readonly scanner: Scanner | null = null) {}
  enqueue(docId: string): void {
    if (this.inflight.has(docId)) return;
    this.inflight.add(docId); this.pending++;
    this.chain = this.chain.then(() => processDocument(this.pool, this.inst, docId, this.now, this.scanner)).catch(() => undefined).finally(() => { this.pending--; this.inflight.delete(docId); });
  }
  async resume(): Promise<number> {
    const ids = await withTenant(this.pool, this.inst, async c => (await c.query("SELECT id FROM documents WHERE status IN ('queued','processing') ORDER BY created_at")).rows.map(r => r.id as string));
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }
  /** Tries again, with back-off, every document that is waiting for a scan. */
  async retryWaiting(): Promise<number> {
    const ids = await withTenant(this.pool, this.inst, async c => (await c.query("SELECT id FROM documents WHERE status = 'queued' AND scan_status IN ('pending','error') AND (scan_next_at IS NULL OR scan_next_at <= $1) ORDER BY created_at LIMIT 50", [this.now().toISOString()])).rows.map(r => r.id as string));
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }
  startRetrying(everyMs = 30_000): void { if (!this.timer) { this.timer = setInterval(() => { void this.retryWaiting().catch(() => undefined); }, everyMs); this.timer.unref(); } }
  async idle(): Promise<void> { if (this.timer) { clearInterval(this.timer); this.timer = null; } await this.chain; }
  get busy(): boolean { return this.pending > 0; }
}

export async function retryDocument(c: pg.PoolClient, inst: string, actorId: string, docId: string): Promise<void> {
  const r = await c.query("UPDATE documents SET status = 'queued', error = NULL WHERE id = $1 AND status = 'failed' RETURNING id", [docId]);
  if (!r.rowCount) throw new IntakeError("only a failed document can be retried", "invalid");
  await audit(c, inst, { actorType: "principal", actorId, action: "document.retried", objectType: "document", objectId: docId, payload: {} });
}

const COLS = "scan_status, scan_engine, scan_signature, scanned_at, scan_attempts, scan_next_at, scan_error, id, title, filename, mime, size_bytes, sha256, data_class, original_agency, source_url, rights_statement, languages, status, error, page_count, language, ocr_used, avg_confidence, evidence_id, uploaded_by, created_at, processed_at";
export async function listDocumentsPage(c: pg.PoolClient, f: { q?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<Page<Record<string, unknown>>> {
  return keysetPage(c, { select: COLS, from: "documents d", where: "($1::text IS NULL OR d.title ILIKE $1 OR d.filename ILIKE $1) AND ($2::text IS NULL OR d.status = $2)", params: [f.q?.trim() ? likePattern(f.q) : null, f.status ?? null], ts: "d.created_at", id: "d.id", limit: f.limit ?? 50, cursor: f.cursor });
}
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
  const r = (await c.query("SELECT d.mime, d.filename, d.scan_status, f.content FROM documents d LEFT JOIN document_files f ON f.document_id = d.id WHERE d.id = $1", [id])).rows[0];
  if (!r) return null;
  if (r.scan_status === "infected") throw new IntakeError("this file was flagged by the malware scanner and cannot be downloaded", "forbidden");
  if (r.scan_status === "pending" || r.scan_status === "error") throw new IntakeError("this file is waiting for a malware scan and cannot be downloaded yet", "forbidden");
  if (!r.content) return null;
  await audit(c, inst, { actorType: "principal", actorId, action: "document.downloaded", objectType: "document", objectId: id, payload: {} });
  return { content: r.content, mime: r.mime, filename: r.filename };
}

/** How many documents are in each scan state, for the Documents screen and the metrics. */
export async function scanSummary(c: pg.PoolClient): Promise<Record<string, number>> {
  const out: Record<string, number> = { pending: 0, clean: 0, infected: 0, error: 0, not_scanned: 0 };
  for (const r of (await c.query("SELECT scan_status, count(*)::int AS n FROM documents GROUP BY scan_status")).rows) out[r.scan_status as string] = r.n;
  return out;
}
