import { tx } from "./i18n";
export interface Route { view: "home" | "sources" | "evidence" | "series" | "graph" | "scenarios" | "run" | "audit" | "admin" | "cases" | "case" | "handoffs" | "memory" | "policy" | "documents" | "document" | "sector" | "settings" | "map" | "retention" | "briefing" | "assistant" | "sourcehealth" | "readiness" | "alerts" | "missing"; id: string | null }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  if (!a) return { view: "home", id: null };
  if (a === "scenarios" && b === "runs" && c) return { view: "run", id: c };
  if (a === "scenarios" && !b) return { view: "scenarios", id: null };
  if (a === "sector" && (b === "energy" || b === "sovereign") && !c) return { view: "sector", id: b };
  if (a === "briefing" && (b === "energy" || b === "sovereign") && !c) return { view: "briefing", id: b };
  if (a === "documents") return b ? { view: "document", id: b } : { view: "documents", id: null };
  if (a === "cases") return b ? { view: "case", id: b } : { view: "cases", id: null };
  if (["sources", "graph", "audit", "admin", "handoffs", "memory", "policy", "settings", "map", "retention", "assistant", "source-health", "readiness", "alerts"].includes(a) && !b) return { view: (a === "source-health" ? "sourcehealth" : a) as Route["view"], id: null };
  if ((a === "evidence" || a === "series") && parts.length <= 2) return { view: a, id: b ?? null };
  return { view: "missing", id: null };
}

export interface NavItem { href: string; label: string; view: Route["view"][]; need: string | null; id?: string }
export const NAV: NavItem[] = [
  { href: "#/", label: tx("Command Centre"), view: ["home"], need: null },
  { href: "#/sector/energy", label: tx("Energy and Oil"), view: ["sector"], need: "series.read", id: "energy" },
  { href: "#/sector/sovereign", label: tx("Sovereign Capital and Treasury"), view: ["sector"], need: "series.read", id: "sovereign" },
  { href: "#/briefing/energy", label: tx("Briefing: Energy and Oil"), view: ["briefing"], need: "series.read", id: "energy" },
  { href: "#/briefing/sovereign", label: tx("Briefing: Sovereign Capital"), view: ["briefing"], need: "series.read", id: "sovereign" },
  { href: "#/assistant", label: tx("Assistant"), view: ["assistant"], need: "sources.read" },
  { href: "#/sources", label: tx("Data & Sources"), view: ["sources"], need: "sources.read" },
  { href: "#/source-health", label: tx("Source health"), view: ["sourcehealth"], need: "sources.read" },
  { href: "#/evidence", label: tx("Evidence"), view: ["evidence"], need: "evidence.read" },
  { href: "#/documents", label: tx("Documents"), view: ["documents", "document"], need: "document.read" },
  { href: "#/series", label: tx("Series"), view: ["series"], need: "series.read" },
  { href: "#/map", label: tx("Map"), view: ["map"], need: "graph.read" },
  { href: "#/graph", label: tx("Graph"), view: ["graph"], need: "graph.read" },
  { href: "#/scenarios", label: tx("Scenarios"), view: ["scenarios", "run"], need: "scenario.read" },
  { href: "#/cases", label: tx("Cases"), view: ["cases", "case"], need: "case.read" },
  { href: "#/handoffs", label: tx("Handoffs"), view: ["handoffs"], need: "handoff.read" },
  { href: "#/memory", label: tx("Institutional Memory"), view: ["memory"], need: "memory.read" },
  { href: "#/policy", label: tx("Policy"), view: ["policy"], need: "policy.read" },
  { href: "#/settings", label: tx("Settings"), view: ["settings"], need: "settings.read" },
  { href: "#/retention", label: tx("Retention"), view: ["retention"], need: "retention.read" },
  { href: "#/alerts", label: tx("Alerts"), view: ["alerts"], need: "sources.read" },
  { href: "#/readiness", label: tx("Readiness"), view: ["readiness"], need: "identity.read" },
  { href: "#/audit", label: tx("Audit"), view: ["audit"], need: "audit.verify" },
  { href: "#/admin", label: tx("Administration"), view: ["admin"], need: "identity.read" },
];
