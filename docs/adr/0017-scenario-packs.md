# ADR 0017: Scenario packs and templates

Status: accepted. Implements decision 2 (first release: the core plus two packs, three scenario templates each).

**Energy and Oil:** hormuz-transit-restriction, oil-price-shock, production-curtailment.
**Sovereign Capital and Treasury:** reserve-runway, export-revenue-gdp, reserve-asset-stress.

- A template declares its pack, the baseline sections it needs (Gulf volumes and prices, reserve composition, GDP), its formula version, the measure that sets the confidence range, and which measures cannot be negative. The engine, sensitivity, bands, confidence, replay and audit are shared and unchanged.
- Every number is deterministic arithmetic over stored evidence and stated parameters. Each parameter is labelled assumed, sourced or calibrated. The institution's own figures (for example the financing gap under review) are inputs and are labelled assumed, never presented as data.
- Sections a template does not use are left out of its baseline. Energy baselines keep exactly the shape older runs have, so earlier runs still replay. A run records the formula version it used. A change to band or confidence rules needs a new formula version.
- Reserve composition is the published SAMA series, read from one quarter, and refused if the classes do not add up to the total. GDP is the four most recent quarters summed. The GDP source does not state a unit; it is read as million riyals, a stated assumption that appears in the run's confidence notes.
- Scope limits: the sovereign templates describe Saudi public data only. They are not a model of any institution's own portfolio, which would be a labelled sample dataset until client data is connected.
