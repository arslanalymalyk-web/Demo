# 0024 First-run set-up and readiness

Status: accepted. Decisions: one deployment per institution; separation of duty; the runtime role owns nothing.

## Context
A new deployment needed several manual steps (migrate, seed, add people one at a time, seed the policy, register sources), with no check that the identity provider would work. The old seed script could not tell that an institution already existed, because row-level security hides other institutions, so a second run made a second institution.

## Decision
1. **One command, two modes** (`packages/setup`): `check` is read-only (migrations applied, owner and runtime roles, identity provider); `apply` creates the institution, the seven roles, the administrators, the default policy and the source registry, and prints the institution id for the configuration. Re-running with that id repairs or extends and never duplicates.
2. **Two administrators are required.** Settings and policy activation need a second person, so a deployment with one administrator is stuck.
3. **The identity provider is checked from outside** (issuer, PKCE, asymmetric keys, token endpoint access for the web origin). What cannot be checked from outside (multi-factor claim, redirect registration, key rotation) is listed for a person. A provider problem does not stop set-up: the provider may only be reachable from the application network.
4. **Existing people are never changed** by set-up. Roles change only under Administration, which is audited.
5. **The source registry is loaded as the registry records it.** Approval is the registry's recorded status; set-up does not approve anything by itself, and the screen tells the administrator to confirm each licence.
6. **A Readiness screen** (administrators and auditors) reads the same facts after set-up: blockers, decisions and by-hand confirmations.

## Consequences
The institution id must be kept: a run without it creates a new institution. The set-up identity checks do not replace a real sign-in test.
