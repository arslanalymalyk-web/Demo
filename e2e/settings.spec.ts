import { expect, test } from "@playwright/test";
import { go, signIn, watch } from "./helpers.js";

test.describe.serial("governed settings", () => {
  test("one administrator drafts a change and cannot approve it", async ({ page }) => {
    const w = watch(page); await signIn(page, "admin1"); await go(page, "/settings");
    await page.getByLabel("Why this change (recorded with the version)").fill("Working thresholds agreed for the end-to-end run");
    await page.getByRole("button", { name: "Save as draft" }).click();
    const table = page.getByRole("region", { name: "Settings versions" });
    await expect(table.locator(".badge", { hasText: "Draft" })).toBeVisible();
    await expect(table.getByText("Another administrator must activate")).toBeVisible();
    await expect(table.getByRole("button", { name: "Activate" })).toHaveCount(0);
    expect(w.problems).toEqual([]);
  });

  test("a different administrator activates it, and every briefing then names the version", async ({ page }) => {
    await signIn(page, "admin2"); await go(page, "/settings");
    await page.getByRole("region", { name: "Settings versions" }).getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText("Version 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Settings versions" }).locator(".badge", { hasText: "Active" })).toBeVisible();
    await go(page, "/briefing/energy");
    await expect(page.getByText(/settings v1/)).toBeVisible();
  });

  test("a role that may only read cannot draft", async ({ page }) => {
    await signIn(page, "ana"); await go(page, "/settings");
    await expect(page.getByText("Your role can read settings but not change them.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save as draft" })).toHaveCount(0);
  });

  test("every settings tab fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); await signIn(page, "admin1");
    for (const tab of ["Signal thresholds", "Scenario defaults", "Hormuz exposure", "Ingestion schedule"]) {
      await go(page, "/settings"); await page.getByRole("tab", { name: tab }).click(); await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tab} scrolls sideways`).toBe(true);
    }
  });
});
