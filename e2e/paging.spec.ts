import { expect, test } from "@playwright/test";
import { go, signIn, watch } from "./helpers.js";

test.describe("long lists", () => {
  test("shows the first page of cases, loads the rest on request, and searches", async ({ page }) => {
    const w = watch(page); await signIn(page, "ana"); await go(page, "/cases");
    const rows = page.getByRole("region", { name: "Cases" }).getByRole("row");
    await expect(page.getByText(/^Showing 50 of \d+$/)).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    await expect(page.getByText(/^Showing (\d+) of \1$/)).toBeVisible();
    await expect.poll(async () => await rows.count()).toBeGreaterThan(55);
    await page.getByLabel("Search by title or key").fill("Paging check 07");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("Showing 1 of 1")).toBeVisible();
    await expect(page.getByRole("link", { name: /Paging check 07/ })).toBeVisible();
    expect(w.problems).toEqual([]);
  });

  test("filters documents and evidence without errors", async ({ page }) => {
    const w = watch(page); await signIn(page, "ana");
    await go(page, "/documents");
    await page.getByLabel("Narrow the list by title").fill("no such document");
    await page.getByRole("button", { name: "Filter" }).click();
    await expect(page.getByText(/Showing 0 of 0|No documents|Nothing/i).first()).toBeVisible();
    await go(page, "/evidence");
    await expect(page.getByText(/^Showing \d+ of \d+$/)).toBeVisible();
    expect(w.problems).toEqual([]);
  });
});
