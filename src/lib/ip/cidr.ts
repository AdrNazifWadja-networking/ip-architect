/**
 * Moteur de calcul IP (IPv4 + IPv6) sans dépendance, basé sur BigInt.
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  value: bigint;
}

export interface ParsedCidr extends ParsedIp {
  prefix: number;
}

export interface SubnetInfo {
  version: IpVersion;
  cidr: string; // forme canonique (adresse réseau / préfixe)
  prefix: number;
  address: string; // adresse saisie
  network: string;
  broadcast: string | null; // null en IPv6
  netmask: string;
  wildcard: string | null; // null en IPv6
  firstHost: string;
  lastHost: string;
  total: bigint; // nombre total d'adresses
  usable: bigint; // adresses utilisables pour des hôtes
}

const MAX_V4 = (1n << 32n) - 1n;
const MAX_V6 = (1n << 128n) - 1n;

export function bitsOf(version: IpVersion): number {
  return version === 4 ? 32 : 128;
}

/* ------------------------------ Parsing ------------------------------ */

export function parseIPv4(input: string): bigint | null {
  const parts = input.trim().split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    // refuse les zéros non significatifs ambigus (ex: 01)
    if (p.length > 1 && p.startsWith("0")) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

export function parseIPv6(input: string): bigint | null {
  let s = input.trim().toLowerCase();
  if (!s || s.includes("%")) return null;

  // IPv4 incorporée en fin d'adresse (ex: ::ffff:192.0.2.1)
  let tail: bigint[] = [];
  if (s.includes(".")) {
    const idx = s.lastIndexOf(":");
    const v4 = parseIPv4(s.slice(idx + 1));
    if (v4 === null) return null;
    tail = [(v4 >> 16n) & 0xffffn, v4 & 0xffffn];
    s = s.slice(0, idx + 1) + "0:0"; // placeholder de 2 groupes
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): string[] | null => {
    if (part === "") return [];
    const g = part.split(":");
    return g.every((x) => /^[0-9a-f]{1,4}$/.test(x)) ? g : null;
  };

  const head = toGroups(halves[0]);
  if (head === null) return null;

  let groups: string[];
  if (halves.length === 2) {
    const rest = toGroups(halves[1]);
    if (rest === null) return null;
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(parseInt(g, 16));

  if (tail.length) {
    value = (value & ~0xffffffffn) | (tail[0] << 16n) | tail[1];
  }
  return value;
}

export function parseIp(input: string): ParsedIp | null {
  const s = input.trim();
  if (s.includes(":")) {
    const v = parseIPv6(s);
    return v === null ? null : { version: 6, value: v };
  }
  const v = parseIPv4(s);
  return v === null ? null : { version: 4, value: v };
}

export function parseCidr(input: string): ParsedCidr | null {
  const [addr, pfx, ...extra] = input.trim().split("/");
  if (extra.length || pfx === undefined || !/^\d{1,3}$/.test(pfx)) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const prefix = Number(pfx);
  if (prefix < 0 || prefix > bitsOf(ip.version)) return null;
  return { ...ip, prefix };
}

/* ----------------------------- Formatting ---------------------------- */

export function formatIPv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => Number((value >> s) & 255n)).join(".");
}

export function formatIPv6(value: bigint): string {
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));

  // plus longue séquence de zéros (>= 2 groupes) pour la compression "::"
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

export function formatIp(version: IpVersion, value: bigint): string {
  return version === 4 ? formatIPv4(value) : formatIPv6(value);
}

/* ------------------------------ Calculs ------------------------------ */

function maskFor(version: IpVersion, prefix: number): bigint {
  const bits = bitsOf(version);
  const full = version === 4 ? MAX_V4 : MAX_V6;
  const hostBits = BigInt(bits - prefix);
  return full ^ ((1n << hostBits) - 1n);
}

export function networkOf(c: ParsedCidr): bigint {
  return c.value & maskFor(c.version, c.prefix);
}

export function lastOf(c: ParsedCidr): bigint {
  const hostBits = BigInt(bitsOf(c.version) - c.prefix);
  return networkOf(c) | ((1n << hostBits) - 1n);
}

/** Forme canonique "réseau/préfixe" (ex: 10.0.0.5/24 -> 10.0.0.0/24). */
export function normalizeCidr(input: string): string | null {
  const c = parseCidr(input);
  if (!c) return null;
  return `${formatIp(c.version, networkOf(c))}/${c.prefix}`;
}

export function calcSubnet(input: string): SubnetInfo | null {
  const c = parseCidr(input);
  if (!c) return null;

  const { version, prefix } = c;
  const bits = bitsOf(version);
  const hostBits = bits - prefix;
  const mask = maskFor(version, prefix);
  const network = networkOf(c);
  const last = lastOf(c);
  const total = 1n << BigInt(hostBits);

  let firstHost = network;
  let lastHost = last;
  let usable = total;

  if (version === 4) {
    if (prefix <= 30) {
      firstHost = network + 1n;
      lastHost = last - 1n;
      usable = total - 2n;
    } else if (prefix === 31) {
      usable = 2n; // RFC 3021 : lien point à point
    } else {
      usable = 1n; // /32 : hôte unique
    }
  }

  return {
    version,
    cidr: `${formatIp(version, network)}/${prefix}`,
    prefix,
    address: formatIp(version, c.value),
    network: formatIp(version, network),
    broadcast: version === 4 ? formatIPv4(last) : null,
    netmask: version === 4 ? formatIPv4(mask) : formatIPv6(mask),
    wildcard: version === 4 ? formatIPv4(mask ^ MAX_V4) : null,
    firstHost: formatIp(version, firstHost),
    lastHost: formatIp(version, lastHost),
    total,
    usable,
  };
}

/** `inner` est-il entièrement contenu dans `outer` ? */
export function cidrContains(outer: string, inner: string): boolean {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (!a || !b || a.version !== b.version || b.prefix < a.prefix) return false;
  return networkOf(a) <= networkOf(b) && lastOf(b) <= lastOf(a);
}

/** Deux plages se chevauchent-elles ? */
export function cidrOverlap(x: string, y: string): boolean {
  const a = parseCidr(x);
  const b = parseCidr(y);
  if (!a || !b || a.version !== b.version) return false;
  return networkOf(a) <= lastOf(b) && networkOf(b) <= lastOf(a);
}

/** Une adresse appartient-elle à un CIDR ? */
export function ipInCidr(ip: string, cidr: string): boolean {
  const a = parseIp(ip);
  const c = parseCidr(cidr);
  if (!a || !c || a.version !== c.version) return false;
  return a.value >= networkOf(c) && a.value <= lastOf(c);
}

/**
 * Découpe un CIDR en sous-réseaux de préfixe `newPrefix`.
 * `limit` protège contre les explosions combinatoires (ex: /48 -> /128).
 */
export function splitCidr(input: string, newPrefix: number, limit = 256): string[] | null {
  const c = parseCidr(input);
  if (!c || newPrefix < c.prefix || newPrefix > bitsOf(c.version)) return null;

  const count = 1n << BigInt(newPrefix - c.prefix);
  const step = 1n << BigInt(bitsOf(c.version) - newPrefix);
  const start = networkOf(c);
  const n = count > BigInt(limit) ? limit : Number(count);

  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${formatIp(c.version, start + step * BigInt(i))}/${newPrefix}`);
  }
  return out;
}
