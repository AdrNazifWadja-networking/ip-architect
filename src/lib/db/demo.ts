/**
 * Données de démonstration : le projet « Entreprise Globale » créé au premier démarrage.
 * « Quitter la démo » crée le premier vrai projet de l'utilisateur, l'active, supprime le projet de démonstration et
 * mémorise le choix (la démo n'est alors plus jamais recréée, même si la base devient vide).
 */
import { getDb, type Db } from "./index";
import { createProject, deleteProject, activateProject } from "./projects";
import { demoDismissed, readSetting as read, writeSetting as write } from "./demoMark";
import { ApiError, type CreateProjectInput, type ProjectRow, type SessionUser } from "../types";

/** Nom du projet créé par le jeu de données de démonstration (sert aussi à reconnaître les bases plus anciennes). */
export const DEMO_PROJECT_NAME = "Entreprise Globale";

export interface DemoInfo {
  id: number;
  name: string;
  networks: number;
  sites: number;
  vlans: number;
  vrfs: number;
}

/**
 * Le projet de démonstration encore présent, ou null (déjà quitté, ou supprimé à la main).
 * Bases anciennes (sans repère) : on reconnaît le projet « Entreprise Globale », tant que la démo n'a pas été quittée.
 */
export function getDemoInfo(db: Db = getDb()): DemoInfo | null {
  if (demoDismissed(db)) return null;
  const marked = Number(read(db, "demo_project_id"));
  const row = (Number.isInteger(marked) && marked > 0
    ? db.prepare("SELECT id, name FROM projects WHERE id = ?").get(marked)
    : db.prepare("SELECT id, name FROM projects WHERE name = ? ORDER BY id LIMIT 1").get(DEMO_PROJECT_NAME)) as
    | { id: number; name: string }
    | undefined;
  if (!row) return null;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`).get(row.id) as { c: number }).c;
  return { id: row.id, name: row.name, networks: count("networks"), sites: count("sites"), vlans: count("vlans"), vrfs: count("vrfs") };
}

/**
 * Quitte la démonstration : crée le projet de l'utilisateur (vide), l'active, supprime le projet de démonstration ET tout
 * son contenu. Refusé (404) s'il n'y a plus de démonstration. Réservé aux administrateurs (la route le garantit).
 */
export function leaveDemo(input: CreateProjectInput, db: Db = getDb(), user: SessionUser | null = null): { project: ProjectRow; removed: DemoInfo } {
  const demo = getDemoInfo(db);
  if (!demo) throw new ApiError("demoGone", 404);
  return db.transaction(() => {
    const project = createProject(input, db); // valide le nom (400/409/422) ; vide, sans donnée de démonstration
    activateProject(project.id, db, user);
    // réglage commun (application sans compte) ou projet actif d'un autre compte : plus de renvoi vers un projet supprimé
    db.prepare("UPDATE settings SET value = ? WHERE key = 'active_project_id' AND value = ?").run(String(project.id), String(demo.id));
    deleteProject(demo.id, db);
    write(db, "demo_dismissed", "1");
    db.prepare("DELETE FROM settings WHERE key = 'demo_project_id'").run();
    return { project: { ...project, active: true }, removed: demo };
  })();
}
