/**
 * Derrière quel genre de serveur tourne l'application ? Les en-têtes X-Forwarded-* sont écrits par le client quand le serveur
 * est joignable directement : les croire permettrait de contourner la limitation des tentatives (une « adresse IP » différente
 * à chaque essai), de fausser le journal d'audit et de fabriquer l'adresse de retour de la connexion unique.
 * On ne les lit donc QUE si l'administrateur a déclaré un proxy de confiance : IP_ARCHITECT_TRUST_PROXY=1 (le proxy doit alors
 * ÉCRASER ces en-têtes, ce que font Nginx, Caddy et Traefik par défaut).
 */
import { parseIp } from "../ip/cidr";

type Get = (name: string) => string | null | undefined;

export const trustProxy = (env: NodeJS.ProcessEnv = process.env): boolean => env.IP_ARCHITECT_TRUST_PROXY === "1";

/** Adresse du client, ou null (sans proxy de confiance, on ne la connaît pas : Next.js ne donne pas l'adresse de la connexion). */
export function clientIpFrom(get: Get, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!trustProxy(env)) return null;
  const first = get("x-forwarded-for")?.split(",")[0].trim();
  return first && parseIp(first) ? first : null;
}

/** Le cookie de session doit-il porter « Secure » ? Oui en HTTPS direct, derrière un proxy de confiance qui dit https, ou si IP_ARCHITECT_SECURE_COOKIES=1. */
export function secureCookie(get: Get, protocol: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.IP_ARCHITECT_SECURE_COOKIES === "1") return true;
  if (trustProxy(env) && get("x-forwarded-proto")?.split(",")[0].trim() === "https") return true;
  return protocol.replace(":", "") === "https";
}
