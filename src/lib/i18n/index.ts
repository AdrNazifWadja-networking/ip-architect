import { fr } from "./fr";
import { en } from "./en";

/** Langues disponibles. Pour en ajouter une : créer xx.ts (même structure que fr.ts) puis l'enregistrer ici. */
export const LOCALES = ["fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "fr";
export const LOCALE_COOKIE = "locale";

export type Dictionary = typeof fr;

export const dictionaries: Record<Locale, Dictionary> = { fr, en };

/** Étiquette BCP 47 utilisée par Intl pour les nombres et les dates. */
export const INTL_TAG: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Remplace les variables {nom} d'un message. Une variable absente est laissée telle quelle. */
export function format(message: string, vars: Record<string, string | number> = {}): string {
  return message.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

/** Choisit la meilleure langue à partir d'un en-tête Accept-Language. */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (isLocale(code)) return code;
  }
  return null;
}
