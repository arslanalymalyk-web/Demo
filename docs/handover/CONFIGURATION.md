# Configuration reference

_Confidential. Property of Tiger Capital AI. Prepared for the client's IT and security team and for operators._

Every setting is an environment variable. A variable marked **secret** may instead be given as `NAME_FILE`, a path to a mounted file holding the value (give one or the other, not both). The API reads its configuration at start-up, reports every problem at once, and refuses to start on any of them. Examples are in `.env.example` and `deploy/compose/.env.example`; this page is checked against the code by `tests/config-docs.test.ts`, so a setting that is read but not listed here fails the build.

## Core

| Variable | Default | Meaning |
|---|---|---|
| `TIGERIS_ENV` | none | `production` turns on the stricter checks below. |
| `NODE_ENV` | none | Standard Node setting; the development identity provider refuses to run when it is `production`. |
| `TIGERIS_INSTITUTION_ID` (secret) | required | The institution this deployment serves, printed by the set-up command. One deployment serves one institution. |
| `DATABASE_URL` (secret) | required | Runtime database role. The API refuses to start if this role is a superuser, bypasses row-level security, can create roles or databases, or owns any table. |
| `DATABASE_URL_OWNER` (secret) | none | Owner role. Used only by migrations, the seed script and the set-up command. Also `DATABASE_URL_OWNER_FILE`. |
| `DB_POOL_MAX` | 10 | Maximum database connections in the API. |
| `HOST`, `PORT` | `127.0.0.1`, 3000 | Where the API listens. |
| `LOG_LEVEL` | `info` | Log level for the structured logs. Secrets and tokens are redacted. |
| `TIGERIS_TRUST_PROXY` | false | Set `true` behind the bundled proxy so client addresses come from its headers. |
| `RATE_LIMIT_PER_MINUTE` | 600 | Per-address request limit in the API; `0` turns it off (the proxy has its own limits). |
| `METRICS_TOKEN` (secret) | none | Bearer token for `/metrics`. Without it the endpoint does not exist. In production, at least 24 characters. |

## Identity

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_ISSUER` | required | The identity provider's issuer. https in production. |
| `OIDC_AUDIENCE` | required | The audience tokens must carry. |
| `OIDC_JWKS_URI` | required | The provider's signing keys. https in production. |
| `OIDC_MAX_TOKEN_AGE_SECONDS` | 28800 | Longest a token is honoured after the identity provider issued it, whatever its own expiry says; tokens with no issue time are refused while this is on. 0 turns the limit off. Sessions can also be ended at any time by an administrator (see SECURITY.md). |
| `TIGERIS_AUDIT_ANCHOR_KEY` | none | Secret of at least 32 characters (also read from `TIGERIS_AUDIT_ANCHOR_KEY_FILE`) that signs audit checkpoints. Without it the checkpoint routes answer 409. Keep it away from the database administrator. |
| `TIGERIS_AUDIT_CHECKPOINT_DIR` | none | Folder where a signed audit checkpoint is saved on a schedule (read-only files, written atomically). Use a write-once or remote mount the database administrator cannot change. Needs `TIGERIS_AUDIT_ANCHOR_KEY`. An alert goes to administrators and auditors when none has been saved for twice the interval. |
| `TIGERIS_AUDIT_CHECKPOINT_HOURS` | 24 | Hours between scheduled checkpoints (1 to 720). |
| `TIGERIS_DOCUMENT_KEY` | none | Secret of at least 32 characters (also `TIGERIS_DOCUMENT_KEY_FILE`). When set, uploaded files and extracted page text are sealed (AES-256-GCM) before they reach the database, and search runs over keyed word tokens. Required in production when institution documents are enabled. Keep it away from the database administrator and back it up separately: without it, sealed documents cannot be read. |
| `TIGERIS_DOCUMENT_KEY_PREVIOUS` | none | Comma-separated earlier keys, so documents sealed with them stay readable after the key is replaced. New documents use `TIGERIS_DOCUMENT_KEY`. |
| `TIGERIS_BREAKGLASS_PUBLIC_KEY` | none | Public half (PEM, or the PEM base64-encoded) of the emergency sign-in key made by `pnpm identity break-glass init`. Not a secret. When set, an emergency token signed by two people holding the two private shares is accepted as a sign-in for a named administrator, for at most four hours; every use is audited and alerted. |
| `TIGERIS_SMTP_PROXY` | `HTTPS_PROXY` | Egress proxy used for the mail relay (an `http://host:port` CONNECT proxy). Defaults to `HTTPS_PROXY`, unless the relay host is listed in `NO_PROXY`; `none` sends directly. |
| `EGRESS_ALLOW` | none | For the egress proxy container only: the hosts the deployment may reach, as `host:port`, comma separated. Nothing is allowed by default. |
| `EGRESS_PORT`, `EGRESS_HOST` | 3128, 0.0.0.0 | For the egress proxy only: where it listens inside the backend network. |
| `EGRESS_ALLOW_PRIVATE` | none | For the egress proxy only: entries from `EGRESS_ALLOW` that are allowed to resolve to a private address (an identity provider or relay inside the institution). |
| `OIDC_REQUIRE_MFA_CLAIM` | true | Tokens must carry a multi-factor claim (`amr` or `acr`). Turning it off in production also needs `TIGERIS_ALLOW_NO_MFA_CLAIM=true`, so it is a recorded decision. |
| `TIGERIS_ALLOW_NO_MFA_CLAIM` | false | See above. |
| `OIDC_CLIENT_ID` | `tigeris-web` | The web app's public client id (proxy and set-up). |
| `WEB_ORIGIN` | none | Used by the set-up check to test that the token endpoint allows the web origin. |
| `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID` | local development provider | Development only; in a container the proxy writes `/config.js` from `OIDC_AUTHORITY` and `OIDC_CLIENT_ID`. |

## Data and documents

| Variable | Default | Meaning |
|---|---|---|
| `TIGERIS_CLIENT_DATA_ENABLED` | false | Allows institution documents. Refused in production unless a real malware scanner is configured and `TIGERIS_CLIENT_DATA_REVIEW_DONE=true`. |
| `TIGERIS_CLIENT_DATA_REVIEW_DONE` | false | Records that the client's own security review is complete (decision 11). |
| `TIGERIS_SCANNER` | `off` | `off`, `clamav` or `stub`. The stub is refused in production. |
| `TIGERIS_CLAMAV_HOST`, `TIGERIS_CLAMAV_PORT` | none, 3310 | Address of the ClamAV daemon. |
| `TIGERIS_CLAMAV_SOCKET` | none | A socket path instead of host and port. |

## Backups

| Variable | Default | Meaning |
|---|---|---|
| `TIGERIS_BACKUP_MAX_AGE_HOURS` | 0 (the compose file sets 36) | Alert, and show on Readiness, when the newest good base backup is older than this many hours or the newest run failed. 0 turns monitoring off. Between 0 and 720. |

The backup script itself reads `BACKUP_DIR`, `BACKUP_KEY_FILE`, `KEEP_DAYS`, `BACKUP_RECORD` (set to 0 to stop it recording runs in the database) and `BACKUP_RECORD_DB` (the database name, default `tigeris`) from its own file; see [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

## Optional services (all off by default)

| Variable | Default | Meaning |
|---|---|---|
| `TIGERIS_SCHEDULER_ENABLED` | false | Scheduled ingestion inside the API. Needs outbound access to the source hosts. |
| `TIGERIS_SCHEDULER_TICK_SECONDS` | 60 | Between 10 and 3600. |
| `TIGERIS_REASONING_PROVIDER` | `off` | `off`, `anthropic`, `openai_compatible` or `local_extractive`. |
| `TIGERIS_MODEL_NAME` | none | Required for `anthropic` and `openai_compatible`. |
| `TIGERIS_MODEL_BASE_URL` | Claude API address for `anthropic` | Required for `openai_compatible`. https in production. |
| `TIGERIS_MODEL_API_KEY` (secret) | none | Required for `anthropic`. |
| `TIGERIS_ALERTS_ENABLED` | false | Alerts by email. |
| `TIGERIS_ALERTS_TRANSPORT` | `smtp` | `smtp` or `log` (development; refused in production). |
| `TIGERIS_SMTP_HOST`, `TIGERIS_SMTP_PORT` | none, 587 | The client's mail relay. |
| `TIGERIS_SMTP_SECURITY` | `starttls` | `starttls`, `tls` or `none` (`none` is refused in production). |
| `TIGERIS_SMTP_USER`, `TIGERIS_SMTP_PASSWORD` (secret) | none | Relay account. |
| `TIGERIS_ALERTS_FROM` | none | Sender address, for example `TIGERIS <alerts@institution.example>`. |
| `TIGERIS_WEB_BASE_URL` | none | Address people use to open TIGERIS; links in notices point there. https in production. |
| `TIGERIS_ALERTS_REMINDER_HOURS` | 24 | Between 1 and 168. |
| `TIGERIS_ALERTS_MAX_PER_HOUR` | 120 | Between 1 and 2000. |

## Development and test only

| Variable | Meaning |
|---|---|
| `DEV_IDP_PORT` | Port of the local development identity provider (default 4010). |
| `TIGERIS_API_URL` | Where the Vite development server proxies `/api`. |
| `DATABASE_URL_TEST`, `DATABASE_URL_TEST_OWNER` | Test databases for `pnpm test` and `pnpm e2e`. |
| `TIGERIS_TEST_CLAMD` | `host:port` of a real ClamAV daemon for the one test that uses it. |
