/** Quelles adresses scanner, et a-t-on le droit de scanner ce réseau ? */
import { cidrContains, formatIp, parseCidr } from "../ip/cidr";
import { SCAN_MIN_PREFIX } from "../scanTypes";

/** Plages privées : RFC 1918 et partage d'adresses des opérateurs (100.64/10). Un outil d'inventaire n'a pas à sonder Internet. */
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"] as const;

export type ScanRefusal = "ipv6" | "tooBig" | "notPrivate";

/** null = scannable. `allowPublic` : variable d'environnement IP_ARCHITECT_SCAN_PUBLIC=1. */
export function scanRefusal(cidr: string, allowPublic = false): ScanRefusal | null {
  const c = parseCidr(cidr);
  if (!c || c.version !== 4) return "ipv6";
  if (c.prefix < SCAN_MIN_PREFIX) return "tooBig";
  if (!allowPublic && !PRIVATE.some((p) => cidrContains(p, cidr))) return "notPrivate";
  return null;
}

/** Adresses hôtes d'un réseau IPv4 (ni adresse réseau ni broadcast, sauf /31 et /32). */
export function scanTargets(cidr: string): string[] {
  const c = parseCidr(cidr);
  if (!c || c.version !== 4) return [];
  const size = 1n << BigInt(32 - c.prefix);
  const base = c.value & ~(size - 1n);
  const [first, last] = c.prefix >= 31 ? [base, base + size - 1n] : [base + 1n, base + size - 2n];
  const out: string[] = [];
  for (let a = first; a <= last; a++) out.push(formatIp(4, a));
  return out;
}
