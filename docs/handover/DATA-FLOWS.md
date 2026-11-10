# Data flows

_Confidential. Property of Tiger Capital AI. Prepared for the client's IT and security team._

## Flows

| # | From | To | Data | Protection |
|---|---|---|---|---|
| 1 | Public source hosts (DataSaudi, IMF, JODI, EIA and others on the allowlist) | Ingest connectors in the API | Public records | Egress allowlist, verified TLS, low request rate, robots.txt honoured; started by an operator command or, when enabled, by the in-process scheduler under a governed schedule; stored as immutable evidence with provenance |
| 2 | Person's browser | Proxy, then API | Requests with a bearer token | TLS 1.2 or 1.3, security headers, rate limits, access rules |
| 3 | Person's browser | Identity provider | Authorization-code flow with PKCE | Client's provider; token kept in browser memory |
| 4 | API | Identity provider (JWKS) | Public signing keys | https required in production |
| 5 | API | PostgreSQL | All records | Internal network only; restricted role; forced row-level security |
| 6 | Person's browser | API | Uploaded documents (only when institution documents are enabled) | Size, page and type limits; processed in a restricted child process; not malware scanned |
| 7 | API | Case exports (download) | Case record, audit events, integrity hash | Permission `export.run`; export itself recorded |
| 8 | Database | Backup service | Base backups and write-ahead log | Encrypted before storage; key from the client's secret store |
| 9 | Monitoring system | `/metrics` | Counters and timings, no record content | Separate bearer token; blocked at the proxy from outside |
| 10 | API | Handoff to the institution's own systems | Human-authorized tasks | A person owns each handoff; no automatic execution |
| 11 | API | The configured model endpoint (only when a model is connected) | A prompt of numbered stored facts, public-record, sample and scenario classes only | https required in production, host on the network allowlist, key from the secret store, no redirects, every call logged. Institution data, licensed and third-party derived data are withheld; text typed into cases is never sent |

## What does not flow

- No client data leaves the deployment. No data goes to other institutions. No learning is shared across institutions.
- No data is sent to a model vendor unless the client connects one. Then only public-record, sample and scenario facts go in a prompt. Models do not compute or write facts.
- No vessel or tanker tracking data is used until written terms exist.
- Institution documents and client data are switched off until the client's review is complete (decision 11).

## Data classes

Public record; Sample dataset; Scenario simulation; Tiger-set value (a governed setting, with who, when, why and version); Institution data (switched off). Each displayed number carries its data class with the other five provenance fields.

## Residency

Data stays on the client's own infrastructure. Backups stay wherever the client points the backup service.
