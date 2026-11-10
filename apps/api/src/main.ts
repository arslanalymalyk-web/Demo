import pg from "pg";
import { DocumentQueue } from "../../../packages/documents/src/index.js";
import { oidcConfigFromEnv, oidcVerifier, remoteKeys } from "../../../packages/identity/src/index.js";
import { buildServer } from "./server.js";

const institutionId = process.env.TIGERIS_INSTITUTION_ID;
if (!process.env.DATABASE_URL || !institutionId) { console.error("DATABASE_URL and TIGERIS_INSTITUTION_ID are required"); process.exit(2); }
const oidc = oidcConfigFromEnv(process.env);
if (!oidc) { console.error("OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required. The API does not start without an identity provider."); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const documents = new DocumentQueue(pool, institutionId);
// Institution documents stay switched off until the NDA and a data processing agreement exist and an operator turns this on.
const app = buildServer({ pool, institutionId, verifier: oidcVerifier(oidc, remoteKeys(oidc.jwksUri)), documents, clientDataEnabled: process.env.TIGERIS_CLIENT_DATA_ENABLED === "true" });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "127.0.0.1" });
const resumed = await documents.resume();
console.log(`API listening on http://127.0.0.1:${port}${resumed ? `; resumed ${resumed} queued document(s)` : ""}`);
