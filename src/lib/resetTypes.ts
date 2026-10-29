/** Mot de passe oublié par e-mail : constantes partagées (sans accès à la base : importables côté navigateur). */

/** Plus long que le code d'inscription (2 min) : il faut le temps d'ouvrir sa messagerie, mais reste court. */
export const RESET_CODE_TTL_MS = 600_000;
export const RESET_MAX_ATTEMPTS = 5;
