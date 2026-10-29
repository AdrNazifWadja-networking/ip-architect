/**
 * Logique d'allocation d'adresses (IPAM) : pure, sans base de données, entièrement testable.
 * S'appuie sur le moteur CIDR (BigInt) : fonctionne à l'identique en IPv4 et IPv6.
 */
import { calcSubnet, formatIp, ipInCidr, networkOf, parseCidr, parseIp } from "./cidr";

/** Forme canonique d'une adresse (ex: 2001:0DB8::0001 -> 2001:db8::1). null si invalide. */
export function normalizeIp(input: string): string | null {
  const ip = parseIp(input);
  return ip ? formatIp(ip.version, ip.value) : null;
}

/** Première et dernière adresse attribuables à un hôte (mêmes bornes que le calculateur IP). */
function hostBounds(cidr: string): { version: 4 | 6; first: bigint; last: bigint } | null {
  const info = calcSubnet(cidr);
  const first = info ? parseIp(info.firstHost) : null;
  const last = info ? parseIp(info.lastHost) : null;
  if (!info || !first || !last) return null;
  return { version: info.version, first: first.value, last: last.value };
}

/** L'adresse est-elle dans le réseau ET attribuable à un hôte (ni adresse réseau, ni broadcast en IPv4) ? */
export function isAssignable(cidr: string, address: string): boolean {
  const ip = parseIp(address);
  const bounds = hostBounds(cidr);
  if (!ip || !bounds || ip.version !== bounds.version || !ipInCidr(address, cidr)) return false;
  return ip.value >= bounds.first && ip.value <= bounds.last;
}

/**
 * Première adresse attribuable qui n'est pas dans `taken` (adresses en forme canonique).
 * Ne parcourt jamais plus de taken.size + 1 candidats : instantané même sur un /64 IPv6.
 * Retourne null si le réseau est plein.
 */
export function nextFreeAddress(cidr: string, taken: ReadonlySet<string>): string | null {
  const bounds = hostBounds(cidr);
  if (!bounds) return null;
  let tried = 0;
  for (let a = bounds.first; a <= bounds.last && tried <= taken.size; a++, tried++) {
    const candidate = formatIp(bounds.version, a);
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** Position de l'adresse dans le réseau (0 = adresse réseau). null si hors réseau ou hors plage de Number. */
export function offsetInCidr(cidr: string, address: string): number | null {
  const c = parseCidr(cidr);
  const ip = parseIp(address);
  if (!c || !ip || ip.version !== c.version || !ipInCidr(address, cidr)) return null;
  const offset = ip.value - networkOf(c);
  return offset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(offset) : null;
}

/** Adresse située à la position `offset` du réseau (0 = adresse réseau). null si hors réseau. */
export function addressAt(cidr: string, offset: number): string | null {
  const c = parseCidr(cidr);
  if (!c || !Number.isInteger(offset) || offset < 0) return null;
  const value = networkOf(c) + BigInt(offset);
  const address = formatIp(c.version, value);
  return ipInCidr(address, cidr) ? address : null;
}
