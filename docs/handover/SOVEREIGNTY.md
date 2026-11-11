# Sovereignty assessment

_Confidential. Property of Tiger Capital AI. Written from the point of view of the institution that owns the deployment._

"Sovereign" here means five things an owner can test: **the institution holds the data, holds the keys, can stop the system, can leave it, and can prove nobody changed the record behind its back.** This page checks each against the code and says plainly what is built, what was only built and tested on a development machine, and what is still missing. Nothing here has run on a client's infrastructure yet.

## Where the work is

All of it is in the repository (`main`), committed and pushed. It has not been deployed anywhere: the container images have never been built and no client environment exists. "Built" below means code, tests against a real PostgreSQL, and a browser suite against the real API. It does not mean proven on the client's hardware.

## The scorecard

| # | What an owner needs | Status | Evidence | What is missing |
|---|---|---|---|---|
| 1 | **One deployment per institution, on the institution's own infrastructure** | Built | Compose files, forced row-level security, start-up checks | Never run on a client host. Images never built. |
| 2 | **The data stays inside** | Built | Egress deny by default in the application; the database and API sit on an internal network; no telemetry or outside web assets (checked: no external fonts, scripts or analytics) | The compose file gives the API a route out for the identity provider (see gap A). Not tested against a real firewall. |
| 3 | **Public-record data only, until the client's own review** | Built | Data-class gate; institution documents off in production until the review is recorded | Depends on the client recording the review honestly. |
| 4 | **Model-agnostic, no vendor lock-in** | Built | Three adapters (extractive, Anthropic, OpenAI-compatible including an on-premises model); off by default; answers verified by code | Never tried against a real endpoint or an on-premises model. |
| 5 | **Humans authorize; the system executes nothing** | Built | No execution stack; handoffs are human-owned tasks | None found. |
| 6 | **The institution holds the keys** | Partly | Secrets from files; backups encrypted with the client's key; audit checkpoints signed with a key outside the database (new) | Document bytes and text are stored unencrypted in the database and rely on disk encryption (gap B). |
| 7 | **Nobody can change the record unnoticed** | Built, with a stated limit | Append-only triggers, a hash chain written in the same transaction, and (new) signed checkpoints | The database owner role can switch triggers off. The test in `tests/sessions.test.ts` does exactly this and rewrites a whole chain; only the checkpoint catches it. So a checkpoint must be taken and kept off the server (gap C). |
| 8 | **Access can be cut at any moment** | Built (new) | Disable a person (immediate); end one person's sessions; end everyone's; sessions capped at eight hours by default; sign-out ends all of a person's sessions | Depends on the identity provider for sign-in itself (gap E). |
| 9 | **The owner can stop the system** | Built (new) | Emergency stop refuses all ordinary requests, model calls, uploads and scheduled fetches; administrators and auditors keep the investigation and release routes; both changes are audited with the reason | Does not cut the network. A firewall rule is the stronger stop (gap A). |
| 10 | **The owner can leave** | Partly | Own PostgreSQL, own backups, case exports with integrity hashes | No whole-institution export in an open format (gap D). |
| 11 | **Supply chain the owner can inspect** | Partly | Pinned dependencies, zero known vulnerabilities at last audit, licence allowlist, SBOM, offline install bundle | No signed releases; images not pinned by digest; npm packages only in the bill of materials (gap F). |
| 12 | **Continuity** | Partly | Encrypted point-in-time backups, restore drill, monitoring of base backups (alerts, readiness) | Single node by decision; drill not run in the client's environment or the official image. |
| 13 | **Rights to the data it shows** | Partly | Sources need an approved status; licence fields recorded | Licence confirmations are open items for Tiger. |

## Found in this audit and fixed

| Finding | Fix |
|---|---|
| A token stayed valid until its own expiry; the identity provider could issue a long-lived one and nothing here bounded it. There was no way to end a session short of disabling the person. | A maximum token age (`OIDC_MAX_TOKEN_AGE_SECONDS`, eight hours by default; tokens without an issue time are refused). Administrators can end one person's sessions or everyone's, with a recorded reason. Signing out now ends all of the person's sessions, not just the browser's copy. Migration 0018. |
| The audit chain uses an unkeyed hash. Someone with full database rights can rewrite every event and recompute the chain, and `verify` still says "intact". Shown by a test. | Signed checkpoints: the head of the chain signed with a key kept outside the database (`TIGERIS_AUDIT_ANCHOR_KEY`). Verification detects an altered checkpoint, another key, rewritten history and a chain cut short. Screens on the Audit page. |
| No emergency stop. The only way to freeze the system was to shut containers down, which also removes the ability to investigate through it. | Lockdown (migration 0019): refuses everything except the investigation and release routes, pauses scheduled fetching, audited. Screen on Administration. |
| Readiness did not mention encryption at rest or the audit signing key. | Two new checks: audit signing key (warns when absent) and storage encryption (a manual confirmation). |

## Still missing, with the solution

Ordered by how much a sovereign owner should care.

**A. The API can reach the internet by default.** The compose file puts the API on a network (`idp`) that has an outside route so it can fetch the identity provider's signing keys; the comment says to restrict it, but nothing ships that does. A mistaken or hostile change could send data out and the container network would not stop it. *Solution:* ship a forward proxy that allows only the identity provider, the mail relay and (when on) the model endpoint, make it the API's only route, and add a host firewall rule as the second layer. Test it in the client's environment with a deliberate blocked request. This needs Docker and a firewall, so it could not be built or proved on the development machine.

**B. Document contents are stored in plain form in the database.** A database administrator or anyone holding a backup that is not encrypted could read them. Backups are encrypted, but the live database relies on disk encryption the application cannot check. *Solution:* encrypt document bytes and extracted text with a key from the institution's secret store (AES-256-GCM, a key version recorded per row so it can be rotated), decrypting only in the API. Documents are switched off until the client's review, so this belongs before that switch. Search over extracted text needs a design decision: encrypting the text removes database search.

**C. A checkpoint is only useful if it is taken, and stored away from the server.** Nothing takes one automatically and nobody is reminded. *Solution:* a scheduled checkpoint written to a place the client chooses (a write-once bucket or a second machine), an alert when the last one is older than a set age, and a named person who owns checking it. The key must not be readable by the database administrator.

**D. No way to leave in an open format.** The data is in the institution's own PostgreSQL, so it is not locked in, but a person who does not run PostgreSQL has no export. *Solution:* a command that writes every table as newline-delimited JSON with a manifest of hashes and the audit chain, and a documented restore path. This is also the best answer to a regulator's "can you give me everything".

**E. Sign-in depends on one outside system.** If the identity provider is down or its owner changes terms, nobody can sign in, and there is no recorded emergency path. *Solution:* a written break-glass procedure (a second provider registered for two administrators, or a time-limited operator token issued with two people present), tested, and an alert when the provider's keys cannot be fetched. This is an institutional decision more than code.

**F. Releases are not signed, and the bill of materials stops at npm.** *Solution:* sign images with the client's key, pin them by digest, add the base image and operating-system packages to the bill of materials, scan for secrets in CI, and make the client's own build the one they deploy from. CI has never run; this waits on that.

**G. Administrators can grant roles to themselves.** One administrator can add any role to any person, including themselves, and it is audited but not approved by a second person. Settings changes already need two people. *Solution:* require a second administrator to approve granting `administrator` or `approver`, and alert on any grant. Decide with the client whether the added friction is wanted in a small team.

**H. Vendor access is undefined.** Nothing in the product lets Tiger Capital AI reach the deployment, which is right, but no written rule says what support access exists, who approves it, for how long, or how it is recorded. *Solution:* a short policy: no standing access; time-limited, client-approved, recorded access through the client's own remote tools; audit export afterwards.

**I. Lockdown is a software stop.** It refuses requests but the process, the database and the scheduler containers keep running. *Solution:* pair it with a documented network cut-off (A) and a runbook step for suspending the egress network.

**J. The proof is on a development machine.** The identity provider, mail relay, scanner signatures, the official PostgreSQL image, the container build, the proxy and a penetration test are all still open (see [OPEN-ITEMS.md](OPEN-ITEMS.md)).

## What I would do next

1. **D (export)** and **C (scheduled checkpoints with an alert)**: no client input needed and they complete the "can leave" and "can prove" claims.
2. **B (encrypt documents)**: before documents are ever enabled.
3. **A, E, F, H**: with the client's infrastructure and decisions; the written parts (E, H) can be drafted now for review.
4. **G**: decide with the client.
