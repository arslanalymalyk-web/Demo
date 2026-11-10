import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { go, signIn, watch } from "./helpers.js";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
async function upload(page: Page, name: string, body: string, expectNote = true) {
  await page.getByLabel("File").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
  await page.getByLabel(/Publishing agency/).fill("Test Agency");
  await page.getByLabel(/^Rights/).fill("Open licence for testing");
  await page.getByRole("button", { name: "Upload" }).click();
  if (expectNote) await expect(page.getByRole("status").filter({ hasText: /Uploaded|already stored/ })).toBeVisible();
}

test.describe("document intake and malware scanning", () => {
  test("reads a clean file and makes it searchable evidence", async ({ page }) => {
    const w = watch(page); await signIn(page, "ana"); await go(page, "/documents");
    await expect(page.getByText(/Malware scanner: local_stub/)).toBeVisible();
    const word = `kuwaitreport${randomUUID().slice(0, 8)}`;
    await upload(page, "monthly.txt", `Brent crude averaged 103.8 dollars per barrel. ${word}`);
    const row = page.getByRole("row", { name: /monthly\.txt/ });
    await expect(row.getByText("Ready")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Search inside documents").fill(word);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("region", { name: "Search results" }).getByText(word)).toBeVisible();
    expect(w.problems).toEqual([]);
  });

  test("flags a file the scanner rejects, and nothing can open or download it", async ({ page }) => {
    await signIn(page, "ana"); await go(page, "/documents");
    await upload(page, "invoice.txt", `${EICAR} ${randomUUID()}`, false);
    await expect(page.getByRole("alert").filter({ hasText: /flagged by the malware scanner/ })).toBeVisible();
    const row = page.getByRole("row", { name: /invoice\.txt/ });
    await expect(row.getByText("Malware flagged")).toBeVisible();
    await row.getByRole("link", { name: "invoice.txt" }).click();
    await expect(page.getByText(/flagged this file \(Eicar-Test-Signature\)/)).toBeVisible();
    await expect(page.getByText("Nothing in the system can release it.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: /download/i })).toHaveCount(0);
    const id = page.url().split("/").pop()!;
    const status = await page.evaluate(async docId => { const r = await fetch(`/api/v1/documents/${docId}/file`); return r.status; }, id);
    expect(status).toBe(401); // no token in the page's own request: the API never serves a file without one
  });

  test("keeps institution documents off and says why", async ({ page }) => {
    await signIn(page, "ana"); await go(page, "/documents");
    await expect(page.getByLabel("What kind of material is it?").locator("option")).toHaveText(["Public record", "Sample dataset"]);
    await expect(page.getByText(/Institution documents are switched off on this deployment/)).toBeVisible();
  });

  test("shows an executive the list but no upload form", async ({ page }) => {
    await signIn(page, "exe"); await go(page, "/documents");
    await expect(page.getByText("Your role can read documents but not add them.")).toBeVisible();
    await expect(page.getByLabel("File")).toHaveCount(0);
  });
});
