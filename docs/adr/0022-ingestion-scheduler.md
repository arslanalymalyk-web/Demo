# 0022 Ingestion scheduler and source health

Status: accepted. Decisions: single node (one deployment per institution), deny-by-default egress, governed settings (two-person), human-authorized.

## Context
Sources were fetched only by an operator running the ingest command. Stale data was visible on a pack's freshness table but nothing fetched on time, backed off, or told anyone.

## Decision
1. **In-process scheduler**, one pass every minute by default (`packages/scheduler`). One node by design; an atomic database claim (`FOR UPDATE SKIP LOCKED`) still stops a second instance from running the same source. Runs are sequential, each with a time limit. A restart resumes from stored state.
2. **The schedule is a governed setting** (`ingestion_schedule`): which approved sources, how often, the mode, the pause limit and a named steward. Drafted by one administrator, activated by another. With no active schedule nothing is fetched automatically.
3. **Back-off and pause.** After a failure the next try is after 15 minutes, then 30, 60 and so on, never later than the normal interval. After the configured number of failures in a row the source is paused until a person resumes it with a stated reason. Pause, resume and run-now are audited.
4. **Health is read from stored facts**: approval, series age against each series' allowed age, recent runs, quarantine. States: healthy, stale, failing, paused, no data, not approved. Prometheus gauges expose the same.
5. **Cases for stale or failing scheduled sources**, opened through the existing signal-to-case path and owned by the steward the schedule names. Case ownership cannot be transferred, so a system owner would strand the case. One case per condition; closing it does not reopen it for the same condition.
6. **Network.** The API now needs outbound access to source hosts when the scheduler is on. It is off by default, and the compose file keeps the API on an internal network until the client adds the egress network and allowlist. The separate ingest service in compose remains an alternative.

## Consequences
A fetch that hangs is given up after the time limit but the underlying request is not cancelled. Run-now is recorded as a scheduled run. Sources that block automated access, such as the IMF workbook returning 403, fail, back off, pause and open a case rather than being retried forever.
