/**
 * CSV (RFC 4180) : lecture tolérante, écriture compatible Excel.
 *
 * - Lecture : guillemets, guillemets doublés, retours à la ligne dans une cellule, BOM UTF-8, fins de ligne
 *   \n / \r\n / \r, séparateur détecté (`;` `,` tabulation), lignes entièrement vides ignorées.
 * - Écriture : BOM UTF-8 (Excel ouvre alors les accents correctement), \r\n, guillemets seulement si nécessaire,
 *   et neutralisation des « formules » : une cellule de texte qui commence par = + - @ ou une tabulation serait exécutée
 *   par Excel ; on la préfixe d'une apostrophe, que la lecture retire (aller-retour sans perte).
 */

export type Delimiter = ";" | "," | "\t";
export const DELIMITERS: readonly Delimiter[] = [";", ",", "\t"];

export const BOM = "﻿";

/** Séparateur le plus fréquent dans la première ligne hors guillemets (virgule en cas d'égalité ou d'absence). */
export function detectDelimiter(text: string): Delimiter {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const counts: Record<Delimiter, number> = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const ch of src) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as Delimiter]++;
  }
  let best: Delimiter = ",";
  for (const d of DELIMITERS) if (counts[d] > counts[best]) best = d;
  return best;
}

export class CsvError extends Error {
  constructor(
    public readonly code: "unterminatedQuote",
    public readonly line: number,
  ) {
    super(`${code} (ligne ${line})`);
  }
}

/** Retire l'apostrophe de neutralisation ajoutée à l'écriture (uniquement devant un caractère déclencheur). */
function unprotect(cell: string): string {
  return /^'+[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell;
}

/** Découpe un texte CSV en lignes de cellules. Lève CsvError si un guillemet n'est pas refermé. */
export function parseCsv(text: string, delimiter?: Delimiter): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let wasQuoted = false; // la cellule courante a été écrite entre guillemets (même vide)
  let line = 1;
  let quoteLine = 1;

  const endCell = () => {
    row.push(unprotect(wasQuoted ? cell : cell.trim()));
    cell = "";
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    // ligne vide = une seule cellule vide non citée
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      wasQuoted = true;
      quoteLine = line;
    } else if (ch === d) endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
      line++;
    } else cell += ch;
  }
  if (quoted) throw new CsvError("unterminatedQuote", quoteLine);
  if (cell !== "" || wasQuoted || row.length > 0) endRow();
  return rows;
}

/** Cellule -> texte CSV : guillemets si la cellule contient le séparateur, un guillemet ou un saut de ligne. */
export function formatCell(value: string | number | boolean | null | undefined, delimiter: Delimiter): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  // nombres et booléens sont écrits tels quels ; seul le TEXTE doit être protégé contre les formules
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  else if (typeof value === "string" && /^'+[=+\-@\t\r]/.test(s)) s = `'${s}`; // déjà une apostrophe + déclencheur : on la double
  return s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r") || /^\s|\s$/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
  delimiter: Delimiter = ";",
): string {
  const lines = [header, ...rows].map((r) => r.map((c) => formatCell(c, delimiter)).join(delimiter));
  return BOM + lines.join("\r\n") + "\r\n";
}
