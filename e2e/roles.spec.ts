import { expect, test } from "@playwright/test";
import { go, signIn } from "./helpers.js";

test.describe("granting authority", () => {
  test("a role that carries authority waits for a second administrator", async ({ page, browser, baseURL }) => {
    await signIn(page, "admin1"); await go(page, "/admin");
    const roles = page.getByRole("group", { name: "Roles for ops" });
    await roles.getByLabel("approver").click();
    await expect(page.getByRole("status").filter({ hasText: "approver is held until a second administrator approves it" })).toBeVisible();
    await expect(roles.getByLabel("approver")).not.toBeChecked();
    const card = page.locator(".card", { hasText: "Roles waiting for a second administrator" });
    await expect(card.getByRole("row", { name: /ops.*approver/ })).toBeVisible();
    // The person who asked cannot approve it.
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /second administrator must approve/ })).toBeVisible();

    const other = await browser.newContext({ baseURL }); const p2 = await other.newPage();
    try {
      await signIn(p2, "admin2"); await go(p2, "/admin");
      const c2 = p2.locator(".card", { hasText: "Roles waiting for a second administrator" });
      await c2.getByRole("button", { name: "Approve" }).click();
      await expect(p2.getByRole("status").filter({ hasText: "The role is now in effect" })).toBeVisible();
      await expect(p2.getByRole("group", { name: "Roles for ops" }).getByLabel("approver")).toBeChecked();
      // Taking authority away is immediate; leave the person as they were.
      await p2.getByRole("group", { name: "Roles for ops" }).getByLabel("approver").click();
      await expect(p2.getByRole("group", { name: "Roles for ops" }).getByLabel("approver")).not.toBeChecked();
    } finally { await other.close(); }
  });
});
