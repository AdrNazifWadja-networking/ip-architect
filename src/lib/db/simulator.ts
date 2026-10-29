/**
 * Simulateur : « et si… ? » en lecture seule. Aucune de ces fonctions n'écrit dans la base.
 *
 * - split : découper un réseau (existant ou saisi) en sous-réseaux plus petits ; pour un réseau existant, on montre
 *   ce qui serait touché (adresses inventoriées par sous-réseau, plages DHCP à cheval sur deux sous-réseaux).
 * - merge : agréger plusieurs réseaux (résumé de routes, supernet, espace ajouté, réseaux qui gêneraient).
 * - free  : espace libre d'un bloc, et premier emplacement pour un préfixe donné.
 * - fit   : un CIDR peut-il être créé ? avec quoi chevauche-t-il (même VRF = conflit, autre VRF = information).
 */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { cidrContains, cidrOverlap, normalizeCidr, parseCidr, parseIp, splitCidr, bitsOf } from "../ip/cidr";
import { allocateBlocks, blockSize, cidrBlock, freeBlocks, mergeBlocks, summarize, supernet, usableHosts } from "../plan/blocks";
import { ApiError } from "../types";

export const MAX_SPLIT_CHILDREN = 256;
export const MAX_MERGE_INPUTS = 200;

export const SIM_MODES = ["split", "merge", "free", "fit"] as const;
export type SimMode = (typeof SIM_MODES)[number];
export function isSimMode(v: unknown): v is SimMode {
  return typeof v === "string" && (SIM_MODES as readonly string[]).includes(v);
}

interface NetRef {
  id: number;
  cidr: string;
  name: string;
  vrfId: number | null;
  vrfName: string | null;
}

function projectNetworks(db: Db, projectId: number): NetRef[] {
  return (
    db
      .prepare(
        `SELECT n.id, n.cidr, n.name, n.vrf_id, v.name AS vrf_name FROM networks n LEFT JOIN vrfs v ON v.id = n.vrf_id
         WHERE n.project_id = ? ORDER BY n.id`,
      )
      .all(projectId) as { id: number; cidr: string; name: string; vrf_id: number | null; vrf_name: string | null }[]
  ).map((r) => ({ id: r.id, cidr: r.cidr, name: r.name, vrfId: r.vrf_id, vrfName: r.vrf_name }));
}

function cleanCidr(value: unknown): string {
  const c = normalizeCidr(typeof value === "string" ? value : "");
  if (!c) throw new ApiError("invalidCidr", 422);
  return c;
}

function cleanVrf(db: Db, projectId: number, value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (!Number.isInteger(value)) throw new ApiError("simInvalid", 422);
  if (!db.prepare("SELECT 1 FROM vrfs WHERE id = ? AND project_id = ?").get(value, projectId)) throw new ApiError("vrfNotFound", 422);
  return value as number;
}

/* ---------------------------------- split ---------------------------------- */

export interface SplitChild {
  cidr: string;
  /** Adresses inventoriées dans ce sous-réseau (réseau existant seulement). */
  inventoried: number;
  /** Réseaux existants (même VRF) avec lesquels ce sous-réseau chevauche. */
  conflicts: string[];
}

export interface SplitResult {
  cidr: string;
  newPrefix: number;
  /** Nombre total de sous-réseaux (peut dépasser ce qui est listé). */
  count: string;
  usablePerChild: string;
  children: SplitChild[];
  truncated: boolean;
  /** Plages DHCP du réseau qui chevauchent deux sous-réseaux ou plus : à redécouper. */
  spanningScopes: { id: number; name: string; rangeStart: string; rangeEnd: string }[];
  existing: { id: number; name: string } | null;
}

export function simulateSplit(input: { cidr?: unknown; networkId?: unknown; newPrefix?: unknown }, db: Db = getDb()): SplitResult {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  let cidr: string;
  let existing: NetRef | null = null;
  if (input.networkId !== undefined && input.networkId !== null && input.networkId !== "") {
    if (!Number.isInteger(input.networkId)) throw new ApiError("simInvalid", 422);
    existing = projectNetworks(db, project.id).find((n) => n.id === input.networkId) ?? null;
    if (!existing) throw new ApiError("networkNotFound", 404);
    cidr = existing.cidr;
  } else cidr = cleanCidr(input.cidr);

  const parent = parseCidr(cidr)!;
  const bits = bitsOf(parent.version);
  const newPrefix = input.newPrefix;
  if (!Number.isInteger(newPrefix) || (newPrefix as number) <= parent.prefix || (newPrefix as number) > bits) throw new ApiError("simInvalid", 422);
  const np = newPrefix as number;

  const all = splitCidr(cidr, np, MAX_SPLIT_CHILDREN)!;
  const count = 1n << BigInt(np - parent.prefix);
  const others = projectNetworks(db, project.id).filter((n) => !existing || n.id !== existing.id);
  const vrfId = existing ? existing.vrfId : null;

  const addrRows = existing
    ? (db.prepare("SELECT address FROM ip_addresses WHERE network_id = ?").all(existing.id) as { address: string }[])
    : [];
  const addrValues = addrRows.map((r) => parseIp(r.address)?.value).filter((v): v is bigint => v !== undefined);

  const children: SplitChild[] = all.map((c) => {
    const b = cidrBlock(c)!;
    return {
      cidr: c,
      inventoried: addrValues.filter((v) => v >= b.start && v <= b.end).length,
      conflicts: others.filter((n) => n.vrfId === vrfId && cidrOverlap(n.cidr, c)).map((n) => n.cidr),
    };
  });

  const spanningScopes: SplitResult["spanningScopes"] = [];
  if (existing && parent.version === 4) {
    const scopes = db
      .prepare("SELECT id, name, range_start, range_end FROM dhcp_scopes WHERE network_id = ? ORDER BY id")
      .all(existing.id) as { id: number; name: string; range_start: string; range_end: string }[];
    const size = 1n << BigInt(bits - np);
    const base = cidrBlock(cidr)!.start;
    for (const s of scopes) {
      const lo = parseIp(s.range_start)?.value;
      const hi = parseIp(s.range_end)?.value;
      if (lo === undefined || hi === undefined) continue;
      if ((lo - base) / size !== (hi - base) / size) {
        spanningScopes.push({ id: s.id, name: s.name, rangeStart: s.range_start, rangeEnd: s.range_end });
      }
    }
  }

  return {
    cidr,
    newPrefix: np,
    count: count.toString(),
    usablePerChild: usableHosts(parent.version, np).toString(),
    children,
    truncated: count > BigInt(MAX_SPLIT_CHILDREN),
    spanningScopes,
    existing: existing ? { id: existing.id, name: existing.name } : null,
  };
}

/* ---------------------------------- merge ---------------------------------- */

export interface MergeResult {
  inputs: string[];
  /** Résumé exact : plus petite liste de CIDR couvrant exactement les entrées. */
  summary: string[];
  /** Plus petit CIDR unique qui les contient toutes (null si versions mélangées). */
  supernet: string | null;
  /** true si les entrées forment exactement un seul bloc (aucun espace en trop). */
  exact: boolean;
  /** Adresses du supernet qui n'appartiennent à aucune entrée (texte : peut être très grand en IPv6). */
  extraAddresses: string | null;
  /** Réseaux existants situés dans le supernet mais qui ne font pas partie des entrées. */
  intruders: { id: number; cidr: string; name: string; vrfName: string | null }[];
}

export function simulateMerge(input: { cidrs?: unknown; networkIds?: unknown }, db: Db = getDb()): MergeResult {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const nets = projectNetworks(db, project.id);
  const list: string[] = [];
  if (input.networkIds !== undefined && input.networkIds !== null) {
    if (!Array.isArray(input.networkIds)) throw new ApiError("simInvalid", 422);
    for (const id of input.networkIds) {
      const n = nets.find((x) => x.id === id);
      if (!n) throw new ApiError("networkNotFound", 404);
      list.push(n.cidr);
    }
  }
  if (input.cidrs !== undefined && input.cidrs !== null) {
    if (!Array.isArray(input.cidrs)) throw new ApiError("simInvalid", 422);
    for (const c of input.cidrs) list.push(cleanCidr(c));
  }
  if (list.length === 0) throw new ApiError("simInvalid", 422);
  if (list.length > MAX_MERGE_INPUTS) throw new ApiError("simTooMany", 422, { max: MAX_MERGE_INPUTS });

  const inputs = [...new Set(list)];
  const sup = supernet(inputs);
  const summary = summarize(inputs);
  let extra: string | null = null;
  let intruders: MergeResult["intruders"] = [];
  if (sup) {
    const sb = cidrBlock(sup)!;
    const covered = mergeBlocks(inputs.map((c) => cidrBlock(c)!).map((b) => ({ version: b.version, start: b.start, end: b.end })));
    const coveredSize = covered.reduce((a, b) => a + blockSize(b), 0n);
    extra = (blockSize(sb) - coveredSize).toString();
    intruders = nets
      .filter((n) => cidrOverlap(n.cidr, sup) && !inputs.some((i) => cidrOverlap(n.cidr, i)))
      .map((n) => ({ id: n.id, cidr: n.cidr, name: n.name, vrfName: n.vrfName }));
  }
  return { inputs, summary, supernet: sup, exact: summary.length === 1 && extra === "0", extraAddresses: extra, intruders };
}

/* ----------------------------------- free ----------------------------------- */

export interface FreeResult {
  parent: string;
  vrfId: number | null;
  /** Réseaux existants qui occupent le bloc. */
  taken: string[];
  blocks: { cidr: string; addresses: string }[];
  freeAddresses: string;
  totalAddresses: string;
  /** Premier emplacement libre pour le préfixe demandé (null = aucun, ou pas de préfixe demandé). */
  firstFit: string | null;
  prefix: number | null;
}

export function simulateFree(input: { parent?: unknown; vrfId?: unknown; prefix?: unknown }, db: Db = getDb()): FreeResult {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const parent = cleanCidr(input.parent);
  const vrfId = cleanVrf(db, project.id, input.vrfId);
  const p = parseCidr(parent)!;
  const taken = projectNetworks(db, project.id)
    .filter((n) => n.vrfId === vrfId && parseCidr(n.cidr)!.version === p.version && cidrOverlap(n.cidr, parent))
    .map((n) => n.cidr);
  const blocks = freeBlocks(parent, taken);
  const sizeOf = (c: string) => 1n << BigInt(bitsOf(p.version) - parseCidr(c)!.prefix);
  const freeTotal = blocks.reduce((a, c) => a + sizeOf(c), 0n);

  let prefix: number | null = null;
  let firstFit: string | null = null;
  if (input.prefix !== undefined && input.prefix !== null && input.prefix !== "") {
    if (!Number.isInteger(input.prefix) || (input.prefix as number) < p.prefix || (input.prefix as number) > bitsOf(p.version)) {
      throw new ApiError("simInvalid", 422);
    }
    prefix = input.prefix as number;
    firstFit = allocateBlocks(parent, taken, [{ key: 0, prefix }])[0].cidr;
  }
  return {
    parent,
    vrfId,
    taken,
    blocks: blocks.map((c) => ({ cidr: c, addresses: sizeOf(c).toString() })),
    freeAddresses: freeTotal.toString(),
    totalAddresses: (1n << BigInt(bitsOf(p.version) - p.prefix)).toString(),
    firstFit,
    prefix,
  };
}

/* ------------------------------------ fit ------------------------------------ */

export interface FitResult {
  cidr: string;
  vrfId: number | null;
  /** true = on peut le créer dans cette VRF (aucun chevauchement dans la même VRF). */
  canCreate: boolean;
  /** Chevauchements dans la même VRF : bloquants. */
  conflicts: { id: number; cidr: string; name: string; relation: "same" | "contains" | "inside" | "partial" }[];
  /** Chevauchements dans d'autres VRF : sans conséquence, mais à connaître. */
  otherVrf: { id: number; cidr: string; name: string; vrfName: string | null }[];
  /** Premier bloc libre de même taille dans le plus petit réseau existant qui le contient (aide à choisir). */
  suggestion: string | null;
}

export function simulateFit(input: { cidr?: unknown; vrfId?: unknown }, db: Db = getDb()): FitResult {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const project = getActiveProject(db);
  const cidr = cleanCidr(input.cidr);
  const vrfId = cleanVrf(db, project.id, input.vrfId);
  const me = parseCidr(cidr)!;
  const nets = projectNetworks(db, project.id).filter((n) => parseCidr(n.cidr)!.version === me.version && cidrOverlap(n.cidr, cidr));

  const relation = (n: NetRef): "same" | "contains" | "inside" | "partial" =>
    n.cidr === cidr ? "same" : cidrContains(n.cidr, cidr) ? "contains" : cidrContains(cidr, n.cidr) ? "inside" : "partial";
  const sameVrf = nets.filter((n) => n.vrfId === vrfId);
  const conflicts = sameVrf.map((n) => ({ id: n.id, cidr: n.cidr, name: n.name, relation: relation(n) }));
  const otherVrf = nets.filter((n) => n.vrfId !== vrfId).map((n) => ({ id: n.id, cidr: n.cidr, name: n.name, vrfName: n.vrfName }));

  // suggestion : un bloc libre de même taille juste à côté, dans l'espace d'adressage de la VRF choisie
  let suggestion: string | null = null;
  if (conflicts.length > 0) {
    const sameAll = projectNetworks(db, project.id).filter((n) => n.vrfId === vrfId && parseCidr(n.cidr)!.version === me.version).map((n) => n.cidr);
    const around = supernet([cidr, ...conflicts.map((c) => c.cidr)]);
    const roomy = around && parseCidr(around)!.prefix < me.prefix ? around : null;
    if (roomy) suggestion = allocateBlocks(roomy, sameAll, [{ key: 0, prefix: me.prefix }])[0].cidr;
  }
  return { cidr, vrfId, canCreate: conflicts.length === 0, conflicts, otherVrf, suggestion };
}

export function simulate(mode: SimMode, input: unknown, db: Db = getDb()) {
  const body = (input ?? {}) as Record<string, unknown>;
  switch (mode) {
    case "split":
      return simulateSplit(body, db);
    case "merge":
      return simulateMerge(body, db);
    case "free":
      return simulateFree(body, db);
    case "fit":
      return simulateFit(body, db);
  }
}
