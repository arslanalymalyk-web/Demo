import { expect, test } from "@playwright/test";
import { go, signIn, watch } from "./helpers.js";

test.describe("readiness", () => {
  test("lists what is done, what needs a decision and what only a person can confirm", async ({ page }) => {
    const w = watch(page); await signIn(page, "admin1"); await go(page, "/readiness");
    await expect(page.getByRole("status").filter({ hasText: /Nothing blocks use\./ })).toBeVisible();
    const item = (title: string) => page.locator("li").filter({ has: page.getByText(title, { exact: true }) });
    await expect(item("Two administrators").getByText("Done")).toBeVisible();
    await expect(item("Decision policy in force").getByText("Done")).toBeVisible();
    await expect(item("Audit chain intact").getByText("Done")).toBeVisible();
    await expect(item("Map geography loaded").getByText("Needs a decision")).toBeVisible();
    await expect(item("Independent penetration test").getByText("Confirm by hand")).toBeVisible();
    await expect(item("Malware scanner").getByText("Done")).toBeVisible();
    await item("Map geography loaded").getByRole("link", { name: "Open" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Map" })).toBeVisible();
    expect(w.problems).toEqual([]);
  });

  test("is for administrators and auditors, not for everyone", async ({ page }) => {
    await signIn(page, "ana");
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Readiness" })).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page, "aud");
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Readiness" })).toBeVisible();
  });
});
