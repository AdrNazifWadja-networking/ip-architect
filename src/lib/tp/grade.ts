/**
 * Moteur de correction du mode TP : fonctions pures, sans base de données ni horloge. Les bonnes réponses viennent du même
 * moteur de calcul que le reste de l'application (calcSubnet, allocateBlocks), jamais d'une table écrite à la main.
 */
import { calcSubnet, cidrContains, cidrOverlap, formatIp, normalizeCidr, parseCidr, parseIp } from "../ip/cidr";
import { allocateBlocks, prefixForHosts, usableHosts } from "../plan/blocks";
import {
  DEFAULT_SUBNET_FIELDS,
  SUBNET_FIELDS,
  TP_ANSWER_MAX,
  TP_MAX_HOSTS,
  TP_MAX_NEEDS,
  TP_MAX_QUESTIONS,
  TP_NEED_NAME_MAX,
  type GradeCode,
  type GradeItem,
  type GradeResult,
  type SubnetAnswers,
  type SubnetConfig,
  type SubnetField,
  type SubnetQuestion,
  type VlsmAnswers,
  type VlsmConfig,
} from "./types";

/* ------------------------------ Configuration ------------------------------ */

export type ConfigCheck<T> = { ok: true; config: T } | { ok: false; code: "tpParentInvalid" | "tpNeedsInvalid" | "tpUnsolvable" | "tpSubnetConfigInvalid" };

const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim();

/** Valide un exercice VLSM : bloc IPv4 (adresse réseau, /30 au plus), 1 à 12 besoins, et surtout que tout tienne dans le bloc. */
export function checkVlsmConfig(raw: unknown): ConfigCheck<VlsmConfig> {
  const r = raw as { parent?: unknown; needs?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.parent !== "string") return { ok: false, code: "tpParentInvalid" };
  const parsed = parseCidr(r.parent.trim());
  if (!parsed || parsed.version !== 4 || parsed.prefix > 30 || normalizeCidr(r.parent.trim()) !== r.parent.trim()) return { ok: false, code: "tpParentInvalid" };
  if (!Array.isArray(r.needs) || r.needs.length < 1 || r.needs.length > TP_MAX_NEEDS) return { ok: false, code: "tpNeedsInvalid" };
  const needs: VlsmConfig["needs"] = [];
  for (const n of r.needs as { name?: unknown; hosts?: unknown }[]) {
    if (!n || typeof n !== "object" || typeof n.name !== "string") return { ok: false, code: "tpNeedsInvalid" };
    const name = cleanName(n.name);
    const hosts = n.hosts;
    if (!name || name.length > TP_NEED_NAME_MAX || typeof hosts !== "number" || !Number.isInteger(hosts) || hosts < 1 || hosts > TP_MAX_HOSTS) return { ok: false, code: "tpNeedsInvalid" };
    needs.push({ name, hosts });
  }
  if (new Set(needs.map((n) => n.name.toLowerCase())).size !== needs.length) return { ok: false, code: "tpNeedsInvalid" };
  const config: VlsmConfig = { parent: r.parent.trim(), needs };
  if (vlsmSolution(config).some((c) => c === null)) return { ok: false, code: "tpUnsolvable" };
  return { ok: true, config };
}

export function checkSubnetConfig(raw: unknown): ConfigCheck<SubnetConfig> {
  const r = raw as { count?: unknown; fields?: unknown } | null;
  if (!r || typeof r !== "object") return { ok: false, code: "tpSubnetConfigInvalid" };
  const count = r.count === undefined ? 5 : r.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > TP_MAX_QUESTIONS) return { ok: false, code: "tpSubnetConfigInvalid" };
  const fields = r.fields === undefined ? DEFAULT_SUBNET_FIELDS : r.fields;
  if (!Array.isArray(fields) || fields.length < 1 || !fields.every((f) => typeof f === "string" && (SUBNET_FIELDS as readonly string[]).includes(f)) || new Set(fields).size !== fields.length) {
    return { ok: false, code: "tpSubnetConfigInvalid" };
  }
  // ordre canonique : l'affichage et la note ne dépendent pas de l'ordre de saisie
  return { ok: true, config: { count, fields: SUBNET_FIELDS.filter((f) => (fields as string[]).includes(f)) } };
}

/* ------------------------------ VLSM ------------------------------ */

/** Solution de référence : un CIDR par besoin (même ordre), null si un besoin ne tient pas. */
export function vlsmSolution(config: VlsmConfig): (string | null)[] {
  const reqs = config.needs.map((n, i) => ({ key: String(i), prefix: prefixForHosts(n.hosts) ?? 99 }));
  return allocateBlocks(config.parent, [], reqs).map((a) => a.cidr);
}

const POINTS_OVERSIZED = 0.5;

/** Note un exercice VLSM : chaque besoin vaut 100/n points. */
export function gradeVlsm(config: VlsmConfig, answers: VlsmAnswers, withExpected = true): GradeResult {
  const n = config.needs.length;
  const per = 100 / n;
  const solution = vlsmSolution(config);
  const given = config.needs.map((_, i) => (typeof answers[String(i)] === "string" ? answers[String(i)].trim() : ""));
  // réponses valides (réseau correct) : servent à détecter les chevauchements entre étudiants-réponses
  const valid = given.map((g) => (g && parseCidr(g) && parseCidr(g)!.version === 4 && normalizeCidr(g) === g ? g : null));
  const items: GradeItem[] = config.needs.map((need, i) => {
    const base = { key: String(i), label: need.name, max: per, ...(withExpected && solution[i] ? { expected: solution[i]! } : {}) };
    const fail = (code: GradeCode, extra: Partial<GradeItem> = {}): GradeItem => ({ ...base, points: 0, code, ...extra });
    const g = given[i];
    if (!g) return fail("missing");
    const p = parseCidr(g);
    if (!p || p.version !== 4) return fail("invalid");
    if (!valid[i]) return fail("notNetwork");
    if (!cidrContains(config.parent, g)) return fail("outside");
    if (valid.some((o, j) => j !== i && o !== null && cidrOverlap(g, o))) return fail("overlap");
    if (usableHosts(4, p.prefix) < BigInt(need.hosts)) return fail("tooSmall");
    const best = prefixForHosts(need.hosts)!;
    if (p.prefix < best) return { ...base, points: per * POINTS_OVERSIZED, code: "oversized", params: { got: p.prefix, best } };
    return { ...base, points: per, code: "ok" };
  });
  return { score: Math.round(items.reduce((a, it) => a + it.points, 0)), items };
}

/* ------------------------------ Sous-réseaux ------------------------------ */

/** Générateur pseudo-aléatoire déterministe (FNV-1a pour la graine, mulberry32 pour le flux). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Questions propres à un étudiant : la même graine donne toujours les mêmes questions (les tentatives successives portent
 * donc sur les mêmes calculs), deux étudiants n'ont pas les mêmes. Préfixes de /20 à /30, adresses privées (RFC 1918).
 */
export function generateSubnetQuestions(seed: string, count: number): SubnetQuestion[] {
  const rand = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const out: SubnetQuestion[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (out.length < count && guard++ < 500) {
    const prefix = int(20, 30);
    const pool = int(0, 2);
    const base = pool === 0 ? [10, int(0, 255), int(0, 255)] : pool === 1 ? [172, int(16, 31), int(0, 255)] : [192, 168, int(0, 255)];
    const value = (BigInt(base[0]) << 24n) | (BigInt(base[1]) << 16n) | (BigInt(base[2]) << 8n) | BigInt(int(0, 255));
    const size = 1n << BigInt(32 - prefix);
    const net = value - (value % size);
    // une adresse d'hôte du sous-réseau (ni l'adresse réseau ni le broadcast)
    const host = net + 1n + BigInt(Math.floor(rand() * Number(size - 2n)));
    const cidr = `${formatIp(4, host)}/${prefix}`;
    if (seen.has(normalizeCidr(cidr) ?? cidr)) continue;
    seen.add(normalizeCidr(cidr) ?? cidr);
    out.push({ key: `q${out.length + 1}`, cidr });
  }
  return out;
}

export function solveSubnet(cidr: string): Record<SubnetField, string> | null {
  const s = calcSubnet(cidr);
  if (!s || s.version !== 4 || s.broadcast === null) return null;
  return { network: s.network, broadcast: s.broadcast, firstHost: s.firstHost, lastHost: s.lastHost, hosts: String(s.usable), mask: s.netmask };
}

/** Masque saisi en « 255.255.255.224 », « /27 » ou « 27 » -> forme pointée, ou null. */
function normalizeMask(input: string): string | null {
  const m = /^\/?(\d{1,2})$/.exec(input);
  if (m) {
    const n = Number(m[1]);
    return n <= 32 ? (calcSubnet(`0.0.0.0/${n}`)?.netmask ?? null) : null;
  }
  const ip = parseIp(input);
  return ip && ip.version === 4 ? formatIp(4, ip.value) : null;
}

function sameAnswer(field: SubnetField, given: string, expected: string): boolean {
  const g = given.trim();
  if (!g) return false;
  if (field === "hosts") return /^\d{1,10}$/.test(g.replace(/\s/g, "")) && String(BigInt(g.replace(/\s/g, ""))) === expected;
  if (field === "mask") return normalizeMask(g) === expected;
  const ip = parseIp(g);
  return !!ip && ip.version === 4 && formatIp(4, ip.value) === expected;
}

export function gradeSubnet(questions: SubnetQuestion[], fields: SubnetField[], answers: SubnetAnswers, withExpected = true): GradeResult {
  const total = questions.length * fields.length;
  const per = total > 0 ? 100 / total : 0;
  const items: GradeItem[] = [];
  for (const q of questions) {
    const sol = solveSubnet(q.cidr);
    for (const field of fields) {
      const expected = sol?.[field] ?? "";
      const raw = answers?.[q.key]?.[field];
      const given = typeof raw === "string" ? raw.trim() : "";
      const base = { key: q.key, field, label: q.cidr, max: per, ...(withExpected ? { expected } : {}) };
      if (!given) items.push({ ...base, points: 0, code: "missing" });
      else if (sameAnswer(field, given, expected)) items.push({ ...base, points: per, code: "ok" });
      else items.push({ ...base, points: 0, code: "wrong" });
    }
  }
  return { score: Math.round(items.reduce((a, it) => a + it.points, 0)), items };
}

/* ------------------------------ Réponses reçues ------------------------------ */

/** Nettoie les réponses envoyées par le navigateur : objets simples, chaînes courtes, rien d'autre. */
export function cleanAnswers(kind: "vlsm" | "subnet", raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, TP_ANSWER_MAX) : "");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > TP_MAX_QUESTIONS * SUBNET_FIELDS.length) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (!/^[a-z0-9]{1,6}$/i.test(k)) return null;
    if (kind === "vlsm") out[k] = str(v);
    else {
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const inner: Record<string, string> = {};
      for (const [f, x] of Object.entries(v as Record<string, unknown>)) if ((SUBNET_FIELDS as readonly string[]).includes(f)) inner[f] = str(x);
      out[k] = inner;
    }
  }
  return out;
}
