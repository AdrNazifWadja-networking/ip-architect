/**
 * Historique « avant / après » du journal d'audit : types et fonctions pures, sans accès à la base (importable côté navigateur).
 *
 * Un `ChangeSet` associe un nom de champ à `[avant, après]`. Il ne contient QUE des valeurs d'adressage ou de réglage non
 * secrètes : les instantanés (db/changes.ts) choisissent leurs champs un par un, et `sanitizeChanges` écarte de toute façon
 * un champ dont le nom évoque un secret.
 */
export type ChangeValue = string | number | boolean | null;
export type ChangeSet = Record<string, [ChangeValue, ChangeValue]>;
export type Snapshot = Record<string, ChangeValue>;

export const MAX_CHANGE_FIELDS = 30;
export const MAX_CHANGE_VALUE = 200;
export const MAX_CHANGES_JSON = 4000;

/** Un nom de champ qui évoque un secret n'est jamais journalisé (défense en profondeur). */
const SECRET_NAME = /pass(word)?|token|secret|hash|api_?key|salt|cookie|session/i;

const cleanValue = (v: unknown): ChangeValue | undefined => {
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    return s.length > MAX_CHANGE_VALUE ? `${s.slice(0, MAX_CHANGE_VALUE - 1)}…` : s;
  }
  return undefined;
};

/** Valide la forme d'un historique (venant de la base ou d'un appelant) ; null si rien d'exploitable. */
export function sanitizeChanges(raw: unknown): ChangeSet | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: ChangeSet = {};
  let size = 2;
  for (const [name, pair] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_CHANGE_FIELDS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) || SECRET_NAME.test(name)) continue;
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const a = cleanValue(pair[0]);
    const b = cleanValue(pair[1]);
    if (a === undefined || b === undefined || a === b) continue;
    const cost = JSON.stringify([name, a, b]).length + 1;
    if (size + cost > MAX_CHANGES_JSON) break;
    size += cost;
    out[name] = [a, b];
  }
  return Object.keys(out).length ? out : null;
}

/** Champs qui diffèrent entre deux instantanés. `null` d'un côté = l'objet n'existait pas (création) ou n'existe plus (suppression). */
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): ChangeSet | null {
  if (!before && !after) return null;
  const raw: Record<string, [ChangeValue, ChangeValue]> = {};
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const n of names) {
    const a = before ? (before[n] ?? null) : null;
    const b = after ? (after[n] ?? null) : null;
    if (a !== b) raw[n] = [a, b];
  }
  return sanitizeChanges(raw);
}

/** Relit la colonne JSON ; tout ce qui n'est pas valide donne null (une base modifiée à la main ne casse pas l'affichage). */
export function parseChanges(json: string | null | undefined): ChangeSet | null {
  if (!json) return null;
  try {
    return sanitizeChanges(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Texte d'une valeur pour l'affichage et le CSV : « (vide) » est ajouté par l'interface, ici une chaîne brute. */
export function changeValueText(v: ChangeValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Une ligne par champ : « name: avant → après » (CSV, recherche). */
export function changesSummary(c: ChangeSet | null): string {
  if (!c) return "";
  return Object.entries(c)
    .map(([k, [a, b]]) => `${k}: ${changeValueText(a) || "∅"} → ${changeValueText(b) || "∅"}`)
    .join(" ; ");
}
