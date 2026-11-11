import net from "node:net";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../apps/api/src/config.js";
import { buildServer } from "../apps/api/src/server.js";
import { AlertRunner, MailError, createMailer, desiredConditions, render, type Mail, type Mailer } from "../packages/alerts/src/index.js";
import { installationReadiness } from "../packages/setup/src/index.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { addUser, verifier } from "./helpers/auth.js";

const BASE = "https://tigeris.client.example";
const stripLinks = (t: string) => t.split("\n").filter(l => !/Open TIGERIS:|افتح TIGERIS:|Reference:|المرجع:/.test(l)).join("\n");

describe("the message", () => {
  it("is fixed text with a category, a link and a reference, and nothing from the records", () => {
    for (const category of ["malware", "source", "review", "operations"] as const) for (const kind of ["raised", "reminder", "resolved", "test"] as const) {
      const m = render({ category, kind, ref: "CASE-0004", link: "/#/cases/abc", baseUrl: BASE });
      expect(m.subject).toMatch(/^\[TIGERIS\] /);
      expect(m.text).toContain(`${BASE}/#/cases/abc`);
      expect(m.text).toContain("Reference: CASE-0004");
      expect(m.text).toMatch(/[؀-ۿ]/); // the Arabic half
      expect(stripLinks(m.text), `${category}/${kind}`).not.toMatch(/[0-9{}]/); // no figures, no unfilled placeholders
      expect(m.text).toContain("contains no data from the stored records");
    }
    expect(render({ category: "source", kind: "reminder", baseUrl: BASE }).subject).toBe("[TIGERIS] Reminder: A data source needs attention");
    expect(render({ category: "review", kind: "resolved", baseUrl: BASE }).subject).toMatch(/^\[TIGERIS\] Resolved: /);
  });
  it("refuses a reference or a link that is not plain", () => {
    expect(() => render({ category: "review", kind: "raised", ref: "CASE-1\nBcc: x@y.z", baseUrl: BASE })).toThrow();
    expect(() => render({ category: "review", kind: "raised", ref: "case 1", baseUrl: BASE })).toThrow();
    expect(() => render({ category: "review", kind: "raised", link: "https://evil.example/", baseUrl: BASE })).toThrow();
    expect(() => render({ category: "review", kind: "raised", link: "/#/cases/../../x?a=b", baseUrl: BASE })).toThrow();
  });
});

/** A stand-in relay that speaks enough SMTP to receive a message, so the real mail library is tested end to end. */
function fakeRelay(rcpt: (to: string) => string = () => "250 ok") {
  const got: { from: string; to: string[]; data: string }[] = [];
  const server = net.createServer(sock => {
    let buf = "", cur: { from: string; to: string[]; data: string } | null = null, inData = false;
    const say = (s: string) => sock.write(s + "\r\n");
    say("220 relay ready");
    sock.on("data", d => {
      buf += d.toString("utf8");
      for (;;) {
        if (inData) { const i = buf.indexOf("\r\n.\r\n"); if (i < 0) return; cur!.data = buf.slice(0, i); buf = buf.slice(i + 5); inData = false; got.push(cur!); cur = null; say("250 queued"); continue; }
        const i = buf.indexOf("\r\n"); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO|^HELO/i.test(line)) say("250 relay");
        else if (/^MAIL FROM:/i.test(line)) { cur = { from: line.slice(10).replace(/[<>]/g, ""), to: [], data: "" }; say("250 ok"); }
        else if (/^RCPT TO:/i.test(line)) { const to = line.slice(8).replace(/[<>]/g, ""), r = rcpt(to); if (r.startsWith("250")) cur!.to.push(to); say(r); }
        else if (/^DATA/i.test(line)) { inData = true; say("354 go"); }
        else if (/^QUIT/i.test(line)) { say("221 bye"); sock.end(); }
        else if (/^RSET/i.test(line)) say("250 ok");
        else say("250 ok");
      }
    });
    sock.on("error", () => undefined);
  });
  return new Promise<{ port: number; got: typeof got; close: () => Promise<void> }>(res => server.listen(0, "127.0.0.1", () => res({ port: (server.address() as net.AddressInfo).port, got, close: () => new Promise(r => server.close(() => r())) })));
}
const smtp = (port: number) => createMailer({ transport: "smtp", host: "127.0.0.1", port, security: "none", from: "TIGERIS <alerts@client.example>", production: false, timeoutMs: 3000 });

describe("the mail relay", () => {
  it("delivers a plain-text message to one person with the category in a header", async () => {
    const r = await fakeRelay();
    const out = await smtp(r.port).send({ to: "ana@client.example", subject: "[TIGERIS] A decision is waiting for you", text: render({ category: "review", kind: "raised", ref: "CASE-0004", link: "/#/cases/x", baseUrl: BASE }).text, category: "review" });
    expect(out.messageId).toMatch(/^<.+>$/);
    expect(r.got).toHaveLength(1);
    expect(r.got[0]).toMatchObject({ from: "alerts@client.example", to: ["ana@client.example"] });
    expect(r.got[0]!.data).toMatch(/X-TIGERIS-Category: review/i);
    expect(r.got[0]!.data).toMatch(/Content-Type: text\/plain/);
    expect(r.got[0]!.data).not.toMatch(/Content-Type: multipart|text\/html/);
    expect(r.got[0]!.data).toContain(`${BASE}/#/cases/x`);
    await r.close();
  });
  it("says what failed without repeating the relay's words", async () => {
    const perm = await fakeRelay(() => "550 mailbox secret-detail unavailable");
    const e1 = await smtp(perm.port).send({ to: "a@client.example", subject: "s", text: "t", category: "x" }).catch(e => e as MailError);
    expect(e1).toBeInstanceOf(MailError); expect((e1 as MailError).transient).toBe(false);
    expect((e1 as MailError).message).toBe("the mail relay rejected the message (code 550)");
    expect((e1 as MailError).message).not.toMatch(/secret/);
    await perm.close();
    const temp = await fakeRelay(() => "451 try later");
    const e2 = await smtp(temp.port).send({ to: "a@client.example", subject: "s", text: "t", category: "x" }).catch(e => e as MailError);
    expect((e2 as MailError).transient).toBe(true);
    await temp.close();
    const e3 = await smtp(1).send({ to: "a@client.example", subject: "s", text: "t", category: "x" }).catch(e => e as MailError);
    expect((e3 as MailError).message).toBe("the mail relay could not be reached"); expect((e3 as MailError).transient).toBe(true);
  });
  it("refuses an address or subject that could carry another header, and refuses weak settings in production", async () => {
    const m = smtp(1);
    await expect(m.send({ to: "a@b.example\r\nBcc: x@y.example", subject: "s", text: "t", category: "x" })).rejects.toThrow(/not accepted/);
    await expect(m.send({ to: "a@b.example", subject: "s\nX: y", text: "t", category: "x" })).rejects.toThrow(/not accepted/);
    expect(() => createMailer({ transport: "smtp", host: "h", port: 25, security: "none", from: "a@b.example", production: true })).toThrow(/TLS/);
    expect(() => createMailer({ transport: "log", host: "", port: 0, security: "none", from: "a@b.example", production: true })).toThrow(/real mail relay/);
    expect((await createMailer({ transport: "log", host: "", port: 0, security: "none", from: "a@b.example", production: false }).send({ to: "a@b.example", subject: "s", text: "t", category: "x" })).messageId).toBeTruthy();
  });
});

describe("alert configuration", () => {
  const base = { DATABASE_URL: "postgres://u:p@h/d", TIGERIS_INSTITUTION_ID: randomUUID(), OIDC_ISSUER: "https://idp.example", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://idp.example/keys" };
  it("is off by default and needs a relay, a sender and a web address when on", () => {
    expect(loadConfig({ ...base }).alerts.enabled).toBe(false);
    expect(() => loadConfig({ ...base, TIGERIS_ALERTS_ENABLED: "true" })).toThrow(/TIGERIS_SMTP_HOST[\s\S]*TIGERIS_ALERTS_FROM[\s\S]*TIGERIS_WEB_BASE_URL/);
    const ok = loadConfig({ ...base, TIGERIS_ALERTS_ENABLED: "true", TIGERIS_SMTP_HOST: "relay.client.example", TIGERIS_ALERTS_FROM: "TIGERIS <alerts@client.example>", TIGERIS_WEB_BASE_URL: BASE });
    expect(ok.alerts).toMatchObject({ transport: "smtp", port: 587, security: "starttls", reminderHours: 24, maxPerHour: 120 });
    expect(() => loadConfig({ ...base, TIGERIS_ALERTS_ENABLED: "true", TIGERIS_SMTP_HOST: "r", TIGERIS_ALERTS_FROM: "not an address", TIGERIS_WEB_BASE_URL: BASE })).toThrow(/TIGERIS_ALERTS_FROM/);
    expect(() => loadConfig({ ...base, TIGERIS_ALERTS_ENABLED: "true", TIGERIS_SMTP_HOST: "r", TIGERIS_ALERTS_FROM: "a@b.example", TIGERIS_WEB_BASE_URL: BASE, TIGERIS_ALERTS_REMINDER_HOURS: "0" })).toThrow(/REMINDER_HOURS/);
  });
  it("refuses an unencrypted relay, the log transport and a plain-http link in production", () => {
    const prod = { ...base, TIGERIS_ENV: "production", DATABASE_URL: "postgres://u:a-long-strong-pass@h/d", TIGERIS_ALERTS_ENABLED: "true", TIGERIS_SMTP_HOST: "r", TIGERIS_ALERTS_FROM: "a@b.example", TIGERIS_WEB_BASE_URL: BASE };
    expect(loadConfig(prod).alerts.security).toBe("starttls");
    expect(() => loadConfig({ ...prod, TIGERIS_SMTP_SECURITY: "none" })).toThrow(/over TLS/);
    expect(() => loadConfig({ ...prod, TIGERIS_ALERTS_TRANSPORT: "log" })).toThrow(/not delivery/);
    expect(() => loadConfig({ ...prod, TIGERIS_WEB_BASE_URL: "http://tigeris.client.example" })).toThrow(/https/);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;
const T0 = new Date("2026-11-10T00:00:00Z"), HOUR = 3_600_000;
const at = (h: number) => new Date(T0.getTime() + h * HOUR);

suite("alerts against a real database", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  /** A mailer that records and can be told to fail. */
  const capture = () => { const sent: Mail[] = [], st = { fail: null as MailError | null, calls: 0 }; const m: Mailer = { transport: "smtp", async send(x) { st.calls++; if (st.fail) throw st.fail; sent.push(x); return { messageId: `<${st.calls}@test>` }; }, async verify() { /* ok */ } }; return { m, sent, st }; };
  async function world() {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'A')", [id]); });
    const tokens = { adm: await addUser(owner, app, id, "adm", ["administrator"]), aud: await addUser(owner, app, id, "aud", ["auditor"]), rev: await addUser(owner, app, id, "rev", ["approver"]), ana: await addUser(owner, app, id, "ana", ["analyst"]), ops: await addUser(owner, app, id, "ops", ["operations"]) };
    const pid = (sub: string) => withTenant(app, id, async c => (await c.query("SELECT id FROM principals WHERE idp_subject = $1", [sub])).rows[0].id as string);
    const ids = { adm: await pid("adm"), aud: await pid("aud"), rev: await pid("rev"), ana: await pid("ana") };
    for (const [k, e] of [["adm", "adm@client.example"], ["aud", "aud@client.example"], ["rev", "rev@client.example"]] as const) await withTenant(app, id, c => c.query("UPDATE principals SET email = $2 WHERE id = $1", [ids[k], e]));
    return { id, tokens, ids };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const runner = (w: W, m: Mailer, clock: { t: Date }, extra: Partial<ConstructorParameters<typeof AlertRunner>[0]> = {}) => new AlertRunner({ pool: app, institutionId: w.id, mailer: m, baseUrl: BASE, engine: { reminderHours: 24, maxPerHour: 100 }, now: () => clock.t, ...extra });
  const rows = (w: W, sql: string) => withTenant(app, w.id, async c => (await c.query(sql)).rows);
  const infected = (w: W, scannedAt: Date) => withTenant(owner, w.id, async c => (await c.query(`INSERT INTO documents (institution_id, title, filename, mime, size_bytes, sha256, data_class, rights_statement, uploaded_by, status, scan_status, scan_signature, scanned_at) VALUES ($1,'t','f.txt','text/plain',1,$2,'sample_dataset','r',$3,'quarantined','infected','Test.Sig',$4) RETURNING id`, [w.id, randomUUID().replace(/-/g, "").repeat(2), w.ids.ana, scannedAt.toISOString()])).rows[0].id as string);
  const caseInReview = async (w: W) => withTenant(app, w.id, async c => { const { createCase } = await import("../packages/cases/src/index.js"); const k = await createCase(c, w.id, { id: w.ids.ana, roles: ["analyst"] }, { title: "A case for the alert test", objective: "Decide whether this needs a response.", domain: "energy" }); await c.query("UPDATE cases SET state = 'in_review', reviewer_id = $2 WHERE id = $1", [k.id, w.ids.rev]); return k; });

  it("tells administrators and auditors once about a flagged file, and nobody else", async () => {
    const w = await world(), cap = capture(), clock = { t: T0 };
    await infected(w, T0);
    const r = runner(w, cap.m, clock);
    expect(await r.tick()).toMatchObject({ planned: 1, sent: 2 });
    expect(cap.sent.map(x => x.to).sort()).toEqual(["adm@client.example", "aud@client.example"]);
    expect(cap.sent[0]!.subject).toBe("[TIGERIS] A file was flagged by the malware scanner");
    expect(cap.sent[0]!.text).toMatch(/Reference: DOC-[0-9A-F]{8}/);
    clock.t = at(48); expect(await r.tick()).toMatchObject({ planned: 0 });
    expect(cap.sent).toHaveLength(2);
  });
  it("ignores a flag that is more than a week old, so switching alerts on does not replay history", async () => {
    const w = await world(), cap = capture();
    await infected(w, new Date(T0.getTime() - 8 * 24 * HOUR));
    expect(await runner(w, cap.m, { t: T0 }).tick()).toMatchObject({ planned: 0 });
    expect(cap.sent).toHaveLength(0);
  });

  it("tells the reviewer, reminds after a day and not before, and says so once when it clears", async () => {
    const w = await world(), cap = capture(), clock = { t: T0 }, r = runner(w, cap.m, clock);
    const k = await caseInReview(w);
    await r.tick();
    expect(cap.sent.map(x => `${x.to}|${x.subject}`)).toEqual(["rev@client.example|[TIGERIS] A decision is waiting for you"]);
    expect(cap.sent[0]!.text).toContain(`Reference: ${k.caseKey}`);
    clock.t = at(23); await r.tick(); expect(cap.sent).toHaveLength(1);
    clock.t = at(25); await r.tick(); expect(cap.sent[1]!.subject).toBe("[TIGERIS] Reminder: A decision is waiting for you");
    clock.t = at(26); await r.tick(); expect(cap.sent).toHaveLength(2);
    await withTenant(app, w.id, c => c.query("UPDATE cases SET state = 'decided' WHERE id = $1", [k.id]));
    clock.t = at(27); await r.tick(); expect(cap.sent[2]!.subject).toBe("[TIGERIS] Resolved: A decision is waiting for you");
    clock.t = at(80); await r.tick(); expect(cap.sent).toHaveLength(3);
    expect((await rows(w, "SELECT kind FROM alert_deliveries WHERE status = 'sent' ORDER BY created_at, id")).map(x => x.kind)).toEqual(["raised", "reminder", "resolved"]);
  });
  it("honours a person's choice to switch off the categories that are not security notices", async () => {
    const w = await world(), cap = capture(), r = runner(w, cap.m, { t: T0 });
    await caseInReview(w);
    await withTenant(app, w.id, c => c.query("INSERT INTO alert_preferences (institution_id, principal_id, category, enabled) VALUES ($1,$2,'review',false)", [w.id, w.ids.rev]));
    expect(await r.tick()).toMatchObject({ planned: 1, sent: 0 });
    expect(await rows(w, "SELECT status, reason FROM alert_deliveries")).toEqual([{ status: "skipped", reason: "switched off by the person" }]);
    await expect(withTenant(app, w.id, c => c.query("INSERT INTO alert_preferences (institution_id, principal_id, category, enabled) VALUES ($1,$2,'malware',false)", [w.id, w.ids.adm]))).rejects.toThrow();
  });
  it("tells administrators when a scanner goes down and again when it comes back", async () => {
    const w = await world(), cap = capture(), clock = { t: T0 }; let up = false;
    const r = runner(w, cap.m, clock, { scanner: async () => ({ configured: true, reachable: up }) });
    await r.tick(); expect(cap.sent.map(x => x.subject)).toEqual(["[TIGERIS] An operational check needs attention", "[TIGERIS] An operational check needs attention"]);
    up = true; clock.t = at(1); await r.tick(); expect(cap.sent.filter(x => x.subject.includes("Resolved"))).toHaveLength(2);
  });
  it("sees the serious faults from stored facts: a broken audit chain, a failed log archive, a paused source", async () => {
    const w = await world();
    const d = await withTenant(app, w.id, c => desiredConditions(c, { auditOk: false, scanner: { configured: true, reachable: false } }, T0));
    expect(d.map(x => x.key).sort()).toEqual(["ops:audit_chain", "ops:scanner"].sort());
    expect(d.every(x => x.audience.roles.includes("administrator"))).toBe(true);
    await withTenant(owner, w.id, c => c.query("INSERT INTO sources (institution_id, source_key, name, publisher, platform_type, base_url, status) VALUES ($1,'s-one','S','P','files','https://p.example','approved')", [w.id]));
    await withTenant(app, w.id, async c => { const sid = (await c.query("SELECT id FROM sources")).rows[0].id; await c.query("INSERT INTO source_schedule (institution_id, source_id, mode, interval_hours, paused, paused_reason) VALUES ($1,$2,'series',24,true,'x')", [w.id, sid]); });
    const cap = capture(), clock = { t: T0 }, r = runner(w, cap.m, clock);
    await r.tick(); expect(cap.sent.map(x => x.subject)).toEqual(["[TIGERIS] A data source needs attention"]);
    expect(cap.sent[0]!.to).toBe("adm@client.example");
    await withTenant(app, w.id, c => c.query("UPDATE source_schedule SET paused = false"));
    clock.t = at(2); await r.tick(); expect(cap.sent[1]!.subject).toBe("[TIGERIS] Resolved: A data source needs attention");
  });

  it("retries a failed send with back-off, stops hammering an unreachable relay, and gives up in the end", async () => {
    const w = await world(), cap = capture(), clock = { t: T0 }, r = runner(w, cap.m, clock);
    await infected(w, T0);
    cap.st.fail = new MailError("the mail relay could not be reached", true);
    expect(await r.tick()).toMatchObject({ sent: 0, failed: 2 });
    expect(cap.st.calls).toBe(1); // the second person failed fast, without another attempt
    expect((await rows(w, "SELECT attempts, last_notified_at FROM alert_conditions"))[0]).toMatchObject({ attempts: 1, last_notified_at: null });
    clock.t = new Date(T0.getTime() + 2 * 60_000); expect(await r.tick()).toMatchObject({ planned: 0 }); // not due yet
    cap.st.fail = null; clock.t = new Date(T0.getTime() + 6 * 60_000);
    expect(await r.tick()).toMatchObject({ sent: 2 });
    expect((await rows(w, "SELECT attempts, notify_count FROM alert_conditions"))[0]).toMatchObject({ attempts: 0, notify_count: 1 });
    const w2 = await world(), cap2 = capture(), c2 = { t: T0 }, r2 = runner(w2, cap2.m, c2);
    await infected(w2, T0); cap2.st.fail = new MailError("the mail relay rejected the message (code 550)", false);
    for (let i = 0; i < 8; i++) { await r2.tick(); c2.t = new Date(c2.t.getTime() + 3 * HOUR); }
    expect(await rows(w2, "SELECT last_notified_at IS NOT NULL AS given_up FROM alert_conditions")).toEqual([{ given_up: true }]);
    const calls = cap2.st.calls; c2.t = new Date(c2.t.getTime() + 3 * HOUR); await r2.tick(); expect(cap2.st.calls).toBe(calls);
  });
  it("records a person with no address as skipped and does not retry", async () => {
    const w = await world(), cap = capture(), r = runner(w, cap.m, { t: T0 });
    await withTenant(app, w.id, c => c.query("UPDATE principals SET email = NULL WHERE id = $1", [w.ids.aud]));
    await infected(w, T0);
    expect(await r.tick()).toMatchObject({ sent: 1, skipped: 1 });
    expect(await rows(w, "SELECT status, reason FROM alert_deliveries ORDER BY status")).toEqual([{ status: "sent", reason: null }, { status: "skipped", reason: "this person has no email address" }]);
    expect((await rows(w, "SELECT notify_count FROM alert_conditions"))[0].notify_count).toBe(1);
  });
  it("sends no more than the hourly limit and holds the rest for later", async () => {
    const w = await world(), cap = capture(), clock = { t: T0 }, r = runner(w, cap.m, clock, { engine: { reminderHours: 24, maxPerHour: 1 } });
    await infected(w, T0);
    expect(await r.tick()).toMatchObject({ sent: 1 });
    expect(await rows(w, "SELECT reason FROM alert_deliveries WHERE status = 'skipped'")).toEqual([{ reason: "hourly limit reached" }]);
    expect((await rows(w, "SELECT last_notified_at, attempts FROM alert_conditions"))[0]).toMatchObject({ last_notified_at: null, attempts: 1 });
    clock.t = new Date(T0.getTime() + 11 * 60_000); expect(await r.tick()).toMatchObject({ planned: 1, sent: 0 }); // still inside the hour
    clock.t = new Date(T0.getTime() + 70 * 60_000); expect(await r.tick()).toMatchObject({ sent: 1 });
    expect(cap.sent.map(x => x.to).sort()).toEqual(["adm@client.example", "aud@client.example"]); // each person once
    expect((await rows(w, "SELECT notify_count FROM alert_conditions"))[0].notify_count).toBe(1);
  });
  it("never puts a figure or a record in any message it sends", async () => {
    const w = await world(), cap = capture(), clock = { t: T0 }, r = runner(w, cap.m, clock, { scanner: async () => ({ configured: true, reachable: false }) });
    await infected(w, T0); await caseInReview(w); await r.tick(); clock.t = at(30); await r.tick();
    expect(cap.sent.length).toBeGreaterThan(4);
    for (const m of cap.sent) { expect(stripLinks(m.text), m.subject).not.toMatch(/[0-9]/); expect(m.subject).not.toMatch(/[0-9]/); }
  });

  it("serves the log to administrators and auditors, preferences to everyone, and addresses to administrators only", async () => {
    const w = await world(), cap = capture(), r = runner(w, cap.m, { t: T0 });
    const server = buildServer({ pool: app, institutionId: w.id, verifier: verifier(), alerts: { mailer: cap.m, baseUrl: BASE, runner: r } });
    const call = (who: keyof W["tokens"], method: string, url: string, payload?: object) => server.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${w.tokens[who]}` }, ...(payload ? { payload } : {}) });
    await infected(w, T0); await r.tick();
    const log = await call("aud", "GET", "/v1/alerts"); expect(log.statusCode).toBe(200);
    expect(log.json()).toMatchObject({ configured: true, transport: "smtp", conditions: [expect.objectContaining({ category: "malware", state: "open" })] });
    expect(log.json().deliveries).toHaveLength(2);
    expect(JSON.stringify(log.json())).not.toMatch(/@client\.example/); // the log names people, never addresses
    expect((await call("ana", "GET", "/v1/alerts")).statusCode).toBe(403);
    expect((await call("ana", "GET", "/v1/alerts/addresses")).statusCode).toBe(403);
    const mine = (await call("rev", "GET", "/v1/alerts/mine")).json();
    expect(mine.email).toBe("r***@client.example");
    expect(mine.categories).toEqual([{ category: "malware", mutable: false, enabled: true }, { category: "source", mutable: true, enabled: true }, { category: "review", mutable: true, enabled: true }, { category: "operations", mutable: false, enabled: true }]);
    expect((await call("rev", "PUT", "/v1/alerts/mine", { category: "review", enabled: false })).statusCode).toBe(200);
    expect((await call("rev", "GET", "/v1/alerts/mine")).json().categories.find((x: { category: string }) => x.category === "review").enabled).toBe(false);
    expect((await call("rev", "PUT", "/v1/alerts/mine", { category: "malware", enabled: false })).statusCode).toBe(400);
    const list = await call("adm", "GET", "/v1/alerts/addresses"); expect(list.json().find((p: { subject: string }) => p.subject === "adm").email).toBe("adm@client.example");
    expect((await call("adm", "PUT", `/v1/alerts/addresses/${w.ids.ana}`, { email: "ana@client.example" })).statusCode).toBe(200);
    expect((await call("adm", "PUT", `/v1/alerts/addresses/${w.ids.ana}`, { email: "not an address" })).statusCode).toBe(422);
    expect((await call("adm", "PUT", `/v1/alerts/addresses/${w.ids.ana}`, { email: "a@b.example\nBcc: x@y.example" })).statusCode).toBe(422);
    expect((await call("adm", "PUT", `/v1/alerts/addresses/${randomUUID()}`, { email: "a@b.example" })).statusCode).toBe(404);
    expect((await call("adm", "PUT", `/v1/alerts/addresses/${w.ids.ana}`, { email: null })).statusCode).toBe(200);
    expect((await rows(w, "SELECT payload FROM audit_events WHERE action = 'alerts.address_set' ORDER BY id")).map(x => x.payload)).toEqual([{ set: true, domain: "client.example" }, { set: false, domain: null }]);
    await server.close();
  });
  it("sends a test message to the person who asks, records it, and limits how often", async () => {
    const w = await world(), cap = capture();
    const off = buildServer({ pool: app, institutionId: w.id, verifier: verifier() }), on = buildServer({ pool: app, institutionId: w.id, verifier: verifier(), alerts: { mailer: cap.m, baseUrl: BASE } });
    const post = (srv: typeof on, who: keyof W["tokens"]) => srv.inject({ method: "POST", url: "/v1/alerts/test", headers: { authorization: `Bearer ${w.tokens[who]}` }, payload: {} });
    expect((await post(off, "adm")).statusCode).toBe(409);
    expect((await post(on, "ana")).statusCode).toBe(403);
    const ok = await post(on, "adm"); expect(ok.json()).toEqual({ status: "sent" });
    expect(cap.sent[0]).toMatchObject({ to: "adm@client.example", subject: "[TIGERIS] Test: An operational check needs attention" });
    await withTenant(app, w.id, c => c.query("UPDATE principals SET email = NULL WHERE id = $1", [w.ids.adm]));
    expect((await post(on, "adm")).json()).toMatchObject({ status: "skipped" });
    for (let i = 0; i < 3; i++) await post(on, "adm");
    expect((await post(on, "adm")).statusCode).toBe(429);
    expect((await rows(w, "SELECT kind, status FROM alert_deliveries ORDER BY created_at LIMIT 2"))).toEqual([{ kind: "test", status: "sent" }, { kind: "test", status: "skipped" }]);
    await off.close(); await on.close();
  });
  it("keeps the delivery log immutable and each institution's alerts private", async () => {
    const a = await world(), b = await world(), cap = capture();
    await infected(a, T0); await runner(a, cap.m, { t: T0 }).tick();
    expect(await rows(b, "SELECT 1 FROM alert_conditions")).toHaveLength(0);
    await expect(withTenant(app, a.id, c => c.query("UPDATE alert_deliveries SET status = 'sent'"))).rejects.toThrow();
    await expect(withTenant(app, a.id, c => c.query("DELETE FROM alert_deliveries"))).rejects.toThrow();
    await expect(withTenant(owner, a.id, c => c.query("UPDATE alert_deliveries SET reason = 'x'"))).rejects.toThrow();
    await expect(withTenant(app, a.id, c => c.query("UPDATE principals SET email = $2 WHERE id = $1", [a.ids.adm, "x@y.example\r\nBcc: z@y.example"]))).rejects.toThrow();
  });
  it("shows on Readiness whether alerts can reach anyone", async () => {
    const w = await world();
    const f = (alerts: { configured: boolean; transport: string | null }) => withTenant(app, w.id, c => installationReadiness(c, { clientDataEnabled: false, scanner: { configured: false, reachable: false }, scheduler: { enabled: false }, reasoning: { provider: null }, alerts, backupMaxAgeHours: 0 })).then(r => r.checks.find(x => x.id === "alerts")!);
    expect(await f({ configured: false, transport: null })).toMatchObject({ status: "warn", detail: expect.stringMatching(/No alert channel/) });
    expect(await f({ configured: true, transport: "log" })).toMatchObject({ status: "warn" });
    expect(await f({ configured: true, transport: "smtp" })).toMatchObject({ status: "pass", detail: expect.stringMatching(/3 people have an address/) });
  });
});
