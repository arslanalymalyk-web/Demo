import { expect, test } from "@playwright/test";
import { signIn, watch } from "./helpers.js";

test.describe("sign-in", () => {
  test("sends a visitor to the identity provider and back, keeping the token in memory only", async ({ page }) => {
    const w = watch(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "TIGERIS" })).toBeVisible();
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/127\.0\.0\.1:4011\/authorize/);
    await page.getByLabel("Subject").fill("ana");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Command Centre" })).toBeVisible();
    await expect(page.getByText("End-to-end Institution")).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no signed token anywhere the browser persists
    expect(w.problems).toEqual([]);
  });

  test("refuses a person the identity provider knows but the institution has not provisioned", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.getByLabel("Subject").fill("stranger");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText(/not been given access/i)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  });

  test("shows only what a role may use, and signs out", async ({ page }) => {
    await signIn(page, "ops");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Source health" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Administration" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Audit" })).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });
});
