import { expect, test } from "@playwright/test";
import { go, signIn, watch } from "./helpers.js";

test.describe("source health and cases from signals", () => {
  test("reads each source's health from the stored records and explains a stale one", async ({ page }) => {
    const w = watch(page); await signIn(page, "ops"); await go(page, "/source-health");
    await expect(page.getByText(/Scheduled fetching is not running in this deployment/)).toBeVisible();
    const table = page.getByRole("region", { name: "Source health" });
    const stale = table.getByRole("row", { name: /stale-source-e2e/ });
    await expect(stale.getByText("Stale", { exact: true })).toBeVisible();
    await expect(table.getByRole("row", { name: /energy-jodi-e2e/ }).getByText("Healthy")).toBeVisible();
    await stale.getByRole("button", { name: "stale-source-e2e" }).click();
    await expect(page.getByText(/stale-series: latest period is \d+ days old; this series allows 30/)).toBeVisible();
    await expect(page.getByRole("region", { name: /Recent runs of stale-source-e2e/ }).getByText("completed")).toBeVisible();
    await expect(stale.getByRole("button", { name: /Run now|Pause/ })).toHaveCount(0); // not scheduled: nothing to run or pause
    expect(w.problems).toEqual([]);
  });

  test("opens a case from a signal with its evidence attached, and does not open a second", async ({ page }) => {
    await signIn(page, "ana"); await go(page, "/sector/energy");
    const first = page.locator("li.signal").first();
    const title = (await first.locator("strong").first().textContent())!;
    await first.getByRole("button", { name: "Open a case" }).click();
    await expect(page).toHaveURL(/#\/cases\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/CASE-\d{4}/);
    await expect(page.getByText(title).first()).toBeVisible();
    await go(page, "/sector/energy");
    await expect(page.locator("li.signal").first().getByRole("link", { name: /^Case CASE-\d{4}/ })).toBeVisible();
    await go(page, "/briefing/energy");
    await expect(page.getByRole("link", { name: /^Case CASE-\d{4}$/ }).first()).toBeVisible();
  });
});
