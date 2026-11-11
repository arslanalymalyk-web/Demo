# Operator runbook

_Confidential. Property of Tiger Capital AI. Prepared for operators._

## Readiness

The Readiness screen (administrators and auditors) lists what is still open for real use: two administrators, an auditor, the decision policy, approved sources, stored records, which settings are still on code defaults, the map geography, the audit chain and the scanner. "Blocks use" must be cleared; "Needs a decision" is for the institution; "Confirm by hand" covers the restore drill, the penetration test and the multi-factor claim. Check it after every change to the configuration.

## Backups

Readiness shows "Base backups monitored". If it says the last backup is overdue, failed, or never recorded, check the host job that runs `backup.sh`, the backup disk and the key file, then run the job by hand. A good run clears the alert by itself. Backups are watched here, not proved: run the restore drill in your environment before go-live and after any change to the scripts.

## Daily checks

- `/health` returns ok and `/ready` returns ready (database reachable, migrations current).
- The newest base backup is under 24 hours old and log archiving has no recent failures.
- No alert on the metrics below.

## Start, stop

Start and stop with the compose file. Stop the proxy first, then the API, then the database. The API handles SIGTERM by finishing in-flight requests and closing the pool. After a restart the document queue resumes unfinished jobs by itself.

## Upgrade and roll back

1. Take a base backup first.
2. Pull or load the new images. Check the SBOM and image inventory.
3. Run the new migrations with the owner role. Migrations only add; they do not delete evidence.
4. Restart the API and proxy. Check `/ready`.
5. Roll back by redeploying the previous images. If a migration must be undone, restore from the backup taken in step 1 instead of editing tables by hand; evidence tables reject edits.

## Rotate secrets

Replace the secret file, restart the service that reads it. For the database password, change it in the database and the secret file together. For the backup key, keep the old key: old backups need it. For the metrics token, update the monitoring system at the same time.

## Add and remove people

Giving someone the `administrator` or `approver` role is a request: a different administrator approves it on the Administration page ("Roles waiting for a second administrator"). Other roles apply at once, and taking any role away is immediate. Check that page when a colleague says they asked for a role. The identity command (`pnpm identity add`) applies everything without approval and is for the first administrators and for break-glass use on the server; its use is recorded in the audit trail as the system.

A person must exist as a provisioned principal with a role before they can use the system. Use the administrator screens or the identity commands. Removing access means removing the role link, which is the only deletion the application is allowed. Keep at least two administrators, because settings activation needs two people.

## Ingestion

The Source health screen shows every source with its state, last success, next run, failures and recent runs. Operators with ingestion rights can run a scheduled source now, pause it or resume it, each with a recorded reason. A source that fails repeatedly is retried after 15, 30, 60 minutes and so on, then paused automatically after the configured number of failures; it stays paused until a person resumes it. A paused or stale scheduled source opens a case for the steward named in the schedule. A source whose publisher blocks automated access will keep failing: pause it and ask the publisher for an approved route.

Without the scheduler, source ingestion runs from the ingest command for each source, on whatever schedule the client chooses. A source whose data is stale is shown as lagging or with its snapshot date, never as current.

## Metrics and alerts

Scrape `/metrics` with the bearer token. Suggested alerts:

| Metric | Alert when |
|---|---|
| `tigeris_http_request_duration_seconds` | high percentile above target for 10 minutes |
| `tigeris_auth_failures_total{reason}` | sudden rise (possible attack or identity provider problem) |
| `tigeris_db_pool_connections{state}` | waiting connections stay above zero |
| `tigeris_document_queue_busy` | stuck busy for long periods |
| `tigeris_sources{health="failing"}` or `{health="stale"}` | above zero for longer than the client's tolerance |
| `tigeris_source_last_success_age_hours{source}` | above the source's normal interval plus a margin |
| `tigeris_ingest_jobs_24h{status="failed"}` | rising with no matching completed jobs |

Logs are JSON with secrets redacted. Every response carries a request id; use it to find the matching log lines.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| API will not start | The configuration message lists every problem. Also: it refuses to run as a superuser, an owner, or with a table lacking forced row-level security. Fix the role, do not bypass the check. |
| Everyone gets 401 | Identity provider issuer, audience or keys changed; clock drift; missing multi-factor claim |
| One person gets 403 | No role, or the role lacks the permission |
| Sign-in loops in the browser | Redirect address not registered, or token endpoint blocks the web origin |
| Uploads rejected | Over size or page limit, unsafe type, or institution documents not enabled |
| Rate limited (429) | Limit per address reached; check for a proxy that hides client addresses |

## Alerts

The Alerts screen (administrators and auditors) lists open and recent conditions and every message attempted, with who it was for and the result. "Send a test to me" checks the relay. If messages fail with "could not be reached", check the relay address, port, TLS mode and the network path; with "refused the credentials", the relay password. Failed notices are retried with back-off and then wait for the next daily reminder. Someone with no address is recorded as skipped: set it on the screen. Metrics `tigeris_alert_conditions_open{category}` and `tigeris_alert_deliveries_24h{status}` show open conditions and failures; alert on `failed` rising or `malware` or `operations` above zero. Operations notices cover the audit chain, the malware scanner and the database log archive; the age of the last base backup is not visible to the database, so keep checking that separately.

## Malware scanner

The Documents screen shows the scanner status, files waiting for a scan, and any flagged file. If the scanner stops answering, new uploads are held unopened and retried every few minutes (up to every 15), then processed when it returns; nothing is treated as clean. A flagged file stays quarantined for good: it is recorded with its signature, its bytes are not kept, and no one can release it. Keep signatures current (the ClamAV container refreshes them through its egress network); alert on `tigeris_scanner_up` at 0 and on `tigeris_documents_by_scan{status="infected"}` above 0.

## Assistant and model calls

If drafts fail with "the model could not be reached", check that the model host is in `EGRESS_ALLOW` (the egress proxy log shows refused hosts), and the key. Verification failures ("Failed verification") are expected sometimes and are not faults: the draft is discarded and the call is logged. Auditors read the call log in the Assistant screen. Per-person limit is 30 drafts an hour. To turn the Assistant off, set the provider to `off` and restart the API.

## Retention

Nothing is deleted automatically. Use the Retention screen for the ten-year report, to place or release a legal hold on a case, and to export a case with its integrity hash. Held cases must not be removed from any storage by hand.

## Document key

When institution documents are on, set `TIGERIS_DOCUMENT_KEY` (from the secret store, at least 32 characters) before the first upload and back it up somewhere the database backup is not. Without it sealed documents cannot be read, and the Readiness screen fails. To replace the key, put the new one in `TIGERIS_DOCUMENT_KEY` and the old one in `TIGERIS_DOCUMENT_KEY_PREVIOUS`; keep old keys as long as the documents they sealed exist.

## Emergency sign-in (break-glass)

For when the identity provider cannot be used. Set up once, before it is needed: on an offline machine run `pnpm identity break-glass init --out <new folder>`, give `share-1.txt` and `share-2.txt` to two different custodians (neither an administrator who would use the route alone, never a supplier), delete them from the machine, and put `public-key.pem` (or its base64) in `TIGERIS_BREAKGLASS_PUBLIC_KEY`. In an emergency both custodians come together: `pnpm identity break-glass issue --share-1 <file> --share-2 <file> --subject <administrator's identity-provider subject> --minutes 60 --reason "why"`. The token is pasted into "Emergency access" on the sign-in screen. It lasts at most four hours, is shown on every screen as emergency access, is recorded with the reason, and alerts the administrators and auditors. Rehearse it once a year (acceptance item `break-glass`).

## Egress and the proxy

All outbound connections leave through the `egress-proxy` container and only to the host:port pairs in `EGRESS_ALLOW`. If a feature fails with "could not be reached", read the proxy's log: a refused line names the host and the reason ("not on the allowlist", "resolves to a private address"). Add exactly what is needed (an internal host also goes in `EGRESS_ALLOW_PRIVATE`) and restart the proxy; never add a wildcard (the proxy does not accept one). Check the boundary after any change to the network: `docker compose exec app node scripts/egress-check.mjs`. In an incident whose cause is unknown, `docker compose stop egress-proxy` cuts every outbound connection at once; start it again afterwards. Load `deploy/egress/nftables.conf` on the host as the second layer.

## Temporary and supplier access

Create the person with "Access ends" set; see [VENDOR-ACCESS.md](VENDOR-ACCESS.md). After the engagement, an auditor reads the person's activity and files the review.

## Releases

A release is a signed manifest: `node scripts/release.mjs --key <signing key> --out <folder> --image app=sha256:... --image web=sha256:...` (it refuses an unpinned image or a tree with uncommitted changes). Recipients check it with the signer's public key: `node scripts/verify-release.mjs --public-key <file> --manifest <file> --root <unpacked release>`. After installing, run the acceptance script ([ACCEPTANCE.md](ACCEPTANCE.md)).

## Ending access and stopping the system

- **One person:** Administration, "End sessions" (their tokens stop working at once; they sign in again through the identity provider). "Disable" also blocks them from signing in.
- **Everyone:** `POST /v1/identity/revoke-all-sessions` with a reason. Everyone, including you, signs in again.
- **Session length:** tokens are honoured for `OIDC_MAX_TOKEN_AGE_SECONDS` (eight hours by default) after the provider issued them. Set shorter in the provider as well.
- **Emergency stop:** Administration, "Emergency stop", with a reason. Reading, uploads, model calls and scheduled fetches are refused for everyone; administrators and auditors can still see people, end sessions, check the audit trail and release the stop. It is a software stop: for a harder one, also suspend the egress network on the host.
- **Audit checkpoints:** set `TIGERIS_AUDIT_ANCHOR_KEY` (at least 32 characters, from the secret store, not readable by the database administrator). Set `TIGERIS_AUDIT_CHECKPOINT_DIR` to a write-once or remote mount the database administrator cannot change, and the API saves a signed checkpoint there every `TIGERIS_AUDIT_CHECKPOINT_HOURS` (24); an alert follows if none is saved for twice that. Once a month, and after any incident or any maintenance by someone with full database rights, an auditor checks the newest file on the Audit page.
- **Leaving, or giving a regulator everything:** `pnpm retention export <new folder>` writes every table as plain files with a manifest; `pnpm retention verify-export <folder>` checks it anywhere, with no database. The export is recorded in the audit trail.

## Incident basics

1. Note the time and request ids. 2. Preserve logs and the latest backup. 3. Check the audit chain (`deploy/backup/verify-audit.sql`); a broken chain is a serious incident. 4. End sessions and disable the people involved (see "Ending access and stopping the system"); use the emergency stop if the cause is not yet understood. Check the newest saved audit checkpoint. 5. Tell Tiger Capital AI and the client's security contact. 6. Restore only if the data is damaged, following [BACKUP-RESTORE.md](BACKUP-RESTORE.md).
