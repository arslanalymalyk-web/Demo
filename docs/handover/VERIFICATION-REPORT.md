# Verification report

_Confidential. Property of Tiger Capital AI. Prepared for Tiger Capital AI and the client's security reviewers._

This report says what was checked in this build, how, and what was **not** checked. Read the second half before relying on the first.

## What was verified, and how

| Area | What was checked | How | Result |
|---|---|---|---|
| Automated tests | 246 tests in 17 files, covering every module | `pnpm check` (wording lint, type check, tests) against real PostgreSQL 16 | All pass |
| Tenancy | A runtime role that owns nothing and cannot bypass row-level security; every institution table forces row-level security; no data crosses institutions | Tests in every module create two institutions and look for leaks. A start-up check refuses to run as a superuser, an owner, or with a table that does not force row-level security | Pass. The API refused to start as the owner role in a live run |
| Evidence and audit | Evidence, decisions, policy decisions, case history, memory, settings and exports cannot be changed or deleted, even by the application role | Database triggers, attacked directly in tests. The audit trail is a per-institution hash chain written in the same transaction | Pass |
| No deletion | The application role has no DELETE right on any table except the person-to-role link, and no TRUNCATE right | A test reads the grants | Pass |
| Authentication | Tokens must be correctly signed, from the right issuer, for the right audience, unexpired, and (by default) carry a multi-factor claim. Unsigned, symmetric-key and forged tokens are refused | Unit and integration tests with locally generated keys; a live sign-in using the authorization-code flow with PKCE | Pass, against a development identity provider only |
| Access control | Every route has an access rule, or the server will not start. Roles map to permissions. Separation of duty is enforced for decisions, settings and policy | Tests for each rule; a live two-person settings change in a browser | Pass |
| Secure web delivery | TLS 1.2 and 1.3 only, security headers on every response, a strict content security policy, rate limits, upload size limits per route, the metrics route hidden from outside | nginx 1.24 run in front of the real API and the built web app with a self-signed certificate; headers, limits and TLS versions probed. A real browser then signed in and opened eight screens with **zero** policy violations | Pass. One defect found and fixed (security headers were missing on pages) |
| Backups | Point-in-time recovery with continuous encrypted log archiving | A disaster drill on a scratch PostgreSQL cluster: take a base backup, write more records, restore to a chosen moment, verify the audit chain. Restoring to the middle gave exactly the earlier 5 records and the latest gave all 7, each with an intact chain. Tampered backups, a wrong key, a short key, a non-empty target and a time before any backup are all refused | Pass. Four defects found and fixed during the drill |
| Offline install | The software installs with no internet | A bundle was built, checksummed, unpacked into an empty directory and installed with `--offline`; type check, licence check and tests then passed from the copy | Pass |
| Dependencies | No known vulnerabilities; permissive licences only | `pnpm audit` (zero known, production and build tools) and a licence check over 258 packages | Pass. One high-severity issue in a production dependency was fixed by upgrading |
| Real data | Figures shown come from stored public records with provenance | Ingested DataSaudi, IMF, JODI and an EIA article; every figure opens to its evidence record | Pass |
| Reasoning | Output verification (numbers, citations, advice, links), data-class gate, immutable call log, per-person limit, adapter request shape, failure handling that never echoes keys or bodies | 29 tests with scripted and extractive models and a fake HTTP layer; a run over the real stored data with the local extractive model (summary, answer, questions, recommendation draft all verified) | Pass for the checks. See item 13 below |
| Scheduled ingestion | Rules for back-off and pause, due-time and claim atomicity, overlapping passes, run time limit, schedule validation, case opening and no duplicates, health from stored series, run and quarantine facts, permissions, audit events, metrics | Tests against a real database with scripted runs and a fake source; one real run through the live pipeline against the IMF source in the development database | Pass for the checks. See item 14 |
| Document intake | PDF text layer, OCR for scans and images, Word text, plain text; unsafe files refused | Tests with real PDFs, a scanned image and a scanned PDF through Poppler and Tesseract 5.3.4 | Pass for English |

## What was NOT verified

These are real gaps. None is hidden by a passing test.

1. **The container images were never built.** The build host had no Docker daemon. The Dockerfile, the compose file and the database init script were checked for syntax and the compose file was resolved with a filled-in example, but nothing was built or started. The CI workflow has a job that builds the images, checks the proxy configuration inside the web image, and confirms the API refuses to start without configuration. **That job has not run.**
2. **The CI workflow has not run on GitHub.** It was checked as valid YAML only.
3. **No real identity provider was used.** Sign-in was tested against a development provider built for the purpose. The client's provider must be checked for: the claim that marks multi-factor sign-in, cross-origin permission for the token endpoint, redirect addresses, and signing-key rotation.
4. **No independent penetration test.** Decision 11 requires one before any client data. This build prepares for it but does not replace it.
5. **No malware scanning of uploads.** Uploaded files are identified by content, size-limited and processed in a restricted child process, but not scanned for malware. A scanner in front of uploads is required before institution documents are enabled.
6. **Arabic OCR accuracy is unmeasured.** The Arabic language data is installed and Arabic plain text is handled, but no real Arabic scan was available.
7. **High availability was not built.** One application node and one database, with fast restore. This was the chosen design for the first client.
8. **Backups were proved on a scratch cluster of the Debian package layout.** The same scripts were not run against the official PostgreSQL container image. The restore script writes minimal configuration files when a backup holds none, and says so. Run the drill (`deploy/backup/drill-debian.sh`) in the client's environment before go-live.
9. **Operating-system packages in the images are not inventoried here.** The software bill of materials covers the 89 production npm packages. The CI job produces an image inventory; review it before release.
10. **Values set by Tiger have not been validated for truth.** The system proves who set a threshold or assumption, when, why and under which version. It cannot prove the number is right.
11. **Facility positions on the map are approximate** and sea routes are schematic, and are labelled so. They have not been checked against a gazetteer.
12. **The client's own data has never been connected.** Everything verified used public records, the system's own test data, or content labelled as a Sample dataset.
13. **No real model endpoint was called.** The Claude API and OpenAI-compatible adapters were tested only against a fake HTTP layer, because no key or endpoint was available. Their request shapes follow the providers' published formats and must be tried against the real service. Verification proves each number is quoted from a cited stored fact; it does not prove the prose reasons soundly, so people read every draft. The number-word and advice checks use fixed lists and will not catch every paraphrase.
14. **Scheduled ingestion was exercised against one real source only, and that source refused.** The IMF commodity workbook returned HTTP 403 to automated access, so the run failed, backed off (15 then 30 minutes) and was recorded as designed; no successful scheduled fetch from a real source has been seen. The scheduler has not run inside the container images, and a fetch that hangs is given up after its time limit but its request is not cancelled. Run-now is recorded as a scheduled run.

## Defects found and fixed by verification (for the record)

- The rate limiter never applied, because its plugin loaded after the routes. Replaced with a small in-process limiter and tested.
- A server error could expose internals. A global handler now returns a generic message and a request id.
- Security headers were missing on every page behind the proxy, because nginx drops server-level headers in a location that sets its own. Moved to a shared include.
- Drag-to-pan on the map swallowed clicks on markers.
- The database bootstrap hard-coded nothing but the migrations did: the role `tigeris_app` must exist. The bootstrap now always creates `tigeris_owner` and `tigeris_app`. An earlier scratch test had passed only because the development cluster already had the role.
- Backup pruning failed with fewer than two backups; the restore command ran without its environment; a wrong key left a half-made directory; the restore left a Debian-layout directory with no configuration files.
- A part of the case update was built by string concatenation. It is now fully parameterised.
- Gulf producers with stale data were shown as current in the Gulf total.
- A high-severity vulnerability in a production dependency, and several in build tools, were removed by upgrading.
