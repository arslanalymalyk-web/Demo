import { createEgressProxy, parseAllow } from "./egress-proxy.js";

const allow = parseAllow(process.env.EGRESS_ALLOW), port = Number(process.env.EGRESS_PORT ?? 3128);
if (allow.length === 0) { console.error("EGRESS_ALLOW is empty: list the hosts this deployment may reach as host:port, comma separated. Nothing is allowed by default."); process.exit(2); }
const server = createEgressProxy({ allow, allowPrivate: parseAllow(process.env.EGRESS_ALLOW_PRIVATE), log: o => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o })) });
server.listen(port, process.env.EGRESS_HOST ?? "0.0.0.0", () => console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "egress proxy listening", port, allow })));
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => server.close(() => process.exit(0)));
