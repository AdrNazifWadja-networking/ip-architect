/**
 * Allocation d'un plan d'adressage (pur, sans base) : partagée par le serveur (application du plan) et par
 * l'éditeur du navigateur (aperçu en direct pendant la saisie).
 */
import { bitsOf, parseCidr, type IpVersion } from "../ip/cidr";
import { allocateBlocks, prefixForHosts, usableHosts, type AllocationReason } from "./blocks";

export interface PlanNeed {
  hosts: number | null;
  prefix: number | null;
}

export interface PlanAllocation {
  /** Bloc attribué ; null si aucune place ou besoin invalide. */
  cidr: string | null;
  /** Préfixe demandé (déduit du nombre d'hôtes si besoin). */
  prefix: number | null;
  /** Adresses utilisables dans le bloc demandé. */
  usable: bigint | null;
  reason: AllocationReason | "invalid" | null;
}

/** Préfixe d'un besoin : explicite, ou déduit du nombre d'hôtes (IPv4 uniquement). null = besoin invalide. */
export function needPrefix(version: IpVersion, need: PlanNeed): number | null {
  const hasHosts = need.hosts !== null && need.hosts !== undefined;
  const hasPrefix = need.prefix !== null && need.prefix !== undefined;
  if (hasHosts === hasPrefix) return null; // les deux, ou aucun
  if (hasPrefix) {
    const p = need.prefix as number;
    return Number.isInteger(p) && p >= 0 && p <= bitsOf(version) ? p : null;
  }
  if (version !== 4) return null;
  return prefixForHosts(need.hosts as number);
}

/** Attribue un bloc du parent à chaque besoin (plus gros d'abord), en évitant les réseaux existants. */
export function allocatePlan(parent: string, taken: string[], needs: PlanNeed[]): PlanAllocation[] {
  const p = parseCidr(parent);
  if (!p) return needs.map(() => ({ cidr: null, prefix: null, usable: null, reason: "invalid" as const }));
  const prefixes = needs.map((n) => needPrefix(p.version, n));
  const valid = prefixes.map((x, i) => (x === null ? null : { key: i, prefix: x })).filter((x): x is { key: number; prefix: number } => x !== null);
  const done = new Map(allocateBlocks(parent, taken, valid).map((a) => [a.key as number, a]));
  return needs.map((_, i) => {
    const prefix = prefixes[i];
    if (prefix === null) return { cidr: null, prefix: null, usable: null, reason: "invalid" as const };
    const a = done.get(i)!;
    return { cidr: a.cidr, prefix, usable: usableHosts(p.version, prefix), reason: a.reason };
  });
}
