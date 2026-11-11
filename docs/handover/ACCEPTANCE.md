# Acceptance in the institution's own environment

_Confidential. Property of Tiger Capital AI. For the institution's IT and security team._

Everything in this pack was proved on a development machine. This page is how the institution proves it on its own: one command that checks what it can, and a list of the things a person has to do and show. It does not replace the institution's own review. It produces a report the institution can file.

## 1. Run the checks

```bash
node scripts/acceptance.mjs --api https://tigeris.client.example --web https://tigeris.client.example \
  --token <administrator token> --auditor-token <auditor token> --analyst-token <analyst token> \
  --environment "client production" --out acceptance \
  --evidence egress=egress.txt --evidence restore-drill=drill.txt --evidence pentest=report.pdf
```

Tokens are real sign-ins through the institution's identity provider (copy the access token from a signed-in session). If the institution uses its own certificate authority, point `NODE_EXTRA_CA_CERTS` at it; the script never turns certificate checks off. Two optional flags act on the system: `--mail-test` sends one test message to the administrator, and `--eicar` uploads the standard anti-virus test string as an institution document, which leaves one permanent quarantined record.

| Check | What it proves |
|---|---|
| API answers and is ready | The service is up and its database answers |
| TLS 1.2 or 1.3 only, trusted certificate, at least 14 days left | The public address meets the transport rules |
| Security headers; web app has its identity-provider settings | The proxy image is configured (this check would have caught a real defect found while building the image: see VERIFICATION-REPORT item 26) |
| Administrator signed in; the token carries a multi-factor claim | A real identity provider works with real multi-factor sign-in |
| Readiness has no failures; base backups recorded and recent; emergency stop off | The installation's own self-assessment, read from outside |
| Audit chain verifies; a signed checkpoint is taken and verified | Tamper evidence works, with the signing key set |
| Mail relay accepted a test message (`--mail-test`) | Alerts reach a person |
| Scanner flagged the anti-virus test string (`--eicar`) | The real scanner, with its real signatures, works |

## 2. Do and show the rest

Each of these needs a person and produces a file. Give the file with `--evidence <name>=<file>`; the report records its SHA-256 and marks the item PASS. **The script does not judge the file.** A reviewer reads it.

| Name | What to do | What to attach |
|---|---|---|
| `egress` | In the API container: `node scripts/egress-check.mjs`. It shows that there is no direct route out and that the proxy refuses a host that is not on the list. Load `deploy/egress/nftables.conf` on the host as the second layer and repeat. | The output |
| `restore-drill` | Run `deploy/backup/verify-restore.sh` against a backup, on the official PostgreSQL image, in this environment | The output |
| `pentest` | An independent penetration test, scope below | The report and the retest letter |
| `break-glass` | With both custodians, make a token (`pnpm identity break-glass issue`), sign in on the sign-in screen, confirm the alert reached the administrators, then end the sessions | A short signed note of the drill |
| `checkpoint-store` | Show that the database administrator cannot change or delete the checkpoint folder | Screenshots or a command transcript from the storage system |
| `release` | `node scripts/verify-release.mjs` against the release manifest for the images actually deployed | The output |
| `tls-cert` | The certificate for the public name was issued by the institution's certificate authority | The certificate chain |

The result is **ACCEPTED** only when nothing failed and nothing is open. It is **INCOMPLETE** while any manual item has no evidence and **NOT ACCEPTED** while anything fails. Add `--sign-key` to sign the report with a release key.

## 3. Penetration test: scope and rules

A test is independent when the testers are not the people who built or run the system. Brief them with this.

**In scope:** the public address and every `/v1` route; sign-in and token handling (including forged, expired, over-age, wrong-audience and no-multi-factor tokens, and emergency tokens); role and route access (every route has an access rule, and the test should try every role against every route); cross-institution access (one deployment serves one institution, so test that nothing about another can be reached or guessed); file upload (size, type, archive bombs, the malware scanner, filenames); injection into every query parameter and header; rate limits; the emergency stop; the egress boundary from a compromised API container; backups and the audit chain (including an attempt to rewrite history with owner rights, which signed checkpoints should reveal); the checkpoint folder.

**Out of scope without further written agreement:** denial-of-service beyond the rate limits, social engineering of staff, the institution's identity provider and mail relay themselves, physical access.

**Rules:** a named, non-production copy first (the system refuses to enable institution documents in production until the security review is recorded), then a short window on production only if the institution chooses; testers use the test accounts created for them with an expiry (see [VENDOR-ACCESS.md](VENDOR-ACCESS.md)); the emergency stop is the testers' and the institution's shared abort; findings are rated and each high or critical one is retested.

**What to ask for:** a report with reproduction steps, a rating for each finding, a statement of what was not tested, and a retest letter after fixes. File it as evidence `pentest`.

## 4. What this still cannot show

An acceptance report shows the state on the day it was run. It does not show that the data is true, that Tiger's thresholds are right, or that staff follow the procedures. The institution's own policies (risk register, staff process, continuity plan) remain the owner's to write.
