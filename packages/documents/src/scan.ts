import net from "node:net";

/** A malware scanner. It answers one question about a file's bytes: clean, or flagged with a signature name. Anything else is "could not tell", which is never treated as clean. */
export type Verdict = { clean: true } | { clean: false; signature: string };
export interface Scanner { engine: string; scan(content: Buffer): Promise<Verdict>; ping(): Promise<string> }
export class ScannerUnavailable extends Error { constructor(message: string) { super(message); } }

export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export type ClamTarget = { host: string; port: number } | { socket: string };
export interface ClamOptions { target: ClamTarget; connectTimeoutMs?: number; timeoutMs?: number; chunkBytes?: number }

/** Talks to a ClamAV daemon with its INSTREAM protocol. The file is streamed and never written to the scanner's disk by this code. */
export function clamavScanner(o: ClamOptions): Scanner {
  const talk = (write: (s: net.Socket) => void, timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
    const s = net.createConnection(o.target as net.NetConnectOpts), chunks: Buffer[] = [];
    let settled = false;
    const done = (e: Error | null, v?: string) => { if (settled) return; settled = true; clearTimeout(t); clearTimeout(c); s.destroy(); e ? reject(e) : resolve(v!); };
    const c = setTimeout(() => done(new ScannerUnavailable("the scanner did not accept a connection")), o.connectTimeoutMs ?? 5_000);
    const t = setTimeout(() => done(new ScannerUnavailable("the scanner did not answer in time")), timeoutMs);
    s.once("connect", () => { clearTimeout(c); write(s); });
    s.on("data", d => { chunks.push(d); if (Buffer.concat(chunks).includes(0)) done(null, Buffer.concat(chunks).toString("utf8").split("\0")[0]); });
    s.on("error", () => done(new ScannerUnavailable("the scanner could not be reached")));
    s.on("close", () => done(chunks.length ? null : new ScannerUnavailable("the scanner closed the connection without answering"), Buffer.concat(chunks).toString("utf8").split("\0")[0]));
  });
  return {
    engine: "clamav",
    async ping() {
      const r = await talk(s => s.write("zVERSION\0"), o.connectTimeoutMs ?? 5_000);
      if (!/^ClamAV /.test(r)) throw new ScannerUnavailable("the scanner gave an unexpected answer");
      return r.slice(0, 120);
    },
    async scan(content) {
      const size = o.chunkBytes ?? 64 * 1024;
      const r = await talk(s => {
        s.write("zINSTREAM\0");
        for (let i = 0; i < content.length; i += size) { const part = content.subarray(i, i + size), len = Buffer.alloc(4); len.writeUInt32BE(part.length); s.write(len); s.write(part); }
        s.write(Buffer.alloc(4));
      }, o.timeoutMs ?? 60_000);
      if (r === "stream: OK") return { clean: true };
      const m = /^stream: ([\x20-\x7e]{1,150}) FOUND$/.exec(r);
      if (m) return { clean: false, signature: m[1]! };
      throw new ScannerUnavailable("the scanner gave an answer that is not a clean verdict"); // errors, size limits and anything unexpected: not clean
    },
  };
}

/** A scanner for tests and offline development: flags the standard EICAR test string and nothing else. It is not protection. */
export function stubScanner(mode: { unavailable?: boolean; flag?: (c: Buffer) => string | null } = {}): Scanner {
  return {
    engine: "local_stub",
    async ping() { if (mode.unavailable) throw new ScannerUnavailable("the scanner could not be reached"); return "local stub scanner"; },
    async scan(c) {
      if (mode.unavailable) throw new ScannerUnavailable("the scanner could not be reached");
      const sig = mode.flag ? mode.flag(c) : c.includes(Buffer.from(EICAR)) ? "Eicar-Test-Signature" : null;
      return sig ? { clean: false, signature: sig } : { clean: true };
    },
  };
}

export const scanBackoffMs = (attempts: number): number => Math.min(30_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10), 15 * 60_000);
