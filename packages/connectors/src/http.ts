export interface HttpOptions {
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  timeoutMs?: number;
  userAgent?: string;
  respectRobots?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Polite client: honours robots.txt, spaces requests per host, retries once on 429/5xx. Never disables TLS checks. */
export class PoliteHttp {
  private last = new Map<string, number>();
  private robots = new Map<string, string[]>();
  private fetchImpl: typeof fetch;
  private minIntervalMs: number;
  private timeoutMs: number;
  private userAgent: string;
  private respectRobots: boolean;
  private sleep: (ms: number) => Promise<void>;
  requests = 0;

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 400;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.userAgent = opts.userAgent ?? "TigerisIngest/0.1 (institutional data connector)";
    this.respectRobots = opts.respectRobots ?? true;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  static parseDisallow(robotsTxt: string): string[] {
    const out: string[] = []; let applies = false;
    for (const raw of robotsTxt.split("\n")) {
      const line = raw.split("#")[0]!.trim(); if (!line) continue;
      const [k, ...rest] = line.split(":"); const v = rest.join(":").trim();
      const key = k!.trim().toLowerCase();
      if (key === "user-agent") applies = v === "*";
      else if (key === "disallow" && applies && v) out.push(v);
    }
    return out;
  }

  async allowed(url: URL): Promise<boolean> {
    if (!this.respectRobots) return true;
    let rules = this.robots.get(url.host);
    if (!rules) {
      try {
        const res = await this.raw(`${url.protocol}//${url.host}/robots.txt`);
        const ct = res.headers.get("content-type") ?? "";
        rules = res.ok && !ct.includes("html") ? PoliteHttp.parseDisallow(await res.text()) : [];
      } catch { rules = []; }
      this.robots.set(url.host, rules);
    }
    return !rules.some(p => url.pathname.startsWith(p));
  }

  private async raw(url: string): Promise<Response> {
    const host = new URL(url).host;
    const wait = (this.last.get(host) ?? 0) + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last.set(host, Date.now()); this.requests++;
    return this.fetchImpl(url, { headers: { "user-agent": this.userAgent, accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs), redirect: "follow" });
  }

  /** Downloads a file (text or binary). Same robots, spacing and retry rules as getJson. */
  async getBuffer(url: string, accept = "*/*"): Promise<Buffer> {
    const u = new URL(url);
    if (!(await this.allowed(u))) throw new Error(`robots.txt disallows ${u.pathname} on ${u.host}`);
    const attempt = async () => { const host = u.host; const wait = (this.last.get(host) ?? 0) + this.minIntervalMs - Date.now(); if (wait > 0) await this.sleep(wait); this.last.set(host, Date.now()); this.requests++; return this.fetchImpl(url, { headers: { "user-agent": this.userAgent, accept }, signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120000)), redirect: "follow" }); };
    let res = await attempt();
    if (res.status === 429 || res.status >= 500) { await this.sleep(1500); res = await attempt(); }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getJson<T = unknown>(url: string): Promise<T> {
    const u = new URL(url);
    if (!(await this.allowed(u))) throw new Error(`robots.txt disallows ${u.pathname} on ${u.host}`);
    let res = await this.raw(url);
    if (res.status === 429 || res.status >= 500) { await this.sleep(1500); res = await this.raw(url); }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  }
}
