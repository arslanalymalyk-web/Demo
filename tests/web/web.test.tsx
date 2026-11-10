// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildAuthorizeUrl, pkceChallenge, randomString } from "../../apps/web/src/auth";
import { DataClass, LineChart, LinkClass, Status, Tornado } from "../../apps/web/src/components";
import { ageDays, musd, num, pct } from "../../apps/web/src/format";
import { NAV, parseRoute } from "../../apps/web/src/route";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
afterEach(cleanup);

describe("sign-in helpers", () => {
  it("derives the PKCE challenge exactly as RFC 7636 specifies", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("makes unguessable URL-safe random strings", () => {
    const a = randomString(), b = randomString();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
  it("builds an authorization request with S256 and no implicit flow", () => {
    const u = new URL(buildAuthorizeUrl("https://idp.example/authorize", { clientId: "web", redirectUri: "https://app.example/", state: "s", challenge: "c" }));
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: "web", code_challenge: "c", code_challenge_method: "S256", state: "s" });
  });
});

describe("routing and navigation", () => {
  it("parses known routes and rejects the rest", () => {
    expect(parseRoute("")).toEqual({ view: "home", id: null });
    expect(parseRoute("#/evidence/abc")).toEqual({ view: "evidence", id: "abc" });
    expect(parseRoute("#/scenarios/runs/r1")).toEqual({ view: "run", id: "r1" });
    expect(parseRoute("#/series/a%7Cb")).toEqual({ view: "series", id: "a|b" });
    expect(parseRoute("#/cases")).toEqual({ view: "cases", id: null });
    expect(parseRoute("#/cases/c1")).toEqual({ view: "case", id: "c1" });
    expect(parseRoute("#/documents")).toEqual({ view: "documents", id: null });
    expect(parseRoute("#/documents/d1")).toEqual({ view: "document", id: "d1" });
    expect(parseRoute("#/sector/energy")).toEqual({ view: "sector", id: "energy" });
    expect(parseRoute("#/sector/sovereign")).toEqual({ view: "sector", id: "sovereign" });
    expect(parseRoute("#/sector/banking").view).toBe("missing");
    expect(parseRoute("#/settings")).toEqual({ view: "settings", id: null });
    expect(parseRoute("#/map")).toEqual({ view: "map", id: null });
    expect(parseRoute("#/policy")).toEqual({ view: "policy", id: null });
    expect(parseRoute("#/scenarios/other").view).toBe("missing");
    expect(parseRoute("#/nope").view).toBe("missing");
  });
  it("ties every navigation item to a permission except the Command Centre", () => {
    expect(NAV.filter(n => n.need === null).map(n => n.label)).toEqual(["Command Centre"]);
    expect(NAV.find(n => n.label === "Administration")!.need).toBe("identity.read");
  });
});

describe("formatting", () => {
  it("formats money in the unit it states", () => {
    expect(musd(1395.57)).toBe("+US$ 1.40 bn");
    expect(musd(-40.87)).toBe("−US$ 41 m");
    expect(num(1234.5, 1)).toBe("1,234.5");
    expect(pct(0.432, 1)).toBe("43.2%");
    expect(ageDays("2026-01-01T00:00:00Z", Date.parse("2026-01-11T00:00:00Z"))).toBe(10);
  });
});

describe("components", () => {
  it("labels status and data class in words, never colour alone", () => {
    render(<><Status value="warned" /><Status value="pending_rights" /><DataClass value="public_record" /><DataClass value="sample_dataset" /><LinkClass value="assumed" /></>);
    for (const t of ["Warned", "Pending rights", "Public record", "Sample dataset", "Assumed"]) expect(screen.getByText(t)).toBeTruthy();
  });
  it("gives a chart a text description and an exact-value table", () => {
    render(<LineChart title="Brent" unit="US$ per barrel" points={[{ x: 1, y: 60, label: "Jan" }, { x: 2, y: 80, label: "Feb" }]} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/2 points from Jan \(60\.0\) to Feb \(80\.0\)/);
    fireEvent.click(screen.getByText("Table"));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("80.00")).toBeTruthy();
  });
  it("says so when a chart has nothing to show", () => {
    render(<LineChart title="x" unit="u" points={[]} />);
    expect(screen.getByText(/No observations/)).toBeTruthy();
  });
  it("describes sensitivity in text, with assumed parameters marked", () => {
    render(<Tornado base={100} unit="u" fmt={v => String(v)} rows={[{ name: "Duration", basis: "assumed", low: 120, high: 40 }, { name: "Flex", basis: "calibrated", low: 90, high: 110 }]} />);
    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toMatch(/Duration: 40 to 120/);
    expect(screen.getByText("Duration (assumed)")).toBeTruthy();
  });
});
