import { expect, test, type Page } from "@playwright/test";
import { accessibilityBasics, go, signIn, watch } from "./helpers.js";

// The same screens as the English suite, in Arabic. Screens not yet translated still have to lay out right to left without errors.
const ALL = ["/", "/sector/energy", "/sector/sovereign", "/briefing/energy", "/briefing/sovereign", "/source-health", "/sources", "/evidence", "/documents", "/series", "/map", "/graph", "/scenarios", "/cases", "/handoffs", "/memory", "/policy", "/settings", "/assistant", "/retention", "/audit", "/readiness", "/admin"];
const TRANSLATED: [string, string][] = [["/", "مركز القيادة"], ["/sector/energy", "الطاقة والنفط"], ["/sector/sovereign", "رأس المال السيادي والخزينة"], ["/briefing/energy", "إحاطة: الطاقة والنفط"], ["/briefing/sovereign", "إحاطة: رأس المال السيادي والخزينة"], ["/source-health", "سلامة المصادر"], ["/assistant", "المساعد"], ["/readiness", "الجاهزية"]];
const toArabic = async (page: Page) => { await page.getByRole("button", { name: "العربية" }).click(); await expect(page.locator("html")).toHaveAttribute("lang", "ar"); };

test.describe("Arabic interface", () => {
  test("switches language and direction together, and remembers the choice", async ({ page }) => {
    await signIn(page, "ana");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await toArabic(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const nav = page.getByRole("navigation", { name: "التنقل الرئيسي" });
    await expect(nav.getByRole("link", { name: "مركز القيادة" })).toBeVisible();
    for (const text of await nav.getByRole("link").allTextContents()) expect(text, "every navigation entry is in Arabic").toMatch(/[؀-ۿ]/);
    await expect(page.getByText("analyst", { exact: false })).toHaveCount(0); // the role is shown in Arabic, not in the stored English key
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.getByRole("button", { name: "تسجيل الدخول عبر مؤسستك" })).toBeVisible();
    await page.getByRole("button", { name: /تسجيل الدخول/ }).click();
    await page.getByLabel("Subject").fill("ana"); await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation", { name: "التنقل الرئيسي" })).toBeVisible();
    await page.getByRole("button", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  test("translates the screens executives use, and leaves every figure exactly as stored", async ({ page }) => {
    await signIn(page, "root"); await toArabic(page);
    for (const [hash, heading] of TRANSLATED) { await go(page, hash); await expect(page.getByRole("heading", { level: 1, name: heading }), hash).toBeVisible(); await page.waitForLoadState("networkidle"); }
    await go(page, "/briefing/sovereign");
    await expect(page.getByText("SAR 940.0 billion")).toBeVisible(); // Western digits and the stored unit, the same as the English screen
    await expect(page.getByText(/Reserve assets fell 6\.0% in the quarter/)).toBeVisible(); // sentences computed from the records stay English in this release
    await expect(page.getByRole("heading", { name: "ما الذي تغيّر" })).toBeVisible();
    await expect(page.getByRole("button", { name: "حفظ نسخة" })).toBeVisible();
    await go(page, "/sector/energy");
    await expect(page.getByText("11,500")).toBeVisible();
    await expect(page.getByText("المملكة العربية السعودية")).toBeVisible();
  });

  test("keeps the Assistant working in Arabic, with Arabic labels and verified output", async ({ page }) => {
    await signIn(page, "ana"); await toArabic(page); await go(page, "/assistant");
    await page.getByRole("combobox", { name: /^ما المطلوب صياغته/ }).selectOption("summary_briefing");
    await page.getByRole("button", { name: "صياغة", exact: true }).click();
    await expect(page.getByText("تم التحقق", { exact: true })).toBeVisible();
    await expect(page.getByText(/صاغه نموذج ثم تحقق منه برنامج/)).toBeVisible();
  });

  test("lays every screen out right to left without errors, sideways scrolling or missing names", async ({ page }) => {
    test.setTimeout(240_000);
    const w = watch(page); await signIn(page, "root"); await toArabic(page);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const hash of ALL) {
        await go(page, hash); await expect(page.locator("main h1")).toHaveCount(1); await page.waitForLoadState("networkidle");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${hash} scrolls sideways at ${width} px`).toBe(true);
        if (width === 1280) expect(await accessibilityBasics(page, hash), hash).toEqual([]);
      }
    }
    expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe("rtl");
    expect(w.problems).toEqual([]);
  });
});
