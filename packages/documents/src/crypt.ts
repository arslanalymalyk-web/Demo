import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/** Application-level sealing of document contents, with a key the database never holds.
 *  Files and page text are sealed with AES-256-GCM, each bound to its own row so a sealed value cannot be moved to another document or page.
 *  Search runs over keyed word tokens (an HMAC of each word) instead of over the text: the database can see that two pages share a word and how often, never the word. */
export class DocumentKeyError extends Error {}
const MAGIC = Buffer.from("TGE1");
export const MIN_DOCUMENT_KEY_LENGTH = 32;

interface Keys { id: Buffer; enc: Buffer; index: Buffer }
const derive = (master: string): Keys => ({
  id: createHash("sha256").update(`tigeris-document-key-id|${master}`).digest().subarray(0, 4),
  enc: Buffer.from(hkdfSync("sha256", master, "tigeris-documents", "seal", 32)),
  index: Buffer.from(hkdfSync("sha256", master, "tigeris-documents", "word-index", 32)),
});

export class DocumentCrypto {
  private current: Keys; private all: Keys[];
  /** `current` seals everything new. `previous` keys only open what they sealed, so a key can be replaced without losing old documents. */
  constructor(current: string, previous: string[] = []) {
    for (const k of [current, ...previous]) if (k.length < MIN_DOCUMENT_KEY_LENGTH) throw new DocumentKeyError(`a document key must be at least ${MIN_DOCUMENT_KEY_LENGTH} characters`);
    this.current = derive(current); this.all = [this.current, ...previous.map(derive)];
  }
  static isSealed(b: Buffer): boolean { return b.length > 4 + 4 + 12 + 16 && b.subarray(0, 4).equals(MAGIC); }
  /** The value stored in place of the plain one. `where` names the row it belongs to. */
  seal(plain: Buffer, where: string): Buffer {
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.current.enc, iv); c.setAAD(Buffer.from(where));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([MAGIC, this.current.id, iv, ct, c.getAuthTag()]);
  }
  open(sealed: Buffer, where: string): Buffer {
    if (!DocumentCrypto.isSealed(sealed)) throw new DocumentKeyError("the stored value is not sealed");
    const id = sealed.subarray(4, 8), k = this.all.find(x => x.id.equals(id));
    if (!k) throw new DocumentKeyError("this value was sealed with a key that is not configured; set the previous key");
    const iv = sealed.subarray(8, 20), tag = sealed.subarray(sealed.length - 16), ct = sealed.subarray(20, sealed.length - 16);
    try { const d = createDecipheriv("aes-256-gcm", k.enc, iv); d.setAAD(Buffer.from(where)); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]); }
    catch { throw new DocumentKeyError("the stored value failed its integrity check; it was changed or moved"); }
  }
  /** Keyed tokens for the words of a text, with how often each occurs. */
  terms(text: string): Map<string, { token: Buffer; freq: number }> {
    const out = new Map<string, { token: Buffer; freq: number }>();
    for (const w of words(text)) { const e = out.get(w); if (e) e.freq++; else if (out.size < 5000) out.set(w, { token: this.token(this.current, w), freq: 1 }); }
    return out;
  }
  /** Every token a word could have been stored under, one per configured key. */
  tokensFor(word: string): Buffer[] { return this.all.map(k => this.token(k, word)); }
  private token(k: Keys, word: string): Buffer { return createHmac("sha256", k.index).update(word).digest().subarray(0, 16); }
}

/** Lower-cased words of letters and digits, in any script. */
export const words = (text: string): string[] => (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);

let active: DocumentCrypto | null = null;
export const useDocumentCrypto = (c: DocumentCrypto | null): void => { active = c; };
export const documentCrypto = (): DocumentCrypto | null => active;
