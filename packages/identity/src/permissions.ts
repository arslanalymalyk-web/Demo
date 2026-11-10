export type Role = "executive" | "analyst" | "expert" | "approver" | "operations" | "administrator" | "auditor";
export type Permission = "sources.read" | "evidence.read" | "series.read" | "graph.read" | "scenario.read" | "scenario.run" | "audit.verify" | "identity.read" | "identity.manage"
  | "case.read" | "case.write" | "decision.make" | "handoff.read" | "handoff.update" | "policy.read" | "policy.manage" | "memory.read" | "document.read" | "document.upload" | "settings.read" | "settings.manage" | "retention.read" | "retention.manage" | "export.run" | "reasoning.use" | "reasoning.read";

const READ: Permission[] = ["sources.read", "evidence.read", "series.read", "graph.read", "scenario.read", "case.read", "handoff.read", "policy.read", "memory.read", "document.read", "settings.read"];
/** Role to permission policy (decision K3). Roles are named human roles; attribute rules (division, classification, case) come with the governance module. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  executive: [...READ, "decision.make", "reasoning.use"],
  analyst: [...READ, "scenario.run", "case.write", "document.upload", "reasoning.use"],
  expert: [...READ, "scenario.run", "reasoning.use"],
  approver: [...READ, "decision.make", "reasoning.use"],
  operations: [...READ, "handoff.update"],
  administrator: [...READ, "identity.read", "identity.manage", "policy.manage", "settings.manage", "retention.read", "retention.manage", "export.run", "reasoning.read"],
  auditor: [...READ, "audit.verify", "identity.read", "retention.read", "export.run", "reasoning.read"],
};

export const permissionsOf = (roles: string[]): Set<Permission> => new Set(roles.flatMap(r => ROLE_PERMISSIONS[r as Role] ?? []));
