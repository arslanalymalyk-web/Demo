# ADR 0014: Interface shell

Status: accepted. Implements the ivory design direction in the master analysis (ivory, emerald and gold, with a serif display face; navy kept as an optional theme).

- React and Vite single-page app in `apps/web`. The API is reached under `/api` through a proxy, so the browser sees one origin.
- Sign-in is the authorization code flow with PKCE against the institution's provider, using its published metadata. The access token is held in memory only. Nothing is stored in the browser except display preferences.
- Navigation and views are permission-aware, and the API remains the authority. A view the role cannot use is not offered, and a direct link shows a plain refusal.
- Every figure can be opened to its six provenance fields. Charts are always paired with an exact-value table and a text description.
- Status, link class and data class are always words, not colour alone. Scenario pages carry a persistent "Scenario simulation" label.
- Motion is limited to the graph's edge flow and the page transition, and is off with the operating-system setting or the in-app switch.
- Layout uses logical properties, so the right-to-left toggle mirrors the whole shell. Arabic text is not shipped: terminology needs client review before any claim of localization.
