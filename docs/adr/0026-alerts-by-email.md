# 0026 Alerts by email

Status: accepted. Decisions: network deny-by-default; no record content leaves the deployment; human-authorized.

## Context
Flagged files, failing sources, decisions waiting and system faults were visible only on screen. Nobody was told.

## Decision
1. **Email through the client's own mail relay** (SMTP with STARTTLS or TLS, credentials from the secret store), sent with a maintained library. No third-party mail service. TLS to the relay is verified; there is no switch that turns that off. Production refuses an unencrypted relay and the development log transport.
2. **Four categories**: malware flagged, data source needing attention, decision waiting for a reviewer, and operations (audit chain, malware scanner, database log archive).
3. **A notice carries nothing from the records.** Fixed bilingual text, a category, an optional reference code (a case key or a document code), and a link to the application. Rendering refuses any reference or link that is not a plain code or an application path. A test checks that no message contains a digit outside the link and the reference.
4. **One notice per condition.** A condition is announced once, reminded about daily while it stays open (configurable), and a single note follows when it clears. A flagged file is a one-time event. A person who already received a notice is not sent it again on a retry for others.
5. **Failure is handled, not hidden.** A failed send is retried with back-off (5 minutes doubling to 2 hours), stops waiting on an unreachable relay for the rest of a pass, gives up after six attempts until the next reminder, and is logged. An hourly cap limits a flood.
6. **Who receives what.** Malware and operations notices go to administrators and auditors and cannot be switched off. Source notices go to the steward named in the ingestion schedule and to administrators. Review notices go to the named reviewer only. A person may switch off source and review notices.
7. **Addresses are set by administrators**, stored with a database check that rejects line breaks, shown masked to the person, and never written to the log, the audit trail or the delivery table (which name people).
8. **Every attempt is recorded** in an immutable table; each notice writes an audit event with counts only.

## Consequences
Email is not a secure channel, so it carries no content. The database cannot show how old the last base backup is, so "backup overdue" is reported as a failing log archive only. Message text is fixed English and Arabic; the Arabic has not been reviewed by a native speaker.
