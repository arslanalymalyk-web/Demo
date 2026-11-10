// Local identity provider for development only. It signs tokens with a throwaway key, serves the public key,
// and implements the authorization code flow with PKCE so the web app can be exercised end to end.
// It refuses to run when NODE_ENV=production. Production uses the institution's own provider (OIDC).
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
if (process.env.NODE_ENV === "production") { console.error("dev-idp must not run in production"); process.exit(2); }
const port = Number(process.env.DEV_IDP_PORT ?? 4010), issuer = `http://127.0.0.1:${port}`, audience = process.env.OIDC_AUDIENCE ?? "tigeris-api";
const clientId = process.env.OIDC_CLIENT_ID ?? "tigeris-web";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: "dev", alg: "RS256", use: "sig" }] };
const codes = new Map(); // code -> { sub, challenge, redirect, exp }
const sign = (sub, mfa = true) => new SignJWT({ name: sub, amr: mfa ? ["pwd", "mfa"] : ["pwd"] }).setProtectedHeader({ alg: "RS256", kid: "dev" }).setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(privateKey);
const json = (res, code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.setHeader("access-control-allow-origin", "*"); res.end(JSON.stringify(body)); };
const body = req => new Promise(r => { let b = ""; req.on("data", d => b += d); req.on("end", () => r(new URLSearchParams(b))); });
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

createServer(async (req, res) => {
  const u = new URL(req.url, issuer);
  if (u.pathname === "/jwks") return json(res, 200, jwks);
  if (u.pathname === "/.well-known/openid-configuration") return json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, code_challenge_methods_supported: ["S256"] });
  if (u.pathname === "/authorize") {
    const q = u.searchParams;
    if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("redirect_uri")) return json(res, 400, { error: "invalid_request" });
    if (req.method === "POST") {
      const f = await body(req), sub = (f.get("sub") ?? "").trim();
      if (!sub) return json(res, 400, { error: "sub required" });
      const code = randomUUID(); codes.set(code, { sub, challenge: q.get("code_challenge"), redirect: q.get("redirect_uri"), exp: Date.now() + 60_000 });
      const back = new URL(q.get("redirect_uri")); back.searchParams.set("code", code); if (q.get("state")) back.searchParams.set("state", q.get("state"));
      res.statusCode = 302; res.setHeader("location", back.toString()); return res.end();
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(`<!doctype html><meta charset=utf-8><title>Development sign-in</title><body style="font:16px system-ui;max-width:28rem;margin:4rem auto"><h1>Development sign-in</h1><p>Local identity provider. Not for production.</p><form method=post action="${esc(req.url)}"><label>Subject <input name=sub autofocus required></label> <button>Sign in</button></form>`);
  }
  if (u.pathname === "/token" && req.method === "POST") {
    const f = await body(req), c = codes.get(f.get("code") ?? "");
    codes.delete(f.get("code") ?? "");
    const ok = c && c.exp > Date.now() && c.redirect === f.get("redirect_uri") && f.get("client_id") === clientId && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
    if (!ok) return json(res, 400, { error: "invalid_grant" });
    return json(res, 200, { access_token: await sign(c.sub), token_type: "Bearer", expires_in: 3600 });
  }
  if (u.pathname === "/token" && req.method === "OPTIONS") { res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type"); res.statusCode = 204; return res.end(); }
  if (u.pathname === "/token" && u.searchParams.get("sub")) { res.setHeader("content-type", "text/plain"); return res.end(await sign(u.searchParams.get("sub"), u.searchParams.get("mfa") !== "false")); }
  res.statusCode = 404; res.end();
}).listen(port, "127.0.0.1", () => console.log(`dev idp ${issuer}`));
