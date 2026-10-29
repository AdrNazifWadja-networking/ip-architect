import type { Dictionary } from "./i18n";
import type { FindingKind } from "./db/monitoring";

export type NetworkStatus = "active" | "inactive" | "maintenance" | "error";
export type AlertSeverity = "critical" | "warning" | "info";
export type AlertKind = "overlap" | "dhcp" | "usage" | "prefix" | "backup";
/** Nature de la cible d'une alerte : sert à choisir le libellé (« Réseau », « Pool », « Projet »). */
export type AlertSubjectType = "network" | "pool" | "project";

export interface Site {
  id: number;
  name: string;
}

/** Site avec ses compteurs (page Sites). */
export interface SiteRow {
  id: number;
  name: string;
  address: string | null;
  description: string | null;
  networkCount: number;
  vlanCount: number;
  /** Utilisation IPv4 moyenne des réseaux du site (null = aucun réseau IPv4). */
  ipv4UsagePct: number | null;
  createdAt: string | null;
}

export interface CreateSiteInput {
  name: string;
  address?: string | null;
  description?: string | null;
}

/** Champ absent = inchangé ; null = efface (adresse, description). */
export interface UpdateSiteInput {
  name?: string;
  address?: string | null;
  description?: string | null;
}

export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  active: boolean;
  networkCount: number;
  siteCount: number;
  vlanCount: number;
  vrfCount: number;
  createdAt: string | null;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
}

export interface NetworkRow {
  id: number;
  cidr: string;
  version: 4 | 6;
  name: string;
  siteId: number | null;
  siteName: string | null;
  vlan: number | null;
  /** VRF du réseau (null = table de routage globale, par défaut). */
  vrfId: number | null;
  vrfName: string | null;
  status: NetworkStatus;
  usedIps: number;
  reservedIps: number;
  capacity: number;
  usagePct: number; // 0-100
  createdAt: string;
  /** Étiquettes posées sur le réseau. */
  tags: TagRef[];
  /** Valeurs des champs personnalisés, par clé de champ. */
  customFields: CustomValues;
}

/** Étiquette telle qu'attachée à un réseau ou une adresse. */
export interface TagRef {
  id: number;
  name: string;
  color: string;
}
export type CustomValue = string | number | boolean;
export type CustomValues = Record<string, CustomValue>;

export interface Delta {
  value: number; // pourcentage ou points
  /** true si une hausse est une mauvaise nouvelle (ex: alertes) */
  inverse?: boolean;
}

export interface DashboardData {
  project: { id: number; name: string };
  kpis: {
    ipv4Networks: number;
    ipv6Networks: number;
    ipv6Delta: Delta | null;
    usedIps: number;
    capacity: number;
    usageRate: number;
    usageDelta: Delta | null;
    vlans: number;
    vlanDelta: Delta | null;
    alerts: number;
    alertDelta: Delta | null;
  };
  addressUsage: { used: number; available: number; reserved: number; total: number; pct: number };
  versionSplit: { ipv4: number; ipv6: number; total: number; ipv4Pct: number; ipv6Pct: number };
  topSites: { name: string; pct: number }[];
  /** Pas de libellé ici : il est traduit à l'affichage (dictionnaire `statusPlural`). */
  statusSplit: { status: NetworkStatus; count: number; pct: number }[];
  statusTotal: number;
  /** ipv4: % d'adresses IPv4 utilisées · ipv6: % de réseaux IPv6 en service · active: % de réseaux au statut "actif" */
  history: { day: string; ipv4: number; ipv6: number; active: number }[];
  /** Contrôles de supervision en cours (les plus graves d'abord) : le texte est construit à partir du dictionnaire `monitoring.findings`. */
  alerts: {
    kind: FindingKind;
    severity: "critical" | "warning";
    params: Record<string, string | number>;
    href: string;
  }[];
}

export interface CreateNetworkInput {
  cidr: string;
  name: string;
  siteId?: number | null;
  vlan?: number | null;
  /** null ou absent = VRF globale (par défaut). */
  vrfId?: number | null;
  status?: NetworkStatus;
  usedIps?: number;
  reservedIps?: number;
  tags?: string[];
  customFields?: Record<string, unknown>;
}

export type AddressStatus = "used" | "reserved";

/** Une adresse inventoriée dans un réseau (IPAM). */
export interface IpAddressRow {
  id: number;
  networkId: number;
  address: string;
  status: AddressStatus;
  hostname: string | null;
  description: string | null;
  createdAt: string;
  tags: TagRef[];
  customFields: CustomValues;
}

export interface CreateAddressInput {
  /** Vide ou absent = première adresse libre du réseau. */
  address?: string;
  status?: AddressStatus;
  hostname?: string;
  description?: string;
  /** Noms d'étiquettes (créées au besoin). */
  tags?: string[];
  customFields?: Record<string, unknown>;
}

export interface VlanRow {
  id: number;
  number: number;
  name: string;
  siteId: number | null;
  siteName: string | null;
  /** Nombre de réseaux rattachés (même site, même numéro de VLAN). */
  networkCount: number;
  createdAt: string;
}

export interface CreateVlanInput {
  number: number;
  name: string;
  siteId?: number | null;
}

/** Plage de distribution DHCP (IPv4) rattachée à un réseau. */
export interface DhcpScopeRow {
  id: number;
  networkId: number;
  networkCidr: string;
  networkName: string;
  siteName: string | null;
  name: string;
  rangeStart: string;
  rangeEnd: string;
  gateway: string | null;
  dns: string[];
  leaseSeconds: number;
  enabled: boolean;
  /** Nombre d'adresses de la plage (fin - début + 1). */
  poolSize: number;
  /** Réservations MAC -> IP de la plage. */
  reservationCount: number;
  /** Adresses inventoriées dans l'IPAM qui tombent dans la plage dynamique (hors réservations DHCP) : risque de conflit. */
  conflictCount: number;
  /** Adresses réellement distribuables : plage - réservations incluses dans la plage - adresses en conflit. */
  distributable: number;
  createdAt: string;
}

export interface CreateDhcpScopeInput {
  networkId: number;
  name: string;
  rangeStart: string;
  rangeEnd: string;
  gateway?: string | null;
  /** Liste séparée par des virgules, des espaces ou des retours à la ligne. */
  dns?: string | string[];
  leaseSeconds?: number;
  enabled?: boolean;
}

export interface DhcpReservationRow {
  id: number;
  scopeId: number;
  mac: string;
  address: string;
  hostname: string | null;
  description: string | null;
  createdAt: string;
}

export interface CreateDhcpReservationInput {
  mac: string;
  address: string;
  hostname?: string;
  description?: string;
}

/** VRF : espace d'adressage isolé. Deux réseaux peuvent avoir le même CIDR s'ils sont dans des VRF différentes. */
export interface VrfRow {
  id: number;
  name: string;
  /** Route distinguisher (ex. 65000:100) ; null = VRF-Lite. */
  rd: string | null;
  rtImport: string[];
  rtExport: string[];
  description: string | null;
  networkCount: number;
  /** Utilisation des réseaux IPv4 de la VRF (0-100) ; null s'il n'y en a aucun. */
  ipv4UsagePct: number | null;
  createdAt: string;
}

export interface CreateVrfInput {
  name: string;
  rd?: string | null;
  /** Liste séparée par des virgules, des espaces ou des retours à la ligne. */
  rtImport?: string | string[];
  rtExport?: string | string[];
  description?: string | null;
}

/* ------------------------------ Modifications ------------------------------ */
/* Pour chaque champ : absent (undefined) = inchangé. `null` efface un champ facultatif. */

export interface UpdateNetworkInput {
  name?: string;
  siteId?: number | null;
  vlan?: number | null;
  vrfId?: number | null;
  status?: NetworkStatus;
  usedIps?: number;
  reservedIps?: number;
  /** Remplace l'ensemble des étiquettes. */
  tags?: string[];
  /** Fusionne : une valeur vide ("" ou null) efface le champ. */
  customFields?: Record<string, unknown>;
}

export interface UpdateVlanInput {
  name?: string;
  number?: number;
  siteId?: number | null;
}

export interface UpdateDhcpScopeInput {
  name?: string;
  rangeStart?: string;
  rangeEnd?: string;
  gateway?: string | null;
  dns?: string | string[];
  leaseSeconds?: number;
  enabled?: boolean;
}

export interface UpdateDhcpReservationInput {
  mac?: string;
  hostname?: string | null;
  description?: string | null;
}

export interface UpdateVrfInput {
  name?: string;
  rd?: string | null;
  rtImport?: string | string[];
  rtExport?: string | string[];
  description?: string | null;
}

export interface UpdateAddressInput {
  status?: AddressStatus;
  hostname?: string | null;
  description?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
}

/** Code d'erreur = clé de `t.errors` : le message est traduit au moment de répondre à la requête. */
export type ErrorCode = keyof Dictionary["errors"];

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    public status = 400,
    public params?: Record<string, string | number>,
  ) {
    super(code);
  }
}

/* ------------------------------ Import / export CSV ------------------------------ */

export const CSV_ENTITIES = [
  "sites",
  "vrfs",
  "vlans",
  "networks",
  "addresses",
  "dhcp_scopes",
  "dhcp_reservations",
] as const;
export type CsvEntity = (typeof CSV_ENTITIES)[number];

export interface ImportRowError {
  /** Numéro d'enregistrement dans le fichier (l'en-tête est la ligne 1). */
  line: number;
  code: ErrorCode;
  params?: Record<string, string | number>;
  /** Message traduit, rempli par la couche API. */
  message?: string;
}

export interface ImportResult {
  entity: CsvEntity;
  /** true = simulation : tout a été exécuté puis annulé. */
  dryRun: boolean;
  /** true = les lignes ont été écrites (jamais en simulation, jamais s'il y a des erreurs). */
  committed: boolean;
  total: number;
  created: number;
  skipped: number;
  errors: ImportRowError[];
  /** Colonnes du fichier qui ne correspondent à aucun champ (ignorées). */
  ignoredColumns: string[];
  delimiter: ";" | "," | "\t";
}

/* ------------------------------ Planification ------------------------------ */

export type PlanStatus = "draft" | "applied";

export interface PlanRow {
  id: number;
  name: string;
  parentCidr: string;
  vrfId: number | null;
  vrfName: string | null;
  description: string | null;
  status: PlanStatus;
  itemCount: number;
  createdAt: string;
}

/** Besoin d'un réseau : soit un nombre d'hôtes (IPv4), soit un préfixe. */
export interface PlanItemInput {
  name: string;
  hosts?: number | null;
  prefix?: number | null;
  siteId?: number | null;
  vlan?: number | null;
}

export interface PlanItem {
  id: number;
  position: number;
  name: string;
  hosts: number | null;
  prefix: number | null;
  siteId: number | null;
  siteName: string | null;
  vlan: number | null;
  /** Réseau créé quand le plan est appliqué. */
  appliedCidr: string | null;
}

export interface PlanDetail extends PlanRow {
  items: PlanItem[];
  /** Réseaux existants (même VRF) qui chevauchent le bloc : l'espace n'est pas libre. */
  taken: string[];
}

export interface CreatePlanInput {
  name: string;
  parentCidr: string;
  vrfId?: number | null;
  description?: string | null;
  items?: PlanItemInput[];
}

/** Brouillon : tout se modifie. Appliqué : seuls le nom et la description. */
export interface UpdatePlanInput {
  name?: string;
  parentCidr?: string;
  vrfId?: number | null;
  description?: string | null;
  items?: PlanItemInput[];
}

export interface ApplyPlanInput {
  /** Statut des réseaux créés (défaut : inactive, car ils ne sont pas encore déployés). */
  status?: NetworkStatus;
}

/* ------------------------------ Utilisateurs ------------------------------ */

export type UserRole = "viewer" | "editor" | "admin";

export interface UserRow {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Adresse e-mail (facultative pour les comptes créés par un administrateur). */
  email: string | null;
  /** L'adresse a été vérifiée par un code (inscription par e-mail). */
  emailVerified: boolean;
  projectScope: "all" | "selected";
  /** « local » (mot de passe de l'application) ou « oidc » / « ldap » (identité gérée ailleurs : pas de mot de passe ici). */
  authSource: "local" | "oidc" | "ldap";
  /** Rôle dans chaque projet (seulement pour la portée « selected »). */
  memberships: { projectId: number; role: "viewer" | "editor" }[];
}

/** L'utilisateur d'une session (jamais de hash de mot de passe). */
export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  /** « all » : le rôle vaut dans tous les projets ; « selected » : seulement dans les projets où le compte est membre. */
  projectScope: "all" | "selected";
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  password: string;
  role?: UserRole;
  email?: string | null;
  projectScope?: "all" | "selected";
  memberships?: { projectId: number; role: "viewer" | "editor" }[];
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  active?: boolean;
  /** Réinitialisation du mot de passe par un administrateur. */
  password?: string;
  /** null ou "" efface l'adresse. Modifier l'adresse la rend non vérifiée. */
  email?: string | null;
  projectScope?: "all" | "selected";
  /** Remplace la liste complète des projets du compte (portée « selected »). */
  memberships?: { projectId: number; role: "viewer" | "editor" }[];
}
