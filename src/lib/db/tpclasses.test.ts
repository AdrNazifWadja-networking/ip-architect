import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA, type Db } from "./index";
import { createUser, updateUser } from "./users";
import { createExercise, duplicateExercise, listExercises, studentDetail, submitAnswers, updateExercise } from "./tp";
import { createClass, deleteClass, getClass, listClasses, listStudents, updateClass } from "./tpclasses";
import { vlsmSolution } from "../tp/grade";
import { TP_TITLE_MAX } from "../tp/types";
import { ApiError, type SessionUser } from "../types";

const PW = "Correct-horse-42";
const NOW = new Date("2026-10-24T10:00:00Z");

async function setup() {
  const db: Db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  const mk = async (username: string, role: "viewer" | "editor" | "admin"): Promise<SessionUser> => {
    const u = await createUser({ username, displayName: username.toUpperCase(), password: PW, role }, db);
    return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, projectScope: "all" };
  };
  return { db, prof: await mk("prof", "editor"), a: await mk("alice", "viewer"), b: await mk("bernard", "viewer"), c: await mk("camille", "viewer") };
}
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};
const VLSM = { title: "TP1", kind: "vlsm", maxAttempts: 2, published: true, config: { parent: "10.0.0.0/24", needs: [{ name: "A", hosts: 100 }, { name: "B", hosts: 20 }] } };
const SOL = vlsmSolution(VLSM.config as never) as string[];
const ans = { "0": SOL[0], "1": SOL[1] };

test("classes : création, noms uniques, membres par identifiants (inconnus signalés), seuls les lecteurs actifs", async () => {
  const { db, a, b, prof } = await setup();
  assert.deepEqual(listStudents(db).map((s) => s.username), ["alice", "bernard", "camille"]);
  const r = createClass({ name: "  L2   Réseaux ", userIds: [a.id], usernames: "Bernard, prof, inconnu" }, db, NOW);
  assert.equal(r.class.name, "L2 Réseaux");
  assert.deepEqual(r.class.members.map((m) => m.username), ["alice", "bernard"]);
  assert.deepEqual(r.unknown.sort(), ["inconnu", "prof"], "un enseignant n'est pas un étudiant");
  assert.equal(code(() => createClass({ name: "l2 réseaux" }, db)), "tpClassNameTaken");
  assert.equal(code(() => createClass({ name: "" }, db)), "tpClassNameRequired");
  assert.equal(code(() => createClass({ name: "x".repeat(61) }, db)), "tpClassNameTooLong");
  assert.equal(code(() => createClass({ name: "Z", userIds: [prof.id] }, db)) , null, "id non étudiant ignoré, signalé");
  assert.equal(code(() => createClass({ name: "Y", userIds: "x" }, db)), "invalidBody");

  const u = updateClass(r.class.id, { name: "L2", usernames: ["alice"] }, db);
  assert.deepEqual([u.class.name, u.class.members.length], ["L2", 1]);
  const keep = updateClass(r.class.id, { name: "L2 bis" }, db);
  assert.equal(keep.class.members.length, 1, "sans liste, les membres ne changent pas");
  assert.equal(code(() => updateClass(r.class.id, {}, db)), "invalidBody");
  assert.equal(code(() => getClass(999, db)), "tpClassNotFound");
  // un compte désactivé ou supprimé quitte la classe / la liste
  await updateUser(b.id, { active: false }, prof.id, db);
  assert.ok(!listStudents(db).some((s) => s.username === "bernard"));
});

test("classes : un exercice réservé n'est visible que des membres (liste, détail, remise)", async () => {
  const { db, prof, a, b } = await setup();
  const cl = createClass({ name: "Groupe A", userIds: [a.id] }, db, NOW).class;
  const open = createExercise({ ...VLSM, title: "Pour tous" }, prof, db, NOW);
  const mine = createExercise({ ...VLSM, title: "Groupe A seul", classId: cl.id }, prof, db, NOW);
  assert.equal(mine.className, "Groupe A");
  assert.deepEqual(listExercises(a, db, NOW).map((e) => e.title).sort(), ["Groupe A seul", "Pour tous"]);
  assert.deepEqual(listExercises(b, db, NOW).map((e) => e.title), ["Pour tous"]);
  assert.equal(listExercises(prof, db, NOW).length, 2, "l'enseignant voit tout");
  assert.equal(code(() => studentDetail(mine.id, b, db, NOW)), "tpNotFound");
  assert.equal(code(() => submitAnswers(mine.id, b, ans, db, NOW)), "tpNotFound");
  assert.ok(submitAnswers(mine.id, a, ans, db, NOW).score > 0);
  assert.equal(studentDetail(open.id, b, db, NOW).exercise.className, null);

  // changer la classe : bernard entre, alice sort
  updateClass(cl.id, { userIds: [b.id] }, db);
  assert.equal(code(() => studentDetail(mine.id, a, db, NOW)), "tpNotFound");
  assert.equal(studentDetail(mine.id, b, db, NOW).exercise.id, mine.id);
  // rendre l'exercice à tous
  updateExercise(mine.id, { classId: null }, db);
  assert.equal(listExercises(a, db, NOW).length, 2);
  assert.equal(code(() => updateExercise(mine.id, { classId: 999 }, db)), "tpClassNotFound");
  assert.equal(code(() => createExercise({ ...VLSM, classId: "1" }, prof, db, NOW)), "tpClassNotFound");
});

test("classes : suppression refusée tant que des exercices y sont réservés ; les membres partent avec la classe", async () => {
  const { db, prof, a } = await setup();
  const cl = createClass({ name: "G", userIds: [a.id] }, db, NOW).class;
  const ex = createExercise({ ...VLSM, classId: cl.id }, prof, db, NOW);
  assert.equal(listClasses(db)[0].exerciseCount, 1);
  assert.equal(code(() => deleteClass(cl.id, db)), "tpClassInUse");
  updateExercise(ex.id, { classId: null }, db);
  deleteClass(cl.id, db);
  assert.equal(listClasses(db).length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM tp_class_members").get() as { c: number }).c, 0);
  assert.equal(listStudents(db).length, 3, "les comptes ne sont pas supprimés");
});

test("duplication : copie en brouillon, sans remises ni date limite, même classe, titre numéroté", async () => {
  const { db, prof, a } = await setup();
  const cl = createClass({ name: "G", userIds: [a.id] }, db, NOW).class;
  const src = createExercise({ ...VLSM, classId: cl.id, dueAt: "2030-01-01T00:00:00Z", showSolution: true, description: "Consigne" }, prof, db, NOW);
  submitAnswers(src.id, a, ans, db, NOW);
  const copy = duplicateExercise(src.id, prof, db, NOW);
  assert.notEqual(copy.id, src.id);
  assert.deepEqual(
    [copy.title, copy.published, copy.dueAt, copy.classId, copy.showSolution, copy.description, copy.maxAttempts],
    ["TP1 (2)", false, null, cl.id, true, "Consigne", 2],
  );
  assert.deepEqual(copy.config, src.config);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM tp_submissions WHERE exercise_id = ?").get(copy.id) as { c: number }).c, 0);
  const long = createExercise({ ...VLSM, title: "T".repeat(TP_TITLE_MAX) }, prof, db, NOW);
  assert.ok(duplicateExercise(long.id, prof, db, NOW).title.length <= TP_TITLE_MAX);
  assert.equal(code(() => duplicateExercise(9999, prof, db, NOW)), "tpNotFound");
});
