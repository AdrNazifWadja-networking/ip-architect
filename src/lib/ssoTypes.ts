/** Types et fonctions pures de la connexion unique (OpenID Connect) et de l'annuaire (LDAP) : importables côté navigateur. */
import type { UserRole } from "./types";

export const DEFAULT_ROLES = ["viewer", "editor"] as const;
export type DefaultRole = (typeof DEFAULT_ROLES)[number];

/** Réglages communs : qui peut se connecter, quel rôle reçoit-il. Les groupes se comparent sans tenir compte de la casse. */
export interface Provisioning {
  /** Si non vide : seuls les membres de l'un de ces groupes (ou des groupes administrateur / éditeur) peuvent se connecter. */
  allowedGroups: string[];
  adminGroups: string[];
  editorGroups: string[];
  /** Rôle d'un compte qui n'est dans aucun groupe de rôle. */
  defaultRole: DefaultRole;
  /** true : le rôle est recalculé à chaque connexion d'après les groupes (jamais en retirant le dernier administrateur). */
  syncRole: boolean;
}

export interface OidcConfig extends Provisioning {
  enabled: boolean;
  /** Adresse de l'émetteur (https://…), sans « /.well-known/… ». */
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  scopes: string;
  /** Revendication utilisée comme identifiant (preferred_username, email…). */
  usernameClaim: string;
  groupsClaim: string;
  /** Texte du bouton de connexion. */
  label: string;
  /** Adresse publique de l'application (https://ipam.exemple.fr) ; vide = déduite de la requête. */
  publicUrl: string;
  /** Domaines d'e-mail acceptés (vide = tous). */
  domains: string[];
}

export type LdapSecurity = "ldaps" | "starttls" | "none";

export interface LdapConfig extends Provisioning {
  enabled: boolean;
  /** ldap://hôte[:port] ou ldaps://hôte[:port]. */
  url: string;
  startTls: boolean;
  bindDn: string;
  hasPassword: boolean;
  baseDn: string;
  /** Filtre RFC 4515 contenant {username}, par exemple (uid={username}) ou (sAMAccountName={username}). */
  userFilter: string;
  usernameAttr: string;
  displayNameAttr: string;
  emailAttr: string;
  groupAttr: string;
}

export interface SsoConfig {
  oidc: OidcConfig;
  ldap: LdapConfig;
}

export type UpdateSsoInput = {
  oidc?: Partial<Omit<OidcConfig, "hasSecret">> & { clientSecret?: string };
  ldap?: Partial<Omit<LdapConfig, "hasPassword">> & { bindPassword?: string };
};

/** Ce que la page de connexion a besoin de savoir (public : aucune donnée sensible). */
export interface LoginOptions {
  oidc: { label: string } | null;
  ldap: boolean;
}

export const OIDC_DEFAULTS = {
  scopes: "openid profile email",
  usernameClaim: "preferred_username",
  groupsClaim: "groups",
  label: "SSO",
} as const;

export const LDAP_DEFAULTS = {
  userFilter: "(uid={username})",
  usernameAttr: "uid",
  displayNameAttr: "cn",
  emailAttr: "mail",
  groupAttr: "memberOf",
} as const;

export const SSO_ERROR_CODES = [
  "ssoDisabled",
  "ssoState",
  "ssoProvider",
  "ssoToken",
  "ssoNotAllowed",
  "ssoInactive",
  "ssoNoUsername",
  "ssoDomain",
  "ssoDenied",
] as const;
export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

/* ------------------------------ Groupes et rôles ------------------------------ */

const cnOf = (g: string): string | null => {
  const m = /^cn=((?:[^,\\]|\\.)+)/i.exec(g.trim());
  return m ? m[1].toLowerCase() : null;
};

/** Identités sous lesquelles un groupe peut être reconnu : son texte complet et, pour un DN, son CN. */
function keys(g: string): string[] {
  const full = g.trim().toLowerCase();
  const cn = cnOf(g);
  return cn ? [full, cn] : [full];
}

/** Le groupe `g` de l'utilisateur est-il l'un des groupes `wanted` de la configuration ? */
export function inGroups(userGroups: readonly string[], wanted: readonly string[]): boolean {
  if (wanted.length === 0) return false;
  const want = new Set(wanted.flatMap(keys));
  return userGroups.some((g) => keys(g).some((k) => want.has(k)));
}

export function roleFromGroups(groups: readonly string[], p: Pick<Provisioning, "adminGroups" | "editorGroups" | "defaultRole">): UserRole {
  if (inGroups(groups, p.adminGroups)) return "admin";
  if (inGroups(groups, p.editorGroups)) return "editor";
  return p.defaultRole;
}

/** false : la connexion est refusée parce qu'une liste de groupes autorisés est définie et que la personne n'y figure pas. */
export function groupAllowed(groups: readonly string[], p: Pick<Provisioning, "allowedGroups" | "adminGroups" | "editorGroups">): boolean {
  if (p.allowedGroups.length === 0) return true;
  return inGroups(groups, [...p.allowedGroups, ...p.adminGroups, ...p.editorGroups]);
}

/** Identifiant de compte valide (3 à 40 caractères : lettres minuscules, chiffres, . _ -) tiré d'une valeur quelconque ; null si rien d'exploitable. */
export function usernameFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u = raw.trim().toLowerCase();
  if (u.includes("@")) u = u.split("@")[0];
  u = u.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]+/g, ".").replace(/^[^a-z0-9]+/, "").replace(/\.{2,}/g, ".").replace(/[._-]+$/, "");
  if (u.length === 0) return null;
  if (u.length < 3) u = u.padEnd(3, "0");
  u = u.slice(0, 40).replace(/[._-]+$/, "");
  return /^[a-z0-9][a-z0-9._-]{2,39}$/.test(u) ? u : null;
}
