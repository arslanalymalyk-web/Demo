import { expect, test } from "@playwright/test";
import { issueBreakGlassToken } from "../packages/identity/src/breakglass.js";
import { TEST_SHARE_A, TEST_SHARE_B } from "./emergency-shares.js";
import { go, signIn } from "./helpers.js";

test.describe("emergency sign-in and temporary access", () => {
  test("two custodians' token signs an administrator in without the identity provider, and says so on every screen", async ({ page }) => {
    const token = await issueBreakGlassToken({ shareA: TEST_SHARE_A, shareB: TEST_SHARE_B, subject: "admin1", actAsIssuer: "http://127.0.0.1:4011", minutes: 10, reason: "End-to-end drill of the emergency route" });
    await page.goto("/");
    await page.getByText("Emergency access").click();
    await page.getByLabel("Emergency token").fill("not a token");
    await page.getByRole("button", { name: "Use emergency token" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByLabel("Emergency token").fill(token);
    await page.getByRole("button", { name: "Use emergency token" }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "signed in with emergency access" })).toBeVisible();
    await go(page, "/admin");
    await expect(page.getByRole("status").filter({ hasText: "signed in with emergency access" })).toBeVisible();
  });

  test("an administrator can create a person whose access ends", async ({ page }) => {
    await signIn(page, "admin1"); await go(page, "/admin");
    await expect(page.getByLabel("Access ends (optional)")).toBeVisible();
    const when = new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 16);
    await page.getByLabel("Issuer").fill("http://127.0.0.1:4011"); await page.getByLabel("Subject", { exact: true }).fill("vendor-temp");
    await page.getByLabel("Access ends (optional)").fill(when);
    await page.getByRole("group", { name: "Roles", exact: true }).getByLabel("auditor").check();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Person added." })).toBeVisible();
    await expect(page.getByRole("row", { name: /vendor-temp/ }).getByText(/Access ends/)).toBeVisible();
  });
});
