import { beforeEach, describe, expect, it } from "vitest";
import { ar } from "../../apps/web/src/i18n-ar.js";
import { date, dateTime, month, num } from "../../apps/web/src/format.js";
import { lang, locale, setLang, t, tx } from "../../apps/web/src/i18n.js";
// @ts-expect-error the extractor is a plain script
import { arabic, scan } from "../../scripts/i18n.mjs";

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort();
const ARABIC_LETTER = /[؀-ۿ]/;

describe("Arabic wording", () => {
  it("covers every message the interface marks for translation", async () => {
    const keys: Map<string, Set<string>> = scan(), dict: Record<string, string> = await arabic();
    const missing = [...keys.keys()].filter(k => !dict[k]);
    expect(missing, `no Arabic for: ${missing.slice(0, 5).join(" | ")}`).toEqual([]);
    expect(keys.size).toBeGreaterThan(300);
  });
  it("keeps every placeholder, and has no entry that nothing uses", async () => {
    const keys: Map<string, Set<string>> = scan();
    for (const [k, v] of Object.entries(ar)) {
      expect(placeholders(v), `placeholders differ for "${k}"`).toEqual(placeholders(k));
      expect(v.trim(), `empty Arabic for "${k}"`).not.toBe("");
      expect(ARABIC_LETTER.test(v), `no Arabic letters in the wording for "${k}"`).toBe(true);
      expect(keys.has(k), `"${k}" is in the dictionary but no screen uses it`).toBe(true);
    }
  });
  it("never lets Arabic wording carry markup or a raw digit style that would change a figure", () => {
    for (const [k, v] of Object.entries(ar)) {
      expect(v, k).not.toMatch(/[<>]/);
      expect(v, k).not.toMatch(/[٠-٩۰-۹]/); // numbers keep Western digits, so a figure reads exactly as stored
    }
  });
});

describe("translation at run time", () => {
  beforeEach(() => setLang("en"));
  it("returns the English text in English and Arabic in Arabic, and falls back to English for an unknown message", () => {
    expect(t("Sign out")).toBe("Sign out");
    setLang("ar");
    expect(lang()).toBe("ar");
    expect(t("Sign out")).toBe("تسجيل الخروج");
    expect(t("A message nobody translated yet")).toBe("A message nobody translated yet");
    expect(tx("Sign out")).toBe("Sign out");
  });
  it("fills placeholders in either language, and leaves an unknown placeholder visible rather than blank", () => {
    expect(t("{n} events verified", { n: 25 })).toBe("25 events verified");
    setLang("ar");
    expect(t("{n} events verified", { n: 25 })).toBe("تم التحقق من 25 حدثاً");
    expect(t("{n} events verified", {})).toContain("{n}");
  });
  it("uses Arabic month names but Western digits, and leaves numbers exactly as in English", () => {
    expect(locale()).toBe("en-GB");
    const en = { d: date("2026-07-01T00:00:00Z"), m: month("2026-07-01T00:00:00Z"), n: num(1234.5, 1) };
    setLang("ar");
    expect(locale()).toBe("ar-SA-u-nu-latn-ca-gregory");
    expect(month("2026-07-01T00:00:00Z")).toMatch(/يوليو/);
    expect(month("2026-07-01T00:00:00Z")).toMatch(/2026/);
    expect(date("2026-07-01T00:00:00Z")).toMatch(/^[؀-ۿ\d\s/،.\-]+$/);
    expect(dateTime("2026-07-01T09:30:00Z")).toContain("UTC");
    expect(num(1234.5, 1)).toBe(en.n);
    expect(en.d).not.toBe(date("2026-07-01T00:00:00Z"));
  });
});
