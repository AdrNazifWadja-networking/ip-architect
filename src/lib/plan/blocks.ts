/**
 * Calcul sur des blocs d'adresses (IPv4 et IPv6, BigInt) : résumé de routes, supernet, espace libre, allocation VLSM.
 * Fonctions pures, sans base de données : partagées par la Planification, le Simulateur et le navigateur.
 *
 * Une plage est une paire [start, end] inclusive ; un CIDR est toujours aligné sur sa taille.
 */
import { bitsOf, formatIp, lastOf, networkOf, parseCidr, type IpVersion } from "../ip/cidr";

export interface Block {
  version: IpVersion;
  start: bigint;
  end: bigint;
}

/** Plage couverte par un CIDR (les bits d'hôte éventuels sont ignorés). */
export function cidrBlock(cidr: string): (Block & { prefix: number }) | null {
  const c = parseCidr(cidr);
  if (!c) return null;
  return { version: c.version, start: networkOf(c), end: lastOf(c), prefix: c.prefix };
}

export function blockSize(b: Block): bigint {
  return b.end - b.start + 1n;
}

/** Nombre de zéros de poids faible de v (v > 0), borné à `max`. */
function trailingZeros(v: bigint, max: number): number {
  if (v === 0n) return max;
  let n = 0;
  while (n < max && ((v >> BigInt(n)) & 1n) === 0n) n++;
  return n;
}

/** Plus petit ensemble de CIDR couvrant exactement [start, end]. */
export function rangeToCidrs(version: IpVersion, start: bigint, end: bigint): string[] {
  const bits = bitsOf(version);
  const out: string[] = [];
  let s = start;
  while (s <= end) {
    const remaining = end - s + 1n;
    const align = trailingZeros(s, bits);
    let fit = 0;
    while (fit < bits && 1n << BigInt(fit + 1) <= remaining) fit++;
    const n = Math.min(align, fit);
    out.push(`${formatIp(version, s)}/${bits - n}`);
    s += 1n << BigInt(n);
  }
  return out;
}

/** Fusionne les plages qui se chevauchent ou se touchent (une version à la fois). */
export function mergeBlocks(blocks: Block[]): Block[] {
  const sorted = [...blocks].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: Block[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start <= last.end + 1n) {
      if (b.end > last.end) last.end = b.end;
    } else out.push({ ...b });
  }
  return out;
}

function toBlocks(cidrs: string[], version: IpVersion): Block[] {
  const out: Block[] = [];
  for (const c of cidrs) {
    const b = cidrBlock(c);
    if (b && b.version === version) out.push({ version, start: b.start, end: b.end });
  }
  return out;
}

/** Résumé de routes : la plus petite liste de CIDR couvrant exactement les entrées (IPv4 puis IPv6). */
export function summarize(cidrs: string[]): string[] {
  const out: string[] = [];
  for (const v of [4, 6] as const) {
    for (const b of mergeBlocks(toBlocks(cidrs, v))) out.push(...rangeToCidrs(v, b.start, b.end));
  }
  return out;
}

/** Plus petit CIDR unique contenant toutes les entrées (même version). null si vide ou versions mélangées. */
export function supernet(cidrs: string[]): string | null {
  const blocks = cidrs.map(cidrBlock);
  if (blocks.length === 0 || blocks.some((b) => b === null)) return null;
  const list = blocks as (Block & { prefix: number })[];
  const version = list[0].version;
  if (list.some((b) => b.version !== version)) return null;
  const bits = bitsOf(version);
  const lo = list.reduce((m, b) => (b.start < m ? b.start : m), list[0].start);
  const hi = list.reduce((m, b) => (b.end > m ? b.end : m), list[0].end);
  // plus long préfixe commun entre lo et hi
  let prefix = bits;
  const diff = lo ^ hi;
  let n = 0;
  while (n < bits && diff >> BigInt(n) !== 0n) n++;
  prefix = bits - n;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return `${formatIp(version, lo & mask)}/${prefix}`;
}

/** Espace libre d'un bloc parent une fois retirées les plages occupées, en plus petite liste de CIDR. */
export function freeBlocks(parent: string, taken: string[]): string[] {
  const p = cidrBlock(parent);
  if (!p) return [];
  const used = mergeBlocks(
    toBlocks(taken, p.version)
      .filter((b) => b.start <= p.end && b.end >= p.start)
      .map((b) => ({ ...b, start: b.start < p.start ? p.start : b.start, end: b.end > p.end ? p.end : b.end })),
  );
  const out: string[] = [];
  let cursor = p.start;
  for (const u of used) {
    if (u.start > cursor) out.push(...rangeToCidrs(p.version, cursor, u.start - 1n));
    cursor = u.end + 1n;
  }
  if (cursor <= p.end) out.push(...rangeToCidrs(p.version, cursor, p.end));
  return out;
}

/** Adresses utilisables pour des hôtes dans un préfixe (IPv4 : réseau et diffusion exclus, sauf /31 et /32). */
export function usableHosts(version: IpVersion, prefix: number): bigint {
  const total = 1n << BigInt(bitsOf(version) - prefix);
  if (version === 6) return total;
  if (prefix <= 30) return total - 2n;
  return prefix === 31 ? 2n : 1n;
}

/**
 * Préfixe IPv4 le plus long (bloc le plus petit) offrant au moins `hosts` adresses utilisables.
 * Le plus petit bloc proposé est un /30 (2 hôtes) : pour un /31 ou un /32, indiquez le préfixe directement.
 * null si hosts n'est pas un entier ≥ 1 ou dépasse un /0.
 */
export function prefixForHosts(hosts: number): number | null {
  if (!Number.isInteger(hosts) || hosts < 1) return null;
  for (let p = 30; p >= 0; p--) {
    if (usableHosts(4, p) >= BigInt(hosts)) return p;
  }
  return null;
}

export interface BlockRequest {
  key: number | string;
  prefix: number;
}

export type AllocationReason = "noSpace" | "tooBig";

export interface BlockAllocation {
  key: number | string;
  cidr: string | null;
  reason: AllocationReason | null;
}

/**
 * Allocation VLSM : les plus gros blocs d'abord (c'est ce qui limite la fragmentation), chacun au premier emplacement
 * libre aligné du parent. `taken` = réseaux déjà existants. Résultat dans l'ordre d'entrée.
 */
export function allocateBlocks(parent: string, taken: string[], requests: BlockRequest[]): BlockAllocation[] {
  const p = cidrBlock(parent);
  const results = new Map<number, BlockAllocation>();
  if (!p) return requests.map((r) => ({ key: r.key, cidr: null, reason: "noSpace" as const }));
  const bits = bitsOf(p.version);
  const used: Block[] = mergeBlocks(
    toBlocks(taken, p.version).filter((b) => b.start <= p.end && b.end >= p.start),
  );

  const order = requests.map((r, i) => i).sort((a, b) => requests[a].prefix - requests[b].prefix || a - b);
  for (const idx of order) {
    const r = requests[idx];
    if (!Number.isInteger(r.prefix) || r.prefix < p.prefix || r.prefix > bits) {
      results.set(idx, { key: r.key, cidr: null, reason: "tooBig" });
      continue;
    }
    const size = 1n << BigInt(bits - r.prefix);
    let cursor = p.start;
    let found: bigint | null = null;
    // parcourt les trous entre plages occupées (triées, sans chevauchement)
    for (let i = 0; i <= used.length && found === null; i++) {
      const gapEnd = i < used.length ? used[i].start - 1n : p.end;
      const aligned = ((cursor + size - 1n) / size) * size;
      if (aligned + size - 1n <= gapEnd && aligned >= cursor) found = aligned;
      else if (i < used.length) cursor = used[i].end + 1n > cursor ? used[i].end + 1n : cursor;
    }
    if (found === null) {
      results.set(idx, { key: r.key, cidr: null, reason: "noSpace" });
      continue;
    }
    results.set(idx, { key: r.key, cidr: `${formatIp(p.version, found)}/${r.prefix}`, reason: null });
    used.push({ version: p.version, start: found, end: found + size - 1n });
    used.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
  return requests.map((_, i) => results.get(i)!);
}
