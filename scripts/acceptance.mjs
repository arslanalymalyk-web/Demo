// Acceptance run for a deployment: checks what can be checked from outside, and records evidence for what a person must do.
//   node scripts/acceptance.mjs --api https://tigeris.client.example [--web https://tigeris.client.example] --token <administrator token> [--auditor-token <token>] [--analyst-token <token>]
//        [--eicar] [--mail-test] [--evidence egress=egress.txt --evidence restore-drill=drill.txt --evidence pentest=report.pdf ...] [--out folder] [--environment "client production"] [--sign-key release-signing.key]
// It never disables TLS verification (trust a private CA with NODE_EXTRA_CA_CERTS). --eicar uploads the standard harmless anti-virus test string as an institution document: it leaves one permanent, quarantined record. --mail-test sends one test message to the signed-in administrator.
// A report lists each check as PASS, FAIL, SKIP (not configured or not asked for) or OPEN (a manual item with no evidence yet). Evidence files are recorded by their SHA-256; this script does not judge them.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";
import { signManifest } from "./release-lib.mjs";

const a = process.argv.slice(2), has = f => a.includes(f), opt = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; }, all = n => a.flatMap((x, i) => x === `--${n}` ? [a[i + 1]] : []);
const api = (opt("api") ?? "").replace(/\/$/, ""), web = (opt("web") ?? "").replace(/\/$/, ""), token = opt("token"), auditor = opt("auditor-token"), analyst = opt("analyst-token");
if (!api) { console.error("usage: --api <url> [--web <url>] --token <administrator token> ... (see the top of this file)"); process.exit(2); }
const results = [];
const add = (id, title, status, detail = "") => { results.push({ id, title, status, detail }); console.log(`${status.padEnd(4)}  ${title}${detail ? ` - ${detail}` : ""}`); };
const call = async (path, tok, init = {}) => { try { const r = await fetch(api + path, { ...init, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000) }); let body = null; try { body = await r.clone().json(); } catch { /* not json */ } return { status: r.status, body, headers: r.headers }; } catch (e) { return { status: 0, body: null, error: e.cause?.code ?? e.message, headers: new Headers() }; } };
const jwt = t => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); } catch { return null; } };

// 1. The service answers, and says what it is ready for.
const ready = await call("/ready");
add("api.ready", "The API answers and is ready", ready.status === 200 ? "PASS" : "FAIL", ready.status === 200 ? `scanner: ${ready.body?.scanner ?? "unknown"}` : `status ${ready.status} ${ready.error ?? ""}`);

// 2. Transport security of the public address.
if (web) {
  const u = new URL(web), port = Number(u.port || 443);
  const probe = (min, max) => new Promise(resolve => { const s = tls.connect({ host: u.hostname, port, servername: u.hostname, minVersion: min, maxVersion: max, rejectUnauthorized: true }, () => { const c = s.getPeerCertificate(); const v = s.getProtocol(); s.destroy(); resolve({ ok: true, v, days: Math.floor((Date.parse(c.valid_to) - Date.now()) / 86_400_000) }); }); s.on("error", e => resolve({ ok: false, error: e.code ?? e.message })); s.setTimeout(8000, () => { s.destroy(); resolve({ ok: false, error: "timeout" }); }); });
  const [old, modern] = [await probe("TLSv1", "TLSv1.1"), await probe("TLSv1.2", "TLSv1.3")];
  add("web.tls", "TLS 1.2 or 1.3 with a certificate this machine trusts, and nothing older", modern.ok && !old.ok ? "PASS" : "FAIL", modern.ok ? `${modern.v}; older protocols ${old.ok ? "ACCEPTED" : "refused"}; certificate valid for ${modern.days} more days` : `could not connect: ${modern.error}`);
  if (modern.ok && modern.days < 14) add("web.cert", "The certificate has at least 14 days left", "FAIL", `${modern.days} days`);
  try { const r = await fetch(web + "/", { signal: AbortSignal.timeout(15000) }); const h = r.headers; const miss = ["strict-transport-security", "content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"].filter(x => !h.get(x)); add("web.headers", "Security headers are present", r.ok && !miss.length ? "PASS" : "FAIL", miss.length ? `missing: ${miss.join(", ")}` : "HSTS, CSP, nosniff, frame and referrer policy"); const cfg = await (await fetch(web + "/config.js")).text(); add("web.config", "The web app was given its identity-provider settings", /oidcAuthority: "https:\/\//.test(cfg) ? "PASS" : "FAIL", /oidcAuthority/.test(cfg) ? "" : "config.js is empty; the proxy did not write its settings"); } catch (e) { add("web.headers", "Security headers are present", "FAIL", e.cause?.code ?? e.message); }
} else add("web.tls", "Transport security of the public address", "SKIP", "no --web address given");

// 3. Signed in with the institution's identity provider.
if (!token) add("idp.signin", "An administrator signed in through the identity provider", "SKIP", "no --token given");
else {
  const c = jwt(token), mfa = c && ((Array.isArray(c.amr) && c.amr.some(x => ["mfa", "otp", "hwk", "swk"].includes(x))) || (typeof c.acr === "string" && /mfa|2fa|loa[2-9]/i.test(c.acr)));
  const me = await call("/v1/identity/me", token);
  add("idp.signin", "An administrator signed in through the identity provider", me.status === 200 && me.body?.roles?.includes("administrator") ? "PASS" : "FAIL", me.status === 200 ? `${me.body.subject}; emergency access: ${me.body.emergencyAccess ? "YES (this is not a normal sign-in)" : "no"}` : `status ${me.status}`);
  add("idp.mfa", "The token carries a multi-factor claim", mfa ? "PASS" : "FAIL", c ? (mfa ? "amr/acr says so" : "no multi-factor claim in the token") : "the token could not be read");
  const rd = await call("/v1/readiness", token);
  if (rd.status === 200) { const f = rd.body.checks.filter(x => x.status === "fail"), w = rd.body.checks.filter(x => x.status === "warn"); add("readiness", "The Readiness screen has no failures", f.length ? "FAIL" : "PASS", f.length ? f.map(x => x.title).join("; ") : `${w.length} warning(s)${w.length ? ": " + w.map(x => x.title).join("; ") : ""}`); } else add("readiness", "The Readiness screen has no failures", "FAIL", `status ${rd.status}`);
  const bk = rd.body?.checks?.find(x => x.id === "base_backup"); add("backup.monitor", "Base backups are recorded and recent", bk ? (bk.status === "pass" ? "PASS" : "FAIL") : "SKIP", bk?.detail ?? "");
  const ep = await call("/v1/lockdown", token); add("lockdown.state", "The emergency stop is off", ep.status === 200 && ep.body.locked === false ? "PASS" : "FAIL", ep.status === 200 ? (ep.body.locked ? `locked down: ${ep.body.reason}` : "") : `status ${ep.status}`);
}
// 4. The audit trail.
const at = auditor ?? token;
if (!at) add("audit.chain", "The audit chain verifies", "SKIP", "no token given");
else { const v = await call("/v1/audit/verify", at); add("audit.chain", "The audit chain verifies", v.status === 200 ? (v.body.ok ? "PASS" : "FAIL") : v.status === 403 ? "SKIP" : "FAIL", v.status === 200 ? `${v.body.events} events` : v.status === 403 ? "give --auditor-token (the administrator role cannot verify)" : `status ${v.status}`);
  const cp = await call("/v1/audit/checkpoint", at); if (cp.status === 200) { const vr = await call("/v1/audit/checkpoint/verify", at, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cp.body) }); add("audit.checkpoint", "A signed checkpoint can be taken and verified", vr.body?.ok ? "PASS" : "FAIL", vr.body?.detail ?? ""); } else add("audit.checkpoint", "A signed checkpoint can be taken and verified", "SKIP", cp.status === 409 ? "TIGERIS_AUDIT_ANCHOR_KEY is not set" : `status ${cp.status}`); }
// 5. Mail and the malware scanner, for real.
if (has("--mail-test") && token) { const r = await call("/v1/alerts/test", token, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); add("mail.relay", "The mail relay accepted a test message", r.status === 200 ? "PASS" : "FAIL", r.status === 200 ? "sent to the signed-in administrator; confirm it arrived" : `status ${r.status} ${r.body?.message ?? ""}`); } else add("mail.relay", "The mail relay accepted a test message", "SKIP", "pass --mail-test to send one");
if (has("--eicar") && analyst) { const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"; const r = await call("/v1/documents", analyst, { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": "acceptance-eicar.txt", "x-title": "Acceptance scanner test", "x-data-class": "institution_own", "x-rights": "Anti-virus test string, no rights concerns" }, body: eicar }); add("scanner.real", "The malware scanner flagged the anti-virus test string", r.body?.scanStatus === "infected" || r.body?.status === "quarantined" ? "PASS" : "FAIL", `status ${r.status}, scan ${r.body?.scanStatus ?? "?"}`); } else add("scanner.real", "The malware scanner flagged the anti-virus test string", "SKIP", "pass --eicar and --analyst-token (leaves one quarantined record)");

// 6. Things a person does and proves. Each needs a file; the file is recorded by hash and not judged here.
const MANUAL = [["egress", "Egress boundary proven from inside the container (scripts/egress-check.mjs)"], ["restore-drill", "Backup restore drill run on this environment, official PostgreSQL image"], ["pentest", "Independent penetration test report"], ["break-glass", "Emergency sign-in drill with both custodians"], ["checkpoint-store", "Checkpoint folder shown to be unwritable by the database administrator"], ["release", "Signed release manifest verified (scripts/verify-release.mjs) for the images deployed"], ["tls-cert", "Certificate issued by the institution's CA for the public name"]];
const evidence = Object.fromEntries(all("evidence").map(x => { const i = x.indexOf("="); return [x.slice(0, i), x.slice(i + 1)]; }));
for (const [id, title] of MANUAL) { if (!evidence[id]) { add(`manual.${id}`, title, "OPEN", "no evidence file given (--evidence " + id + "=<file>)"); continue; } let h; try { h = createHash("sha256").update(readFileSync(evidence[id])).digest("hex"); } catch { add(`manual.${id}`, title, "FAIL", `cannot read ${evidence[id]}`); continue; } add(`manual.${id}`, title, "PASS", `evidence ${evidence[id]} sha256 ${h.slice(0, 16)}...`); results[results.length - 1].evidenceSha256 = h; }

const count = s => results.filter(r => r.status === s).length;
const verdict = count("FAIL") ? "NOT ACCEPTED" : count("OPEN") ? "INCOMPLETE" : "ACCEPTED";
const report = { format: "tigeris-acceptance-1", environment: opt("environment") ?? null, api, web: web || null, ranAt: new Date().toISOString(), verdict, counts: { PASS: count("PASS"), FAIL: count("FAIL"), SKIP: count("SKIP"), OPEN: count("OPEN") }, results };
const out = opt("out") ?? "acceptance"; mkdirSync(out, { recursive: true });
writeFileSync(`${out}/acceptance-report.json`, JSON.stringify(report, null, 2) + "\n");
writeFileSync(`${out}/acceptance-report.md`, `# Acceptance report\n\nEnvironment: ${report.environment ?? "(not named)"}  \nRun: ${report.ranAt}  \nResult: **${verdict}** (${report.counts.PASS} pass, ${report.counts.FAIL} fail, ${report.counts.SKIP} skipped, ${report.counts.OPEN} open)\n\n| Check | Result | Detail |\n|---|---|---|\n${results.map(r => `| ${r.title} | ${r.status} | ${String(r.detail).replace(/\|/g, "/")} |`).join("\n")}\n\nA PASS on a manual item means an evidence file was recorded, not that its content was judged.\n`);
if (opt("sign-key")) writeFileSync(`${out}/acceptance-report.sig`, signManifest(report, readFileSync(opt("sign-key"), "utf8")) + "\n");
console.log(`\n${verdict}: ${report.counts.PASS} pass, ${report.counts.FAIL} fail, ${report.counts.SKIP} skipped, ${report.counts.OPEN} open. Report in ${out}/`);
process.exit(report.counts.FAIL ? 1 : 0);
