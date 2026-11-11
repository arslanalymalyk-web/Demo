import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../apps/api/src/config.js";
import { DocumentCrypto, DocumentKeyError, DocumentQueue, downloadDocument, getPage, searchDocuments, stubScanner, submitDocument, useDocumentCrypto, words } from "../packages/documents/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser } from "./helpers/auth.js";

const KEY = "k1-".repeat(14), OLD = "old-key-".repeat(5);

describe("sealing", () => {
  const c = new DocumentCrypto(KEY, [OLD]);
  it("round-trips, binds a value to its row, and fails closed", () => {
    const sealed = c.seal(Buffer.from("secret text"), "inst|doc|file");
    expect(DocumentCrypto.isSealed(sealed)).toBe(true); expect(sealed.includes(Buffer.from("secret"))).toBe(false);
    expect(c.open(sealed, "inst|doc|file").toString()).toBe("secret text");
    expect(() => c.open(sealed, "inst|other|file")).toThrow(/integrity check/);
    const flipped = Buffer.from(sealed); flipped[flipped.length - 20]! ^= 1;
    expect(() => c.open(flipped, "inst|doc|file")).toThrow(DocumentKeyError);
    expect(() => new DocumentCrypto(KEY.replace(/k1-/g, "zz-")).open(sealed, "inst|doc|file")).toThrow(/not configured/);
    expect(c.seal(Buffer.from("x"), "w").equals(c.seal(Buffer.from("x"), "w"))).toBe(false); // a fresh nonce every time
  });
  it("opens what an earlier key sealed, and refuses a short key", () => {
    const old = new DocumentCrypto(OLD).seal(Buffer.from("older"), "w");
    expect(c.open(old, "w").toString()).toBe("older");
    expect(() => new DocumentCrypto("short")).toThrow(/at least 32/);
  });
  it("makes keyed tokens that depend on the key and hide the word", () => {
    const t = c.terms("Brent crude, brent CRUDE. تقرير شهري");
    expect([...t.keys()].sort()).toEqual(["brent", "crude", "تقرير", "شهري"]);
    expect(t.get("brent")!.freq).toBe(2); expect(t.get("brent")!.token.length).toBe(16);
    expect(new DocumentCrypto("another-key-".repeat(4)).terms("brent").get("brent")!.token.equals(t.get("brent")!.token)).toBe(false);
    expect(c.tokensFor("brent")).toHaveLength(2); expect(words("a bc 1 22")).toEqual(["bc", "22"]);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("sealed documents against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });
  afterEach(() => useDocumentCrypto(null));

  async function scene() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'D')", [id]); });
    await addUser(owner, app, id, "ana", ["analyst"]);
    const me = await withTenant(app, id, async c => (await c.query("SELECT id FROM principals LIMIT 1")).rows[0].id as string);
    const queue = new DocumentQueue(app, id, () => new Date("2026-11-10T00:00:00Z"), stubScanner());
    const add = async (text: string, title: string) => { const r = await withTenant(app, id, c => submitDocument(c, id, me, { buffer: Buffer.from(text, "utf8"), filename: `${title}.txt`, title, dataClass: "public_record", originalAgency: "Example Agency", rights: "Public record, no restriction", clientDataEnabled: true } as never)); queue.enqueue(r.id); await queue.idle(); return r.id; };
    const raw = (doc: string) => withTenant(owner, id, async c => ({
      file: (await c.query("SELECT content FROM document_files WHERE document_id = $1", [doc])).rows[0].content as Buffer,
      pages: (await c.query("SELECT page_no, text, text_enc FROM document_pages WHERE document_id = $1 ORDER BY page_no", [doc])).rows,
      terms: (await c.query("SELECT term FROM document_terms WHERE document_id = $1", [doc])).rows.map(r => r.term as Buffer),
    }));
    const search = (q: string) => withTenant(app, id, c => searchDocuments(c, q)) as Promise<{ id: string; title: string; snippet: string; rank: number }[]>;
    return { id, me, add, raw, search };
  }
  const BODY = "Brent crude averaged 103.8 dollars per barrel in May. Kuwait exports fell sharply. تقرير شهري";

  it("keeps the file and the page text out of the database in readable form, yet reads and searches them", async () => {
    useDocumentCrypto(new DocumentCrypto(KEY));
    const s = await scene(), a = await s.add(BODY, "Monthly report"), b = await s.add("Kuwait reserves are steady. Nothing about prices.", "Reserves note");
    const r = await s.raw(a);
    expect(DocumentCrypto.isSealed(r.file)).toBe(true); expect(r.file.includes(Buffer.from("Brent"))).toBe(false);
    expect(r.pages[0].text).toBe(""); expect(Buffer.isBuffer(r.pages[0].text_enc) && r.pages[0].text_enc.includes(Buffer.from("Brent"))).toBe(false);
    expect(r.terms.length).toBeGreaterThan(8); expect(r.terms.every(t => t.length === 16)).toBe(true);
    expect(await withTenant(app, s.id, c => getPage(c, a, 1))).toMatchObject({ page_no: 1, text: BODY });
    expect((await withTenant(app, s.id, c => downloadDocument(c, s.id, s.me, a)))!.content.toString("utf8")).toBe(BODY);
    // search: every word must be present; Arabic works; the snippet comes from the decrypted page
    expect((await s.search("kuwait")).map(x => x.title).sort()).toEqual(["Monthly report", "Reserves note"]);
    const both = await s.search("Brent Kuwait"); expect(both.map(x => x.title)).toEqual(["Monthly report"]); expect(both[0]!.snippet).toMatch(/⟦Brent⟧/);
    expect((await s.search("brent prices")).length).toBe(0);
    expect((await s.search("شهري")).map(x => x.title)).toEqual(["Monthly report"]);
    expect((await s.search("nonexistent")).length).toBe(0);
    void b;
  });

  it("reads documents stored before sealing was switched on, and finds them", async () => {
    const s = await scene(), a = await s.add(BODY, "Plain one");
    useDocumentCrypto(new DocumentCrypto(KEY));
    const b = await s.add("Plain and sealed both mention Brent.", "Sealed one");
    expect(DocumentCrypto.isSealed((await s.raw(a)).file)).toBe(false); expect(DocumentCrypto.isSealed((await s.raw(b)).file)).toBe(true);
    expect((await withTenant(app, s.id, c => getPage(c, a, 1)))!.text).toBe(BODY);
    expect((await s.search("brent")).map(x => x.title).sort()).toEqual(["Plain one", "Sealed one"]);
  });

  it("fails closed when the key is missing or wrong, and reads old documents after a key is replaced", async () => {
    useDocumentCrypto(new DocumentCrypto(OLD));
    const s = await scene(), a = await s.add(BODY, "Sealed with the old key");
    useDocumentCrypto(null);
    await expect(withTenant(app, s.id, c => getPage(c, a, 1))).rejects.toThrow(/no document key is configured/);
    useDocumentCrypto(new DocumentCrypto(KEY));
    await expect(withTenant(app, s.id, c => getPage(c, a, 1))).rejects.toThrow(/not configured/);
    useDocumentCrypto(new DocumentCrypto(KEY, [OLD]));
    expect((await withTenant(app, s.id, c => getPage(c, a, 1)))!.text).toBe(BODY);
    expect((await s.search("brent")).map(x => x.title)).toEqual(["Sealed with the old key"]); // found through the old key's tokens
  });

  it("refuses a sealed page that was moved to another document", async () => {
    useDocumentCrypto(new DocumentCrypto(KEY));
    const s = await scene(), a = await s.add(BODY, "A"), b = await s.add("Another body of text entirely.", "B");
    await withTenant(owner, s.id, async c => {
      await c.query("ALTER TABLE document_pages DISABLE TRIGGER USER");
      const enc = (await c.query("SELECT text_enc FROM document_pages WHERE document_id = $1", [a])).rows[0].text_enc;
      await c.query("UPDATE document_pages SET text_enc = $2 WHERE document_id = $1", [b, enc]);
      await c.query("ALTER TABLE document_pages ENABLE TRIGGER USER");
    });
    await expect(withTenant(app, s.id, c => getPage(c, b, 1))).rejects.toThrow(/integrity check/);
  });

  it("is configured from the environment and required for institution documents in production", () => {
    const base = { DATABASE_URL: "postgres://u:Strong-passw0rd-xyz@h/d", TIGERIS_INSTITUTION_ID: randomUUID(), OIDC_ISSUER: "https://i.example", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://i.example/jwks" };
    expect(loadConfig({ ...base }).documentKeys).toBeNull();
    expect(loadConfig({ ...base, TIGERIS_DOCUMENT_KEY: KEY, TIGERIS_DOCUMENT_KEY_PREVIOUS: `${OLD}, ${OLD}x` }).documentKeys).toEqual({ current: KEY, previous: [OLD, `${OLD}x`] });
    expect(() => loadConfig({ ...base, TIGERIS_DOCUMENT_KEY: "short" })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...base, TIGERIS_DOCUMENT_KEY_PREVIOUS: OLD })).toThrow(/needs TIGERIS_DOCUMENT_KEY/);
    expect(() => loadConfig({ ...base, TIGERIS_ENV: "production", TIGERIS_CLIENT_DATA_ENABLED: "true", TIGERIS_CLIENT_DATA_REVIEW_DONE: "true" })).toThrow(/TIGERIS_DOCUMENT_KEY is not set/);
  });
});
