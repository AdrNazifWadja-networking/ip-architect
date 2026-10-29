/**
 * Qui fait la requête en cours, et sur quel projet (cookies / en-têtes de Next.js). Séparé de guard.ts pour que la couche
 * données (getActiveProject) puisse le demander sans dépendre du contrôle d'accès. Hors requête (tests, scripts, planificateur),
 * `requestAuth()` lève une erreur de Next : elle est interceptée et le résultat est « personne ».
 */
import { syncCookies as cookies, syncHeaders as headers } from "./nextHeaders";
import { getDb } from "../db";
import { authEnabled, sessionUser } from "../db/users";
import { authenticateToken } from "../db/tokens";
import { SESSION_COOKIE } from "./roles";
import { PROJECT_HEADER } from "../projectAccess";
import { ApiError, type SessionUser } from "../types";

export function sessionToken(): string | null {
  return cookies().get(SESSION_COOKIE)?.value ?? null;
}

export interface RequestAuth {
  user: SessionUser;
  /** Renseigné quand la requête s'authentifie par jeton d'API (et non par cookie). */
  token: { id: number; prefix: string } | null;
}

/** Jeton présenté dans l'en-tête Authorization, ou null si absent ou de forme différente. */
function presentedToken(): string | null {
  const m = /^Bearer\s+(ipa_\S+)$/i.exec(headers().get("authorization")?.trim() ?? "");
  return m ? m[1] : null;
}

/** Qui fait la requête (jeton d'API ou session) ; null = personne (ou application ouverte, voir `authEnabled`). */
export function requestAuth(): RequestAuth | null {
  const db = getDb();
  if (!authEnabled(db)) return null;
  const raw = presentedToken();
  if (raw) {
    // un jeton présenté est le seul moyen d'authentification de la requête : jamais de repli sur le cookie
    const t = authenticateToken(raw, db);
    return t ? { user: t.user, token: { id: t.tokenId, prefix: t.prefix } } : null;
  }
  const user = sessionUser(sessionToken(), db);
  return user ? { user, token: null } : null;
}

/** Utilisateur de la requête en cours ; null = pas connecté (ou application ouverte, voir `authEnabled`). */
export function currentUser(): SessionUser | null {
  return requestAuth()?.user ?? null;
}

/** Projet demandé explicitement par l'en-tête X-Project-Id : null s'il est absent ; 400 s'il n'est pas un entier positif. */
export function requestedProjectId(): number | null {
  const raw = headers().get(PROJECT_HEADER);
  if (raw === null || raw.trim() === "") return null;
  if (!/^[1-9]\d{0,9}$/.test(raw.trim())) throw new ApiError("invalidProjectHeader", 400);
  return Number(raw.trim());
}

/** Contexte de la requête pour la couche données ; null hors requête ou quand l'application est ouverte (aucun compte). */
export function requestContext(): { user: SessionUser; projectId: number | null } | null {
  try {
    headers(); // hors requête (tests, scripts, planificateur) : Next lève une erreur, et on ne touche pas à la base globale
  } catch {
    return null;
  }
  let auth: RequestAuth | null;
  try {
    auth = requestAuth();
  } catch {
    return null;
  }
  if (!auth) return null;
  let projectId: number | null = null;
  try {
    projectId = requestedProjectId();
  } catch (e) {
    if (e instanceof ApiError) throw e; // en-tête mal formé : refus explicite
  }
  return { user: auth.user, projectId };
}
