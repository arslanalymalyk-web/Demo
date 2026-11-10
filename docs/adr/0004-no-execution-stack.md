# ADR 0004: No in-house execution stack

Status: Accepted (resolution 4)

## Decision

Actions leave the system only as human-authorized handoffs or through adapters into the institution's own systems (order management, treasury). Any later execution module needs separate regulatory review and its own decision record.

## Why

The client orchestrates existing platforms and is not a portfolio engine. Staged autonomy (read-only, advisory, thresholded) is expressed as policy, disabled by default.
