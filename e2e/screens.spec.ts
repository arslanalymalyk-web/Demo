import { expect, test } from "@playwright/test";
import { accessibilityBasics, go, signIn, watch } from "./helpers.js";

// Every screen, opened by a person who may use all of them. A screen passes when it renders its heading,
// raises no script or console error, makes no failed request, does not scroll sideways, and meets the basic accessibility checks below.
export const SCREENS: [string, string, string][] = [
  ["/", "Command Centre", "home"], ["/sector/energy", "Energy and Oil", "energy centre"], ["/sector/sovereign", "Sovereign Capital and Treasury", "sovereign centre"],
  ["/briefing/energy", "Briefing: Energy and Oil", "energy briefing"], ["/briefing/sovereign", "Briefing: Sovereign Capital and Treasury", "sovereign briefing"],
  ["/source-health", "Source health", "source health"], ["/sources", "Data & Sources", "sources"], ["/evidence", "Evidence", "evidence"], ["/documents", "Documents", "documents"],
  ["/series", "Series", "series"], ["/map", "Map", "map"], ["/graph", "Graph", "graph"], ["/scenarios", "Scenarios", "scenarios"], ["/cases", "Cases", "cases"],
  ["/handoffs", "Handoffs", "handoffs"], ["/memory", "Institutional Memory", "memory"], ["/policy", "Policy", "policy"], ["/settings", "Settings", "settings"],
  ["/assistant", "Assistant", "assistant"], ["/retention", "Retention", "retention"], ["/audit", "Audit", "audit"], ["/readiness", "Readiness", "readiness"], ["/admin", "Administration", "administration"],
];

test.describe("every screen", () => {
  test("opens cleanly at desktop width for a person who may use it all", async ({ page }) => {
    test.setTimeout(180_000);
    const w = watch(page); await signIn(page, "root");
    for (const [hash, heading, name] of SCREENS) {
      await go(page, hash);
      await expect(page.getByRole("heading", { level: 1, name: heading }), name).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await accessibilityBasics(page, name), name).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} scrolls sideways`).toBe(true);
    }
    expect(w.problems).toEqual([]);
  });

  test("fits a phone, in both reading directions", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "root");
    for (const dir of ["LTR", "RTL"]) {
      await page.getByRole("button", { name: dir, exact: true }).click();
      for (const [hash, heading, name] of SCREENS) {
        await go(page, hash); await expect(page.getByRole("heading", { level: 1, name: heading }), name).toBeVisible(); await page.waitForLoadState("networkidle");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} scrolls sideways at 390 px, ${dir}`).toBe(true);
      }
    }
  });

  test("can be used with the keyboard alone: skip link, focus on the page after a move, and a visible focus mark", async ({ page }) => {
    await signIn(page, "ana");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Cases" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Cases" })).toBeVisible();
    await expect(page.locator("main#main")).toBeFocused();
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Evidence" }).focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab"); // keyboard focus, as a keyboard user would arrive
    const outline = await page.evaluate(() => { const s = getComputedStyle(document.activeElement!); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow }; });
    expect(outline.style !== "none" && outline.width > 0 || outline.shadow !== "none").toBe(true);
  });
});
