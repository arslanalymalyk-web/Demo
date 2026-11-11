# Vendor and support access

_Confidential. Property of Tiger Capital AI. For approval by the institution._

This is a proposed policy for any person from Tiger Capital AI, or any other supplier, who needs to look at a running deployment. It is written to be adopted, changed or rejected by the institution. Nothing in the product gives the supplier access by itself: there is no remote shell, no phone-home, no support account and no shared secret. Anything below happens only because the institution chose it.

## Rules

1. **No standing access.** The supplier holds no account on the institution's systems between engagements. A person who is not employed by the institution is never an administrator or approver.
2. **Access is requested, approved and written down.** The request names the person, the purpose, the roles needed and the time needed. Two of the institution's administrators agree to it. The request and both approvals are kept by the institution; the system adds its own record when the account is made.
3. **Least role, shortest time.** Use `auditor` to look and `operations` to restart or fix ingestion. Do not use `administrator` or `approver`: granting either needs a second administrator in the product anyway, and a supplier does not need to hold them to be helped.
4. **Every account has an end.** The account is created with an expiry (Administration, "Access ends"). The product refuses the person after it, however the identity provider behaves. Default: the working day, never more than seven days; renew with a reason rather than create a longer one.
5. **Through the institution's own tools.** The person signs in with the institution's identity provider, from the institution's remote-access service, with the institution's multi-factor sign-in. If a screen share is needed, the institution's staff drive it.
6. **Nothing leaves.** The supplier does not copy records, exports or logs off the institution's network. If a log excerpt is needed for diagnosis, the institution's staff redact and send it.
7. **Reviewed afterwards.** When the engagement ends an auditor opens "what this person did" (the activity route, `GET /v1/identity/principals/<id>/activity`) and reads it against the purpose. The review and its date are filed with the request.
8. **Emergencies.** If the identity provider is unavailable, the break-glass route in the runbook applies, with both custodians present. A supplier is never a custodian.

## How it is done in the product

| Step | What to do | What the system records |
|---|---|---|
| Create the account | Administration, add a person, role `auditor` or `operations`, set "Access ends" | `identity.principal_provisioned` with the expiry |
| Change the end time | Administration (or `PUT /v1/identity/principals/<id>/expiry`) with a reason | `identity.expiry_changed` with old and new time and the reason |
| End early | "End sessions" and "Disable" | `identity.sessions_revoked`, `identity.principal_disabled` |
| Review | Auditor reads the person's activity | the read itself is an ordinary request in the log |
| After the end time | Nothing; the account is refused, hidden from pickers and sent no notices | `identity.denied` for any attempt |

## What this does not give you

- It does not stop a person with legitimate `auditor` access from reading what an auditor can read; the review is how that is checked.
- It does not control the supplier's own laptops or accounts.
- Expiry is checked on every request by the API, but a running browser session is only ended when the person next calls the API.

## For the institution to decide

Who approves; the longest engagement without a new request; whether `operations` may be given at all; where requests and reviews are filed; whether the supplier must name a second person who can be reached while access is open.
