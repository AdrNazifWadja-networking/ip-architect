/**
 * Contrôle d'accès côté serveur (Node, base de données) : appelé au début de chaque route API (`guard`) et de chaque
 * page (`requireUser`). Toute la vérification se fait ici, jamais dans le navigateur.
 *
 * Tant qu'aucun compte n'existe, tout est ouvert (voir db/users.ts). Dès qu'un compte existe :
 * - pas de session valide -> 401 (API) ou redirection vers /login (page) ;
 * - rôle insuffisant -> 403 ;
 * - requête modifiant des données (rôle éditeur ou plus) dont l'en-tête Origin désigne un autre site -> 403.
 *
 * Deux façons de s'authentifier pour l'API : le cookie de session (navigateur) ou un jeton d'API
 * `Authorization: Bearer ipa_…` (scripts). Un jeton n'est jamais lu pour les pages, ne dépasse jamais « éditeur » et ne peut
 * pas gérer les jetons ni changer un mot de passe (`requireSessionUser`). Un en-tête Authorization qui n'a pas la forme
 * d'un jeton (ex. authentification d'un proxy) est ignoré : le cookie reste utilisé.
 */
import { syncHeaders as headers } from "./nextHeaders";
import { redirect } from "next/navigation";
import type { NextResponse } from "next/server";
import { getDb } from "../db";
import { authEnabled, sessionUser } from "../db/users";
import { setupActive } from "./setup";
import { accessibleProjects, projectRole, resolveProjectFor } from "../db/access";
import { errorResponse } from "../api";
import { atLeast, type Role } from "./roles";
import { assertBodySize } from "./bodylimit";
import { requestAuth, requestedProjectId, sessionToken, currentUser } from "./request";
import { ApiError, type SessionUser } from "../types";

export { requestAuth, currentUser, sessionToken, type RequestAuth } from "./request";

function sameOrigin(): boolean {
  const h = headers();
  const origin = h.get("origin");
  if (!origin) return true; // outils en ligne de commande, navigations : pas d'en-tête Origin
  try {
    const host = h.get("host");
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Pour les routes à règle d'accès personnalisée : refuse (403) une écriture dont l'en-tête Origin désigne un autre site. */
export function assertSameOrigin(): void {
  if (!sameOrigin()) throw new ApiError("crossOrigin", 403);
}

/**
 * À appeler en première ligne d'un gestionnaire de route : `const denied = guard("editor"); if (denied) return denied;`
 * Retourne la réponse d'erreur à renvoyer, ou null si l'accès est autorisé.
 *
 * Accès par projet : pour un compte « à projets choisis », une route éditeur exige le rôle éditeur DANS le projet de la requête
 * (en-tête X-Project-Id, sinon projet actif du compte). Une route lecteur laisse passer tout compte connecté : les données du
 * projet sont de toute façon refusées par la couche données si le compte n'y a pas accès.
 */
export function guard(min: Role): NextResponse | null {
  try {
    assertBodySize((n) => headers().get(n));
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e);
    // hors requête (tests, scripts) : pas d'en-têtes à contrôler
  }
  const db = getDb();
  if (!authEnabled(db)) return setupActive(db) ? errorResponse(new ApiError("setupRequired", 403)) : null;
  const auth = requestAuth();
  if (!auth) return errorResponse(new ApiError("authRequired", 401));
  if (!atLeast(auth.user.role, min)) return errorResponse(new ApiError("forbidden", 403));
  // le contrôle d'origine protège les cookies (envoyés automatiquement par le navigateur) : sans objet pour un jeton
  if (min !== "viewer" && !auth.token && !sameOrigin()) return errorResponse(new ApiError("crossOrigin", 403));
  try {
    const wanted = requestedProjectId();
    const u = auth.user;
    if (wanted !== null || (min !== "viewer" && u.role !== "admin" && u.projectScope === "selected")) {
      const project = resolveProjectFor(db, u, wanted);
      const role = projectRole(db, u, project.id);
      if (!role || !atLeast(role, min)) return errorResponse(new ApiError("forbidden", 403));
    }
  } catch (e) {
    return errorResponse(e);
  }
  return null;
}

/**
 * Utilisateur connecté PAR SESSION DE NAVIGATEUR, pour les routes sensibles (changer son mot de passe, gérer les jetons,
 * administrer les comptes) : lève 401 sans connexion, 403 si la requête vient d'un jeton d'API.
 */
export function requireSessionUser(): SessionUser {
  const auth = requestAuth();
  if (!auth) throw new ApiError("authRequired", 401);
  if (auth.token) throw new ApiError("sessionRequired", 403);
  return auth.user;
}

/**
 * À appeler en première ligne d'une page : redirige vers /login si la connexion est exigée et absente. Un compte « à projets
 * choisis » sans aucun projet est envoyé vers /aucun-projet, sauf pour les pages qui n'utilisent pas de projet (`projectless`).
 */
export function requireUser(min: Role = "viewer", opts: { projectless?: boolean } = {}): SessionUser | null {
  const db = getDb();
  if (!authEnabled(db)) {
    if (setupActive(db)) redirect("/utilisateurs"); // installation : seule la création du premier compte est accessible
    return null;
  }
  const user = sessionUser(sessionToken(), db);
  if (!user) redirect("/login");
  if (!atLeast(user.role, min)) redirect("/");
  if (!opts.projectless && user.role !== "admin" && user.projectScope === "selected") {
    if (accessibleProjects(db, user).length === 0) redirect("/aucun-projet");
    if (min !== "viewer") {
      const role = projectRole(db, user, resolveProjectFor(db, user).id);
      if (!role || !atLeast(role, min)) redirect("/");
    }
  }
  return user;
}
