import { unzipSync } from "fflate";

export type Kind = "pdf" | "image" | "docx" | "text";
export interface Sniffed { kind: Kind; mime: string; ext: string }
export class IntakeError extends Error { constructor(message: string, readonly code: "unsupported" | "too_large" | "invalid" | "forbidden") { super(message); } }

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_UNZIPPED = 60 * 1024 * 1024;
export const MAX_ENTRIES = 2000;

const starts = (b: Buffer, ...sig: number[]) => sig.every((x, i) => b[i] === x);

/** Identifies a file from its content. The file name and the declared type are never trusted. */
export function sniff(buf: Buffer): Sniffed {
  if (buf.length === 0) throw new IntakeError("the file is empty", "invalid");
  if (buf.length > MAX_BYTES) throw new IntakeError(`the file is larger than ${MAX_BYTES / 1024 / 1024} MB`, "too_large");
  if (buf.subarray(0, 1024).includes(Buffer.from("%PDF-")) && buf.subarray(0, 1024).indexOf("%PDF-") < 1024) return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
  if (starts(buf, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", mime: "image/png", ext: "png" };
  if (starts(buf, 0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (starts(buf, 0x49, 0x49, 0x2a, 0x00) || starts(buf, 0x4d, 0x4d, 0x00, 0x2a)) return { kind: "image", mime: "image/tiff", ext: "tif" };
  if (starts(buf, 0x50, 0x4b, 0x03, 0x04)) {
    const files = listZip(buf);
    if (files.includes("word/document.xml") && files.includes("[Content_Types].xml")) return { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
    throw new IntakeError("this archive is not a Word document; archives are not accepted", "unsupported");
  }
  if (starts(buf, 0x4d, 0x5a) || starts(buf, 0x7f, 0x45, 0x4c, 0x46) || starts(buf, 0x23, 0x21)) throw new IntakeError("executable files are not accepted", "unsupported");
  if (isText(buf)) return { kind: "text", mime: "text/plain", ext: "txt" };
  throw new IntakeError("unsupported file type. Accepted: PDF, PNG, JPEG, TIFF, Word (.docx) and plain text.", "unsupported");
}

/** Lists a zip's entries without inflating anything, and refuses archives that look like bombs. */
export function listZip(buf: Buffer): string[] {
  const names: string[] = [];
  let total = 0;
  try {
    unzipSync(new Uint8Array(buf), { filter: f => { names.push(f.name); total += f.originalSize; if (names.length > MAX_ENTRIES || total > MAX_UNZIPPED) throw new IntakeError("the archive is too large to accept", "too_large"); return false; } });
  } catch (e) { if (e instanceof IntakeError) throw e; throw new IntakeError("the file could not be read as a Word document", "invalid"); }
  return names;
}

export function isText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** Dominant script of a text, so the interface can set direction and the record can say what language it holds. */
export function detectLanguage(text: string): "ar" | "en" | "mixed" | "unknown" {
  const ar = (text.match(/[؀-ۿݐ-ݿ]/g) ?? []).length, la = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar + la < 10) return "unknown";
  const share = ar / (ar + la);
  return share > 0.8 ? "ar" : share < 0.1 ? "en" : "mixed";
}
