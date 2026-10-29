/** Rôles, du moins au plus privilégié. Module pur : importable côté navigateur. */
export const ROLES = ["viewer", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Le rôle `role` donne-t-il au moins les droits de `min` ? */
export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** Nom du cookie de session. */
export const SESSION_COOKIE = "ipa_session";
/** Un utilisateur inactif plus longtemps que ça est déconnecté. */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** Durée maximale absolue d'une session, même en activité continue. */
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
