export type Role = "executive" | "analyst" | "expert" | "approver" | "operations" | "administrator" | "auditor";
export type Permission = "sources.read" | "evidence.read" | "series.read" | "graph.read" | "scenario.read" | "scenario.run" | "audit.verify" | "identity.read" | "identity.manage"
  | "case.read" | "case.write" | "decision.make" | "handoff.read" | "handoff.update" | "policy.read" | "policy.manage" | "memory.read" | "document.read" | "document.upload";

const READ: Permission[] = ["sources.read", "evidence.read", "series.read", "graph.read", "scenario.read", "case.read", "handoff.read", "policy.read", "memory.read", "document.read"];
/** Role to permission policy (decision K3). Roles are named human roles; attribute rules (division, classification, case) come with the governance module. */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  executive: [...READ, "decision.make"],
  analyst: [...READ, "scenario.run", "case.write", "document.upload"],
  expert: [...READ, "scenario.run"],
  approver: [...READ, "decision.make"],
  operations: [...READ, "handoff.update"],
  administrator: [...READ, "identity.read", "identity.manage", "policy.manage"],
  auditor: [...READ, "audit.verify", "identity.read"],
};

export const permissionsOf = (roles: string[]): Set<Permission> => new Set(roles.flatMap(r => ROLE_PERMISSIONS[r as Role] ?? []));
