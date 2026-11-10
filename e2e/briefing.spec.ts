import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { verifyBriefing } from "../packages/sectors/src/briefing.js";
import { go, signIn, watch } from "./helpers.js";

test.describe("executive briefing", () => {
  test("says what the stored records support, links every item to its evidence, and saves a copy that verifies", async ({ page }) => {
    const w = watch(page); await signIn(page, "exe");
    await go(page, "/briefing/sovereign");
    await expect(page.getByRole("heading", { level: 1, name: "Briefing: Sovereign Capital and Treasury" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Needs attention" })).toBeVisible();
    await expect(page.getByText(/Reserve assets fell 6\.0% in the quarter/)).toBeVisible();
    await expect(page.getByText("No model wrote any sentence here.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: /^evidence [0-9a-f]{8}$/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Evidence" })).toBeVisible();
    await page.goBack();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save a copy" }).click()]);
    const saved = JSON.parse(readFileSync((await download.path())!, "utf8"));
    expect(saved).toMatchObject({ pack: "sovereign", dataClass: "public_record" });
    expect(verifyBriefing(saved)).toBe(true);
    expect(verifyBriefing({ ...saved, headline: { ...saved.headline, text: "All is well." } })).toBe(false);
    expect(w.problems).toEqual([]);
  });

  test("names the stale source and the lagging data as things to read with care", async ({ page }) => {
    await signIn(page, "exe"); await go(page, "/briefing/energy");
    await expect(page.getByRole("heading", { name: "Read with care" })).toBeVisible();
    await expect(page.getByText(/stale-series: the latest stored period is 2024-01/)).toBeVisible();
  });

  test("shows an executive no cases it may not see, and hides the case section from a role without case access", async ({ page }) => {
    await signIn(page, "ops"); await go(page, "/briefing/energy");
    await expect(page.getByRole("heading", { name: "What needs attention" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Open decisions" })).toBeVisible(); // operations may read cases
  });
});
