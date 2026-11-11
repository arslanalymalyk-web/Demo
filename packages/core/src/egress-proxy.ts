import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";

/** The only way out of the deployment. A CONNECT-only forwarder that opens a tunnel to a destination only if that exact host and port is on the allowlist.
 *  Plain HTTP is refused, so nothing travels unencrypted; names are resolved here, and a name that resolves to a private, loopback or link-local address is refused unless it was listed as private on purpose,
 *  so an allowed name cannot be pointed back at the institution's own network. Every decision is logged. */
export interface EgressOptions { allow: string[]; allowPrivate?: string[]; log?: (o: Record<string, unknown>) => void; connectTimeoutMs?: number; idleTimeoutMs?: number; maxTunnels?: number; resolve?: (host: string) => Promise<string[]> }

const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");
export const parseAllow = (v: string | undefined): string[] => (v ?? "").split(",").map(x => x.trim()).filter(Boolean).map(x => { const m = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(x); if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error(`"${x}" is not host:port`); return `${norm(m[1]!)}:${Number(m[2])}`; });

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) { const [a, b] = ip.split(".").map(Number) as [number, number]; return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v) || v.startsWith("ff");
}

export function createEgressProxy(o: EgressOptions): http.Server {
  const allow = new Set(o.allow.map(x => x.toLowerCase())), priv = new Set((o.allowPrivate ?? []).map(x => x.toLowerCase())), log = o.log ?? (() => undefined);
  const resolve = o.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map(a => a.address));
  let open = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }).end("ok\n"); return; }
    log({ decision: "refused", reason: "only CONNECT is accepted", method: req.method });
    res.writeHead(405, { allow: "CONNECT", "content-type": "text/plain" }).end("only encrypted tunnels to allowed hosts are served\n");
  });
  server.on("connect", async (req, client: net.Socket, head) => {
    const deny = (code: number, text: string, reason: string, extra: Record<string, unknown> = {}) => { log({ decision: "refused", reason, target: req.url, ...extra }); client.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); };
    client.on("error", () => client.destroy());
    const m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!m) return deny(400, "Bad Request", "malformed target");
    const host = norm(m[1]!), port = Number(m[2]), key = `${host}:${port}`;
    if (!allow.has(key)) return deny(403, "Forbidden", "not on the allowlist");
    if (open >= (o.maxTunnels ?? 200)) return deny(503, "Service Unavailable", "too many tunnels");
    let addrs: string[];
    try { addrs = net.isIP(host) ? [host] : await resolve(host); } catch { return deny(502, "Bad Gateway", "name did not resolve"); }
    if (!addrs.length) return deny(502, "Bad Gateway", "name did not resolve");
    if (!priv.has(key) && addrs.some(isPrivateAddress)) return deny(403, "Forbidden", "resolves to a private address", { addresses: addrs });
    open++;
    const up = net.connect({ host: addrs[0]!, port });
    let done = false; const finish = () => { if (!done) { done = true; open--; client.destroy(); up.destroy(); } };
    up.setTimeout(o.connectTimeoutMs ?? 10_000, () => { if (!up.connecting) return; deny(504, "Gateway Timeout", "destination did not answer"); finish(); });
    up.once("connect", () => {
      up.setTimeout(o.idleTimeoutMs ?? 300_000, finish); client.setTimeout(o.idleTimeoutMs ?? 300_000, finish);
      log({ decision: "allowed", target: key, address: addrs[0] });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    up.on("error", () => { if (up.connecting) deny(502, "Bad Gateway", "destination refused", { target: key }); finish(); });
    client.on("close", finish); up.on("close", finish);
  });
  return server;
}
