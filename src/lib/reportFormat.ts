/**
 * Mise en forme des cellules d'un rapport, partagée par la page, l'export CSV et les tests :
 * un même chiffre s'écrit pareil partout (sauf que le CSV garde les nombres bruts, utilisables dans un tableur).
 */
import type { Dictionary, Locale } from "./i18n";
import type { ReportCell, ReportColumn, ReportTable } from "./reportTypes";
import { fmtInt, fmtPct } from "./format";
import { formatLease } from "./dhcp/lease";

/** Texte affiché quand la cellule est vide, selon la colonne. */
function emptyLabel(col: ReportColumn, t: Dictionary): string {
  if (col.key === "site") return t.reports.values.noSite;
  if (col.key === "vrf") return t.reports.values.globalVrf;
  return t.reports.values.none;
}

const VALUES = (t: Dictionary) => t.reports.values as Record<string, string>;

/** La ligne « v4Occupancy » du tableau de synthèse est un pourcentage, les autres des entiers. */
function effectiveType(table: ReportTable, col: ReportColumn, row: ReportCell[]): ReportColumn["type"] {
  if (table.id === "totals" && col.key === "value" && row[0] === "v4Occupancy") return "pct";
  return col.type;
}

export function displayCell(table: ReportTable, colIndex: number, row: ReportCell[], t: Dictionary, locale: Locale): string {
  const col = table.columns[colIndex];
  const cell = row[colIndex];
  if (cell === null || cell === undefined || cell === "") return emptyLabel(col, t);
  switch (effectiveType(table, col, row)) {
    case "int":
      // la durée de bail s'affiche en clair (1 j, 8 h…)
      if (col.key === "lease") return formatLease(Number(cell), t.dhcp.lease);
      return fmtInt(Number(cell), locale);
    case "pct":
      return fmtPct(Number(cell), locale);
    case "bool":
      return cell ? t.reports.values.yes : t.reports.values.no;
    case "status":
      return VALUES(t)[String(cell)] ?? String(cell);
    default:
      return String(cell);
  }
}

/** Valeur pour le CSV : nombres bruts (pourcentage arrondi à 0,1), textes traduits. */
export function csvCell(table: ReportTable, colIndex: number, row: ReportCell[], t: Dictionary): string | number | null {
  const col = table.columns[colIndex];
  const cell = row[colIndex];
  if (cell === null || cell === undefined || cell === "") return null;
  switch (effectiveType(table, col, row)) {
    case "int":
      return Number(cell);
    case "pct":
      return Math.round(Number(cell) * 10) / 10;
    case "bool":
      return cell ? t.reports.values.yes : t.reports.values.no;
    case "status":
      return VALUES(t)[String(cell)] ?? String(cell);
    default:
      return String(cell);
  }
}
