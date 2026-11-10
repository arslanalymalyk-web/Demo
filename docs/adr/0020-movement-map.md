# ADR 0020: The map

Status: accepted. Implements resolutions R5 to R7 (round 3) and decisions 5, 6 and 7.

- The map draws public-record geography only. No vessel positions appear, and the screen says that no live vessel feed is connected. A vessel layer needs written terms first (decision 7).
- Base geography is Natural Earth (public domain), built once into 79 KB of pre-projected path data by `scripts/build-geo.mjs` and shipped with the app. It works without a network and needs no tile host (decision 5). The extent is the Gulf and the connecting seas (decision 6).
- Map features are graph entities and links, so they carry the same link classes, rationales and evidence as everything else. Facility positions are labelled approximate and sea lanes and pipeline paths are labelled schematic.
- Pipeline capacities and the Hormuz flow figure come from one cited source (EIA, 21 November 2023). `pnpm geography seed` fetches the article respecting robots.txt, stores it through document intake as a public-record evidence document, and then writes the links citing that record. If the record is not stored, the same facts are written as assumed and the flow figure is left out.
- Producer bubbles are the stored JODI export series. A country whose newest data is old is drawn hollow and labelled, never shown as current.
- Scenario propagation draws a stored Hormuz run, with its stored per-country revenue change, from the Strait to each producer. It is labelled Scenario simulation. Every layer has a table alternative, the map is keyboard operable, and motion follows the reduced-motion settings.
