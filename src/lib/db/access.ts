/**
 * Accès par projet.
 *
 * - Compte « all » (et tout administrateur) : son rôle vaut dans tous les projets, présents et futurs.
 * - Compte « selected » : il n'a accès qu'aux projets où il est membre, avec le rôle de ce projet (viewer ou editor).
 *   Le rôle global du compte est alors maintenu égal au plus haut de ses rôles de projet (plafond cohérent avec les jetons
 *   d'API et le contrôle d'accès des routes) ; un administrateur n'est jamais « selected ».
 *
 * Le projet d'une requête : l'en-tête X-Project-Id s'il est présent (refusé s'il n'est pas accessible), sinon le projet actif
 * propre au compte, sinon le premier projet accessible.
 */
import { getDb, type Db } from "./index";
import { atLeast, type Role } from "../auth/roles";
import { isMemberRole, isProjectScope, type MemberRole, type Membership, type ProjectScope } from "../projectAccess";
import { ApiError, type SessionUser } from "../types";

type Who = Pick<SessionUser, "id" | "role" | "projectScope">;

const sees_all = (u: Who): boolean => u.role === "admin" || u.projectScope === "all";

export function getMemberships(db: Db, userId: number): Membership[] {
  return (db.prepare("SELECT project_id, role FROM project_members WHERE user_id = ? ORDER BY project_id").all(userId) as { project_id: number; role: string }[])
    .filter((r) => isMemberRole(r.role))
    .map((r) => ({ projectId: r.project_id, role: r.role as MemberRole }));
}

/** Rôle du compte dans ce projet, ou null s'il n'y a pas accès (ou si le projet n'existe pas). */
export function projectRole(db: Db, user: Who, projectId: number): Role | null {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return null;
  if (sees_all(user)) return user.role;
  const r = db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, user.id) as { role: string } | undefined;
  if (!r || !isMemberRole(r.role)) return null;
  // jamais plus que le plafond du compte (rôle global, ou rôle du jeton d'API)
  return atLeast(user.role, r.role) ? r.role : user.role;
}

export function accessibleProjects(db: Db, user: Who): { id: number; name: string }[] {
  if (sees_all(user)) return db.prepare("SELECT id, name FROM projects ORDER BY id").all() as { id: number; name: string }[];
  return db
    .prepare("SELECT p.id, p.name FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.id")
    .all(user.id) as { id: number; name: string }[];
}

/** Le projet de la requête pour ce compte. 403 si le projet demandé n'est pas accessible ou si le compte n'a aucun projet. */
export function resolveProjectFor(db: Db, user: Who, requestedId?: number | null): { id: number; name: string } {
  const list = accessibleProjects(db, user);
  if (requestedId !== undefined && requestedId !== null) {
    const hit = list.find((p) => p.id === requestedId);
    if (!hit) throw new ApiError("projectForbidden", 403);
    return hit;
  }
  if (list.length === 0) throw new ApiError("noProjectAccess", 403);
  const mine = db.prepare("SELECT active_project_id AS a FROM users WHERE id = ?").get(user.id) as { a: number | null } | undefined;
  return list.find((p) => p.id === mine?.a) ?? list[0];
}

/** Mémorise le projet actif de CE compte (il doit y avoir accès). */
export function setActiveProjectFor(db: Db, user: Who, projectId: number): void {
  if (!accessibleProjects(db, user).some((p) => p.id === projectId)) throw new ApiError("projectForbidden", 403);
  db.prepare("UPDATE users SET active_project_id = ? WHERE id = ?").run(projectId, user.id);
}

export interface ScopeInput {
  projectScope?: unknown;
  memberships?: unknown;
}

/** Valide la portée et la liste de projets d'une saisie d'administrateur. */
export function cleanScope(db: Db, role: Role, current: { scope: ProjectScope; memberships: Membership[] }, input: ScopeInput): { scope: ProjectScope; memberships: Membership[] } {
  let scope = current.scope;
  if (input.projectScope !== undefined) {
    if (!isProjectScope(input.projectScope)) throw new ApiError("invalidBody", 400);
    scope = input.projectScope;
  }
  let memberships = current.memberships;
  if (input.memberships !== undefined) {
    if (!Array.isArray(input.memberships) || input.memberships.length > 500) throw new ApiError("invalidBody", 400);
    const seen = new Set<number>();
    memberships = [];
    for (const m of input.memberships as unknown[]) {
      const o = m as { projectId?: unknown; role?: unknown } | null;
      if (!o || typeof o !== "object" || !Number.isInteger(o.projectId) || !isMemberRole(o.role)) throw new ApiError("invalidBody", 400);
      const pid = o.projectId as number;
      if (seen.has(pid)) throw new ApiError("invalidBody", 400);
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(pid)) throw new ApiError("projectNotFound", 404);
      seen.add(pid);
      memberships.push({ projectId: pid, role: o.role });
    }
  }
  if (role === "admin" && scope === "selected") throw new ApiError("adminAllProjects", 422);
  return { scope, memberships };
}

/**
 * Enregistre la portée et les projets d'un compte, et aligne son rôle global : « selected » → le plus haut rôle de ses projets
 * (viewer s'il n'en a aucun) ; « all » → le rôle choisi par l'administrateur, inchangé. À appeler dans une transaction.
 */
export function applyScope(db: Db, userId: number, role: Role, scope: ProjectScope, memberships: Membership[]): Role {
  db.prepare("UPDATE users SET project_scope = ? WHERE id = ?").run(scope, userId);
  db.prepare("DELETE FROM project_members WHERE user_id = ?").run(userId);
  let finalRole = role;
  if (scope === "selected") {
    const ins = db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)");
    for (const m of memberships) ins.run(m.projectId, userId, m.role);
    finalRole = memberships.some((m) => m.role === "editor") ? "editor" : "viewer";
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(finalRole, userId);
  }
  return finalRole;
}

export const defaultScopeFor = (db: Db = getDb()): ProjectScope =>
  (db.prepare("SELECT COUNT(*) AS c FROM projects").get() as { c: number }).c > 1 ? "selected" : "all";
