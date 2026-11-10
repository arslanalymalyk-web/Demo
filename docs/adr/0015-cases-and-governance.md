# ADR 0015: Cases and governance

Status: accepted. Implements the case lifecycle and decision-authority flow in the UI/UX brief, and decisions K4 to K6.

- A case runs open, analysis, in review, decided, closed. It opens with a frozen graph snapshot. Evidence and scenario runs are attached, never overwritten. A closed case cannot change.
- Proposals carry an action class: monitor, advisory or handoff. A handoff is a task for a person in the institution's own systems. The system records it and never executes it (ADR 0004).
- A proposal reaches a named reviewer only if the active policy returns PASS. HOLD and BLOCK stop it with the rule ids and reasons. There is no override in the case interface.
- Policy is data: declarative rules evaluated by deterministic code, stored as immutable versions. A new version is drafted, then activated by a different administrator. With no active policy every submission is refused.
- The decision uses a fresh evaluation, not the one made at submission. Authority comes from the policy by action class, not from the role alone. Approval needs PASS; rejecting, deferring and requesting evidence are always possible.
- Separation of duty is enforced in code: the owner cannot review their own case, the reviewer cannot have written the proposal, only the named reviewer can decide, and the reviewer decides against the case version they saw.
- Decisions, policy decisions, case events and memory records are append-only in the database. Recommendations, policies, handoffs and cases are only mutable in named columns, enforced by triggers.
- Restricted cases are visible only to participants and auditors. A case a person may not see is reported as not found.
- Only a decided and closed case enters institutional memory, with the rationale and outcome. Nothing leaves the institution and nothing trains a model.
- The default policy is bootstrapped by the system actor with `pnpm governance seed-policy` and audited as such.
