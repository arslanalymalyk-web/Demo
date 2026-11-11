import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, decodeJwt, importSPKI, jwtVerify } from "jose";
import { AuthError, type Claims, type TokenVerifier } from "./verify.js";

/** Emergency sign-in for when the institution's identity provider cannot be used.
 *  An Ed25519 key is made once; its private half is split into two shares held by two different people, and the public half is the only thing the application knows.
 *  A token needs both shares, so no one person can sign in this way. It names an existing administrator, lasts at most four hours, must give a reason, and every use is recorded and alerted. */
export const BREAK_GLASS_ISSUER = "tigeris-break-glass", MAX_BREAK_GLASS_MINUTES = 240;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((x, i) => x ^ b[i]!));
const toKey = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });

export function generateBreakGlass(): { publicKeyPem: string; shares: [string, string] } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const a = randomBytes(32);
  return { publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string, shares: [a.toString("hex"), xor(a, seed).toString("hex")] };
}

/** The public key that two shares make. Lets a test set up the application and sign tokens from the same two fixed shares. */
export function publicKeyFromShares(shareA: string, shareB: string): string { return createPublicKey(toKey(xor(share(shareA), share(shareB)))).export({ format: "pem", type: "spki" }) as string; }

const share = (s: string): Buffer => { const b = Buffer.from(s.trim(), "hex"); if (b.length !== 32) throw new Error("a share is 64 hexadecimal characters"); return b; };

export async function issueBreakGlassToken(o: { shareA: string; shareB: string; subject: string; actAsIssuer: string; minutes: number; reason: string; now?: Date; publicKeyPem?: string }): Promise<string> {
  if (!Number.isInteger(o.minutes) || o.minutes < 1 || o.minutes > MAX_BREAK_GLASS_MINUTES) throw new Error(`minutes must be between 1 and ${MAX_BREAK_GLASS_MINUTES}`);
  if (o.reason.trim().length < 10) throw new Error("give a reason of at least ten characters");
  const key = toKey(xor(share(o.shareA), share(o.shareB)));
  if (o.publicKeyPem && createPublicKey(key).export({ format: "pem", type: "spki" }) !== createPublicKey(o.publicKeyPem).export({ format: "pem", type: "spki" })) throw new Error("these two shares do not make the configured key");
  const iat = Math.floor((o.now ?? new Date()).getTime() / 1000);
  return new SignJWT({ act_as_issuer: o.actAsIssuer, reason: o.reason.trim() }).setProtectedHeader({ alg: "EdDSA" }).setIssuer(BREAK_GLASS_ISSUER).setAudience(BREAK_GLASS_ISSUER).setSubject(o.subject).setJti(randomUUID()).setIssuedAt(iat).setExpirationTime(iat + o.minutes * 60).sign(key);
}

/** Verifies an emergency token. The result is a normal sign-in for the named person at the institution's own identity provider, marked as emergency access. */
export function breakGlassVerifier(publicKey: string, oidcIssuer: string, now: () => number = () => Date.now()): TokenVerifier {
  const pem = publicKey.includes("BEGIN") ? publicKey : Buffer.from(publicKey, "base64").toString("utf8");
  const key = importSPKI(pem, "EdDSA");
  return async token => {
    try {
      const { payload } = await jwtVerify(token, await key, { issuer: BREAK_GLASS_ISSUER, audience: BREAK_GLASS_ISSUER, algorithms: ["EdDSA"], requiredClaims: ["sub", "exp", "iat", "jti"], currentDate: new Date(now()) });
      if (payload.exp! - payload.iat! > MAX_BREAK_GLASS_MINUTES * 60) throw new AuthError("emergency token lasts too long");
      if (payload.act_as_issuer !== oidcIssuer) throw new AuthError("emergency token is for another institution");
      if (typeof payload.reason !== "string" || payload.reason.length < 10) throw new AuthError("emergency token has no reason");
      return { issuer: oidcIssuer, subject: String(payload.sub), name: null, mfa: true, issuedAt: payload.iat!, breakGlass: { jti: String(payload.jti), reason: payload.reason } } satisfies Claims;
    } catch (e) { throw e instanceof AuthError ? e : new AuthError("invalid token"); }
  };
}

/** Sends emergency tokens to their verifier and everything else to the identity provider's. A token is routed by its claimed issuer only; each verifier then checks its own signature. */
export function withBreakGlass(primary: TokenVerifier, emergency: TokenVerifier): TokenVerifier {
  return token => { let iss: unknown; try { iss = decodeJwt(token).iss; } catch { return primary(token); } return iss === BREAK_GLASS_ISSUER ? emergency(token) : primary(token); };
}
