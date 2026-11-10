/** A model connection. Adapters only move text: they hold no data of their own and never see anything but the prompt they are given. */
export interface ModelRequest { system: string; user: string; maxTokens: number }
export interface ModelReply { text: string; inputTokens: number | null; outputTokens: number | null }
export interface ModelAdapter { provider: string; model: string; complete(req: ModelRequest): Promise<ModelReply> }

export class ModelError extends Error { constructor(message: string) { super(message); } }

export interface HttpAdapterOptions { baseUrl: string; model: string; apiKey?: string | null; production: boolean; fetchImpl?: typeof fetch; timeoutMs?: number }
const MAX_BYTES = 1_000_000;

/** https is required in production. Outside production a plain http address is accepted only for this machine, to reach a local model. */
export function checkEndpoint(baseUrl: string, production: boolean): URL {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new ModelError("the model address is not a valid URL"); }
  if (u.username || u.password) throw new ModelError("the model address must not carry credentials");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !production)) throw new ModelError(production ? "the model address must use https in production" : "the model address must use https, or http on this machine only");
  return u;
}

async function post(url: string, headers: Record<string, string>, body: unknown, o: HttpAdapterOptions): Promise<any> {
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try { res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) }); }
  catch (e) { throw new ModelError(`the model could not be reached (${(e as Error).name === "TimeoutError" ? "timed out" : "network error"})`); }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new ModelError("the model reply was too large");
  if (!res.ok) throw new ModelError(`the model service refused the request (status ${res.status})`); // the body is not echoed: it may repeat the prompt or a key
  try { return JSON.parse(text); } catch { throw new ModelError("the model service returned something that is not JSON"); }
}

export function anthropicAdapter(o: HttpAdapterOptions): ModelAdapter {
  const base = checkEndpoint(o.baseUrl, o.production);
  if (!o.apiKey) throw new ModelError("the Claude API needs an API key");
  return {
    provider: "anthropic", model: o.model,
    async complete(r) {
      const j = await post(new URL("/v1/messages", base).toString(), { "x-api-key": o.apiKey!, "anthropic-version": "2023-06-01" }, { model: o.model, max_tokens: r.maxTokens, temperature: 0, system: r.system, messages: [{ role: "user", content: r.user }] }, o);
      const text = Array.isArray(j?.content) ? j.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text)).join("") : "";
      return { text, inputTokens: Number.isInteger(j?.usage?.input_tokens) ? j.usage.input_tokens : null, outputTokens: Number.isInteger(j?.usage?.output_tokens) ? j.usage.output_tokens : null };
    },
  };
}

export function openAiCompatibleAdapter(o: HttpAdapterOptions): ModelAdapter {
  const base = checkEndpoint(o.baseUrl, o.production);
  return {
    provider: "openai_compatible", model: o.model,
    async complete(r) {
      const url = `${base.toString().replace(/\/+$/, "")}/chat/completions`;
      const j = await post(url, o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}, { model: o.model, max_tokens: r.maxTokens, temperature: 0, messages: [{ role: "system", content: r.system }, { role: "user", content: r.user }] }, o);
      const text = typeof j?.choices?.[0]?.message?.content === "string" ? j.choices[0].message.content : "";
      return { text, inputTokens: Number.isInteger(j?.usage?.prompt_tokens) ? j.usage.prompt_tokens : null, outputTokens: Number.isInteger(j?.usage?.completion_tokens) ? j.usage.completion_tokens : null };
    },
  };
}
