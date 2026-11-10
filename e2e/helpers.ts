import { expect, type ConsoleMessage, type Page } from "@playwright/test";

/** Signs in through the local identity provider, with the authorization code flow and PKCE exactly as the product does. */
export async function signIn(page: Page, subject: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.getByLabel("Subject").fill(subject);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}

/** Collects what a person would never see but a developer must: script errors, console errors and failed requests to this application. */
export function watch(page: Page): { problems: string[] } {
  const problems: string[] = [];
  page.on("pageerror", e => problems.push(`script error: ${e.message}`));
  page.on("console", (m: ConsoleMessage) => { if (m.type() === "error") problems.push(`console error: ${m.text()}`); });
  page.on("response", r => { const u = new URL(r.url()); if (u.hostname === "127.0.0.1" && r.status() >= 400 && !u.pathname.startsWith("/.well-known")) problems.push(`${r.status()} ${r.request().method()} ${u.pathname}`); });
  return { problems };
}

export const go = async (page: Page, hash: string) => { await page.goto(`/#${hash}`); await expect(page.locator("main#main")).toBeVisible(); };
