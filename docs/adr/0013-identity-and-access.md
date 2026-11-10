# ADR 0013: Identity and access

Status: accepted. Implements decisions K1 to K4.

- Authentication is OIDC bearer tokens from the institution's own identity provider. The API verifies signature (RS256, PS256, ES256, EdDSA only), issuer, audience, expiry and, by default, an MFA claim. Multi-factor is enforced at the provider (K2); the claim check is a second line of defence and can be turned off only by explicit configuration.
- The API does not start without `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URI`. There is no unauthenticated mode. `scripts/dev-idp.mjs` is a local provider for development and refuses to run when `NODE_ENV=production`.
- A valid token is not enough. The subject must map to a provisioned, active principal of this institution. Nothing is provisioned automatically.
- Seven named roles map to permissions in `packages/identity/src/permissions.ts`. Attribute rules (division, classification, case) arrive with the governance module.
- Every route needs an access rule. A route without one is refused, and the server refuses to start if one is missing. Only `/health` is public.
- Provisioning, role changes, disabling and denials by role are written to the hash-chained audit trail. Principals are disabled, never deleted. The last active administrator cannot be demoted or disabled.
- The first administrator is created with `pnpm identity add`, audited with actor type system.
- Scenario runs record the acting principal taken from the token.
