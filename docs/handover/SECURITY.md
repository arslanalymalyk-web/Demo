# Security

_Confidential. Property of Tiger Capital AI. Prepared for Tiger Capital AI and the client's security reviewers._

## Threat model (summary)

| Threat | Main controls |
|---|---|
| Stolen or forged token | Signature, issuer, audience, expiry and multi-factor claim checks; unsigned and symmetric-key tokens refused; token held in browser memory only |
| Unprovisioned or over-privileged user | Provisioned principals only; seven roles; default-deny route access map; separation of duty for decisions, settings and policy |
| Cross-institution data exposure | Forced row-level security on every institution table; runtime role owns nothing and has no BYPASSRLS; start-up check; one deployment per institution |
| Tampering with records | Immutability triggers on evidence, decisions, policy decisions, case history, memory, settings, exports; per-institution hash-chained audit written in the same transaction; no DELETE or TRUNCATE rights |
| Injection | Parameterised queries (a concatenated case update was found and fixed); input validation with zod; strict content security policy |
| Hostile uploads | Content sniffing, size and page limits, zip-bomb guard, child process with no shell and a clean environment. No malware scanning (gap) |
| Data leaving the system | Egress deny-by-default with a per-connector allowlist; TLS verification never disabled; no execution stack; actions only as human-owned handoffs |
| Abuse and denial | Rate limits in the proxy and the API; per-route body limits |
| Information leakage | Generic server errors with a request id; log redaction; metrics behind a separate token and hidden from outside |
| Backup theft | Backups and log archive encrypted (AES-256, key from the client's secret store); SHA-256 manifests; tampered backups refused |
| Supply chain | Pinned dependencies, zero known vulnerabilities at last audit, licence allowlist, SBOM, offline bundle, CI audit |

## Control inventory

See [CONTROL-MATRIX.md](CONTROL-MATRIX.md) for each control, its standard mapping, status and where the evidence is.

## Known gaps

These are the same gaps as the second half of [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md): images never built; CI never run; no real identity provider; no independent penetration test; no malware scanning; Arabic OCR unmeasured; no high availability; backup scripts proved on the Debian layout only; no operating-system package inventory; Tiger's values not validated for truth; approximate facility positions; client data never connected.

## Before client data

Decision 11 and the client's review require all of these before institution data or documents are enabled:

1. Independent penetration test, with findings fixed or accepted in writing.
2. Malware scanning in front of uploads.
3. Identity provider checks: multi-factor claim, token endpoint cross-origin permission, redirect addresses, key rotation.
4. Image build and CI run, and review of the image inventory.
5. Backup drill in the client's environment, with the result recorded.
6. The client's own security review recorded, then `TIGERIS_CLIENT_DATA_REVIEW_DONE=true` set deliberately.
7. Arabic OCR checked on real samples if Arabic scans are in scope.

## Reporting a vulnerability

Report to Tiger Capital AI's security contact (to be named in [OPEN-ITEMS.md](OPEN-ITEMS.md)). Do not test against a client's live deployment without written permission.
