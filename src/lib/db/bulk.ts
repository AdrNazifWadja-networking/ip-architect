import { getDb, type Db } from "./index";
import { deleteNetwork } from "./queries";
import { getNetwork } from "./ipam";
import { updateNetwork } from "./edit";
import { ApiError, type UpdateNetworkInput } from "../types";

export const BULK_MAX = 200;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Une modification groupée a échoué sur un réseau précis : on garde l'erreur d'origine et le CIDR pour le message. */
export class BulkError extends Error {
  constructor(public readonly cidr: string, public readonly cause: ApiError) {
    super(cidr);
  }
}

export interface BulkChanges {
  siteId?: number | null;
  vlan?: number | null;
  vrfId?: number | null;
  status?: string;
  /** Étiquettes à ajouter / à retirer (les autres restent). */
  addTags?: string[];
  removeTags?: string[];
  /** Fusionné comme pour une modification simple ; valeur vide = effacer. */
  customFields?: Record<string, unknown>;
}

const ALLOWED = ["siteId", "vlan", "vrfId", "status", "addTags", "removeTags", "customFields"];

export function cleanIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiError("bulkNoSelection", 422);
  if (raw.length > BULK_MAX) throw new ApiError("bulkTooMany", 422, { max: BULK_MAX });
  const ids: number[] = [];
  for (const v of raw) {
    if (!Number.isInteger(v)) throw new ApiError("invalidId", 400);
    if (!ids.includes(v as number)) ids.push(v as number);
  }
  return ids;
}

function cidrOf(id: number, db: Db): string {
  try {
    return getNetwork(id, db).cidr;
  } catch {
    return `#${id}`;
  }
}

const names = (v: unknown): string[] => {
  if (!Array.isArray(v)) throw new ApiError("invalidBody", 400);
  return v.map(String);
};

/**
 * Applique les mêmes modifications à plusieurs réseaux du projet actif, tout ou rien :
 * une seule erreur (chevauchement de VRF, valeur invalide…) annule l'ensemble et nomme le réseau fautif.
 */
export function bulkUpdateNetworks(rawIds: unknown, changes: BulkChanges, db: Db = getDb()): number[] {
  const ids = cleanIds(rawIds);
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new ApiError("invalidBody", 400);
  const keys = Object.keys(changes);
  if (keys.length === 0 || keys.some((k) => !ALLOWED.includes(k))) throw new ApiError("invalidBody", 400);
  const add = has(changes, "addTags") ? names(changes.addTags) : [];
  const remove = has(changes, "removeTags") ? names(changes.removeTags) : [];

  const run = db.transaction(() => {
    for (const id of ids) {
      const input: UpdateNetworkInput = {};
      for (const k of ["siteId", "vlan", "vrfId", "status", "customFields"] as const) {
        if (has(changes, k)) (input as Record<string, unknown>)[k] = changes[k];
      }
      try {
        if (add.length > 0 || remove.length > 0) {
          const low = (s: string) => s.trim().toLowerCase();
          const current = getNetwork(id, db).tags.map((t) => t.name);
          const gone = new Set(remove.map(low));
          const next = [...current, ...add].filter((n, i, all) => all.findIndex((x) => low(x) === low(n)) === i && !gone.has(low(n)));
          input.tags = next;
        }
        updateNetwork(id, input, db);
      } catch (e) {
        if (e instanceof ApiError) throw new BulkError(cidrOf(id, db), e);
        throw e;
      }
    }
  });
  run();
  return ids;
}

/** Supprime plusieurs réseaux (et leurs adresses), tout ou rien. */
export function bulkDeleteNetworks(rawIds: unknown, db: Db = getDb()): number[] {
  const ids = cleanIds(rawIds);
  db.transaction(() => {
    for (const id of ids) {
      const cidr = cidrOf(id, db);
      try {
        deleteNetwork(id, db);
      } catch (e) {
        if (e instanceof ApiError) throw new BulkError(cidr, e);
        throw e;
      }
    }
  })();
  return ids;
}
