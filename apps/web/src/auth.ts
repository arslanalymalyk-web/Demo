// Authorization code flow with PKCE against the institution's identity provider. The access token lives in memory only.
export interface AuthConfig { authority: string; clientId: string }
export const authConfig = (): AuthConfig => ({ authority: import.meta.env.VITE_OIDC_AUTHORITY ?? "http://127.0.0.1:4010", clientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? "tigeris-web" });

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomString = (n = 48): string => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function buildAuthorizeUrl(endpoint: string, p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, scope: "openid profile", state: p.state, code_challenge: p.challenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
  return u.toString();
}

/** Reads the provider's own metadata, so endpoints are never hard-coded. */
async function discover(authority: string): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const r = await fetch(`${authority.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error("identity provider unavailable");
  return r.json();
}

const KEY = "tigeris.pkce";
export async function startLogin(cfg = authConfig()): Promise<void> {
  const meta = await discover(cfg.authority);
  const verifier = randomString(), state = randomString(16);
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state }));
  location.assign(buildAuthorizeUrl(meta.authorization_endpoint, { clientId: cfg.clientId, redirectUri: `${location.origin}/`, state, challenge: await pkceChallenge(verifier) }));
}

export interface Session { token: string; expiresAt: number }

/** Completes the flow when the provider redirected back with a code. Returns null when this page load is not a callback. */
export async function completeLogin(cfg = authConfig()): Promise<Session | null> {
  const q = new URLSearchParams(location.search), code = q.get("code");
  if (!code) return null;
  const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { verifier: string; state: string } | null;
  sessionStorage.removeItem(KEY);
  history.replaceState(null, "", location.pathname + location.hash);
  if (!saved || saved.state !== q.get("state")) throw new Error("sign-in response did not match the request");
  const meta = await discover(cfg.authority);
  const r = await fetch(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cfg.clientId, redirect_uri: `${location.origin}/`, code_verifier: saved.verifier }) });
  if (!r.ok) throw new Error("sign-in was refused");
  const j = await r.json() as { access_token: string; expires_in?: number };
  return { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
}
