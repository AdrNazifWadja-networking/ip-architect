/** Types et constantes du journal d'audit, sans accès à la base : importables côté navigateur. */

export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "activate",
  "apply",
  "import",
  "login",
  "loginFailed",
  "logout",
  "passwordChange",
  "backup",
  "ask",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITIES = [
  "network",
  "address",
  "vlan",
  "site",
  "project",
  "vrf",
  "dhcpScope",
  "dhcpReservation",
  "plan",
  "user",
  "session",
  "csv",
  "settings",
  "database",
  "assistant",
  "token",
  "exercise",
  "tpClass",
  "tag",
  "customField",
  "webhook",
  "scan",
  "topoDevice",
  "topoLink",
  "snmpCredential",
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export const isAuditAction = (v: unknown): v is AuditAction => typeof v === "string" && (AUDIT_ACTIONS as readonly string[]).includes(v);
export const isAuditEntity = (v: unknown): v is AuditEntity => typeof v === "string" && (AUDIT_ENTITIES as readonly string[]).includes(v);

import type { ChangeSet } from "./changeTypes";

export interface AuditRow {
  id: number;
  /** ISO 8601 UTC. */
  at: string;
  userId: number | null;
  /** Nom du compte au moment de l'action (conservé même si le compte est supprimé) ; null = pas de compte. */
  username: string | null;
  projectId: number | null;
  projectName: string | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId: number | null;
  /** Texte libre (données de l'utilisateur : jamais traduit). */
  detail: string | null;
  ip: string | null;
  /** Valeurs avant / après (modifications et suppressions d'objets), sans aucune valeur secrète ; null = non applicable. */
  changes: ChangeSet | null;
  /** « token:ipa_ab12 » quand l'action est venue d'un jeton d'API ; null = session de navigateur. */
  via: string | null;
}

export interface AuditFilters {
  q?: string;
  user?: string;
  action?: string;
  entity?: string;
  /** AAAA-MM-JJ, jour UTC inclus. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MIN_RETENTION_DAYS = 30;
export const AUDIT_MAX_RETENTION_DAYS = 3650;
export const AUDIT_DEFAULT_RETENTION_DAYS = 365;
