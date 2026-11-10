import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../apps/api/src/config.js";
import { buildServer } from "../apps/api/src/server.js";
import { withTenant } from "../packages/ingest/src/store.js";
import { ModelError, anthropicAdapter, checkEndpoint, extractiveAdapter, judge, numbersIn, openAiCompatibleAdapter, packFacts, factsFromCase, type Fact, type ModelAdapter } from "../packages/reasoning/src/index.js";
import { addUser, verifier } from "./helpers/auth.js";

const F = (ref: string, text: string, evidenceId: string | null = "ev-" + ref): Fact => ({ ref, text, evidenceId, dataClass: "public_record" });
const facts = [F("F1", "Brent crude: 80.12 US$ per barrel in 2026-10, +3.0% on the month"), F("F2", "Saudi Arabia: crude exports 1,250 thousand barrels a day in 2026-08, against a median of 7,000"), F("F3", "Iraq: no data since 2024-03")];
const raw = (o: unknown) => JSON.stringify(o);
const item = (text: string, ...cites: string[]) => ({ text, cites });

describe("verification of model output", () => {
  it("reads numbers the way people write them", () => { expect(numbersIn("US$ 1,250.5 and 3% in 2026-10")).toEqual([1250.5, 3, 2026, 10]); });

  it("accepts text whose numbers all appear in the facts it cites", () => {
    const j = judge("summary_briefing", raw({ items: [item("Brent crude was 80.12 US$ per barrel in 2026-10.", "F1"), item("Exports were 1,250 thousand barrels a day.", "F2")] }), facts);
    expect(j.verdict).toBe("accepted");
    if (j.verdict === "accepted") expect(j.output.evidenceIds).toEqual(["ev-F1", "ev-F2"]);
  });
  it("accepts a fenced reply", () => { expect(judge("summary_briefing", "```json\n" + raw({ items: [item("Iraq has no data since 2024-03.", "F3")] }) + "\n```", facts).verdict).toBe("accepted"); });

  it("rejects a number the model changed, rounded or computed", () => {
    for (const t of ["Brent crude was 80 US$ per barrel.", "Brent crude rose 3.5% on the month.", "Exports were 1,250 against 7,000, a drop of 82%."]) {
      const j = judge("summary_briefing", raw({ items: [item(t, "F1", "F2")] }), facts);
      expect(j.verdict, t).toBe("rejected");
    }
  });
  it("rejects a number that is in another fact but not in the one cited", () => {
    const j = judge("summary_briefing", raw({ items: [item("Exports were 1,250 thousand barrels a day.", "F1")] }), facts);
    expect(j).toMatchObject({ verdict: "rejected" });
    if (j.verdict === "rejected") expect(j.reasons.join()).toMatch(/1250 does not appear/);
  });
  it("rejects items with no citation, an unknown citation, or quantities stated in words", () => {
    expect(judge("summary_briefing", raw({ items: [{ text: "Things are fine.", cites: [] }] }), facts).verdict).toBe("rejected");
    expect(judge("summary_briefing", raw({ items: [item("Iraq has no data.", "F9")] }), facts).verdict).toBe("rejected");
    expect(judge("summary_briefing", raw({ items: [item("Brent crude doubled.", "F1")] }), facts).verdict).toBe("rejected");
    expect(judge("summary_briefing", raw({ items: [item("Exports fell by half.", "F2")] }), facts).verdict).toBe("rejected");
  });
  it("rejects advice, links and markup, and rejects anything not in the required form", () => {
    expect(judge("summary_briefing", raw({ items: [item("Iraq should be contacted.", "F3")] }), facts).verdict).toBe("rejected");
    expect(judge("summary_briefing", raw({ items: [item("See https://example.com for Iraq.", "F3")] }), facts).verdict).toBe("rejected");
    expect(judge("summary_briefing", raw({ items: [item("<b>Iraq</b> has no data.", "F3")] }), facts).verdict).toBe("rejected");
    expect(judge("summary_briefing", "I think the answer is yes.", facts).verdict).toBe("rejected");
    expect(judge("summary_briefing", raw({ items: [] }), facts).verdict).toBe("rejected");
  });
  it("lets questions say 'should' but still not advise", () => {
    expect(judge("questions_case", raw({ items: [{ text: "What should explain the gap in Iraq?", cites: ["F3"], type: "question" }] }), facts).verdict).toBe("accepted");
    expect(judge("questions_case", raw({ items: [{ text: "We recommend contacting Iraq.", cites: ["F3"], type: "question" }] }), facts).verdict).toBe("rejected");
    expect(judge("questions_case", raw({ items: [item("Iraq has no data.", "F3")] }), facts).verdict).toBe("rejected");
  });
  it("accepts a refusal only for a free-text answer", () => {
    expect(judge("answer", raw({ refusal: "The facts do not address this.", items: [] }), facts)).toMatchObject({ verdict: "refused" });
    expect(judge("summary_briefing", raw({ refusal: "no", items: [] }), facts).verdict).toBe("rejected");
  });
  it("needs a number-free title on a recommendation draft and builds its description from verified statements", () => {
    const ok = judge("recommendation_case", raw({ title: "Review the Gulf export gap", items: [item("Saudi exports were 1,250 thousand barrels a day.", "F2")] }), facts);
    expect(ok).toMatchObject({ verdict: "accepted", output: { title: "Review the Gulf export gap", description: "Saudi exports were 1,250 thousand barrels a day.", evidenceIds: ["ev-F2"] } });
    expect(judge("recommendation_case", raw({ title: "Cut exposure by 20%", items: [item("Iraq has no data.", "F3")] }), facts).verdict).toBe("rejected");
    expect(judge("recommendation_case", raw({ items: [item("Iraq has no data.", "F3")] }), facts).verdict).toBe("rejected");
  });
  it("accepts what the local extractive model produces, for every task", async () => {
    const m = extractiveAdapter();
    for (const task of ["summary_briefing", "summary_case", "questions_case", "recommendation_case", "answer"] as const) {
      const r = await m.complete({ system: "", user: JSON.stringify({ task, question: "What about Iraq data?", facts: facts.map(f => ({ ref: f.ref, text: f.text })) }), maxTokens: 10 });
      expect(judge(task, r.text, facts).verdict, task).toBe("accepted");
    }
    const none = await m.complete({ system: "", user: JSON.stringify({ task: "answer", question: "Tell me about wheat", facts: facts.map(f => ({ ref: f.ref, text: f.text })) }), maxTokens: 10 });
    expect(judge("answer", none.text, facts).verdict).toBe("refused");
  });
});

describe("what may be sent to a model", () => {
  it("withholds every class except public records, sample datasets and scenario simulations", () => {
    const p = packFacts([
      { text: "a 1", evidenceId: "e1", dataClass: "public_record" }, { text: "b 2", evidenceId: "e2", dataClass: "institution_own" }, { text: "c 3", evidenceId: "e3", dataClass: "licensed_feed" },
      { text: "d 4", evidenceId: "e4", dataClass: "third_party_derived" }, { text: "e 5", evidenceId: "e5", dataClass: "sample_dataset" }, { text: "a 1", evidenceId: "e1", dataClass: "public_record" },
    ]);
    expect(p.facts.map(f => f.text)).toEqual(["a 1", "e 5"]);
    expect(p.withheld).toBe(3);
    expect(p.classes).toEqual(["public_record", "sample_dataset"]);
    expect(p.facts.map(f => f.ref)).toEqual(["F1", "F2"]);
  });
  it("hashes the facts so the same input gives the same hash and any change gives another", () => {
    const a = packFacts([{ text: "x 1", evidenceId: null, dataClass: "public_record" }]), b = packFacts([{ text: "x 1", evidenceId: null, dataClass: "public_record" }]), c = packFacts([{ text: "x 2", evidenceId: null, dataClass: "public_record" }]);
    expect(a.hash).toBe(b.hash); expect(a.hash).not.toBe(c.hash);
  });
  it("never sends text people wrote into a case, only the title and objective a rule generated", () => {
    expect(factsFromCase({ signal: null, title: "Our secret plan", objective: "Confidential objective" }, [])).toEqual([]);
    expect(factsFromCase({ signal: {}, title: "Our secret plan", objective: "Confidential objective" }, [])).toEqual([]);
    expect(factsFromCase({ signal: { id: "E1:SA:2026-08" }, title: "Saudi exports fell", objective: "Decide." }, []).map(f => f.text)).toEqual(["Saudi exports fell", "Decide."]);
  });
});

describe("model adapters", () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("requires https in production and allows http only on this machine elsewhere", () => {
    expect(() => checkEndpoint("http://model.example", true)).toThrow(/https/);
    expect(() => checkEndpoint("http://model.example", false)).toThrow(/https/);
    expect(() => checkEndpoint("http://localhost:11434/v1", true)).toThrow(/https/);
    expect(checkEndpoint("http://localhost:11434/v1", false).hostname).toBe("localhost");
    expect(checkEndpoint("https://model.example", true).protocol).toBe("https:");
    expect(() => checkEndpoint("https://u:p@model.example", true)).toThrow(/credentials/);
    expect(() => checkEndpoint("nonsense", true)).toThrow(ModelError);
  });
  it("calls the Claude API with the key in a header, no redirects and a timeout, and reads text and usage", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const a = anthropicAdapter({ baseUrl: "https://api.anthropic.com", model: "m1", apiKey: "sk-test-key", production: true, fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ content: [{ type: "text", text: "hello" }], usage: { input_tokens: 5, output_tokens: 2 } })); }) as unknown as typeof fetch });
    expect(await a.complete({ system: "s", user: "u", maxTokens: 10 })).toEqual({ text: "hello", inputTokens: 5, outputTokens: 2 });
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect((seen!.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test-key");
    expect(seen!.init.redirect).toBe("error");
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ model: "m1", temperature: 0, system: "s", messages: [{ role: "user", content: "u" }] });
    expect(() => anthropicAdapter({ baseUrl: "https://api.anthropic.com", model: "m1", production: true })).toThrow(/key/);
  });
  it("calls an OpenAI-compatible endpoint, with or without a key", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })); }) as unknown as typeof fetch;
    const a = openAiCompatibleAdapter({ baseUrl: "https://llm.client.example/v1/", model: "local", production: true, fetchImpl: f });
    expect(await a.complete({ system: "s", user: "u", maxTokens: 10 })).toEqual({ text: "hi", inputTokens: 3, outputTokens: 1 });
    expect(seen!.url).toBe("https://llm.client.example/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBeUndefined();
    const k = openAiCompatibleAdapter({ baseUrl: "https://llm.client.example/v1", model: "local", apiKey: "tok", production: true, fetchImpl: f });
    await k.complete({ system: "s", user: "u", maxTokens: 10 });
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
  it("reports failures without echoing the response body or the key", async () => {
    const bad = anthropicAdapter({ baseUrl: "https://api.anthropic.com", model: "m", apiKey: "sk-secret", production: true, fetchImpl: reply({ error: "echo sk-secret and the prompt" }, 401) });
    const e = await bad.complete({ system: "s", user: "u", maxTokens: 1 }).catch(x => x as Error);
    expect(e).toBeInstanceOf(ModelError);
    expect((e as Error).message).toBe("the model service refused the request (status 401)");
    const down = openAiCompatibleAdapter({ baseUrl: "https://x.example", model: "m", production: true, fetchImpl: (async () => { throw new TypeError("connect ECONNREFUSED sk-secret"); }) as unknown as typeof fetch });
    expect(((await down.complete({ system: "s", user: "u", maxTokens: 1 }).catch(x => x)) as Error).message).toBe("the model could not be reached (network error)");
    const html = openAiCompatibleAdapter({ baseUrl: "https://x.example", model: "m", production: true, fetchImpl: (async () => new Response("<html>")) as unknown as typeof fetch });
    await expect(html.complete({ system: "s", user: "u", maxTokens: 1 })).rejects.toThrow(/not JSON/);
  });
});

describe("reasoning configuration", () => {
  const base = { DATABASE_URL: "postgres://u:p@h/d", TIGERIS_INSTITUTION_ID: randomUUID(), OIDC_ISSUER: "https://idp.example", OIDC_AUDIENCE: "a", OIDC_JWKS_URI: "https://idp.example/keys" };
  it("is off by default", () => { expect(loadConfig({ ...base }).reasoning.provider).toBe("off"); });
  it("needs a model name and a key for the Claude API, and an address for an OpenAI-compatible model", () => {
    expect(() => loadConfig({ ...base, TIGERIS_REASONING_PROVIDER: "anthropic" })).toThrow(/TIGERIS_MODEL_NAME[\s\S]*TIGERIS_MODEL_API_KEY/);
    expect(loadConfig({ ...base, TIGERIS_REASONING_PROVIDER: "anthropic", TIGERIS_MODEL_NAME: "m", TIGERIS_MODEL_API_KEY: "k" }).reasoning.baseUrl).toBe("https://api.anthropic.com");
    expect(() => loadConfig({ ...base, TIGERIS_REASONING_PROVIDER: "openai_compatible", TIGERIS_MODEL_NAME: "m" })).toThrow(/TIGERIS_MODEL_BASE_URL/);
    expect(() => loadConfig({ ...base, TIGERIS_REASONING_PROVIDER: "other" })).toThrow(/TIGERIS_REASONING_PROVIDER/);
    expect(() => loadConfig({ ...base, TIGERIS_ENV: "production", DATABASE_URL: "postgres://u:a-long-strong-pass@h/d", TIGERIS_REASONING_PROVIDER: "openai_compatible", TIGERIS_MODEL_NAME: "m", TIGERIS_MODEL_BASE_URL: "http://llm.internal/v1" })).toThrow(/https in production/);
  });
});

const ownerUrl = process.env.DATABASE_URL_TEST_OWNER, appUrl = process.env.DATABASE_URL_TEST;
const suite = ownerUrl && appUrl ? describe : describe.skip;

suite("reasoning routes", () => {
  let owner: pg.Pool, app: pg.Pool;
  beforeAll(() => { owner = new pg.Pool({ connectionString: ownerUrl! }); app = new pg.Pool({ connectionString: appUrl! }); });
  afterAll(async () => { await owner.end(); await app.end(); });

  const scripted = (fn: (user: string) => string | Error): ModelAdapter => ({ provider: "scripted", model: "s/1", async complete(r) { const o = fn(r.user); if (o instanceof Error) throw new ModelError(o.message); return { text: o, inputTokens: 1, outputTokens: 1 }; } });
  async function setup(adapter: ModelAdapter | null, perHour?: number) {
    const id = randomUUID();
    await withTenant(owner, id, async c => { await c.query("INSERT INTO institutions (id, name) VALUES ($1,'R')", [id]); });
    const tokens = { ana: await addUser(owner, app, id, "ana", ["analyst"]), ops: await addUser(owner, app, id, "ops", ["operations"]), aud: await addUser(owner, app, id, "aud", ["auditor"]) };
    const server = buildServer({ pool: app, institutionId: id, verifier: verifier(), reasoning: adapter ? { adapter, ...(perHour ? { perHour } : {}) } : null });
    const call = async (who: keyof typeof tokens, method: string, url: string, payload?: object) => { const r = await server.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${tokens[who]}` }, ...(payload ? { payload } : {}) }); let body: any = null; try { body = r.json(); } catch { /* none */ } return { status: r.statusCode, body }; };
    return { id, server, call };
  }
  const rows = (id: string) => withTenant(app, id, async c => (await c.query("SELECT task, verdict, provider, output, raw_output, prompt_hash FROM reasoning_calls ORDER BY created_at")).rows);
  const auditActions = (id: string) => withTenant(app, id, async c => (await c.query("SELECT action FROM audit_events WHERE action = 'reasoning.call'")).rows.length);

  it("records a verified draft with its audit event, and shows the facts the model saw", async () => {
    const s = await setup(extractiveAdapter());
    const r = await s.call("ana", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "energy" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ verdict: "accepted", provider: "local_extractive", task: "summary_briefing" });
    expect(r.body.facts.length).toBeGreaterThan(0);
    expect(r.body.output.items[0].cites).toEqual(["F1"]);
    const logged = await rows(s.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ task: "summary_briefing", verdict: "accepted", provider: "local_extractive" });
    expect(logged[0].prompt_hash).toBe(r.body.promptHash);
    expect(await auditActions(s.id)).toBe(1);
    await s.server.close();
  });

  it("rejects an invented figure, shows nothing of it, and keeps the raw reply for the auditor", async () => {
    const s = await setup(scripted(() => JSON.stringify({ items: [{ text: "Brent crude reached 140 US$ per barrel.", cites: ["F1"] }] })));
    const r = await s.call("ana", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "energy" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ verdict: "rejected", output: null });
    expect(r.body.reasons.join()).toMatch(/140/);
    const logged = await rows(s.id);
    expect(logged[0]).toMatchObject({ verdict: "rejected", output: null });
    expect(logged[0].raw_output).toMatch(/140/);
    const calls = await s.call("aud", "GET", "/v1/reasoning/calls");
    expect(calls.body[0]).toMatchObject({ verdict: "rejected" });
    await s.server.close();
  });

  it("records a model failure as an error, without the model's words", async () => {
    const s = await setup(scripted(() => new Error("the model could not be reached (network error)")));
    const r = await s.call("ana", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "sovereign" });
    expect(r.body).toMatchObject({ verdict: "error", output: null, reasons: ["the model could not be reached (network error)"] });
    expect((await rows(s.id))[0].verdict).toBe("error");
    await s.server.close();
  });

  it("refuses a question the stored facts cannot answer, and sends the question only as a prompt", async () => {
    const s = await setup(extractiveAdapter());
    const r = await s.call("ana", "POST", "/v1/reasoning/run", { task: "answer", question: "Describe the wheat harvest in Canada" });
    expect(r.body).toMatchObject({ verdict: "refused", output: null });
    await s.server.close();
  });

  it("answers 404 for a case the reader cannot see and 400 for a bad body", async () => {
    const s = await setup(extractiveAdapter());
    expect((await s.call("ana", "POST", "/v1/reasoning/run", { task: "summary_case", caseId: randomUUID() })).status).toBe(404);
    expect((await s.call("ana", "POST", "/v1/reasoning/run", { task: "answer", question: "hi" })).status).toBe(400);
    expect((await s.call("ana", "POST", "/v1/reasoning/run", { task: "nope" })).status).toBe(400);
    expect(await rows(s.id)).toHaveLength(0);
    await s.server.close();
  });

  it("says plainly when no model is connected", async () => {
    const s = await setup(null);
    expect((await s.call("ana", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "energy" })).status).toBe(503);
    expect((await s.call("ana", "GET", "/v1/reasoning/config")).body).toMatchObject({ enabled: false, provider: null });
    await s.server.close();
  });

  it("limits each person's drafts per hour", async () => {
    const s = await setup(extractiveAdapter(), 2);
    const go = () => s.call("ana", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "energy" });
    expect((await go()).status).toBe(200); expect((await go()).status).toBe(200);
    expect((await go()).status).toBe(429);
    await s.server.close();
  });

  it("gives the log to auditors only, and drafting only to roles that read evidence for decisions", async () => {
    const s = await setup(extractiveAdapter());
    expect((await s.call("ops", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "energy" })).status).toBe(403);
    expect((await s.call("ops", "GET", "/v1/reasoning/config")).status).toBe(200);
    expect((await s.call("ana", "GET", "/v1/reasoning/calls")).status).toBe(403);
    expect((await s.call("aud", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "energy" })).status).toBe(403);
    expect((await s.call("aud", "GET", "/v1/reasoning/calls")).status).toBe(200);
    await s.server.close();
  });

  it("keeps the log immutable and private to each institution", async () => {
    const a = await setup(extractiveAdapter()), b = await setup(extractiveAdapter());
    await a.call("ana", "POST", "/v1/reasoning/run", { task: "summary_briefing", pack: "energy" });
    expect(await rows(b.id)).toHaveLength(0);
    await expect(withTenant(app, a.id, c => c.query("UPDATE reasoning_calls SET verdict = 'accepted'"))).rejects.toThrow();
    await expect(withTenant(app, a.id, c => c.query("DELETE FROM reasoning_calls"))).rejects.toThrow();
    await expect(withTenant(owner, a.id, c => c.query("UPDATE reasoning_calls SET model = 'x'"))).rejects.toThrow();
    await a.server.close(); await b.server.close();
  });
});
