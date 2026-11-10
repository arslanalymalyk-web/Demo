# Open items: what is needed from people

_Confidential. Property of Tiger Capital AI. Prepared for the named recipients only._

## From Tiger Capital AI

1. Real signal thresholds, scenario default assumptions and ranges. The values now active are working values; the system proves who set them, not that they are right.
2. Sourced Hormuz exposure and bypass capacity values (currently labelled by link class and rationale).
3. Verified facility positions, checked against a gazetteer. Positions are approximate until then.
4. The USPTO blueprint material, and any written terms for TankerMap or vessel data.
5. Legal wording for ownership and licence, and the signed NDA and data processing agreement filed with the pack.
6. Name a security contact for vulnerability reports.
7. Owner-written policies for the Organisational rows in [CONTROL-MATRIX.md](CONTROL-MATRIX.md): security policy set, risk register, staff process, continuity plan.

## Source rights and data

1. Licence confirmations for DataSaudi, GCC-Stat, JODI and IMF.
2. An approved access route for IMF data. The IMF commodity workbook currently answers automated requests with HTTP 403, so a scheduled fetch of it fails and pauses.
3. The unit for GDP and the period of the M3 growth rate.
4. Permission requests to the Qatar and Bahrain data teams.
5. Widening Gulf coverage to the UAE, Qatar, Oman and Iran once rights are confirmed. Iraq data stops at March 2024 and is shown as lagging.
6. Arabic scan samples to measure OCR accuracy.

## From the client

1. Identity provider details: issuer, audience, redirect addresses, the multi-factor claim, token endpoint cross-origin permission, key rotation. Then a real sign-in test.
2. The client's own security review, recorded, before client data or institution documents are enabled.
3. A host, TLS certificate, secret store and backup location.
4. The names of the first administrators (two, for settings approval).

## Arabic interface

1. A native Arabic reviewer for `apps/web/src/i18n-ar.ts` and the terms table in [I18N.md](I18N.md), before the interface is shown to a client.
2. Decide whether the remaining screens (Evidence, Documents, Cases, Scenarios, Settings and the rest) are translated in the next release.
3. Decide whether sentences computed from the stored records are composed in Arabic on the server. This needs structured values and a review of every sentence so that no figure changes.

## Scheduled ingestion

1. Which approved sources to fetch automatically and how often.
2. The steward who owns cases for stale or failing sources, and the number of failures before a source pauses.
3. A decision on whether the API may have outbound access (scheduler on) or fetching stays in the separate ingest service.

## Model use

1. Decide the provider (Claude API, an OpenAI-compatible service, or an on-premises model) and obtain its key or address.
2. A written data-processing position from the provider, before anything real is sent.
3. Try the real adapter against the chosen endpoint and record the result.

## Engineering and verification

1. Run the CI `images` job and review the image inventory (the images have never been built).
2. Run the CI workflow on GitHub.
3. Run the backup drill in the client's environment and against the official PostgreSQL image.
4. Commission the independent penetration test (decision 11).
5. Run the malware scanner with its real signature database in the client's environment and confirm signature updates (the hook is built and tested with a test signature only).
6. A dedicated environment setup script for the development cloud environment: Tesseract and PostgreSQL were installed only in the working container and are not in the shared default environment.
7. Decide whether high availability is needed beyond the first client.

## Known data notes

- One early scenario run (`e75437b4…`) replays with a different results hash, because its stored bands predate the clamp for non-negative measures. Its stored rows still match. It is immutable and is disclosed rather than edited.
- The development database holds extra test cases, a legal hold on CASE-0004, one case export and extra development principals. They cannot be deleted by design and must not be carried into a client deployment; create a fresh database there.
