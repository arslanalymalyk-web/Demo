// Checks a signed release manifest with the signer's public key, and (with --root) the files it lists.
//   node scripts/verify-release.mjs --public-key release-signing.pub --manifest release-manifest.json [--sig release-manifest.sig] [--root <unpacked release>]
import { readFileSync } from "node:fs";
import { checkFiles, verifyManifest } from "./release-lib.mjs";

const a = process.argv.slice(2), opt = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const pub = opt("public-key"), mf = opt("manifest"); if (!pub || !mf) { console.error("usage: --public-key <file> --manifest <file> [--sig <file>] [--root <folder>]"); process.exit(2); }
const manifest = JSON.parse(readFileSync(mf, "utf8")), sig = readFileSync(opt("sig") ?? mf.replace(/\.json$/, ".sig"), "utf8").trim();
if (!verifyManifest(manifest, sig, readFileSync(pub, "utf8"))) { console.error("NOT VERIFIED: the signature does not match this manifest and key."); process.exit(1); }
console.log(`Signature valid: release ${manifest.version}, commit ${manifest.commit}, made ${manifest.createdAt}.`);
const unpinned = manifest.baseImages.filter(i => !i.pinned); if (unpinned.length) console.log(`Note: ${unpinned.length} base image(s) were not pinned by digest: ${unpinned.map(i => i.ref).join(", ")}`);
for (const [n, d] of Object.entries(manifest.builtImages)) console.log(`Image ${n}: ${d}`);
if (opt("root")) { const r = checkFiles(manifest, opt("root")); r.problems.forEach(p => console.error(`MISMATCH: ${p}`)); if (r.skipped.length) console.log(`Not present, not checked: ${r.skipped.join(", ")}`); if (r.problems.length) process.exit(1); console.log("Listed files match."); }
