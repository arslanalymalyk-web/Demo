# Resolutions, round 3 (build review)

Answers given by the product owner after the sector command centres were built. They apply from here on.

| # | Question | Answer |
|---|---|---|
| R1 | What to build next | The live movement map |
| R2 | Who owns signal thresholds, policy rules and scenario default assumptions | Tiger Capital AI defines them. They become governed, versioned settings. |
| R3 | Settings management | A governed settings module: drafted by one administrator, approved by another, versioned, audited. Old runs keep the values they used. |
| R4 | Settings in scope | Signal rule thresholds, scenario defaults and ranges, Hormuz exposure and bypass capacity, and a link to policy rules and authority |
| R5 | Vessel and movement data | Public-record geography only. No live vessel positions until written terms exist (decision 7). |
| R6 | Base geography | Bundled Gulf vector data, served from the deployment, working air-gapped (decisions 5 and 6) |
| R7 | First map layers | Chokepoints and sea routes; export terminals, ports and pipelines; stored series on the map; scenario propagation |
| R8 | NDA and data processing agreement | Both signed. Client data is planned but stays off until the client's own security review (decision 11). |
| R9 | Repository | A new private GitHub repository under the personal account. The product owner creates it empty; the work is pushed to it. |

Notes
- Facility positions on the map are approximate and labelled so. Capacities and routes carry a public source or are labelled assumed.
- The GitHub connector was unavailable in the build session, so commits are prepared locally and pushed when the repository exists.
