import { unzipSync, strFromU8 } from "fflate";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { IntakeError, detectLanguage, sniff, type Kind } from "./sniff.js";
import { exec, readFile, readdir, sandboxDir, tools, writeInput } from "./tools.js";

export type Method = "text-layer" | "ocr" | "plain" | "docx";
export interface ExtractedPage { pageNo: number; method: Method; text: string; confidence: number | null }
export interface Extraction {
  kind: Kind; mime: string; pages: ExtractedPage[]; language: "ar" | "en" | "mixed" | "unknown"; ocrUsed: boolean; avgConfidence: number | null; created: string | null;
  engine: { pdftotext: string | null; tesseract: string | null; languages: string };
}
export const MAX_PAGES = 100;
const OCR_MIN_CHARS = 25;
const clean = (s: string): string => s.normalize("NFC").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
const LANG = /^[a-z]{3}(\+[a-z]{3}){0,2}$/;

/** OCR one image file. Returns text and the mean word confidence (0 to 100) from Tesseract's own scores. */
async function ocrImage(dir: string, file: string, languages: string): Promise<{ text: string; confidence: number | null }> {
  const base = join(dir, `ocr-${createHash("sha1").update(file).digest("hex").slice(0, 8)}`);
  await exec("tesseract", [file, base, "-l", languages, "--psm", "3", "txt", "tsv"], dir, 180_000);
  const text = clean(await readFile(`${base}.txt`, "utf8"));
  const confs = (await readFile(`${base}.tsv`, "utf8")).split("\n").slice(1).map(l => l.split("\t")).filter(c => c.length >= 12 && Number(c[10]) >= 0 && (c[11] ?? "").trim() !== "").map(c => Number(c[10]));
  return { text, confidence: confs.length ? confs.reduce((a, x) => a + x, 0) / confs.length : null };
}

async function needOcr(languages: string): Promise<void> {
  const t = await tools();
  if (!t.tesseract) throw new IntakeError("OCR is not available on this deployment", "unsupported");
  const missing = languages.split("+").filter(l => !t.languages.includes(l));
  if (missing.length) throw new IntakeError(`OCR language data not installed: ${missing.join(", ")}`, "unsupported");
}

async function pdf(buf: Buffer, languages: string): Promise<{ pages: ExtractedPage[]; created: string | null }> {
  return sandboxDir(async dir => {
    const file = await writeInput(dir, "in.pdf", buf);
    let info: string;
    try { info = (await exec("pdfinfo", [file], dir, 30_000)).stdout; } catch { throw new IntakeError("the PDF could not be read (damaged or encrypted)", "invalid"); }
    const n = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
    if (!n) throw new IntakeError("the PDF has no pages", "invalid");
    if (n > MAX_PAGES) throw new IntakeError(`the PDF has ${n} pages; the limit is ${MAX_PAGES}`, "too_large");
    const cd = /^CreationDate:\s+(.+)$/m.exec(info)?.[1];
    const created = cd && !Number.isNaN(Date.parse(cd)) ? new Date(cd).toISOString() : null;
    const layer = (await exec("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], dir, 120_000)).stdout.split("\f");
    const pages: ExtractedPage[] = [];
    for (let i = 1; i <= n; i++) {
      const t = clean(layer[i - 1] ?? "");
      if (t.length >= OCR_MIN_CHARS) { pages.push({ pageNo: i, method: "text-layer", text: t, confidence: null }); continue; }
      // No usable text layer: render the page and recognise it.
      await needOcr(languages);
      await exec("pdftoppm", ["-r", "200", "-f", String(i), "-l", String(i), "-png", file, join(dir, `p${i}`)], dir, 120_000);
      const img = (await readdir(dir)).find(f => f.startsWith(`p${i}-`) && f.endsWith(".png"));
      if (!img) { pages.push({ pageNo: i, method: "ocr", text: "", confidence: null }); continue; }
      const o = await ocrImage(dir, join(dir, img), languages);
      pages.push({ pageNo: i, method: "ocr", text: o.text, confidence: o.confidence });
    }
    return { pages, created };
  });
}

function docxText(buf: Buffer): ExtractedPage[] {
  const files = unzipSync(new Uint8Array(buf), { filter: f => f.name === "word/document.xml" && f.originalSize < 40 * 1024 * 1024 });
  const xml = files["word/document.xml"];
  if (!xml) throw new IntakeError("the Word document has no body", "invalid");
  const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const doc = strFromU8(xml);
  const pages = doc.split(/<w:br [^>]*w:type="page"[^>]*\/>|<w:lastRenderedPageBreak\/>/);
  return pages.map((p, i) => ({ pageNo: i + 1, method: "docx" as const, confidence: null,
    text: clean(p.split(/<\/w:p>/).map(par => unesc([...par.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map(m => m[1] ?? "\t").join(""))).join("\n")) })).filter(p => p.text.length > 0 || pages.length === 1);
}

/** Extracts text from a document with deterministic tools only. No model reads or rewrites the content. */
export async function extract(buf: Buffer, opts: { languages?: string } = {}): Promise<Extraction> {
  const s = sniff(buf), languages = opts.languages ?? "eng";
  if (!LANG.test(languages)) throw new IntakeError("invalid OCR language selection", "invalid");
  let pages: ExtractedPage[] = [], created: string | null = null;
  if (s.kind === "pdf") ({ pages, created } = await pdf(buf, languages));
  else if (s.kind === "docx") pages = docxText(buf);
  else if (s.kind === "text") pages = [{ pageNo: 1, method: "plain", text: clean(buf.toString("utf8")), confidence: null }];
  else {
    await needOcr(languages);
    pages = await sandboxDir(async dir => { const o = await ocrImage(dir, await writeInput(dir, `in.${s.ext}`, buf), languages); return [{ pageNo: 1, method: "ocr" as const, text: o.text, confidence: o.confidence }]; });
  }
  const conf = pages.filter(p => p.confidence !== null).map(p => p.confidence as number);
  const t = await tools();
  return { kind: s.kind, mime: s.mime, pages, language: detectLanguage(pages.map(p => p.text).join("\n")), ocrUsed: pages.some(p => p.method === "ocr"), avgConfidence: conf.length ? conf.reduce((a, x) => a + x, 0) / conf.length : null, created,
    engine: { pdftotext: t.pdftotext, tesseract: t.tesseract, languages } };
}
