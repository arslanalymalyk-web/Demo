import { expect, test } from "@playwright/test";
import { go, signIn } from "./helpers.js";

test.describe("emergency stop and ending sessions", () => {
  test("an administrator starts a lockdown, ordinary screens refuse, and releasing it restores them", async ({ page }) => {
    await signIn(page, "admin1"); await go(page, "/admin");
    const card = page.getByRole("region", { name: "Emergency stop" }).or(page.locator(".card", { hasText: "Emergency stop" })).first();
    try {
      await card.getByLabel("Reason").fill("Containing a suspected incident");
      await card.getByRole("button", { name: "Start lockdown" }).click();
      await expect(card.getByText("Locked down: Containing a suspected incident")).toBeVisible();
      await go(page, "/evidence");
      await expect(page.getByRole("alert").filter({ hasText: /lockdown/i })).toBeVisible();
    } finally {
      await go(page, "/admin");
      const c2 = page.locator(".card", { hasText: "Emergency stop" }).first();
      await expect(c2.getByRole("button", { name: /Release lockdown|Start lockdown/ })).toBeVisible();
      if (await c2.getByRole("button", { name: "Release lockdown" }).isVisible()) {
        await c2.getByLabel("Reason").fill("Checked and secured");
        await c2.getByRole("button", { name: "Release lockdown" }).click();
        await expect(c2.getByText("Normal")).toBeVisible();
      }
    }
    await go(page, "/evidence");
    await expect(page.getByText(/^Showing \d+ of \d+$/)).toBeVisible();
  });

  test("an auditor can take a checkpoint and see it accepted", async ({ page }) => {
    await signIn(page, "aud"); await go(page, "/audit");
    await expect(page.getByText("Checkpoints")).toBeVisible();
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Take a checkpoint" }).click()]);
    await expect(page.getByText(/Checkpoint saved: \d+ events/)).toBeVisible();
    const cp = await (await import("node:fs/promises")).readFile(await file.path(), "utf8");
    await page.getByLabel("Check a saved checkpoint").fill(cp);
    await page.getByRole("button", { name: "Check it" }).click();
    await expect(page.getByText(/Nothing up to the checkpoint has changed/)).toBeVisible();
  });
});
