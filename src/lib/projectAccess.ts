/** Accès par projet : types partagés serveur / navigateur. */
import type { Role } from "./auth/roles";

/**
 * « all » : le rôle du compte vaut dans tous les projets (comportement historique, y compris les projets créés plus tard).
 * « selected » : le compte n'a accès qu'aux projets listés, avec un rôle propre à chacun.
 */
export const PROJECT_SCOPES = ["all", "selected"] as const;
export type ProjectScope = (typeof PROJECT_SCOPES)[number];

export function isProjectScope(v: unknown): v is ProjectScope {
  return typeof v === "string" && (PROJECT_SCOPES as readonly string[]).includes(v);
}

/** Rôles possibles dans un projet : jamais « administrateur » (l'administration est globale). */
export const MEMBER_ROLES = ["viewer", "editor"] as const;
export type MemberRole = Extract<Role, (typeof MEMBER_ROLES)[number]>;

export function isMemberRole(v: unknown): v is MemberRole {
  return typeof v === "string" && (MEMBER_ROLES as readonly string[]).includes(v);
}

export interface Membership {
  projectId: number;
  role: MemberRole;
}

/** En-tête qui choisit le projet d'une requête d'API (sinon : le projet actif du compte). */
export const PROJECT_HEADER = "x-project-id";
