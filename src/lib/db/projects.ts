/** Projets : espaces de travail indépendants (réseaux, sites, VLANs, VRF…). Un seul est actif à la fois. */
import { getDb, type Db } from "./index";
import { getActiveProject } from "./queries";
import { accessibleProjects, setActiveProjectFor } from "./access";
import { requestContext } from "../auth/request";
import { ApiError, type CreateProjectInput, type ProjectRow, type SessionUser, type UpdateProjectInput } from "../types";

interface RawProject {
  id: number;
  name: string;
  description: string | null;
  created_at: string | null;
  network_count: number;
  site_count: number;
  vlan_count: number;
  vrf_count: number;
}

const PROJECT_SELECT = `
  SELECT p.id, p.name, p.description, p.created_at,
         (SELECT COUNT(*) FROM networks x WHERE x.project_id = p.id) AS network_count,
         (SELECT COUNT(*) FROM sites x WHERE x.project_id = p.id) AS site_count,
         (SELECT COUNT(*) FROM vlans x WHERE x.project_id = p.id) AS vlan_count,
         (SELECT COUNT(*) FROM vrfs x WHERE x.project_id = p.id) AS vrf_count
  FROM projects p`;

function mapProject(r: RawProject, activeId: number): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    active: r.id === activeId,
    networkCount: r.network_count,
    siteCount: r.site_count,
    vlanCount: r.vlan_count,
    vrfCount: r.vrf_count,
    createdAt: r.created_at,
  };
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new ApiError("nameRequired", 422);
  if (name.length > 80) throw new ApiError("nameTooLong", 422);
  return name;
}

function cleanDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 200) throw new ApiError("textTooLong", 422, { max: 200 });
  return s;
}

function assertNameFree(db: Db, name: string, exceptId?: number): void {
  const row = db.prepare("SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND id IS NOT ?").get(name, exceptId ?? null);
  if (row) throw new ApiError("projectNameTaken", 409, { name });
}

/** Projets que la requête en cours a le droit de voir : tous, sauf pour un compte « à projets choisis ». */
function visibleIds(db: Db): Set<number> | null {
  const ctx = requestContext();
  if (!ctx) return null;
  return new Set(accessibleProjects(db, ctx.user).map((p) => p.id));
}

export function listProjects(db: Db = getDb()): ProjectRow[] {
  const visible = visibleIds(db);
  // un compte sans aucun projet voit une liste vide (et non une erreur)
  const active = visible && visible.size === 0 ? { id: -1 } : getActiveProject(db);
  const rows = (db.prepare(`${PROJECT_SELECT} ORDER BY LOWER(p.name)`).all() as RawProject[]).filter((r) => !visible || visible.has(r.id));
  return rows.map((r) => mapProject(r, active.id));
}

export function getProject(id: number, db: Db = getDb()): ProjectRow {
  const active = getActiveProject(db);
  const row = db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id) as RawProject | undefined;
  if (!row || (visibleIds(db) && !visibleIds(db)!.has(id))) throw new ApiError("projectNotFound", 404);
  return mapProject(row, active.id);
}

/** Crée un projet vide (sans donnée de démonstration). Il n'est pas activé automatiquement. */
export function createProject(input: CreateProjectInput, db: Db = getDb()): ProjectRow {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  return db.transaction(() => {
    assertNameFree(db, name);
    const id = Number(
      db
        .prepare("INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)")
        .run(name, description, new Date().toISOString()).lastInsertRowid,
    );
    return getProject(id, db);
  })();
}

export function updateProject(id: number, input: UpdateProjectInput, db: Db = getDb()): ProjectRow {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) {
    throw new ApiError("invalidBody", 400);
  }
  const current = getProject(id, db);
  const name = input.name !== undefined ? cleanName(input.name) : current.name;
  const description = input.description !== undefined ? cleanDescription(input.description) : current.description;
  return db.transaction(() => {
    if (name.toLowerCase() !== current.name.toLowerCase()) assertNameFree(db, name, id);
    db.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?").run(name, description, id);
    return getProject(id, db);
  })();
}

/**
 * Change le projet actif : toutes les pages (réseaux, IPAM, DHCP, VRF…) montrent alors ce projet. Avec des comptes, le choix est
 * PERSONNEL (chaque compte a son projet actif, parmi ceux auxquels il a accès) ; sans compte, c'est un réglage commun.
 */
export function activateProject(id: number, db: Db = getDb(), user: SessionUser | null = null): ProjectRow {
  if (user) {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) throw new ApiError("projectNotFound", 404);
    setActiveProjectFor(db, user, id); // 403 si le compte n'y a pas accès
    return getProject(id, db);
  }
  getProject(id, db); // 404 si inconnu
  db.prepare("INSERT INTO settings (key, value) VALUES ('active_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(id),
  );
  return getProject(id, db);
}

/**
 * Supprime un projet ET tout son contenu (réseaux, adresses, DHCP, VRF, VLANs, sites, alertes : suppression en cascade).
 * Le projet actif ne peut pas être supprimé : activez-en d'abord un autre.
 */
export function deleteProject(id: number, db: Db = getDb()): void {
  const project = getProject(id, db);
  if (project.active) throw new ApiError("projectActive", 409);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}
