/**
 * Arbre des préfixes : regroupe des réseaux sous des blocs d'agrégation (IPv4 : /8 puis /16 ; IPv6 : /32 puis /48).
 * Module pur, sans base de données. Les réseaux d'une même VRF ne se chevauchent pas, il n'y a donc jamais de
 * réseau « dans » un autre : l'arbre sert à voir où l'espace d'adressage est consommé, bloc par bloc.
 */
import { bitsOf, formatIp, networkOf, parseCidr, type ParsedCidr } from "./cidr";

export const TREE_LEVELS: Record<4 | 6, readonly number[]> = { 4: [8, 16], 6: [32, 48] };

export interface TreeInput {
  id: number;
  cidr: string;
  name: string;
  version: 4 | 6;
  status: string;
  usedIps: number;
  capacity: number;
  tags: { id: number; name: string; color: string }[];
}

export interface TreeNode {
  key: string;
  cidr: string;
  kind: "block" | "network";
  version: 4 | 6;
  prefix: number;
  /** Réseau : son identifiant, son nom, son statut. */
  networkId?: number;
  name?: string;
  status?: string;
  tags: { id: number; name: string; color: string }[];
  /** Nombre de réseaux dans ce nœud (1 pour un réseau). */
  networkCount: number;
  /** Adresses utilisées et capacité cumulées (IPv4 seulement ; 0 en IPv6). */
  used: number;
  capacity: number;
  usagePct: number;
  /** Part de l'espace d'adressage du bloc couverte par des réseaux (0-100, deux décimales). */
  allocatedPct: number;
  children: TreeNode[];
}

const sizeOf = (c: ParsedCidr): bigint => 1n << BigInt(bitsOf(c.version) - c.prefix);

function blockKey(c: ParsedCidr, level: number): { key: string; parsed: ParsedCidr } {
  const shift = BigInt(bitsOf(c.version) - level);
  const value = (networkOf(c) >> shift) << shift;
  return { key: `${formatIp(c.version, value)}/${level}`, parsed: { version: c.version, value, prefix: level } };
}

const pct = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 10000n) / whole) / 100);

export function buildTree(networks: TreeInput[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const blocks = new Map<string, TreeNode>();
  const covered = new Map<string, bigint>(); // espace couvert par bloc (clé) avant calcul des pourcentages
  const sizes = new Map<string, bigint>();

  const sorted = networks
    .map((n) => ({ n, c: parseCidr(n.cidr) }))
    .filter((x): x is { n: TreeInput; c: ParsedCidr } => x.c !== null)
    .sort((a, b) => {
      if (a.c.version !== b.c.version) return a.c.version - b.c.version;
      const x = networkOf(a.c), y = networkOf(b.c);
      return x < y ? -1 : x > y ? 1 : a.c.prefix - b.c.prefix;
    });

  for (const { n, c } of sorted) {
    const leaf: TreeNode = {
      key: `net:${n.id}`,
      cidr: n.cidr,
      kind: "network",
      version: c.version,
      prefix: c.prefix,
      networkId: n.id,
      name: n.name,
      status: n.status,
      tags: n.tags,
      networkCount: 1,
      used: c.version === 4 ? n.usedIps : 0,
      capacity: c.version === 4 ? n.capacity : 0,
      usagePct: c.version === 4 && n.capacity > 0 ? Math.min(100, (n.usedIps / n.capacity) * 100) : 0,
      allocatedPct: 100,
      children: [],
    };

    let parent: TreeNode | null = null;
    for (const level of TREE_LEVELS[c.version].filter((l) => l < c.prefix)) {
      const { key, parsed } = blockKey(c, level);
      let block = blocks.get(key);
      if (!block) {
        block = {
          key,
          cidr: key,
          kind: "block",
          version: c.version,
          prefix: level,
          tags: [],
          networkCount: 0,
          used: 0,
          capacity: 0,
          usagePct: 0,
          allocatedPct: 0,
          children: [],
        };
        blocks.set(key, block);
        sizes.set(key, sizeOf(parsed));
        (parent ? parent.children : roots).push(block);
      }
      block.networkCount += 1;
      block.used += leaf.used;
      block.capacity += leaf.capacity;
      covered.set(key, (covered.get(key) ?? 0n) + sizeOf(c));
      parent = block;
    }
    (parent ? parent.children : roots).push(leaf);
  }

  for (const [key, block] of blocks) {
    block.allocatedPct = pct(covered.get(key) ?? 0n, sizes.get(key) ?? 1n);
    block.usagePct = block.capacity > 0 ? Math.min(100, (block.used / block.capacity) * 100) : 0;
  }
  return roots;
}
