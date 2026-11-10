/** A fixed-window request limiter per client address, kept in memory. One deployment is one process, so no shared store is needed.
 *  A front proxy should apply its own limits too; this is the second line. */
export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Returns 0 when the request is allowed, otherwise the milliseconds until the client may try again. */
  check(key: string): number {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) { this.hits.set(key, { n: 1, resetAt: t + this.windowMs }); return 0; }
    cur.n++;
    return cur.n > this.max ? cur.resetAt - t : 0;
  }
}
