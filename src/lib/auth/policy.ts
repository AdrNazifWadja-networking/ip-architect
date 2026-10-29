/**
 * Politique d'accès, source unique de vérité : quel rôle minimum pour quelle route API.
 * Chaque gestionnaire de route appelle `guard(<rôle>)` avec exactement la valeur calculée ici ;
 * `auth.test.ts` parcourt tous les fichiers `route.ts` et vérifie les deux (rien d'oublié, rien de divergent).
 *
 * « public » = accessible sans connexion (connexion, état de la session, sonde de santé).
 */
import type { Role } from "./roles";

export type Access = Role | "public";

/** Méthodes qui modifient des données (le reste est de la lecture). */
export const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"] as const;

/**
 * @param method  GET, POST, PATCH, PUT ou DELETE
 * @param route   chemin du fichier route sans « src/app » ni « /route.ts », avec les paramètres entre crochets :
 *                « /api/projects/[id]/activate »
 */
export function requiredAccess(method: string, route: string): Access {
  const m = method.toUpperCase();
  if (route === "/api/health" || route === "/api/auth/login" || route === "/api/auth/logout" || route === "/api/auth/me") return "public";
  // inscription en libre-service : publique (le serveur exige que l'inscription soit activée et vérifie le code envoyé par e-mail)
  if (route === "/api/auth/register/start" || route === "/api/auth/register/verify") return "public";
  // mot de passe oublié : public (le serveur exige l'envoi d'e-mails configuré et vérifie le code reçu par e-mail)
  if (route === "/api/auth/reset/start" || route === "/api/auth/reset/verify") return "public";
  // connexion unique : options affichées sur la page de connexion, départ et retour OpenID Connect (le serveur vérifie state, nonce, PKCE et cookie de liaison)
  if (route === "/api/auth/options" || route === "/api/auth/oidc/start" || route === "/api/auth/oidc/callback") return "public";
  if (route === "/api/auth/password") return "viewer";
  if (route === "/api/users" || route.startsWith("/api/users/")) return "admin";

  // les simulations ne modifient rien : un lecteur peut les lancer
  if (route.startsWith("/api/simulator/")) return "viewer";

  // jetons d'API : chaque compte gère les siens (la route exige en plus une vraie session et la même origine)
  if (route === "/api/tokens" || route.startsWith("/api/tokens/")) return "viewer";

  // étiquettes : consulter = lecteur, gérer = éditeur ; définition des champs personnalisés : administrateur
  if (route === "/api/tags") return m === "GET" ? "viewer" : "editor";
  if (route.startsWith("/api/tags/")) return "editor";
  if (route === "/api/custom-fields") return m === "GET" ? "viewer" : "admin";
  if (route.startsWith("/api/custom-fields/")) return "admin";

  // classes du mode TP et liste des étudiants : enseignant (les classes disent qui est inscrit)
  if (route === "/api/tp/classes" || route.startsWith("/api/tp/classes/") || route === "/api/tp/students") return "editor";

  // mode TP : consulter et remettre = lecteur (c'est le rôle des étudiants) ; les résultats de tous les étudiants = éditeur (enseignant)
  if (/^\/api\/tp\/\[id\]\/submit$/.test(route)) return "viewer";
  if (/^\/api\/tp\/\[id\]\/results$/.test(route)) return "editor";

  // notifications : chaque compte gère ses propres « lus » (ce n'est pas une écriture sur les données d'adressage)
  if (route === "/api/notifications" || route === "/api/notifications/read") return "viewer";

  // assistant IA : poser une question = lecteur (lecture seule) ; configuration, liste des modèles = administrateur
  if (route === "/api/assistant") return m === "POST" ? "viewer" : "admin";
  if (route.startsWith("/api/assistant/")) return "admin";

  // journal d'audit et sauvegarde de la base : administrateur (le journal dit qui a fait quoi ; la copie contient les comptes)
  if (route === "/api/audit" || route === "/api/settings/backup") return "admin";
  // inscription par e-mail et serveur SMTP : administrateur
  if (route === "/api/settings/signup" || route.startsWith("/api/settings/signup/")) return "admin";
  if (route === "/api/settings/alerts" || route.startsWith("/api/settings/alerts/")) return "admin";
  // réglages communs à tous : lisibles par tous, modifiables par un administrateur
  if (route === "/api/settings" && m === "PATCH") return "admin";

  // connexion unique et annuaire : administrateur (secrets, rôles)
  if (route === "/api/settings/sso" || route.startsWith("/api/settings/sso/")) return "admin";

  // topologie : lire = lecteur, modifier et lancer une découverte = éditeur ; identifiants SNMP (communautés) : administrateur (liste des noms : éditeur)
  if (route === "/api/topology/credentials") return m === "GET" ? "editor" : "admin";
  if (route.startsWith("/api/topology/credentials/")) return "admin";

  // webhooks : administrateur (une adresse de webhook fait sortir des données du serveur)
  if (route === "/api/webhooks" || route.startsWith("/api/webhooks/")) return "admin";

  if (m === "GET") return "viewer";

  // projets : chaque compte a SON projet actif (parmi ceux auxquels il a accès) : le changer ne modifie aucune donnée, c'est un
  // simple choix d'affichage (lecteur). Créer, renommer, supprimer = administrateur
  if (route === "/api/demo/leave") return "admin";
  if (route === "/api/projects/[id]/activate") return "viewer";
  if (route === "/api/projects" || route === "/api/projects/[id]") return "admin";

  // seuils de supervision : réglage commun à tous
  if (route === "/api/monitoring/settings") return "admin";

  return "editor";
}
