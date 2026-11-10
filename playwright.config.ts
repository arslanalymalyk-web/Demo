import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

try { process.loadEnvFile(".env"); } catch { /* the environment may already provide the variables */ }
// One institution per run. Workers read the same value because it is set before they start.
process.env.E2E_INSTITUTION_ID ??= randomUUID();
const inst = process.env.E2E_INSTITUTION_ID, api = 3100, web = 5174, idp = 4011;
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required: the end-to-end suite runs against the test database`); return v; };
const ownerUrl = need("DATABASE_URL_TEST_OWNER"), appUrl = need("DATABASE_URL_TEST");

export default defineConfig({
  testDir: "e2e", fullyParallel: false, workers: 1, retries: process.env.CI ? 1 : 0, timeout: 45_000, expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL: `http://127.0.0.1:${web}`, trace: "off", screenshot: "only-on-failure", viewport: { width: 1280, height: 900 } },
  webServer: [
    // A local identity provider with a throwaway key. It refuses to run in production.
    { command: "node scripts/dev-idp.mjs", url: `http://127.0.0.1:${idp}/jwks`, env: { DEV_IDP_PORT: String(idp) }, reuseExistingServer: false, timeout: 30_000 },
    // The real API against the test database, after the seed has made this run's institution.
    { command: "node --import tsx e2e/seed.ts && node --import tsx apps/api/src/main.ts", url: `http://127.0.0.1:${api}/ready`, reuseExistingServer: false, timeout: 120_000, stdout: "pipe", stderr: "pipe",
      env: { E2E_INSTITUTION_ID: inst, DATABASE_URL_TEST_OWNER: ownerUrl, DATABASE_URL: appUrl, TIGERIS_INSTITUTION_ID: inst, PORT: String(api), HOST: "127.0.0.1", OIDC_ISSUER: `http://127.0.0.1:${idp}`, OIDC_AUDIENCE: "tigeris-api", OIDC_JWKS_URI: `http://127.0.0.1:${idp}/jwks`,
        TIGERIS_SCANNER: "stub", TIGERIS_REASONING_PROVIDER: "local_extractive", RATE_LIMIT_PER_MINUTE: "0", LOG_LEVEL: "warn" } },
    { command: `node_modules/.bin/vite --config apps/web/vite.config.ts --port ${web} --strictPort`, url: `http://127.0.0.1:${web}/`, reuseExistingServer: false, timeout: 60_000,
      env: { VITE_OIDC_AUTHORITY: `http://127.0.0.1:${idp}`, TIGERIS_API_URL: `http://127.0.0.1:${api}` } },
  ],
});
