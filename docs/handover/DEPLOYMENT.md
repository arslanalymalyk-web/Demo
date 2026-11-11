# Deployment guide

_Confidential. Property of Tiger Capital AI. Prepared for the client's IT and security team._

**Status:** the web image has been built and run once. The application image has not been built and the compose stack has not been started. Treat the first install as a verification run: finish it with the acceptance run in [ACCEPTANCE.md](ACCEPTANCE.md) and report problems to Tiger Capital AI. See [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md).

## Topology

One node, containers on the client's own infrastructure:

| Service | Role | Network |
|---|---|---|
| `proxy` (nginx) | TLS 1.2 and 1.3, security headers, rate limits, body limits, serves the web app | Only service published to users (443) |
| `api` | Fastify API | Internal |
| `db` | PostgreSQL 16 with extensions | Internal backend network (`internal: true`), no outside route |
| `backup` | Base backups and encrypted log archiving | Internal |

The compose file is `deploy/compose/docker-compose.yml`. Examples: `deploy/compose/.env.example`, `backup.env`, `secrets/README.md`, `tls/README.md`.

## Network and egress

Egress is deny-by-default. Only hosts on a connector allowlist may be called, over verified TLS. TLS verification is never disabled. For a fully closed network, install from the offline bundle and use only the stored records; ingestion then runs only if the source hosts are reachable. The metrics route is not reachable from outside the proxy.

## TLS

Place the certificate and key as described in `deploy/compose/tls/README.md`. Use a certificate from the client's own authority. A self-signed certificate was used only for testing.

## Identity provider requirements

The client's provider must supply, and Tiger must check:

1. OIDC discovery and a JWKS endpoint over https (production refuses http).
2. The issuer and audience values the API is configured with.
3. A claim that marks multi-factor sign-in (`amr` or `acr`). Without it sign-in is refused unless `TIGERIS_ALLOW_NO_MFA_CLAIM=true` is set deliberately.
4. Cross-origin permission for the token endpoint from the web origin (the browser calls it).
5. The redirect addresses of the web app registered, with PKCE allowed for a public client.
6. A signing-key rotation process; the API refreshes keys from the JWKS.
7. Each person provisioned in TIGERIS with a role before first sign-in. A valid token alone is not enough.

None of this has been tested against a real provider.

## Secrets

Supply secrets as files (the `*_FILE` variant of each variable, mounted as docker secrets) or as environment variables from the client's own secret store. Never put them in the image or in git. Secrets: the application database password, the owner database password (migrations only), the metrics token (24 characters or more), the backup encryption key.

## Configuration

Production start-up refuses weak or missing configuration and lists every problem at once. Notable rules: https issuer and JWKS, a strong database password, the metrics token length, and `TIGERIS_CLIENT_DATA_REVIEW_DONE=true` before institution documents may be enabled. The variable reference is `.env.example` and `deploy/compose/.env.example`. The web app reads its issuer, client id and API address at run time from `/config.js`.

## Install steps

1. Provision a host with the container runtime and enough disk for the database, base backups and log archive.
2. Create the secret files and the TLS files. Copy the example environment files and fill them in.
3. Start the database and run the migrations (`docker compose up -d db migrate`).
4. Check the database and the identity provider, read-only: `docker compose --profile setup run --rm setup check`. Fix every FAIL. Items marked CHECK need a person (multi-factor claim, redirect address, key rotation).
5. Stand up the institution: `docker compose --profile setup run --rm setup apply --name "Client Fund" --jurisdiction SA --admin <subject>:"First Admin" --admin <subject>:"Second Admin" [--auditor <subject>:"Name"]`. Subjects are the identity provider's `sub` for each person. It creates the institution, the seven roles, the administrators (two are required, because settings and policy changes need one person to draft and another to approve), the default decision policy and the source registry, and prints `TIGERIS_INSTITUTION_ID`. Put that value in `.env`. It is safe to run again with `--institution-id`.
6. Start the API and the proxy. Check `/health` and `/ready` through the proxy. Sign in as the first administrator and open Readiness: it lists what is still open.
7. Confirm each source's licence and approve it, load the Gulf geography (`pnpm geography`), and have the second administrator activate the settings the institution decides.
8. Schedule `backup.sh` daily from the host (it records each run so a missed or failed backup raises an alert; see [BACKUP-RESTORE.md](BACKUP-RESTORE.md)) and run the restore drill in [BACKUP-RESTORE.md](BACKUP-RESTORE.md) before go-live.
9. Review the image inventory produced by CI and the SBOM in `docs/handover/sbom`.

## Alerts by email

Off by default. Set `TIGERIS_ALERTS_ENABLED=true`, `TIGERIS_SMTP_HOST`, `TIGERIS_SMTP_PORT`, `TIGERIS_SMTP_SECURITY` (`starttls` or `tls`), `TIGERIS_SMTP_USER`, the password as a mounted secret (`TIGERIS_SMTP_PASSWORD_FILE`), `TIGERIS_ALERTS_FROM` and `TIGERIS_WEB_BASE_URL` (the address people use to open TIGERIS; links in the messages point there). Give the API container a network path to the relay only. Then an administrator sets each person's address on the Alerts screen and sends a test message. Production refuses an unencrypted relay and a plain-http web address. A notice contains a category, an optional reference code and a link, never figures or record content. Not yet tried against a real relay.

## Malware scanner

Start the scanner with `docker compose --profile scanner up -d` and set `TIGERIS_SCANNER=clamav` (host `clamav`, port 3310 by default). The ClamAV container sits on the internal network and on the egress network so it can refresh signatures; restrict that egress to the ClamAV signature hosts with the host firewall (the image is pinned by digest). It is required before institution documents are enabled: configuration refuses client-data mode without it and start-up refuses to run if it does not answer. Not yet built or started in this build.

## Optional: scheduled ingestion

Off by default. Set `TIGERIS_SCHEDULER_ENABLED=true`, and add exactly the source hosts (as `host:443`) to `EGRESS_ALLOW` (the sources are listed on the Data and Sources screen; each connector reaches only its own source). The API has no other route out: everything goes through the egress proxy. Then two administrators activate a schedule under Settings, Ingestion schedule. With the scheduler on and no schedule active, nothing is fetched. The scheduler appears on `/metrics` as `tigeris_scheduler_enabled`. If the client prefers the API never to have outbound access, leave it off and use the separate ingest service or an external scheduler running the ingest command.

## Optional: connecting a model

The Assistant is off by default and nothing is sent anywhere. To enable it, set `TIGERIS_REASONING_PROVIDER` to `anthropic`, `openai_compatible` (any endpoint, including an on-premises model) or `local_extractive` (no network, quotes stored facts only). Set `TIGERIS_MODEL_NAME`, `TIGERIS_MODEL_BASE_URL` (https in production) and the key as a mounted secret (`TIGERIS_MODEL_API_KEY_FILE`). The API container sits on an internal network with no route out, so also add the egress network to it and allow exactly the model host on the network allowlist. Only public-record, sample and scenario facts are placed in prompts. Review the provider's data terms first. Not yet tried against a real endpoint.

## Before client data is connected

Complete the items in [SECURITY.md](SECURITY.md) under "Before client data": independent penetration test, the malware scanner running with current signatures, identity provider check, the backup drill in this environment, and the client's own review.
