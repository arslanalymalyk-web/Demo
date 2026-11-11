import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../apps/api/src/server.js";
import { DocumentQueue, stubScanner } from "../packages/documents/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const run = (...a: string[]) => new Promise<{ out: string; code: number | null }>(resolve => execFile("node", ["scripts/acceptance.mjs", ...a], { cwd: new URL("..", import.meta.url).pathname }, (e, out, err) => resolve({ out: out + err, code: e ? (e as { code?: number }).code ?? 1 : 0 })));

suite("the acceptance run", () => {
  let owner: pg.Pool, app: pg.Pool, server: ReturnType<typeof buildServer>, url = "", admin = "", auditor = "", analyst = "";
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! });
    const id = randomUUID(); await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'A')", [id]); });
    admin = await addUser(owner, app, id, "boss", ["administrator"]); auditor = await addUser(owner, app, id, "aud", ["auditor"]); analyst = await addUser(owner, app, id, "ana", ["analyst"]);
    const scanner = stubScanner();
    server = buildServer({ pool: app, institutionId: id, verifier: verifier(), auditAnchorKey: "a".repeat(40), documents: new DocumentQueue(app, id, () => new Date(), scanner), clientDataEnabled: true, scanner });
    await server.listen({ port: 0, host: "127.0.0.1" }); url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await server.close(); await owner.end(); await app.end(); });

  it("checks what it can, leaves manual items open, and never says accepted while any is open", async () => {
    const out = mkdtempSync(join(tmpdir(), "tigeris-acc-"));
    const r = await run("--api", url, "--token", admin, "--auditor-token", auditor, "--out", out, "--environment", "test run");
    expect(r.out).toMatch(/PASS  The API answers and is ready/); expect(r.out).toMatch(/PASS  The audit chain verifies/); expect(r.out).toMatch(/PASS  A signed checkpoint can be taken and verified/);
    expect(r.out).toMatch(/FAIL  The token carries a multi-factor claim|PASS  The token carries a multi-factor claim/); // depends on the test token's claim
    expect(r.out).toMatch(/OPEN  Independent penetration test report/); expect(r.out).toMatch(/SKIP  The malware scanner/);
    const rep = JSON.parse(readFileSync(join(out, "acceptance-report.json"), "utf8"));
    expect(rep.verdict).not.toBe("ACCEPTED"); expect(rep.counts.OPEN).toBe(7); expect(rep.environment).toBe("test run");
    expect(readFileSync(join(out, "acceptance-report.md"), "utf8")).toMatch(/Result: \*\*(INCOMPLETE|NOT ACCEPTED)\*\*/);
  }, 60_000);

  it("records evidence files by hash, flags a failing readiness item, and uses the scanner when asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tigeris-acc-")), ev = join(dir, "pentest.txt"); writeFileSync(ev, "report text");
    const r = await run("--api", url, "--token", admin, "--auditor-token", auditor, "--analyst-token", analyst, "--eicar", "--evidence", `pentest=${ev}`, "--evidence", `egress=${join(dir, "missing.txt")}`, "--out", join(dir, "out"));
    expect(r.out).toMatch(/PASS  Independent penetration test report - evidence .*pentest.txt sha256 [0-9a-f]{16}/);
    expect(r.out).toMatch(/FAIL  Egress boundary proven.*cannot read/); expect(r.code).toBe(1);
    expect(r.out).toMatch(/PASS  The malware scanner flagged the anti-virus test string/);
    const rep = JSON.parse(readFileSync(join(dir, "out", "acceptance-report.json"), "utf8"));
    expect(rep.results.find((x: { id: string }) => x.id === "manual.pentest").evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.verdict).toBe("NOT ACCEPTED");
  }, 60_000);

  it("fails clearly when nothing answers", async () => {
    const r = await run("--api", "http://127.0.0.1:9", "--out", mkdtempSync(join(tmpdir(), "tigeris-acc-")));
    expect(r.code).toBe(1); expect(r.out).toMatch(/FAIL  The API answers and is ready/);
  }, 60_000);
});
