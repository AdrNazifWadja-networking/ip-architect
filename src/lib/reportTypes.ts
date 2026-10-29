/** Types et constantes des rapports, sans accès à la base : importables côté navigateur. */

export const REPORT_KINDS = ["summary", "sites", "networks", "dhcp", "vlans", "vrf"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);
}

/**
 * - text : texte brut ; int : entier ; pct : pourcentage 0-100 ; status : valeur traduite (t.reports.values) ;
 * - bool : oui/non. Une cellule null s’affiche « — » (ou un libellé propre à la colonne : « Sans site », « Globale »).
 */
export type ColumnType = "text" | "int" | "pct" | "status" | "bool";

export interface ReportColumn {
  key: string;
  type: ColumnType;
}

export type ReportCell = string | number | boolean | null;

export interface ReportTable {
  /** Identifiant du tableau (titre : t.reports.tables[id]). */
  id: string;
  columns: ReportColumn[];
  rows: ReportCell[][];
  /** Ligne de totaux facultative (mêmes colonnes ; null = pas de total pour cette colonne). */
  footer?: ReportCell[];
}

export interface Report {
  kind: ReportKind;
  project: string;
  /** Nom de l'organisation (Paramètres) ; vide = aucun. */
  organization: string;
  /** ISO 8601 UTC. */
  generatedAt: string;
  tables: ReportTable[];
}
