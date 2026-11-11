import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === "dist" ? [] : walk(p)) : /\.(ts|tsx|mjs)$/.test(f) ? [p] : []; });
const read = (p: string) => readFileSync(p, "utf8");

describe("configuration reference", () => {
  it("lists every environment variable the code reads", () => {
    const used = new Set<string>();
    for (const dir of ["apps", "packages", "scripts", "db"]) for (const f of walk(join(root, dir))) for (const m of read(f).matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)|env\["([A-Z][A-Z0-9_]+)"\]/g)) used.add((m[1] ?? m[2])!);
    const doc = read(join(root, "docs/handover/CONFIGURATION.md"));
    const missing = [...used].filter(v => !doc.includes(`\`${v}\``) && !doc.includes(`${v}\``) && !new RegExp(`\`[^\`]*${v}[^\`]*\``).test(doc));
    expect(missing, `read by the code but missing from docs/handover/CONFIGURATION.md: ${missing.join(", ")}`).toEqual([]);
    expect(used.size).toBeGreaterThan(40);
  });
  it("does not document a variable nothing reads", () => {
    const doc = read(join(root, "docs/handover/CONFIGURATION.md")), code = ["apps", "packages", "scripts", "db", "e2e", "tests", "deploy", "playwright.config.ts"].flatMap(d => { try { return statSync(join(root, d)).isDirectory() ? walk(join(root, d)) : [join(root, d)]; } catch { return []; } }).map(read).join("\n") + read(join(root, "deploy/compose/docker-compose.yml"));
    const names = [...doc.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map(m => m[1]!).filter(n => !["NODE_ENV"].includes(n));
    const unused = [...new Set(names)].filter(n => !code.includes(n) && !code.includes(n.replace(/_FILE$/, "")));
    expect(unused).toEqual([]);
  });
});
