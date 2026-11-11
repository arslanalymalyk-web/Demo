import { expect, test } from "@playwright/test";
import { go, signIn, watch } from "./helpers.js";

test.describe("alerts", () => {
  test("lets an administrator see how alerts are sent, send a test, and read the message log", async ({ page }) => {
    const w = watch(page); await signIn(page, "admin1"); await go(page, "/alerts");
    await expect(page.getByText(/Alerts are sent by a log only \(development\)/)).toBeVisible();
    await page.getByRole("button", { name: "Send a test to me" }).click();
    await expect(page.getByRole("status").filter({ hasText: "A test message was sent to your address." })).toBeVisible();
    const log = page.getByRole("region", { name: "Alert messages" });
    await expect(log.getByRole("row", { name: /admin1.*test.*Sent/ })).toBeVisible();
    await expect(page.getByText("@e2e.example")).toHaveCount(1); // only the administrator's own address field shows a full address; the log shows names
    expect(w.problems).toEqual([]);
  });

  test("lets an administrator set and remove a person's address, with a clear refusal for a bad one", async ({ page }) => {
    await signIn(page, "admin1"); await go(page, "/alerts");
    const field = page.getByLabel("Email address of ana"), row = page.getByRole("row").filter({ has: field });
    await field.fill("not an address"); await row.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /not a valid email address|invalid/i })).toBeVisible();
    await field.fill("ana@e2e.example"); await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("button", { name: "Remove address" })).toBeVisible();
    await row.getByRole("button", { name: "Remove address" }).click();
    await expect(field).toHaveValue("");
  });

  test("lets everyone switch off the optional notices but never the security ones", async ({ page }) => {
    await signIn(page, "admin1"); await go(page, "/alerts");
    const mine = page.locator("section", { hasText: "My alerts" }).first();
    await expect(mine.getByText(/Notices go to a\*\*\*@e2e\.example|Notices go to .*@e2e\.example/)).toBeVisible();
    await expect(mine.getByRole("checkbox", { name: "Malware flagged" })).toBeDisabled();
    await expect(mine.getByRole("checkbox", { name: "Operations" })).toBeDisabled();
    const source = mine.getByRole("checkbox", { name: "Data source" });
    await source.click(); await expect(source).not.toBeChecked();
    await page.getByRole("button", { name: "Sign out" }).click(); await signIn(page, "admin1"); // the choice is kept on the server, not in the browser
    await go(page, "/alerts"); await expect(page.locator("section", { hasText: "My alerts" }).first().getByRole("checkbox", { name: "Data source" })).not.toBeChecked();
  });

  test("shows an analyst only their own settings, and an auditor the log without the address list", async ({ page }) => {
    await signIn(page, "ana"); await go(page, "/alerts");
    await expect(page.getByText("You have no email address set, so no notice can reach you.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Email addresses" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Messages" })).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await signIn(page, "aud"); await go(page, "/alerts");
    await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Email addresses" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send a test to me" })).toHaveCount(0);
  });
});
