/** Jetons d'API : constantes et types, sans accès à la base (importables côté navigateur). */

export const TOKEN_PREFIX = "ipa_";
/** Un jeton ne donne jamais plus que « éditeur » : l'administration (comptes, projets, réglages, sauvegarde) exige une vraie session. */
export const TOKEN_ROLES = ["viewer", "editor"] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];
export const TOKEN_MAX_ACTIVE = 20;
export const TOKEN_NAME_MAX = 60;
/** Durées proposées (jours). 0 = sans expiration. */
export const TOKEN_EXPIRY_CHOICES = [30, 90, 365, 0] as const;
export const TOKEN_DEFAULT_EXPIRY_DAYS = 90;
export const TOKEN_MAX_EXPIRY_DAYS = 730;
/** Forme d'un jeton présenté dans l'en-tête Authorization : « Bearer ipa_… ». */
export const TOKEN_PATTERN = /^ipa_[A-Za-z0-9_-]{20,100}$/;

export const isTokenRole = (v: unknown): v is TokenRole => typeof v === "string" && (TOKEN_ROLES as readonly string[]).includes(v);

export type TokenStatus = "active" | "expired" | "revoked";

export interface ApiTokenRow {
  id: number;
  userId: number;
  /** Propriétaire (affiché aux administrateurs, qui voient tous les jetons). */
  username: string;
  name: string;
  /** Début du jeton (« ipa_Ab12 »), pour le reconnaître sans le révéler. */
  prefix: string;
  role: TokenRole;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: TokenStatus;
}

export interface CreateTokenInput {
  name?: unknown;
  role?: unknown;
  /** Jours avant expiration ; 0 = jamais ; absent = 90 jours. */
  expiresInDays?: unknown;
}
