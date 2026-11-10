import { locale } from "./i18n";
const nf = (d: number) => new Intl.NumberFormat("en", { maximumFractionDigits: d, minimumFractionDigits: d });
export const num = (v: number, d = 1): string => nf(d).format(v);
export const signed = (v: number, d = 1): string => (v > 0 ? "+" : v < 0 ? "−" : "") + nf(d).format(Math.abs(v));
export const pct = (v: number, d = 0): string => `${nf(d).format(v * 100)}%`;
/** Million US$ to a short, exact-unit label. */
export function musd(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? "−" : v > 0 ? "+" : "";
  return a >= 1000 ? `${sign}US$ ${nf(2).format(a / 1000)} bn` : `${sign}US$ ${nf(0).format(a)} m`;
}
export const date = (iso: string | null | undefined): string => iso ? new Date(iso).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—";
export const month = (iso: string): string => new Date(iso).toLocaleDateString(locale(), { year: "numeric", month: "short", timeZone: "UTC" });
export const dateTime = (iso: string): string => new Date(iso).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
export const short = (h: string, n = 10): string => h.slice(0, n);
export const ageDays = (iso: string, now = Date.now()): number => Math.floor((now - new Date(iso).getTime()) / 86_400_000);
export const titleCase = (s: string): string => s.replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());
