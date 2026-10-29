/**
 * Classes du mode TP : un groupe d'étudiants (comptes « lecteur ») auquel l'enseignant peut réserver des exercices.
 * Un exercice sans classe reste visible de tous les étudiants. Supprimer une classe qui a des exercices est refusé
 * (sinon ils deviendraient visibles de tout le monde sans que personne l'ait décidé).
 */
import { getDb, type Db } from "./index";
import { ApiError } from "../types";
import { TP_CLASS_MAX_MEMBERS, TP_CLASS_NAME_MAX, type TpClassMember, type TpClassRow } from "../tp/types";

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim() : "";
  if (!s) throw new ApiError("tpClassNameRequired", 422);
  if (s.length > TP_CLASS_NAME_MAX) throw new ApiError("tpClassNameTooLong", 422, { max: TP_CLASS_NAME_MAX });
  return s;
}

const nameTaken = (db: Db, name: string, exceptId?: number): boolean =>
  !!db.prepare("SELECT 1 FROM tp_classes WHERE LOWER(name) = LOWER(?) AND id IS NOT ?").get(name, exceptId ?? null);

/** Les comptes qu'on peut inscrire dans une classe : étudiants (rôle lecteur) actifs. */
export function listStudents(db: Db = getDb()): TpClassMember[] {
  return db
    .prepare("SELECT id, username, display_name AS displayName FROM users WHERE role = 'viewer' AND active = 1 ORDER BY LOWER(username)")
    .all() as unknown as TpClassMember[];
}

export function listClasses(db: Db = getDb()): TpClassRow[] {
  const members = db
    .prepare(
      `SELECT m.class_id, u.id, u.username, u.display_name AS displayName FROM tp_class_members m JOIN users u ON u.id = m.user_id ORDER BY LOWER(u.username)`,
    )
    .all() as unknown as (TpClassMember & { class_id: number })[];
  const counts = db.prepare("SELECT class_id, COUNT(*) AS n FROM tp_exercises WHERE class_id IS NOT NULL GROUP BY class_id").all() as { class_id: number; n: number }[];
  return (db.prepare("SELECT id, name FROM tp_classes ORDER BY LOWER(name)").all() as { id: number; name: string }[]).map((c) => ({
    id: c.id,
    name: c.name,
    members: members.filter((m) => m.class_id === c.id).map(({ class_id: _c, ...m }) => m),
    exerciseCount: counts.find((x) => x.class_id === c.id)?.n ?? 0,
  }));
}

export function getClass(id: number, db: Db = getDb()): TpClassRow {
  const c = listClasses(db).find((x) => x.id === id);
  if (!c) throw new ApiError("tpClassNotFound", 404);
  return c;
}

export interface ClassInput {
  name?: unknown;
  /** Remplace la liste des membres (identifiants de comptes). */
  userIds?: unknown;
  /** Idem par identifiants de connexion ; s'ajoute à `userIds`. Les inconnus sont renvoyés dans `unknown`. */
  usernames?: unknown;
}

/** Résout la liste des membres demandée ; null = ne pas toucher aux membres. */
function resolveMembers(db: Db, input: ClassInput): { ids: number[]; unknown: string[] } | null {
  if (input.userIds === undefined && input.usernames === undefined) return null;
  const ids = new Set<number>();
  const unknown: string[] = [];
  if (input.userIds !== undefined) {
    if (!Array.isArray(input.userIds) || input.userIds.length > TP_CLASS_MAX_MEMBERS) throw new ApiError("invalidBody", 400);
    for (const v of input.userIds as unknown[]) {
      if (typeof v !== "number" || !Number.isInteger(v)) throw new ApiError("invalidBody", 400);
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'viewer' AND active = 1").get(v)) unknown.push(String(v));
      else ids.add(v);
    }
  }
  if (input.usernames !== undefined) {
    const raw = Array.isArray(input.usernames) ? input.usernames : typeof input.usernames === "string" ? input.usernames.split(/[\s,;]+/) : null;
    if (!raw || raw.length > TP_CLASS_MAX_MEMBERS * 2) throw new ApiError("invalidBody", 400);
    for (const v of raw as unknown[]) {
      if (typeof v !== "string" || v.trim() === "") continue;
      const u = db.prepare("SELECT id FROM users WHERE LOWER(username) = ? AND role = 'viewer' AND active = 1").get(v.trim().toLowerCase().slice(0, 80)) as { id: number } | undefined;
      if (u) ids.add(u.id);
      else unknown.push(v.trim().slice(0, 40));
    }
  }
  if (ids.size > TP_CLASS_MAX_MEMBERS) throw new ApiError("invalidBody", 400);
  return { ids: [...ids], unknown };
}

function setMembers(db: Db, classId: number, ids: number[]): void {
  db.prepare("DELETE FROM tp_class_members WHERE class_id = ?").run(classId);
  const ins = db.prepare("INSERT INTO tp_class_members (class_id, user_id) VALUES (?, ?)");
  for (const id of ids) ins.run(classId, id);
}

export function createClass(input: ClassInput, db: Db = getDb(), now: Date = new Date()): { class: TpClassRow; unknown: string[] } {
  if (!input || typeof input !== "object") throw new ApiError("invalidBody", 400);
  const name = cleanName(input.name);
  const members = resolveMembers(db, input);
  return db.transaction(() => {
    if (nameTaken(db, name)) throw new ApiError("tpClassNameTaken", 409, { name });
    const id = Number(db.prepare("INSERT INTO tp_classes (name, created_at) VALUES (?, ?)").run(name, now.toISOString()).lastInsertRowid);
    if (members) setMembers(db, id, members.ids);
    return { class: getClass(id, db), unknown: members?.unknown ?? [] };
  })();
}

export function updateClass(id: number, input: ClassInput, db: Db = getDb()): { class: TpClassRow; unknown: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) throw new ApiError("invalidBody", 400);
  const cur = getClass(id, db);
  const name = input.name !== undefined ? cleanName(input.name) : cur.name;
  const members = resolveMembers(db, input);
  return db.transaction(() => {
    if (name.toLowerCase() !== cur.name.toLowerCase() && nameTaken(db, name, id)) throw new ApiError("tpClassNameTaken", 409, { name });
    db.prepare("UPDATE tp_classes SET name = ? WHERE id = ?").run(name, id);
    if (members) setMembers(db, id, members.ids);
    return { class: getClass(id, db), unknown: members?.unknown ?? [] };
  })();
}

export function deleteClass(id: number, db: Db = getDb()): void {
  const c = getClass(id, db);
  if (c.exerciseCount > 0) throw new ApiError("tpClassInUse", 409, { n: c.exerciseCount });
  db.prepare("DELETE FROM tp_classes WHERE id = ?").run(id);
}
