# Operator runbook

_Confidential. Property of Tiger Capital AI. Prepared for operators._

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

A person must exist as a provisioned principal with a role before they can use the system. Use the administrator screens or the identity commands. Removing access means removing the role link, which is the only deletion the application is allowed. Keep at least two administrators, because settings activation needs two people.

## Ingestion

Source ingestion runs from the ingest command for each source. Run it on the schedule the client chooses. A source whose data is stale is shown as lagging or with its snapshot date, never as current. Quarantined records appear in the ingestion view and need a person to review them.

## Metrics and alerts

Scrape `/metrics` with the bearer token. Suggested alerts:

| Metric | Alert when |
|---|---|
| `tigeris_http_request_duration_seconds` | high percentile above target for 10 minutes |
| `tigeris_auth_failures_total{reason}` | sudden rise (possible attack or identity provider problem) |
| `tigeris_db_pool_connections{state}` | waiting connections stay above zero |
| `tigeris_document_queue_busy` | stuck busy for long periods |

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

## Assistant and model calls

If drafts fail with "the model could not be reached", check the egress network, the allowlist and the key. Verification failures ("Failed verification") are expected sometimes and are not faults: the draft is discarded and the call is logged. Auditors read the call log in the Assistant screen. Per-person limit is 30 drafts an hour. To turn the Assistant off, set the provider to `off` and restart the API.

## Retention

Nothing is deleted automatically. Use the Retention screen for the ten-year report, to place or release a legal hold on a case, and to export a case with its integrity hash. Held cases must not be removed from any storage by hand.

## Incident basics

1. Note the time and request ids. 2. Preserve logs and the latest backup. 3. Check the audit chain (`deploy/backup/verify-audit.sql`); a broken chain is a serious incident. 4. Revoke access by removing roles. 5. Tell Tiger Capital AI and the client's security contact. 6. Restore only if the data is damaged, following [BACKUP-RESTORE.md](BACKUP-RESTORE.md).
