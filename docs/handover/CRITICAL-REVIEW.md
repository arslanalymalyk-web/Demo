# Critical review

_Confidential. Property of Tiger Capital AI. Prepared for Tiger Capital AI._

An honest look at the build as it stands: what is strong, what this review found and fixed, what is still missing and why, and what I would add next in order.

## What is strong

- **Integrity is enforced, not promised.** Row-level security on every institution table with a runtime role that owns nothing; immutable evidence, decisions, settings, exports and logs enforced by database triggers (and attacked directly in tests); a per-institution audit hash chain written in the same transaction; no DELETE rights.
- **Numbers are computed by code and verified.** Deterministic scenario engine with exact replay; the model assistant can only return cited text whose every number is checked against stored facts, rejected whole on any failure; notices by email carry no figures.
- **Two-person control** on settings, policy and the ingestion schedule; separation of duty for decisions.
- **Failure is designed for.** Fail-closed malware scanning, back-off and auto-pause for sources, retry and give-up for alerts, a restore drill proved on a real cluster, an error boundary on every screen.
- **Tested end to end.** 311 unit and integration tests against a real database and 32 browser tests against the real API, including Arabic and right-to-left at phone width.
- **Honest documentation.** Every handover document says what was not verified; the verification report lists 19 numbered gaps.

## Found and fixed in this review

| Finding | Fix |
|---|---|
| Four colour pairs in the ivory theme below WCAG AA contrast | Tokens darkened; a test now computes the ratio for every pair in both themes |
| One failing screen blanked the application | Error boundary with a plain message, Arabic too |
| No page titles | Each screen sets its title |
| An uncaught fault would not stop the API cleanly | Process-level handler logs one line and exits so the container restarts |
| Sixteen settings read by the code were documented nowhere | `CONFIGURATION.md` plus a test that fails if a setting is read but not listed |
| No metrics for alerts | `tigeris_alert_conditions_open`, `tigeris_alert_deliveries_24h` |
| Series list took about 300 ms and spilled 22 MB to disk per request; throughput about 55 requests per second | Rewritten with a hash aggregate (about 24 ms); about 213 requests per second at 50 concurrent users |
| Load had never been measured | Measured, recorded in the verification report |
| Application image contents unverified | A production-only install, without Docker, starts the API and every command-line tool |
| Project rules file out of date | `CLAUDE.md` lists the modules and the new rules |
| No dependency update process or disclosure policy | Dependabot configuration and a root `SECURITY.md` (contact still to be named) |

## Still missing, and why

These need something only a person or a real environment can give. None blocks showing the product to the client.

1. **A real identity provider.** The sign-in flow, multi-factor claim, redirect address and key rotation have only run against a development provider.
2. **A real mail relay, model endpoint and scanner database.** Each was tested against a stand-in or a test signature only.
3. **CI on GitHub and the container images.** Neither has ever run; the workflow is valid YAML and the image contents were checked by hand.
4. **An independent penetration test**, required before any client data.
5. **The client's own security review** (decision 11).
6. **Tiger's values and licences**: thresholds, scenario assumptions, Hormuz exposure, source licence confirmations, an approved IMF route (the workbook refuses automated access).
7. **A native Arabic reviewer.** The wording is unreviewed.
8. **Legal wording** for ownership and licence, and the named security contact.

## What I would add next, in order

1. **Translate the remaining screens, and compose computed sentences in Arabic.** Today the executive screens are translated but signal titles, caveats and drafts are English. This is the most visible gap for a Gulf audience. Needs the reviewer first.
2. **Monitor base-backup age.** The database cannot see it, so "backup overdue" is not alerted. A heartbeat written by the backup script would close this.
3. **Pagination and search on large lists.** Lists are capped at 200 rows with no cursor. Fine for the first client's data; needed as evidence grows.
4. **Soak and large-data tests.** Run the schedulers, alert runner and document queue for days, and load a data set an order of magnitude larger, through the proxy.
5. **Token revocation.** Tokens are valid until they expire and are held in memory only. Set short lifetimes in the identity provider; consider a server-side deny list for an urgent removal.
6. **High availability.** One node with fast restore was the chosen design. If the client needs it, the next step is a standby database and a second API node (the scheduler and alert runner already claim work atomically).
7. **Browsers and assistive technology.** Only Chromium is automated, and accessibility is checked structurally and for contrast. A manual WCAG audit with a screen reader should precede a client launch.
8. **Secrets scanning in CI** and a signed release process (images signed, bill of materials attached to each release).
9. **Per-person Arabic or English emails**, once the Arabic is reviewed.

## One decision for you

Showing the product to the client before the items above are done is reasonable if the walkthrough is framed as public records only, with their own data not connected. Real client data should wait for items 1, 4 and 5.
