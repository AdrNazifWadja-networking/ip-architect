/** Constantes et types partagés (serveur + interface) pour les webhooks. */

/** Objets dont les changements peuvent être envoyés (jamais les comptes, jetons, sessions ni réglages). */
export const WEBHOOK_ENTITIES = [
  "network",
  "address",
  "vlan",
  "site",
  "vrf",
  "dhcpScope",
  "dhcpReservation",
  "plan",
  "tag",
  "customField",
] as const;
export type WebhookEntity = (typeof WEBHOOK_ENTITIES)[number];

export const WEBHOOK_CRUD = ["create", "update", "delete"] as const;

/** Événements précis : « objet.action ». */
export const WEBHOOK_EVENTS: readonly string[] = [
  ...WEBHOOK_ENTITIES.flatMap((e) => WEBHOOK_CRUD.map((a) => `${e}.${a}`)),
  "plan.apply",
  "csv.import",
];
export const TEST_EVENT = "webhook.test";

export const WEBHOOK_NAME_MAX = 60;
export const WEBHOOK_URL_MAX = 500;
export const WEBHOOKS_PER_PROJECT_MAX = 10;
export const DELIVERY_MAX_ATTEMPTS = 5;
export const DELIVERY_RETENTION_DAYS = 14;
export const DELIVERIES_PER_HOOK_MAX = 1000;
/** Délai avant la nouvelle tentative n° 2, 3, 4, 5 (secondes). */
export const RETRY_DELAYS_S = [60, 300, 1800, 7200] as const;

export type DeliveryStatus = "pending" | "success" | "failed";

/** « * », « network.* » ou un événement précis. */
export function isEventPattern(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (p === "*") return true;
  if (WEBHOOK_EVENTS.includes(p)) return true;
  const m = /^([A-Za-z]+)\.\*$/.exec(p);
  return !!m && (WEBHOOK_ENTITIES as readonly string[]).includes(m[1]);
}

export function eventMatches(patterns: readonly string[], event: string): boolean {
  return patterns.some((p) => p === "*" || p === event || (p.endsWith(".*") && event.startsWith(p.slice(0, -1))));
}

export interface WebhookInfo {
  id: number;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  pending: number;
  failed: number;
  success: number;
  lastStatus: DeliveryStatus | null;
  lastAt: string | null;
}

export interface DeliveryInfo {
  id: number;
  event: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  events?: string[];
  active?: boolean;
}
export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  events?: string[];
  active?: boolean;
}
