// Finds every message the interface marks for translation, and reports which have no Arabic wording yet.
//   node scripts/i18n.mjs            lists keys with no Arabic entry (exit 1 if any)
//   node scripts/i18n.mjs --all      lists every key
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../apps/web/src/", import.meta.url).pathname;
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
const CALL = /\b(?:t|tx)\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g;
const unescape = s => s.replace(/\\(["'\\])/g, "$1").replace(/\\n/g, "\n");

export function scan() {
  const keys = new Map(); // key -> files
  for (const f of walk(ROOT)) {
    if (/i18n(-ar)?\.ts$/.test(f)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(CALL)) { const k = unescape(m[1] ?? m[2]); if (!keys.has(k)) keys.set(k, new Set()); keys.get(k).add(f.slice(ROOT.length)); }
  }
  return keys;
}
export async function arabic() {
  const src = readFileSync(join(ROOT, "i18n-ar.ts"), "utf8");
  const mod = await import("data:text/javascript;base64," + Buffer.from(src.replace(/^export const ar: Record<string, string> =/m, "export const ar =")).toString("base64"));
  return mod.ar;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const keys = scan(), ar = await arabic();
  const missing = [...keys.keys()].filter(k => !ar[k]);
  if (process.argv.includes("--all")) for (const k of keys.keys()) console.log(JSON.stringify(k));
  else { for (const k of missing) console.log(JSON.stringify(k)); console.error(`${keys.size} messages, ${missing.length} without Arabic`); }
  process.exit(missing.length && !process.argv.includes("--all") ? 1 : 0);
}
