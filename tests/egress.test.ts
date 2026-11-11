import { spawn } from "node:child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { smtpProxy } from "../apps/api/src/config.js";
import { createEgressProxy, isPrivateAddress, parseAllow } from "../packages/core/src/index.js";

const connect = (proxy: number, target: string): Promise<{ status: string; socket: net.Socket }> => new Promise((resolve, reject) => {
  const s = net.connect(proxy, "127.0.0.1"); let buf = "";
  s.on("data", d => { buf += d.toString(); if (buf.includes("\r\n\r\n")) { s.removeAllListeners("data"); resolve({ status: buf.split("\r\n")[0]!, socket: s }); } });
  s.on("error", reject); s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
});
const request = (port: number, raw: string): Promise<string> => new Promise(resolve => { const s = net.connect(port, "127.0.0.1"); let b = ""; s.on("data", d => b += d); s.on("close", () => resolve(b)); s.write(raw); setTimeout(() => s.destroy(), 500); });

describe("the egress proxy", () => {
  let echo: net.Server, echoPort: number, proxy: ReturnType<typeof createEgressProxy>, port: number; const log: Record<string, unknown>[] = [], hits: string[] = [];
  beforeAll(async () => {
    echo = net.createServer(s => { hits.push("connected"); s.on("data", d => s.write(d)); }); await new Promise<void>(r => echo.listen(0, "127.0.0.1", r)); echoPort = (echo.address() as AddressInfo).port;
    const map: Record<string, string> = { "idp.internal.example": "127.0.0.1", "public.example": "93.184.216.34", "sneaky.example": "10.0.0.5", "relay.example": "127.0.0.1" };
    proxy = createEgressProxy({
      allow: [`idp.internal.example:${echoPort}`, `sneaky.example:${echoPort}`, `relay.example:${echoPort}`, "public.example:443"], allowPrivate: [`idp.internal.example:${echoPort}`],
      log: o => log.push(o), maxTunnels: 3, connectTimeoutMs: 300, resolve: async h => { if (!map[h]) throw new Error("nxdomain"); return [map[h]!]; },
    });
    await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r)); port = (proxy.address() as AddressInfo).port;
  });
  afterAll(() => { proxy.close(); echo.close(); });

  it("tunnels to a listed host and port, and carries bytes both ways", async () => {
    const { status, socket } = await connect(port, `idp.internal.example:${echoPort}`);
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const got = await new Promise<string>(r => { socket.once("data", d => r(d.toString())); socket.write("ping"); });
    expect(got).toBe("ping"); socket.destroy();
    expect(log.find(l => l.decision === "allowed")).toMatchObject({ target: `idp.internal.example:${echoPort}` });
  });
  it("refuses anything not on the list, without ever contacting it", async () => {
    const before = hits.length;
    expect((await connect(port, "evil.example:443")).status).toBe("HTTP/1.1 403 Forbidden");
    expect((await connect(port, `idp.internal.example:${echoPort + 1}`)).status).toBe("HTTP/1.1 403 Forbidden"); // right host, wrong port
    expect((await connect(port, `127.0.0.1:${echoPort}`)).status).toBe("HTTP/1.1 403 Forbidden"); // an address is not a listed name
    expect((await connect(port, "not a target")).status).toBe("HTTP/1.1 400 Bad Request");
    expect(hits.length).toBe(before);
    expect(log.filter(l => l.decision === "refused" && l.reason === "not on the allowlist").length).toBeGreaterThanOrEqual(3);
  });
  it("refuses a listed name that resolves to a private address, unless it was listed as private", async () => {
    const r = await connect(port, `sneaky.example:${echoPort}`);
    expect(r.status).toBe("HTTP/1.1 403 Forbidden");
    expect(log.find(l => l.reason === "resolves to a private address")).toMatchObject({ addresses: ["10.0.0.5"] });
    expect((await connect(port, `relay.example:${echoPort}`)).status).toBe("HTTP/1.1 403 Forbidden"); // loopback, not listed as private
    { const ok = await connect(port, `idp.internal.example:${echoPort}`); expect(ok.status).toBe("HTTP/1.1 200 Connection Established"); ok.socket.destroy(); } // listed as private on purpose
  });
  it("does not serve plain HTTP, answers its health check, and limits open tunnels", async () => {
    expect(await request(port, "GET http://public.example/ HTTP/1.1\r\nHost: public.example\r\n\r\n")).toMatch(/^HTTP\/1.1 405/);
    expect(await request(port, "GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")).toMatch(/^HTTP\/1.1 200/);
    const open = await Promise.all([1, 2, 3].map(() => connect(port, `idp.internal.example:${echoPort}`)));
    expect(open.every(o => o.status.includes("200"))).toBe(true);
    expect((await connect(port, `idp.internal.example:${echoPort}`)).status).toBe("HTTP/1.1 503 Service Unavailable");
    open.forEach(o => o.socket.destroy());
  });
  it("makes a program that honours HTTPS_PROXY go through it, and fail when refused", async () => {
    log.length = 0;
    const run = (url: string) => new Promise<{ out: string; code: number | null }>(resolve => {
      const p = spawn("node", ["-e", `fetch(${JSON.stringify(url)}).then(r=>console.log('status',r.status)).catch(e=>console.log('failed',(e.cause&&e.cause.code)||e.message))`], { env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`, NO_PROXY: "", no_proxy: "" } });
      let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d); p.on("close", code => resolve({ out, code }));
    });
    const blocked = await run("https://blocked.example/"); expect(blocked.out).toMatch(/failed/);
    expect(log.some(l => l.decision === "refused" && l.target === "blocked.example:443")).toBe(true); // the request reached the proxy, not the internet
    const allowed = await run(`https://idp.internal.example:${echoPort}/`); expect(allowed.out).toMatch(/failed/); // the echo server is not TLS, so the handshake fails...
    expect(log.some(l => l.decision === "allowed" && l.target === `idp.internal.example:${echoPort}`)).toBe(true); // ...after the proxy let it through
  }, 20_000);
});

describe("allowlist and mail settings", () => {
  it("reads host:port lists strictly and recognises private addresses", () => {
    expect(parseAllow("A.Example:443, b.example:8443")).toEqual(expect.arrayContaining(["a.example:443"]));
    expect(() => parseAllow("nohost")).toThrow(/host:port/); expect(() => parseAllow("a.example:99999")).toThrow(); expect(parseAllow(undefined)).toEqual([]);
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("sends mail through the proxy unless the relay is internal or the proxy is switched off", () => {
    const e = { HTTPS_PROXY: "http://egress-proxy:3128", NO_PROXY: "db,.internal.example" };
    expect(smtpProxy(e, "smtp.provider.example")).toBe("http://egress-proxy:3128");
    expect(smtpProxy(e, "mail.internal.example")).toBeNull(); expect(smtpProxy(e, "db")).toBeNull();
    expect(smtpProxy({ ...e, TIGERIS_SMTP_PROXY: "none" }, "smtp.provider.example")).toBeNull();
    expect(smtpProxy({ ...e, TIGERIS_SMTP_PROXY: "http://other:3128" }, "x.example")).toBe("http://other:3128");
    expect(smtpProxy({}, "x.example")).toBeNull();
  });
});

describe("the egress check script", () => {
  it("passes against a proxy that enforces its list and fails against one that allows everything", async () => {
    const { spawn } = await import("node:child_process");
    const run = (port: number, allow: string) => new Promise<{ out: string; code: number | null }>(resolve => { const p = spawn("node", ["scripts/egress-check.mjs", "--skip-direct", "--proxy", `http://127.0.0.1:${port}`, "--allow", allow]); let out = ""; p.stdout.on("data", d => out += d); p.on("close", code => resolve({ out, code })); });
    const echo = net.createServer(s => s.on("data", d => s.write(d))); await new Promise<void>(r => echo.listen(0, "127.0.0.1", r)); const ep = (echo.address() as AddressInfo).port;
    const good = createEgressProxy({ allow: [`ok.example:${ep}`], allowPrivate: [`ok.example:${ep}`], resolve: async () => ["127.0.0.1"] }); await new Promise<void>(r => good.listen(0, "127.0.0.1", r));
    const ok = await run((good.address() as AddressInfo).port, `ok.example:${ep}`);
    expect(ok.code).toBe(0); expect(ok.out).toMatch(/PASS  the proxy refuses a host that is not on the list/); expect(ok.out).toMatch(/PASS  the proxy opens a tunnel to ok.example/); expect(ok.out).toMatch(/The boundary holds/);
    // a proxy that lets anything through is exactly what the check exists to catch
    const open = net.createServer(s => s.once("data", () => s.end("HTTP/1.1 200 Connection Established\r\n\r\n"))); await new Promise<void>(r => open.listen(0, "127.0.0.1", r));
    const bad = await run((open.address() as AddressInfo).port, "");
    expect(bad.code).toBe(1); expect(bad.out).toMatch(/FAIL  the proxy refuses a host that is not on the list/); expect(bad.out).toMatch(/BOUNDARY NOT PROVEN/);
    good.close(); open.close(); echo.close();
  }, 20_000);
});
