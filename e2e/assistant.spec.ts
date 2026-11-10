import { expect, test } from "@playwright/test";
import { go, signIn, watch } from "./helpers.js";

test.describe("assistant", () => {
  test("drafts a briefing summary, shows what the model was given, and cites stored evidence", async ({ page }) => {
    const w = watch(page); await signIn(page, "ana"); await go(page, "/assistant");
    await expect(page.getByText(/Connected: local_extractive/)).toBeVisible();
    await page.getByRole("combobox", { name: /^Pack/ }).selectOption("energy");
    await page.getByRole("button", { name: "Draft" }).click();
    await expect(page.getByText("Verified", { exact: true })).toBeVisible();
    await expect(page.getByText(/Drafted by a model, then checked by code/)).toBeVisible();
    await expect(page.getByRole("link", { name: /^F\d+ · evidence [0-9a-f]{8}$/ }).first()).toBeVisible();
    await page.getByText(/What the model was given/).click();
    await expect(page.getByText(/prompt [0-9a-f]{64}/)).toBeVisible();
    expect(w.problems).toEqual([]);
  });

  test("answers from stored facts, and refuses a question the records cannot answer", async ({ page }) => {
    await signIn(page, "ana"); await go(page, "/assistant");
    await page.getByRole("combobox", { name: /^What to draft/ }).selectOption("answer");
    await page.getByRole("textbox", { name: /^Question/ }).fill("How far are Saudi crude exports below their recent level?");
    await page.getByRole("button", { name: "Draft" }).click();
    await expect(page.getByText("Verified", { exact: true })).toBeVisible();
    await expect(page.getByText(/Saudi Arabia: crude exports \d+% below their recent level/).first()).toBeVisible();
    await page.getByRole("textbox", { name: /^Question/ }).fill("Describe the wheat harvest in Canada");
    await page.getByRole("button", { name: "Draft" }).click();
    await expect(page.getByText("Not supported by the records")).toBeVisible();
    await expect(page.getByText("Nothing from the model is shown.")).toBeVisible();
  });

  test("lets an auditor read the call log but not draft", async ({ page }) => {
    await signIn(page, "aud"); await go(page, "/assistant");
    await expect(page.getByText("Your role can read the call log but cannot draft.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Call log" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Model calls" }).getByRole("row")).not.toHaveCount(1);
  });
});
