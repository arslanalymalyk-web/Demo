# Source verification - GCC public data register

Verified on 10 Nov 2026 from a restricted cloud environment. A failure here is **not** proof that a site is down: several block automated clients (bot protection), some servers present incomplete TLS chains, and the environment applies a network allowlist. TLS verification was never disabled.

## Result summary

| Category | Sources |
|---|---|
| A. Programmatic API confirmed | 4 |
| B. Bulk files / spreadsheets / PDFs | 8 |
| E. API available (registration key or token) | 5 |
| C. Web pages only (no API found) | 4 |
| F. Third-party feed, rights unclear | 1 |
| D. Could not access from this environment | 14 |

Register: 36 source links across 35 hosts (6 countries + GCC-Stat + energy, maritime, macro, sanctions and hazard feeds).

## Largest confirmed catalogues

| Portal | Platform | Size | Licence signal |
|---|---|---|---|
| Qatar Open Data | Opendatasoft | 2,082 datasets | CC BY on 2,070 |
| Bahrain Open Data | Opendatasoft | 515 datasets | none declared |
| DataSaudi | Tesseract OLAP | 280 cubes (GASTAT 144, SAMA 58) | confirm Saudi Open Data Licence |
| GCC-Stat | CKAN | 37 datasets | confirm |

Machine-readable copies of the catalogues: `03_catalog_bahrain_open_data.csv`, `03_catalog_qatar_open_data.csv`, `03_catalog_datasaudi_cubes.csv`.

## Detail by category

### A. Programmatic API confirmed

| Area | Source | URL | What was found | Implication |
|---|---|---|---|---|
| Bahrain | Open Data Portal | https://www.data.gov.bh/ | Opendatasoft v2.1 (/api/explore/v2.1/catalog/datasets); 515 datasets, EN+AR labels; no licence metadata on any dataset; themes: Census 45, Marriage & Divorce 42, Geographic 36, Education 35, Births & Deaths 34, Transport 33, Labour 25, Foreign Trade 23 | Licence must be confirmed per dataset (none declared). robots.txt allows catalogue API. |
| Qatar | Qatar Open Data | https://www.data.gov.qa/ | Opendatasoft v2.1; 2,082 datasets; 2,070 tagged CC BY; themes: SDG 385, Labour 259, Finance & Economy 202, Energy & Environment 195, Culture/Sports/Tourism 165, Transport 157, Education 146, Trade & Industry 139 | Best-licensed GCC portal found. 12 datasets without licence. |
| Saudi Arabia | DataSaudi | https://datasaudi.sa/en | Public Tesseract OLAP API (api.datasaudi.sa/tesseract/cubes): 280 cubes, bilingual; 144 sourced from GASTAT, 58 from SAMA, plus MoH, Saudi Census, MT, KSrelief, Saudi Exchange; topics: economic 127, social 114, international 14, Hajj 10, Umrah 5 | Re-publisher of official data: always cite the original agency (source_link in each cube). Confirm Saudi Open Data Licence terms before bulk use. |
| Comparable GCC indicators | GCC-Stat Data Portal | https://dp.marsa.gccstat.org/ | CKAN (Drupal 7 front end): /api/3/action/package_list returns 37 datasets (national accounts, consumer prices, energy, monetary & financial, population, labour, tourism, health...); catalog.xml also exposed | Small catalogue (37). package_search endpoint not available. Portal runs Drupal 7 (end-of-life) - availability risk. |

### B. Bulk files / spreadsheets / PDFs

| Area | Source | URL | What was found | Implication |
|---|---|---|---|---|
| Bahrain | Central Bank publications | https://www.cbb.gov.bh/publications/ | WordPress site; monthly XLSX files (e.g. /wp-content/uploads/2026/11/Sep-2026-1.xlsx); /apis/ page exists; sitemap at /wp-sitemap.xml | Statistical series arrive as spreadsheets - needs a file-ingest adapter. Check /apis/ for an official API. |
| Oman | NCSI | https://ncsi.gov.om/ | Oman NCSI portal publishes PDFs via api.ncsi.gov.om/uploads/pdfs (monthly statistical bulletin Oct 2026, tourism indicators Sep 2026, SDG goals, AI society survey) | PDF-first publishing: needs document extraction/OCR pipeline. |
| Energy supply and flows | JODI Oil | https://www.jodidata.org/oil/database/data-downloads.aspx | Public bulk files: /_resources/files/downloads/oil-data/world_ext.zip and a country-availability XLSX; gas database also available | Strong baseline for production/stocks/exports by country. Monthly cadence; check JODI terms for redistribution. |
| Macro and commodities | IMF Data | https://data.imf.org/ | data.imf.org dataset pages (WEO, Fiscal Monitor, COFER, CPI, labour statistics, etc.) | New IMF data portal; confirm SDMX/API access and terms. |
| Macro and commodities | IMF Commodity Prices | https://www.imf.org/en/Research/commodity-prices | Monthly commodity price workbook: /-/media/files/research/commodityprices/monthly/external-data.xlsx | Simple XLSX ingest; good for oil-price scenario baselines. |
| Macro and commodities | World Bank Open Data | https://data.worldbank.org/ | data.worldbank.org plus datacatalog.worldbank.org and microdata; public APIs live on separate hosts (api.worldbank.org not in this environment allowlist) | Well-documented public APIs; needs allowed host in deployment network. |
| News and official events | OFAC SLS | https://ofac.treasury.gov/sanctions-list-service | Sanctions List Service (Drupal 10) with downloadable list datasets and a "customize dataset" tool | Authoritative US list; legal-determination caveat applies. |
| News and official events | UK Sanctions List | https://www.gov.uk/government/publications/the-uk-sanctions-list | Direct CSV: sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv; Open Government Licence v3 | Cleanest licence of all sources checked. |

### E. API available (registration key or token)

| Area | Source | URL | What was found | Implication |
|---|---|---|---|---|
| Energy supply and flows | EIA International | https://www.eia.gov/international/ | EIA Open Data API v2 (/opendata, /beta/api) - registration key required | Free key; includes international petroleum series and chokepoint analysis pages. |
| Energy supply and flows | EIA Chokepoints | https://www.eia.gov/international/analysis/special-topics/world_oil_transit_Chokepoints | Same host as EIA International; special-topic analysis page for world oil transit chokepoints | Analytical text and tables, not raw AIS. |
| Maritime / Hormuz | UNCTAD transport data | https://data360.worldbank.org/en/dataset/UNCTAD_MT | World Bank Data360 (data360api.worldbank.org) hosts UNCTAD maritime dataset; /en/api documentation page exists | Check Data360 API terms; dataset UNCTAD_MT. |
| Weather and hazards | NOAA Climate Data Online | https://www.ncei.noaa.gov/cdo-web/ | CDO datasets listing; API requires a token | Optional hazard context; GCC coverage to verify. |
| Weather and hazards | NASA FIRMS | https://firms.modaps.eosdis.nasa.gov/ | FIRMS download page; API requires a map key | Optional hazard/thermal context. |

### C. Web pages only (no API found)

| Area | Source | URL | What was found | Implication |
|---|---|---|---|---|
| Kuwait | Central Statistical Bureau | https://www.csb.gov.kw/Default_EN | Kuwait CSB home loads; no catalogue API discovered | Check statistical-publication pages for XLS/PDF downloads. |
| Oman | NCSI Data Portal | https://data.gov.om/ | Oman NCSI Data Portal home loads (HTML); no CKAN/Opendatasoft/DKAN endpoint responds | Needs scraping or manual download unless a private API is documented. |
| United Arab Emirates | Bayanat | https://bayanat.ae/ | Custom Opendata platform (title "The Opendata Portal"); CKAN/Opendatasoft/DKAN probes return the HTML 404 page | Needs its own adapter or manual export; check platform documentation. |
| United Arab Emirates | Capital Market Authority data | https://www.uaecma.gov.ae/en/open-data.aspx | UAE CMA open-data page loads (HTML); robots.txt disallows /cp/ only | Look for downloadable datasets on the page. |

### F. Third-party feed, rights unclear

| Area | Source | URL | What was found | Implication |
|---|---|---|---|---|
| Maritime / Hormuz | TankerMap | https://tankermap.com/ | SPA tanker map; claims 4,100+ active tankers, 3,200+ crude tankers, 50+ LNG terminals, 6 languages; features: fleets, cargo state, tracks (live/24h/7d/30d), Hormuz Watch, chokepoint analytics, sanctioned-vessel highlight; no documented public API found | Free service; commercial/storage/air-gap rights not stated. Treat as UI reference and conditional data source only. |

### D. Could not access from this environment

| Area | Source | URL | What was found | Implication |
|---|---|---|---|---|
| Bahrain | iGA | https://www.iga.gov.bh/ | HTTP 403 (bot protection) | Not accessible to automated clients from this environment. |
| Kuwait | Government Open Data | https://e.gov.kw/sites/kgoEnglish/Pages/OtherTopics/OpenData.aspx | HTTP 403 (bot protection) | Not accessible to automated clients from this environment; manual or sanctioned access needed. |
| Kuwait | Central Bank statistics | https://www.cbk.gov.kw/en/statistics-and-publication | Kuwait CBK URL returns 404 ("Page Not Found") for the register link; Oman CBO connection failed with an incomplete TLS certificate chain | Register URL is stale (Kuwait) or server misconfigured (Oman). Do not disable certificate checks; install the issuing CA via a reviewed bundle if rights allow. |
| Oman | National Open Data Portal | https://opendata.gov.om/en | Redirect loop (HTTP 307, max redirects exceeded) on opendata.gov.om/en | Retest with a browser-class client; may be geo or bot related. |
| Oman | Central Bank statistics | https://cbo.gov.om/Pages/PublicationStatistics.aspx | Kuwait CBK URL returns 404 ("Page Not Found") for the register link; Oman CBO connection failed with an incomplete TLS certificate chain | Register URL is stale (Kuwait) or server misconfigured (Oman). Do not disable certificate checks; install the issuing CA via a reviewed bundle if rights allow. |
| Qatar | National Planning Council | https://www.npc.qa/en/statistics/ | Incomplete TLS certificate chain (server-side misconfiguration) | Retest later or request correct chain; do not bypass verification. |
| Qatar | Qatar Central Bank | https://www.qcb.gov.qa/ | Incomplete TLS certificate chain (server-side misconfiguration) | As above. |
| Saudi Arabia | National Open Data | https://data.gov.sa/ | Saudi data.gov.sa: connection reset by peer | Possibly geo/IP restricted or bot-blocked; retest from an in-Kingdom or approved network. |
| Saudi Arabia | GASTAT | https://www.stats.gov.sa/ | www.stats.gov.sa does not resolve from this environment (register URL redirects to http://www.stats.gov.sa/en/) | DataSaudi cites both www.stats.gov.sa and database.stats.gov.sa as its sources - verify the current GASTAT host. |
| Saudi Arabia | SAMA statistics | https://www.sama.gov.sa/en-US/Statistics/pages/summary.aspx | Empty reply from server | Retest; DataSaudi already republishes 58 SAMA series. |
| United Arab Emirates | FCSC | https://fcsc.gov.ae/ | HTTP 403 - Cloudflare "Attention Required" | Bot challenge. Requires an authorised route (agreement or manual download). |
| United Arab Emirates | CBUAE statistics | https://centralbank.ae/en/research-and-statistics/ | HTTP 403 - Cloudflare challenge page | Bot challenge. Requires an authorised route. |
| News and official events | GDELT Data | https://www.gdeltproject.org/data.html | Blocked by network policy: apex redirect to gdeltproject.org not allowed in this environment | Re-verify after allowing the apex host. |
| News and official events | UN Security Council List | https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list | HTTP 202 (accepted, no body) | Page assembles via JavaScript or async job; retest with a browser client. |

## Observations that change the plan

1. **Real public data is richer than assumed.** About 2,900 catalogued datasets/cubes are reachable by API today (Qatar, Bahrain, DataSaudi, GCC-Stat), so most 'sample' content can be real, dated public data rather than invented numbers.
2. **Three connector styles cover most sources:** Opendatasoft v2.1, CKAN, and Tesseract; plus a spreadsheet/CSV/ZIP file adapter and a PDF extraction pipeline (Oman NCSI).
3. **UAE and Kuwait official portals are bot-protected** (Cloudflare or 403) - they need an authorised route; do not plan on scraping.
4. **Three official hosts have broken certificate chains** (Oman CBO, Qatar NPC, Qatar QCB). A production connector must handle this through a reviewed trust configuration, never by turning verification off.
5. **DataSaudi is an aggregator** over GASTAT and SAMA; provenance must record the original agency, not just the portal (this matches the TRD provenance rule).
6. **No source found offers live vessel positions under clear rights.** TankerMap is free but its commercial, storage and air-gap rights are unstated; the data register's own caution stands.
7. **Sanctions lists are the cleanest licensed data:** UK CSV under Open Government Licence v3; OFAC downloads; UN list needs a browser-class fetch.
