import { syncCookies as cookies, syncHeaders as headers } from "@/lib/auth/nextHeaders";
import { DEFAULT_LOCALE, LOCALE_COOKIE, dictionaries, isLocale, matchAcceptLanguage, type Dictionary, type Locale } from "./index";

/**
 * Langue de la requête : cookie (choix de l'utilisateur) > Accept-Language du navigateur > français.
 * À n'appeler que côté serveur (composants serveur, routes API).
 */
export function getLocale(): Locale {
  const fromCookie = cookies().get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  return matchAcceptLanguage(headers().get("accept-language")) ?? DEFAULT_LOCALE;
}

/** `t` = dictionnaire de la langue courante, `locale` = code de langue (pour Intl, <html lang>…). */
export function getDictionary(): { locale: Locale; t: Dictionary } {
  const locale = getLocale();
  return { locale, t: dictionaries[locale] };
}
