import { INTL_TAG, format, type Dictionary, type Locale } from "./i18n";

/** Entier avec séparateur de milliers selon la langue (fr : 18 749 · en : 18,749). */
export function fmtInt(n: number, locale: Locale): string {
  return Math.round(n).toLocaleString(INTL_TAG[locale]);
}

/** Pourcentage selon la langue (fr : 28,6% · en : 28.6%). */
export function fmtPct(n: number, locale: Locale, digits = 1): string {
  return `${n.toLocaleString(INTL_TAG[locale], { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** Valeur signée (+2,1 / -3.4) pour les variations. */
export function fmtSigned(n: number, locale: Locale, digits = 1): string {
  const body = n.toLocaleString(INTL_TAG[locale], { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return n >= 0 ? `+${body}` : body;
}

/** "Il y a 5 min" / "5 min ago" selon le dictionnaire fourni. */
export function timeAgo(iso: string, time: Dictionary["time"], now: number = Date.now()): string {
  const diffMin = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (diffMin < 1) return time.justNow;
  if (diffMin < 60) return format(time.minutesAgo, { n: diffMin });
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return format(time.hoursAgo, { n: hours });
  return format(time.daysAgo, { n: Math.floor(hours / 24) });
}

/** "2026-10-16" -> "16 oct." / "Oct 16" (jour local, sans décalage de fuseau) */
export function shortDay(day: string, locale: Locale): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(INTL_TAG[locale], { day: "numeric", month: "short" });
}

/** Très grands nombres d'adresses (IPv6) : 1,84 × 10^19 (virgule ou point selon la langue). */
export function formatCount(n: bigint, locale: Locale): string {
  const tag = INTL_TAG[locale];
  if (n < 1_000_000_000_000n) return Number(n).toLocaleString(tag);
  const digits = n.toString();
  const decimal = (1.1).toLocaleString(tag).charAt(1);
  return `${digits[0]}${decimal}${digits.slice(1, 3)} × 10^${digits.length - 1}`;
}
