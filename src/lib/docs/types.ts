/**
 * Modèle de la documentation : des sections faites de blocs simples (pas de HTML libre, donc rien à échapper
 * ni à assainir : l'interface rend chaque bloc elle-même).
 */
export type NoteKind = "tip" | "warning" | "info";

export type DocBlock =
  | { t: "p"; text: string }
  | { t: "h3"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "note"; kind: NoteKind; text: string }
  | { t: "code"; text: string }
  | { t: "table"; head: string[]; rows: string[][] }
  /** Emplacement du tableau de référence de l'API (généré depuis `api.ts`, jamais écrit à la main). */
  | { t: "api" };

export type DocGroup = "start" | "modules" | "admin" | "ref";
export const DOC_GROUPS: DocGroup[] = ["start", "modules", "admin", "ref"];

export interface DocSection {
  /** Ancre stable (identique dans toutes les langues). */
  id: string;
  group: DocGroup;
  title: string;
  summary: string;
  blocks: DocBlock[];
  /** Lien vers la page de l'application que la section décrit. */
  open?: { label: string; href: string };
}

export interface ApiDoc {
  method: string;
  path: string;
  /** Rôle minimum, calculé depuis `policy.ts` (jamais écrit à la main). */
  access: "public" | "viewer" | "editor" | "admin";
  description: string;
}

/** Texte brut d'un bloc, pour la recherche. */
export function blockText(b: DocBlock): string {
  switch (b.t) {
    case "p":
    case "h3":
    case "code":
      return b.text;
    case "note":
      return b.text;
    case "ul":
    case "ol":
      return b.items.join(" ");
    case "table":
      return [...b.head, ...b.rows.flat()].join(" ");
    case "api":
      return "";
  }
}

/** Texte brut d'une section (titre, résumé, contenu) mis en minuscules, pour le filtre de recherche. */
export function sectionText(s: DocSection, api: ApiDoc[]): string {
  const parts = [s.title, s.summary, ...s.blocks.map(blockText)];
  if (s.blocks.some((b) => b.t === "api")) for (const r of api) parts.push(r.method, r.path, r.description);
  return parts.join(" ").toLowerCase();
}

/** Découpe une saisie de recherche en mots (tous doivent être présents). */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 8);
}
