// Proves, from inside a container, that the only way out is the egress proxy and that it enforces its list.
//   docker compose exec app node scripts/egress-check.mjs
// Checks: (1) a direct connection to the internet fails; (2) the proxy refuses a host that is not on the list; (3) the proxy opens a tunnel to each host that is.
// Exit status 1 if (1) or (2) fail, because that means data could leave. An unreachable listed host is reported but is not a failure of the boundary.
import net from "node:net";

const args = process.argv.slice(2), has = f => args.includes(f), opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const proxy = new URL(opt("proxy") ?? process.env.HTTPS_PROXY ?? "http://egress-proxy:3128");
const allow = (opt("allow") ?? process.env.EGRESS_ALLOW ?? "").split(",").map(s => s.trim()).filter(Boolean);
const results = [];
const record = (name, ok, detail, failsBoundary = true) => { results.push({ name, ok, detail, failsBoundary }); console.log(`${ok ? "PASS" : failsBoundary ? "FAIL" : "WARN"}  ${name}${detail ? ` - ${detail}` : ""}`); };

const direct = (host, port, ms = 3000) => new Promise(resolve => { const s = net.connect({ host, port }); const done = r => { s.destroy(); resolve(r); }; s.setTimeout(ms, () => done("timed out")); s.once("connect", () => done("connected")); s.once("error", e => done(e.code ?? e.message)); });
const tunnel = (target, ms = 8000) => new Promise(resolve => {
  const s = net.connect(Number(proxy.port || 3128), proxy.hostname); let buf = "";
  s.setTimeout(ms, () => { s.destroy(); resolve("no answer from the proxy"); });
  s.once("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
  s.on("data", d => { buf += d; if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(buf.split("\r\n")[0]); } });
  s.once("error", e => resolve(e.code ?? e.message));
});

if (!has("--skip-direct")) {
  for (const [h, p] of [["1.1.1.1", 443], ["192.0.2.1", 443]]) { const r = await direct(h, p); record(`no direct route to ${h}:${p}`, r !== "connected", `result: ${r}`); }
} else console.log("SKIP  direct-route checks (--skip-direct)");
const refused = await tunnel("not-on-the-list.invalid:443");
record("the proxy refuses a host that is not on the list", refused.includes(" 403 "), refused);
for (const t of allow) { const r = await tunnel(t); record(`the proxy opens a tunnel to ${t}`, r.includes(" 200 "), r, false); }
const bad = results.filter(r => !r.ok && r.failsBoundary);
console.log(bad.length ? `\nBOUNDARY NOT PROVEN: ${bad.length} check(s) failed.` : "\nThe boundary holds: no direct route, and the proxy enforces its list.");
process.exit(bad.length ? 1 : 0);
