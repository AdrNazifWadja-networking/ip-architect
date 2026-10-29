/** Types et constantes du scan réseau, sans accès à la base : importables côté navigateur. */

/** Ports essayés (connexion TCP) : beaucoup d'hôtes bloquent le ping mais répondent sur l'un d'eux. */
export const SCAN_PORTS = [22, 53, 80, 135, 443, 445, 3389, 8080] as const;
export const SCAN_DEFAULT_PORTS: readonly number[] = [22, 80, 443, 445, 3389];
/** Plus grand réseau scannable : /22 (1 024 adresses). */
export const SCAN_MIN_PREFIX = 22;
export const SCANS_KEPT_PER_NETWORK = 5;
/** Adresses importables en une fois. */
export const SCAN_IMPORT_MAX = 256;

export interface ScanOptions {
  icmp: boolean;
  ports: number[];
  /** Résolution DNS inverse des hôtes qui répondent. */
  resolve: boolean;
}

export interface ScanHost {
  address: string;
  /** Temps de réponse (ping) en ms, si connu. */
  ms: number | null;
  /** « icmp », « tcp:443 » (port ouvert) ou « tcp-refused » (le port a refusé : l'hôte est bien là). */
  via: string[];
  /** Nom obtenu par DNS inverse. */
  hostname: string | null;
  /** Adresse MAC lue dans la table des voisins du serveur (hôtes du même réseau local seulement), sinon null. */
  mac: string | null;
}

export type ScanStatus = "running" | "done" | "cancelled";

export interface ScanSummary {
  /** null tant que le scan tourne (il n'est enregistré qu'à la fin). */
  id: number | null;
  networkId: number;
  cidr: string;
  status: ScanStatus;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  alive: number;
  options: ScanOptions;
  /** Remarques : « icmpUnavailable » (commande ping absente : seuls les ports TCP ont servi). */
  notes: string[];
}

/** new = répond mais n'est pas inventoriée ; known = inventoriée et répond ; silent = inventoriée (« utilisée ») mais ne répond pas. */
export type ScanRowState = "new" | "known" | "silent" | "ignored";

export interface ScanRow {
  address: string;
  state: ScanRowState;
  ms: number | null;
  via: string[];
  /** Nom trouvé par DNS inverse. */
  discoveredHostname: string | null;
  /** Nom saisi dans l'IPAM. */
  hostname: string | null;
  inventoryStatus: "used" | "reserved" | null;
  mac: string | null;
  /** MAC vue au scan précédent quand elle est différente de celle-ci (changement de matériel, ou usurpation d'adresse). */
  prevMac: string | null;
}

export interface ScanReport {
  scan: ScanSummary | null;
  rows: ScanRow[];
  counts: { new: number; known: number; silent: number; ignored: number };
}

export interface ScanImportResult {
  imported: number;
  /** Adresses ignorées parce qu'elles sont désormais inventoriées. */
  skipped: number;
}

/** Délais possibles entre deux scans programmés, en heures (1 h, 6 h, 12 h, 1 jour, 1 semaine). */
export const SCHEDULE_HOURS = [1, 6, 12, 24, 168] as const;
/** Scans programmés par projet. */
export const SCHEDULES_MAX = 20;

export interface ScanSchedule {
  networkId: number;
  everyHours: number;
  enabled: boolean;
  /** Signaler (cloche, e-mails d'alerte) les hôtes inconnus trouvés par ce réseau. */
  alert: boolean;
  options: ScanOptions;
  lastStartedAt: string | null;
  /** Prochain lancement prévu (null si désactivé). */
  nextAt: string | null;
}

export interface UpdateScheduleInput {
  everyHours?: number;
  enabled?: boolean;
  alert?: boolean;
  icmp?: boolean;
  ports?: number[];
  resolve?: boolean;
}
