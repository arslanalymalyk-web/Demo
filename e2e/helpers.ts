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

/** What a screen reader and a keyboard user need, checked without a third-party rules engine. */
export async function accessibilityBasics(page: Page, name: string): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.querySelectorAll("h1").length !== 1) out.push(`expected one h1, found ${document.querySelectorAll("h1").length}`);
    if (document.querySelectorAll("main").length !== 1) out.push("expected one main landmark");
    if (!document.querySelector("nav[aria-label]")) out.push("no labelled navigation");
    if (document.documentElement.lang === "") out.push("the page has no language");
    const text = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    for (const b of document.querySelectorAll("button")) if (!text(b) && !b.getAttribute("aria-labelledby") && !b.title) out.push("a button has no name");
    for (const a of document.querySelectorAll("a[href]")) if (!text(a) && !a.getAttribute("aria-labelledby")) out.push(`a link has no name: ${a.getAttribute("href")}`);
    for (const i of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      const el = i as HTMLInputElement, labelled = el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.id && document.querySelector(`label[for="${el.id}"]`));
      if (!labelled) out.push(`a form field has no label (${el.tagName.toLowerCase()} ${el.type ?? ""})`);
    }
    for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt")) out.push("an image has no alt text");
    const ids = [...document.querySelectorAll("[id]")].map(e => e.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dup.length) out.push(`duplicate ids: ${[...new Set(dup)].join(", ")}`);
    for (const t of document.querySelectorAll("table")) if (!t.closest("[role=region][aria-label]") && !t.getAttribute("aria-label") && !t.querySelector("caption")) out.push("a table has no accessible name");
    return out;
  }).then(r => r.map(x => `${name}: ${x}`));
}

