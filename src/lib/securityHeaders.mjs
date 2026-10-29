/**
 * En-têtes de sécurité envoyés avec chaque réponse (voir next.config.mjs). Fichier .mjs car la configuration de Next.js est lue
 * avant toute compilation TypeScript.
 *
 * - CSP : tout vient de ce serveur (`'self'`), aucun objet ni cadre ; le site ne peut pas être affiché dans le cadre d'un autre
 *   (`frame-ancestors 'none'`, doublé par X-Frame-Options). `'unsafe-inline'` reste nécessaire pour les scripts : Next.js
 *   injecte ses données de page en ligne, et sans « nonce » par requête (qui exigerait un middleware) on ne peut pas l'ôter.
 *   `'unsafe-eval'` et les WebSockets ne sont autorisés qu'en développement (rechargement à chaud).
 * - IP_ARCHITECT_CSP=0 retire la CSP (secours si une extension ou un proxy s'en trouve gêné).
 * - IP_ARCHITECT_HSTS=1 ajoute Strict-Transport-Security : à n'activer que si le site est servi en HTTPS (le navigateur
 *   refusera ensuite tout accès en HTTP pendant 1 an).
 */

/** @param {NodeJS.ProcessEnv} [env] @returns {{ key: string, value: string }[]} */
export function securityHeaders(env = process.env) {
  const dev = env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const list = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
  if (env.IP_ARCHITECT_CSP !== "0") list.push({ key: "Content-Security-Policy", value: csp });
  if (env.IP_ARCHITECT_HSTS === "1") list.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  return list;
}
