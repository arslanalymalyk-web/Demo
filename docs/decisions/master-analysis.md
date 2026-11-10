# TIGERIS - Master analysis (10 Nov 2026)

Status: analysis only. Nothing has been built. Source corpus: 13 uploaded documents (PDF, DOCX, MD), 5 transcripts/MOMs, 12 UI images, 7 websites (6 read, 1 blocked), 93 extracted text files in `raw_text/`.

---

## 0. Working rule agreed for the product (your instruction)

1. We are building a **working product**, not a presentation. No screen, label, file name, route, e-mail, README, commit message, test name or marketing line will contain the words "demo", "demonstration", "prototype", "mock", "MVP" or "POC".
2. Honest data labelling stays, because it is part of the product's own trust model (every number traces to a source). Neutral vocabulary replaces the banned words:

| Instead of | Use |
|---|---|
| Demonstration Mode | **Reference institution** / **Configured environment** |
| Synthetic / Illustrative data | **Sample dataset** (institution-specific) and **Public record** (real public data) |
| Illustrative scenario | **Scenario simulation** |
| Not connected to live data | **Source not connected** / **Snapshot as of <date>** |
| Simulated authorization | **Authorization recorded in this environment** |

3. Hard line: no simulated number is ever presented as a live feed or as a client's real data. Source class and "as of" time stay visible on every figure. (Open question Q-series in the questionnaire asks you to confirm the vocabulary.)

---

## 1. Chronology of the engagement

| Date | Event | Source |
|---|---|---|
| 29 Sep 2026 | First call: Infoetec suggests Tiger owns the orchestration layer | MOM sync-up |
| 30 Sep 2026 | Discovery call (~30 min): non-SaaS, foresight engine, dummy-data first, USD 20,000 used only as an illustration | MOM sync-up |
| 12 Oct 2026 | Prototype review (minuted 23 Oct): rename to "Sofran/Sovereign Intelligence OS", map and graphics upgrades, air-gap, model-agnostic | MOM_1 |
| (undated) | Planning meeting (1 h 45): architecture before screens, 2-3 validated use cases, NDA first, PIF governance meeting expected | MOM Planning |
| 23 Oct 2026 | Decision pack: Foundation decisions, MVP blueprint, PRD, TRD, UX brief, map spec, GCC sectors and data sources | Uploaded docs |
| (undated) | Implementation plan (12-week baseline), App Flow, backend schema | Uploaded docs |
| 9 Nov 2026 | Recording (30 min, truncated): gap analysis as the sales entry point, outcome-based licence, budget "allocation" request | Video transcript |
| 10 Nov 2026 | Public-site and data-source analysis (this document) | - |

Likely duplicates: MOM_1 and MOM Planning appear to be the same meeting transcribed twice (names garbled: Mubasher/Ehtisham, Alec/Ali, Sofran/Sovereign).

---

## 2. Documents digest

| Document | What it contributes | Weakness |
|---|---|---|
| MOM sync-up (30 Sep) | 14 client requirements (R1-R14), client vocabulary, PM six-layer architecture, 5-phase plan | Phase durations are Infoetec estimates; budget/IP/commercial open |
| MOM_1 / Planning | Roles, command centre, sign-in, map feedback, air-gap, model-agnostic, signal flow, investor readiness, data isolation | Transcripts truncated |
| Video 9 Nov | Gap/diagnosis as entry product, outcome model, commercial partner expectation, Atlas/Brain reference | Poor transcription, speakers unlabelled |
| Foundation decisions | Name, category, journeys, nav (10 items), badges (OBSERVED/INFERRED/ASSUMPTION/SYNTHETIC/ILLUSTRATIVE), guardrails | All "recommended", none client-approved |
| MVP blueprint | 7-layer architecture, 5 must-prove capabilities, 8-week cut list | 8 weeks is a bounded slice only |
| PRD | 45 FRs (32 MUST), 12 acceptance criteria, 7 personas | Excludes value-realization, structural alpha, decision-drift FRs |
| TRD | 15 components, canonical objects, 4 deployment profiles, air-gap package workflow, 48 TRs, threat table | Stack left open |
| UX brief + App Flow | 10-step flow, case lifecycle, PASS/HOLD/BLOCK, role journeys | App Flow duplicates UX brief |
| Live Movement Map spec | 5 data modes (LIVE/REPLAY/INFERRED/SCENARIO/SYNTHETIC), motion rules, 4-step map roadmap | No data source with cleared rights |
| Implementation plan | 12-week baseline, +4 weeks hardening, Claude Code operating model, CI gates | No team size or budget; no path beyond W16 |
| Backend schema | 36-table PostgreSQL design with RLS and composite FKs | SQL file not supplied; no tables for documents, geo, back-test, packages, holdings |
| GCC target industries | 8 prioritised + 9 expansion sectors, wave sequence | Sector lists differ across documents |
| GCC data sources (x2, identical text) | 36 public sources, 7 non-public classes, provenance contract, air-gap package pattern | Verified in this analysis: see `02_*` |
| UI screens (12 images) | 8 ivory sector command centres + sign-in; navy working-app Institutional Memory (EN/AR); capability graphic | Mixed visual systems |

---

## 3. Website digest

### 3.1 tigerisos.ai (Tiger's own site)
- Stack: React/Vite SPA, appears Lovable-built, Supabase backend; ~60 routes; gated areas (admin, portal, vault, data room, cap table, countersign, allocation) **not accessed**.
- Public experiences: 4:02 product film (11 steps), 43-second ivory film, 8-room interactive briefing, `/os` command centre (9 nav groups, 13 scenarios), investor pages, white-paper series (6 layers), events, team, global presence.
- **Product loop in the film:** identity -> verified event (Hormuz, Reuters Sep 2026) -> Sovereign Gap Analysis (12 gaps: source confidence, data coverage, model certainty, mandate constraints) -> intelligence graph propagation -> **nine agents** (geopolitical, risk transmission, macroeconomics, portfolio, infrastructure, strategic opportunity, governance, mandate alignment, institutional memory) -> 72h/90d/1y/5y -> mandate runtime ("Intelligence proposes. Sovereign authority decides.") -> structural alpha and value realization -> institutional memory.
- White-paper staged adoption: Stage 1 unified record and read-only intelligence; Stage 2 advisory allocation; Stage 3 thresholded autonomous execution inside a declared, versioned envelope.

### 3.2 tigercapital.ai
- Corporate site (TanStack-style SSR): 7 routes. Positions Tiger Capital AI as architect of the "Sovereign Intelligence Operating System"; capital intelligence is the "first commercial layer".
- `/environment`: 12-step loop (Detect, Understand, Anticipate, Simulate, Reason, Decide, Govern, Coordinate, Act, Measure, Learn, Compound); indices CSAI, cognitive debt, coordination debt, time to governed action; mandate toggles (Balanced, Resilience, Liquidity, Localization); 35-node first/second/third-order graph; scenario probabilities; **17 canned "Ask TIGERIS" prompts** (e.g. "Who has authority?", "Show conflicting agent views", "Show me the 72-hour plan").
- Claims 58 active agents, 25+ agent classes, 14 domains, 40+ live domains (marketing figures).

### 3.3 Reference sites
- **Brain Co.** - Atlas platform (security, model replacement, deploy on their cloud / yours / your data centre / fully isolated, no cross-client training, SOC 2 Type II and HIPAA) beneath vertical OS products (Gov, Health, Insurance, Finance, Enterprise). Engagement: start with one application, fit it, add more; "3 days to prototype, 3 weeks live on your data, 3 months to production"; human in the lead.
- **Gaia (gaia.sa)** - Saudi sovereign work-AI: RAG with citations and refusal without evidence, permission inheritance, Arabic-first RTL, human approval gates, audit log, on-prem/air-gapped/in-Kingdom, compliance framing (NCA, NDMO, SAMA, SDAIA, PDPL), 15+ integrations.
- **DataSaudi** - Next.js front end over a Tesseract OLAP API: 280 cubes, mostly GASTAT and SAMA series, 13 regions, 13 bilateral partners, 13 ISIC sectors, economic calendar, data explorer. Latest observations in the site: Q2 2026 GDP, Aug 2026 trade and industrial production, Sep 2026 CPI.
- **TankerMap** - free AIS tanker map; Hormuz Watch; chokepoint analytics; sanctioned-vessel layer; no documented API; rights unclear.
- **Bloomberg Middle East** - HTTP 403 (bot protection). Not worked around. Needs specific pages or PDFs from you.
- **Brain trust centre** - hosted by a third party; returned no content.

---

## 4. Data-source landscape (details in `02_*` and `03_*`)

- 36 registered public sources: 4 confirmed programmatic APIs (Bahrain, Qatar, GCC-Stat, DataSaudi), 8 bulk-file sources, 5 keyed APIs, 4 web-only, 1 third-party feed, 14 inaccessible from this environment (bot protection, TLS chain errors, resets, one dead host, one stale URL).
- About 2,900 datasets/cubes are catalogued and machine-readable today.
- Non-public classes (client authorisation required): capital allocation, sovereign and banking risk, energy and industrial operations, trade and supply-chain records, private market and company intelligence, commercial signals (AIS, satellite, live prices, ratings), sensitive/personal records.
- Provenance contract (6 fields): origin, time and scope, rights and version, transformation, confidence, data class.

---

## 5. Client vocabulary glossary (to be defined with the client)

Sovereign intelligence paradox - coordination debt - decision drift - institutional memory - structural alpha - mandate intelligence - sovereign intelligence absorption capacity - enduring sovereign capability - value realization - foresight engine - architecture-market fit - governance as code - Sovereign Gap Analysis - sovereign operating picture - mandate runtime - strategic envelope - Governor's Vault - national node - intelligence sovereignty - overlay intelligence - CSAI (Compound Sovereign Advantage Index) - cognitive debt - time to governed action - systems of record / engagement / action / intelligence.

Terms with **no agreed definition** in any document: structural alpha, mandate intelligence, absorption capacity, CSAI, cognitive debt, coordination debt (as a number), decision drift (as a measure).

---

## 6. Contradiction register

| # | Topic | Position A | Position B | Source |
|---|---|---|---|---|
| 1 | Autonomy | Autonomous trade execution, settlement | No action without named human authority | Investor pages vs film, TRD |
| 2 | Resolution | Staged autonomy earned by audit evidence | - | White paper layer 06 |
| 3 | Portfolio scope | "Not a portfolio management engine" | Layer with order management and trade execution | 30 Sep call vs /briefing |
| 4 | Architecture | 8+ public variants (5 modules x2, 5 layers, L1-L5, 6 layers, 6 stages, 8 rooms, 11/12-step loops) | TRD 7 layers / 15 components | Websites vs docs |
| 5 | Name | Sovereign Capital Intelligence OS | AI-Native Sovereign Intelligence OS | Site vs meetings |
| 6 | Arabic spelling | تيجريس | تايغريس | Working-app screens |
| 7 | Visual system | Ivory/emerald/gold/serif | Navy/gold | Foundation vs PRD, UX |
| 8 | Hormuz event | Sep 2026, Brent > $100 (film) | 12 Jun 2026, Brent $87 (sandbox) | tigerisos vs tigercapital |
| 9 | Gap analysis | Event-level evidence/coverage check | Institution-level diagnosis | Film vs 9 Nov call |
| 10 | Infrastructure | Multi-cloud, Snowflake, Kafka | Air-gap, on-prem, in-Kingdom | /brief vs minutes |
| 11 | Certification | SOC 2 / ISO 27001 stated as held | "Targeted" | /brief appendices |
| 12 | Models | 12 AI models / 7 LLMs | Model-agnostic, unspecified | /os, /brief |
| 13 | Agents | 9 / 25+ classes / 58 | Typed agents per TRD | Film, tigercapital, TRD |
| 14 | Scale claims | <50 ms, 11 ms, <0.3 s; 12,887/s to 50M/day | Unmeasured | Investor pages |
| 15 | Engine cost | $80-110M "validated" | USD 20,000 illustration | /brief vs 30 Sep call |
| 16 | Timeline | 8 weeks | 12 + 4 weeks | Blueprint/PRD vs Plan |
| 17 | Sectors | 8 packs incl. Insurance | 7 in PRD list, 9 expansion sectors | Foundation, GCC doc, PRD |
| 18 | Navigation | 10 items (Foundation) | 9 groups (/os) | Docs vs site |
| 19 | Roles | 4-5 (minutes) | 7 personas (PRD) | MOM vs PRD |
| 20 | Horizons | 72h/90d/1y/5y (docs, film) | "next five months", five years | Client wording |
| 21 | Self-learning | Required by client | No fine-tuning or online learning in MVP | MOM vs TRD |
| 22 | Deployment | Per-institution deployment | RLS multi-institution schema | TRD vs schema |
| 23 | Live data | Live ships, Bloomberg, Aladdin | Public snapshots, no live licensed feed | Client ask vs docs |
| 24 | Geography | Saudi-specific copy and skyline | Reusable OS for any country | Screens vs client |
| 25 | Staleness | Round "closes Q3 2026" countdown at zero | Today is Nov 2026 | /brief |

---

## 6b. Exposure notes for the client (read-only findings, not tested)

- Pages marked confidential/under NDA (one-pager v2, Dragon Capital brief, investor brief) load without login.
- One gated page displays a hint at its access-code pattern.
- The Supabase project URL is visible in the public bundle (normal for client apps; row policies must be reviewed).
- A placeholder-looking phone number and a raw translation key (`investors.engine.module5Name`) appear on public pages.
- Public claims (named backers, a committed family office, named funds) need legal review.

---

## 7. Proposed reconciliations (for your decision, not yet applied)

1. **Staged autonomy:** Stage 1 read-only unified record; Stage 2 advisory with human authorization; Stage 3 thresholded in-envelope execution, disabled by default and enabled per institution by policy. This follows Tiger's own white paper.
2. **Positioning:** one product, "TIGERIS AI OS", with capital intelligence as the first domain pack.
3. **Visual:** ivory/emerald/gold as the primary theme (Tiger's newest film and the `/os` app already use it); navy kept as an optional dark theme.
4. **Platform shape (Brain Co. pattern):** a shared platform layer plus sector packs that are configurations, not separate dashboards.
5. **Data:** build on real public sources first (DataSaudi, Bahrain/Qatar open data, GCC-Stat, JODI, IMF, sanctions lists); institution-specific exposures come from a clearly labelled sample dataset until client data is connected.
6. **Evidence:** keep the TRD provenance and lineage contract as the non-negotiable core.

---

## 8. Realistic timeline (preliminary)

| Layer | Duration |
|---|---|
| Prerequisites (NDA, IP, blueprint, source rights) | 3-6 weeks before the clock starts |
| Hardened working slice on real public data, single institution | ~16 weeks with 8-10 people |
| Pilot-ready sovereign OS (core + 3 priority packs: Energy, Sovereign Capital, Banking) | 14-18 months |
| Remaining packs (Manufacturing, Supply Chain, Real Estate/Construction, Infrastructure, Insurance) | months 18-24 |
| Full production with certifications | 24+ months |

Assumptions: team of 12-16 at peak, client data access and connector licences arrive on time, existing prototype code is reviewed before it is reused.

---

## 9. Still missing

USPTO architecture blueprint - overview document shared in chat on 30 Sep - SQL schema file - WhatsApp graphics samples - Manufacturing Command Centre source files - Energy/Banking case screens - answers on provenance of the working navy app - specific Bloomberg pages - GASTAT current host - cleared AIS source.
