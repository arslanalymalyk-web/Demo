# ADR 0018: Sector command centres

Status: accepted. Implements the Command Centre in the UI/UX brief for the two first-release packs (decision 2): Energy and Oil, and Sovereign Capital and Treasury.

- A command centre is a view over stored evidence, scoped to a pack. It shows key figures, an attention queue, trends, the pack's scenarios, its cases and the decisions waiting for the signed-in person, and the freshness of the pack's series. It holds no data of its own and shows nothing it cannot open to a source record.
- The attention queue comes from fixed, versioned rules (`signal-rules/1`) over stored series. No model decides what is surfaced. Thresholds are first-release defaults, listed on the page, and meant to be set by each institution.
- A signal is computed, not stored. It has a stable id (rule, subject, period). Opening a case from a signal re-computes it, so a signal that is no longer active cannot start a case. The case records the rule version and values, attaches the signal's own evidence, and an existing open case for the same signal is returned instead of a duplicate.
- A country whose newest stored month is older than the others is shown as lagging and never compared or summed into the current total. A figure whose source leaves something unstated says so on the card.
- Everything is labelled Public record. Institution-specific content stays a labelled sample dataset until client data is connected.
- Not built, by decision: other sector packs (Banking, Infrastructure, Insurance, Manufacturing, and so on) wait for the later release.
