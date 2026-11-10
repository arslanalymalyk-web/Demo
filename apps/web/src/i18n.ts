import { ar } from "./i18n-ar";

/** The interface language. English text is the key: a missing Arabic entry shows the English, never a blank.
 *  Numbers keep Western digits in both languages so every figure reads exactly as it is stored. */
export type Lang = "en" | "ar";
const KEY = "tigeris.lang";
const read = (): Lang => { try { return localStorage.getItem(KEY) === "ar" ? "ar" : "en"; } catch { return "en"; } };
let current: Lang = read();

export const lang = (): Lang => current;
export function setLang(l: Lang): void {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage may be blocked */ }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}
/** Resolves a message at render time. {name} placeholders are filled from vars. */
export function t(s: string, vars?: Record<string, string | number>): string {
  const tpl = current === "ar" ? (ar[s] ?? s) : s;
  return vars ? tpl.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`)) : tpl;
}
/** Marks a message that is stored in a table and resolved later with t(). Identity at run time; the translation check reads it. */
export const tx = (s: string): string => s;
export const locale = (): string => current === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB";
