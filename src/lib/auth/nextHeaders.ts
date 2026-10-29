/**
 * Accès synchrone à cookies() / headers() de Next.js.
 *
 * Next 15 les rend asynchrones (Promise) ; l'accès synchrone reste toléré (avertissement en développement) et ne sera
 * retiré qu'avec Next 16. Tout le code d'authentification, d'audit et de langue est synchrone (better-sqlite3) :
 * on centralise ici le seul endroit où l'on contourne le typage, pour pouvoir le migrer en un seul point.
 * Hors requête (tests, scripts, planificateur), Next lève une erreur — comportement inchangé.
 */
import { cookies, headers } from "next/headers";

type Cookies = Awaited<ReturnType<typeof cookies>>;
type Headers = Awaited<ReturnType<typeof headers>>;

export const syncCookies = (): Cookies => cookies() as unknown as Cookies;
export const syncHeaders = (): Headers => headers() as unknown as Headers;
