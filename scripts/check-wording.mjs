// Fails when forbidden words appear in project files. See CLAUDE.md for the rule and its exceptions.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const ROOT = process.cwd();
const FORBIDDEN = /\b(demos?|demonstrations?|demonstrat\w*|prototypes?|prototyp\w*|mocks?|mocked|mocking|mockups?|mvp|poc)\b/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "data"]);
const SKIP_FILES = new Set(["CLAUDE.md", "pnpm-lock.yaml", "scripts/check-wording.mjs"]);
const SKIP_PREFIX = ["docs/decisions/", "docs/adr/"];
const TEXT = /\.(ts|tsx|js|mjs|json|md|sql|yml|yaml|html|css|txt|sh)$/i;
const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name); const rel = relative(ROOT, full);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (SKIP_FILES.has(rel) || SKIP_PREFIX.some(p => rel.startsWith(p)) || !TEXT.test(name)) continue;
    if (FORBIDDEN.test(rel)) hits.push(`${rel}: file name`);
    readFileSync(full, "utf8").split("\n").forEach((line, i) => { const m = line.match(FORBIDDEN); if (m) hits.push(`${rel}:${i + 1}: "${m[0]}"`); });
  }
}
walk(ROOT);
if (hits.length) { console.error("Forbidden wording found:\n" + hits.join("\n")); process.exit(1); }
console.log("wording check passed");
