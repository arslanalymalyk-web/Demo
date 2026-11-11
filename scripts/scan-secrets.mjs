// Looks for secrets in tracked files before they reach a remote: private keys, cloud and token formats, connection strings with passwords, and long random values assigned to secret-like names.
// A hit that is a deliberate test value is allowed by naming its file and the matched text in scripts/secrets-allow.json, with a reason. Run:  node scripts/scan-secrets.mjs [--staged]
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

export const RULES = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ["API key (sk-)", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["bearer token literal", /\bBearer\s+[A-Za-z0-9._~+/-]{40,}={0,2}(?![A-Za-z0-9])/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/],
  ["connection string with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`$<>{}]+:(?!\$|\{|<|\*|x{3,}|password|change_?me|pass\b|ci\b|secret\b|\.\.\.)[^\s:@/'"`$<>{}]{6,}@[^\s'"`]+/i],
  ["secret assigned a long random value", /\b[A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_?KEY|TOKEN|PRIVATE_?KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?(?=[A-Za-z0-9+/_=-]{24,}["']?\s*(?:[,;]|$))(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?![A-Za-z0-9_]*_FILE)[A-Za-z0-9+/_=-]{24,}/i],
];

/** Findings in one text: [{ rule, line, text }]. */
export function scanText(text, allow = []) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (line.length > 2000) return;
    for (const [rule, re] of RULES) { const m = re.exec(line); if (m && !allow.some(a => m[0].includes(a))) out.push({ rule, line: i + 1, text: m[0].length > 60 ? m[0].slice(0, 57) + "..." : m[0] }); }
  });
  return out;
}

const SKIP = /(?:^|\/)(?:pnpm-lock\.yaml|.*\.(?:png|jpg|jpeg|gif|ico|woff2?|pdf|tsbuildinfo|geojson|zip|gz))$|^docs\/handover\/sbom\//;

export function scanRepo({ staged = false, root = process.cwd(), allowFile = new URL("./secrets-allow.json", import.meta.url) } = {}) {
  const allow = JSON.parse(readFileSync(allowFile, "utf8")).allow ?? [];
  const files = execFileSync("git", staged ? ["diff", "--cached", "--name-only", "--diff-filter=AM"] : ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const findings = [];
  for (const f of files) {
    if (SKIP.test(f)) continue;
    let size; try { size = statSync(`${root}/${f}`).size; } catch { continue; }
    if (size > 1_500_000) continue;
    const buf = readFileSync(`${root}/${f}`); if (buf.includes(0)) continue;
    const ok = allow.filter(a => a.file === f).map(a => a.contains);
    for (const x of scanText(buf.toString("utf8"), ok)) findings.push({ file: f, ...x });
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = scanRepo({ staged: process.argv.includes("--staged") });
  for (const f of found) console.error(`${f.file}:${f.line}  ${f.rule}: ${f.text}`);
  if (found.length) { console.error(`\nsecret scan failed: ${found.length} possible secret(s). Remove them, rotate anything real, or allow a deliberate test value in scripts/secrets-allow.json with a reason.`); process.exit(1); }
  console.log("secret scan passed");
}
