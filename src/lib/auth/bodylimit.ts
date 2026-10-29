/**
 * Taille des requêtes : Next.js ne limite pas le corps des requêtes des routes API. Sans plafond, un compte (ou, sur les routes
 * publiques, n'importe qui) pourrait envoyer plusieurs gigaoctets et saturer la mémoire du serveur.
 * On se fie à l'en-tête Content-Length (toujours envoyé par les navigateurs, curl -d, fetch avec une chaîne) et on refuse
 * l'envoi « chunked » (sans longueur annoncée) : aucun client légitime de cette API n'en a besoin.
 */
import { ApiError } from "../types";

/** Plafond général : le plus gros corps légitime est un import CSV. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** Routes publiques (connexion, inscription, mot de passe oublié) : quelques champs de texte. */
export const MAX_PUBLIC_BODY_BYTES = 64 * 1024;

type Get = (name: string) => string | null | undefined;

export function bodyTooLarge(get: Get, max = MAX_BODY_BYTES): boolean {
  if (get("transfer-encoding")?.toLowerCase().includes("chunked")) return true;
  const len = get("content-length");
  if (len === null || len === undefined) return false;
  const n = Number(len.trim());
  return !Number.isFinite(n) || n < 0 || n > max;
}

/** Lève 413 si le corps annoncé est trop gros. */
export function assertBodySize(get: Get, max = MAX_BODY_BYTES): void {
  if (bodyTooLarge(get, max)) throw new ApiError("requestTooLarge", 413);
}
