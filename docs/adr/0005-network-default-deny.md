# ADR 0005: Deny-by-default network egress

Status: Accepted (resolution 5)

## Decision

Every outbound call goes through a connector with an allowlisted host. Vendor hosts are allowed only in installs that are not sovereign or air-gapped. TLS verification is never disabled; broken certificate chains are handled with a reviewed trust bundle.

## Why

Required for sovereign and offline deployments.
