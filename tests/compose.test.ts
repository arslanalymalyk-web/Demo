import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Svc = { networks?: string[]; ports?: string[]; environment?: Record<string, string>; profiles?: string[]; entrypoint?: string[]; cap_drop?: string[] };
const file = (n: string) => parse(readFileSync(new URL(`../deploy/compose/${n}`, import.meta.url), "utf8"), { merge: true }) as { networks: Record<string, { internal?: boolean }>; services: Record<string, Svc> };
const c = file("docker-compose.yml");

describe("the deployment's network shape", () => {
  it("has an internal backend and exactly one way out", () => {
    expect(c.networks.backend?.internal).toBe(true);
    expect(c.networks.egress?.internal).toBeFalsy();
    expect(Object.keys(c.networks).sort()).toEqual(["backend", "egress"]); // the old unrestricted identity-provider network is gone
  });
  it("puts only the egress proxy, the scanner's signature refresh and the web proxy's public side outside the backend", () => {
    const outside = Object.entries(c.services).filter(([, s]) => (s.networks ?? []).some(n => n !== "backend")).map(([k]) => k).sort();
    expect(outside).toEqual(["clamav", "egress-proxy", "proxy"]);
    expect(c.services.proxy!.networks).toEqual(["backend", "default"]);
    expect(c.services.clamav!.networks).toEqual(["backend", "egress"]);
    expect(c.services["egress-proxy"]!.networks).toEqual(["backend", "egress"]);
  });
  it("sends the API, set-up and ingest through the proxy, with nothing else to reach", () => {
    for (const k of ["app", "setup", "ingest"]) {
      expect(c.services[k]!.networks, k).toEqual(["backend"]);
      expect(c.services[k]!.environment!.HTTPS_PROXY, k).toBe("http://egress-proxy:3128");
    }
    expect(c.services.app!.environment!.NODE_USE_ENV_PROXY).toBe("1");
    expect(c.services.app!.environment!.NO_PROXY).toContain("db");
  });
  it("publishes only the web proxy, refuses to start without an allowlist, and drops capabilities", () => {
    expect(Object.entries(c.services).filter(([, s]) => s.ports).map(([k]) => k)).toEqual(["proxy"]);
    expect(c.services["egress-proxy"]!.environment!.EGRESS_ALLOW).toMatch(/:\?/);
    for (const k of ["app", "egress-proxy", "proxy", "db"]) expect(c.services[k]!.cap_drop ?? [], k).toEqual(expect.arrayContaining(["ALL"]));
  });
  it("keeps the key overlay to secrets and one checkpoint mount", () => {
    const k = file("docker-compose.keys.yml");
    expect(Object.keys(k.services)).toEqual(["app"]);
    expect(JSON.stringify(k)).toContain("TIGERIS_DOCUMENT_KEY_FILE"); expect(JSON.stringify(k)).not.toMatch(/key[:=] ?['"]?[A-Za-z0-9+/]{30,}/);
  });
});
