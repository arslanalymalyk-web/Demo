// Makes a signed release manifest: what is in this release (commit, lock file, bill of materials, migrations, base images, built image digests, offline bundle), signed with the institution's or Tiger's release key.
//   node scripts/release.mjs keygen --out <new folder>
//   node scripts/release.mjs --key <private key> --out <folder> [--image app=sha256:... --image web=sha256:...] [--bundle <file>] [--allow-dirty] [--allow-unpinned]
// It refuses a release from a tree with uncommitted changes and a release that pulls any image by tag alone. Verify with: node scripts/verify-release.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { buildManifest, fileHash, imageRefs, keygen, signManifest } from "./release-lib.mjs";

const a = process.argv.slice(2), has = f => a.includes(f), opt = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; }, all = n => a.flatMap((x, i) => x === `--${n}` ? [a[i + 1]] : []);
const root = resolve(new URL("..", import.meta.url).pathname), fail = m => { console.error(`release refused: ${m}`); process.exit(1); };

if (a[0] === "keygen") {
  const out = opt("out"); if (!out) fail("usage: keygen --out <new folder>");
  const k = keygen(); mkdirSync(out, { mode: 0o700 }); writeFileSync(`${out}/release-signing.key`, k.privatePem, { mode: 0o600 }); writeFileSync(`${out}/release-signing.pub`, k.publicPem);
  console.log(`Made ${out}/. Keep release-signing.key in the signer's secret store; publish release-signing.pub (and its fingerprint) where recipients can check it.`); process.exit(0);
}
const keyFile = opt("key"), out = opt("out");
if (!keyFile || !out) fail("usage: --key <private key> --out <folder>");
if (!has("--allow-dirty") && execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) fail("the working tree has uncommitted changes (use --allow-dirty only for a trial)");
const unpinned = imageRefs(root).filter(i => !i.pinned);
if (unpinned.length && !has("--allow-unpinned")) fail(`these images are not pinned by digest: ${unpinned.map(i => i.ref).join(", ")}`);
const builtImages = Object.fromEntries(all("image").map(x => { const [n, d] = x.split("="); if (!/^sha256:[0-9a-f]{64}$/.test(d ?? "")) fail(`--image ${x}: expected name=sha256:<64 hex>`); return [n, d]; }));
const bundlePath = opt("bundle");
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
const manifest = buildManifest({ root, version: pkg.version, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), builtImages, bundle: bundlePath ? { name: basename(bundlePath), sha256: fileHash(bundlePath) } : null });
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/release-manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(`${out}/release-manifest.sig`, signManifest(manifest, readFileSync(keyFile, "utf8")) + "\n");
console.log(`Signed release ${manifest.version} (${manifest.commit.slice(0, 12)}) in ${out}/: release-manifest.json and release-manifest.sig`);
