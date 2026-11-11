import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Text and its background must reach WCAG AA (4.5:1) in both themes. The colours are read from the stylesheet, so a change that breaks contrast fails here.
const css = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");
const block = (start: string, end?: string) => { const a = css.indexOf(start), b = end ? css.indexOf(end, a + 1) : css.indexOf("}", a); return css.slice(a, b); };
const tokens = (b: string): Record<string, string> => Object.fromEntries([...b.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1]!, m[2]!]));
const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

const root = tokens(block(":root", ':root[data-theme="navy"]')), navy = { ...root, ...tokens(block(':root[data-theme="navy"]')) };
const PAIRS: [string, string][] = [["ink", "paper"], ["ink", "ivory"], ["ink-2", "paper"], ["ink-2", "ivory"], ["ink-3", "paper"], ["ink-3", "ivory"], ["emerald", "paper"], ["emerald", "ivory"], ["emerald", "emerald-soft"], ["red", "red-soft"], ["red", "paper"], ["amber", "amber-soft"], ["amber", "paper"], ["gold-ink", "gold-soft"], ["gold-ink", "paper"], ["teal", "teal-soft"], ["teal", "paper"], ["rail-ink", "rail"], ["rail-dim", "rail"]];

describe("colour contrast", () => {
  for (const [name, t] of [["ivory", root], ["navy", navy]] as const) {
    it(`meets 4.5:1 for every text and background pair in the ${name} theme`, () => {
      const low = PAIRS.map(([a, b]) => ({ a, b, r: ratio(t[a]!, t[b]!) })).filter(x => x.r < 4.5).map(x => `${x.a} on ${x.b} is ${x.r.toFixed(2)}`);
      expect(low).toEqual([]);
    });
  }
});
