/** Types et constantes de la topologie réseau, sans accès à la base : importables côté navigateur. */

export const TOPO_KINDS = ["router", "firewall", "switch", "ap", "server", "host", "phone", "network", "other"] as const;
export type TopoKind = (typeof TOPO_KINDS)[number];
export const isTopoKind = (v: unknown): v is TopoKind => typeof v === "string" && (TOPO_KINDS as readonly string[]).includes(v);

export const TOPO_DEVICES_MAX = 200;
export const TOPO_LINKS_MAX = 1000;
export const TOPO_DEPTH_MAX = 5;
export const TOPO_CLIENTS_PER_DEVICE = 1000;
export const TOPO_CREDENTIALS_MAX = 20;
export const TOPO_PORTS_MAX = 256;

export interface TopoPort {
  name: string;
  speedMbps: number | null;
  up: boolean | null;
}

export interface TopoDevice {
  id: number;
  name: string;
  address: string | null;
  kind: TopoKind;
  /** Description donnée par l'équipement (sysDescr) ou saisie à la main. */
  info: string | null;
  chassisId: string | null;
  siteId: number | null;
  credentialId: number | null;
  /** « manual » : saisi à la main ; « snmp » : interrogé ; « lldp » : vu par un voisin mais pas interrogé. */
  source: "manual" | "snmp" | "lldp" | "scan";
  /** Position choisie à la main (null : calcul automatique). */
  x: number | null;
  y: number | null;
  lastSeenAt: string | null;
  ports: TopoPort[];
  clientCount: number;
}

export interface TopoLink {
  id: number;
  aDevice: number;
  aPort: string | null;
  bDevice: number;
  bPort: string | null;
  source: "manual" | "lldp" | "cdp" | "scan";
  speedMbps: number | null;
  lastSeenAt: string | null;
}

export interface TopoClient {
  deviceId: number;
  port: string | null;
  mac: string;
  ip: string | null;
  vlan: number | null;
  lastSeenAt: string;
}

/** La communauté n'est jamais renvoyée : seulement le fait qu'elle existe. */
export interface TopoCredential {
  id: number;
  name: string;
  port: number;
}

export interface TopologyData {
  devices: TopoDevice[];
  links: TopoLink[];
}

export interface DiscoverInput {
  /** Réseau de l'IPAM à découvrir (scan des hôtes) ; sans lui, `seed` est obligatoire. */
  networkId?: number;
  /** Adresse du premier équipement à interroger (le plus central : routeur ou cœur de réseau). */
  seed?: string;
  /** Facultatif avec `networkId` : sans identifiants, seuls les hôtes qui répondent sont placés (pas de câblage). */
  credentialId?: number;
  /** Profondeur maximale à partir de l'équipement de départ. */
  depth?: number;
}

export interface DiscoverStatus {
  status: "idle" | "running" | "done" | "failed" | "cancelled";
  seed: string | null;
  /** « scan » : recherche des hôtes ; « snmp » : lecture des équipements ; « merge » : enregistrement. */
  phase: "scan" | "snmp" | "merge" | null;
  startedAt: string | null;
  finishedAt: string | null;
  visited: number;
  queued: number;
  devices: number;
  links: number;
  clients: number;
  notes: string[];
}
