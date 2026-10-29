/** Repères « données de démonstration » dans la table settings (sans dépendance : utilisé par le schéma et le jeu de données). */
import type { Db } from "./index";

export const readSetting = (db: Db, key: string): string | null =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;

export const writeSetting = (db: Db, key: string, value: string): void => {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

/** La démonstration a été quittée : elle ne sera plus jamais recréée. */
export const demoDismissed = (db: Db): boolean => readSetting(db, "demo_dismissed") === "1";

/** Enregistre quel projet porte les données de démonstration (appelé par le jeu de données). */
export function markDemoProject(db: Db, projectId: number): void {
  writeSetting(db, "demo_project_id", String(projectId));
}
