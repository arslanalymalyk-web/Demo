# Executive summary

_Confidential. Property of Tiger Capital AI. Prepared for the named recipients only._

## What it is

TIGERIS AI OS is an intelligence system owned by the institution that runs it. Every figure on screen opens to its source record. Every protected change (a decision, a setting, a case step) is written to a tamper-evident trail. Models never compute or write facts; deterministic code does. One deployment serves one institution, and nothing crosses between institutions.

## What exists today

- **Core:** ingestion of public records with provenance, a link graph with explicit link classes (observed, sourced, inferred, assumed, sample), a deterministic scenario engine with exact replay, identity with multi-factor sign-in and seven roles, governance and cases with a policy gate and human-owned handoffs, institutional memory, document intake with OCR, governed settings approved by two people, and ten-year retention tools, an executive briefing per pack, a model-agnostic assistant whose every figure is verified against stored records, scheduled ingestion with a source-health screen, fail-closed malware scanning of uploads, email alerts for flagged files, failing sources, decisions waiting and system faults, and an Arabic interface (right-to-left layout on every screen, Arabic wording on the executive screens, pending native review).
- **Two packs:** Energy and Oil, and Sovereign Capital and Treasury. Each has three scenario templates and a command centre with signal rules.
- **Live map:** Gulf map built from public-domain geography, with chokepoints, routes, terminals and stored series drawn on it. Facility positions are approximate and routes are schematic, and the screen says so.
- **Real data:** DataSaudi, IMF, JODI and an EIA article are stored with provenance. Example findings from stored data: Saudi crude exports are 31% below their 12-month median, and reserve assets fell 5.8% in the latest quarter.
- **Delivery:** containers for the client's own infrastructure, a TLS reverse proxy, encrypted point-in-time backups, health and metrics endpoints, a software bill of materials, and an offline install bundle.

## What is proved

311 automated tests pass against a real database, and 32 browser tests walk every screen against the real API. A disaster-recovery drill, a proxy and browser test, an offline install and a dependency audit (zero known vulnerabilities) were run for real. See [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md).

## What is not proved

The container images were never built and the CI workflow has never run, because the build host had no container daemon. No real identity provider has been tested. There has been no independent penetration test, no test of the malware scanner with its real signature database, and no measurement of Arabic OCR accuracy. Client data has never been connected. The full list is in the second half of the verification report.

## What the client's data policy is

The NDA and data processing agreement are signed. By decision 11, client data and institution documents stay switched off until the client's own security review is complete. The system refuses to enable institution documents in production until that review is recorded.

## What is needed to go further

See [OPEN-ITEMS.md](OPEN-ITEMS.md). In short: Tiger's thresholds and assumptions, source licence confirmations, the client's identity provider details, an independent penetration test, and a run of the image build and backup drill in the client's environment.

## Control posture

A control matrix maps what is built to SOC 2 first, then ISO 27001:2022. Rows are marked Implemented, Partial, Organisational or Gap. It is a self-assessment of the build, not an audit report. See [CONTROL-MATRIX.md](CONTROL-MATRIX.md).
