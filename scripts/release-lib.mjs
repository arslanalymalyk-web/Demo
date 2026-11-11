import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const FORMAT = "tigeris-release-1";
export const sha256 = buf => createHash("sha256").update(buf).digest("hex");
export const fileHash = path => sha256(readFileSync(path));
const sorted = o => Array.isArray(o) ? o.map(sorted) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sorted(o[k])])) : o;
/** The exact bytes that are signed: the manifest with its keys in order, so the same content always gives the same signature input. */
export const canonical = manifest => Buffer.from(JSON.stringify(sorted(manifest)));

export function keygen() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privatePem: privateKey.export({ format: "pem", type: "pkcs8" }), publicPem: publicKey.export({ format: "pem", type: "spki" }) };
}
export const signManifest = (manifest, privatePem) => sign(null, canonical(manifest), createPrivateKey(privatePem)).toString("base64");
export const verifyManifest = (manifest, signature, publicPem) => { try { return verify(null, canonical(manifest), createPublicKey(publicPem), Buffer.from(signature, "base64")); } catch { return false; } };

const PIN = /@sha256:[0-9a-f]{64}/;
/** Every image a release would pull: FROM lines and image: defaults. Each says whether it is pinned by digest. */
export function imageRefs(root) {
  const out = [];
  for (const f of ["Dockerfile", "deploy/db/Dockerfile"]) for (const l of readFileSync(join(root, f), "utf8").split("\n")) {
    const m = /^FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$/i.exec(l.trim()); if (m && !/^(deps|build|app|web)$/.test(m[1])) out.push({ file: f, ref: m[1], pinned: PIN.test(m[1]) });
  }
  for (const l of readFileSync(join(root, "deploy/compose/docker-compose.yml"), "utf8").split("\n")) { const m = /\bimage:\s*(\S+)/.exec(l); if (m) { const ref = m[1].replace(/^\$\{[A-Z_]+:-/, "").replace(/\}$/, ""); out.push({ file: "deploy/compose/docker-compose.yml", ref, pinned: PIN.test(ref) }); } }
  return out;
}

function dirHash(dir) { const h = createHash("sha256"); for (const f of readdirSync(dir).sort()) { h.update(f); h.update(readFileSync(join(dir, f))); } return h.digest("hex"); }

export function buildManifest({ root, version, commit, now = new Date(), builtImages = {}, bundle = null }) {
  const files = {};
  for (const f of ["pnpm-lock.yaml", "Dockerfile", "deploy/db/Dockerfile", "deploy/compose/docker-compose.yml"]) files[f] = fileHash(join(root, f));
  const sbomDir = join(root, "docs/handover/sbom");
  for (const f of readdirSync(sbomDir).sort()) if (statSync(join(sbomDir, f)).isFile()) files[`docs/handover/sbom/${f}`] = fileHash(join(sbomDir, f));
  if (bundle) files[`bundle/${bundle.name}`] = bundle.sha256;
  const mig = join(root, "db/migrations");
  return { format: FORMAT, version, commit, createdAt: now.toISOString(), files, migrations: { count: readdirSync(mig).filter(f => f.endsWith(".sql")).length, sha256: dirHash(mig) }, baseImages: imageRefs(root), builtImages };
}

/** Checks a manifest against a folder holding the same files. Files that are not present are reported as skipped, not as failures, so a client can check just what they received. */
export function checkFiles(manifest, root) {
  const problems = [], skipped = [];
  for (const [f, h] of Object.entries(manifest.files)) {
    if (f.startsWith("bundle/")) continue;
    let actual; try { actual = fileHash(join(root, f)); } catch { skipped.push(f); continue; }
    if (actual !== h) problems.push(`${f} does not match the manifest`);
  }
  try { const m = dirHash(join(root, "db/migrations")); if (m !== manifest.migrations.sha256) problems.push("db/migrations does not match the manifest"); } catch { skipped.push("db/migrations"); }
  return { problems, skipped };
}
