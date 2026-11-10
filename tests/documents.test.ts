import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { DocumentQueue, IntakeError, detectLanguage, extract, sniff, stubScanner, tools } from "../packages/documents/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

const fx = (n: string) => readFile(join(import.meta.dirname, "fixtures", n));
const T = await tools();
const ocr = T.tesseract ? it : it.skip;

function pdfWithText(texts: string[]): Buffer {
  const objs: string[] = ["<</Type/Catalog/Pages 2 0 R>>", `<</Type/Pages/Kids[${texts.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}]/Count ${texts.length}>>`];
  texts.forEach((t, i) => { const body = `BT /F1 14 Tf 72 700 Td (${t}) Tj ET`; objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${3 + texts.length * 2} 0 R>>>>>>`, `<</Length ${body.length}>>\nstream\n${body}\nendstream`); });
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<</Root 1 0 R/Size ${objs.length + 1}>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const docx = (bodyXml: string, extra: Record<string, Uint8Array> = {}) => Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(`<w:document><w:body>${bodyXml}</w:body></w:document>`), ...extra }));
const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;

describe("file type detection", () => {
  it("decides from content, not from the name", async () => {
    expect(sniff(pdfWithText(["x"])).kind).toBe("pdf");
    expect(sniff(await fx("ocr-sample.png")).kind).toBe("image");
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])).mime).toBe("image/jpeg");
    expect(sniff(docx(para("hello"))).kind).toBe("docx");
    expect(sniff(Buffer.from("plain notes, with ünïcode")).kind).toBe("text");
  });
  it("refuses executables, scripts, other archives, binary noise, empty and oversize files", () => {
    const bad: [Buffer, RegExp][] = [
      [Buffer.from([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]), /executable/], [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), /executable/], [Buffer.from("#!/bin/sh\nrm -rf /"), /executable/],
      [Buffer.from(zipSync({ "a.txt": strToU8("x") })), /not a Word document/], [Buffer.from([0, 1, 2, 3, 250, 251, 252]), /unsupported/], [Buffer.alloc(0), /empty/], [Buffer.alloc(20 * 1024 * 1024 + 1, 65), /larger than/],
    ];
    for (const [b, re] of bad) expect(() => sniff(b)).toThrow(re);
  });
  it("refuses an archive that inflates far beyond its size", () => {
    const bomb = Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": new Uint8Array(70 * 1024 * 1024) }));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => sniff(bomb)).toThrow(/too large/);
  });
  it("names the dominant script", () => {
    expect(detectLanguage("Brent crude averaged 103.8 dollars per barrel")).toBe("en");
    expect(detectLanguage("بلغ متوسط سعر خام برنت في مايو أكثر من مئة دولار للبرميل")).toBe("ar");
    expect(detectLanguage("Report تقرير about النفط and oil النفط production")).toBe("mixed");
    expect(detectLanguage("ok")).toBe("unknown");
  });
});

describe("text extraction", () => {
  it("reads plain text, including Arabic, without OCR", async () => {
    const x = await extract(Buffer.from("تقرير شهري عن إنتاج النفط الخام في المنطقة\nSecond line"));
    expect(x).toMatchObject({ kind: "text", ocrUsed: false, avgConfidence: null });
    expect(x.pages[0]).toMatchObject({ method: "plain" });
    expect(x.pages[0]!.text).toContain("إنتاج النفط");
  });
  it("reads a Word document, splitting pages at page breaks and decoding entities", async () => {
    const x = await extract(docx(`${para("Revenue &amp; costs &lt;2026&gt;")}<w:p><w:r><w:br w:type="page"/></w:r></w:p>${para("Second page")}`));
    expect(x.pages.map(p => p.method)).toEqual(["docx", "docx"]);
    expect(x.pages[0]!.text).toBe("Revenue & costs <2026>");
    expect(x.pages[1]!.text).toBe("Second page");
  });
  it("reads the text layer of a PDF and records no confidence", async () => {
    const x = await extract(pdfWithText(["Quarterly reserves statement for the central bank"]));
    expect(x.pages).toHaveLength(1);
    expect(x.pages[0]).toMatchObject({ method: "text-layer", confidence: null });
    expect(x.pages[0]!.text).toContain("Quarterly reserves statement");
    expect(x.ocrUsed).toBe(false);
  });
  it("refuses damaged PDFs, over-long PDFs and invalid language selections", async () => {
    await expect(extract(Buffer.from("%PDF-1.4\nthis is not a pdf"))).rejects.toThrow(/could not be read/);
    await expect(extract(pdfWithText(Array.from({ length: 101 }, (_, i) => `page ${i} has enough text to count`)))).rejects.toThrow(/limit is 100/);
    await expect(extract(Buffer.from("hello there, enough text"), { languages: "eng;rm -rf" })).rejects.toThrow(/invalid OCR language/);
  });
});

describe("OCR", () => {
  ocr("recognises a scanned image and reports the engine's own confidence", async () => {
    const x = await extract(await fx("ocr-sample.png"));
    expect(x.ocrUsed).toBe(true);
    expect(x.pages[0]!.method).toBe("ocr");
    expect(x.pages[0]!.text).toMatch(/Brent crude averaged 103\.8 dollars/);
    expect(x.pages[0]!.text).toMatch(/Kuwait crude exports fell to 24/);
    expect(x.avgConfidence).toBeGreaterThan(70);
    expect(x.engine.tesseract).toMatch(/tesseract/);
  });
  ocr("falls back to OCR for a PDF page with no text layer, and keeps text-layer pages as they are", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t-")), run = promisify(execFile);
    try {
      await writeFile(join(dir, "a.pdf"), pdfWithText(["A page with a real text layer, long enough"])); await writeFile(join(dir, "b.pdf"), await fx("scanned.pdf"));
      await run("pdfunite", [join(dir, "a.pdf"), join(dir, "b.pdf"), join(dir, "c.pdf")]);
      const x = await extract(await readFile(join(dir, "c.pdf")));
      expect(x.pages.map(p => p.method)).toEqual(["text-layer", "ocr"]);
      expect(x.pages[1]!.text).toMatch(/Brent crude averaged/);
      expect(x.pages[0]!.confidence).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  ocr("returns no text for a blank page rather than inventing some", async () => {
    const x = await extract(await fx("blank.png"));
    expect(x.pages[0]!.text).toBe("");
  });
  ocr("says so when a language pack is not installed", async () => {
    await expect(extract(await fx("ocr-sample.png"), { languages: "fra" })).rejects.toThrow(/language data not installed: fra/);
  });
  it("offers Arabic OCR where the language data is installed", () => { if (T.tesseract) expect(T.languages).toEqual(expect.arrayContaining(["eng", "ara"])); });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("document intake against a real database and the API", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  async function scene(clientData = false) {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'Docs')", [id]); });
    const tokens = { ana: await addUser(owner, app, id, "ana", ["analyst"]), ed: await addUser(owner, app, id, "ed", ["executive"]), aud: await addUser(owner, app, id, "aud", ["auditor"]) };
    const scanner = clientData ? stubScanner() : null; // institution documents need a scanner
    const queue = new DocumentQueue(app, id, () => new Date("2026-11-10T00:00:00Z"), scanner);
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier(), documents: queue, clientDataEnabled: clientData, scanner });
    const call = async (who: keyof typeof tokens | null, method: string, url: string, payload?: Buffer | object, headers: Record<string, string> = {}) => {
      const r = await server.inject({ method: method as "GET", url, headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers }, ...(payload ? { payload: payload as never } : {}) });
      let body: any = null; try { body = r.json(); } catch { /* binary */ }
      return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers };
    };
    const up = (buf: Buffer, h: Record<string, string> = {}, who: "ana" | "ed" = "ana") => call(who, "POST", "/v1/documents", buf, { "content-type": "application/octet-stream", "x-filename": "report.txt", "x-title": "Monthly report", "x-data-class": "public_record", "x-original-agency": "Ministry of Energy", "x-rights": "Public report, open licence", ...h });
    return { id, call, up, queue, tokens };
  }
  const TEXT = Buffer.from("Brent crude averaged 103.8 dollars per barrel in May. Kuwait exports fell sharply. تقرير شهري");

  it("takes a document from upload to searchable, provenance-backed evidence", async () => {
    const s = await scene();
    const r = await s.up(TEXT);
    expect(r.status).toBe(202); expect(r.body).toMatchObject({ status: "queued", duplicate: false });
    expect((await s.call("ed", "GET", "/v1/documents/config")).body).toMatchObject({ clientDataEnabled: false, maxMegabytes: 20, ocr: { available: T.tesseract !== null } });
    await s.queue.idle();
    const d = (await s.call("ana", "GET", `/v1/documents/${r.body.id}`)).body;
    expect(d).toMatchObject({ status: "ready", mime: "text/plain", page_count: 1, ocr_used: false, language: "mixed", data_class: "public_record", title: "Monthly report", uploaded_by_name: "ana" });
    const lin = (await s.call("ana", "GET", `/v1/evidence/${d.evidence_id}/lineage`)).body;
    expect(lin.provenance).toMatchObject({ origin: { originalAgency: "Ministry of Energy", recordKey: expect.stringMatching(/^document:[0-9a-f]{64}$/) }, dataClass: "public_record", confidence: { validation: "warned" } });
    expect(lin.provenance.transformation).toMatch(/no model reads or rewrites/);
    expect(lin.payload.pages[0]).toMatchObject({ n: 1, method: "plain" });
    const hits = (await s.call("ana", "GET", "/v1/documents/search?q=Kuwait")).body;
    expect(hits).toHaveLength(1); expect(hits[0].snippet).toMatch(/⟦Kuwait⟧/);
    expect((await s.call("ana", "GET", `/v1/documents/${r.body.id}/pages/1`)).body.text).toContain("103.8");
    expect((await s.call("ana", "GET", `/v1/documents/${r.body.id}/pages/9`)).status).toBe(404);
    const dl = await s.call("ana", "GET", `/v1/documents/${r.body.id}/file`);
    expect(dl.raw.equals(TEXT)).toBe(true);
    expect(dl.headers).toMatchObject({ "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
    expect(String(dl.headers["content-disposition"])).toMatch(/^attachment/);
    const actions = await withTenant(app, s.id, async c => (await c.query("SELECT action FROM audit_events WHERE action LIKE 'document.%' ORDER BY seq")).rows.map(x => x.action));
    expect(actions).toEqual(["document.uploaded", "document.processed", "document.downloaded"]);
    expect((await s.call("aud", "GET", "/v1/audit/verify")).body).toMatchObject({ ok: true });
  });

  ocr("runs OCR on an uploaded scan and keeps its confidence in the record", async () => {
    const s = await scene();
    const r = await s.up(await fx("ocr-sample.png"), { "x-filename": "scan.png", "x-title": "Scanned bulletin" });
    await s.queue.idle();
    const d = (await s.call("ana", "GET", `/v1/documents/${r.body.id}`)).body;
    expect(d).toMatchObject({ status: "ready", ocr_used: true, mime: "image/png" });
    expect(d.avg_confidence).toBeGreaterThan(70);
    expect(d.pages[0]).toMatchObject({ method: "ocr" });
    expect((await s.call("ana", "GET", "/v1/documents/search?q=Kuwait")).body[0].title).toBe("Scanned bulletin");
  });

  ocr("quarantines a scan with no readable text and keeps it out of search", async () => {
    const s = await scene();
    const r = await s.up(await fx("blank.png"), { "x-filename": "blank.png" });
    await s.queue.idle();
    const d = (await s.call("ana", "GET", `/v1/documents/${r.body.id}`)).body;
    expect(d.status).toBe("quarantined");
    const lin = (await s.call("ana", "GET", `/v1/evidence/${d.evidence_id}/lineage`)).body;
    expect(lin.provenance.confidence.validation).toBe("quarantined");
    expect(lin.provenance.confidence.checks.find((c: { name?: string; rule?: string }) => (c.name ?? c.rule) === "has_text")).toMatchObject({ result: "fail" });
    expect((await s.call("ana", "GET", "/v1/documents/search?q=blank")).body).toHaveLength(0);
  });

  it("returns the same record for a duplicate upload and does not process it twice", async () => {
    const s = await scene();
    const a = await s.up(TEXT); await s.queue.idle();
    const b = await s.up(TEXT, { "x-title": "Same file again" });
    expect(b.status).toBe(200); expect(b.body).toMatchObject({ id: a.body.id, duplicate: true, status: "ready" });
    expect(await withTenant(app, s.id, async c => Number((await c.query("SELECT count(*) FROM documents")).rows[0].count))).toBe(1);
  });

  it("keeps institution documents switched off until an operator enables them, and labels them when on", async () => {
    const off = await scene();
    const r = await off.up(TEXT, { "x-data-class": "institution_own" });
    expect(r.status).toBe(403); expect(r.body.message).toMatch(/Public sources only until the NDA/);
    const on = await scene(true);
    const ok = await on.up(TEXT, { "x-data-class": "institution_own", "x-original-agency": "" }); await on.queue.idle();
    expect(ok.status).toBe(202);
    const d = (await on.call("ana", "GET", `/v1/documents/${ok.body.id}`)).body;
    expect((await on.call("ana", "GET", `/v1/evidence/${d.evidence_id}/lineage`)).body.provenance.dataClass).toBe("institution_own");
  });

  it("requires the facts of origin, and refuses bad files and unauthorised people", async () => {
    const s = await scene();
    expect((await s.up(TEXT, { "x-original-agency": "" })).body.message).toMatch(/name the agency/);
    expect((await s.up(TEXT, { "x-rights": "" })).body.message).toMatch(/rights/);
    expect((await s.up(TEXT, { "x-data-class": "licensed_feed" })).status).toBe(422);
    expect((await s.up(Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]))).status).toBe(415);
    expect((await s.up(Buffer.alloc(20 * 1024 * 1024 + 1, 65))).status).toBe(413);
    expect((await s.up(TEXT, {}, "ed")).status).toBe(403);
    expect((await s.call(null, "POST", "/v1/documents", TEXT, { "content-type": "application/octet-stream" })).status).toBe(401);
    expect((await s.call("ed", "GET", "/v1/documents")).status).toBe(200);
    expect((await s.call("ana", "GET", "/v1/documents/search?q=a")).status).toBe(400);
  });

  it("reports a failure in words and allows a retry", async () => {
    const s = await scene();
    const png = T.tesseract ? await fx("ocr-sample.png") : TEXT;
    const r = await s.up(png, { "x-languages": T.tesseract ? "fra" : "eng", "x-filename": "x.png" });
    if (!T.tesseract) return;
    await s.queue.idle();
    expect((await s.call("ana", "GET", `/v1/documents/${r.body.id}`)).body).toMatchObject({ status: "failed", error: expect.stringMatching(/language data not installed/) });
    expect((await s.call("ana", "POST", `/v1/documents/${r.body.id}/retry`)).status).toBe(200);
    await s.queue.idle();
    expect((await s.call("ana", "GET", `/v1/documents/${r.body.id}`)).body.status).toBe("failed");
    const ok = await s.up(TEXT, { "x-title": "fine" }); await s.queue.idle();
    expect((await s.call("ana", "POST", `/v1/documents/${ok.body.id}/retry`)).status).toBe(422);
  });

  it("picks up queued documents after a restart", async () => {
    const s = await scene();
    const r = await withTenant(app, s.id, async c => { const { submitDocument } = await import("../packages/documents/src/index.js"); const me = (await c.query("SELECT id FROM principals LIMIT 1")).rows[0].id; return submitDocument(c, s.id, me, { buffer: TEXT, filename: "n.txt", dataClass: "sample_dataset", rights: "Sample content", clientDataEnabled: false }); });
    const fresh = new DocumentQueue(app, s.id);
    expect(await fresh.resume()).toBe(1); await fresh.idle();
    expect((await s.call("ana", "GET", `/v1/documents/${r.id}`)).body).toMatchObject({ status: "ready", data_class: "sample_dataset" });
  });

  it("lets a document be attached to a case as evidence, shown by its title", async () => {
    const s = await scene();
    const r = await s.up(TEXT); await s.queue.idle();
    const evId = (await s.call("ana", "GET", `/v1/documents/${r.body.id}`)).body.evidence_id;
    const c = await s.call("ana", "POST", "/v1/cases", { title: "Report review", objective: "Use the monthly report", domain: "energy" });
    expect((await s.call("ana", "POST", `/v1/cases/${c.body.id}/evidence`, { evidenceId: evId, role: "supports" })).status).toBe(201);
    expect((await s.call("ana", "GET", `/v1/cases/${c.body.id}`)).body.evidence[0]).toMatchObject({ title: "Monthly report", dataClass: "public_record" });
    expect((await s.call("ana", "GET", "/v1/evidence")).body[0].title).toBe("Monthly report");
  });

  it("keeps documents apart between institutions and immutable in the database", async () => {
    const a = await scene(), b = await scene();
    const r = await a.up(TEXT); await a.queue.idle();
    expect((await b.call("ana", "GET", `/v1/documents/${r.body.id}`)).status).toBe(404);
    expect((await b.call("ana", "GET", "/v1/documents")).body).toEqual([]);
    expect((await b.call("ana", "GET", "/v1/documents/search?q=Kuwait")).body).toEqual([]);
    expect((await b.call("ana", "GET", `/v1/documents/${r.body.id}/file`)).status).toBe(404);
    const attempt = (sql: string) => expect(withTenant(app, a.id, c => c.query(sql))).rejects.toThrow();
    await attempt("UPDATE documents SET title = 'renamed'");
    await attempt("UPDATE documents SET status = 'queued'");
    await attempt("DELETE FROM documents");
    await attempt("UPDATE document_files SET content = '\\x00'");
    await attempt("DELETE FROM document_pages");
    await attempt("UPDATE document_pages SET text = 'edited'");
  });
});
