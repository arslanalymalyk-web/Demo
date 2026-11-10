# Decision log (from the 200-question form, 10 Nov 2026)

Source of truth: the saved answers on the published form (version 230). Flags: CONFLICT-n = needs resolution before building; OPEN = depends on something we do not have yet; NOTE = needs a guard rail.


## A. Ground rules and vocabulary

| ID | Decision | Flag |
|---|---|---|
| A1 | B) Demo, demonstration, prototype, mock, MVP and POC |  |
| A2 | A) Sample dataset |  |
| A3 | A) Public record |  |
| A4 | A) A source-class badge on every figure |  |
| A5 | A) TIGERIS AI OS |  |
| A6 | A) تيجريس |  |
| A7 | A) AI-Native Sovereign Intelligence Operating System |  |
| A8 | A) Intelligence into Capability. Capital into Sovereign Advantage. everywhere |  |

## B. Product definition

| ID | Decision | Flag |
|---|---|---|
| B1 | Other: All of Above |  |
| B2 | A) Institution-owned deployment (not SaaS) |  |
| B3 | C) Separate products per sector | CONFLICT-1 |
| B4 | A) First domain pack under the OS |  |
| B5 | A) A gap and diagnosis report |  |
| B6 | A) Embedded in every case, always with citations |  |
| B7 | A) Yes, a dedicated executive surface |  |
| B8 | A) Reusable for any country, Saudi Arabia first |  |
| B9 | A) Evidence-traceable decisions |  |
| B10 | A) In product copy and sales material |  |

## C. Scope and definition of done

| ID | Decision | Flag |
|---|---|---|
| C1 | A) A working system on real public data plus a configured reference institution |  |
| C2 | D) Four or more | CONFLICT-2 |
| C3 | A) Energy and Oil |  |
| C4 | A) Sovereign Capital and Treasury |  |
| C5 | A) Flagship scenario pack with a canonical event |  |
| C6 | A) Real ingestion, graph, scenario, approval and audit, end to end |  |
| C7 | C) A joint committee |  |
| C8 | A) 100 percent traceable or suppressed |  |
| C9 | A) Yes, with local models |  |
| C10 | A) English and Arabic, full right-to-left |  |
| C11 | A) Desktop and tablet |  |
| C12 | A) Weekly builds, bi-weekly client review |  |

## D. Autonomy and execution

| ID | Decision | Flag |
|---|---|---|
| D1 | A) Nothing; human-authorized handoff only |  |
| D2 | A) Yes, as product stages |  |
| D3 | A) Named human roles defined by policy |  |
| D4 | A) Material actions as defined by policy |  |
| D5 | A) Versioned policy-as-code per institution |  |
| D6 | D) A full execution stack | CONFLICT-4 |
| D7 | A) Yes, in the first release | NOTE |
| D8 | A) A per-institution halt for all automated actions |  |
| D9 | A) Immutable ledger with replay |  |
| D10 | A) Governed autonomy, human authority retained |  |

## E. Architecture decisions

| ID | Decision | Flag |
|---|---|---|
| E1 | A) The USPTO blueprint when received | OPEN |
| E2 | A) Build behind adapters and review it later |  |
| E3 | A) Modular monolith |  |
| E4 | A) TypeScript service plus a Python reasoning service |  |
| E5 | A) React |  |
| E6 | A) PostgreSQL |  |
| E7 | A) PostgreSQL adjacency behind a repository interface |  |
| E8 | A) PostGIS plus TimescaleDB |  |
| E9 | A) Postgres-backed queue with a state machine |  |
| E10 | A) Postgres outbox, no broker at first |  |
| E11 | A) S3-compatible (for example MinIO) |  |
| E12 | A) pgvector |  |
| E13 | A) Open Policy Agent |  |
| E14 | A) REST with OpenAPI |  |

## F. Deployment and sovereignty

| ID | Decision | Flag |
|---|---|---|
| F1 | A) A single on-premise Linux host or VM |  |
| F2 | A) Signed OCI containers |  |
| F3 | A) Signed offline bundles with a manifest |  |
| F4 | A) An in-region Gulf cloud, public data only |  |
| F5 | A) We publish a reference specification; client or we provision |  |
| F6 | A) None leaves the institution; opt-in support bundles |  |
| F7 | A) Signed licence files |  |
| F8 | A) Not in the first release; one deployment per institution |  |
| F9 | A) Scripted, encrypted, with tested restores |  |
| F10 | A) Single node with backups |  |
| F11 | A) The client, in its own KMS or HSM |  |
| F12 | B) Allow vendor hosts | CONFLICT-5 |

## G. Models and AI

| ID | Decision | Flag |
|---|---|---|
| G1 | A) A gateway: local first, remote optional |  |
| G2 | A) Open-weight models chosen by our own benchmark |  |
| G3 | A) Include Arabic-strong models in the evaluation set |  |
| G4 | A) Allowed if the client policy permits, off by default |  |
| G5 | A) Optional adapters, disabled by default |  |
| G6 | D) Both | NOTE |
| G7 | A) Custom typed workflows, no open-ended loops |  |
| G8 | A) Six generic typed agents plus sector configurations |  |
| G9 | A) Deterministic calculators only; models never compute |  |
| G10 | A) Citation required or the system refuses |  |
| G11 | A) A golden question set scored on every build |  |
| G12 | A) Pin the model and prompt per run and replay |  |
| G13 | A) Never by default |  |
| G14 | A) Governed memory feedback with no weight updates |  |

## H. Data sources and ingestion

| ID | Decision | Flag |
|---|---|---|
| H1 | A) DataSaudi plus the GCC portals |  |
| H2 | A) Ingest through its API and record the original agency |  |
| H3 | A) Ingest selected themes |  |
| H4 | A) Ingest after licence confirmation |  |
| H5 | A) Ingest |  |
| H6 | A) Request authorized access or data agreements |  |
| H7 | A) JODI plus EIA (free key) plus IMF commodity prices |  |
| H8 | A) UK CSV and OFAC downloads first; UN list later |  |
| H9 | A) Add after its host is allowed |  |
| H10 | A) A rights-cleared commercial provider | CONFLICT-7 |
| H11 | A) Use it for interface reference only | CONFLICT-7 |
| H12 | A) Adapter interface now, connector when licences exist |  |
| H13 | A) PDF, Word, Excel and PowerPoint with OCR |  |
| H14 | A) Local open-source with Arabic support |  |
| H15 | A) Per-source policy; daily by default for statistics |  |
| H16 | A) Immutable dated snapshots with hashes |  |
| H17 | A) Follow each source's licence |  |
| H18 | A) Validation and quarantine with analyst disposition |  |

## I. Sector packs and use cases

| ID | Decision | Flag |
|---|---|---|
| I1 | C) Five scenarios | CONFLICT-2 |
| I2 | A) September 2026 (Brent above $100, Reuters) |  |
| I3 | A) The client nominates three to five |  |
| I4 | A) A national resilience cascade |  |
| I5 | A) A reference sovereign portfolio with mandate constraints |  |
| I6 | A) Exposure and liquidity scenarios, no core banking |  |
| I7 | A) Later, after actuarial controls |  |
| I8 | A) Second wave, reusing the existing design |  |
| I9 | A) One shared template configured per sector |  |
| I10 | A) Only metrics backed by connected sources |  |
| I11 | D) Eight or more | CONFLICT-2 |
| I12 | A) Contract one or two part-time sector analysts |  |
| I13 | A) Co-built configuration workshops |  |
| I14 | C) Both |  |

## J. Intelligence engines

| ID | Decision | Flag |
|---|---|---|
| J1 | A) Allowlisted sources with scoring |  |
| J2 | A) Rules, anomaly detection and news analysis |  |
| J3 | A) Three orders with loop protection |  |
| J4 | A) Observed, sourced, inferred, assumed, synthetic |  |
| J5 | A) Simulation plus a causal graph |  |
| J6 | A) 72 hours, 90 days, 1 year, 5 years fixed |  |
| J7 | A) A band plus its basis components |  |
| J8 | A) Define it with the client first (a blocker) | OPEN |
| J9 | A) A deviation score from mandate, computed from the decision log |  |
| J10 | A) Baseline versus outcome tracking after approved actions |  |
| J11 | A) Define each with the client and compute transparently |  |
| J12 | A) Versioned, executable constraints |  |
| J13 | A) Cited answers from graph and documents plus shortcut prompts |  |
| J14 | A) Approved decisions, outcomes and evidence snapshots |  |

## K. Governance, security and compliance

| ID | Decision | Flag |
|---|---|---|
| K1 | A) OIDC or SAML to the institution's provider; local accounts in development only |  |
| K2 | A) Enforced at the identity provider |  |
| K3 | A) Seven: Executive, Analyst, Expert, Approver, Operations, Administrator, Auditor |  |
| K4 | A) Roles plus attributes (division, classification, case) |  |
| K5 | A) Enforced by policy for restricted actions |  |
| K6 | A) Append-only and hash-chained |  |
| K7 | C) Ten years |  |
| K8 | A) Redacted, labelled, permissioned and logged |  |
| K9 | A) SOC 2 Type II and ISO 27001 roadmap, penetration test first |  |
| K10 | A) Only what is actually held |  |
| K11 | A) Independent test before any client data |  |
| K12 | A) Four: public, internal, confidential, restricted |  |
| K13 | A) Excluded except staff identities |  |
| K14 | A) Saudi: NCA, NDMO, SAMA, SDAIA, PDPL |  |

## L. Design and user interface

| ID | Decision | Flag |
|---|---|---|
| L1 | A) Ivory, emerald and gold (light) |  |
| L2 | A) Yes, a navy dark theme |  |
| L3 | A) Serif headings with a sans interface |  |
| L4 | A) Work objects: Command Centre, Cases, Signals, Scenarios, Decisions, Memory, Data, Governance, Admin |  |
| L5 | A) A context switch in the header |  |
| L6 | D) Per institution |  |
| L7 | A) Per-institution logo, tagline and palette tokens |  |
| L8 | A) Full mirroring of layout, charts and maps |  |
| L9 | A) ECharts |  |
| L10 | A) WCAG 2.2 AA |  |
| L11 | A) 'Connect authorised data' with guidance |  |
| L12 | B) Rich ambient motion | CONFLICT-8 |
| L13 | A) Executive summary first, drill down for detail |  |
| L14 | A) Request the approved brand files |  |

## M. Map and movement

| ID | Decision | Flag |
|---|---|---|
| M1 | A) MapLibre GL with packaged tiles |  |
| M2 | A) Pre-packaged vector tiles for the GCC extent |  |
| M3 | D) Global | CONFLICT-6 |
| M4 | D) TankerMap | CONFLICT-7 |
| M5 | B) Simulated | NOTE |
| M6 | A) LIVE, REPLAY, INFERRED, SCENARIO labels |  |
| M7 | A) Official public reference data plus client assets |  |
| M8 | A) Ten thousand with clustering |  |

## N. Team and delivery

| ID | Decision | Flag |
|---|---|---|
| N1 | D) Twenty or more | CONFLICT-3 |
| N2 | C) A larger team | CONFLICT-3 |
| N3 | A) Primary build tool with human review |  |
| N4 | A) A private GitHub organisation |  |
| N5 | A) Trunk-based with pull-request review |  |
| N6 | A) Lint, types, unit, integration, tenant isolation, dependency scan |  |
| N7 | A) Development, staging, release candidate, per-client |  |
| N8 | A) Unit, integration, replay, security and accessibility |  |
| N9 | A) Decision records plus runbooks |  |
| N10 | A) A board with requirement IDs |  |
| N11 | A) Weekly working session |  |
| N12 | D) Unknown provenance: ask first | OPEN |

## O. Commercial, IP and legal

| ID | Decision | Flag |
|---|---|---|
| O1 | C) Not needed | CONFLICT-9 |
| O2 | A) Client owns engine and orchestration; Infoetec keeps pre-existing tools under licence |  |
| O3 | A) Phased fixed scope with milestone payments |  |
| O4 | A) Deployment licence plus annual platform fee |  |
| O5 | A) Yes, a priced workshop and report |  |
| O6 | A) Legal review before any public claim |  |
| O7 | A) Review claims before the architecture freeze |  |
| O8 | A) Only with written approval |  |
| O9 | A) Required before any client data |  |
| O10 | A) Permissive licences only, with a software bill of materials |  |

## P. Timeline, budget and gates

| ID | Decision | Flag |
|---|---|---|
| P1 | A) About 16 weeks after prerequisites | CONFLICT-3 |
| P2 | A) A meeting with a sovereign fund within weeks | CONFLICT-10 |
| P3 | A) Phase-gated budgets |  |
| P4 | B) $250K to $750K | CONFLICT-3 |
| P5 | B) $5M to $15M |  |
| P6 | A) Five gated phases |  |
| P7 | A) A named product owner this week |  |
| P8 | A) Traceability, scenario reproducibility, back-test precision and recall |  |
| P9 | A) Correctness first |  |
| P10 | A) Written change requests for new sectors and feeds |  |

## Q. Public website and materials

| ID | Decision | Flag |
|---|---|---|
| Q1 | A) Yes, immediately |  |
| Q2 | A) Yes, before launch |  |
| Q3 | A) Revise to governed autonomy |  |
| Q4 | A) Fix now |  |
| Q5 | A) Reuse the approved ivory film assets |  |
| Q6 | A) An application subdomain of the client domain |  |

## Answers that differ from the recommended option

A6, A8, B3, C2, D6, D7, F12, G6, I1, I11, K7, L6, L12, M3, M4, M5, N1, N2, O1
---

## Conflict resolutions (accepted 10 Nov 2026: "all A")

| # | Resolution |
|---|---|
| 1 | One platform; sector packs are named and priced as separate products on top of it (B3 restated). |
| 2 | First release (about 16 weeks) = platform core + two packs (Energy and Oil, Sovereign Capital and Treasury), three scenario templates each. Remaining packs follow in gated phases. |
| 3 | Start with 10-12 people; scale to 20+ after the first gate. |
| 4 | No in-house execution stack. Execution happens through adapters into the institution's own systems. Any later execution module needs separate regulatory review. |
| 5 | Network default is deny-all with a per-connector allowlist. Vendor hosts only in non-sovereign installs. |
| 6 | Map defaults to Gulf/GCC extent with an optional global tile pack. |
| 7 | No TankerMap data until written commercial and offline terms exist. Use licensed or historical snapshots meanwhile. |
| 8 | Rich motion on map, propagation and briefing views only. Decorative motion off by default. Reduced-motion always honoured. |
| 9 | NDA signed before any further client material is shared or stored in the project. |
| 10 | The fund meeting uses Tiger's existing film and site plus our architecture pack. No unfinished product is shown. |
